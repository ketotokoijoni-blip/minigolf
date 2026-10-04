// Per-hole mutable world state and ball construction, shared by the sim (WP-B), the reducer (WP-C) and the client
// (DESIGN §10.1). Runtime imports are WP0 modules only: constants, course/chars, course/grid.
import { COURSE_H, COURSE_W, TILE, TILE_COUNT } from '../constants';
import { wallFromChar } from '../course/chars';
import { tileIndex, tileOf } from '../course/grid';
import type { Course, Vec2 } from '../course/types';
import type { BallState, WorldDelta, WorldState } from './types';

/** Fresh world: a copy of `walls` (the input is not retained), zero hits taken, every mine armed. */
export function createWorld(walls: Uint8Array, mineCount: number): WorldState {
  const minesArmed = new Uint8Array(mineCount);
  minesArmed.fill(1);
  return { walls: walls.slice(), breakHits: new Uint8Array(TILE_COUNT), minesArmed };
}

/**
 * World for the start of a hole, straight from the course file: walls decoded row-major from the wall rows with
 * wallFromChar, mineCount = number of 'mine' objects in course order (the order WP-A's decodeLayers uses for
 * CourseLayers.mines, so minesArmed[i] refers to the i-th mine object). Precondition: validateCourse(course) has no
 * errors; malformed rows throw rather than being silently repaired.
 */
export function createWorldFromCourse(course: Course): WorldState {
  const rows = course.walls;
  if (rows.length !== COURSE_H) {
    throw new Error(`createWorldFromCourse: expected ${COURSE_H} wall rows, got ${rows.length}`);
  }
  const walls = new Uint8Array(TILE_COUNT);
  for (let y = 0; y < COURSE_H; y++) {
    const row = rows[y] ?? '';
    if (row.length !== COURSE_W) {
      throw new Error(`createWorldFromCourse: wall row ${y} has ${row.length} chars, expected ${COURSE_W}`);
    }
    for (let x = 0; x < COURSE_W; x++) {
      const ch = row.charAt(x);
      const w = wallFromChar(ch);
      if (w === undefined) throw new Error(`createWorldFromCourse: bad wall char '${ch}' at (${x}, ${y})`);
      walls[tileIndex(x, y)] = w;
    }
  }
  let mineCount = 0;
  for (const o of course.objects) if (o.type === 'mine') mineCount++;
  return createWorld(walls, mineCount);
}

export function cloneWorld(w: WorldState): WorldState {
  return { walls: w.walls.slice(), breakHits: w.breakHits.slice(), minesArmed: w.minesArmed.slice() };
}

/** Tiles whose wall code or hit count changed (ascending index, both current values) and the mines that went from armed to disarmed. */
export function diffWorld(before: WorldState, after: WorldState): WorldDelta {
  const tiles: WorldDelta['tiles'] = [];
  const n = after.walls.length;
  for (let i = 0; i < n; i++) {
    const wall = after.walls[i] ?? 0;
    const hits = after.breakHits[i] ?? 0;
    if (wall !== (before.walls[i] ?? 0) || hits !== (before.breakHits[i] ?? 0)) tiles.push({ i, wall, hits });
  }
  const minesDisarmed: number[] = [];
  const m = after.minesArmed.length;
  for (let i = 0; i < m; i++) {
    if ((after.minesArmed[i] ?? 0) === 0 && (before.minesArmed[i] ?? 0) !== 0) minesDisarmed.push(i);
  }
  return { tiles, minesDisarmed };
}

/** New world with the delta applied (tiles[i] sets walls & breakHits, minesDisarmed sets 0); `w` is left untouched. */
export function applyWorldDelta(w: WorldState, d: WorldDelta): WorldState {
  const next = cloneWorld(w);
  for (const t of d.tiles) {
    next.walls[t.i] = t.wall;
    next.breakHits[t.i] = t.hits;
  }
  for (const i of d.minesDisarmed) next.minesArmed[i] = 0;
  return next;
}

/** Resting ball at p: {x,y,vx:0,vy:0,moving:false,lastTile:tileOf(p.x,p.y),teleportCooldownTile:-1,insideOneWay:-1,slowTicks:0}. */
export function createBallAt(p: Vec2): BallState {
  return {
    x: p.x,
    y: p.y,
    vx: 0,
    vy: 0,
    moving: false,
    lastTile: tileOf(p.x, p.y),
    teleportCooldownTile: -1,
    insideOneWay: -1,
    slowTicks: 0,
  };
}

/** World centre ((x+0.5)*TILE, (y+0.5)*TILE) of the 'start' object; throws if absent (validation guarantees presence). */
export function startCentre(course: Course): Vec2 {
  for (const o of course.objects) {
    if (o.type === 'start') return { x: (o.x + 0.5) * TILE, y: (o.y + 0.5) * TILE };
  }
  throw new Error('startCentre: course has no start object');
}
