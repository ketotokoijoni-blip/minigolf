// Play view controller (DESIGN §12.4, §12.2 "which balls are drawn", §12.3, §9.6, §10.7).
//
// GameController binds a GameHost (localHost or RoomSession) to the renderer, the aim input, the HUD, the shot
// animator, the sound effects and the overlays. On `shotTaken` it rebuilds the shot from the PREVIOUS state with
// createShotIterator (layers cached per course id), animates it, and compares outcomeOf(it).checksum with the
// authority's checksum; a later event arriving while animating fast-forwards the animation first.
//
// Everything that touches the DOM or a canvas sits behind the PlayView port so the controller logic runs in the
// node-environment tests with a fake view (controller.test.ts).
import { HOLE_INTRO_MS } from '@puttipeli/shared/constants';
import type { Course, CourseLayers } from '@puttipeli/shared/course/types';
import type { GameEvent } from '@puttipeli/shared/game/events';
import { currentCourse, isMyTurn, otherBallCentres } from '@puttipeli/shared/game/selectors';
import type { GameState } from '@puttipeli/shared/game/types';
import { createShotIterator, outcomeOf } from '@puttipeli/shared/sim/simulate';
import type { ShotInput, ShotIterator, ShotSummary, WorldState } from '@puttipeli/shared/sim/types';
import { createSfx, type Sfx } from '../audio/sfx';
import { t } from '../i18n/t';
import { Renderer, type AimSprite, type BallSprite } from '../render/renderer';
import { getSettings } from '../storage/settings';
import { el, toast } from '../ui/components';
import { confirmDialog } from '../ui/dialogs';
import { createHud, type Hud } from '../ui/hud';
import type { GameHost } from './gameHost';
import { createAimInput, type AimInput } from './input';
import { layersFor } from './localHost';
import { startLoop } from './loop';
import { ShotAnimator } from './shotAnimator';
import { createOverlays, ensureGameStyles, type OverlayContext, type Overlays } from './summaries';

// ---------------------------------------------------------------------------------------------------------------
// Ports (the real Renderer / ShotAnimator / AimInput / Hud satisfy them structurally)
// ---------------------------------------------------------------------------------------------------------------

export interface RendererPort {
  setCourse(layers: CourseLayers, world: WorldState): void;
  setWorld(world: WorldState): void;
  setBalls(balls: readonly BallSprite[]): void;
  setAim(aim: AimSprite | null): void;
  render(nowMs: number): void;
  readonly effects: { clear(): void; enabled: boolean };
  destroy(): void;
}

export interface AnimatorPort {
  play(it: ShotIterator, sprite: BallSprite, onDone: (it: ShotIterator) => void): void;
  fastForward(): void;
  readonly running: boolean;
  update(nowMs: number): void;
}

export interface PlayView {
  renderer: RendererPort;
  animator: AnimatorPort;
  aim: AimInput;
  hud: Hud;
  sfx: Sfx;
  overlays: Overlays;
  startLoop(tick: (nowMs: number) => void): () => void;
  /** Where keydown is listened to (window in the browser; a plain EventTarget in tests). */
  keyTarget: EventTarget | null;
  destroy(): void;
}

export interface PlaySettings {
  volume: number;
  touchFireButton: boolean;
  reduceEffects: boolean;
}

export interface GameControllerOptions {
  /** Editor test play: HUD label, no confirmation on leaving, "Takaisin editoriin" wording. */
  testPlay?: boolean;
  /** The player leaves (Valikkoon / Lopeta / Poistu). The caller tears down the host and navigates. */
  onLeave?: () => void;
  /** A remote host returned to the lobby (backToLobby event): the caller navigates to #/room/CODE. */
  onBackToLobby?: () => void;
  /** Test seams. */
  view?: PlayView;
  settings?: Partial<PlaySettings>;
  confirm?: (text: string, opts: { ok?: string; danger?: boolean }) => Promise<boolean>;
}

/** Events that never change the ball/world picture: an animation keeps running when one arrives. */
const COSMETIC_EVENTS: ReadonlySet<GameEvent['type']> = new Set([
  'playerConnection', 'playerAfk', 'spectatorJoined', 'spectatorLeft', 'hostChanged', 'summaryReady',
  'profileChanged', 'readyChanged', 'settingsChanged', 'coursesChanged',
]);

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers (tested)
// ---------------------------------------------------------------------------------------------------------------

/**
 * §12.2: every player with !leftRound && !holeDone[id] whose ball exists; the player on turn is drawn last (on top)
 * with the highlight pulse; other players' resting balls at 60 % alpha (the local player's own ball stays opaque).
 * The ball being animated is handled by the renderer (ShotAnimator installs it separately and it hides the
 * same-id sprite from this list until the animation ends).
 */
export function ballSprites(state: GameState, localPlayerId: string): BallSprite[] {
  const turnId = state.phase === 'hole' && state.turn !== null ? state.turn.playerId : null;
  const out: BallSprite[] = [];
  let current: BallSprite | null = null;
  for (const p of state.players) {
    if (p.leftRound || state.holeDone[p.id] === true) continue;
    const ball = state.balls[p.id];
    if (ball === undefined) continue;
    const onTurn = p.id === turnId;
    const sprite: BallSprite = {
      id: p.id,
      ball,
      colour: p.colour,
      alpha: onTurn || p.id === localPlayerId ? 1 : 0.6,
      highlight: onTurn,
    };
    if (onTurn) current = sprite;
    else out.push(sprite);
  }
  if (current !== null) out.push(current);
  return out;
}

export type ShotTakenEvent = Extract<GameEvent, { type: 'shotTaken' }>;

export interface ReplayPlan { it: ShotIterator; worldBefore: WorldState; sprite: BallSprite }

/**
 * The replay of a shotTaken event built from the state BEFORE the event (§12.4): prev.balls[pid], prev.world,
 * otherBallCentres(prev, pid) and the event's shot. Null when the previous state cannot animate it (no ball/world).
 */
export function planReplay(prev: GameState, ev: ShotTakenEvent, localPlayerId: string): ReplayPlan | null {
  const course = currentCourse(prev);
  const ball = prev.balls[ev.playerId];
  const world = prev.world;
  if (course === null || ball === undefined || world === null) return null;
  const it = createShotIterator(layersFor(course), world, ball, ev.shot, otherBallCentres(prev, ev.playerId));
  const player = prev.players.find((p) => p.id === ev.playerId);
  const sprite: BallSprite = { id: ev.playerId, ball, colour: player?.colour ?? 0, alpha: 1, highlight: ev.playerId === localPlayerId };
  return { it, worldBefore: world, sprite };
}

export interface ReplayCheck { ok: boolean; expected: number; actual: number; result: string; ticks: number }

/** §9.6: compares the finished replay with the authority's ShotSummary. */
export function checkReplay(it: ShotIterator, worldBefore: WorldState, expected: ShotSummary): ReplayCheck {
  const out = outcomeOf(it, worldBefore);
  const ok = out.checksum === expected.checksum && out.result === expected.result && out.ticks === expected.ticks;
  return { ok, expected: expected.checksum, actual: out.checksum, result: out.result, ticks: out.ticks };
}

// ---------------------------------------------------------------------------------------------------------------
// DOM view
// ---------------------------------------------------------------------------------------------------------------

function readSettings(partial: Partial<PlaySettings> | undefined): PlaySettings {
  let base: PlaySettings = { volume: 0.7, touchFireButton: true, reduceEffects: false };
  try {
    const s = getSettings();
    base = { volume: s.volume, touchFireButton: s.touchFireButton, reduceEffects: s.reduceEffects };
  } catch {
    /* storage unavailable: defaults */
  }
  return { ...base, ...partial };
}

/** Builds the real HUD + canvas stack + overlays inside `root`. */
export function createDomView(root: HTMLElement, settings: PlaySettings): PlayView {
  ensureGameStyles();
  root.classList.add('game-root');
  const hudWrap = el('div', { class: 'game-hud' });
  const stage = el('div', { class: 'game-stage' });
  root.append(hudWrap, stage);
  const hud = createHud(hudWrap);
  const renderer = new Renderer(stage);
  const overlayHost = el('div');
  stage.append(overlayHost); // after the canvas stack, so it paints on top
  const overlays = createOverlays(overlayHost);
  const sfx = createSfx();
  sfx.setVolume(settings.volume);
  renderer.effects.enabled = !settings.reduceEffects;
  const animator = new ShotAnimator(renderer, sfx);
  const aim = createAimInput(renderer.canvas, renderer.camera, { touchFireButton: settings.touchFireButton, fireButton: hud.fireButton });
  const unlock = (): void => sfx.unlock();
  root.addEventListener('pointerdown', unlock);
  window.addEventListener('keydown', unlock);
  return {
    renderer,
    animator,
    aim,
    hud,
    sfx,
    overlays,
    startLoop,
    keyTarget: window,
    destroy() {
      root.removeEventListener('pointerdown', unlock);
      window.removeEventListener('keydown', unlock);
      aim.destroy();
      overlays.destroy();
      hud.destroy();
      renderer.destroy();
      hudWrap.remove();
      stage.remove();
      root.classList.remove('game-root');
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------------------------------------------

export class GameController {
  readonly host: GameHost;
  readonly view: PlayView;
  readonly testPlay: boolean;
  private readonly onLeaveCb: (() => void) | null;
  private readonly onBackToLobbyCb: (() => void) | null;
  private readonly confirm: (text: string, opts: { ok?: string; danger?: boolean }) => Promise<boolean>;
  private readonly unsubscribe: () => void;
  private readonly offError: () => void;
  private readonly offShoot: () => void;
  private readonly stopLoop: () => void;
  private readonly keyTarget: EventTarget | null;
  private readonly onKeyDown = (e: Event): void => this.handleKey(e as KeyboardEvent);
  private layers: CourseLayers | null = null;
  private layersCourse: Course | null = null;
  private aimKey = '';
  /**
   * Whether each player's latest shot on the current hole holed out (from the deciding shotTaken event; GameState
   * keeps no shot result). A missing key means "not observed" (joined by snapshot): the summary then infers it.
   */
  private holed: Record<string, boolean> = {};
  /** True while a running replay is fast-forwarded to make room for the next shotTaken: its world must not be drawn yet. */
  private replayPending = false;
  private _desyncs = 0;
  private destroyed = false;
  private leaving = false;

  constructor(host: GameHost, root: HTMLElement, opts: GameControllerOptions = {}) {
    this.host = host;
    this.testPlay = opts.testPlay === true;
    this.onLeaveCb = opts.onLeave ?? null;
    this.onBackToLobbyCb = opts.onBackToLobby ?? null;
    this.confirm = opts.confirm ?? ((text, o) => confirmDialog(text, o));
    this.view = opts.view ?? createDomView(root, readSettings(opts.settings));
    this.view.hud.setLabel(this.testPlay ? t('game.testPlay') : null);
    this.offShoot = this.view.aim.onShoot((shot) => this.shoot(shot));
    this.offError = host.onError((code, message) => this.onHostError(code, message));
    this.keyTarget = this.view.keyTarget;
    this.keyTarget?.addEventListener('keydown', this.onKeyDown);
    this.unsubscribe = host.subscribe((state, ev, prev) => this.onHostEvent(state, ev, prev));
    this.stopLoop = this.view.startLoop((now) => this.frame(now));
  }

  /** Number of replay/checksum mismatches seen (§9.6 "desync"); 0 across a round is the acceptance criterion. */
  get desyncCount(): number { return this._desyncs; }

  destroy(): void {
    if (this.destroyed) return;
    this.destroyed = true;
    this.stopLoop();
    this.unsubscribe();
    this.offError();
    this.offShoot();
    this.keyTarget?.removeEventListener('keydown', this.onKeyDown);
    this.view.destroy();
  }

  // --- public actions (toolbar buttons, keys) ----------------------------------------------------------------

  toggleScorecard(): void {
    if (this.destroyed) return;
    this.view.overlays.toggleScorecard(this.host.getState(), this.host.localPlayerId);
    this.syncAim(this.host.getState());
  }

  pause(): void {
    if (this.destroyed || this.view.overlays.paused) return;
    this.view.overlays.showPause(this.ctx(this.host.getState()), { onResume: () => this.resume(), onQuit: () => this.requestLeave() });
    this.syncAim(this.host.getState());
  }

  resume(): void {
    if (this.destroyed) return;
    this.view.overlays.hidePause();
    this.syncAim(this.host.getState());
  }

  /** Leave with an in-page confirmation while a round is in progress (never for test play or a finished round). */
  requestLeave(): void {
    if (this.destroyed || this.leaving) return;
    const phase = this.host.getState().phase;
    const inProgress = phase === 'countdown' || phase === 'hole' || phase === 'holeSummary';
    if (this.testPlay || !inProgress) {
      this.leave();
      return;
    }
    const text = this.host.kind === 'remote' ? t('game.leaveRoom.confirm') : t('game.quit.confirm');
    void this.confirm(text, { ok: this.host.kind === 'remote' ? t('game.leave') : t('game.quit'), danger: true }).then((ok) => {
      if (ok && !this.destroyed) this.leave();
    });
  }

  // --- host events --------------------------------------------------------------------------------------------

  private onHostEvent(state: GameState, ev: GameEvent | null, prev: GameState | null): void {
    if (this.destroyed) return;
    if (ev === null) {
      this.resync(state);
      return;
    }
    if (this.view.animator.running && !COSMETIC_EVENTS.has(ev.type)) {
      // A new shot is about to be replayed: the previous replay finishes with its OWN world (onReplayDone must not
      // push the state that already contains the new shot's changes, e.g. a block the animated ball has yet to hit).
      this.replayPending = ev.type === 'shotTaken';
      try {
        this.view.animator.fastForward();
      } finally {
        this.replayPending = false;
      }
    }
    switch (ev.type) {
      case 'holeStarted':
        this.onHoleStarted(state);
        break;
      case 'shotTaken':
        this.holed[ev.playerId] = ev.outcome.result === 'holed';
        if (prev !== null) this.onShotTaken(prev, ev);
        break;
      case 'turnTimedOut':
        this.holed[ev.playerId] = false; // +1 stroke without a shot: a stroke-limit finish here is not a hole-out
        if (ev.playerId === this.host.localPlayerId && this.host.localPlayerId !== '') toast(t('game.timedOut'), 'error');
        break;
      case 'holeEnded':
        this.showHoleSummary(state);
        break;
      case 'roundEnded':
        this.onRoundEnded(state, ev);
        break;
      case 'backToLobby':
        this.view.overlays.hideSummary();
        this.view.overlays.hidePause();
        if (this.host.kind === 'remote') this.onBackToLobbyCb?.();
        break;
      default:
        break;
    }
    this.afterState(state);
  }

  /** Initial subscription call and snapshot adoption: rebuild the whole picture from `state`. */
  private resync(state: GameState): void {
    if (this.view.animator.running) this.view.animator.fastForward();
    this.view.overlays.hideSummary();
    const course = currentCourse(state);
    if (course !== null && state.world !== null && (state.phase === 'hole' || state.phase === 'holeSummary' || state.phase === 'roundSummary')) {
      this.layers = layersFor(course);
      this.layersCourse = course;
      this.view.renderer.setCourse(this.layers, state.world);
      this.view.aim.setTargets(this.layers.holes.map((h) => ({ x: h.cx, y: h.cy })));
    }
    this.aimKey = '';
    this.holed = {}; // a snapshot carries no shot results: the summary falls back to inference
    if (state.phase === 'holeSummary') this.showHoleSummary(state);
    else if (state.phase === 'roundSummary') this.showRoundSummary(state);
    this.afterState(state);
  }

  private onHoleStarted(state: GameState): void {
    const course = currentCourse(state);
    if (course === null || state.world === null) return;
    this.layers = layersFor(course);
    this.layersCourse = course;
    this.view.renderer.setCourse(this.layers, state.world);
    this.view.aim.setTargets(this.layers.holes.map((h) => ({ x: h.cx, y: h.cy })));
    this.view.overlays.hideSummary();
    this.view.overlays.showTitleCard(state, HOLE_INTRO_MS + 700);
    this.aimKey = '';
    this.holed = {};
  }

  private onShotTaken(prev: GameState, ev: ShotTakenEvent): void {
    const plan = planReplay(prev, ev, this.host.localPlayerId);
    if (plan === null) {
      console.warn('[puttipeli] shotTaken without a previous ball/world; skipping the replay', ev.playerId);
      return;
    }
    const expected = ev.outcome;
    this.view.animator.play(plan.it, plan.sprite, (done) => this.onReplayDone(done, plan.worldBefore, expected, ev));
  }

  private onReplayDone(it: ShotIterator, worldBefore: WorldState, expected: ShotSummary, ev: ShotTakenEvent): void {
    if (this.destroyed) return;
    try {
      const check = checkReplay(it, worldBefore, expected);
      if (!check.ok) {
        this._desyncs++;
        console.warn('[puttipeli] desync', { player: ev.playerId, turnSeq: ev.turnSeq, expected: expected.checksum, actual: check.actual, expectedResult: expected.result, result: check.result, expectedTicks: expected.ticks, ticks: check.ticks });
        if (this.host.kind === 'remote') toast(t('game.desync'), 'error');
        this.host.requestSnapshot(); // the reducer state already holds the authority's ball and world
      }
    } catch (err) {
      console.warn('[puttipeli] replay check failed', err);
    }
    if (expected.result === 'timeout') console.warn('[puttipeli]', t('game.shotTimeout'));
    this.afterState(this.host.getState());
  }

  private onRoundEnded(state: GameState, ev: Extract<GameEvent, { type: 'roundEnded' }>): void {
    const aborted = ev.ranking.length === 0 || state.players.every((p) => p.leftRound);
    if (aborted) {
      this.view.overlays.hideSummary();
      if (!this.leaving) toast(t('game.aborted'));
      return;
    }
    this.view.sfx.play('applause');
    this.showRoundSummary(state);
  }

  private showHoleSummary(state: GameState): void {
    this.view.overlays.showHoleSummary(state, this.ctx(state), { onContinue: () => this.continueSummary() });
  }

  private showRoundSummary(state: GameState): void {
    const remote = this.host.kind === 'remote';
    this.view.overlays.showRoundSummary(state, this.ctx(state), {
      onRestart: remote ? undefined : () => this.host.restart(),
      onLeave: () => this.leave(),
      onReady: remote && this.host.localPlayerId !== '' ? () => this.continueSummary() : undefined,
      onBackToLobby: remote ? () => this.host.backToLobby() : undefined,
    });
  }

  private continueSummary(): void {
    const state = this.host.getState();
    const id = this.host.localPlayerId;
    if (id === '' || state.summaryReady[id] === true) return;
    if (state.phase !== 'holeSummary' && state.phase !== 'roundSummary') return;
    this.host.summaryReady();
  }

  /** After every state change: static layer, ball sprites, aim and open overlays. */
  private afterState(state: GameState): void {
    const animating = this.view.animator.running || this.replayPending;
    if (!animating && state.world !== null && this.layersCourse === currentCourse(state) && this.layers !== null) {
      this.view.renderer.setWorld(state.world);
    }
    this.view.renderer.setBalls(ballSprites(state, this.host.localPlayerId));
    this.syncAim(state);
    this.view.overlays.update(state, this.ctx(state));
  }

  /** §12.3: aiming is active only on my turn, with no animation running and no overlay open. */
  private syncAim(state: GameState): void {
    const id = this.host.localPlayerId;
    const overlays = this.view.overlays;
    const mine = id !== '' && isMyTurn(state, id) && !this.view.animator.running && !overlays.paused && !overlays.scorecardOpen;
    if (!mine || state.turn === null) {
      this.view.aim.setEnabled(false);
      return;
    }
    const key = `${state.holeIndex}:${state.turn.turnSeq}`;
    if (key !== this.aimKey) {
      this.aimKey = key;
      const b = state.balls[id];
      this.view.aim.setBall(b === undefined ? null : { x: b.x, y: b.y });
    }
    this.view.aim.setEnabled(true);
  }

  private ctx(state: GameState): OverlayContext {
    const id = this.host.localPlayerId;
    return { localPlayerId: id, kind: this.host.kind, testPlay: this.testPlay, isHost: id !== '' && state.hostId === id, holed: this.holed };
  }

  // --- input ----------------------------------------------------------------------------------------------------

  private shoot(shot: ShotInput): void {
    if (this.destroyed) return;
    this.view.sfx.unlock();
    this.host.shoot(shot);
  }

  private frame(now: number): void {
    if (this.destroyed) return;
    const state = this.host.getState();
    this.view.animator.update(now);
    const id = this.host.localPlayerId;
    const aiming = id !== '' && isMyTurn(state, id) && !this.view.animator.running && !this.view.overlays.paused && !this.view.overlays.scorecardOpen;
    const aim = aiming ? this.view.aim.getAim() : null;
    this.view.renderer.setAim(aim);
    this.view.hud.setPower(aiming ? (aim ? aim.power : 0) : null);
    this.view.hud.update(state, id, this.host.nowAuthorityMs());
    this.view.renderer.render(now);
  }

  private handleKey(e: KeyboardEvent): void {
    if (this.destroyed) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable === true)) return;
    if (typeof document !== 'undefined' && document.querySelector('.dialog-backdrop')) return; // an in-page dialog owns the keys
    const overlays = this.view.overlays;
    switch (e.key) {
      case 'Tab':
        if (overlays.paused || overlays.summary !== 'none') return; // let focus move between the overlay buttons
        e.preventDefault();
        this.toggleScorecard();
        return;
      case 'Escape':
        if (e.defaultPrevented) return; // the aim input cancelled an armed aim with this press
        e.preventDefault();
        if (overlays.scorecardOpen) {
          overlays.closeScorecard();
          this.syncAim(this.host.getState());
        } else if (overlays.paused) {
          this.resume();
        } else {
          this.pause();
        }
        return;
      case ' ':
      case 'Enter':
        if (e.repeat) return; // a held key must not continue the summary (and then auto-shoot on the next turn)
        if (overlays.summary === 'hole' && !overlays.paused && !(target && target.tagName === 'BUTTON')) {
          e.preventDefault();
          this.continueSummary();
        }
        return;
      default:
        return;
    }
  }

  private onHostError(code: string, message: string): void {
    if (this.destroyed) return;
    console.warn('[puttipeli] host error', code, message);
    const key = `error.${code}`;
    const text = t(key);
    toast(text === key ? t('game.error', { code }) : text, 'error');
  }

  private leave(): void {
    if (this.destroyed || this.leaving) return;
    this.leaving = true;
    this.view.overlays.hidePause();
    if (this.onLeaveCb) this.onLeaveCb();
    else this.host.leave();
  }
}
