import { describe, expect, it } from 'vitest';
import { MAX_ROOM_CODE_CHARS } from './limits';
import { isRoomCode, normalizeRoomCode, ROOM_CODE_ALPHABET } from './roomCode';

describe('ROOM_CODE_ALPHABET', () => {
  it('has 32 distinct upper-case characters without I, O, 0, 1', () => {
    expect(ROOM_CODE_ALPHABET).toHaveLength(32);
    expect(new Set(ROOM_CODE_ALPHABET).size).toBe(32);
    expect(ROOM_CODE_ALPHABET).toBe(ROOM_CODE_ALPHABET.toUpperCase());
    for (const c of 'IO01') expect(ROOM_CODE_ALPHABET).not.toContain(c);
    expect(ROOM_CODE_ALPHABET).toBe('ABCDEFGHJKLMNPQRSTUVWXYZ23456789');
  });
});

describe('normalizeRoomCode', () => {
  it('trims, uppercases and removes spaces and hyphens', () => {
    expect(normalizeRoomCode('k7pq2')).toBe('K7PQ2');
    expect(normalizeRoomCode(' k7-pq2 ')).toBe('K7PQ2');
    expect(normalizeRoomCode('K7 PQ 2')).toBe('K7PQ2');
    expect(normalizeRoomCode('\tk7\n- pq-2  ')).toBe('K7PQ2');
    expect(normalizeRoomCode('')).toBe('');
    expect(normalizeRoomCode(' - - ')).toBe('');
  });
  it('does not substitute ambiguous characters', () => {
    expect(normalizeRoomCode('k7pq0')).toBe('K7PQ0');
    expect(normalizeRoomCode('k7pqi')).toBe('K7PQI');
  });
});

describe('isRoomCode', () => {
  it('accepts exactly MAX_ROOM_CODE_CHARS alphabet characters', () => {
    expect(MAX_ROOM_CODE_CHARS).toBe(5);
    expect(isRoomCode('K7PQ2')).toBe(true);
    expect(isRoomCode('AAAAA')).toBe(true);
    expect(isRoomCode('99999')).toBe(true);
    expect(isRoomCode(normalizeRoomCode(' k7-pq2 '))).toBe(true);
  });
  it('rejects wrong length, lowercase, ambiguous characters and non-strings', () => {
    expect(isRoomCode('K7PQ0')).toBe(false);
    expect(isRoomCode('K7PQI')).toBe(false);
    expect(isRoomCode('K7PQO')).toBe(false);
    expect(isRoomCode('K7PQ1')).toBe(false);
    expect(isRoomCode('k7pq2')).toBe(false);
    expect(isRoomCode('K7PQ')).toBe(false);
    expect(isRoomCode('K7PQ22')).toBe(false);
    expect(isRoomCode('')).toBe(false);
    expect(isRoomCode('K7-Q2')).toBe(false);
    expect(isRoomCode('K7PQÅ')).toBe(false);
    expect(isRoomCode(12345 as unknown as string)).toBe(false);
    expect(isRoomCode(null as unknown as string)).toBe(false);
  });
  it('every alphabet character is accepted in every position', () => {
    for (const c of ROOM_CODE_ALPHABET) expect(isRoomCode(c.repeat(5))).toBe(true);
  });
});
