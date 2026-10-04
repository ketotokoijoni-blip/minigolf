import { describe, expect, it } from 'vitest';
import { MAX_ROOM_CODE_CHARS } from '@puttipeli/shared/protocol/limits';
import { ROOM_CODE_ALPHABET, isRoomCode, normalizeRoomCode } from '@puttipeli/shared/protocol/roomCode';
import { generateRoomCode } from './codes';

describe('room codes', () => {
  it('alphabet has 32 characters without I, O, 0, 1 (D19)', () => {
    expect(ROOM_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(32);
    for (const bad of 'IO01') expect(ROOM_CODE_ALPHABET.includes(bad)).toBe(false);
  });

  it('generates codes of the right length from the alphabet', () => {
    for (let i = 0; i < 200; i++) {
      const code = generateRoomCode();
      expect(code).toHaveLength(MAX_ROOM_CODE_CHARS);
      expect(isRoomCode(code)).toBe(true);
    }
  });

  it('has (almost) no collisions over 10 000 draws', () => {
    // 32^5 = 33.5 M codes: the birthday bound gives ~1.5 expected collisions in 10 000 draws, so strict uniqueness
    // (DESIGN §16.4 wording) cannot hold; a biased or broken generator would collide far more often than 20 times.
    const seen = new Set<string>();
    for (let i = 0; i < 10_000; i++) seen.add(generateRoomCode());
    expect(seen.size).toBeGreaterThanOrEqual(10_000 - 20);
  });

  it('uses every alphabet character over many draws', () => {
    const seen = new Set<string>();
    for (let i = 0; i < 2000; i++) for (const ch of generateRoomCode()) seen.add(ch);
    expect(seen.size).toBe(32);
  });

  it('normalizes input without substituting characters', () => {
    expect(normalizeRoomCode('k7pq2')).toBe('K7PQ2');
    expect(normalizeRoomCode(' k7-pq2 ')).toBe('K7PQ2');
    expect(normalizeRoomCode('k 7 p q 2')).toBe('K7PQ2');
    expect(isRoomCode('K7PQ2')).toBe(true);
    expect(isRoomCode('K7PQ0')).toBe(false);
    expect(isRoomCode('K7PQI')).toBe(false);
    expect(isRoomCode('K7PQ')).toBe(false);
    expect(isRoomCode('K7PQ22')).toBe(false);
  });
});
