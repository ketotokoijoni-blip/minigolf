// History: limit, redo invalidation, gesture coalescing, reset (DESIGN §13.3, §16.5).
import { describe, expect, it } from 'vitest';
import { createBlankCourse } from '@puttipeli/shared/course/blank';
import { setMeta, setSurface } from '@puttipeli/shared/course/edit';
import { Surface, type Course } from '@puttipeli/shared/course/types';
import { History, HISTORY_LIMIT, coursesDiffer } from './history';

const base = createBlankCourse({ name: 'Historia' });
const paint = (c = base, x = 5, y = 5, s: Surface = Surface.Sand) => setSurface(c, x, y, s);

describe('coursesDiffer', () => {
  it('detects content changes and ignores reference identity', () => {
    expect(coursesDiffer(base, base)).toBe(false);
    expect(coursesDiffer(base, { ...base })).toBe(false);
    expect(coursesDiffer(base, paint())).toBe(true);
    // Same content hash but a different reference with a stale id: falls back to the canonical comparison.
    expect(coursesDiffer(base, { ...paint(), id: base.id })).toBe(true);
  });
});

describe('History', () => {
  it('commits, undoes and redoes', () => {
    const h = new History(base);
    expect(h.canUndo).toBe(false);
    const a = paint(base, 1, 1);
    const b = paint(a, 2, 2);
    h.commit(a);
    h.commit(b);
    expect(h.current).toBe(b);
    expect(h.undoDepth).toBe(2);
    expect(h.undo()).toBe(a);
    expect(h.undo()).toBe(base);
    expect(h.undo()).toBeNull();
    expect(h.redo()).toBe(a);
    expect(h.redo()).toBe(b);
    expect(h.redo()).toBeNull();
  });

  it('ignores commits that do not change the content', () => {
    const h = new History(base);
    h.commit(base);
    h.commit({ ...base });
    expect(h.canUndo).toBe(false);
    expect(h.current).toBe(base);
  });

  it('a new commit after undo clears the redo stack', () => {
    const h = new History(base);
    h.commit(paint(base, 1, 1));
    h.undo();
    expect(h.canRedo).toBe(true);
    h.commit(paint(base, 3, 3));
    expect(h.canRedo).toBe(false);
  });

  it(`keeps at most ${HISTORY_LIMIT} undo steps`, () => {
    const h = new History(base);
    let c = base;
    for (let i = 0; i < HISTORY_LIMIT + 25; i++) {
      c = paint(c, 1 + (i % 47), 1 + Math.floor(i / 47), i % 2 === 0 ? Surface.Sand : Surface.Ice);
      h.commit(c);
    }
    expect(h.undoDepth).toBe(HISTORY_LIMIT);
    let steps = 0;
    while (h.undo()) steps++;
    expect(steps).toBe(HISTORY_LIMIT);
  });

  it('folds a gesture into one entry and restores the pre-gesture course on undo', () => {
    const h = new History(base);
    h.beginGesture();
    expect(h.inGesture).toBe(true);
    expect(h.canUndo).toBe(false);
    let c = base;
    for (let x = 1; x < 20; x++) {
      c = paint(c, x, 3);
      h.update(c);
    }
    expect(h.current).toBe(c);
    h.endGesture();
    expect(h.undoDepth).toBe(1);
    expect(h.undo()).toBe(base);
    expect(h.redo()).toBe(c);
  });

  it('a gesture without changes leaves no entry', () => {
    const h = new History(base);
    h.beginGesture();
    h.update(base);
    h.update({ ...base });
    h.endGesture();
    expect(h.canUndo).toBe(false);
    h.endGesture(); // idempotent
    expect(h.canUndo).toBe(false);
  });

  it('update() outside a gesture is a plain commit and commit() inside a gesture folds in', () => {
    const h = new History(base);
    const a = paint(base, 1, 1);
    h.update(a);
    expect(h.undoDepth).toBe(1);
    h.beginGesture();
    h.commit(paint(a, 2, 2));
    h.commit(paint(a, 3, 3));
    h.endGesture();
    expect(h.undoDepth).toBe(2);
  });

  it('reset drops everything', () => {
    const h = new History(base);
    h.commit(paint(base, 1, 1));
    h.undo();
    const fresh = createBlankCourse({ name: 'Toinen' });
    h.reset(fresh);
    expect(h.current).toBe(fresh);
    expect(h.canUndo).toBe(false);
    expect(h.canRedo).toBe(false);
  });
});

describe('History gesture owners', () => {
  const rename = (c: Course, name: string): Course => setMeta(c, { name });

  it('a tools gesture that starts while the inspector holds the gesture closes the inspector gesture first', () => {
    const h = new History(base);
    h.beginGesture('inspector'); // metadata field focused
    h.update(rename(base, 'A'));
    expect(h.gestureOwner).toBe('inspector');
    h.beginGesture('tools'); // canvas drag starts while the field still has focus
    expect(h.gestureOwner).toBe('tools');
    expect(h.undoDepth).toBe(1); // the typing became its own entry
    let c = h.current;
    for (let x = 1; x <= 4; x++) h.update((c = paint(c, x, 2)));
    h.endGesture('inspector'); // the field blurs mid-drag: not its gesture any more -> ignored
    expect(h.inGesture).toBe(true);
    h.update((c = paint(c, 5, 2)));
    h.endGesture('tools');
    expect(h.inGesture).toBe(false);
    expect(h.undoDepth).toBe(2); // typing + one drag
    expect(h.undo()?.name).toBe('A');
    expect(h.undo()).toBe(base);
  });

  it('the field keeps focus through the drag: later keystrokes coalesce into a new inspector gesture', () => {
    const h = new History(base);
    h.beginGesture('inspector');
    h.update(rename(base, 'A'));
    h.beginGesture('tools');
    h.update(paint(h.current, 1, 1));
    h.update(paint(h.current, 2, 1));
    h.endGesture('tools');
    expect(h.undoDepth).toBe(2);
    // Every keystroke re-opens the inspector gesture (idempotent while it is held); the blur closes it.
    h.beginGesture('inspector'); h.update(rename(h.current, 'AB'));
    h.beginGesture('inspector'); h.update(rename(h.current, 'ABC'));
    h.endGesture('inspector');
    expect(h.undoDepth).toBe(3);
    expect(h.undo()?.name).toBe('A');
  });

  it('endGesture without an owner means the tools, and a non-matching owner is a no-op', () => {
    const h = new History(base);
    h.beginGesture('inspector');
    h.update(rename(base, 'X'));
    h.endGesture(); // tools by default
    expect(h.inGesture).toBe(true);
    h.endGesture('inspector');
    expect(h.inGesture).toBe(false);
    expect(h.undoDepth).toBe(1);
    h.reset(base);
    expect(h.gestureOwner).toBeNull();
  });
});
