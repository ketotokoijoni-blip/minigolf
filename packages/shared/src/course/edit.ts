// Pure editor operations (DESIGN §7.7, D11). Every function returns a new Course; inputs are never mutated.
import { COURSE_H, COURSE_W, MAX_AUTHOR_CHARS, MAX_COURSE_NAME_CHARS, MAX_DESCRIPTION_CHARS } from '../constants';
import { withComputedId } from './canonical';
import { charOfSurface, charOfWall, surfaceFromChar, wallFromChar } from './chars';
import { inBounds } from './grid';
import { Surface, WallShape, type Course, type CourseObject, type CourseRules } from './types';

export type Layer = 'surface' | 'walls';

const replaceChar = (row: string, x: number, ch: string): string => row.slice(0, x) + ch + row.slice(x + 1);
const isBallHazard = (s: number): boolean => s === Surface.Water || s === Surface.Acid || s === Surface.Tar;
const isLiquid = (s: number): boolean => s === Surface.Water || s === Surface.Acid;

/** Whether `obj` may rest on surface `s` (start/hole/teleport refuse water/acid/tar; mines refuse water/acid; magnets sit on walls). */
export function objectAllowedOnSurface(obj: CourseObject, s: number): boolean {
  if (obj.type === 'magnet') return true;
  return obj.type === 'mine' ? !isLiquid(s) : !isBallHazard(s);
}

export function objectAt(course: Course, x: number, y: number): CourseObject | undefined {
  return course.objects.find((o) => o.x === x && o.y === y);
}

/** Reads a layer cell as a code (None/Grass when the char is unknown). */
export function cellValue(course: Course, layer: Layer, x: number, y: number): number {
  const ch = course[layer][y]?.charAt(x) ?? '';
  return (layer === 'surface' ? surfaceFromChar(ch) : wallFromChar(ch)) ?? 0;
}

function setCell(rows: readonly string[], x: number, y: number, ch: string): string[] {
  const out = rows.slice();
  out[y] = replaceChar(out[y]!, x, ch);
  return out;
}

const withoutObjectsAt = (objects: readonly CourseObject[], x: number, y: number, keep?: (o: CourseObject) => boolean): CourseObject[] =>
  objects.filter((o) => !(o.x === x && o.y === y) || (keep !== undefined && keep(o)));

/** Painting Water/Acid/Tar under start/hole/teleport removes that object; Water/Acid under a mine removes the mine. */
export function setSurface(course: Course, x: number, y: number, s: Surface): Course {
  if (!inBounds(x, y)) return course;
  const rows = setCell(course.surface, x, y, charOfSurface(s));
  const objects = course.objects.filter((o) => !(o.x === x && o.y === y) || objectAllowedOnSurface(o, s));
  return withComputedId({ ...course, surface: rows, objects });
}

/**
 * Any wall != None removes a non-magnet object on the tile; None under a magnet removes the magnet; a magnet tile
 * painted with a non-Full wall removes the magnet.
 */
export function setWall(course: Course, x: number, y: number, w: WallShape): Course {
  if (!inBounds(x, y)) return course;
  const rows = setCell(course.walls, x, y, charOfWall(w));
  const objects = course.objects.filter((o) => {
    if (o.x !== x || o.y !== y) return true;
    return o.type === 'magnet' ? w === WallShape.Full : w === WallShape.None;
  });
  return withComputedId({ ...course, walls: rows, objects });
}

/**
 * Replaces whatever object is on the tile. 'start' is a singleton (previous start removed). magnet -> wall set to Full;
 * other objects -> wall set to None. Surface hazards under the new object are reset to Grass.
 */
export function placeObject(course: Course, obj: CourseObject): Course {
  if (!Number.isInteger(obj.x) || !Number.isInteger(obj.y) || !inBounds(obj.x, obj.y)) return course;
  const { x, y } = obj;
  let objects = withoutObjectsAt(course.objects, x, y);
  if (obj.type === 'start') objects = objects.filter((o) => o.type !== 'start');
  objects = [...objects, { ...obj }];
  const walls = setCell(course.walls, x, y, charOfWall(obj.type === 'magnet' ? WallShape.Full : WallShape.None));
  let surface = course.surface;
  if (!objectAllowedOnSurface(obj, cellValue(course, 'surface', x, y))) {
    surface = setCell(course.surface, x, y, charOfSurface(Surface.Grass));
  }
  return withComputedId({ ...course, walls, surface, objects });
}

/** Removing a magnet leaves its Full wall in place. */
export function removeObjectAt(course: Course, x: number, y: number): Course {
  const objects = withoutObjectsAt(course.objects, x, y);
  if (objects.length === course.objects.length) return course;
  return withComputedId({ ...course, objects });
}

function paintCells(course: Course, layer: Layer, cells: readonly { x: number; y: number }[], value: number): Course {
  let rows: string[] = course[layer].slice();
  const ch: string | undefined = layer === 'surface' ? charOfSurface(value as Surface) : charOfWall(value as WallShape);
  if (ch === undefined || ch.length !== 1) return course;
  // Apply the object invariants of setSurface/setWall tile by tile, but build the rows in one pass.
  let objects = course.objects;
  let painted = false;
  for (const { x, y } of cells) {
    if (!inBounds(x, y)) continue;
    painted = true;
    rows = setCell(rows, x, y, ch);
    objects = objects.filter((o) => {
      if (o.x !== x || o.y !== y) return true;
      if (layer === 'surface') return objectAllowedOnSurface(o, value);
      return o.type === 'magnet' ? value === WallShape.Full : value === WallShape.None;
    });
  }
  if (!painted) return course; // nothing on the field was touched: keep the input (and its id) as is
  return withComputedId({ ...course, [layer]: rows, objects });
}

const clampCoord = (v: number, max: number): number => (v < 0 ? 0 : v > max ? max : Math.trunc(v));

/**
 * Fills (outline: strokes) the rectangle spanned by the two corners (inclusive, any order), clipped to the field.
 * A rectangle with no cell inside the field returns the input unchanged (the clamp must not paint an edge tile).
 */
export function fillRect(course: Course, layer: Layer, x0: number, y0: number, x1: number, y1: number, value: number, outline = false): Course {
  if (![x0, y0, x1, y1].every(Number.isFinite)) return course;
  if (Math.max(x0, x1) < 0 || Math.min(x0, x1) > COURSE_W - 1 || Math.max(y0, y1) < 0 || Math.min(y0, y1) > COURSE_H - 1) return course;
  const ax = clampCoord(Math.min(x0, x1), COURSE_W - 1);
  const bx = clampCoord(Math.max(x0, x1), COURSE_W - 1);
  const ay = clampCoord(Math.min(y0, y1), COURSE_H - 1);
  const by = clampCoord(Math.max(y0, y1), COURSE_H - 1);
  const cells: { x: number; y: number }[] = [];
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) {
      if (outline && x !== ax && x !== bx && y !== ay && y !== by) continue;
      cells.push({ x, y });
    }
  }
  return paintCells(course, layer, cells, value);
}

/** 4-connected flood fill of the region of equal value containing (x, y). */
export function floodFill(course: Course, layer: Layer, x: number, y: number, value: number): Course {
  if (!inBounds(x, y)) return course;
  const target = cellValue(course, layer, x, y);
  if (target === value) return course;
  const seen = new Uint8Array(COURSE_W * COURSE_H);
  const cells: { x: number; y: number }[] = [];
  const stack: number[] = [y * COURSE_W + x];
  seen[y * COURSE_W + x] = 1;
  while (stack.length > 0) {
    const i = stack.pop()!;
    const cx = i % COURSE_W;
    const cy = (i - cx) / COURSE_W;
    cells.push({ x: cx, y: cy });
    const tryPush = (nx: number, ny: number): void => {
      if (!inBounds(nx, ny)) return;
      const j = ny * COURSE_W + nx;
      if (seen[j]) return;
      if (cellValue(course, layer, nx, ny) !== target) return;
      seen[j] = 1;
      stack.push(j);
    };
    tryPush(cx + 1, cy);
    tryPush(cx - 1, cy);
    tryPush(cx, cy + 1);
    tryPush(cx, cy - 1);
  }
  return paintCells(course, layer, cells, value);
}

/** Longest line (in tiles along its major axis) the editor accepts; keeps the integer arithmetic below exact. */
export const MAX_LINE_STEPS = 1 << 24;

/**
 * Bresenham line from (x0, y0) to (x1, y1), both endpoints included; cells outside the field are skipped, the
 * on-field part is painted even when both endpoints lie far outside the field.
 *
 * The raster is the midpoint (Bresenham) line evaluated in closed form: step k along the major axis lands on
 * minor = minor0 + sign * floor((2 * k * |dMinor| + n) / (2 * n)), which is exactly what the incremental error
 * algorithm produces. The closed form lets the loop run only over the steps whose major coordinate is on the field,
 * so a drag that starts a thousand tiles off-screen still paints the visible segment and the cost is bounded.
 */
export function line(course: Course, layer: Layer, x0: number, y0: number, x1: number, y1: number, value: number): Course {
  if (![x0, y0, x1, y1].every(Number.isFinite)) return course;
  const ax = Math.round(x0);
  const ay = Math.round(y0);
  const bx = Math.round(x1);
  const by = Math.round(y1);
  const dx = Math.abs(bx - ax);
  const dy = Math.abs(by - ay);
  const n = Math.max(dx, dy);
  if (n > MAX_LINE_STEPS) return course;
  const xMajor = dx >= dy;
  const major0 = xMajor ? ax : ay;
  const minor0 = xMajor ? ay : ax;
  const sMajor = (xMajor ? bx >= ax : by >= ay) ? 1 : -1;
  const sMinor = (xMajor ? by >= ay : bx >= ax) ? 1 : -1;
  const dMinor = xMajor ? dy : dx;
  const majorMax = (xMajor ? COURSE_W : COURSE_H) - 1;
  // Steps whose major coordinate is inside the field: major0 + sMajor * k in [0, majorMax].
  const kA = (0 - major0) * sMajor;
  const kB = (majorMax - major0) * sMajor;
  const kMin = Math.max(0, Math.min(kA, kB));
  const kMax = Math.min(n, Math.max(kA, kB));
  const cells: { x: number; y: number }[] = [];
  for (let k = kMin; k <= kMax; k++) {
    const major = major0 + sMajor * k;
    const minor = n === 0 ? minor0 : minor0 + sMinor * Math.floor((2 * k * dMinor + n) / (2 * n));
    cells.push(xMajor ? { x: major, y: minor } : { x: minor, y: major });
  }
  return paintCells(course, layer, cells, value);
}

/** Updates name/author/description and/or rules; strings are clipped to their maximum lengths, rules are left for the validator. */
export function setMeta(course: Course, meta: Partial<Pick<Course, 'name' | 'author' | 'description'>> & Partial<CourseRules>): Course {
  const next: Course = { ...course, rules: { ...course.rules } };
  if (meta.name !== undefined) next.name = meta.name.slice(0, MAX_COURSE_NAME_CHARS);
  if (meta.author !== undefined) next.author = meta.author.slice(0, MAX_AUTHOR_CHARS);
  if (meta.description !== undefined) next.description = meta.description.slice(0, MAX_DESCRIPTION_CHARS);
  if (meta.maxStrokes !== undefined) next.rules.maxStrokes = meta.maxStrokes;
  if (meta.par !== undefined) next.rules.par = meta.par;
  return withComputedId(next);
}
