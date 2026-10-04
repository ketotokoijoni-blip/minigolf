// The help legend must cover every surface code, every wall shape and every object type, and every entry must
// have both legend strings (DESIGN §12.1 #/help: "tile legend rendered by tileArt"). Pure logic, no DOM (D24).
import { describe, expect, it } from 'vitest';
import { Surface, WallShape } from '@puttipeli/shared/course/types';
import { ALL_SURFACES, ALL_WALLS } from '../render/tileArt';
import { LEGEND_ITEMS } from './help.screen';
import { fi } from '../i18n/fi';
import { en } from '../i18n/en';

describe('help legend', () => {
  it('covers every surface code', () => {
    const covered = new Set(LEGEND_ITEMS.flatMap((i) => i.tiles.map((tile) => tile.surface ?? Surface.Grass)));
    for (const code of ALL_SURFACES) expect(covered.has(code), `surface ${code}`).toBe(true);
  });

  it('covers every wall shape', () => {
    const covered = new Set(LEGEND_ITEMS.flatMap((i) => i.tiles.map((tile) => tile.wall)).filter((w): w is number => w !== undefined));
    for (const code of ALL_WALLS) expect(covered.has(code), `wall ${code}`).toBe(true);
    expect(covered.has(WallShape.None)).toBe(false);
  });

  it('covers every object type, both magnet polarities and two teleport colours', () => {
    const objects = LEGEND_ITEMS.flatMap((i) => i.tiles.map((tile) => tile.object)).filter((o) => o !== undefined);
    const types = new Set(objects.map((o) => o.type));
    for (const type of ['start', 'hole', 'teleport', 'magnet', 'mine']) expect(types.has(type as never), type).toBe(true);
    const polarities = new Set(objects.filter((o) => o.type === 'magnet').map((o) => (o as { polarity: number }).polarity));
    expect(polarities).toEqual(new Set([1, -1]));
    const groups = new Set(objects.filter((o) => o.type === 'teleport').map((o) => (o as { group: number }).group));
    expect(groups.size).toBeGreaterThanOrEqual(2);
    // Every magnet sits on a full block, as validation requires.
    for (const item of LEGEND_ITEMS) for (const tile of item.tiles) if (tile.object?.type === 'magnet') expect(tile.wall).toBe(WallShape.Full);
  });

  it('parameterises the tuning numbers in the controls and rules text instead of hardcoding them', () => {
    for (const dict of [fi, en]) {
      expect(dict['help.controls.mouse.aim']).toContain('{pull}');
      expect(dict['help.controls.mouse.aim']).not.toMatch(/\b120\b/);
      expect(dict['help.rules.maxStrokes']).toContain('{max}');
    }
  });

  it('has a name and a description string for every item in both languages', () => {
    const keys = LEGEND_ITEMS.map((i) => i.key);
    expect(new Set(keys).size).toBe(keys.length);
    for (const key of keys) {
      for (const dict of [fi, en]) {
        expect(dict[`legend.${key}`], key).toBeTypeOf('string');
        expect(dict[`legend.${key}.desc`], key).toBeTypeOf('string');
      }
    }
  });
});
