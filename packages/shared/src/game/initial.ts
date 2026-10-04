// Initial states and settings normalization (DESIGN §10.3).
import { DEFAULT_TURN_TIMEOUT_SEC, HOLE_SUMMARY_SEC, MAX_PLAYERS } from '../constants';
import type { Course } from '../course/types';
import type { GameState, PlayerState, RoomSettings } from './types';

export const DEFAULT_ROOM_SETTINGS: RoomSettings = Object.freeze({
  maxPlayers: MAX_PLAYERS as 4,
  turnTimeoutSec: DEFAULT_TURN_TIMEOUT_SEC as 45,
  holeSummarySec: HOLE_SUMMARY_SEC as 6,
  ballCollision: false,
}) as RoomSettings;

const MAX_PLAYERS_VALUES: readonly RoomSettings['maxPlayers'][] = [2, 3, 4];
const TURN_TIMEOUT_VALUES: readonly RoomSettings['turnTimeoutSec'][] = [0, 30, 45, 60];
const HOLE_SUMMARY_VALUES: readonly RoomSettings['holeSummarySec'][] = [0, 3, 6, 10];

function pick<T>(value: unknown, allowed: readonly T[], fallback: T): T {
  return (allowed as readonly unknown[]).includes(value) ? (value as T) : fallback;
}

/**
 * Unknown or invalid values fall back to `base` (default DEFAULT_ROOM_SETTINGS). `maxPlayers` is raised to at least
 * `minPlayers` (the current player count, passed by Authority.setSettings) and never above MAX_PLAYERS.
 * `ballCollision` is forced to false (reserved, D20).
 */
export function normalizeSettings(
  partial: Partial<RoomSettings> | undefined,
  base: RoomSettings = DEFAULT_ROOM_SETTINGS,
  minPlayers = 0,
): RoomSettings {
  const p: Record<string, unknown> =
    typeof partial === 'object' && partial !== null && !Array.isArray(partial) ? (partial as Record<string, unknown>) : {};
  let maxPlayers = pick(p['maxPlayers'], MAX_PLAYERS_VALUES, base.maxPlayers);
  const floor = Math.min(Math.max(Math.floor(Number.isFinite(minPlayers) ? minPlayers : 0), 0), MAX_PLAYERS);
  if (maxPlayers < floor) maxPlayers = pick(floor, MAX_PLAYERS_VALUES, MAX_PLAYERS as 4);
  return {
    maxPlayers,
    turnTimeoutSec: pick(p['turnTimeoutSec'], TURN_TIMEOUT_VALUES, base.turnTimeoutSec),
    holeSummarySec: pick(p['holeSummarySec'], HOLE_SUMMARY_VALUES, base.holeSummarySec),
    ballCollision: false,
  };
}

/** Empty lobby: hostId null, no players. The server passes BUILTIN_COURSES as the initial set. */
export function createLobbyState(settings: RoomSettings, courses: Course[]): GameState {
  return {
    phase: 'lobby',
    settings: normalizeSettings(settings),
    hostId: null,
    players: [],
    spectators: [],
    courses: courses.slice(),
    seatOrder: [],
    holeIndex: -1,
    order: [],
    balls: {},
    shotOrigins: {},
    strokes: {},
    holeDone: {},
    world: null,
    turn: null,
    lastShot: null,
    summaryReady: {},
    ranking: null,
    countdownEndsAtMs: null,
    seq: 0,
  };
}

export const SINGLE_PLAYER_SETTINGS: RoomSettings = Object.freeze({
  maxPlayers: 2,
  turnTimeoutSec: 0,
  holeSummarySec: 0,
  ballCollision: false,
}) as RoomSettings;

/**
 * Lobby with that one player seated, ready and host. Authority.join() with the same id is then a no-op, so
 * localHost may call join(player) followed by start(player.id) as described in §10.7.
 */
export function createSinglePlayerState(courses: Course[], player: PlayerState): GameState {
  const seated: PlayerState = {
    ...player,
    ready: true,
    connected: true,
    afk: false,
    consecutiveTimeouts: 0,
    leftRound: false,
    joinedSeq: player.joinedSeq > 0 ? player.joinedSeq : 1,
  };
  const state = createLobbyState(SINGLE_PLAYER_SETTINGS, courses);
  return { ...state, hostId: seated.id, players: [seated], strokes: { [seated.id]: [] } };
}
