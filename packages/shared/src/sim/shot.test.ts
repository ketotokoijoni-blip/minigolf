import { afterEach, describe, expect, it } from 'vitest';
import { MAX_PULL_PX, MIN_PULL_PX, SHOT_QUANTUM } from '../constants';
import { isNullShot, quantizeShot, validateShot } from './shot';
import { resetSimTuning, setSimTuning } from './tuning';

const MIN_UNITS = MIN_PULL_PX * SHOT_QUANTUM; // 300
const MAX_UNITS = MAX_PULL_PX * SHOT_QUANTUM; // 12000

afterEach(() => resetSimTuning());

describe('quantizeShot', () => {
  it('scales by SHOT_QUANTUM and rounds to integers', () => {
    expect(quantizeShot(10, 0)).toEqual({ dx: 1000, dy: 0 });
    expect(quantizeShot(0, -42.5)).toEqual({ dx: 0, dy: -4250 });
    expect(quantizeShot(-10.004, 5.006)).toEqual({ dx: -1000, dy: 501 });
    expect(quantizeShot(33.333, 66.666)).toEqual({ dx: 3333, dy: 6667 });
  });

  it('returns the null shot inside the dead zone (|pull| < MIN_PULL_PX)', () => {
    expect(quantizeShot(0, 0)).toEqual({ dx: 0, dy: 0 });
    expect(quantizeShot(MIN_PULL_PX - 0.01, 0)).toEqual({ dx: 0, dy: 0 });
    expect(quantizeShot(0, -(MIN_PULL_PX - 0.01))).toEqual({ dx: 0, dy: 0 });
    expect(isNullShot(quantizeShot(1, 1))).toBe(true);
    expect(quantizeShot(MIN_PULL_PX, 0)).toEqual({ dx: MIN_UNITS, dy: 0 });
  });

  it('clamps |pull| to MAX_PULL_PX, keeping the direction', () => {
    expect(quantizeShot(1000, 0)).toEqual({ dx: MAX_UNITS, dy: 0 });
    expect(quantizeShot(0, -MAX_PULL_PX - 50)).toEqual({ dx: 0, dy: -MAX_UNITS });
    const d = quantizeShot(300, -300);
    expect(d.dx).toBe(-d.dy);
    expect(d.dx).toBeGreaterThan(0);
    expect(Math.abs(Math.sqrt(d.dx * d.dx + d.dy * d.dy) - MAX_UNITS)).toBeLessThanOrEqual(1);
    const e = quantizeShot(MAX_PULL_PX, 0);
    expect(e).toEqual({ dx: MAX_UNITS, dy: 0 }); // exactly at the cap is not scaled
  });

  it('never produces -0, NaN or Infinity', () => {
    const z = quantizeShot(-0.001, 50);
    expect(Object.is(z.dx, 0)).toBe(true);
    expect(Object.is(z.dy, 5000)).toBe(true);
    expect(quantizeShot(NaN, 10)).toEqual({ dx: 0, dy: 0 });
    expect(quantizeShot(Infinity, 10)).toEqual({ dx: 0, dy: 0 });
    expect(quantizeShot(10, -Infinity)).toEqual({ dx: 0, dy: 0 });
  });

  it('every non-null result passes validateShot, including the dead-zone boundary', () => {
    const dirs: [number, number][] = [[1, 0], [0, 1], [-1, 0], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1], [3, -4], [-5, 12], [7, 24], [1, 100], [100, 1], [2, 3]];
    const radii = [MIN_PULL_PX, MIN_PULL_PX + 0.005, 3.1, 5, 17.3, 60, 119.99, MAX_PULL_PX, 121, 500];
    let nonNull = 0;
    for (const [ux, uy] of dirs) {
      const l = Math.sqrt(ux * ux + uy * uy);
      for (const r of radii) {
        const s = quantizeShot((ux / l) * r, (uy / l) * r);
        if (isNullShot(s)) continue;
        nonNull++;
        expect(validateShot(s), `dir (${ux},${uy}) r=${r} -> ${JSON.stringify(s)}`).toBe(true);
      }
    }
    expect(nonNull).toBeGreaterThan(dirs.length * (radii.length - 2));
    // a diagonal pull of exactly MIN_PULL_PX rounds below 300 units: it is reported as the null shot, not as an invalid one
    const k = MIN_PULL_PX / Math.sqrt(2);
    expect(quantizeShot(k, k)).toEqual({ dx: 0, dy: 0 });
    expect(isNullShot(quantizeShot(k + 0.01, k + 0.01))).toBe(false);
  });

  it('follows simTuning.MAX_PULL_PX and MIN_PULL_PX (dev panel), restored by resetSimTuning', () => {
    setSimTuning({ MAX_PULL_PX: 60, MIN_PULL_PX: 10 });
    expect(quantizeShot(100, 0)).toEqual({ dx: 6000, dy: 0 });
    expect(quantizeShot(9, 0)).toEqual({ dx: 0, dy: 0 });
    expect(quantizeShot(10, 0)).toEqual({ dx: 1000, dy: 0 });
    resetSimTuning();
    expect(quantizeShot(100, 0)).toEqual({ dx: 10000, dy: 0 });
    expect(quantizeShot(9, 0)).toEqual({ dx: 900, dy: 0 });
  });
});

describe('validateShot', () => {
  it('accepts integer vectors with MIN <= |s| <= MAX + 1', () => {
    expect(validateShot({ dx: MIN_UNITS, dy: 0 })).toBe(true);
    expect(validateShot({ dx: 0, dy: -MIN_UNITS })).toBe(true);
    expect(validateShot({ dx: 180, dy: -240 })).toBe(true); // exactly 300
    expect(validateShot({ dx: MAX_UNITS, dy: 0 })).toBe(true);
    expect(validateShot({ dx: MAX_UNITS + 1, dy: 0 })).toBe(true); // rounding tolerance
    expect(validateShot({ dx: -8485, dy: 8485 })).toBe(true);
    expect(validateShot({ dx: 300, dy: 0, extra: 1 })).toBe(true); // extra keys ignored
  });

  it('rejects the null shot, out-of-range, non-integers and garbage', () => {
    expect(validateShot({ dx: 0, dy: 0 })).toBe(false);
    expect(validateShot({ dx: MIN_UNITS - 1, dy: 0 })).toBe(false);
    expect(validateShot({ dx: 212, dy: 212 })).toBe(false); // 299.8
    expect(validateShot({ dx: MAX_UNITS + 2, dy: 0 })).toBe(false);
    expect(validateShot({ dx: 8486, dy: 8486 })).toBe(false);
    expect(validateShot({ dx: 1000.5, dy: 0 })).toBe(false);
    expect(validateShot({ dx: NaN, dy: 0 })).toBe(false);
    expect(validateShot({ dx: Infinity, dy: 0 })).toBe(false);
    expect(validateShot({ dx: 1e300, dy: 0 })).toBe(false);
    expect(validateShot({ dx: -0, dy: 300 })).toBe(false); // -0 survives JSON.parse but not JSON.stringify: not replayable
    expect(validateShot({ dx: 300, dy: -0 })).toBe(false);
    expect(validateShot(JSON.parse('{"dx":-0,"dy":300}'))).toBe(false);
    expect(validateShot({ dx: 300, dy: 0 })).toBe(true); // +0 stays valid
    expect(validateShot({ dx: '1000', dy: 0 })).toBe(false);
    expect(validateShot({ dx: 1000 })).toBe(false);
    expect(validateShot({ dy: 1000 })).toBe(false);
    expect(validateShot({ dx: 1000n, dy: 0 })).toBe(false);
    expect(validateShot(null)).toBe(false);
    expect(validateShot(undefined)).toBe(false);
    expect(validateShot('shot')).toBe(false);
    expect(validateShot(1000)).toBe(false);
    expect(validateShot([1000, 0])).toBe(false);
    expect(validateShot({})).toBe(false);
  });

  it('ignores simTuning (the server validates against the fixed constants)', () => {
    setSimTuning({ MAX_PULL_PX: 10, MIN_PULL_PX: 50 });
    expect(validateShot({ dx: MAX_UNITS, dy: 0 })).toBe(true);
    expect(validateShot({ dx: MIN_UNITS, dy: 0 })).toBe(true);
    expect(validateShot({ dx: 2000, dy: 0 })).toBe(true);
  });

  it('isNullShot', () => {
    expect(isNullShot({ dx: 0, dy: 0 })).toBe(true);
    expect(isNullShot({ dx: 0, dy: 1 })).toBe(false);
    expect(isNullShot({ dx: -1, dy: 0 })).toBe(false);
  });
});
