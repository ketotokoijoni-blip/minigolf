// Tool state machine -> expected edit.ts calls, and drag coalescing in history (DESIGN §16.5).
import { describe, expect, it, vi } from 'vitest';
import { COURSE_H, COURSE_W, TILE } from '@puttipeli/shared/constants';
import { createBlankCourse } from '@puttipeli/shared/course/blank';
import * as editOps from '@puttipeli/shared/course/edit';
import { cellValue, objectAt, placeObject, setMeta, setWall } from '@puttipeli/shared/course/edit';
import { tileIndex } from '@puttipeli/shared/course/grid';
import { Surface, WallShape, type Course, type CourseObject } from '@puttipeli/shared/course/types';
import { History } from './history';
import {
  ToolController, adoptCourse, buildEditorLayers, defaultSelection, describeTile, lineCells, rectCells, tabOfSelection,
  worldToTile, type EditOps, type PointerPoint, type Selection, type TilePoint, type ToolHost,
} from './tools';

function spyOps(): EditOps {
  return {
    setSurface: vi.fn(editOps.setSurface),
    setWall: vi.fn(editOps.setWall),
    placeObject: vi.fn(editOps.placeObject),
    removeObjectAt: vi.fn(editOps.removeObjectAt),
    fillRect: vi.fn(editOps.fillRect),
    floodFill: vi.fn(editOps.floodFill),
    line: vi.fn(editOps.line),
  };
}

function setup(initial: Course = createBlankCourse({ name: 'Testi' })) {
  const history = new History(initial);
  const log: string[] = [];
  const picks: { sel: Selection; tab: string }[] = [];
  const inspected: (TilePoint | null)[] = [];
  const notes: { key: string; params?: Record<string, string | number> }[] = [];
  const host: ToolHost = {
    getCourse: () => history.current,
    beginGesture: () => { log.push('begin'); history.beginGesture(); },
    update: (c) => { log.push('update'); history.update(c); },
    endGesture: () => { log.push('end'); history.endGesture(); },
    commit: (c) => { log.push('commit'); history.commit(c); },
    pick: (sel, tab) => picks.push({ sel, tab }),
    inspect: (p) => inspected.push(p),
    notify: (key, params) => notes.push({ key, params }),
  };
  const ops = spyOps();
  const tools = new ToolController(host, ops);
  return { tools, ops, history, log, picks, inspected, notes, course: () => history.current };
}

const at = (x: number, y: number, extra: Partial<PointerPoint> = {}): PointerPoint => ({ x, y, button: 0, ...extra });

describe('worldToTile', () => {
  it('maps world px to tiles without clamping', () => {
    expect(worldToTile(0, 0)).toEqual({ x: 0, y: 0 });
    expect(worldToTile(TILE * 3 + 7, TILE * 2 + 14.9)).toEqual({ x: 3, y: 2 });
    expect(worldToTile(-0.5, 10)).toEqual({ x: -1, y: 0 });
    expect(worldToTile(COURSE_W * TILE, COURSE_H * TILE + 1)).toEqual({ x: COURSE_W, y: COURSE_H });
  });
});

describe('selection helpers', () => {
  it('tabOfSelection and defaults', () => {
    expect(tabOfSelection({ kind: 'surface', value: Surface.Ice })).toBe('surface');
    expect(tabOfSelection({ kind: 'walls', value: WallShape.None })).toBe('walls');
    expect(tabOfSelection({ kind: 'eraseObject' })).toBe('objects');
    expect(tabOfSelection(defaultSelection('objects'))).toBe('objects');
    expect(defaultSelection('walls')).toEqual({ kind: 'walls', value: WallShape.Full });
  });
});

describe('brush', () => {
  it('paints one tile per distinct tile during a drag and coalesces the drag into one history entry', () => {
    const s = setup();
    s.tools.setSelection({ kind: 'surface', value: Surface.Sand });
    s.tools.pointerDown(at(3, 3));
    s.tools.pointerMove(at(3, 3)); // same tile: nothing
    s.tools.pointerMove(at(4, 3));
    s.tools.pointerMove(at(5, 4));
    s.tools.pointerUp(at(5, 4));
    expect(s.ops.setSurface).toHaveBeenCalledTimes(3);
    expect(s.ops.setSurface).toHaveBeenNthCalledWith(1, expect.anything(), 3, 3, Surface.Sand);
    expect(s.ops.setSurface).toHaveBeenNthCalledWith(2, expect.anything(), 4, 3, Surface.Sand);
    expect(s.ops.setSurface).toHaveBeenNthCalledWith(3, expect.anything(), 5, 4, Surface.Sand);
    expect(s.ops.line).not.toHaveBeenCalled();
    expect(s.log).toEqual(['begin', 'update', 'update', 'update', 'end']);
    expect(s.history.undoDepth).toBe(1);
    expect(cellValue(s.course(), 'surface', 4, 3)).toBe(Surface.Sand);
    expect(s.history.undo()).not.toBeNull();
    expect(cellValue(s.course(), 'surface', 4, 3)).toBe(Surface.Grass);
    expect(s.tools.lastTile).toEqual({ x: 5, y: 4 });
  });

  it('fills the gap with a line when the pointer jumps more than one tile', () => {
    const s = setup();
    s.tools.setSelection({ kind: 'walls', value: WallShape.Full });
    s.tools.pointerDown(at(2, 2));
    s.tools.pointerMove(at(8, 2));
    s.tools.pointerUp(at(8, 2));
    expect(s.ops.setWall).toHaveBeenCalledTimes(1);
    expect(s.ops.line).toHaveBeenCalledWith(expect.anything(), 'walls', 2, 2, 8, 2, WallShape.Full);
    for (let x = 2; x <= 8; x++) expect(cellValue(s.course(), 'walls', x, 2)).toBe(WallShape.Full);
    expect(s.history.undoDepth).toBe(1);
  });

  it('Shift-click draws a line from the last tile as a single commit', () => {
    const s = setup();
    s.tools.setSelection({ kind: 'surface', value: Surface.Ice });
    s.tools.pointerDown(at(1, 1));
    s.tools.pointerUp(at(1, 1));
    s.tools.pointerDown(at(10, 5, { shift: true }));
    expect(s.ops.line).toHaveBeenCalledWith(expect.anything(), 'surface', 1, 1, 10, 5, Surface.Ice);
    expect(s.tools.dragging).toBe(false);
    expect(s.log.filter((l) => l === 'commit')).toHaveLength(1);
    expect(s.history.undoDepth).toBe(2);
    expect(cellValue(s.course(), 'surface', 10, 5)).toBe(Surface.Ice);
  });

  it('Shift-click without a previous tile is a plain click', () => {
    const s = setup();
    s.tools.setSelection({ kind: 'surface', value: Surface.Ice });
    s.tools.pointerDown(at(4, 4, { shift: true }));
    s.tools.pointerUp(at(4, 4));
    expect(s.ops.line).not.toHaveBeenCalled();
    expect(s.ops.setSurface).toHaveBeenCalledTimes(1);
  });

  it('a drag that leaves the field paints nothing outside and clips the gap line', () => {
    const s = setup();
    s.tools.setSelection({ kind: 'surface', value: Surface.Sand });
    s.tools.pointerDown(at(47, 12));
    s.tools.pointerMove(at(48, 12));
    s.tools.pointerMove(at(49, 12)); // off the field (right)
    s.tools.pointerMove(at(60, 12));
    s.tools.pointerMove(at(-3, 12)); // jumped across: the clipped line paints the whole row
    s.tools.pointerUp(at(-3, 12));
    expect(() => s.tools.overlay()).not.toThrow();
    expect(s.tools.overlay().hoverTile).toBe(-1);
    for (let x = 0; x < COURSE_W; x++) expect(cellValue(s.course(), 'surface', x, 12)).toBe(Surface.Sand);
    expect(s.history.undoDepth).toBe(1);
  });

  it('places objects through placeObject and moves the start singleton', () => {
    const s = setup();
    s.tools.setSelection({ kind: 'object', template: { type: 'start', x: 0, y: 0 } });
    s.tools.pointerDown(at(10, 10));
    s.tools.pointerMove(at(11, 10));
    s.tools.pointerUp(at(11, 10));
    expect(s.ops.placeObject).toHaveBeenCalledTimes(2);
    expect(s.ops.placeObject).toHaveBeenLastCalledWith(expect.anything(), { type: 'start', x: 11, y: 10 });
    expect(s.course().objects.filter((o) => o.type === 'start')).toEqual([{ type: 'start', x: 11, y: 10 }]);
    expect(s.history.undoDepth).toBe(1);
  });

  it('does not interpolate object placement across a pointer jump', () => {
    const s = setup();
    s.tools.setSelection({ kind: 'object', template: { type: 'mine', x: 0, y: 0 } });
    s.tools.pointerDown(at(10, 10));
    s.tools.pointerMove(at(20, 10));
    s.tools.pointerUp(at(20, 10));
    expect(s.ops.placeObject).toHaveBeenCalledTimes(2);
    expect(s.ops.line).not.toHaveBeenCalled();
    expect(s.course().objects.filter((o) => o.type === 'mine')).toHaveLength(2);
  });

  it('notifies once per gesture when a layer paint removes objects', () => {
    const s = setup();
    s.tools.setSelection({ kind: 'surface', value: Surface.Water });
    s.tools.pointerDown(at(3, 12)); // the start sits here
    s.tools.pointerMove(at(4, 12));
    s.tools.pointerMove(at(45, 12)); // the hole; the gap line covers it
    s.tools.pointerUp(at(45, 12));
    expect(s.course().objects).toHaveLength(0);
    expect(s.notes).toEqual([{ key: 'editor.toast.objectRemoved', params: { count: 1 } }]);
  });

  it('ignores a pointerMove/pointerUp without a prior pointerDown', () => {
    const s = setup();
    s.tools.pointerMove(at(3, 3));
    s.tools.pointerUp(at(3, 3));
    expect(s.log).toEqual([]);
    expect(s.tools.overlay().hoverTile).toBe(tileIndex(3, 3));
  });

  it('cancel() ends a paint gesture keeping what was painted, and setTool mid-drag does the same', () => {
    const s = setup();
    s.tools.setSelection({ kind: 'surface', value: Surface.Sand });
    s.tools.pointerDown(at(3, 3));
    s.tools.pointerMove(at(4, 3));
    s.tools.cancel();
    expect(s.log).toEqual(['begin', 'update', 'update', 'end']);
    expect(s.history.undoDepth).toBe(1);
    expect(s.history.inGesture).toBe(false);
    s.tools.pointerDown(at(6, 3));
    s.tools.setTool('rect');
    expect(s.tools.dragging).toBe(false);
    expect(s.history.inGesture).toBe(false);
    expect(s.history.undoDepth).toBe(2);
  });
});

describe('rectangle', () => {
  it('previews while dragging, mutates nothing until pointerUp and then calls fillRect once', () => {
    const s = setup();
    s.tools.setTool('rect');
    s.tools.setSelection({ kind: 'walls', value: WallShape.Bumper });
    s.tools.pointerDown(at(2, 2));
    s.tools.pointerMove(at(5, 6));
    expect(s.ops.fillRect).not.toHaveBeenCalled();
    expect(s.log).toEqual([]);
    const o = s.tools.overlay();
    expect(o.highlightTiles).toHaveLength(4 * 5);
    expect(o.preview).toBeUndefined();
    s.tools.pointerUp(at(5, 6));
    expect(s.ops.fillRect).toHaveBeenCalledTimes(1);
    expect(s.ops.fillRect).toHaveBeenCalledWith(expect.anything(), 'walls', 2, 2, 5, 6, WallShape.Bumper, false);
    expect(s.log).toEqual(['commit']);
    expect(cellValue(s.course(), 'walls', 3, 4)).toBe(WallShape.Bumper);
  });

  it('Alt paints the outline only', () => {
    const s = setup();
    s.tools.setTool('rect');
    s.tools.setSelection({ kind: 'walls', value: WallShape.Full });
    s.tools.pointerDown(at(10, 10, { alt: true }));
    s.tools.pointerMove(at(14, 14, { alt: true }));
    expect(s.tools.overlay().highlightTiles).toHaveLength(16);
    s.tools.pointerUp(at(14, 14, { alt: true }));
    expect(s.ops.fillRect).toHaveBeenCalledWith(expect.anything(), 'walls', 10, 10, 14, 14, WallShape.Full, true);
    expect(cellValue(s.course(), 'walls', 12, 12)).toBe(WallShape.None);
    expect(cellValue(s.course(), 'walls', 10, 12)).toBe(WallShape.Full);
  });

  it('a corner dragged off the canvas is clipped by the op', () => {
    const s = setup();
    s.tools.setTool('rect');
    s.tools.setSelection({ kind: 'surface', value: Surface.Ice });
    s.tools.pointerDown(at(46, 22));
    s.tools.pointerUp(at(70, 40));
    expect(s.ops.fillRect).toHaveBeenCalledWith(expect.anything(), 'surface', 46, 22, 70, 40, Surface.Ice, false);
    expect(cellValue(s.course(), 'surface', 48, 24)).toBe(Surface.Ice);
    expect(cellValue(s.course(), 'surface', 45, 22)).toBe(Surface.Grass);
  });

  it('with an object selection places once like a click', () => {
    const s = setup();
    s.tools.setTool('rect');
    s.tools.setSelection({ kind: 'object', template: { type: 'hole', x: 0, y: 0 } });
    s.tools.pointerDown(at(20, 20));
    s.tools.pointerMove(at(25, 22));
    s.tools.pointerUp(at(25, 22));
    expect(s.ops.fillRect).not.toHaveBeenCalled();
    expect(s.ops.placeObject).toHaveBeenCalledWith(expect.anything(), { type: 'hole', x: 20, y: 20 });
  });

  it('cancel discards a shape drag', () => {
    const s = setup();
    s.tools.setTool('rect');
    s.tools.pointerDown(at(2, 2));
    s.tools.pointerMove(at(5, 5));
    s.tools.cancel();
    s.tools.pointerUp(at(5, 5));
    expect(s.ops.fillRect).not.toHaveBeenCalled();
    expect(s.log).toEqual([]);
  });
});

describe('line and fill', () => {
  it('line tool calls line() once at pointerUp with the anchor and the release tile', () => {
    const s = setup();
    s.tools.setTool('line');
    s.tools.setSelection({ kind: 'walls', value: WallShape.Breakable2 });
    s.tools.pointerDown(at(5, 5));
    s.tools.pointerMove(at(9, 7));
    expect(s.tools.overlay().highlightTiles).toEqual(lineCells({ x: 5, y: 5 }, { x: 9, y: 7 }).map((c) => tileIndex(c.x, c.y)));
    s.tools.pointerUp(at(9, 7));
    expect(s.ops.line).toHaveBeenCalledTimes(1);
    expect(s.ops.line).toHaveBeenCalledWith(expect.anything(), 'walls', 5, 5, 9, 7, WallShape.Breakable2);
    expect(cellValue(s.course(), 'walls', 9, 7)).toBe(WallShape.Breakable2);
  });

  it('fill tool flood-fills on pointerDown as one commit and ignores clicks outside the field', () => {
    const s = setup();
    s.tools.setTool('fill');
    s.tools.setSelection({ kind: 'surface', value: Surface.Sand });
    s.tools.pointerDown(at(-1, 5));
    expect(s.ops.floodFill).not.toHaveBeenCalled();
    s.tools.pointerDown(at(10, 10));
    s.tools.pointerUp(at(10, 10));
    expect(s.ops.floodFill).toHaveBeenCalledTimes(1);
    expect(s.ops.floodFill).toHaveBeenCalledWith(expect.anything(), 'surface', 10, 10, Surface.Sand);
    expect(s.log).toEqual(['commit']);
    expect(cellValue(s.course(), 'surface', 0, 0)).toBe(Surface.Sand);
  });

  it('fill with an object selection places the object at the clicked tile', () => {
    const s = setup();
    s.tools.setTool('fill');
    s.tools.setSelection({ kind: 'object', template: { type: 'mine', x: 0, y: 0 } });
    s.tools.pointerDown(at(10, 10));
    expect(s.ops.floodFill).not.toHaveBeenCalled();
    expect(s.ops.placeObject).toHaveBeenCalledWith(expect.anything(), { type: 'mine', x: 10, y: 10 });
  });
});

describe('eraser', () => {
  it('follows the active tab: grass / no wall / remove object', () => {
    const start = placeObject(setWall(createBlankCourse(), 10, 10, WallShape.Full), { type: 'mine', x: 20, y: 20 });
    const s = setup(start);
    s.tools.setTool('eraser');
    s.tools.setTab('surface');
    s.tools.pointerDown(at(3, 3));
    s.tools.pointerUp(at(3, 3));
    expect(s.ops.setSurface).toHaveBeenCalledWith(expect.anything(), 3, 3, Surface.Grass);
    s.tools.setTab('walls');
    s.tools.pointerDown(at(10, 10));
    s.tools.pointerUp(at(10, 10));
    expect(s.ops.setWall).toHaveBeenCalledWith(expect.anything(), 10, 10, WallShape.None);
    expect(cellValue(s.course(), 'walls', 10, 10)).toBe(WallShape.None);
    s.tools.setTab('objects');
    expect(s.tools.preview()).toBeUndefined();
    s.tools.pointerDown(at(20, 20));
    s.tools.pointerUp(at(20, 20));
    expect(s.ops.removeObjectAt).toHaveBeenCalledWith(expect.anything(), 20, 20);
    expect(objectAt(s.course(), 20, 20)).toBeUndefined();
  });

  it('"Poista kohde" selection removes with any tool', () => {
    const s = setup();
    s.tools.setSelection({ kind: 'eraseObject' });
    s.tools.pointerDown(at(45, 12));
    s.tools.pointerUp(at(45, 12));
    expect(s.ops.removeObjectAt).toHaveBeenCalledWith(expect.anything(), 45, 12);
    expect(s.course().objects.some((o) => o.type === 'hole')).toBe(false);
  });
});

describe('pipette and inspect', () => {
  const magnet: CourseObject = { type: 'magnet', x: 20, y: 5, polarity: -1, strength: 250, radius: 60 };
  const course = placeObject(setWall(createBlankCourse(), 10, 10, WallShape.TriNE), magnet);

  it('right-click picks an object into the palette regardless of tool or tab', () => {
    const s = setup(course);
    s.tools.setTool('rect');
    s.tools.setTab('surface');
    s.tools.pointerDown(at(20, 5, { button: 2 }));
    expect(s.picks).toEqual([{ sel: { kind: 'object', template: { ...magnet, x: 0, y: 0 } }, tab: 'objects' }]);
    expect(s.tools.tab).toBe('objects');
    expect(s.tools.tool).toBe('rect');
    expect(s.tools.dragging).toBe(false);
    expect(s.log).toEqual([]);
  });

  it('picks the wall on the walls tab (None becomes "Poista seinä") and the surface on the surface tab', () => {
    const s = setup(course);
    s.tools.setTool('picker');
    s.tools.setTab('walls');
    s.tools.pointerDown(at(10, 10));
    expect(s.picks.at(-1)).toEqual({ sel: { kind: 'walls', value: WallShape.TriNE }, tab: 'walls' });
    s.tools.pointerDown(at(11, 10));
    expect(s.picks.at(-1)).toEqual({ sel: { kind: 'walls', value: WallShape.None }, tab: 'walls' });
    s.tools.setTab('surface');
    s.tools.pointerDown(at(10, 10));
    expect(s.picks.at(-1)).toEqual({ sel: { kind: 'surface', value: Surface.Grass }, tab: 'surface' });
    // Objects tab without an object: wall if any, else surface.
    s.tools.setTab('objects');
    s.tools.pointerDown(at(10, 10));
    expect(s.picks.at(-1)?.sel).toEqual({ kind: 'walls', value: WallShape.TriNE });
    expect(s.tools.tab).toBe('walls'); // the tab follows the picked selection
    s.tools.setTab('objects');
    s.tools.pointerDown(at(12, 12));
    expect(s.picks.at(-1)?.sel).toEqual({ kind: 'surface', value: Surface.Grass });
    // Outside the field: nothing.
    s.tools.pointerDown(at(-1, -1));
    expect(s.picks).toHaveLength(5);
  });

  it('inspect reports the tile or null outside the field and never mutates', () => {
    const s = setup(course);
    s.tools.setTool('inspect');
    s.tools.pointerDown(at(20, 5));
    s.tools.pointerUp(at(20, 5));
    s.tools.pointerDown(at(99, 0));
    expect(s.inspected).toEqual([{ x: 20, y: 5 }, null]);
    expect(s.log).toEqual([]);
    expect(s.tools.preview()).toBeUndefined();
  });
});

describe('overlay previews', () => {
  it('reflect the tool and selection', () => {
    const s = setup();
    s.tools.setSelection({ kind: 'surface', value: Surface.Tar });
    s.tools.pointerMove(at(4, 4));
    expect(s.tools.overlay()).toEqual({ hoverTile: tileIndex(4, 4), preview: { layer: 'surface', value: Surface.Tar }, highlightTiles: [] });
    s.tools.setSelection({ kind: 'object', template: { type: 'teleport', x: 0, y: 0, group: 3 } });
    expect(s.tools.preview()).toEqual({ layer: 'object', value: { type: 'teleport', x: 0, y: 0, group: 3 } });
    s.tools.setTool('eraser');
    s.tools.setTab('walls');
    expect(s.tools.preview()).toEqual({ layer: 'walls', value: WallShape.None });
    s.tools.pointerLeave();
    expect(s.tools.overlay().hoverTile).toBe(-1);
  });

  it('per-tab selections are remembered across tab switches', () => {
    const s = setup();
    s.tools.setSelection({ kind: 'surface', value: Surface.Acid });
    s.tools.setSelection({ kind: 'walls', value: WallShape.Movable });
    s.tools.setTab('surface');
    expect(s.tools.selection).toEqual({ kind: 'surface', value: Surface.Acid });
    s.tools.setTab('walls');
    expect(s.tools.selection).toEqual({ kind: 'walls', value: WallShape.Movable });
  });
});

describe('shape rasters', () => {
  it('rectCells matches fillRect and clips', () => {
    expect(rectCells({ x: 2, y: 2 }, { x: 4, y: 3 }, false)).toHaveLength(6);
    expect(rectCells({ x: 4, y: 3 }, { x: 2, y: 2 }, false)).toHaveLength(6);
    expect(rectCells({ x: 0, y: 0 }, { x: 4, y: 4 }, true)).toHaveLength(16);
    expect(rectCells({ x: -5, y: -5 }, { x: -1, y: 10 }, false)).toEqual([]);
    expect(rectCells({ x: 47, y: 23 }, { x: 99, y: 99 }, false)).toHaveLength(4);
  });

  it('lineCells matches the edit.ts raster', () => {
    const base = createBlankCourse();
    const cells = lineCells({ x: 1, y: 1 }, { x: 20, y: 8 });
    const painted = editOps.line(base, 'surface', 1, 1, 20, 8, Surface.Sand);
    let count = 0;
    for (let y = 0; y < COURSE_H; y++) for (let x = 0; x < COURSE_W; x++) if (cellValue(painted, 'surface', x, y) === Surface.Sand) count++;
    expect(count).toBe(cells.length);
    for (const c of cells) expect(cellValue(painted, 'surface', c.x, c.y)).toBe(Surface.Sand);
    expect(lineCells({ x: 3, y: 3 }, { x: 3, y: 3 })).toEqual([{ x: 3, y: 3 }]);
    expect(lineCells({ x: -10, y: 5 }, { x: 60, y: 5 })).toHaveLength(COURSE_W);
  });
});

describe('course helpers', () => {
  it('describeTile reads both layers and the object', () => {
    const c = placeObject(createBlankCourse(), { type: 'mine', x: 7, y: 7 });
    expect(describeTile(c, { x: 0, y: 0 })).toEqual({ surface: Surface.Grass, wall: WallShape.Full, object: undefined });
    expect(describeTile(c, { x: 7, y: 7 }).object).toEqual({ type: 'mine', x: 7, y: 7 });
  });

  it('adoptCourse recomputes a custom id, strips built-in ids and repairs rows', () => {
    const blank = createBlankCourse({ name: 'Oma' });
    const claimed = { ...blank, id: 'b_01' };
    const adopted = adoptCourse(claimed);
    expect(adopted.id.startsWith('c_')).toBe(true);
    expect(adopted.id).toBe(blank.id);
    const broken = { ...blank, surface: blank.surface.slice(0, 10), walls: ['#'], objects: [...blank.objects, { bogus: true } as unknown as CourseObject] };
    const fixed = adoptCourse(broken);
    expect(fixed.surface).toHaveLength(COURSE_H);
    expect(fixed.walls).toHaveLength(COURSE_H);
    expect(fixed.walls[0]).toBe('#' + '.'.repeat(COURSE_W - 1));
    expect(fixed.surface.every((r) => r.length === COURSE_W)).toBe(true);
    expect(fixed.objects).toHaveLength(2);
    expect(() => editOps.setSurface(fixed, 48, 24, Surface.Sand)).not.toThrow();
  });

  it('buildEditorLayers tolerates every mid-edit state the strict decoder rejects', () => {
    const blank = createBlankCourse();
    // No start, a lone teleport, two magnets with out-of-range values, an unknown character.
    let c = editOps.removeObjectAt(blank, 3, 12);
    c = placeObject(c, { type: 'teleport', x: 10, y: 10, group: 2 });
    c = placeObject(c, { type: 'magnet', x: 20, y: 20, polarity: 1, strength: 9999, radius: 1 });
    c = { ...c, surface: c.surface.map((r, y) => (y === 5 ? '?' + r.slice(1) : r)) };
    const layers = buildEditorLayers(c);
    expect(layers.startTile).toBe(-1);
    expect(layers.teleports).toHaveLength(1);
    expect(layers.teleports[0]!.partnerIndex).toBe(-1);
    expect(layers.magnets[0]!.strength).toBe(500);
    expect(layers.magnets[0]!.radius).toBe(30);
    expect(layers.surface[tileIndex(0, 5)]).toBe(Surface.Grass);
    expect(layers.walls[tileIndex(0, 0)]).toBe(WallShape.Full);
    expect(layers.holes).toHaveLength(1);
    expect(layers.objectAt[tileIndex(45, 12)]).toBeGreaterThanOrEqual(0);
    // A paired group links both pads to each other.
    const paired = placeObject(c, { type: 'teleport', x: 30, y: 10, group: 2 });
    const l2 = buildEditorLayers(paired);
    expect(l2.teleports[0]!.partnerIndex).toBe(1);
    expect(l2.teleports[1]!.partnerIndex).toBe(0);
    expect(l2.teleports[0]!.partnerTile).toBe(tileIndex(30, 10));
  });
});

describe('gesture overlap with the inspector (one entry per drag, DESIGN §13.3)', () => {
  // The screen wires the inspector to history.beginGesture('inspector') and the tools to the default 'tools' owner.
  it('a brush drag that starts while a metadata field is focused stays one entry even when the field blurs mid-drag', () => {
    const { tools, history } = setup();
    history.beginGesture('inspector');
    history.update(setMeta(history.current, { name: 'Nimi' }));
    tools.pointerDown(at(2, 2));
    history.endGesture('inspector'); // blur after the canvas pointerdown
    tools.pointerMove(at(3, 2));
    tools.pointerMove(at(4, 2));
    tools.pointerMove(at(5, 2));
    tools.pointerUp(at(6, 2));
    expect(history.inGesture).toBe(false);
    expect(history.undoDepth).toBe(2);
    expect(history.undo()?.name).toBe('Nimi');
    expect(history.undo()?.name).toBe('Testi');
  });

  it('the field keeps focus: the drag ends on pointerUp and does not swallow later keystrokes', () => {
    const { tools, history } = setup();
    history.beginGesture('inspector');
    history.update(setMeta(history.current, { name: 'N' }));
    tools.pointerDown(at(2, 2));
    tools.pointerMove(at(3, 2));
    tools.pointerUp(at(4, 2));
    expect(history.undoDepth).toBe(2);
    history.beginGesture('inspector');
    history.update(setMeta(history.current, { name: 'Ni' }));
    history.beginGesture('inspector');
    history.update(setMeta(history.current, { name: 'Nim' }));
    history.endGesture('inspector');
    expect(history.undoDepth).toBe(3);
  });
});
