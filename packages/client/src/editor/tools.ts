// Tool state machine of the course editor (DESIGN §13.2, D11). Pure logic, no DOM: every mutation goes through the
// shared edit ops, injected as `ops` so tests can observe the exact calls. The screen feeds it tile coordinates derived
// from Camera.toWorld — they may lie outside the field while a drag leaves the canvas — and reads the overlay model
// back for the renderer. Painting with a layer value removes objects per the §7.7 invariants; the controller notifies
// the host once per gesture when that happens.
import {
  COURSE_H, COURSE_W, DEFAULT_MAX_STROKES, DEFAULT_PAR,
  MAGNET_MAX_RADIUS, MAGNET_MAX_STRENGTH, MAGNET_MIN_RADIUS, MAGNET_MIN_STRENGTH, TILE, TILE_COUNT,
} from '@puttipeli/shared/constants';
import { withComputedId } from '@puttipeli/shared/course/canonical';
import { surfaceFromChar, wallFromChar } from '@puttipeli/shared/course/chars';
import * as editOps from '@puttipeli/shared/course/edit';
import { MAX_LINE_STEPS, cellValue, objectAt, type Layer } from '@puttipeli/shared/course/edit';
import { inBounds, tileCentre, tileIndex } from '@puttipeli/shared/course/grid';
import {
  Surface, WallShape,
  type Course, type CourseLayers, type CourseObject, type HoleDef, type MagnetDef, type MineDef, type TeleportPad,
} from '@puttipeli/shared/course/types';
import type { EditorOverlay } from '../render/renderer';

// ---------------------------------------------------------------------------------------------------------------
// Vocabulary
// ---------------------------------------------------------------------------------------------------------------

export type ToolId = 'brush' | 'rect' | 'fill' | 'line' | 'eraser' | 'picker' | 'inspect';
export const TOOL_IDS: readonly ToolId[] = ['brush', 'rect', 'fill', 'line', 'eraser', 'picker', 'inspect'];
/** Single-key shortcuts (§13.2). The picker has no key of its own: the right mouse button picks with every tool. */
export const TOOL_KEYS: Readonly<Record<string, ToolId>> = { b: 'brush', r: 'rect', f: 'fill', l: 'line', e: 'eraser', i: 'inspect' };

export type PaletteTab = 'surface' | 'walls' | 'objects';
export const PALETTE_TABS: readonly PaletteTab[] = ['surface', 'walls', 'objects'];
export const TAB_KEYS: Readonly<Record<string, PaletteTab>> = { '1': 'surface', '2': 'walls', '3': 'objects' };

/** What the palette has selected. Object templates carry type + properties; x/y are ignored (set when placed). */
export type Selection =
  | { kind: 'surface'; value: Surface }
  | { kind: 'walls'; value: WallShape }
  | { kind: 'object'; template: CourseObject }
  | { kind: 'eraseObject' };

export const tabOfSelection = (sel: Selection): PaletteTab =>
  sel.kind === 'surface' ? 'surface' : sel.kind === 'walls' ? 'walls' : 'objects';

export function defaultSelection(tab: PaletteTab): Selection {
  switch (tab) {
    case 'surface': return { kind: 'surface', value: Surface.Sand };
    case 'walls': return { kind: 'walls', value: WallShape.Full };
    default: return { kind: 'object', template: { type: 'hole', x: 0, y: 0 } };
  }
}

/** Tile coordinates; may be outside the field (negative or >= COURSE_W/H) while the pointer is off the field. */
export interface TilePoint { x: number; y: number }
export interface PointerPoint extends TilePoint {
  /** 0 = primary, 2 = secondary (pipette). */
  button?: 0 | 2;
  shift?: boolean;
  alt?: boolean;
}

/** World px (Camera.toWorld output) -> tile coordinates without clamping, so off-field points stay off-field. */
export function worldToTile(wx: number, wy: number): TilePoint {
  return { x: Math.floor(wx / TILE), y: Math.floor(wy / TILE) };
}

export const samePoint = (a: TilePoint, b: TilePoint): boolean => a.x === b.x && a.y === b.y;

/** The edit ops the tools call (a subset of course/edit.ts); injectable for tests. */
export type EditOps = Pick<typeof editOps, 'setSurface' | 'setWall' | 'placeObject' | 'removeObjectAt' | 'fillRect' | 'floodFill' | 'line'>;
export const DEFAULT_EDIT_OPS: EditOps = editOps;

/** What the tools act on: the editor screen implements this over its History and UI. */
export interface ToolHost {
  getCourse(): Course;
  /** A drag starts: subsequent update() calls form one undo entry. */
  beginGesture(): void;
  update(course: Course): void;
  endGesture(): void;
  /** A one-step change (click, flood fill, finished rectangle/line). */
  commit(course: Course): void;
  /** The pipette picked something: the palette should show `selection` on `tab`. */
  pick(selection: Selection, tab: PaletteTab): void;
  /** The inspect tool selected a tile (null = clicked outside the field). */
  inspect(tile: TilePoint | null): void;
  /** Non-blocking message, e.g. 'editor.toast.objectRemoved' with { count }. */
  notify(key: string, params?: Record<string, string | number>): void;
}

/** Overlay part computed by the tools; the screen adds grid/radii/links and its own highlights. */
export interface ToolOverlay {
  hoverTile: number | -1;
  preview: EditorOverlay['preview'];
  highlightTiles: number[];
}

type Drag =
  | { kind: 'paint'; last: TilePoint }
  | { kind: 'shape'; anchor: TilePoint; current: TilePoint; alt: boolean };

// ---------------------------------------------------------------------------------------------------------------
// Shape previews (must raster exactly like fillRect / line in edit.ts so the preview is what gets painted)
// ---------------------------------------------------------------------------------------------------------------

const clampCoord = (v: number, max: number): number => (v < 0 ? 0 : v > max ? max : Math.trunc(v));

/** Cells of the inclusive rectangle spanned by two corners, clipped to the field; `outline` keeps the border only. */
export function rectCells(a: TilePoint, b: TilePoint, outline: boolean): TilePoint[] {
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return [];
  if (Math.max(a.x, b.x) < 0 || Math.min(a.x, b.x) > COURSE_W - 1 || Math.max(a.y, b.y) < 0 || Math.min(a.y, b.y) > COURSE_H - 1) return [];
  const ax = clampCoord(Math.min(a.x, b.x), COURSE_W - 1);
  const bx = clampCoord(Math.max(a.x, b.x), COURSE_W - 1);
  const ay = clampCoord(Math.min(a.y, b.y), COURSE_H - 1);
  const by = clampCoord(Math.max(a.y, b.y), COURSE_H - 1);
  const cells: TilePoint[] = [];
  for (let y = ay; y <= by; y++) {
    for (let x = ax; x <= bx; x++) {
      if (outline && x !== ax && x !== bx && y !== ay && y !== by) continue;
      cells.push({ x, y });
    }
  }
  return cells;
}

/** Cells of the Bresenham line from a to b (both inclusive), clipped to the field; same raster as edit.ts line(). */
export function lineCells(a: TilePoint, b: TilePoint): TilePoint[] {
  if (![a.x, a.y, b.x, b.y].every(Number.isFinite)) return [];
  const ax = Math.round(a.x);
  const ay = Math.round(a.y);
  const bx = Math.round(b.x);
  const by = Math.round(b.y);
  const dx = Math.abs(bx - ax);
  const dy = Math.abs(by - ay);
  const n = Math.max(dx, dy);
  if (n > MAX_LINE_STEPS) return [];
  const xMajor = dx >= dy;
  const major0 = xMajor ? ax : ay;
  const minor0 = xMajor ? ay : ax;
  const sMajor = (xMajor ? bx >= ax : by >= ay) ? 1 : -1;
  const sMinor = (xMajor ? by >= ay : bx >= ax) ? 1 : -1;
  const dMinor = xMajor ? dy : dx;
  const majorMax = (xMajor ? COURSE_W : COURSE_H) - 1;
  const kA = (0 - major0) * sMajor;
  const kB = (majorMax - major0) * sMajor;
  const kMin = Math.max(0, Math.min(kA, kB));
  const kMax = Math.min(n, Math.max(kA, kB));
  const cells: TilePoint[] = [];
  for (let k = kMin; k <= kMax; k++) {
    const major = major0 + sMajor * k;
    const minor = n === 0 ? minor0 : minor0 + sMinor * Math.floor((2 * k * dMinor + n) / (2 * n));
    const c = xMajor ? { x: major, y: minor } : { x: minor, y: major };
    if (inBounds(c.x, c.y)) cells.push(c);
  }
  return cells;
}

// ---------------------------------------------------------------------------------------------------------------
// Controller
// ---------------------------------------------------------------------------------------------------------------

export class ToolController {
  private _tool: ToolId = 'brush';
  private _tab: PaletteTab = 'surface';
  private readonly selections: Record<PaletteTab, Selection> = {
    surface: defaultSelection('surface'),
    walls: defaultSelection('walls'),
    objects: defaultSelection('objects'),
  };
  private drag: Drag | null = null;
  private hover: TilePoint | null = null;
  private notifiedInGesture = false;
  /** Last tile a click or drag touched: origin of a Shift-click line. */
  lastTile: TilePoint | null = null;

  constructor(private readonly host: ToolHost, private readonly ops: EditOps = DEFAULT_EDIT_OPS) {}

  get tool(): ToolId { return this._tool; }
  get tab(): PaletteTab { return this._tab; }
  get selection(): Selection { return this.selections[this._tab]; }
  get dragging(): boolean { return this.drag !== null; }
  get hoverPoint(): TilePoint | null { return this.hover; }

  /** Changing the tool mid-drag ends the drag first (a paint gesture keeps what it painted). */
  setTool(tool: ToolId): void {
    if (tool === this._tool) return;
    this.cancel();
    this._tool = tool;
  }

  /** Switches the tab; the tab's previous selection is restored. */
  setTab(tab: PaletteTab): void { this._tab = tab; }

  /** Selects a palette item; the tab follows the selection. */
  setSelection(sel: Selection): void {
    const tab = tabOfSelection(sel);
    this.selections[tab] = sel;
    this._tab = tab;
  }

  selectionOf(tab: PaletteTab): Selection { return this.selections[tab]; }

  // ---- pointer -------------------------------------------------------------------------------------------------

  pointerDown(p: PointerPoint): void {
    this.hover = p;
    this.notifiedInGesture = false;
    if (this.drag) this.cancel();
    if (p.button === 2) {
      this.pickAt(p);
      return;
    }
    const course = this.host.getCourse();
    switch (this._tool) {
      case 'picker':
        this.pickAt(p);
        return;
      case 'inspect':
        this.host.inspect(inBounds(p.x, p.y) ? { x: p.x, y: p.y } : null);
        return;
      case 'fill': {
        if (!inBounds(p.x, p.y)) return;
        const lv = this.paintValue();
        const next = lv
          ? this.track(course, (c) => this.ops.floodFill(c, lv.layer, p.x, p.y, lv.value))
          : this.applyPoint(course, p);
        this.host.commit(next);
        this.lastTile = { x: p.x, y: p.y };
        return;
      }
      case 'rect':
      case 'line': {
        if (this.paintValue()) {
          this.drag = { kind: 'shape', anchor: { x: p.x, y: p.y }, current: { x: p.x, y: p.y }, alt: p.alt === true };
          return;
        }
        // Object selections have no sensible rectangle/line semantics: place once, like a brush click.
        if (!inBounds(p.x, p.y)) return;
        this.host.commit(this.applyPoint(course, p));
        this.lastTile = { x: p.x, y: p.y };
        return;
      }
      case 'brush':
      case 'eraser': {
        const lv = this.paintValue();
        const from = this.lastTile;
        if (p.shift === true && from && lv) {
          this.host.commit(this.track(course, (c) => this.ops.line(c, lv.layer, from.x, from.y, p.x, p.y, lv.value)));
          this.lastTile = { x: p.x, y: p.y };
          return;
        }
        this.host.beginGesture();
        this.host.update(this.track(course, (c) => this.applyPoint(c, p)));
        this.drag = { kind: 'paint', last: { x: p.x, y: p.y } };
        this.lastTile = { x: p.x, y: p.y };
        return;
      }
    }
  }

  pointerMove(p: PointerPoint): void {
    this.hover = p;
    const d = this.drag;
    if (!d) return;
    if (d.kind === 'paint') {
      if (samePoint(d.last, p)) return;
      const course = this.host.getCourse();
      this.host.update(this.track(course, (c) => this.applySegment(c, d.last, p)));
      d.last = { x: p.x, y: p.y };
      this.lastTile = { x: p.x, y: p.y };
    } else {
      d.current = { x: p.x, y: p.y };
      if (p.alt !== undefined) d.alt = p.alt;
    }
  }

  pointerUp(p: PointerPoint): void {
    this.hover = p;
    const d = this.drag;
    this.drag = null;
    if (!d) return;
    if (d.kind === 'paint') {
      if (!samePoint(d.last, p)) {
        const course = this.host.getCourse();
        this.host.update(this.track(course, (c) => this.applySegment(c, d.last, p)));
        this.lastTile = { x: p.x, y: p.y };
      }
      this.host.endGesture();
      return;
    }
    const lv = this.paintValue();
    if (!lv) return;
    const alt = p.alt ?? d.alt;
    const course = this.host.getCourse();
    const next = this.track(course, (c) =>
      this._tool === 'rect'
        ? this.ops.fillRect(c, lv.layer, d.anchor.x, d.anchor.y, p.x, p.y, lv.value, alt)
        : this.ops.line(c, lv.layer, d.anchor.x, d.anchor.y, p.x, p.y, lv.value));
    this.host.commit(next);
    this.lastTile = { x: p.x, y: p.y };
  }

  /** The pointer left the canvas without a drag in progress: no hover highlight. */
  pointerLeave(): void {
    if (!this.drag) this.hover = null;
  }

  /** Pointer cancel / Esc / window blur: a paint gesture keeps what it painted, a shape drag is discarded. */
  cancel(): void {
    const d = this.drag;
    this.drag = null;
    if (d?.kind === 'paint') this.host.endGesture();
  }

  // ---- overlay ------------------------------------------------------------------------------------------------

  overlay(): ToolOverlay {
    const h = this.hover;
    const hoverTile = h && inBounds(h.x, h.y) ? tileIndex(h.x, h.y) : -1;
    const d = this.drag;
    const highlightTiles: number[] = [];
    if (d && d.kind === 'shape') {
      const cells = this._tool === 'rect' ? rectCells(d.anchor, d.current, d.alt) : lineCells(d.anchor, d.current);
      for (const c of cells) highlightTiles.push(tileIndex(c.x, c.y));
    }
    return { hoverTile, preview: d && d.kind === 'shape' ? undefined : this.preview(), highlightTiles };
  }

  /** 60 % alpha preview of what a click would paint on the hovered tile (none for picker/inspect/object erase). */
  preview(): EditorOverlay['preview'] {
    if (this._tool === 'picker' || this._tool === 'inspect') return undefined;
    const lv = this.paintValue();
    if (lv) return { layer: lv.layer, value: lv.value };
    const oa = this.objectAction();
    if (oa && oa !== 'erase') return { layer: 'object', value: oa };
    return undefined;
  }

  // ---- internals -----------------------------------------------------------------------------------------------

  /** Layer + value the current tool paints with, or null when the action concerns objects. */
  paintValue(): { layer: Layer; value: number } | null {
    if (this._tool === 'eraser') {
      if (this._tab === 'surface') return { layer: 'surface', value: Surface.Grass };
      if (this._tab === 'walls') return { layer: 'walls', value: WallShape.None };
      return null;
    }
    const sel = this.selection;
    if (sel.kind === 'surface') return { layer: 'surface', value: sel.value };
    if (sel.kind === 'walls') return { layer: 'walls', value: sel.value };
    return null;
  }

  /** Object template to place, 'erase' to remove the object, or null when the action paints a layer. */
  objectAction(): CourseObject | 'erase' | null {
    if (this._tool === 'eraser') return this._tab === 'objects' ? 'erase' : null;
    const sel = this.selection;
    if (sel.kind === 'object') return sel.template;
    if (sel.kind === 'eraseObject') return 'erase';
    return null;
  }

  private applyPoint(course: Course, p: TilePoint): Course {
    if (!inBounds(p.x, p.y)) return course;
    const lv = this.paintValue();
    if (lv) {
      return lv.layer === 'surface'
        ? this.ops.setSurface(course, p.x, p.y, lv.value as Surface)
        : this.ops.setWall(course, p.x, p.y, lv.value as WallShape);
    }
    const oa = this.objectAction();
    if (oa === 'erase') return this.ops.removeObjectAt(course, p.x, p.y);
    if (oa) return this.ops.placeObject(course, { ...oa, x: p.x, y: p.y });
    return course;
  }

  /** A drag step: adjacent tiles paint one cell, a jump (fast pointer) paints the Bresenham line between them. */
  private applySegment(course: Course, from: TilePoint, to: TilePoint): Course {
    const lv = this.paintValue();
    if (lv && (Math.abs(to.x - from.x) > 1 || Math.abs(to.y - from.y) > 1)) {
      return this.ops.line(course, lv.layer, from.x, from.y, to.x, to.y, lv.value);
    }
    return this.applyPoint(course, to);
  }

  /** Runs a layer edit and notifies (once per gesture) when it removed objects per the §7.7 invariants. */
  private track(course: Course, fn: (c: Course) => Course): Course {
    const next = fn(course);
    const removed = course.objects.length - next.objects.length;
    if (removed > 0 && this.paintValue() !== null && !this.notifiedInGesture) {
      this.notifiedInGesture = true;
      this.host.notify('editor.toast.objectRemoved', { count: removed });
    }
    return next;
  }

  /**
   * Pipette: an object on the tile always wins; otherwise the active tab decides (surface tab picks the surface, walls
   * tab the wall — None becomes "Poista seinä" — and the objects tab falls back to a wall, then the surface).
   */
  private pickAt(p: TilePoint): void {
    if (!inBounds(p.x, p.y)) return;
    const course = this.host.getCourse();
    const obj = objectAt(course, p.x, p.y);
    const wall = cellValue(course, 'walls', p.x, p.y) as WallShape;
    const surface = cellValue(course, 'surface', p.x, p.y) as Surface;
    let sel: Selection;
    if (obj) sel = { kind: 'object', template: { ...obj, x: 0, y: 0 } };
    else if (this._tab === 'walls' || (this._tab === 'objects' && wall !== WallShape.None)) sel = { kind: 'walls', value: wall };
    else sel = { kind: 'surface', value: surface };
    this.setSelection(sel);
    this.host.pick(sel, this._tab);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Course helpers for the editor shell
// ---------------------------------------------------------------------------------------------------------------

export interface TileInfo { surface: Surface; wall: WallShape; object: CourseObject | undefined }

/** Layer values and object under a tile (for the status bar and the inspector). */
export function describeTile(course: Course, p: TilePoint): TileInfo {
  return {
    surface: cellValue(course, 'surface', p.x, p.y) as Surface,
    wall: cellValue(course, 'walls', p.x, p.y) as WallShape,
    object: objectAt(course, p.x, p.y),
  };
}

/**
 * Prepares a course coming from the library, a file or a share code for editing: rows are padded/trimmed to 49×25
 * (unknown characters are left for the validator to report), malformed object entries are dropped and the id is
 * recomputed as a custom 'c_' id — the editor never works on a reserved built-in id (R13).
 */
export function adoptCourse(input: Course): Course {
  const fixRows = (rows: readonly unknown[] | undefined, fill: string): string[] => {
    const out: string[] = [];
    for (let y = 0; y < COURSE_H; y++) {
      const r = rows?.[y];
      const row = typeof r === 'string' ? r : '';
      out.push(row.length >= COURSE_W ? row.slice(0, COURSE_W) : row + fill.repeat(COURSE_W - row.length));
    }
    return out;
  };
  const rawObjects: unknown[] = Array.isArray(input.objects) ? input.objects : [];
  const objects: CourseObject[] = [];
  for (const o of rawObjects) {
    if (!o || typeof o !== 'object') continue;
    const r = o as Record<string, unknown>;
    if (typeof r.type !== 'string' || !Number.isInteger(r.x) || !Number.isInteger(r.y)) continue;
    objects.push({ ...(o as CourseObject) });
  }
  const rules = input.rules && typeof input.rules === 'object' ? input.rules : { maxStrokes: DEFAULT_MAX_STROKES, par: DEFAULT_PAR };
  return withComputedId({
    format: 'puttipeli-course',
    formatVersion: 1,
    id: '',
    name: typeof input.name === 'string' ? input.name : '',
    author: typeof input.author === 'string' ? input.author : '',
    description: typeof input.description === 'string' ? input.description : '',
    width: 49,
    height: 25,
    rules: {
      maxStrokes: typeof rules.maxStrokes === 'number' ? rules.maxStrokes : DEFAULT_MAX_STROKES,
      par: typeof rules.par === 'number' ? rules.par : DEFAULT_PAR,
    },
    surface: fixRows(input.surface, '.'),
    walls: fixRows(input.walls, '.'),
    objects,
  });
}

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

/**
 * Lenient CourseLayers for rendering. The strict decodeLayers() throws on every state the validator rejects, but
 * the editor must draw mid-edit courses (an unpaired teleport, no start yet, an unknown character): unknown chars
 * draw as grass/none, a lone teleport pad has partnerIndex -1 (no link line), magnets are clamped like decodeLayers.
 */
export function buildEditorLayers(course: Course): CourseLayers {
  const surface = new Uint8Array(TILE_COUNT);
  const walls = new Uint8Array(TILE_COUNT);
  for (let y = 0; y < COURSE_H; y++) {
    const sRow = course.surface[y] ?? '';
    const wRow = course.walls[y] ?? '';
    for (let x = 0; x < COURSE_W; x++) {
      const i = tileIndex(x, y);
      surface[i] = surfaceFromChar(sRow.charAt(x)) ?? Surface.Grass;
      walls[i] = wallFromChar(wRow.charAt(x)) ?? WallShape.None;
    }
  }
  const objectAtTile = new Int16Array(TILE_COUNT);
  objectAtTile.fill(-1);
  const objects = course.objects.filter((o) => !!o && typeof o === 'object' && Number.isInteger(o.x) && Number.isInteger(o.y) && inBounds(o.x, o.y));
  let startTile = -1;
  const holes: HoleDef[] = [];
  const mines: MineDef[] = [];
  const magnets: MagnetDef[] = [];
  const teleports: TeleportPad[] = [];
  objects.forEach((o, k) => {
    const tile = tileIndex(o.x, o.y);
    objectAtTile[tile] = k;
    const { x: cx, y: cy } = tileCentre(tile);
    switch (o.type) {
      case 'start':
        if (startTile < 0) startTile = tile;
        break;
      case 'hole':
        holes.push({ tile, cx, cy });
        break;
      case 'mine':
        mines.push({ tile, cx, cy });
        break;
      case 'magnet':
        magnets.push({
          tile, cx, cy, polarity: o.polarity,
          strength: clamp(Number.isFinite(o.strength) ? o.strength : MAGNET_MIN_STRENGTH, MAGNET_MIN_STRENGTH, MAGNET_MAX_STRENGTH),
          radius: clamp(Number.isFinite(o.radius) ? o.radius : MAGNET_MIN_RADIUS, MAGNET_MIN_RADIUS, MAGNET_MAX_RADIUS),
        });
        break;
      case 'teleport':
        teleports.push({ tile, cx, cy, group: o.group, partnerTile: -1, partnerIndex: -1 });
        break;
    }
  });
  for (let i = 0; i < teleports.length; i++) {
    const a = teleports[i]!;
    const peers = teleports.filter((p) => p.group === a.group);
    if (peers.length !== 2) continue;
    const j = teleports.indexOf(peers[0] === a ? peers[1]! : peers[0]!);
    a.partnerIndex = j;
    a.partnerTile = teleports[j]!.tile;
  }
  const start = startTile >= 0 ? tileCentre(startTile) : { x: -TILE, y: -TILE };
  return {
    surface, walls, objectAt: objectAtTile, objects, start, startTile, holes, teleports, magnets, mines,
    maxStrokes: course.rules.maxStrokes, par: course.rules.par,
  };
}
