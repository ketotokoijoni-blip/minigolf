// validateCourse(course): ValidationIssue[] (DESIGN §7.5). Codes double as i18n key suffixes ('validation.' + code).
import {
  COURSE_H, COURSE_W, MAX_AUTHOR_CHARS, MAX_COURSE_NAME_CHARS, MAX_DESCRIPTION_CHARS,
  MAX_MAX_STROKES, MAX_PAR, MIN_MAX_STROKES, MIN_PAR,
} from '../constants';
import { MAX_COURSE_BYTES } from '../protocol/limits';
import { courseByteLength } from './canonical';
import { SURFACE_CHARS, WALL_CHARS, surfaceFromChar, wallFromChar } from './chars';
import { inBounds, tileIndex } from './grid';
import { decodeLayers } from './parse';
import { isHoleReachable } from './reachability';
import { Surface, WallShape, type Course, type CourseObject, type ValidationIssue } from './types';

export const PAR_HIGH_THRESHOLD = 8;

type Issue = ValidationIssue;
const err = (code: string, message: string, extra: Partial<Issue> = {}): Issue => ({ level: 'error', code, message, ...extra });
const warn = (code: string, message: string, extra: Partial<Issue> = {}): Issue => ({ level: 'warning', code, message, ...extra });

const OBJECT_TYPES = new Set<string>(['start', 'hole', 'teleport', 'magnet', 'mine']);
const isHazardForBall = (s: number): boolean => s === Surface.Water || s === Surface.Acid || s === Surface.Tar;
const isLiquid = (s: number): boolean => s === Surface.Water || s === Surface.Acid;

/** Checks the two row layers; returns false when the grid is unusable for the object checks. */
function checkLayers(course: Course, issues: Issue[]): boolean {
  let ok = true;
  if (course.width !== COURSE_W || course.height !== COURSE_H) {
    issues.push(err('BAD_DIMENSIONS', `course is ${course.width}x${course.height}, expected ${COURSE_W}x${COURSE_H}`));
    ok = false;
  }
  for (const layer of ['surface', 'walls'] as const) {
    const rows = course[layer];
    const alphabet = layer === 'surface' ? SURFACE_CHARS : WALL_CHARS;
    const fromChar = layer === 'surface' ? surfaceFromChar : wallFromChar;
    if (!Array.isArray(rows) || rows.length !== COURSE_H) {
      issues.push(err('BAD_DIMENSIONS', `${layer} has ${Array.isArray(rows) ? rows.length : 'no'} rows, expected ${COURSE_H}`, { y: Array.isArray(rows) ? rows.length : 0, x: 0 }));
      ok = false;
      continue;
    }
    for (let y = 0; y < rows.length; y++) {
      const row = rows[y];
      if (typeof row !== 'string' || row.length !== COURSE_W) {
        issues.push(err('BAD_DIMENSIONS', `${layer} row ${y} has ${typeof row === 'string' ? row.length : 'no'} chars, expected ${COURSE_W}`, { x: typeof row === 'string' ? row.length : 0, y }));
        ok = false;
        continue;
      }
      for (let x = 0; x < row.length; x++) {
        const ch = row.charAt(x);
        if (fromChar(ch) === undefined) {
          issues.push(err('BAD_CHAR', `bad ${layer} char '${ch}' at (${x}, ${y}); allowed: ${alphabet}`, { x, y, params: { char: ch, layer } }));
          ok = false;
        }
      }
    }
  }
  return ok;
}

function checkMeta(course: Course, issues: Issue[]): void {
  const name = typeof course.name === 'string' ? course.name.trim() : '';
  if (name.length === 0 || name.length > MAX_COURSE_NAME_CHARS) {
    issues.push(err('BAD_NAME', `name must be 1..${MAX_COURSE_NAME_CHARS} chars after trim`));
  }
  if (typeof course.author !== 'string' || course.author.trim().length > MAX_AUTHOR_CHARS) {
    issues.push(err('BAD_AUTHOR', `author must be at most ${MAX_AUTHOR_CHARS} chars`));
  }
  if (typeof course.description !== 'string' || course.description.trim().length > MAX_DESCRIPTION_CHARS) {
    issues.push(err('BAD_DESCRIPTION', `description must be at most ${MAX_DESCRIPTION_CHARS} chars`));
  }
  const r = course.rules;
  const okStrokes = !!r && Number.isInteger(r.maxStrokes) && r.maxStrokes >= MIN_MAX_STROKES && r.maxStrokes <= MAX_MAX_STROKES;
  const okPar = !!r && Number.isInteger(r.par) && r.par >= MIN_PAR && r.par <= MAX_PAR;
  if (!okStrokes || !okPar) {
    issues.push(err('BAD_RULES', `maxStrokes must be an integer in [${MIN_MAX_STROKES},${MAX_MAX_STROKES}] and par in [${MIN_PAR},${MAX_PAR}]`));
  } else if (r.par > PAR_HIGH_THRESHOLD) {
    issues.push(warn('PAR_HIGH', `par ${r.par} is unusually high`));
  }
}

function checkObjects(course: Course, gridOk: boolean, issues: Issue[]): void {
  const objects: CourseObject[] = Array.isArray(course.objects) ? course.objects : [];
  const wallAt = (x: number, y: number): number => wallFromChar(course.walls[y]!.charAt(x)) ?? WallShape.None;
  const surfAt = (x: number, y: number): number => surfaceFromChar(course.surface[y]!.charAt(x)) ?? Surface.Grass;

  let starts = 0;
  let holes = 0;
  const occupied = new Int16Array(COURSE_W * COURSE_H).fill(-1);
  const groupCount: number[] = [0, 0, 0, 0, 0, 0, 0, 0];
  let startTile = -1;
  const holeTiles: { x: number; y: number }[] = [];

  for (let i = 0; i < objects.length; i++) {
    const o = objects[i]!;
    // A hand-built or tampered Course (not coming through parseCourseFile) may carry a non-object entry or an unknown
    // type; decodeLayers would throw on it, so it must be an error here (same code parseCourseFile uses for the shape).
    if (typeof o !== 'object' || o === null) {
      issues.push(err('BAD_STRUCTURE', `objects[${i}] is not an object`, { objectIndex: i }));
      continue;
    }
    if (!OBJECT_TYPES.has(o.type)) {
      issues.push(err('BAD_STRUCTURE', `objects[${i}] has unknown type '${String(o.type)}'`, { objectIndex: i }));
      continue;
    }
    const at = { objectIndex: i, x: o.x, y: o.y };
    if (o.type === 'start') starts++;
    if (o.type === 'hole') holes++;
    if (!Number.isInteger(o.x) || !Number.isInteger(o.y) || !inBounds(o.x, o.y)) {
      issues.push(err('OBJECT_OUT_OF_BOUNDS', `${o.type} at (${o.x}, ${o.y}) is outside the field`, at));
      continue;
    }
    const tile = tileIndex(o.x, o.y);
    if (occupied[tile] !== -1) {
      issues.push(err('OBJECT_OVERLAP', `${o.type} at (${o.x}, ${o.y}) shares a tile with object ${occupied[tile]}`, at));
    } else {
      occupied[tile] = i;
    }
    if (o.type === 'start') startTile = tile;
    if (o.type === 'hole') holeTiles.push({ x: o.x, y: o.y });

    if (o.type === 'teleport') {
      if (Number.isInteger(o.group) && o.group >= 0 && o.group <= 7) groupCount[o.group]!++;
      else issues.push(err('BAD_TELEPORT_GROUP', `teleport group ${o.group} is not 0..7`, at));
    }
    if (o.type === 'magnet') {
      if ((o.polarity !== 1 && o.polarity !== -1) || !Number.isFinite(o.strength) || !Number.isFinite(o.radius)) {
        issues.push(err('BAD_MAGNET', `magnet at (${o.x}, ${o.y}) has invalid polarity/strength/radius`, at));
      }
    }

    if (!gridOk) continue;
    const wall = wallAt(o.x, o.y);
    const surf = surfAt(o.x, o.y);
    if (o.type === 'magnet') {
      if (wall !== WallShape.Full) issues.push(err('MAGNET_NOT_ON_FULL', `magnet at (${o.x}, ${o.y}) must sit on a full wall tile`, at));
    } else {
      if (wall !== WallShape.None) issues.push(err('OBJECT_ON_WALL', `${o.type} at (${o.x}, ${o.y}) sits on a wall tile`, at));
      if (o.type === 'mine' ? isLiquid(surf) : isHazardForBall(surf)) {
        issues.push(err('OBJECT_ON_HAZARD', `${o.type} at (${o.x}, ${o.y}) sits on a hazard surface`, at));
      }
    }
  }

  if (starts === 0) issues.push(err('NO_START', 'course has no start'));
  else if (starts > 1) issues.push(err('MULTIPLE_STARTS', `course has ${starts} starts, expected 1`));
  if (holes === 0) issues.push(err('NO_HOLE', 'course has no hole'));
  for (let g = 0; g < 8; g++) {
    const count = groupCount[g]!;
    if (count !== 0 && count !== 2) {
      issues.push(err('TELEPORT_GROUP_SIZE', `teleport group ${g} has ${count} pads, expected 2`, { params: { group: g, count } }));
    }
  }
  if (startTile !== -1 && starts === 1) {
    const sx = startTile % COURSE_W;
    const sy = (startTile - sx) / COURSE_W;
    for (const h of holeTiles) {
      if (Math.max(Math.abs(h.x - sx), Math.abs(h.y - sy)) <= 1) {
        issues.push(warn('HOLE_NEXT_TO_START', `hole at (${h.x}, ${h.y}) touches the start`, { x: h.x, y: h.y }));
        break;
      }
    }
  }
}

function checkBorder(course: Course, issues: Issue[]): void {
  for (let y = 0; y < COURSE_H; y++) {
    for (let x = 0; x < COURSE_W; x++) {
      if (x !== 0 && y !== 0 && x !== COURSE_W - 1 && y !== COURSE_H - 1) continue;
      if (course.walls[y]!.charAt(x) === '.') {
        issues.push(warn('OPEN_BORDER', `border tile (${x}, ${y}) has no wall (physics treats the outside as solid)`, { x, y }));
        return;
      }
    }
  }
}

/** All issues of a course: errors (block play) first in detection order, then warnings. Never throws. */
export function validateCourse(course: Course): ValidationIssue[] {
  const issues: Issue[] = [];
  checkMeta(course, issues);
  const gridOk = checkLayers(course, issues);
  checkObjects(course, gridOk, issues);
  if (gridOk) {
    checkBorder(course, issues);
    try {
      if (courseByteLength(course) > MAX_COURSE_BYTES) {
        issues.push(err('TOO_LARGE', `canonical JSON exceeds ${MAX_COURSE_BYTES} bytes`));
      }
    } catch {
      issues.push(err('TOO_LARGE', 'course could not be serialised'));
    }
  }
  const hasErrors = issues.some((i) => i.level === 'error');
  if (!hasErrors) {
    try {
      if (!isHoleReachable(decodeLayers(course))) {
        issues.push(warn('UNREACHABLE_HOLE', 'no hole is reachable from the start by rolling through passable tiles'));
      }
    } catch {
      // decodeLayers only throws on conditions reported above as errors; nothing to add.
    }
  }
  issues.sort((a, b) => (a.level === b.level ? 0 : a.level === 'error' ? -1 : 1));
  return issues;
}

export const hasValidationErrors = (issues: readonly ValidationIssue[]): boolean => issues.some((i) => i.level === 'error');
