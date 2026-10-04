import { describe, expect, it } from 'vitest';
import { TILE_COUNT } from '../constants';
import { createBallAt, createWorldFromCourse } from '../sim/worldState';
import { deepFreeze, makeCourse, makePlayer, START_CENTRE } from './fixtures.test';
import { createLobbyState, DEFAULT_ROOM_SETTINGS } from './initial';
import { gameStateFromJson, gameStateToJson, worldFromJson, worldToJson } from './serialize';
import type { GameState } from './types';

describe('serialize', () => {
  const course = makeCourse({ objects: [{ type: 'mine', x: 20, y: 8 }, { type: 'mine', x: 21, y: 8 }] });

  function midHole(): GameState {
    const world = createWorldFromCourse(course);
    world.walls[100] = 9;
    world.breakHits[200] = 2;
    world.minesArmed[1] = 0;
    return deepFreeze({
      ...createLobbyState(DEFAULT_ROOM_SETTINGS, [course]),
      phase: 'hole',
      hostId: 'a',
      players: [makePlayer('a', 1), makePlayer('b', 2, { connected: false })],
      spectators: [{ id: 's1', name: 'Katsoja' }],
      seatOrder: ['a', 'b'],
      holeIndex: 0,
      order: ['a', 'b'],
      balls: { a: createBallAt(START_CENTRE), b: { ...createBallAt({ x: 10.5, y: 20.25 }), vx: 1.1, vy: -2.2, moving: true, lastTile: 5 } },
      shotOrigins: { a: START_CENTRE, b: { x: 1, y: 2 } },
      strokes: { a: [2], b: [-1] },
      holeDone: { a: false },
      world,
      turn: { playerId: 'b', turnSeq: 3, deadlineMs: 123456, shotInFlight: true },
      lastShot: { playerId: 'b', turnSeq: 3, shot: { dx: 300, dy: -400 }, ticks: 77, atMs: 999 },
      summaryReady: {},
      ranking: null,
      countdownEndsAtMs: null,
      seq: 42,
    });
  }

  it('converts the world to plain arrays and back', () => {
    const w = createWorldFromCourse(course);
    w.walls[3] = 1;
    w.minesArmed[0] = 0;
    const j = worldToJson(w);
    expect(Array.isArray(j.walls)).toBe(true);
    expect(j.walls).toHaveLength(TILE_COUNT);
    expect(j.minesArmed).toEqual([0, 1]);
    const back = worldFromJson(JSON.parse(JSON.stringify(j)));
    expect(back.walls).toBeInstanceOf(Uint8Array);
    expect(back.walls).toEqual(w.walls);
    expect(back.breakHits).toEqual(w.breakHits);
    expect(back.minesArmed).toEqual(w.minesArmed);
  });

  it('round-trips a mid-hole state through JSON text', () => {
    const s = midHole();
    const json = gameStateToJson(s);
    expect(json.world).not.toBeNull();
    expect(Array.isArray(json.world!.walls)).toBe(true);
    const text = JSON.stringify(json);
    const back = gameStateFromJson(JSON.parse(text));
    expect(back).toEqual(s);
    expect(back.world!.walls).toBeInstanceOf(Uint8Array);
    expect(back.world!.walls[100]).toBe(9);
    expect(back.world!.breakHits[200]).toBe(2);
    expect(back.world!.minesArmed[1]).toBe(0);
  });

  it('keeps a null world and does not touch the input', () => {
    const s = deepFreeze(createLobbyState(DEFAULT_ROOM_SETTINGS, [course]));
    const json = gameStateToJson(s);
    expect(json.world).toBeNull();
    expect(gameStateFromJson(json)).toEqual(s);
    expect(gameStateFromJson(json)).not.toBe(s);
  });
});
