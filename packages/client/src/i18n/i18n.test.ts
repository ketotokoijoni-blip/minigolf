import { describe, expect, it } from 'vitest';
import { fi } from './fi';
import { en } from './en';
import { t, setLanguage } from './t';

const VALIDATION_CODES = [
  'BAD_DIMENSIONS', 'BAD_CHAR', 'NO_START', 'MULTIPLE_STARTS', 'NO_HOLE', 'OBJECT_OUT_OF_BOUNDS', 'OBJECT_OVERLAP',
  'OBJECT_ON_WALL', 'MAGNET_NOT_ON_FULL', 'OBJECT_ON_HAZARD', 'TELEPORT_GROUP_SIZE', 'BAD_TELEPORT_GROUP', 'BAD_MAGNET',
  'BAD_RULES', 'BAD_NAME', 'BAD_AUTHOR', 'BAD_DESCRIPTION', 'TOO_LARGE',
  'UNREACHABLE_HOLE', 'HOLE_NEXT_TO_START', 'OPEN_BORDER', 'PAR_HIGH',
];

describe('core dictionaries', () => {
  it('fi and en have the same keys', () => {
    const fiKeys = Object.keys(fi).sort();
    const enKeys = Object.keys(en).sort();
    expect(enKeys).toEqual(fiKeys);
  });

  it('no empty strings', () => {
    for (const d of [fi, en]) for (const [k, v] of Object.entries(d)) expect(v, k).not.toBe('');
  });

  it('covers every validation code of DESIGN §7.5', () => {
    for (const code of VALIDATION_CODES) {
      expect(fi[`validation.${code}`], code).toBeTypeOf('string');
      expect(en[`validation.${code}`], code).toBeTypeOf('string');
    }
  });

  it('placeholders match between languages', () => {
    const params = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    for (const k of Object.keys(fi)) expect(params(en[k]!), k).toEqual(params(fi[k]!));
  });

  it('colour names match the canvas palette (render/palette.ts)', async () => {
    const { PLAYER_COLOUR_NAMES_FI, PLAYER_COLOURS } = await import('../render/palette');
    expect(PLAYER_COLOURS).toHaveLength(4);
    PLAYER_COLOUR_NAMES_FI.forEach((name, i) => expect(fi[`colour.${i}`], `colour.${i}`).toBe(name));
  });

  it('t() falls back to Finnish and interpolates', () => {
    setLanguage('en');
    expect(t('menu.multi.caption.online', { players: 3, rooms: 1 })).toBe('Players online: 3 · Rooms: 1');
    setLanguage('fi');
    expect(t('validation.TELEPORT_GROUP_SIZE', { group: 2, count: 3 })).toBe('Teleporttiryhmässä 2 on 3 laattaa – pitää olla tasan 2');
    expect(t('does.not.exist')).toBe('does.not.exist');
  });
});
