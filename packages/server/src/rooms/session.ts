// Session tokens and small pure helpers shared by Room and RoomManager (DESIGN §11.5, §11.7, §6.4):
// token generation/comparison, name and chat sanitation, free-colour and host-migration picks.
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { MAX_NAME_CHARS, DEFAULT_PLAYER_NAME } from '@puttipeli/shared/constants';
import type { PlayerColour } from '@puttipeli/shared/game/types';
import { ErrorCode } from '@puttipeli/shared/protocol/codes';
import { MAX_CHAT_CHARS, SESSION_TOKEN_BYTES } from '@puttipeli/shared/protocol/limits';

/** 128-bit random token as 32 hex chars. */
export function generateSessionToken(): string {
  return randomBytes(SESSION_TOKEN_BYTES).toString('hex');
}

/** Constant-time comparison; false for anything that is not a same-length string. */
export function tokensEqual(a: string, b: unknown): boolean {
  if (typeof b !== 'string' || a.length !== b.length) return false;
  return timingSafeEqual(Buffer.from(a, 'utf8'), Buffer.from(b, 'utf8'));
}

// eslint-disable-next-line no-control-regex
const CONTROL_CHARS = new RegExp("[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]", "g");

/** Trim, strip control/invisible chars, collapse whitespace, cut to `max` chars (code points). */
export function sanitizeText(raw: string, max: number): string {
  const cleaned = raw.replace(CONTROL_CHARS, '').replace(/\s+/g, ' ').trim();
  const points = Array.from(cleaned);
  return points.length > max ? points.slice(0, max).join('').trim() : cleaned;
}

/** Player name: 1..MAX_NAME_CHARS after sanitation; an empty result falls back to DEFAULT_PLAYER_NAME. */
export function sanitizeName(raw: string): string {
  const s = sanitizeText(raw, MAX_NAME_CHARS);
  return s.length === 0 ? DEFAULT_PLAYER_NAME : s;
}

/** Chat line: sanitized and cut to MAX_CHAT_CHARS; '' means "nothing to send". */
export function sanitizeChatText(raw: string): string {
  return sanitizeText(raw, MAX_CHAT_CHARS);
}

export function namesEqual(a: string, b: string): boolean {
  return a.localeCompare(b, undefined, { sensitivity: 'accent' }) === 0 || a.toLowerCase() === b.toLowerCase();
}

/** Requested colour if free, else the lowest free one (§6.4). Returns the request when every colour is taken. */
export function pickColour(requested: PlayerColour, taken: Iterable<PlayerColour>): PlayerColour {
  const used = new Set(taken);
  if (!used.has(requested)) return requested;
  for (const c of [0, 1, 2, 3] as const) if (!used.has(c)) return c;
  return requested;
}

/**
 * `becomePlayer` name rule (§6.4): append the smallest free digit suffix (Matti -> Matti2), truncating the base to
 * keep the whole name within MAX_NAME_CHARS.
 */
export function uniqueName(base: string, taken: readonly string[]): string {
  if (!taken.some((n) => namesEqual(n, base))) return base;
  for (let i = 2; i < 10_000; i++) {
    const suffix = String(i);
    const points = Array.from(base);
    const head = points.slice(0, Math.max(1, MAX_NAME_CHARS - suffix.length)).join('').trim();
    const candidate = head + suffix;
    if (!taken.some((n) => namesEqual(n, candidate))) return candidate;
  }
  return base;
}

export interface HostCandidate {
  id: string;
  joinedSeq: number;
  connected: boolean;
  leftRound: boolean;
}

/** Host migration (§10.5): connected, non-left player with the lowest joinedSeq; else any non-left player; else null. */
export function pickHost(players: readonly HostCandidate[]): string | null {
  const alive = players.filter((p) => !p.leftRound);
  const bySeq = (a: HostCandidate, b: HostCandidate) => a.joinedSeq - b.joinedSeq;
  const connected = alive.filter((p) => p.connected).sort(bySeq);
  if (connected.length > 0) return connected[0]!.id;
  const any = alive.sort(bySeq);
  return any.length > 0 ? any[0]!.id : null;
}

/** English developer strings for `error.message` (clients localize by code, §6.4). */
export function errorMessage(code: ErrorCode): string {
  switch (code) {
    case ErrorCode.BAD_VERSION: return 'Protocol or simulation version mismatch';
    case ErrorCode.INVALID_MESSAGE: return 'Malformed message';
    case ErrorCode.RATE_LIMITED: return 'Too many messages';
    case ErrorCode.SERVER_FULL: return 'The server has no free room slots';
    case ErrorCode.ROOM_NOT_FOUND: return 'No room with that code';
    case ErrorCode.ROOM_FULL: return 'The room is full';
    case ErrorCode.NAME_TAKEN: return 'That name is already used in the room';
    case ErrorCode.NOT_IN_ROOM: return 'Not in a room';
    case ErrorCode.ALREADY_IN_ROOM: return 'Already in a room; leave it first';
    case ErrorCode.NOT_HOST: return 'Only the host can do that';
    case ErrorCode.NOT_IN_LOBBY: return 'Allowed in the lobby only';
    case ErrorCode.GAME_IN_PROGRESS: return 'A game is in progress';
    case ErrorCode.NOT_ENOUGH_PLAYERS: return 'Not enough connected players to start';
    case ErrorCode.PLAYERS_NOT_READY: return 'Every player must be ready';
    case ErrorCode.NOT_A_PLAYER: return 'Spectators cannot do that';
    case ErrorCode.NOT_YOUR_TURN: return 'It is not your turn';
    case ErrorCode.STALE_TURN: return 'The turn has already changed';
    case ErrorCode.SHOT_IN_FLIGHT: return 'A shot is already in flight';
    case ErrorCode.INVALID_SHOT: return 'Invalid shot vector';
    case ErrorCode.INVALID_COURSE: return 'Invalid course selection';
    case ErrorCode.SESSION_EXPIRED: return 'The session is no longer valid';
    default: return code;
  }
}
