// Objects (DESIGN §8.3 steps 2b, 2c, 7d-7f and §8.6): magnet fields, hole funnel pull and capture, mines, teleport pads,
// and the ball reset used by water/acid/mine. Every unit-vector computation guards d == 0 (D16).
import { DT } from '../constants';
import { tileOf } from '../course/grid';
import type { CourseLayers, Vec2 } from '../course/types';
import { len, unitOrZero } from '../math/vec';
import { simTuning } from './tuning';
import type { BallState, SimContext, SimEvent, WorldState } from './types';

/**
 * Adds every magnet's acceleration (course order): a = strength * (1 - d / radius) toward (polarity 1) or away from
 * (polarity -1) the centre, for MAGNET_DEAD_ZONE < d < radius. Returns true when at least one magnet acted.
 */
export function applyMagnets(layers: CourseLayers, ball: BallState): boolean {
  const t = simTuning;
  const magnets = layers.magnets;
  let acted = false;
  for (let i = 0; i < magnets.length; i++) {
    const m = magnets[i];
    if (m === undefined) continue;
    const dx = m.cx - ball.x;
    const dy = m.cy - ball.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > t.MAGNET_DEAD_ZONE && d < m.radius) {
      const a = m.strength * (1 - d / m.radius);
      const k = (m.polarity * a * DT) / d;
      ball.vx += k * dx;
      ball.vy += k * dy;
      acted = true;
    }
  }
  return acted;
}

/** Funnel pull: HOLE_PULL_ACCEL toward every cup centre closer than HOLE_PULL_RADIUS while slower than HOLE_PULL_MAX_SPEED. */
export function applyHolePull(layers: CourseLayers, ball: BallState): void {
  const t = simTuning;
  const speed = len(ball.vx, ball.vy);
  if (speed >= t.HOLE_PULL_MAX_SPEED) return;
  const holes = layers.holes;
  for (let i = 0; i < holes.length; i++) {
    const h = holes[i];
    if (h === undefined) continue;
    const dx = h.cx - ball.x;
    const dy = h.cy - ball.y;
    const d = Math.sqrt(dx * dx + dy * dy);
    if (d > 1e-9 && d < t.HOLE_PULL_RADIUS) {
      const k = (t.HOLE_PULL_ACCEL * DT) / d;
      ball.vx += k * dx;
      ball.vy += k * dy;
    }
  }
}

/** Index of the first cup (course order) within HOLE_CAPTURE_RADIUS while the ball is at most HOLE_CAPTURE_MAX_SPEED; -1 if none. */
export function findCapturingHole(layers: CourseLayers, ball: BallState): number {
  const t = simTuning;
  if (len(ball.vx, ball.vy) > t.HOLE_CAPTURE_MAX_SPEED) return -1;
  const holes = layers.holes;
  for (let i = 0; i < holes.length; i++) {
    const h = holes[i];
    if (h === undefined) continue;
    if (len(h.cx - ball.x, h.cy - ball.y) <= t.HOLE_CAPTURE_RADIUS) return i;
  }
  return -1;
}

/** Index of the first armed mine (course order) whose centre is closer than MINE_TRIGGER_RADIUS; -1 if none. */
export function findTriggeredMine(layers: CourseLayers, world: WorldState, ball: BallState): number {
  const r = simTuning.MINE_TRIGGER_RADIUS;
  const mines = layers.mines;
  for (let i = 0; i < mines.length; i++) {
    const m = mines[i];
    if (m === undefined || (world.minesArmed[i] ?? 0) === 0) continue;
    if (len(m.cx - ball.x, m.cy - ball.y) < r) return i;
  }
  return -1;
}

/**
 * Teleports the ball through the first pad (course order) within TELEPORT_TRIGGER_RADIUS that is not the cooldown pad:
 * the ball appears TELEPORT_EXIT_OFFSET px past the partner's centre along its velocity, the partner becomes the
 * cooldown pad and the teleport count grows. Returns the partner tile, or -1 when no pad fired (also once
 * ctx.teleportCount has reached MAX_TELEPORTS_PER_SHOT: pads are ignored for the rest of the shot).
 */
export function tryTeleport(layers: CourseLayers, ball: BallState, ctx: SimContext, events: SimEvent[]): number {
  const t = simTuning;
  if (ctx.teleportCount >= t.MAX_TELEPORTS_PER_SHOT) return -1;
  const pads = layers.teleports;
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (pad === undefined || pad.tile === ball.teleportCooldownTile) continue;
    if (len(pad.cx - ball.x, pad.cy - ball.y) >= t.TELEPORT_TRIGGER_RADIUS) continue;
    const partner = pads[pad.partnerIndex];
    if (partner === undefined) return -1;
    const u = unitOrZero(ball.vx, ball.vy);
    ball.x = partner.cx + u.x * t.TELEPORT_EXIT_OFFSET;
    ball.y = partner.cy + u.y * t.TELEPORT_EXIT_OFFSET;
    ball.teleportCooldownTile = partner.tile;
    ctx.teleportCount++;
    events.push({ tick: ctx.tick, type: 'teleport', from: pad.tile, to: partner.tile });
    return partner.tile;
  }
  return -1;
}

/** Water/acid/mine reset: ball at rest on p with every per-shot flag cleared (§8.3 resetBall). */
export function resetBall(ball: BallState, p: Vec2): void {
  ball.x = p.x;
  ball.y = p.y;
  ball.vx = 0;
  ball.vy = 0;
  ball.moving = false;
  ball.lastTile = tileOf(p.x, p.y);
  ball.teleportCooldownTile = -1;
  ball.insideOneWay = -1;
  ball.slowTicks = 0;
}
