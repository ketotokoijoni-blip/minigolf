// Turn-order rules shared by the reducer, the Authority and the clients (DESIGN §10.3). Pure functions over GameState.
import { ErrorCode } from '../protocol/codes';
import type { GameState, PlayerState } from './types';

/**
 * Turn order for hole `holeIndex`: `seatOrder` rotated left by `holeIndex % n` (so the first shooter rotates every
 * hole), with `leftRound` players (and ids that are no longer in `players`) dropped.
 */
export function holeOrder(seatOrder: readonly string[], holeIndex: number, players: readonly PlayerState[]): string[] {
  const n = seatOrder.length;
  if (n === 0) return [];
  const shift = ((holeIndex % n) + n) % n;
  const out: string[] = [];
  for (let k = 0; k < n; k++) {
    const id = seatOrder[(shift + k) % n]!;
    const p = players.find((q) => q.id === id);
    if (p !== undefined && !p.leftRound) out.push(id);
  }
  return out;
}

function isEligible(state: GameState, id: string): boolean {
  if (state.holeDone[id]) return false;
  const p = state.players.find((q) => q.id === id);
  return p !== undefined && !p.leftRound;
}

/**
 * Cyclic walk of `state.order` starting after `afterPlayerId` (from index 0 when null); returns the first player who is
 * neither `holeDone` nor `leftRound`, or null when nobody is left to play.
 *
 * A player who leaves while on turn is removed from `order` by the reducer before the Authority asks for the next
 * player, so `after` may be absent from `order`. In that case the walk starts at the first `order` entry that follows
 * `after` in the rotated seat order (falling back to index 0), which keeps the rotation intact.
 */
export function nextTurnPlayer(state: GameState, afterPlayerId: string | null): string | null {
  const order = state.order;
  const n = order.length;
  if (n === 0) return null;
  let start = 0;
  if (afterPlayerId !== null) {
    const idx = order.indexOf(afterPlayerId);
    if (idx >= 0) {
      start = (idx + 1) % n;
    } else {
      const seats = state.seatOrder;
      const m = seats.length;
      const seatIdx = seats.indexOf(afterPlayerId);
      if (seatIdx >= 0 && m > 0) {
        for (let k = 1; k < m; k++) {
          const candidate = order.indexOf(seats[(seatIdx + k) % m]!);
          if (candidate >= 0) {
            start = candidate;
            break;
          }
        }
      }
    }
  }
  for (let k = 0; k < n; k++) {
    const id = order[(start + k) % n]!;
    if (isEligible(state, id)) return id;
  }
  return null;
}

/** True when nobody in `order` can still shoot on this hole (also true for an empty order). */
export function isHoleComplete(state: GameState): boolean {
  for (const id of state.order) if (isEligible(state, id)) return false;
  return true;
}

/** Players who have not left the round. */
export function activePlayers(state: GameState): PlayerState[] {
  return state.players.filter((p) => !p.leftRound);
}

/**
 * Lobby start gate: NOT_IN_LOBBY | INVALID_COURSE (empty set, cannot normally happen) | NOT_ENOUGH_PLAYERS (connected
 * players < minPlayers) | PLAYERS_NOT_READY (a connected non-host player is not ready; disconnected lobby players are
 * ignored, they are removed after LOBBY_DISCONNECT_REMOVE_SEC anyway).
 */
export function canStart(state: GameState, minPlayers: 1 | 2): ErrorCode | null {
  if (state.phase !== 'lobby') return ErrorCode.NOT_IN_LOBBY;
  if (state.courses.length < 1) return ErrorCode.INVALID_COURSE;
  const connected = state.players.filter((p) => p.connected);
  if (connected.length < minPlayers) return ErrorCode.NOT_ENOUGH_PLAYERS;
  for (const p of connected) if (p.id !== state.hostId && !p.ready) return ErrorCode.PLAYERS_NOT_READY;
  return null;
}
