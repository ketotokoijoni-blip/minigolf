// Dev-panel dictionaries (WP-K): same key set in both languages, namespaced, no empty strings, matching
// placeholders, and a description for every tunable that gets a slider (and none for the R3-excluded keys).
import { describe, expect, it } from 'vitest';
import { SIM_TUNING_KEYS } from '@puttipeli/shared/sim/tuning';
import { enDev } from './en.dev';
import { fiDev } from './fi.dev';
import { setLanguage, t } from './t';

describe('dev dictionaries', () => {
  it('fi and en have the same keys', () => {
    expect(Object.keys(enDev).sort()).toEqual(Object.keys(fiDev).sort());
  });

  it('no empty strings and every key is namespaced dev.', () => {
    for (const d of [fiDev, enDev]) {
      for (const [k, v] of Object.entries(d)) {
        expect(v, k).not.toBe('');
        expect(k.startsWith('dev.'), k).toBe(true);
      }
    }
  });

  it('placeholders match between languages', () => {
    const params = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    for (const k of Object.keys(fiDev)) expect(params(enDev[k]!), k).toEqual(params(fiDev[k]!));
  });

  it('describes every tunable except the R3-excluded pull cap/dead zone and the R20-excluded magnet limits', () => {
    const excluded = ['MAX_PULL_PX', 'MIN_PULL_PX', 'MAGNET_MIN_STRENGTH', 'MAGNET_MAX_STRENGTH', 'MAGNET_MIN_RADIUS', 'MAGNET_MAX_RADIUS'];
    for (const k of SIM_TUNING_KEYS) {
      if (excluded.includes(k)) {
        expect(fiDev[`dev.key.${k}`], k).toBeUndefined();
        continue;
      }
      expect(fiDev[`dev.key.${k}`], k).toBeTypeOf('string');
      expect(enDev[`dev.key.${k}`], k).toBeTypeOf('string');
    }
    for (const g of ['shot', 'collision', 'surfaces', 'objects']) expect(fiDev[`dev.group.${g}`], g).toBeTypeOf('string');
  });

  it('registers at import and interpolates', () => {
    setLanguage('fi');
    expect(t('dev.changed', { count: 3 })).toBe('3 arvoa muutettu');
    setLanguage('en');
    expect(t('dev.changed', { count: 3 })).toBe('3 values changed');
    setLanguage('fi');
  });
});
