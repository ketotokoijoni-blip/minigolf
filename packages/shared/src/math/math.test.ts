import { describe, expect, it } from 'vitest';
import { clampLen, dot, len, unitOrZero } from './vec';
import { fnv1a32, hex8 } from './hash';
import { xorshift32 } from './rng';

describe('vec', () => {
  it('len and dot', () => {
    expect(len(3, 4)).toBe(5);
    expect(len(0, 0)).toBe(0);
    expect(len(-6, 8)).toBe(10);
    expect(dot(1, 2, 3, 4)).toBe(11);
    expect(dot(1, 0, 0, 1)).toBe(0);
  });

  it('unitOrZero guards zero, tiny and NaN vectors (D16)', () => {
    expect(unitOrZero(0, 0)).toEqual({ x: 0, y: 0 });
    expect(unitOrZero(1e-12, -1e-12)).toEqual({ x: 0, y: 0 });
    expect(unitOrZero(1e-12, 0, 1e-15)).toEqual({ x: 1, y: 0 });
    expect(unitOrZero(NaN, 1)).toEqual({ x: 0, y: 0 });
    const u = unitOrZero(3, 4);
    expect(u.x).toBeCloseTo(0.6, 12);
    expect(u.y).toBeCloseTo(0.8, 12);
    expect(len(u.x, u.y)).toBeCloseTo(1, 12);
    expect(unitOrZero(0, -2)).toEqual({ x: 0, y: -1 });
  });

  it('clampLen scales only vectors longer than max', () => {
    expect(clampLen(3, 4, 10)).toEqual({ x: 3, y: 4 });
    expect(clampLen(3, 4, 5)).toEqual({ x: 3, y: 4 });
    expect(clampLen(0, 0, 10)).toEqual({ x: 0, y: 0 });
    const c = clampLen(30, 40, 5);
    expect(c.x).toBeCloseTo(3, 12);
    expect(c.y).toBeCloseTo(4, 12);
    expect(len(c.x, c.y)).toBeCloseTo(5, 12);
    expect(clampLen(-30, 40, 5).x).toBeCloseTo(-3, 12);
  });
});

describe('fnv1a32', () => {
  it('matches the reference FNV-1a 32-bit vectors', () => {
    expect(fnv1a32('')).toBe(0x811c9dc5);
    expect(fnv1a32('a')).toBe(0xe40c292c);
    expect(fnv1a32('foobar')).toBe(0xbf9cf968);
    expect(fnv1a32(new Uint8Array([0x61]))).toBe(0xe40c292c);
    expect(fnv1a32(new Uint8Array(0))).toBe(0x811c9dc5);
  });

  it('hashes strings as UTF-8, identical to TextEncoder (incl. multi-byte, 4-byte and lone surrogates)', () => {
    const enc = new TextEncoder();
    const samples = ['', 'abc', 'ääkköset', 'Puttipeli – rata', 'snowman ☃', '\u{1F600} emoji', 'a\ud800b', '\udc00', 'tail\ud83d'];
    for (const s of samples) expect(fnv1a32(s), JSON.stringify(s)).toBe(fnv1a32(enc.encode(s)));
    expect(fnv1a32('ä')).toBe(fnv1a32(new Uint8Array([0xc3, 0xa4])));
    expect(fnv1a32('\u{1F600}')).toBe(fnv1a32(new Uint8Array([0xf0, 0x9f, 0x98, 0x80])));
  });

  it('is unsigned 32-bit, basis-dependent and chainable', () => {
    const h = fnv1a32('course');
    expect(Number.isInteger(h)).toBe(true);
    expect(h).toBeGreaterThanOrEqual(0);
    expect(h).toBeLessThanOrEqual(0xffffffff);
    expect(fnv1a32('course', 0x01000193 ^ 0x811c9dc5)).not.toBe(h);
    expect(fnv1a32('course', h)).not.toBe(h);
    // the basis is taken modulo 2^32: an unsigned and its signed int32 form agree
    expect(fnv1a32(new Uint8Array([1, 2, 3]), 0xffffffff)).toBe(fnv1a32(new Uint8Array([1, 2, 3]), -1));
    // sensitivity: one changed byte changes the hash
    expect(fnv1a32(new Uint8Array([1, 2, 3]))).not.toBe(fnv1a32(new Uint8Array([1, 2, 4])));
  });

  it('hex8 pads to 8 lower-case hex digits', () => {
    expect(hex8(0)).toBe('00000000');
    expect(hex8(0xabc)).toBe('00000abc');
    expect(hex8(0xffffffff)).toBe('ffffffff');
    expect(hex8(-1)).toBe('ffffffff');
    expect(hex8(fnv1a32('a'))).toBe('e40c292c');
  });
});

describe('xorshift32', () => {
  it('is deterministic per seed, differs between seeds and stays in [0, 1)', () => {
    const a = xorshift32(12345);
    const b = xorshift32(12345);
    const c = xorshift32(54321);
    const seqA = Array.from({ length: 200 }, () => a());
    const seqB = Array.from({ length: 200 }, () => b());
    const seqC = Array.from({ length: 200 }, () => c());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
    for (const v of seqA) {
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
    expect(new Set(seqA).size).toBe(200);
    const mean = seqA.reduce((s, v) => s + v, 0) / seqA.length;
    expect(mean).toBeGreaterThan(0.35);
    expect(mean).toBeLessThan(0.65);
  });

  it('does not degenerate on seed 0 and accepts non-int32 seeds', () => {
    const r = xorshift32(0);
    const vals = [r(), r(), r(), r()];
    expect(vals.every((v) => v !== 0)).toBe(true);
    expect(new Set(vals).size).toBe(4);
    expect(xorshift32(2 ** 40 + 7)()).toBe(xorshift32(7)()); // seed is reduced to int32
  });
});
