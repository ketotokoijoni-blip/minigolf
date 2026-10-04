// Hand-written guards for inbound client frames (DESIGN §3, §11.2). parseClientMessage(raw) returns a *fresh* object
// holding only the known fields of a valid ClientMessage, or null for anything else (malformed JSON, wrong types,
// oversize strings, unknown message type). Rejection -> the server answers INVALID_MESSAGE.
//
// Custom courses inside setCourses are checked structurally (shape and size) only; the full rule set is WP-A's
// parseCourseFile/validateCourse on the server (INVALID_COURSE with issues), so a course that is merely invalid
// still yields a helpful error instead of INVALID_MESSAGE.
import { MAX_COURSES_PER_SET, MAX_NAME_CHARS } from '../constants';
import type { Course, CourseRef } from '../course/types';
import type { PlayerColour, RoomSettings } from '../game/types';
import { validateShot } from '../sim/shot';
import { MAX_CHAT_CHARS, MAX_COURSE_BYTES, MAX_MESSAGE_BYTES } from './limits';
import type { ClientMessage } from './messages';

/** Upper bounds for free-form strings that the server normalizes or looks up afterwards. */
export const MAX_RAW_CODE_CHARS = 32;        // room code before normalizeRoomCode
export const MAX_SESSION_TOKEN_CHARS = 128;  // hex of SESSION_TOKEN_BYTES is 32
export const MAX_CLIENT_BUILD_CHARS = 64;
export const MAX_BUILTIN_ID_CHARS = 32;
/** Raw (non-canonical) JSON of one custom course may carry whitespace and extra keys; the canonical form is capped at MAX_COURSE_BYTES by WP-A. */
export const MAX_RAW_COURSE_CHARS = MAX_COURSE_BYTES * 2;
export const MAX_OBJECTS_PER_COURSE = 2000;
export const MAX_TURN_SEQ = 1_000_000;

type Rec = Record<string, unknown>;

const isRec = (v: unknown): v is Rec => typeof v === 'object' && v !== null && !Array.isArray(v);
const isInt = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v);
const isFiniteNum = (v: unknown): v is number => typeof v === 'number' && Number.isFinite(v);
const isStr = (v: unknown, min: number, max: number): v is string => typeof v === 'string' && v.length >= min && v.length <= max;
const isColour = (v: unknown): v is PlayerColour => isInt(v) && v >= 0 && v <= 3;
const isBool = (v: unknown): v is boolean => typeof v === 'boolean';

/** 1..MAX_NAME_CHARS UTF-16 units with at least one non-whitespace character; the server sanitizes further. */
export function isValidName(v: unknown): v is string {
  return isStr(v, 1, MAX_NAME_CHARS) && v.trim().length > 0;
}

const MAX_PLAYERS_VALUES: readonly unknown[] = [2, 3, 4];
const TURN_TIMEOUT_VALUES: readonly unknown[] = [0, 30, 45, 60];
const HOLE_SUMMARY_VALUES: readonly unknown[] = [0, 3, 6, 10];

/** Known keys with valid values are copied; unknown keys are dropped; a known key with an invalid value rejects. */
function parseSettings(v: unknown): Partial<RoomSettings> | null {
  if (!isRec(v)) return null;
  const out: Partial<RoomSettings> = {};
  if (v['maxPlayers'] !== undefined) {
    if (!MAX_PLAYERS_VALUES.includes(v['maxPlayers'])) return null;
    out.maxPlayers = v['maxPlayers'] as RoomSettings['maxPlayers'];
  }
  if (v['turnTimeoutSec'] !== undefined) {
    if (!TURN_TIMEOUT_VALUES.includes(v['turnTimeoutSec'])) return null;
    out.turnTimeoutSec = v['turnTimeoutSec'] as RoomSettings['turnTimeoutSec'];
  }
  if (v['holeSummarySec'] !== undefined) {
    if (!HOLE_SUMMARY_VALUES.includes(v['holeSummarySec'])) return null;
    out.holeSummarySec = v['holeSummarySec'] as RoomSettings['holeSummarySec'];
  }
  if (v['ballCollision'] !== undefined) {
    if (v['ballCollision'] !== false) return null;
    out.ballCollision = false;
  }
  return out;
}

const isStringRows = (v: unknown, maxRows: number, maxLen: number): v is string[] =>
  Array.isArray(v) && v.length <= maxRows && v.every((r) => isStr(r, 0, maxLen));

/**
 * Structural pre-check of a custom course: a plain object of bounded size whose fields have the right JSON types.
 * Dimensions, characters, object rules and identity are left to parseCourseFile (WP-A).
 */
export function isCourseShaped(v: unknown): v is Course {
  if (!isRec(v)) return false;
  if (!isStr(v['format'], 1, 64) || !isFiniteNum(v['formatVersion'])) return false;
  if (v['id'] !== undefined && !isStr(v['id'], 0, 64)) return false;
  if (!isStr(v['name'], 0, 200)) return false;
  if (v['author'] !== undefined && !isStr(v['author'], 0, 200)) return false;
  if (v['description'] !== undefined && !isStr(v['description'], 0, 1000)) return false;
  if (!isFiniteNum(v['width']) || !isFiniteNum(v['height'])) return false;
  if (v['rules'] !== undefined) {
    const r = v['rules'];
    if (!isRec(r)) return false;
    if (r['maxStrokes'] !== undefined && !isFiniteNum(r['maxStrokes'])) return false;
    if (r['par'] !== undefined && !isFiniteNum(r['par'])) return false;
  }
  if (!isStringRows(v['surface'], 64, 128) || !isStringRows(v['walls'], 64, 128)) return false;
  const objects = v['objects'];
  if (!Array.isArray(objects) || objects.length > MAX_OBJECTS_PER_COURSE) return false;
  for (const o of objects) {
    if (!isRec(o) || !isStr(o['type'], 1, 32) || !isFiniteNum(o['x']) || !isFiniteNum(o['y'])) return false;
  }
  return JSON.stringify(v).length <= MAX_RAW_COURSE_CHARS;
}

function parseCourseRef(v: unknown): CourseRef | null {
  if (!isRec(v)) return null;
  if (v['kind'] === 'builtin') return isStr(v['id'], 1, MAX_BUILTIN_ID_CHARS) ? { kind: 'builtin', id: v['id'] } : null;
  if (v['kind'] === 'custom') return isCourseShaped(v['course']) ? { kind: 'custom', course: v['course'] } : null;
  return null;
}

/** Validates an already-parsed value (e.g. from a test or an in-process transport). */
export function validateClientMessage(value: unknown): ClientMessage | null {
  if (!isRec(value)) return null;
  const m = value;
  switch (m['t']) {
    case 'hello':
      return isInt(m['protocolVersion']) && isInt(m['simVersion']) && isStr(m['clientBuild'], 0, MAX_CLIENT_BUILD_CHARS)
        ? { t: 'hello', protocolVersion: m['protocolVersion'], simVersion: m['simVersion'], clientBuild: m['clientBuild'] }
        : null;

    case 'createRoom': {
      if (!isValidName(m['name']) || !isColour(m['colour'])) return null;
      const out: ClientMessage = { t: 'createRoom', name: m['name'], colour: m['colour'] };
      if (m['settings'] !== undefined) {
        const settings = parseSettings(m['settings']);
        if (settings === null) return null;
        out.settings = settings;
      }
      return out;
    }

    case 'joinRoom': {
      if (!isStr(m['code'], 1, MAX_RAW_CODE_CHARS) || !isValidName(m['name']) || !isColour(m['colour'])) return null;
      const out: ClientMessage = { t: 'joinRoom', code: m['code'], name: m['name'], colour: m['colour'] };
      if (m['asSpectator'] !== undefined) {
        if (!isBool(m['asSpectator'])) return null;
        out.asSpectator = m['asSpectator'];
      }
      return out;
    }

    case 'rejoin':
      return isStr(m['code'], 1, MAX_RAW_CODE_CHARS) && isStr(m['sessionToken'], 1, MAX_SESSION_TOKEN_CHARS)
        ? { t: 'rejoin', code: m['code'], sessionToken: m['sessionToken'] }
        : null;

    case 'leaveRoom':
      return { t: 'leaveRoom' };

    case 'setProfile': {
      const out: ClientMessage = { t: 'setProfile' };
      if (m['name'] !== undefined) {
        if (!isValidName(m['name'])) return null;
        out.name = m['name'];
      }
      if (m['colour'] !== undefined) {
        if (!isColour(m['colour'])) return null;
        out.colour = m['colour'];
      }
      return out;
    }

    case 'setReady':
      return isBool(m['ready']) ? { t: 'setReady', ready: m['ready'] } : null;

    case 'chat':
      return isStr(m['text'], 1, MAX_CHAT_CHARS) ? { t: 'chat', text: m['text'] } : null;

    case 'setCourses': {
      const list = m['courses'];
      if (!Array.isArray(list) || list.length < 1 || list.length > MAX_COURSES_PER_SET) return null;
      const courses: CourseRef[] = [];
      for (const item of list) {
        const ref = parseCourseRef(item);
        if (ref === null) return null;
        courses.push(ref);
      }
      return { t: 'setCourses', courses };
    }

    case 'setSettings': {
      const settings = parseSettings(m['settings']);
      return settings === null ? null : { t: 'setSettings', settings };
    }

    case 'startGame':
      return { t: 'startGame' };

    case 'backToLobby':
      return { t: 'backToLobby' };

    case 'shoot': {
      const holeIndex = m['holeIndex'];
      const turnSeq = m['turnSeq'];
      const shot = m['shot'];
      if (!isInt(holeIndex) || holeIndex < 0 || holeIndex >= MAX_COURSES_PER_SET) return null;
      if (!isInt(turnSeq) || turnSeq < 1 || turnSeq > MAX_TURN_SEQ) return null;
      if (!validateShot(shot)) return null;
      return { t: 'shoot', holeIndex, turnSeq, shot: { dx: shot.dx, dy: shot.dy } };
    }

    case 'summaryReady':
      return { t: 'summaryReady' };

    case 'becomePlayer':
      return { t: 'becomePlayer' };

    case 'requestSnapshot':
      return { t: 'requestSnapshot' };

    case 'ping':
      return isFiniteNum(m['t0']) ? { t: 'ping', t0: m['t0'] } : null;

    default:
      return null;
  }
}

/** Parses one text frame. Non-string input, frames longer than MAX_MESSAGE_BYTES characters and malformed JSON yield null. */
export function parseClientMessage(raw: string): ClientMessage | null {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > MAX_MESSAGE_BYTES) return null;
  let value: unknown;
  try {
    value = JSON.parse(raw);
  } catch {
    return null;
  }
  return validateClientMessage(value);
}
