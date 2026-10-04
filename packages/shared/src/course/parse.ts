// Course rows + objects <-> typed runtime layers (DESIGN §7.2). Tile arithmetic comes from WP0's grid.ts.
import {
  COURSE_H, COURSE_W, TILE, TILE_COUNT,
  MAGNET_MAX_RADIUS, MAGNET_MAX_STRENGTH, MAGNET_MIN_RADIUS, MAGNET_MIN_STRENGTH,
} from '../constants';
import { charOfSurface, charOfWall, surfaceFromChar, wallFromChar } from './chars';
import { inBounds, tileIndex } from './grid';
import type { Course, CourseLayers, HoleDef, MagnetDef, MineDef, Surface, TeleportPad, WallShape } from './types';

/** Thrown by decodeLayers on malformed input. The message names the problem; nothing is silently repaired. */
export class DecodeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'DecodeError';
  }
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

function decodeRows(rows: string[], layer: 'surface' | 'walls', fromChar: (c: string) => number | undefined): Uint8Array {
  if (!Array.isArray(rows) || rows.length !== COURSE_H) {
    throw new DecodeError(`${layer}: expected ${COURSE_H} rows, got ${Array.isArray(rows) ? rows.length : typeof rows}`);
  }
  const out = new Uint8Array(TILE_COUNT);
  for (let y = 0; y < COURSE_H; y++) {
    const row = rows[y];
    if (typeof row !== 'string' || row.length !== COURSE_W) {
      throw new DecodeError(`${layer}: row ${y} has ${typeof row === 'string' ? row.length : 'no'} chars, expected ${COURSE_W}`);
    }
    for (let x = 0; x < COURSE_W; x++) {
      const ch = row.charAt(x);
      const code = fromChar(ch);
      if (code === undefined) throw new DecodeError(`${layer}: bad char '${ch}' at (${x}, ${y})`);
      out[tileIndex(x, y)] = code;
    }
  }
  return out;
}

/**
 * Decodes rows + objects into typed arrays and object tables. Precondition: validateCourse(course) has no errors.
 * Throws DecodeError on malformed input: bad dimensions/chars, no start, several starts, no hole, object out of bounds,
 * two objects on one tile, unpaired teleport group. Magnet strength/radius are clamped into [MAGNET_MIN_*, MAGNET_MAX_*].
 * holes/mines are in object-array order (WorldState.minesArmed[i] <-> mines[i]).
 */
export function decodeLayers(course: Course): CourseLayers {
  const surface = decodeRows(course.surface, 'surface', surfaceFromChar);
  const walls = decodeRows(course.walls, 'walls', wallFromChar);
  const objectAt = new Int16Array(TILE_COUNT);
  objectAt.fill(-1);
  const objects = course.objects;
  if (!Array.isArray(objects)) throw new DecodeError('objects: not an array');

  let startTile = -1;
  const holes: HoleDef[] = [];
  const mines: MineDef[] = [];
  const magnets: MagnetDef[] = [];
  const pads: TeleportPad[] = [];

  for (let i = 0; i < objects.length; i++) {
    const o = objects[i]!;
    if (!Number.isInteger(o.x) || !Number.isInteger(o.y) || !inBounds(o.x, o.y)) {
      throw new DecodeError(`object ${i} (${o.type}) out of bounds at (${o.x}, ${o.y})`);
    }
    const tile = tileIndex(o.x, o.y);
    if (objectAt[tile] !== -1) throw new DecodeError(`object ${i} (${o.type}) overlaps object ${objectAt[tile]} at (${o.x}, ${o.y})`);
    objectAt[tile] = i;
    const cx = (o.x + 0.5) * TILE;
    const cy = (o.y + 0.5) * TILE;
    switch (o.type) {
      case 'start':
        if (startTile !== -1) throw new DecodeError(`object ${i}: second start at (${o.x}, ${o.y})`);
        startTile = tile;
        break;
      case 'hole':
        holes.push({ tile, cx, cy });
        break;
      case 'mine':
        mines.push({ tile, cx, cy });
        break;
      case 'magnet':
        magnets.push({
          tile, cx, cy,
          polarity: o.polarity,
          strength: clamp(o.strength, MAGNET_MIN_STRENGTH, MAGNET_MAX_STRENGTH),
          radius: clamp(o.radius, MAGNET_MIN_RADIUS, MAGNET_MAX_RADIUS),
        });
        break;
      case 'teleport':
        pads.push({ tile, cx, cy, group: o.group, partnerTile: -1, partnerIndex: -1 });
        break;
      default:
        throw new DecodeError(`object ${i}: unknown type '${(o as { type: string }).type}'`);
    }
  }
  if (startTile === -1) throw new DecodeError('no start object');
  if (holes.length === 0) throw new DecodeError('no hole object');

  // Pair teleport pads: exactly two per used group, in course order.
  for (let i = 0; i < pads.length; i++) {
    const pad = pads[i]!;
    if (pad.partnerIndex !== -1) continue;
    let partner = -1;
    for (let j = i + 1; j < pads.length; j++) {
      const other = pads[j]!;
      if (other.group !== pad.group) continue;
      if (partner !== -1 || other.partnerIndex !== -1) throw new DecodeError(`teleport group ${pad.group} has more than 2 pads`);
      partner = j;
    }
    if (partner === -1) throw new DecodeError(`teleport group ${pad.group} has only 1 pad`);
    const p = pads[partner]!;
    pad.partnerIndex = partner;
    pad.partnerTile = p.tile;
    p.partnerIndex = i;
    p.partnerTile = pad.tile;
  }

  const start = startTile; // index
  return {
    surface,
    walls,
    objectAt,
    objects: objects.slice(),
    start: { x: ((start % COURSE_W) + 0.5) * TILE, y: ((start - (start % COURSE_W)) / COURSE_W + 0.5) * TILE },
    startTile,
    holes,
    teleports: pads,
    magnets,
    mines,
    maxStrokes: course.rules.maxStrokes,
    par: course.rules.par,
  };
}

/** Typed arrays back into row strings (inverse of decodeLayers for the two layers). Throws DecodeError on a bad code. */
export function encodeLayers(surface: Uint8Array, walls: Uint8Array): { surface: string[]; walls: string[] } {
  if (surface.length !== TILE_COUNT || walls.length !== TILE_COUNT) {
    throw new DecodeError(`encodeLayers: expected ${TILE_COUNT} tiles, got ${surface.length}/${walls.length}`);
  }
  const s: string[] = [];
  const w: string[] = [];
  for (let y = 0; y < COURSE_H; y++) {
    let sr = '';
    let wr = '';
    for (let x = 0; x < COURSE_W; x++) {
      const i = tileIndex(x, y);
      const sc = surface[i]!;
      const wc = walls[i]!;
      const sch = charOfSurface(sc as Surface);
      const wch = charOfWall(wc as WallShape);
      if (sch === undefined) throw new DecodeError(`encodeLayers: bad surface code ${sc} at (${x}, ${y})`);
      if (wch === undefined) throw new DecodeError(`encodeLayers: bad wall code ${wc} at (${x}, ${y})`);
      sr += sch;
      wr += wch;
    }
    s.push(sr);
    w.push(wr);
  }
  return { surface: s, walls: w };
}
