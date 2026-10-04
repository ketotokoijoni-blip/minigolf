export interface Vec2 { x: number; y: number }

/** Surface layer (what the ball rolls on). Char per tile in `Course.surface` rows, see chars.ts. */
export const Surface = {
  Grass: 0, Sand: 1, Ice: 2, Tar: 3, Water: 4, Acid: 5,
  SlopeN: 6, SlopeE: 7, SlopeS: 8, SlopeW: 9,
} as const;
export type Surface = (typeof Surface)[keyof typeof Surface];

/** Wall layer (solid shapes and block materials). Separate layer so a slope may run under a diagonal, etc. */
export const WallShape = {
  None: 0,
  Full: 1,
  TriNW: 2,      // solid north-west half; hypotenuse from (15,0) to (0,15), right angle at the NW corner
  TriNE: 3,      // solid north-east half
  TriSE: 4,      // solid south-east half
  TriSW: 5,      // solid south-west half
  Breakable1: 6, // full block, destroyed after 1 hit
  Breakable2: 7, // 2 hits
  Breakable3: 8, // 3 hits
  Movable: 9,    // full block; slides one tile when hit if the target tile is free
  Bumper: 10,    // full block; restitution 1.4, minimum exit speed
  OneWayN: 11,   // passable only while moving toward -y (north); solid otherwise
  OneWayE: 12,
  OneWayS: 13,
  OneWayW: 14,
} as const;
export type WallShape = (typeof WallShape)[keyof typeof WallShape];

export type TeleportGroup = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type Polarity = 1 | -1; // 1 attract, -1 repel

/** Objects live on exactly one tile (0-based tile coordinates). World centre = ((x + 0.5) * TILE, (y + 0.5) * TILE). */
export type CourseObject =
  | { type: 'start'; x: number; y: number }                                                        // exactly one
  | { type: 'hole'; x: number; y: number }                                                         // one or more
  | { type: 'teleport'; x: number; y: number; group: TeleportGroup }                               // exactly 2 per used group
  | { type: 'magnet'; x: number; y: number; polarity: Polarity; strength: number; radius: number } // tile must be WallShape.Full
  | { type: 'mine'; x: number; y: number };
export type CourseObjectType = CourseObject['type'];

export interface CourseRules {
  maxStrokes: number; // 1..50, default 20
  par: number;        // 1..20, default 3
}

/** Authoring + wire format. Row strings are 49 chars, 25 rows. */
export interface Course {
  format: 'puttipeli-course';
  formatVersion: 1;
  id: string;            // builtin "b_01".."b_09"; custom "c_" + 16 hex (courseId(), content hash, id itself excluded)
  name: string;          // 1..40 chars
  author: string;        // 0..40 chars
  description: string;   // 0..200 chars ('' allowed)
  width: 49;
  height: 25;
  rules: CourseRules;
  surface: string[];     // 25 rows x 49 chars, Surface chars
  walls: string[];       // 25 rows x 49 chars, WallShape chars
  objects: CourseObject[]; // at most one object per tile
}

export type CourseRef =
  | { kind: 'builtin'; id: string }
  | { kind: 'custom'; course: Course };

export interface HoleDef { tile: number; cx: number; cy: number }
export interface MineDef { tile: number; cx: number; cy: number }
export interface TeleportPad { tile: number; cx: number; cy: number; group: TeleportGroup; partnerTile: number; partnerIndex: number }
export interface MagnetDef { tile: number; cx: number; cy: number; polarity: Polarity; strength: number; radius: number }

/** Decoded, immutable runtime form produced by decodeLayers(course). Mutable per-hole state lives in sim WorldState. */
export interface CourseLayers {
  surface: Uint8Array;   // TILE_COUNT Surface codes
  walls: Uint8Array;     // TILE_COUNT WallShape codes (initial)
  objectAt: Int16Array;  // TILE_COUNT -> index into objects, or -1
  objects: CourseObject[];
  start: Vec2;           // px centre
  startTile: number;
  holes: HoleDef[];      // course order
  teleports: TeleportPad[];
  magnets: MagnetDef[];
  mines: MineDef[];      // mine index = position in this array (WorldState.minesArmed uses it)
  maxStrokes: number;
  par: number;
}

/**
 * Validation issue. `code` doubles as the i18n key suffix ('validation.' + code) and `message`
 * is an English developer fallback. `params` feed the localized template.
 */
export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  params?: Record<string, string | number>;
  x?: number;
  y?: number;
  objectIndex?: number;
}
