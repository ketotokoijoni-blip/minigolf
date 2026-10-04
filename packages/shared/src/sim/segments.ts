// Wall segments with shared-edge culling (DESIGN §8.4). Every solid tile contributes line segments in px with outward
// normals (away from the solid). collectSegments() scans the 3x3 tiles around the ball's tile, culls the axis edges that
// face another solid (so a straight wall is one flush face per tile and a grazing ball never snags on a seam) and treats
// out-of-bounds tiles as Full blocks of material 'border' (the implicit solid ring that keeps the ball on the field).
// Allocation-free: the caller passes a preallocated buffer (createSegmentBuffer) whose entries are overwritten in place.
// The per-shape facts (edges, covered sides, material, one-way direction) are precomputed into flat tables at module
// load; the scan itself touches only local variables and typed arrays (it runs 3+ times per tick).
import { COURSE_H, COURSE_W, TILE } from '../constants';
import { isOneWay, isTriangle, oneWayDir } from '../course/chars';
import { WallShape } from '../course/types';

export type SegmentMaterial = 'wall' | 'breakable' | 'movable' | 'bumper' | 'oneway' | 'border';

/** Sides: 0 N, 1 E, 2 S, 3 W, 4 hypotenuse (matches DIR_* indices of course/chars.ts). */
export type SegmentSide = 0 | 1 | 2 | 3 | 4;

export interface Segment {
  ax: number; ay: number;      // segment start (px)
  bx: number; by: number;      // segment end (px)
  nx: number; ny: number;      // unit outward normal (away from the solid)
  tile: number;                // tile index of the solid; -1 for border (out-of-bounds) segments
  side: SegmentSide;
  material: SegmentMaterial;
  dir: number;                 // one-way passage direction 0..3 (DIR_DX/DIR_DY), else -1
}

/** Upper bound of segments the 3x3 scan can produce (9 tiles x 4 edges = 36; the spec reserves 45). */
export const SEGMENT_BUFFER_SIZE = 45;

export function createSegmentBuffer(size: number = SEGMENT_BUFFER_SIZE): Segment[] {
  const out: Segment[] = [];
  for (let i = 0; i < size; i++) {
    out.push({ ax: 0, ay: 0, bx: 0, by: 0, nx: 0, ny: -1, tile: -1, side: 0, material: 'wall', dir: -1 });
  }
  return out;
}

const S = Math.SQRT1_2; // exactly 0.7071067811865476
const W = COURSE_W;
const H = COURSE_H;
const T = TILE;
const SHAPES = 15; // WallShape codes 0..14
const NONE = WallShape.None;
const FULL = WallShape.Full;

/** True when the tile's solid reaches the full length of that side: full-footprint blocks on every side, triangles on
 *  their two legs; false for None and for one-way blocks (a ball may be inside them, so neighbours keep facing edges). */
export function coversSide(shape: number, side: number): boolean {
  switch (shape) {
    case WallShape.None:
      return false;
    case WallShape.TriNW:
      return side === 0 || side === 3;
    case WallShape.TriNE:
      return side === 0 || side === 1;
    case WallShape.TriSE:
      return side === 1 || side === 2;
    case WallShape.TriSW:
      return side === 2 || side === 3;
    default:
      return !isOneWay(shape);
  }
}

/** True when the shape has an axis edge on that side (its legs for triangles, all four sides for every block). */
export function hasEdge(shape: number, side: number): boolean {
  if (shape === WallShape.None) return false;
  if (isTriangle(shape)) return coversSide(shape, side);
  return true;
}

export function materialOf(shape: number): SegmentMaterial {
  if (shape >= WallShape.Breakable1 && shape <= WallShape.Breakable3) return 'breakable';
  if (shape === WallShape.Movable) return 'movable';
  if (shape === WallShape.Bumper) return 'bumper';
  if (isOneWay(shape)) return 'oneway';
  return 'wall';
}

// Flat per-shape tables, index shape * 4 + side.
const COVERS = new Uint8Array(SHAPES * 4);
const EDGES = new Uint8Array(SHAPES * 4);
const MATERIAL: SegmentMaterial[] = [];
const ONEWAY_DIR: number[] = [];   // -1 unless one-way
const HYP: number[] = [];          // 0 none, 1 TriNW, 2 TriNE, 3 TriSE, 4 TriSW
for (let shape = 0; shape < SHAPES; shape++) {
  for (let side = 0; side < 4; side++) {
    COVERS[shape * 4 + side] = coversSide(shape, side) ? 1 : 0;
    EDGES[shape * 4 + side] = hasEdge(shape, side) ? 1 : 0;
  }
  MATERIAL.push(materialOf(shape));
  ONEWAY_DIR.push(isOneWay(shape) ? oneWayDir(shape) : -1);
  HYP.push(shape === WallShape.TriNW ? 1 : shape === WallShape.TriNE ? 2 : shape === WallShape.TriSE ? 3 : shape === WallShape.TriSW ? 4 : 0);
}

function put(
  out: Segment[], n: number,
  ax: number, ay: number, bx: number, by: number, nx: number, ny: number,
  tile: number, side: SegmentSide, material: SegmentMaterial, dir: number,
): number {
  const seg = out[n];
  if (seg === undefined) throw new Error('collectSegments: segment buffer too small');
  seg.ax = ax; seg.ay = ay; seg.bx = bx; seg.by = by;
  seg.nx = nx; seg.ny = ny;
  seg.tile = tile; seg.side = side; seg.material = material; seg.dir = dir;
  return n + 1;
}

/**
 * Fills `out` (preallocated, >= SEGMENT_BUFFER_SIZE entries) with the segments of the 3x3 tiles around tile (tx, ty),
 * scanning rows then columns (ty-1..ty+1, tx-1..tx+1), per tile N, E, S, W then hypotenuse. Returns the count.
 * An axis edge is emitted iff the shape has it and the neighbour across it does not cover the shared side (out-of-bounds
 * neighbours count as Full); one-way tiles never cull their own edges; hypotenuses are never culled.
 */
export function collectSegments(walls: Uint8Array, tx: number, ty: number, out: Segment[]): number {
  let n = 0;
  for (let y = ty - 1; y <= ty + 1; y++) {
    const rowIn = y >= 0 && y < H;
    const row = y * W;
    for (let x = tx - 1; x <= tx + 1; x++) {
      const inside = rowIn && x >= 0 && x < W;
      const shape = inside ? (walls[row + x] ?? NONE) : FULL;
      if (shape === NONE) continue;
      const tile = inside ? row + x : -1;
      const material: SegmentMaterial = inside ? (MATERIAL[shape] ?? 'wall') : 'border';
      const dir = ONEWAY_DIR[shape] ?? -1;
      const oneWay = dir >= 0;
      const base = shape * 4;
      const ox = x * T;
      const oy = y * T;
      const ex = ox + T;
      const ey = oy + T;
      // neighbour shapes (out of bounds => Full)
      const nN = y - 1 >= 0 && x >= 0 && x < W ? (walls[row - W + x] ?? NONE) : FULL;
      const nE = rowIn && x + 1 < W && x + 1 >= 0 ? (walls[row + x + 1] ?? NONE) : FULL;
      const nS = y + 1 < H && x >= 0 && x < W ? (walls[row + W + x] ?? NONE) : FULL;
      const nW = rowIn && x - 1 >= 0 && x - 1 < W ? (walls[row + x - 1] ?? NONE) : FULL;
      if (EDGES[base] === 1 && (oneWay || COVERS[nN * 4 + 2] === 0)) {
        n = put(out, n, ox, oy, ex, oy, 0, -1, tile, 0, material, dir);
      }
      if (EDGES[base + 1] === 1 && (oneWay || COVERS[nE * 4 + 3] === 0)) {
        n = put(out, n, ex, oy, ex, ey, 1, 0, tile, 1, material, dir);
      }
      if (EDGES[base + 2] === 1 && (oneWay || COVERS[nS * 4] === 0)) {
        n = put(out, n, ox, ey, ex, ey, 0, 1, tile, 2, material, dir);
      }
      if (EDGES[base + 3] === 1 && (oneWay || COVERS[nW * 4 + 1] === 0)) {
        n = put(out, n, ox, oy, ox, ey, -1, 0, tile, 3, material, dir);
      }
      switch (HYP[shape]) {
        case 1: // TriNW: solid NW half, hypotenuse NE corner -> SW corner, normal toward SE
          n = put(out, n, ex, oy, ox, ey, S, S, tile, 4, material, dir);
          break;
        case 2: // TriNE: solid NE half, hypotenuse NW corner -> SE corner, normal toward SW
          n = put(out, n, ox, oy, ex, ey, -S, S, tile, 4, material, dir);
          break;
        case 3: // TriSE: solid SE half, hypotenuse NE corner -> SW corner, normal toward NW
          n = put(out, n, ex, oy, ox, ey, -S, -S, tile, 4, material, dir);
          break;
        case 4: // TriSW: solid SW half, hypotenuse NW corner -> SE corner, normal toward NE
          n = put(out, n, ox, oy, ex, ey, S, -S, tile, 4, material, dir);
          break;
        default:
          break;
      }
    }
  }
  return n;
}
