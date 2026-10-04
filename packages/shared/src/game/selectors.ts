// Read-only views over GameState used by the HUD, the controller and the Authority (DESIGN §10.3).
import type { Course, Vec2 } from '../course/types';
import type { BallState } from '../sim/types';
import type { GameState, PlayerState } from './types';

export function currentCourse(state: GameState): Course | null {
  if (state.holeIndex < 0) return null;
  return state.courses[state.holeIndex] ?? null;
}

export function currentPlayerId(state: GameState): string | null {
  return state.turn?.playerId ?? null;
}

export function playerOf(state: GameState, id: string): PlayerState | null {
  return state.players.find((p) => p.id === id) ?? null;
}

export function ballOf(state: GameState, id: string): BallState | null {
  return state.balls[id] ?? null;
}

/** Strokes on the current hole; 0 when the hole has not been played or there is no current hole. */
export function strokesThisHole(state: GameState, id: string): number {
  if (state.holeIndex < 0) return 0;
  const s = state.strokes[id]?.[state.holeIndex] ?? -1;
  return s < 0 ? 0 : s;
}

/** phase 'hole' && turn && turn.playerId === id && !turn.shotInFlight */
export function isMyTurn(state: GameState, id: string): boolean {
  return state.phase === 'hole' && state.turn !== null && state.turn.playerId === id && !state.turn.shotInFlight;
}

/**
 * Centres of the resting balls of the *other* players who are still playing this hole (not holeDone, not leftRound).
 * Holed and max-stroke balls have left the field, so they are not obstacles (movable block target check, D29).
 */
export function otherBallCentres(state: GameState, exceptId: string): Vec2[] {
  const out: Vec2[] = [];
  for (const p of state.players) {
    if (p.id === exceptId || p.leftRound || state.holeDone[p.id]) continue;
    const b = state.balls[p.id];
    if (b === undefined || b.moving) continue;
    out.push({ x: b.x, y: b.y });
  }
  return out;
}
