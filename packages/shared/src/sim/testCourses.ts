// Hand-built CourseLayers fixtures and sim-driving helpers for the WP-B tests (DESIGN §15 WP-B). buildLayers() is a
// WP-B-private decoder that duplicates only what the tests need; production code uses WP-A's decodeLayers. Nothing here
// is imported by production sim code. Golden fixtures refer to the named courses as 'test:<name>'.
import { COURSE_H, COURSE_W, DEFAULT_MAX_STROKES, DEFAULT_PAR, SHOT_QUANTUM, TILE, TILE_COUNT } from '../constants';
import { surfaceFromChar, wallFromChar } from '../course/chars';
import { inBounds, tileIndex } from '../course/grid';
import type {
  CourseLayers, CourseObject, CourseRules, HoleDef, MagnetDef, MineDef, Polarity, TeleportGroup, TeleportPad, Vec2,
} from '../course/types';
import { createWorld } from './worldState';
import { stepTick } from './step';
import { simTuning } from './tuning';
import type { BallState, ShotInput, SimContext, SimEvent, StepStatus, WorldState } from './types';

// ---------------------------------------------------------------------------------------------------------------------
// Row painting

/** COURSE_H rows of COURSE_W copies of `ch`. */
export function blankRows(ch: string = '.'): string[] {
  const rows: string[] = [];
  for (let y = 0; y < COURSE_H; y++) rows.push(ch.repeat(COURSE_W));
  return rows;
}

/** Wall rows with a Full ('#') ring and None inside. */
export function borderRows(): string[] {
  const rows = blankRows('.');
  paintRect(rows, 0, 0, COURSE_W - 1, COURSE_H - 1, '#', true);
  return rows;
}

export function paint(rows: string[], x: number, y: number, ch: string): void {
  if (!inBounds(x, y)) throw new Error(`paint: (${x}, ${y}) is outside the field`);
  if (ch.length !== 1) throw new Error(`paint: expected one character, got '${ch}'`);
  const row = rows[y] ?? '';
  rows[y] = row.slice(0, x) + ch + row.slice(x + 1);
}

/** Inclusive rectangle; `outline` paints only its ring. */
export function paintRect(rows: string[], x0: number, y0: number, x1: number, y1: number, ch: string, outline: boolean = false): void {
  const xa = Math.min(x0, x1);
  const xb = Math.max(x0, x1);
  const ya = Math.min(y0, y1);
  const yb = Math.max(y0, y1);
  for (let y = ya; y <= yb; y++) {
    for (let x = xa; x <= xb; x++) {
      if (outline && x !== xa && x !== xb && y !== ya && y !== yb) continue;
      paint(rows, x, y, ch);
    }
  }
}

export function paintRow(rows: string[], y: number, x0: number, x1: number, ch: string): void {
  paintRect(rows, x0, y, x1, y, ch);
}

export function paintCol(rows: string[], x: number, y0: number, y1: number, ch: string): void {
  paintRect(rows, x, y0, x, y1, ch);
}

// ---------------------------------------------------------------------------------------------------------------------
// Objects

export const start = (x: number, y: number): CourseObject => ({ type: 'start', x, y });
export const hole = (x: number, y: number): CourseObject => ({ type: 'hole', x, y });
export const teleport = (x: number, y: number, group: TeleportGroup): CourseObject => ({ type: 'teleport', x, y, group });
export const magnet = (x: number, y: number, polarity: Polarity, strength: number, radius: number): CourseObject =>
  ({ type: 'magnet', x, y, polarity, strength, radius });
export const mine = (x: number, y: number): CourseObject => ({ type: 'mine', x, y });

/** World centre of tile (x, y). */
export const centreOf = (x: number, y: number): Vec2 => ({ x: (x + 0.5) * TILE, y: (y + 0.5) * TILE });

// ---------------------------------------------------------------------------------------------------------------------
// Decoder

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/**
 * Decodes 25 x 49 surface and wall rows plus objects into CourseLayers. Throws on bad dimensions or characters, on a
 * missing start, when any object tile is used twice, and when a teleport group does not have exactly two pads. Does not
 * validate the rest (a hole is optional, objects may sit on walls), so tests can build deliberately odd geometry.
 */
export function buildLayers(
  surfaceRows: readonly string[], wallRows: readonly string[], objects: readonly CourseObject[], rules?: Partial<CourseRules>,
): CourseLayers {
  if (surfaceRows.length !== COURSE_H || wallRows.length !== COURSE_H) throw new Error('buildLayers: expected 25 rows');
  const surface = new Uint8Array(TILE_COUNT);
  const walls = new Uint8Array(TILE_COUNT);
  for (let y = 0; y < COURSE_H; y++) {
    const s = surfaceRows[y] ?? '';
    const w = wallRows[y] ?? '';
    if (s.length !== COURSE_W || w.length !== COURSE_W) throw new Error(`buildLayers: row ${y} is not 49 characters`);
    for (let x = 0; x < COURSE_W; x++) {
      const sc = surfaceFromChar(s.charAt(x));
      const wc = wallFromChar(w.charAt(x));
      if (sc === undefined) throw new Error(`buildLayers: bad surface char '${s.charAt(x)}' at (${x}, ${y})`);
      if (wc === undefined) throw new Error(`buildLayers: bad wall char '${w.charAt(x)}' at (${x}, ${y})`);
      surface[tileIndex(x, y)] = sc;
      walls[tileIndex(x, y)] = wc;
    }
  }
  const objectAt = new Int16Array(TILE_COUNT).fill(-1);
  const list: CourseObject[] = [];
  const holes: HoleDef[] = [];
  const mines: MineDef[] = [];
  const magnets: MagnetDef[] = [];
  const pads: TeleportPad[] = [];
  let startPos: Vec2 | null = null;
  let startTile = -1;
  for (let i = 0; i < objects.length; i++) {
    const o = objects[i];
    if (o === undefined) continue;
    if (!inBounds(o.x, o.y)) throw new Error(`buildLayers: object ${i} is outside the field`);
    const tile = tileIndex(o.x, o.y);
    if (objectAt[tile] !== -1) throw new Error(`buildLayers: two objects on tile (${o.x}, ${o.y})`);
    objectAt[tile] = list.length;
    list.push(o);
    const c = centreOf(o.x, o.y);
    switch (o.type) {
      case 'start':
        if (startPos !== null) throw new Error('buildLayers: more than one start');
        startPos = c;
        startTile = tile;
        break;
      case 'hole':
        holes.push({ tile, cx: c.x, cy: c.y });
        break;
      case 'mine':
        mines.push({ tile, cx: c.x, cy: c.y });
        break;
      case 'magnet':
        magnets.push({
          tile, cx: c.x, cy: c.y, polarity: o.polarity,
          strength: clamp(o.strength, simTuning.MAGNET_MIN_STRENGTH, simTuning.MAGNET_MAX_STRENGTH),
          radius: clamp(o.radius, simTuning.MAGNET_MIN_RADIUS, simTuning.MAGNET_MAX_RADIUS),
        });
        break;
      case 'teleport':
        pads.push({ tile, cx: c.x, cy: c.y, group: o.group, partnerTile: -1, partnerIndex: -1 });
        break;
    }
  }
  if (startPos === null) throw new Error('buildLayers: no start object');
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i];
    if (pad === undefined) continue;
    let partner = -1;
    let count = 0;
    for (let j = 0; j < pads.length; j++) {
      const other = pads[j];
      if (other !== undefined && other.group === pad.group) {
        count++;
        if (j !== i) partner = j;
      }
    }
    if (count !== 2 || partner === -1) throw new Error(`buildLayers: teleport group ${pad.group} has ${count} pads, expected 2`);
    pad.partnerIndex = partner;
    pad.partnerTile = pads[partner]?.tile ?? -1;
  }
  return {
    surface,
    walls,
    objectAt,
    objects: list,
    start: startPos,
    startTile,
    holes,
    teleports: pads,
    magnets,
    mines,
    maxStrokes: rules?.maxStrokes ?? DEFAULT_MAX_STROKES,
    par: rules?.par ?? DEFAULT_PAR,
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Named test courses (golden fixtures use 'test:<name>')

/** No walls at all (an open border): only the implicit out-of-bounds ring keeps the ball in. */
function openCourse(): CourseLayers {
  return buildLayers(blankRows('.'), blankRows('.'), [start(3, 12), hole(45, 12)]);
}

/** Torture course: every wall shape, every surface, every object type. */
function arenaCourse(): CourseLayers {
  const w = borderRows();
  paint(w, 1, 1, '7');
  paint(w, 47, 1, '9');
  paint(w, 1, 23, '1');
  paint(w, 47, 23, '3');
  // central diamond of four triangles
  paint(w, 23, 11, '3');
  paint(w, 24, 11, '1');
  paint(w, 23, 12, '9');
  paint(w, 24, 12, '7');
  // breakable column
  for (let i = 0; i < 7; i++) paint(w, 12, 9 + i, 'xyz'.charAt(i % 3));
  paint(w, 18, 6, 'M');
  paint(w, 18, 18, 'M');
  paint(w, 30, 8, 'O');
  paint(w, 30, 16, 'O');
  paint(w, 36, 12, 'O');
  // wall column with an eastward one-way gate
  paintCol(w, 40, 9, 15, '#');
  paint(w, 40, 12, '>');
  // wall row with two southward gates leading onto the slope below
  paintRow(w, 16, 3, 10, '#');
  paint(w, 6, 16, 'v');
  paint(w, 7, 16, 'v');
  // magnet blocks
  paint(w, 28, 12, '#');
  paint(w, 16, 12, '#');

  const s = blankRows('.');
  paintRect(s, 5, 3, 9, 6, 's');
  paintRect(s, 26, 18, 34, 22, 'i');
  paint(s, 15, 3, 't');
  paint(s, 16, 3, 't');
  paintRect(s, 20, 19, 22, 21, 'w');
  paintRect(s, 42, 20, 44, 21, 'a');
  paintRect(s, 3, 17, 10, 22, '2');
  paintRect(s, 30, 2, 34, 4, '6');
  paintRect(s, 42, 16, 46, 18, '4');

  return buildLayers(s, w, [
    start(2, 12),
    hole(46, 12),
    hole(46, 3),
    teleport(10, 2, 0),
    teleport(38, 21, 0),
    magnet(28, 12, 1, 350, 90),
    magnet(16, 12, -1, 300, 75),
    mine(20, 8),
    mine(20, 16),
    mine(44, 8),
  ], { par: 4 });
}

/** Serpentine of 15 px corridors with one-way gates and a breakable wall. */
function corridorsCourse(): CourseLayers {
  const w = blankRows('#');
  const s = blankRows('.');
  for (let i = 0; i < 6; i++) paintRow(w, 2 + 4 * i, 1, 47, '.');
  paintCol(w, 47, 2, 6, '.');
  paintCol(w, 1, 6, 10, '.');
  paintCol(w, 47, 10, 14, '.');
  paintCol(w, 1, 14, 18, '.');
  paintCol(w, 47, 18, 22, '.');
  paint(w, 24, 6, '<');
  paint(w, 10, 10, '>');
  paint(w, 24, 14, '<');
  paint(w, 30, 18, 'y');
  paintRow(s, 10, 1, 47, 'i');
  paintRow(s, 18, 5, 9, 's');
  return buildLayers(s, w, [start(1, 2), hole(1, 22)], { par: 6 });
}

/** Four slope fields converging on a central cup, with four pillars. */
function slopesCourse(): CourseLayers {
  const w = borderRows();
  paint(w, 12, 6, '#');
  paint(w, 12, 18, '#');
  paint(w, 36, 6, '#');
  paint(w, 36, 18, '#');
  const s = blankRows('.');
  paintRect(s, 1, 1, 22, 23, '6');
  paintRect(s, 26, 1, 47, 23, '4');
  paintRect(s, 23, 1, 25, 10, '2');
  paintRect(s, 23, 14, 25, 23, '8');
  return buildLayers(s, w, [start(2, 12), hole(24, 12)], { par: 2 });
}

/** All ice with five bumpers and chamfered corners: long shots with many bounces. */
function iceCourse(): CourseLayers {
  const w = borderRows();
  paint(w, 1, 1, '7');
  paint(w, 47, 1, '9');
  paint(w, 1, 23, '1');
  paint(w, 47, 23, '3');
  paint(w, 10, 6, 'O');
  paint(w, 10, 18, 'O');
  paint(w, 24, 12, 'O');
  paint(w, 38, 6, 'O');
  paint(w, 38, 18, 'O');
  return buildLayers(blankRows('i'), w, [start(2, 12), hole(46, 12)], { par: 3 });
}

const TEST_COURSE_BUILDERS: readonly (readonly [string, () => CourseLayers])[] = [
  ['open', openCourse],
  ['arena', arenaCourse],
  ['corridors', corridorsCourse],
  ['slopes', slopesCourse],
  ['ice', iceCourse],
];

export const TEST_COURSE_NAMES: readonly string[] = TEST_COURSE_BUILDERS.map(([name]) => name);

/** Fresh layers of a named test course ('open' | 'arena' | 'corridors' | 'slopes' | 'ice'); throws on an unknown name. */
export function testCourse(name: string): CourseLayers {
  for (const [n, build] of TEST_COURSE_BUILDERS) if (n === name) return build();
  throw new Error(`testCourse: unknown test course '${name}'`);
}

// ---------------------------------------------------------------------------------------------------------------------
// Sim-driving helpers

/** World at the start of a hole on these layers. */
export function freshWorld(layers: CourseLayers): WorldState {
  return createWorld(layers.walls, layers.mines.length);
}

/** SimContext for driving stepTick directly from the ball's current position. */
export function makeContext(layers: CourseLayers, ball: BallState, otherBalls: readonly Vec2[] = []): SimContext {
  return {
    shotOrigin: { x: ball.x, y: ball.y },
    startPos: { x: layers.start.x, y: layers.start.y },
    tick: 0,
    teleportCount: 0,
    lastBreakTile: -1,
    lastBreakTick: -1,
    otherBalls,
  };
}

/** ShotInput whose launch velocity is (vx, vy) px/s under the current tuning (|v| <= MAX_PULL_PX * POWER_SCALE). */
export function shotFor(vx: number, vy: number): ShotInput {
  const k = SHOT_QUANTUM / simTuning.POWER_SCALE;
  const dx = Math.round(vx * k);
  const dy = Math.round(vy * k);
  return { dx: dx === 0 ? 0 : dx, dy: dy === 0 ? 0 : dy };
}

/** Sets an arbitrary velocity directly (for sweeps beyond the pull cap) and marks the ball moving. */
export function launch(ball: BallState, vx: number, vy: number): void {
  ball.vx = vx;
  ball.vy = vy;
  ball.moving = true;
  ball.slowTicks = 0;
}

/** Runs stepTick until the ball is no longer moving; `onTick` sees every tick's status. Returns the final status. */
export function runTicks(
  layers: CourseLayers, world: WorldState, ball: BallState, ctx: SimContext, events: SimEvent[],
  onTick?: (status: StepStatus, tick: number) => void,
): StepStatus {
  let status: StepStatus = 'moving';
  while (status === 'moving') {
    status = stepTick(layers, world, ball, ctx, events);
    if (onTick) onTick(status, ctx.tick);
  }
  return status;
}
