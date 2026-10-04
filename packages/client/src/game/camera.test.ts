// Pure-logic tests for the camera scale choice (DESIGN §12.2, R20): integer scale only when it keeps >= 80 % of the
// fractional fit, otherwise the fractional fit (so the field fills a 1280x800 window and stays whole on small screens).
import { describe, expect, it } from 'vitest';
import { INTEGER_SCALE_MIN_RATIO, LOGICAL_H, LOGICAL_W, chooseScale } from './camera';

describe('chooseScale', () => {
  it('uses the logical 765x405 canvas and the R20 ratio', () => {
    expect([LOGICAL_W, LOGICAL_H]).toEqual([765, 405]);
    expect(INTEGER_SCALE_MIN_RATIO).toBe(0.8);
  });

  it('returns exactly 1 for a container that fits the logical canvas', () => {
    expect(chooseScale(LOGICAL_W, LOGICAL_H)).toBe(1);
  });

  it('keeps the fractional fit in a 1280x800 window (R20: floor(1.67) = 1 < 0.8 * 1.67)', () => {
    const s = chooseScale(1280, 800);
    expect(s).toBeCloseTo(Math.min(1280 / LOGICAL_W, 800 / LOGICAL_H), 10);
    expect(s).toBeGreaterThan(1.6);
    expect(s).toBeLessThan(1.7);
    expect(Number.isInteger(s)).toBe(false);
  });

  it('snaps to the integer scale when it keeps at least 80 % of the fit (950x620 -> 1, 1700x900 -> 2)', () => {
    expect(chooseScale(950, 620)).toBe(1); // raw ~1.24, 1 >= 0.992
    expect(chooseScale(1700, 900)).toBe(2); // raw ~2.22, 2 >= 1.78
  });

  it('switches from integer to fractional exactly at the 80 % threshold', () => {
    const w = 1.25 * LOGICAL_W; // raw = 1.25 -> floor 1 == 0.8 * 1.25: integer still wins
    expect(chooseScale(w, 10_000)).toBe(1);
    expect(chooseScale(w + 1, 10_000)).toBeGreaterThan(1.25); // just over: fractional
  });

  it('keeps the whole field visible on small screens with a fractional scale below 1', () => {
    const s = chooseScale(400, 300);
    expect(s).toBeCloseTo(400 / LOGICAL_W, 10);
    expect(s).toBeLessThan(1);
    expect(LOGICAL_W * s).toBeLessThanOrEqual(400);
    expect(LOGICAL_H * s).toBeLessThanOrEqual(300);
  });

  it('limits by the tighter axis', () => {
    expect(chooseScale(10_000, LOGICAL_H * 3)).toBe(3);
    expect(chooseScale(LOGICAL_W * 3, 10_000)).toBe(3);
  });

  it('falls back to 1 for degenerate container sizes', () => {
    expect(chooseScale(0, 0)).toBe(1);
    expect(chooseScale(-10, 500)).toBe(1);
    expect(chooseScale(Number.NaN, 500)).toBe(1);
    expect(chooseScale(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY)).toBe(1);
  });
});
