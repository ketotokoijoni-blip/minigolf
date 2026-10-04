// Scorecard arithmetic (DESIGN §10.3). Strokes are stored per hole index; -1 means "not played".
import type { GameState, RankingEntry } from './types';

/** Sum of the player's strokes over played holes (entries >= 0). */
export function totalStrokes(state: GameState, playerId: string): number {
  const row = state.strokes[playerId];
  if (row === undefined) return 0;
  let sum = 0;
  for (const s of row) if (s >= 0) sum += s;
  return sum;
}

/** Sum of par over the holes the player has played (strokes >= 0). */
export function parPlayed(state: GameState, playerId: string): number {
  const row = state.strokes[playerId];
  if (row === undefined) return 0;
  let sum = 0;
  for (let i = 0; i < row.length; i++) {
    if ((row[i] ?? -1) >= 0) sum += state.courses[i]?.rules.par ?? 0;
  }
  return sum;
}

/** Strokes relative to par over the played holes (negative = under par). */
export function toPar(state: GameState, playerId: string): number {
  return totalStrokes(state, playerId) - parPlayed(state, playerId);
}

/**
 * Active players by total ascending; ties share a rank and the next rank skips (1, 1, 3). Equal totals keep seat order
 * (players are sorted by joinedSeq). Players with `leftRound` are appended, also by total, all with
 * rank = number of active players + 1.
 */
export function ranking(state: GameState): RankingEntry[] {
  const withTotals = state.players.map((p, i) => ({ p, i, total: totalStrokes(state, p.id) }));
  const byTotal = (a: { total: number; i: number }, b: { total: number; i: number }) => a.total - b.total || a.i - b.i;
  const active = withTotals.filter((e) => !e.p.leftRound).sort(byTotal);
  const left = withTotals.filter((e) => e.p.leftRound).sort(byTotal);
  const out: RankingEntry[] = [];
  for (let k = 0; k < active.length; k++) {
    const e = active[k]!;
    const prev = k > 0 ? out[k - 1]! : null;
    const rank = prev !== null && prev.total === e.total ? prev.rank : k + 1;
    out.push({ playerId: e.p.id, total: e.total, rank });
  }
  const leftRank = active.length + 1;
  for (const e of left) out.push({ playerId: e.p.id, total: e.total, rank: leftRank });
  return out;
}
