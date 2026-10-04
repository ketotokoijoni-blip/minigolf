// #/dev pure helpers (WP-K): R3 exclusion, slider specs, value normalisation, the constants.ts snippet and the
// route registration side effect. No DOM.
import { afterEach, describe, expect, it } from 'vitest';
import * as C from '@puttipeli/shared/constants';
import { SIM_TUNING_DEFAULTS, SIM_TUNING_KEYS, resetSimTuning, setSimTuning, simTuning } from '@puttipeli/shared/sim/tuning';
import { getScreenRegistry } from '../app/screen';
import {
  DEV_TUNING_KEYS, EXCLUDED_TUNING_KEYS, SLIDER_SPECS, TUNING_GROUPS,
  changedKeys, decimalsOf, formatValue, keysOfGroup, normalizeValue, tuningSnippet,
} from './dev.screen';

afterEach(() => resetSimTuning());

describe('#/dev tuning keys', () => {
  it('excludes exactly MAX_PULL_PX and MIN_PULL_PX (R3) and keeps every other SIM_TUNING_KEYS entry in order', () => {
    expect(EXCLUDED_TUNING_KEYS).toEqual(['MAX_PULL_PX', 'MIN_PULL_PX']);
    expect(DEV_TUNING_KEYS).not.toContain('MAX_PULL_PX');
    expect(DEV_TUNING_KEYS).not.toContain('MIN_PULL_PX');
    expect(DEV_TUNING_KEYS).toEqual(SIM_TUNING_KEYS.filter((k) => k !== 'MAX_PULL_PX' && k !== 'MIN_PULL_PX'));
    expect(DEV_TUNING_KEYS.length).toBe(SIM_TUNING_KEYS.length - 2);
  });

  it('has a slider spec for every key whose range contains the constants.ts default', () => {
    for (const k of DEV_TUNING_KEYS) {
      const spec = SLIDER_SPECS[k];
      expect(spec, k).toBeDefined();
      expect(spec.step, k).toBeGreaterThan(0);
      expect(spec.min, k).toBeLessThan(spec.max);
      expect(SIM_TUNING_DEFAULTS[k], k).toBeGreaterThanOrEqual(spec.min);
      expect(SIM_TUNING_DEFAULTS[k], k).toBeLessThanOrEqual(spec.max);
      expect(SIM_TUNING_DEFAULTS[k], k).toBe((C as Record<string, unknown>)[k]);
      expect(TUNING_GROUPS, k).toContain(spec.group);
      // the default sits on the step grid, so the slider can show it exactly
      expect(normalizeValue(k, SIM_TUNING_DEFAULTS[k]), k).toBe(SIM_TUNING_DEFAULTS[k]);
    }
    expect(Object.keys(SLIDER_SPECS).sort()).toEqual([...DEV_TUNING_KEYS].sort());
  });

  it('every group is non-empty and the groups partition the keys', () => {
    const all = TUNING_GROUPS.flatMap((g) => keysOfGroup(g));
    expect(all.length).toBe(DEV_TUNING_KEYS.length);
    expect(new Set(all).size).toBe(DEV_TUNING_KEYS.length);
    for (const g of TUNING_GROUPS) expect(keysOfGroup(g).length, g).toBeGreaterThan(0);
    expect(SLIDER_SPECS.MAX_SPEED.max, 'D4: above 900 px/s a substep exceeds the ball radius').toBeLessThanOrEqual(900);
  });
});

describe('#/dev value helpers', () => {
  it('decimalsOf follows the step', () => {
    expect(decimalsOf(10)).toBe(0);
    expect(decimalsOf(1)).toBe(0);
    expect(decimalsOf(0.5)).toBe(1);
    expect(decimalsOf(0.05)).toBe(2);
    expect(decimalsOf(0.005)).toBe(3);
  });

  it('normalizeValue clamps, rounds to the step grid and falls back to the default for garbage', () => {
    expect(normalizeValue('FRICTION_GRASS', 10_000)).toBe(SLIDER_SPECS.FRICTION_GRASS.max);
    expect(normalizeValue('FRICTION_GRASS', -5)).toBe(SLIDER_SPECS.FRICTION_GRASS.min);
    expect(normalizeValue('RESTITUTION_WALL', 0.78449)).toBe(0.78);
    expect(normalizeValue('POWER_SCALE', NaN)).toBe(C.POWER_SCALE);
    expect(normalizeValue('POWER_SCALE', Infinity)).toBe(C.POWER_SCALE);
    // Steps coarser than one decimal place must snap too, or the number box and the range thumb disagree.
    expect(normalizeValue('FRICTION_GRASS', 203)).toBe(200);
    expect(normalizeValue('FRICTION_GRASS', 206)).toBe(210);
    expect(normalizeValue('FRICTION_SAND', 1234)).toBe(1250);
    expect(normalizeValue('HOLE_CAPTURE_RADIUS', 6.3)).toBe(6.25);
    expect(normalizeValue('HOLE_PULL_ACCEL', 1012)).toBe(1000);
    expect(normalizeValue('FORCED_STOP_TICKS', 100)).toBe(102); // grid is min 6 + n * 6
    expect(normalizeValue('STOP_SPEED', 7.3)).toBe(7.5);
  });

  it('normalizeValue always lands on the range input grid (min + n * step) for every key', () => {
    for (const k of DEV_TUNING_KEYS) {
      const spec = SLIDER_SPECS[k];
      for (const frac of [0, 0.137, 0.5, 0.731, 1]) {
        const v = normalizeValue(k, spec.min + frac * (spec.max - spec.min));
        const n = (v - spec.min) / spec.step;
        expect(Math.abs(n - Math.round(n)), `${k} ${v}`).toBeLessThan(1e-6);
        expect(v, k).toBeGreaterThanOrEqual(spec.min);
        expect(v, k).toBeLessThanOrEqual(spec.max);
      }
    }
  });

  it('formatValue prints short decimals', () => {
    expect(formatValue('POWER_SCALE', 5.5)).toBe('5.5');
    expect(formatValue('FRICTION_GRASS', 200)).toBe('200');
    expect(formatValue('PENETRATION_SLOP', 0.01)).toBe('0.01');
  });

  it('changedKeys reflects the live simTuning object', () => {
    expect(changedKeys()).toEqual([]);
    setSimTuning({ FRICTION_ICE: 60, HOLE_CAPTURE_RADIUS: 7 });
    expect(changedKeys()).toEqual(['FRICTION_ICE', 'HOLE_CAPTURE_RADIUS']);
    expect(simTuning.FRICTION_ICE).toBe(60);
    resetSimTuning();
    expect(changedKeys()).toEqual([]);
  });
});

describe('#/dev constants.ts snippet', () => {
  it('lists every slider key once as an export const line, in constants.ts order, with no R3 keys', () => {
    const text = tuningSnippet();
    const lines = text.split('\n').filter((l) => l.startsWith('export const '));
    expect(lines.map((l) => l.split(' ')[2])).toEqual([...DEV_TUNING_KEYS]);
    expect(text).not.toContain('MAX_PULL_PX');
    expect(text).not.toContain('MIN_PULL_PX');
    expect(text.startsWith('// Puttipeli #/dev tuning snippet: 0 of')).toBe(true);
    for (const k of DEV_TUNING_KEYS) expect(text).toContain(`export const ${k} = ${formatValue(k, SIM_TUNING_DEFAULTS[k])};`);
    expect(text).not.toContain('// was');
  });

  it('marks changed values with the previous default', () => {
    setSimTuning({ FRICTION_GRASS: 250, RESTITUTION_BUMPER: 1.6 });
    const text = tuningSnippet();
    expect(text).toContain('export const FRICTION_GRASS = 250; // was 200');
    expect(text).toContain('export const RESTITUTION_BUMPER = 1.6; // was 1.4');
    expect(text).toContain('export const FRICTION_SAND = 1100;\n');
    expect(text.startsWith('// Puttipeli #/dev tuning snippet: 2 of')).toBe(true);
  });

  it('is valid TypeScript-ish: every value parses back to the same number', () => {
    setSimTuning({ PENETRATION_SLOP: 0.015, HOLE_CAPTURE_RADIUS: 6.25 });
    for (const line of tuningSnippet().split('\n')) {
      const m = /^export const (\w+) = ([-\d.]+);/.exec(line);
      if (!m) continue;
      expect(Number(m[2]), line).toBe(simTuning[m[1] as keyof typeof simTuning]);
    }
  });
});

describe('#/dev registration', () => {
  it('registers the #/dev route at import like every other *.screen.ts', () => {
    expect(getScreenRegistry().has('#/dev')).toBe(true);
  });
});
