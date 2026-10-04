// Multiplayer session persistence (DESIGN §11.5, §12.5): the session token of each room lives in sessionStorage
// (per tab, so a reload rejoins the same seat), the last three room codes in localStorage (recent rooms, never with
// tokens). Every storage access is wrapped: a missing or throwing storage degrades to memory for the page's lifetime.
import type { PlayerColour } from '@puttipeli/shared/game/types';
import { MAX_ROOM_CODE_CHARS } from '@puttipeli/shared/protocol/limits';
import { isRoomCode, normalizeRoomCode } from '@puttipeli/shared/protocol/roomCode';
import type { StorageLike } from '../storage/settings';

export interface StoredSession {
  code: string;
  token: string;
  playerId: string;
  role: 'player' | 'spectator';
  /** Profile used for the automatic spectator re-join after SESSION_EXPIRED (§10.6). */
  name: string;
  colour: PlayerColour;
  savedAt: number;
}

export interface RecentRoom { code: string; at: number }

export const SESSION_KEY_PREFIX = 'puttipeli.session.v1.';
export const RECENT_ROOMS_KEY = 'puttipeli.recentRooms.v1';
export const MAX_RECENT_ROOMS = 3;

export interface SessionStore {
  getSession(code: string): StoredSession | null;
  setSession(session: StoredSession): void;
  clearSession(code: string): void;
  /** Newest first, at most MAX_RECENT_ROOMS entries. */
  listRecent(): RecentRoom[];
  rememberRecent(code: string): void;
  forgetRecent(code: string): void;
}

export interface SessionStoreDeps {
  /** Per-tab storage for tokens (default window.sessionStorage). */
  session?: StorageLike | null;
  /** Persistent storage for recent rooms (default window.localStorage). */
  local?: StorageLike | null;
  now?: () => number;
}

function globalStorage(name: 'sessionStorage' | 'localStorage'): StorageLike | null {
  try {
    const g = globalThis as Record<string, unknown>;
    const s = g[name];
    return s && typeof s === 'object' ? (s as StorageLike) : null;
  } catch {
    return null;
  }
}

/** In-memory fallback when a storage is unavailable or throws. */
class MemoryStore implements StorageLike {
  private readonly map = new Map<string, string>();
  getItem(key: string): string | null { return this.map.get(key) ?? null; }
  setItem(key: string, value: string): void { this.map.set(key, value); }
  removeItem(key: string): void { this.map.delete(key); }
}

function safeGet(storage: StorageLike, key: string): string | null {
  try { return storage.getItem(key); } catch { return null; }
}
function safeSet(storage: StorageLike, key: string, value: string): void {
  try { storage.setItem(key, value); } catch { /* quota, private mode, disabled storage */ }
}
function safeRemove(storage: StorageLike, key: string): void {
  try { storage.removeItem(key); } catch { /* ignore */ }
}

function isColour(v: unknown): v is PlayerColour {
  return v === 0 || v === 1 || v === 2 || v === 3;
}

function parseSession(raw: string | null, code: string): StoredSession | null {
  if (!raw) return null;
  try {
    const r = JSON.parse(raw) as Record<string, unknown>;
    if (!r || typeof r !== 'object') return null;
    if (typeof r.token !== 'string' || r.token.length === 0 || typeof r.playerId !== 'string') return null;
    return {
      code,
      token: r.token,
      playerId: r.playerId,
      role: r.role === 'spectator' ? 'spectator' : 'player',
      name: typeof r.name === 'string' ? r.name : '',
      colour: isColour(r.colour) ? r.colour : 0,
      savedAt: typeof r.savedAt === 'number' ? r.savedAt : 0,
    };
  } catch {
    return null;
  }
}

function parseRecent(raw: string | null): RecentRoom[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return [];
    const out: RecentRoom[] = [];
    for (const e of parsed) {
      if (!e || typeof e !== 'object') continue;
      const r = e as Record<string, unknown>;
      if (typeof r.code !== 'string' || !isRoomCode(r.code)) continue;
      if (out.some((x) => x.code === r.code)) continue;
      out.push({ code: r.code, at: typeof r.at === 'number' && Number.isFinite(r.at) ? r.at : 0 });
    }
    out.sort((a, b) => b.at - a.at);
    return out.slice(0, MAX_RECENT_ROOMS);
  } catch {
    return [];
  }
}

export function createSessionStore(deps: SessionStoreDeps = {}): SessionStore {
  const session: StorageLike = (deps.session === undefined ? globalStorage('sessionStorage') : deps.session) ?? new MemoryStore();
  const local: StorageLike = (deps.local === undefined ? globalStorage('localStorage') : deps.local) ?? new MemoryStore();
  const now = deps.now ?? (() => Date.now());
  // Memory mirror so a throwing storage still behaves consistently within the page.
  const sessionMirror = new Map<string, StoredSession>();
  let recentMirror: RecentRoom[] | null = null;

  const keyOf = (code: string): string => SESSION_KEY_PREFIX + normalizeRoomCode(code);

  const loadRecent = (): RecentRoom[] => {
    if (recentMirror) return recentMirror;
    recentMirror = parseRecent(safeGet(local, RECENT_ROOMS_KEY));
    return recentMirror;
  };
  const persistRecent = (): void => {
    safeSet(local, RECENT_ROOMS_KEY, JSON.stringify(recentMirror ?? []));
  };

  return {
    getSession(code) {
      const c = normalizeRoomCode(code);
      const stored = parseSession(safeGet(session, keyOf(c)), c);
      if (stored) { sessionMirror.set(c, stored); return stored; }
      return sessionMirror.get(c) ?? null;
    },
    setSession(s) {
      const c = normalizeRoomCode(s.code);
      const value: StoredSession = { ...s, code: c, savedAt: s.savedAt || now() };
      sessionMirror.set(c, value);
      safeSet(session, keyOf(c), JSON.stringify(value));
    },
    clearSession(code) {
      const c = normalizeRoomCode(code);
      sessionMirror.delete(c);
      safeRemove(session, keyOf(c));
    },
    listRecent() {
      return loadRecent().map((r) => ({ ...r }));
    },
    rememberRecent(code) {
      const c = normalizeRoomCode(code);
      if (!isRoomCode(c)) return;
      const list = loadRecent().filter((r) => r.code !== c);
      list.unshift({ code: c, at: now() });
      recentMirror = list.slice(0, MAX_RECENT_ROOMS);
      persistRecent();
    },
    forgetRecent(code) {
      const c = normalizeRoomCode(code);
      recentMirror = loadRecent().filter((r) => r.code !== c);
      persistRecent();
    },
  };
}

/**
 * Room code from free-form input: a pasted room link ('…#/room/K7PQ2?x=1'), a code with spaces/hyphens or lower case.
 * Returns the normalized (not necessarily valid) code, capped at MAX_ROOM_CODE_CHARS.
 */
export function codeFromInput(text: string): string {
  const m = /room\/([^?&#/\s]+)/i.exec(text);
  const raw = m ? m[1]! : text;
  let decoded = raw;
  try { decoded = decodeURIComponent(raw); } catch { /* keep raw */ }
  return normalizeRoomCode(decoded).slice(0, MAX_ROOM_CODE_CHARS);
}

/** Shareable deep link to a room: `${origin}${pathname}#/room/CODE` (DESIGN §12.1). */
export function roomLink(code: string, loc?: { origin: string; pathname: string }): string {
  const l = loc ?? (typeof location !== 'undefined' ? { origin: location.origin, pathname: location.pathname } : { origin: '', pathname: '/' });
  return `${l.origin}${l.pathname}#/room/${normalizeRoomCode(code)}`;
}

// Default singleton bound to the window storages (lazy: nothing is read at import time).
let defaultStore: SessionStore | null = null;
export function getSessionStore(): SessionStore {
  if (!defaultStore) defaultStore = createSessionStore();
  return defaultStore;
}
