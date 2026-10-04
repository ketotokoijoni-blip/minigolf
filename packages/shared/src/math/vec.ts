// Vec2 helpers for the sim and the client. Only + - * / and Math.sqrt (determinism rules, DESIGN §9).
import type { Vec2 } from '../course/types';

/** Euclidean length: Math.sqrt(x*x + y*y). */
export function len(x: number, y: number): number {
  return Math.sqrt(x * x + y * y);
}

export function dot(ax: number, ay: number, bx: number, by: number): number {
  return ax * bx + ay * by;
}

/** Unit vector of (x, y). Returns {x:0,y:0} when len < eps (D16: every unit-vector computation guards d == 0); NaN input also yields zero. */
export function unitOrZero(x: number, y: number, eps = 1e-9): Vec2 {
  const l = len(x, y);
  if (!(l >= eps)) return { x: 0, y: 0 };
  return { x: x / l, y: y / l };
}

/** (x, y) scaled down to length `max` when it is longer; returned unchanged (as a new object) otherwise. */
export function clampLen(x: number, y: number, max: number): Vec2 {
  const l = len(x, y);
  if (l > max && l > 0) {
    const k = max / l;
    return { x: x * k, y: y * k };
  }
  return { x, y };
}
