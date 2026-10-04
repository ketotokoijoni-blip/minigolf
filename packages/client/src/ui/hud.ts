// DOM HUD bound to GameState (DESIGN §12.7). Phase 1 reads GameState fields directly; phase 2 swaps in WP-C
// selectors/scoring where they exist. `update` may be called every frame, so it only touches DOM nodes whose
// content changed.
import type { GameState, PlayerState } from '@puttipeli/shared/game/types';
import { AFK_TURN_TIMEOUT_SEC, DISCONNECTED_TURN_WAIT_SEC } from '@puttipeli/shared/constants';
import { el } from './components';
import { t } from '../i18n/t';

export interface Hud {
  root: HTMLElement;
  update(state: GameState, localPlayerId: string, nowAuthorityMs: number): void;
  setPower(power01: number | null): void;
  setLabel(text: string | null): void;
  fireButton: HTMLButtonElement; /* hidden unless touch */
  destroy(): void;
}

const setText = (node: HTMLElement, text: string): void => { if (node.textContent !== text) node.textContent = text; };
const setClass = (node: HTMLElement, cls: string, on: boolean): void => { if (node.classList.contains(cls) !== on) node.classList.toggle(cls, on); };

/** Sum of strokes >= 0 (phase 2: scoring.totalStrokes). */
export function totalStrokesOf(state: GameState, playerId: string): number {
  const arr = state.strokes[playerId];
  if (!arr) return 0;
  let sum = 0;
  for (const s of arr) if (s >= 0) sum += s;
  return sum;
}

/** Strokes on the current hole, 0 when not started (phase 2: selectors.strokesThisHole). */
export function strokesThisHoleOf(state: GameState, playerId: string): number {
  if (state.holeIndex < 0) return 0;
  const s = state.strokes[playerId]?.[state.holeIndex] ?? -1;
  return s < 0 ? 0 : s;
}

function isTouchDevice(): boolean {
  try {
    return window.matchMedia('(pointer: coarse)').matches || navigator.maxTouchPoints > 0;
  } catch {
    return false;
  }
}

interface Chip { root: HTMLElement; name: HTMLElement; strokes: HTMLElement; status: HTMLElement; tag: HTMLElement }

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
  fireButton.hidden = !isTouchDevice();
  const countdown = el('span', { class: 'hud__countdown', hidden: true });
  const bottom = el('div', { class: 'hud__bottom' }, turnText, countdown, power, fireButton);

  const root = el('div', { class: 'hud' }, top, players, bottom);
  container.append(root);

  const chips = new Map<string, Chip>();
  let chipSignature = '';

  const buildChips = (list: PlayerState[], hostId: string | null): void => {
    players.replaceChildren();
    chips.clear();
    for (const p of list) {
      const dot = el('span', { class: 'chip__dot' });
      dot.style.setProperty('--player-colour', `var(--player-${p.colour})`);
      const name = el('span', { class: 'chip__name' }, p.name);
      const strokes = el('span', { class: 'chip__strokes' });
      const status = el('span', { class: 'chip__status' });
      const tag = el('span', { class: 'chip__tag' });
      const root = el('span', { class: 'chip', role: 'listitem', title: p.id === hostId ? t('hud.host') : '' }, dot, name, strokes, tag, status);
      chips.set(p.id, { root, name, strokes, status, tag });
      players.append(root);
    }
  };

  let lastPower: number | null = null;

  return {
    root,
    fireButton,

    update(state, localPlayerId, nowAuthorityMs) {
      const course = state.holeIndex >= 0 ? state.courses[state.holeIndex] ?? null : null;
      const inRound = state.phase === 'hole' || state.phase === 'holeSummary' || state.phase === 'roundSummary';

      // Stats
      setText(title, course ? course.name : '');
      stats.hidden = !inRound || !course;
      if (course) {
        setText(holeValue, `${state.holeIndex + 1}/${state.courses.length}`);
        setText(parValue, String(course.rules.par));
        const mine = strokesThisHoleOf(state, localPlayerId);
        setText(strokesValue, localPlayerId ? String(mine) : '–');
        setClass(strokesValue, 'is-over', mine > course.rules.par);
        setText(totalValue, localPlayerId ? String(totalStrokesOf(state, localPlayerId)) : '–');
      }

      // Chips (rebuild only when the roster changes)
      const sig = state.players.map((p) => `${p.id}:${p.name}:${p.colour}`).join('|') + `#${state.hostId ?? ''}`;
      if (sig !== chipSignature) { chipSignature = sig; buildChips(state.players, state.hostId); }
      const turnId = state.turn?.playerId ?? null;
      for (const p of state.players) {
        const c = chips.get(p.id);
        if (!c) continue;
        setClass(c.root, 'is-turn', state.phase === 'hole' && p.id === turnId);
        setClass(c.root, 'is-me', p.id === localPlayerId);
        const done = state.holeDone[p.id] === true;
        setClass(c.root, 'is-done', inRound && done);
        setClass(c.root, 'is-left', p.leftRound);
        setText(c.strokes, inRound && state.holeIndex >= 0 ? String(strokesThisHoleOf(state, p.id)) : '');
        setText(c.tag, p.leftRound ? t('hud.left') : done && state.phase === 'hole' ? t('hud.done') : p.afk ? t('hud.afk') : '');
        setClass(c.status, 'is-offline', !p.connected);
        setClass(c.status, 'is-afk', p.connected && p.afk);
        c.status.title = !p.connected ? t('hud.offline') : p.afk ? t('hud.afk') : '';
      }

      // Turn text
      let turnMsg = '';
      if (state.phase === 'hole' && state.turn) {
        const onTurn = state.players.find((p) => p.id === state.turn!.playerId);
        if (state.turn.shotInFlight) turnMsg = t('hud.shotInFlight');
        else if (state.turn.playerId === localPlayerId) turnMsg = t('hud.yourTurn');
        else turnMsg = t('hud.turn', { name: onTurn?.name ?? '?' });
      } else if (state.phase === 'holeSummary') turnMsg = t('hud.holeSummary');
      else if (state.phase === 'roundSummary') turnMsg = t('hud.roundSummary');
      else if (state.phase === 'lobby') turnMsg = t('hud.lobby');
      if (!localPlayerId && inRound) turnMsg = `${t('hud.spectating')} · ${turnMsg}`;
      setText(turnText, turnMsg);

      // Countdown
      if (state.phase === 'countdown' && state.countdownEndsAtMs !== null) {
        const s = Math.max(0, Math.ceil((state.countdownEndsAtMs - nowAuthorityMs) / 1000));
        countdown.hidden = false;
        setText(countdown, t('hud.countdown', { s }));
      } else if (!countdown.hidden) countdown.hidden = true;

      // Timer ring: only with a deadline
      const deadline = state.phase === 'hole' ? state.turn?.deadlineMs ?? null : null;
      if (deadline !== null && state.turn) {
        const onTurn = state.players.find((p) => p.id === state.turn!.playerId);
        const durationSec = onTurn && !onTurn.connected ? DISCONNECTED_TURN_WAIT_SEC : onTurn?.afk ? AFK_TURN_TIMEOUT_SEC : state.settings.turnTimeoutSec || DISCONNECTED_TURN_WAIT_SEC;
        const remainMs = Math.max(0, deadline - nowAuthorityMs);
        const frac = Math.min(1, remainMs / (durationSec * 1000));
        timer.hidden = false;
        timerRing.style.setProperty('--p', frac.toFixed(3));
        setClass(timerRing, 'is-urgent', remainMs <= 5000);
        setText(timerText, String(Math.ceil(remainMs / 1000)));
      } else if (!timer.hidden) timer.hidden = true;

      // Fire button is only meaningful on my turn
      fireButton.disabled = !(state.phase === 'hole' && state.turn && state.turn.playerId === localPlayerId && !state.turn.shotInFlight);
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
      root.remove();
      chips.clear();
    },
  };
}
