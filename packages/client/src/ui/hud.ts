// DOM HUD bound to GameState (DESIGN §12.7). Phase 2: all numbers come from WP-C selectors/scoring. The pure
// `hudModel()` computes everything the HUD shows (tested in node without a DOM); `createHud().update()` only
// writes the DOM nodes whose content changed, because the controller may call it every frame.
import type { GameState, PlayerColour } from '@puttipeli/shared/game/types';
import { currentCourse, isMyTurn, playerOf, strokesThisHole } from '@puttipeli/shared/game/selectors';
import { totalStrokes } from '@puttipeli/shared/game/scoring';
import { AFK_TURN_TIMEOUT_SEC, DISCONNECTED_TURN_WAIT_SEC } from '@puttipeli/shared/constants';
import { el } from './components';
import { t } from '../i18n/t';
import { getSettings, onSettingsChange } from '../storage/settings';

export interface Hud {
  root: HTMLElement;
  update(state: GameState, localPlayerId: string, nowAuthorityMs: number): void;
  setPower(power01: number | null): void;
  setLabel(text: string | null): void;
  fireButton: HTMLButtonElement; /* hidden unless touch device AND the touchFireButton setting is on (§12.3) */
  destroy(): void;
}

// ---------------------------------------------------------------------------------------------------------------
// Pure view model
// ---------------------------------------------------------------------------------------------------------------

export type ChipTag = '' | 'done' | 'left' | 'afk';

export interface HudChipModel {
  id: string;
  name: string;
  colour: PlayerColour;
  isTurn: boolean;
  isMe: boolean;
  done: boolean;
  left: boolean;
  host: boolean;
  /** Strokes on the current hole as text, '' outside a round. */
  strokes: string;
  tag: ChipTag;
  offline: boolean;
  afk: boolean;
}

export interface HudTimerModel { fraction: number; secondsLeft: number; urgent: boolean }

export interface HudModel {
  /** Course name, '' outside a hole. */
  title: string;
  inRound: boolean;
  hole: string;      // "3/9"
  par: string;
  strokes: string;   // local player's strokes this hole, '–' for spectators
  strokesOver: boolean;
  total: string;
  chips: HudChipModel[];
  turnText: string;
  /** Seconds left of the countdown, null outside the countdown phase. */
  countdownSec: number | null;
  /** Turn timer; null when the turn has no deadline. */
  timer: HudTimerModel | null;
  canFire: boolean;
}

const ROUND_PHASES: readonly GameState['phase'][] = ['hole', 'holeSummary', 'roundSummary'];

/** Everything the HUD displays, derived from the state with WP-C selectors/scoring. */
export function hudModel(state: GameState, localPlayerId: string, nowAuthorityMs: number): HudModel {
  const course = currentCourse(state);
  const inRound = ROUND_PHASES.includes(state.phase);
  const turnId = state.turn?.playerId ?? null;
  // A spectator is anyone outside the roster: the empty id of a pure watcher as well as an unknown (own) id.
  const spectator = playerOf(state, localPlayerId) === null;
  const mine = spectator ? 0 : strokesThisHole(state, localPlayerId);

  const chips: HudChipModel[] = state.players.map((p) => {
    const done = state.holeDone[p.id] === true;
    const tag: ChipTag = p.leftRound ? 'left' : done && state.phase === 'hole' ? 'done' : p.afk ? 'afk' : '';
    return {
      id: p.id,
      name: p.name,
      colour: p.colour,
      isTurn: state.phase === 'hole' && p.id === turnId,
      isMe: p.id === localPlayerId,
      done: inRound && done,
      left: p.leftRound,
      host: p.id === state.hostId,
      strokes: inRound && course ? String(strokesThisHole(state, p.id)) : '',
      tag,
      offline: !p.connected,
      afk: p.connected && p.afk,
    };
  });

  let turnText = '';
  if (state.phase === 'hole' && state.turn) {
    const onTurn = playerOf(state, state.turn.playerId);
    if (state.turn.shotInFlight) turnText = t('hud.shotInFlight');
    else if (state.turn.playerId === localPlayerId) turnText = t('hud.yourTurn');
    else turnText = t('hud.turn', { name: onTurn?.name ?? '?' });
  } else if (state.phase === 'holeSummary') turnText = t('hud.holeSummary');
  else if (state.phase === 'roundSummary') turnText = t('hud.roundSummary');
  else if (state.phase === 'lobby') turnText = t('hud.lobby');
  if (spectator && inRound) turnText = `${t('hud.spectating')} · ${turnText}`;

  const countdownSec = state.phase === 'countdown' && state.countdownEndsAtMs !== null
    ? Math.max(0, Math.ceil((state.countdownEndsAtMs - nowAuthorityMs) / 1000))
    : null;

  let timer: HudTimerModel | null = null;
  const deadline = state.phase === 'hole' ? state.turn?.deadlineMs ?? null : null;
  if (deadline !== null && state.turn) {
    const onTurn = playerOf(state, state.turn.playerId);
    const durationSec = onTurn && !onTurn.connected
      ? DISCONNECTED_TURN_WAIT_SEC
      : onTurn?.afk ? AFK_TURN_TIMEOUT_SEC : state.settings.turnTimeoutSec || DISCONNECTED_TURN_WAIT_SEC;
    const remainMs = Math.max(0, deadline - nowAuthorityMs);
    timer = {
      fraction: Math.min(1, remainMs / (durationSec * 1000)),
      secondsLeft: Math.ceil(remainMs / 1000),
      urgent: remainMs <= 5000,
    };
  }

  return {
    title: course ? course.name : '',
    inRound: inRound && course !== null,
    hole: course ? `${state.holeIndex + 1}/${state.courses.length}` : '',
    par: course ? String(course.rules.par) : '',
    strokes: course ? (spectator ? '–' : String(mine)) : '',
    strokesOver: course !== null && !spectator && mine > course.rules.par,
    total: course ? (spectator ? '–' : String(totalStrokes(state, localPlayerId))) : '',
    chips,
    turnText,
    countdownSec,
    timer,
    canFire: !spectator && isMyTurn(state, localPlayerId),
  };
}

// ---------------------------------------------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------------------------------------------

const setText = (node: HTMLElement, text: string): void => { if (node.textContent !== text) node.textContent = text; };
const setClass = (node: HTMLElement, cls: string, on: boolean): void => { if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on); };
const setHidden = (node: HTMLElement, hidden: boolean): void => { if (node.hidden !== hidden) node.hidden = hidden; };

function isTouchDevice(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  } catch {
    return false;
  }
}

interface Chip { root: HTMLElement; strokes: HTMLElement; status: HTMLElement; tag: HTMLElement }

const tagText = (tag: ChipTag): string => (tag === 'left' ? t('hud.left') : tag === 'done' ? t('hud.done') : tag === 'afk' ? t('hud.afk') : '');

export function createHud(container: HTMLElement): Hud {
  // Top row: course title + stats + label + timer
  const title = el('span', { class: 'hud__title' });
  const holeValue = el('span', { class: 'hud__stat-value' });
  const parValue = el('span', { class: 'hud__stat-value' });
  const strokesValue = el('span', { class: 'hud__stat-value' });
  const totalValue = el('span', { class: 'hud__stat-value' });
  const stat = (labelKey: string, value: HTMLElement): HTMLElement =>
    el('span', { class: 'hud__stat' }, el('span', { class: 'hud__stat-label' }, t(labelKey)), value);
  const stats = el('div', { class: 'hud__stats' }, stat('hud.hole', holeValue), stat('hud.par', parValue), stat('hud.strokes', strokesValue), stat('hud.total', totalValue));
  const label = el('span', { class: 'hud__label', hidden: true });
  const timerText = el('span', { class: 'timer-ring__text' });
  const timerRing = el('div', { class: 'timer-ring', role: 'timer', 'aria-label': t('hud.timer') }, timerText);
  const timer = el('div', { class: 'hud__timer', hidden: true }, timerRing);
  const top = el('div', { class: 'hud__top' }, title, stats, el('span', { class: 'hud__spacer' }), label, timer);

  // Player chips
  const players = el('div', { class: 'hud__players', role: 'list', 'aria-label': t('hud.players') });

  // Bottom row: turn text, power bar, fire button
  const turnText = el('span', { class: 'hud__turn muted' });
  const powerFill = el('div', { class: 'power__fill' });
  const power = el('div', { class: 'power', role: 'progressbar', 'aria-label': t('hud.power'), 'aria-valuemin': '0', 'aria-valuemax': '100', 'aria-valuenow': '0', hidden: true },
    powerFill,
    ...[25, 50, 75].map((p) => { const tick = el('div', { class: 'power__tick' }); tick.style.left = `${p}%`; return tick; }));
  const fireButton = el('button', { type: 'button', class: 'btn btn--primary hud__fire' }, t('hud.fire'));
  // §12.3: on touch the Lyö button fires only while the touchFireButton setting is on; with it off, input.ts fires on
  // pointer release and the button would be redundant. Followed live so a settings change needs no remount.
  const touch = isTouchDevice();
  const applyFireVisibility = (touchFireButton: boolean): void => { fireButton.hidden = !(touch && touchFireButton); };
  applyFireVisibility(getSettings().touchFireButton);
  const offSettings = onSettingsChange((s) => applyFireVisibility(s.touchFireButton));
  const countdown = el('span', { class: 'hud__countdown', hidden: true });
  const bottom = el('div', { class: 'hud__bottom' }, turnText, countdown, power, fireButton);

  const root = el('div', { class: 'hud' }, top, players, bottom);
  container.append(root);

  const chips = new Map<string, Chip>();
  let chipSignature = '';

  const buildChips = (list: HudChipModel[]): void => {
    players.replaceChildren();
    chips.clear();
    for (const c of list) {
      const dot = el('span', { class: 'chip__dot' });
      dot.style.setProperty('--player-colour', `var(--player-${c.colour})`);
      const name = el('span', { class: 'chip__name' }, c.name);
      const strokes = el('span', { class: 'chip__strokes' });
      const status = el('span', { class: 'chip__status' });
      const tag = el('span', { class: 'chip__tag' });
      const chipRoot = el('span', { class: 'chip', role: 'listitem', title: c.host ? t('hud.host') : '' }, dot, name, strokes, tag, status);
      if (c.host) chipRoot.append(el('span', { class: 'chip__crown', 'aria-hidden': 'true' }, '♛'));
      chips.set(c.id, { root: chipRoot, strokes, status, tag });
      players.append(chipRoot);
    }
  };

  let lastPower: number | null = null;

  return {
    root,
    fireButton,

    update(state, localPlayerId, nowAuthorityMs) {
      const m = hudModel(state, localPlayerId, nowAuthorityMs);

      setText(title, m.title);
      setHidden(stats, !m.inRound);
      if (m.inRound) {
        setText(holeValue, m.hole);
        setText(parValue, m.par);
        setText(strokesValue, m.strokes);
        setClass(strokesValue, 'is-over', m.strokesOver);
        setText(totalValue, m.total);
      }

      // Chips are rebuilt only when the roster (id, name, colour, host) changes.
      const sig = m.chips.map((c) => `${c.id}:${c.name}:${c.colour}:${c.host ? 1 : 0}`).join('|');
      if (sig !== chipSignature) { chipSignature = sig; buildChips(m.chips); }
      for (const c of m.chips) {
        const chip = chips.get(c.id);
        if (!chip) continue;
        setClass(chip.root, 'is-turn', c.isTurn);
        setClass(chip.root, 'is-me', c.isMe);
        setClass(chip.root, 'is-done', c.done);
        setClass(chip.root, 'is-left', c.left);
        setText(chip.strokes, c.strokes);
        setText(chip.tag, tagText(c.tag));
        setClass(chip.status, 'is-offline', c.offline);
        setClass(chip.status, 'is-afk', c.afk);
        const statusTitle = c.offline ? t('hud.offline') : c.afk ? t('hud.afk') : '';
        if (chip.status.title !== statusTitle) chip.status.title = statusTitle;
      }

      setText(turnText, m.turnText);

      if (m.countdownSec !== null) {
        setHidden(countdown, false);
        setText(countdown, t('hud.countdown', { s: m.countdownSec }));
      } else setHidden(countdown, true);

      if (m.timer) {
        setHidden(timer, false);
        timerRing.style.setProperty('--p', m.timer.fraction.toFixed(3));
        setClass(timerRing, 'is-urgent', m.timer.urgent);
        setText(timerText, String(m.timer.secondsLeft));
      } else setHidden(timer, true);

      if (fireButton.disabled === m.canFire) fireButton.disabled = !m.canFire;
    },

    setPower(power01) {
      if (power01 === lastPower) return;
      lastPower = power01;
      if (power01 === null) { power.hidden = true; return; }
      const pct = Math.max(0, Math.min(1, power01));
      power.hidden = false;
      powerFill.style.width = `${(pct * 100).toFixed(1)}%`;
      power.setAttribute('aria-valuenow', String(Math.round(pct * 100)));
      setClass(power, 'is-max', power01 >= 1);
    },

    setLabel(text) {
      if (text === null) { label.hidden = true; return; }
      label.hidden = false;
      setText(label, text);
    },

    destroy() {
      offSettings();
      root.remove();
      chips.clear();
    },
  };
}
