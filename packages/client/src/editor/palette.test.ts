// Palette data (pure parts): every surface and wall code has an item and a Finnish/English name, templates follow
// the chip defaults, item matching ignores object properties.
import { describe, expect, it } from 'vitest';
import { MAGNET_DEFAULT_RADIUS, MAGNET_DEFAULT_STRENGTH } from '@puttipeli/shared/constants';
import { Surface, WallShape } from '@puttipeli/shared/course/types';
import { setLanguage } from '../i18n/t';
import '../i18n/fi.editor';
import '../i18n/en.editor';
import {
  INITIAL_OBJECT_DEFAULTS, OBJECT_ITEMS, SURFACE_ITEMS, WALL_ITEMS, itemMatches, itemSelection, objectTemplate, selectionName, surfaceName, wallName,
} from './palette';

describe('palette items', () => {
  it('cover every Surface and WallShape code exactly once', () => {
    expect([...SURFACE_ITEMS].sort((a, b) => a - b)).toEqual(Object.values(Surface).sort((a, b) => a - b));
    expect([...WALL_ITEMS].sort((a, b) => a - b)).toEqual(Object.values(WallShape).sort((a, b) => a - b));
    expect(WALL_ITEMS.at(-1)).toBe(WallShape.None); // "Poista seinä" last
    expect(OBJECT_ITEMS).toEqual(['start', 'hole', 'teleport', 'magnet', 'mine', 'erase']);
  });

  it('have a translated name in both languages', () => {
    for (const lang of ['fi', 'en'] as const) {
      setLanguage(lang);
      for (const s of SURFACE_ITEMS) expect(surfaceName(s)).not.toMatch(/^editor\./);
      for (const w of WALL_ITEMS) expect(wallName(w)).not.toMatch(/^editor\./);
    }
    setLanguage('fi');
    expect(surfaceName(Surface.Sand)).toBe('Hiekka');
    expect(wallName(WallShape.Bumper)).toBe('Pomppu');
  });
});

describe('object templates', () => {
  it('follow the defaults for teleports and magnets', () => {
    const d = { ...INITIAL_OBJECT_DEFAULTS, group: 5 as const, polarity: -1 as const };
    expect(objectTemplate('teleport', d)).toEqual({ type: 'teleport', x: 0, y: 0, group: 5 });
    expect(objectTemplate('magnet', d)).toEqual({ type: 'magnet', x: 0, y: 0, polarity: -1, strength: MAGNET_DEFAULT_STRENGTH, radius: MAGNET_DEFAULT_RADIUS });
    expect(objectTemplate('hole', d)).toEqual({ type: 'hole', x: 0, y: 0 });
    expect(itemSelection('erase', d)).toEqual({ kind: 'eraseObject' });
  });

  it('itemMatches compares layer values and object types only', () => {
    expect(itemMatches({ kind: 'surface', value: Surface.Ice }, { kind: 'surface', value: Surface.Ice })).toBe(true);
    expect(itemMatches({ kind: 'surface', value: Surface.Ice }, { kind: 'surface', value: Surface.Tar })).toBe(false);
    expect(itemMatches({ kind: 'walls', value: WallShape.None }, { kind: 'surface', value: Surface.Grass })).toBe(false);
    expect(itemMatches(
      { kind: 'object', template: { type: 'teleport', x: 0, y: 0, group: 0 } },
      { kind: 'object', template: { type: 'teleport', x: 0, y: 0, group: 7 } },
    )).toBe(true);
    expect(itemMatches({ kind: 'eraseObject' }, { kind: 'eraseObject' })).toBe(true);
  });

  it('selectionName shows teleport groups as 1..8', () => {
    setLanguage('fi');
    expect(selectionName({ kind: 'object', template: { type: 'teleport', x: 0, y: 0, group: 0 } })).toBe('Teleportti 1');
    expect(selectionName({ kind: 'walls', value: WallShape.None })).toBe('Poista seinä');
    expect(selectionName({ kind: 'eraseObject' })).toBe('Poista kohde');
  });
});
