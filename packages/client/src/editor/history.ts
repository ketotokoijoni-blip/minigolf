// Undo/redo history over immutable Course snapshots (DESIGN §13.3): up to 200 entries, one entry per drag gesture.
// Every edit op returns a new Course (~3 KB), so snapshots are simply kept by reference.
import { canonicalCourseJson } from '@puttipeli/shared/course/canonical';
import type { Course } from '@puttipeli/shared/course/types';

export const HISTORY_LIMIT = 200;

/**
 * Who opened the gesture. The tools (pointer drag) and the inspector (focused text field / slider) both coalesce
 * their edits, and their lifetimes overlap in a very common flow: name the course, then paint while the input still
 * has focus. Opening a gesture for another owner closes the previous one first, and endGesture() from an owner that
 * no longer holds the gesture is ignored, so a drag is always exactly one entry.
 */
export type GestureOwner = 'tools' | 'inspector';

/**
 * True when two courses differ in content. The id is a content hash for every custom course, so differing ids mean
 * different content; equal ids are confirmed with the canonical JSON (cheap: ~3 KB string compare, once per commit).
 */
export function coursesDiffer(a: Course, b: Course): boolean {
  if (a === b) return false;
  if (a.id !== b.id) return true;
  return canonicalCourseJson(a) !== canonicalCourseJson(b);
}

export class History {
  private past: Course[] = [];
  private future: Course[] = [];
  private present: Course;
  /** Snapshot taken at beginGesture(); null when no gesture is open. */
  private gestureBase: Course | null = null;
  private owner: GestureOwner | null = null;

  constructor(initial: Course, readonly limit: number = HISTORY_LIMIT) {
    this.present = initial;
  }

  get current(): Course { return this.present; }
  get inGesture(): boolean { return this.gestureBase !== null; }
  /** Owner of the open gesture; null when none is open. */
  get gestureOwner(): GestureOwner | null { return this.owner; }
  /** Undo/redo are unavailable while a gesture is open (the pointer is still painting). */
  get canUndo(): boolean { return this.gestureBase === null && this.past.length > 0; }
  get canRedo(): boolean { return this.gestureBase === null && this.future.length > 0; }
  get undoDepth(): number { return this.past.length; }
  get redoDepth(): number { return this.future.length; }

  /**
   * Opens a gesture: every update() until endGesture(owner) is folded into a single history entry. Idempotent for
   * the same owner; a gesture held by another owner is ended (and recorded) first.
   */
  beginGesture(owner: GestureOwner = 'tools'): void {
    if (this.gestureBase !== null) {
      if (this.owner === owner) return;
      this.endGesture(this.owner ?? undefined);
    }
    this.gestureBase = this.present;
    this.owner = owner;
  }

  /** Replaces the working course. Inside a gesture no entry is created; outside it behaves like commit(). */
  update(course: Course): void {
    if (this.gestureBase === null) {
      this.commit(course);
      return;
    }
    this.present = course;
  }

  /**
   * Closes the gesture and records one entry if the course changed since beginGesture(). A call from an owner that
   * does not hold the gesture (it was taken over by the other owner) is a no-op.
   */
  endGesture(owner: GestureOwner = 'tools'): void {
    const base = this.gestureBase;
    if (base === null || this.owner !== owner) return;
    this.gestureBase = null;
    this.owner = null;
    const result = this.present;
    this.present = base;
    this.commit(result);
  }

  /** Records one entry (no entry when the content is unchanged). Inside a gesture it folds into the gesture. */
  commit(course: Course): void {
    if (this.gestureBase !== null) {
      this.present = course;
      return;
    }
    if (!coursesDiffer(this.present, course)) return;
    this.past.push(this.present);
    if (this.past.length > this.limit) this.past.splice(0, this.past.length - this.limit);
    this.present = course;
    this.future = [];
  }

  undo(): Course | null {
    if (!this.canUndo) return null;
    this.future.push(this.present);
    this.present = this.past.pop()!;
    return this.present;
  }

  redo(): Course | null {
    if (!this.canRedo) return null;
    this.past.push(this.present);
    this.present = this.future.pop()!;
    return this.present;
  }

  /** New document: drops the whole history. */
  reset(course: Course): void {
    this.past = [];
    this.future = [];
    this.gestureBase = null;
    this.owner = null;
    this.present = course;
  }
}
