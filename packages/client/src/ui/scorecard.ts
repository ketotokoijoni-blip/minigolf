// Scorecard table (DESIGN §12.7). Idempotent: every call rebuilds the table from the state. Phase 2: totals, to-par
// and ranking come from WP-C scoring.ts; the pure `scorecardModel()` is what the node tests check.
import type { GameState, PlayerColour, PlayerState, RankingEntry } from '@puttipeli/shared/game/types';
import { parPlayed, ranking, toPar, totalStrokes } from '@puttipeli/shared/game/scoring';
import { el } from './components';
import { t } from '../i18n/t';

export type ScoreClass = '' | 'under' | 'over' | 'max';

export interface ScorecardCell { text: string; cls: ScoreClass; current: boolean }

export interface ScorecardRow {
  playerId: string;
  name: string;
  colour: PlayerColour;
  isMe: boolean;
  left: boolean;
  cells: ScorecardCell[];
  total: number;
  /** Formatted to-par ('E', '+2', '-1') or '–' before any hole has been played. */
  toPar: string;
  toParCls: ScoreClass;
  /** '1.' etc., '' when ranking is not shown. */
  rank: string;
}

export interface ScorecardModel {
  holes: { index: number; name: string; par: number; current: boolean }[];
  parTotal: number;
  rows: ScorecardRow[];
  /** Rank column shown: final ranking after roundEnded, or live standings during a multi-player round (hole phases only). */
  showRank: boolean;
  final: boolean;
}

const ROUND_PHASES: readonly GameState['phase'][] = ['hole', 'holeSummary', 'roundSummary'];

export function formatToPar(diff: number): string {
  if (diff === 0) return t('scorecard.even');
  return diff > 0 ? `+${diff}` : String(diff);
}

/** Players in seat order (frozen at gameStarted); players not in seatOrder (lobby) follow in joinedSeq order. */
export function orderedPlayers(state: GameState): PlayerState[] {
  if (state.seatOrder.length === 0) return state.players;
  const byId = new Map(state.players.map((p) => [p.id, p]));
  const seated = state.seatOrder.map((id) => byId.get(id)).filter((p): p is PlayerState => !!p);
  const rest = state.players.filter((p) => !state.seatOrder.includes(p.id));
  return [...seated, ...rest];
}

function scoreClass(strokes: number, par: number, maxStrokes: number): ScoreClass {
  if (strokes >= maxStrokes) return 'max';
  if (strokes < par) return 'under';
  if (strokes > par) return 'over';
  return '';
}

export function scorecardModel(state: GameState, localPlayerId: string): ScorecardModel {
  const holes = state.courses.map((c, i) => ({ index: i, name: c.name, par: c.rules.par, current: i === state.holeIndex }));
  const parTotal = holes.reduce((sum, h) => sum + h.par, 0);
  const final = state.ranking !== null;
  // Live standings only once a round is under way; in the lobby and the countdown everyone would be tied at '1.'.
  const showRank = final || (ROUND_PHASES.includes(state.phase) && state.players.length > 1);
  const entries: RankingEntry[] = state.ranking ?? (showRank ? ranking(state) : []);
  const rankOf = new Map(entries.map((r) => [r.playerId, r.rank]));

  const rows: ScorecardRow[] = orderedPlayers(state).map((p) => {
    const strokes = state.strokes[p.id] ?? [];
    const cells: ScorecardCell[] = state.courses.map((course, i) => {
      const s = strokes[i] ?? -1;
      return {
        text: s < 0 ? t('scorecard.notPlayed') : String(s),
        cls: s < 0 ? '' : scoreClass(s, course.rules.par, course.rules.maxStrokes),
        current: i === state.holeIndex,
      };
    });
    const played = parPlayed(state, p.id);
    const diff = toPar(state, p.id);
    const rank = rankOf.get(p.id);
    return {
      playerId: p.id,
      name: p.name,
      colour: p.colour,
      isMe: p.id === localPlayerId,
      left: p.leftRound,
      cells,
      total: totalStrokes(state, p.id),
      toPar: played > 0 ? formatToPar(diff) : t('scorecard.notPlayed'),
      toParCls: played > 0 && diff !== 0 ? (diff < 0 ? 'under' : 'over') : '',
      rank: showRank && rank !== undefined ? `${rank}.` : '',
    };
  });

  return { holes, parTotal, rows, showRank, final };
}

const clsName = (cls: ScoreClass): string => (cls ? `score-${cls}` : '');

export function renderScorecard(container: HTMLElement, state: GameState, localPlayerId: string): void {
  const m = scorecardModel(state, localPlayerId);
  const table = el('table', { 'aria-label': t('scorecard.title') });

  // Header
  const head = el('tr', {}, el('th', { scope: 'col' }, t('scorecard.player')));
  for (const h of m.holes) {
    const th = el('th', { scope: 'col', title: h.name }, String(h.index + 1));
    if (h.current) th.classList.add('is-current-hole');
    head.append(th);
  }
  head.append(el('th', { scope: 'col', class: 'total' }, t('scorecard.total')), el('th', { scope: 'col' }, t('scorecard.toPar')));
  if (m.showRank) head.append(el('th', { scope: 'col', title: m.final ? '' : t('scorecard.live') }, t('scorecard.rank')));
  table.append(el('thead', {}, head));

  const body = el('tbody');

  // Par row
  const parRow = el('tr', { class: 'row-par' }, el('td', {}, t('scorecard.par')));
  for (const h of m.holes) {
    const td = el('td', {}, String(h.par));
    if (h.current) td.classList.add('is-current-hole');
    parRow.append(td);
  }
  parRow.append(el('td', { class: 'total' }, String(m.parTotal)), el('td', {}, ''));
  if (m.showRank) parRow.append(el('td', {}, ''));
  body.append(parRow);

  // Player rows
  for (const r of m.rows) {
    const row = el('tr');
    if (r.isMe) row.classList.add('is-me');
    if (r.left) row.classList.add('is-left');
    const dot = el('span', { class: 'chip__dot' });
    dot.style.setProperty('--player-colour', `var(--player-${r.colour})`);
    const nameCell = el('span', { class: 'scorecard__name' }, dot, el('span', {}, r.name));
    if (r.left) nameCell.append(el('span', { class: 'badge' }, t('scorecard.left')));
    row.append(el('td', {}, nameCell));

    for (const c of r.cells) {
      const td = el('td', {}, c.text);
      if (c.current) td.classList.add('is-current-hole');
      if (c.cls) td.classList.add(clsName(c.cls));
      row.append(td);
    }

    const diffCell = el('td', {}, r.toPar);
    if (r.toParCls) diffCell.classList.add(clsName(r.toParCls));
    row.append(el('td', { class: 'total' }, String(r.total)), diffCell);
    if (m.showRank) row.append(el('td', { class: 'rank' }, r.rank));
    body.append(row);
  }
  table.append(body);

  container.classList.add('scorecard');
  container.replaceChildren(table);
}
