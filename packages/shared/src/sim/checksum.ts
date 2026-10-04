// Sim state checksum (DESIGN §9.6): x, y, vx, vy as little-endian Float64 in a 32-byte DataView hashed with FNV-1a; the
// result seeds the hash of walls, then breakHits, then minesArmed. Pure int32 arithmetic => identical on every engine.
// Only the fields that the shot changes deterministically are hashed; every terminal sim path writes literal zeros into
// vx/vy, so a JSON round trip (-0 -> 0) never changes the result of a finished shot.
import { fnv1a32 } from '../math/hash';
import type { BallState, WorldState } from './types';

export function hashSimState(ball: BallState, world: WorldState): number {
  const buf = new ArrayBuffer(32);
  const dv = new DataView(buf);
  dv.setFloat64(0, ball.x, true);
  dv.setFloat64(8, ball.y, true);
  dv.setFloat64(16, ball.vx, true);
  dv.setFloat64(24, ball.vy, true);
  let h = fnv1a32(new Uint8Array(buf));
  h = fnv1a32(world.walls, h);
  h = fnv1a32(world.breakHits, h);
  h = fnv1a32(world.minesArmed, h);
  return h;
}
