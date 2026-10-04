import { describe, expect, it } from 'vitest';
import { generateSessionToken, pickColour, pickHost, sanitizeChatText, sanitizeName, tokensEqual, uniqueName } from './session';

describe('session tokens', () => {
  it('are 32 hex chars and unique', () => {
    const a = generateSessionToken();
    const b = generateSessionToken();
    expect(a).toMatch(/^[0-9a-f]{32}$/);
    expect(a).not.toBe(b);
  });
  it('compare in constant time without throwing on odd input', () => {
    const a = generateSessionToken();
    expect(tokensEqual(a, a)).toBe(true);
    expect(tokensEqual(a, a.slice(0, 31) + (a.endsWith('0') ? '1' : '0'))).toBe(false);
    expect(tokensEqual(a, a + 'x')).toBe(false);
    expect(tokensEqual(a, 42)).toBe(false);
    expect(tokensEqual(a, undefined)).toBe(false);
  });
});

describe('sanitation', () => {
  it('names: trim, strip controls, collapse whitespace, cut to 16, fallback', () => {
    expect(sanitizeName('  Matti   Meikä ')).toBe('Matti Meikä');
    expect(sanitizeName('Ma' + String.fromCharCode(7) + 'tti' + String.fromCharCode(0x200b))).toBe('Matti');
    expect(sanitizeName('A'.repeat(40))).toHaveLength(16);
    expect(sanitizeName('')).toBe('Pelaaja');
    expect(sanitizeName('   ' + String.fromCharCode(1))).toBe('Pelaaja');
  });
  it('chat text: cut to 200 chars, empty when nothing is left', () => {
    expect(sanitizeChatText('  hei   kaikki  ')).toBe('hei kaikki');
    expect(sanitizeChatText('x'.repeat(500))).toHaveLength(200);
    expect(sanitizeChatText(String.fromCharCode(27) + ' ')).toBe('');
  });
});

describe('pickColour', () => {
  it('keeps a free colour and falls back to the lowest free one', () => {
    expect(pickColour(2, [])).toBe(2);
    expect(pickColour(0, [0, 1])).toBe(2);
    expect(pickColour(3, [3, 0])).toBe(1);
    expect(pickColour(1, [0, 1, 2, 3])).toBe(1);
  });
});

describe('uniqueName', () => {
  it('appends the smallest free digit suffix and respects the length cap', () => {
    expect(uniqueName('Matti', ['Liisa'])).toBe('Matti');
    expect(uniqueName('Matti', ['matti'])).toBe('Matti2');
    expect(uniqueName('Matti', ['Matti', 'Matti2', 'Matti3'])).toBe('Matti4');
    const long = 'A'.repeat(16);
    const u = uniqueName(long, [long]);
    expect(u).toHaveLength(16);
    expect(u.endsWith('2')).toBe(true);
  });
});

describe('pickHost', () => {
  it('prefers connected, lowest joinedSeq; then any non-left player; else null', () => {
    const p = (id: string, joinedSeq: number, connected: boolean, leftRound = false) => ({ id, joinedSeq, connected, leftRound });
    expect(pickHost([p('a', 1, false), p('b', 2, true), p('c', 3, true)])).toBe('b');
    expect(pickHost([p('a', 1, false), p('b', 2, false)])).toBe('a');
    expect(pickHost([p('a', 1, false, true), p('b', 2, false)])).toBe('b');
    expect(pickHost([p('a', 1, true, true)])).toBeNull();
    expect(pickHost([])).toBeNull();
  });
});
