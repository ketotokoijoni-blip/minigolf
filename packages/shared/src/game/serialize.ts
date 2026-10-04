// GameState <-> JSON-safe GameStateJson (typed arrays <-> number[]). DESIGN §10.3. The GameState *is* the snapshot (D2).
import type { WorldState } from '../sim/types';
import type { GameState, GameStateJson, WorldJson } from './types';

export function worldToJson(w: WorldState): WorldJson {
  return { walls: Array.from(w.walls), breakHits: Array.from(w.breakHits), minesArmed: Array.from(w.minesArmed) };
}

export function worldFromJson(j: WorldJson): WorldState {
  return {
    walls: Uint8Array.from(j.walls),
    breakHits: Uint8Array.from(j.breakHits),
    minesArmed: Uint8Array.from(j.minesArmed),
  };
}

/** Shallow copy with the world converted; every other field of GameState is already plain JSON data. */
export function gameStateToJson(state: GameState): GameStateJson {
  const { world, ...rest } = state;
  return { ...rest, world: world === null ? null : worldToJson(world) };
}

export function gameStateFromJson(json: GameStateJson): GameState {
  const { world, ...rest } = json;
  return { ...rest, world: world === null ? null : worldFromJson(world) };
}
