import { afterEach, describe, expect, it } from 'vitest';
import * as C from '../constants';
import { SIM_TUNING_DEFAULTS, SIM_TUNING_KEYS, isSimTuningDefault, resetSimTuning, setSimTuning, simTuning } from './tuning';
import type { SimTuning } from './tuning';

afterEach(() => resetSimTuning());

describe('simTuning', () => {
  it('defaults are copied from constants.ts for every key and frozen', () => {
    expect(SIM_TUNING_KEYS.length).toBe(39);
    expect(new Set(SIM_TUNING_KEYS).size).toBe(SIM_TUNING_KEYS.length);
    for (const k of SIM_TUNING_KEYS) {
      expect(SIM_TUNING_DEFAULTS[k], k).toBe(C[k]);
      expect(simTuning[k], k).toBe(C[k]);
      expect(Number.isFinite(simTuning[k]), k).toBe(true);
    }
    expect(Object.isFrozen(SIM_TUNING_DEFAULTS)).toBe(true);
    expect(() => {
      (SIM_TUNING_DEFAULTS as SimTuning).MAX_PULL_PX = 1;
    }).toThrow();
    expect(Object.isFrozen(simTuning)).toBe(false);
    expect(isSimTuningDefault()).toBe(true);
  });

  it('setSimTuning applies finite numbers, ignores unknown keys and non-finite values', () => {
    setSimTuning({ MAX_PULL_PX: 200, FRICTION_GRASS: 0 });
    expect(simTuning.MAX_PULL_PX).toBe(200);
    expect(simTuning.FRICTION_GRASS).toBe(0);
    expect(isSimTuningDefault()).toBe(false);
    const garbage = { MAX_PULL_PX: NaN, POWER_SCALE: Infinity, STOP_SPEED: '7', BOGUS: 5 } as unknown as Partial<SimTuning>;
    setSimTuning(garbage);
    expect(simTuning.MAX_PULL_PX).toBe(200);
    expect(simTuning.POWER_SCALE).toBe(C.POWER_SCALE);
    expect(simTuning.STOP_SPEED).toBe(C.STOP_SPEED);
    expect('BOGUS' in simTuning).toBe(false);
    setSimTuning({});
    expect(simTuning.MAX_PULL_PX).toBe(200);
  });

  it('resetSimTuning restores every default and SIM_TUNING_DEFAULTS is unaffected by tuning', () => {
    for (const k of SIM_TUNING_KEYS) setSimTuning({ [k]: C[k] + 1 } as Partial<SimTuning>);
    expect(isSimTuningDefault()).toBe(false);
    for (const k of SIM_TUNING_KEYS) expect(SIM_TUNING_DEFAULTS[k]).toBe(C[k]);
    resetSimTuning();
    expect(isSimTuningDefault()).toBe(true);
    for (const k of SIM_TUNING_KEYS) expect(simTuning[k]).toBe(C[k]);
  });
});
