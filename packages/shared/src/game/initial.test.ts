import { describe, expect, it } from 'vitest';
import { makeCourse, makePlayer } from './fixtures.test';
import { createLobbyState, createSinglePlayerState, DEFAULT_ROOM_SETTINGS, normalizeSettings, SINGLE_PLAYER_SETTINGS } from './initial';
import type { RoomSettings } from './types';

describe('normalizeSettings', () => {
  it('returns defaults for undefined / garbage input', () => {
    expect(normalizeSettings(undefined)).toEqual(DEFAULT_ROOM_SETTINGS);
    expect(normalizeSettings(null as unknown as Partial<RoomSettings>)).toEqual(DEFAULT_ROOM_SETTINGS);
    expect(normalizeSettings([] as unknown as Partial<RoomSettings>)).toEqual(DEFAULT_ROOM_SETTINGS);
    expect(normalizeSettings({ maxPlayers: 7 as unknown as 4, turnTimeoutSec: 'x' as unknown as 0, holeSummarySec: 5 as unknown as 6 })).toEqual(DEFAULT_ROOM_SETTINGS);
  });
  it('accepts valid values and falls back to base per field', () => {
    const base: RoomSettings = { maxPlayers: 3, turnTimeoutSec: 30, holeSummarySec: 0, ballCollision: false };
    expect(normalizeSettings({ turnTimeoutSec: 60 }, base)).toEqual({ ...base, turnTimeoutSec: 60 });
    expect(normalizeSettings({ maxPlayers: 2, holeSummarySec: 10 }, base)).toEqual({ ...base, maxPlayers: 2, holeSummarySec: 10 });
    expect(normalizeSettings({ maxPlayers: 1 as unknown as 2 }, base).maxPlayers).toBe(3);
  });
  it('forces ballCollision false and clamps maxPlayers up to the player count', () => {
    expect(normalizeSettings({ ballCollision: true as unknown as false }).ballCollision).toBe(false);
    expect(normalizeSettings({ maxPlayers: 2 }, DEFAULT_ROOM_SETTINGS, 3).maxPlayers).toBe(3);
    expect(normalizeSettings({ maxPlayers: 2 }, DEFAULT_ROOM_SETTINGS, 4).maxPlayers).toBe(4);
    expect(normalizeSettings({ maxPlayers: 2 }, DEFAULT_ROOM_SETTINGS, 9).maxPlayers).toBe(4);
    expect(normalizeSettings({ maxPlayers: 3 }, DEFAULT_ROOM_SETTINGS, 1).maxPlayers).toBe(3);
    expect(normalizeSettings({ maxPlayers: 2 }, DEFAULT_ROOM_SETTINGS, Number.NaN).maxPlayers).toBe(2);
  });
});

describe('createLobbyState', () => {
  it('builds an empty lobby with normalized settings and a copied course list', () => {
    const courses = [makeCourse()];
    const s = createLobbyState({ ...DEFAULT_ROOM_SETTINGS, ballCollision: true as unknown as false }, courses);
    expect(s.phase).toBe('lobby');
    expect(s.hostId).toBeNull();
    expect(s.players).toEqual([]);
    expect(s.settings.ballCollision).toBe(false);
    expect(s.courses).toEqual(courses);
    expect(s.courses).not.toBe(courses);
    expect(s.holeIndex).toBe(-1);
    expect(s.world).toBeNull();
    expect(s.seq).toBe(0);
  });
});

describe('createSinglePlayerState', () => {
  it('seats the player as ready host with single-player settings', () => {
    const p = makePlayer('p1', 0, { ready: false, connected: false, afk: true, consecutiveTimeouts: 3, leftRound: true });
    const s = createSinglePlayerState([makeCourse()], p);
    expect(s.settings).toEqual(SINGLE_PLAYER_SETTINGS);
    expect(s.settings).toEqual({ maxPlayers: 2, turnTimeoutSec: 0, holeSummarySec: 0, ballCollision: false });
    expect(s.hostId).toBe('p1');
    expect(s.players).toHaveLength(1);
    expect(s.players[0]).toMatchObject({ id: 'p1', ready: true, connected: true, afk: false, consecutiveTimeouts: 0, leftRound: false, joinedSeq: 1 });
    expect(s.strokes).toEqual({ p1: [] });
    const s2 = createSinglePlayerState([makeCourse()], makePlayer('p1', 7));
    expect(s2.players[0]!.joinedSeq).toBe(7);
  });
});
