// Editor dictionaries: same key set in both languages, no empty strings, matching placeholders, a name per code.
import { describe, expect, it } from 'vitest';
import { Surface, WallShape } from '@puttipeli/shared/course/types';
import { fiEditor } from './fi.editor';
import { enEditor } from './en.editor';
import { t, setLanguage } from './t';

describe('editor dictionaries', () => {
  it('fi and en have the same keys', () => {
    expect(Object.keys(enEditor).sort()).toEqual(Object.keys(fiEditor).sort());
  });

  it('no empty strings and every key is namespaced', () => {
    for (const d of [fiEditor, enEditor]) {
      for (const [k, v] of Object.entries(d)) {
        expect(v, k).not.toBe('');
        expect(k.startsWith('editor.') || k.startsWith('validation.'), k).toBe(true);
      }
    }
  });

  it('placeholders match between languages', () => {
    const params = (s: string): string[] => [...s.matchAll(/\{(\w+)\}/g)].map((m) => m[1]!).sort();
    for (const k of Object.keys(fiEditor)) expect(params(enEditor[k]!), k).toEqual(params(fiEditor[k]!));
  });

  it('names every surface and wall code and every object type', () => {
    for (const s of Object.values(Surface)) expect(fiEditor[`editor.surface.${s}`], `surface ${s}`).toBeTypeOf('string');
    for (const w of Object.values(WallShape)) expect(fiEditor[`editor.wall.${w}`], `wall ${w}`).toBeTypeOf('string');
    for (const o of ['start', 'hole', 'teleport', 'magnet', 'mine', 'erase', 'none']) expect(fiEditor[`editor.object.${o}`], o).toBeTypeOf('string');
    for (const tool of ['brush', 'rect', 'fill', 'line', 'eraser', 'picker', 'inspect']) {
      expect(fiEditor[`editor.tool.${tool}`], tool).toBeTypeOf('string');
      expect(fiEditor[`editor.tool.${tool}.hint`], tool).toBeTypeOf('string');
    }
  });

  it('registers at import and interpolates', () => {
    setLanguage('fi');
    expect(t('editor.toast.objectRemoved', { count: 2 })).toBe('Maalaus poisti 2 kohdetta.');
    setLanguage('en');
    expect(t('editor.tab.walls')).toBe('Walls');
    setLanguage('fi');
  });
});
