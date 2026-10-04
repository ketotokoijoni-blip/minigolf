// Scorecard table (DESIGN §12.7). Idempotent: every call rebuilds the table from the state. Phase 1 computes totals
// and ranking locally from GameState; phase 2 swaps in WP-C scoring.ts.
import type { GameState, PlayerState } from '@puttipeli/shared/game/types';
import { el } from './components';
import { t } from '../i18n/t';
import { totalStrokesOf } from './hud';

/** Par over the holes a player has finished or is playing (strokes >= 0). */
export function parPlayedOf(state: GameState, playerId: string): number {
  const arr = state.strokes[playerId];
  if (!arr) return 0;
  let sum = 0;
  arr.forEach((s, i) => { if (s >= 0) sum += state.courses[i]?.rules.par ?? 0; });
  return sum;
}

export function formatToPar(diff: number): string {
  if (diff === 0) return t('scorecard.even');
  return diff > 0 ? `+${diff}` : String(diff);
}

function orderedPlayers(state: GameState): PlayerState[] {
  if (state.seatOrder.length === 0) return state.players;
  const byId = new Map(state.players.map((p) => [p.id, p]));
  const seated = state.seatOrder.map((id) => byId.get(id)).filter((p): p is PlayerState => !!p);
  const rest = state.players.filter((p) => !state.seatOrder.includes(p.id));
  return [...seated, ...rest];
}

export function renderScorecard(container: HTMLElement, state: GameState, localPlayerId: string): void {
  const holes = state.courses.length;
  const table = el('table', { 'aria-label': t('scorecard.title') });

  // Header
  const head = el('tr', {}, el('th', { scope: 'col' }, t('scorecard.player')));
  for (let i = 0; i < holes; i++) {
    const th = el('th', { scope: 'col', title: state.courses[i]?.name ?? '' }, String(i + 1));
    if (i === state.holeIndex) th.classList.add('is-current-hole');
    head.append(th);
  }
  head.append(el('th', { scope: 'col', class: 'total' }, t('scorecard.total')), el('th', { scope: 'col' }, t('scorecard.toPar')));
  if (state.ranking) head.append(el('th', { scope: 'col' }, t('scorecard.rank')));
  table.append(el('thead', {}, head));

  const body = el('tbody');

  // Par row
  const parRow = el('tr', { class: 'row-par' }, el('td', {}, t('scorecard.par')));
  let parTotal = 0;
  for (let i = 0; i < holes; i++) {
    const par = state.courses[i]?.rules.par ?? 0;
    parTotal += par;
    const td = el('td', {}, String(par));
    if (i === state.holeIndex) td.classList.add('is-current-hole');
    parRow.append(td);
  }
  parRow.append(el('td', { class: 'total' }, String(parTotal)), el('td', {}, ''));
  if (state.ranking) parRow.append(el('td', {}, ''));
  body.append(parRow);

  // Player rows
  const rankOf = new Map((state.ranking ?? []).map((r) => [r.playerId, r.rank]));
  for (const p of orderedPlayers(state)) {
    const row = el('tr');
    if (p.id === localPlayerId) row.classList.add('is-me');
    if (p.leftRound) row.classList.add('is-left');
    const dot = el('span', { class: 'chip__dot' });
    dot.style.setProperty('--player-colour', `var(--player-${p.colour})`);
    const nameCell = el('span', { class: 'scorecard__name' }, dot, el('span', {}, p.name));
    if (p.leftRound) nameCell.append(el('span', { class: 'badge' }, t('scorecard.left')));
    row.append(el('td', {}, nameCell));

    const strokes = state.strokes[p.id] ?? [];
    for (let i = 0; i < holes; i++) {
      const s = strokes[i] ?? -1;
      const course = state.courses[i];
      const td = el('td', {}, s < 0 ? t('scorecard.notPlayed') : String(s));
      if (i === state.holeIndex) td.classList.add('is-current-hole');
      if (s >= 0 && course) {
        if (s >= course.rules.maxStrokes) td.classList.add('score-max');
        else if (s < course.rules.par) td.classList.add('score-under');
        else if (s > course.rules.par) td.classList.add('score-over');
      }
      row.append(td);
    }

    const total = totalStrokesOf(state, p.id);
    const played = parPlayedOf(state, p.id);
    const diff = total - played;
    const diffCell = el('td', {}, played > 0 ? formatToPar(diff) : t('scorecard.notPlayed'));
    if (played > 0 && diff !== 0) diffCell.classList.add(diff < 0 ? 'score-under' : 'score-over');
    row.append(el('td', { class: 'total' }, String(total)), diffCell);
    if (state.ranking) {
      const r = rankOf.get(p.id);
      row.append(el('td', { class: 'rank' }, r === undefined ? '' : `${r}.`));
    }
    body.append(row);
  }
  table.append(body);

  container.classList.add('scorecard');
  container.replaceChildren(table);
}
