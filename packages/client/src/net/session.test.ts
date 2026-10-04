import { describe, expect, it } from 'vitest';
import type { StorageLike } from '../storage/settings';
import { createSessionStore, codeFromInput, roomLink, RECENT_ROOMS_KEY, SESSION_KEY_PREFIX, MAX_RECENT_ROOMS, type StoredSession } from './session';

class MemoryStorage implements StorageLike {
  data = new Map<string, string>();
  getItem(k: string): string | null { return this.data.get(k) ?? null; }
  setItem(k: string, v: string): void { this.data.set(k, v); }
  removeItem(k: string): void { this.data.delete(k); }
}
const throwing: StorageLike = {
  getItem() { throw new Error('nope'); },
  setItem() { throw new Error('nope'); },
  removeItem() { throw new Error('nope'); },
};

const sess = (code: string, token = 'tok'): StoredSession => ({ code, token, playerId: 'p1', role: 'player', name: 'Maija', colour: 2, savedAt: 0 });

describe('session tokens (sessionStorage)', () => {
  it('stores, reads and clears per code, normalizing the code', () => {
    const storage = new MemoryStorage();
    const store = createSessionStore({ session: storage, local: new MemoryStorage(), now: () => 1000 });
    store.setSession(sess('k7pq2', 'abc'));
    expect(storage.getItem(`${SESSION_KEY_PREFIX}K7PQ2`)).toContain('"abc"');
    expect(store.getSession(' k7-pq2 ')).toMatchObject({ code: 'K7PQ2', token: 'abc', playerId: 'p1', role: 'player', name: 'Maija', colour: 2, savedAt: 1000 });
    expect(store.getSession('ZZZZZ')).toBeNull();
    store.clearSession('K7PQ2');
    expect(store.getSession('K7PQ2')).toBeNull();
    expect(storage.getItem(`${SESSION_KEY_PREFIX}K7PQ2`)).toBeNull();
  });

  it('is readable from another store instance on the same storage (reload)', () => {
    const storage = new MemoryStorage();
    createSessionStore({ session: storage, local: new MemoryStorage() }).setSession(sess('ABCDE'));
    expect(createSessionStore({ session: storage, local: new MemoryStorage() }).getSession('ABCDE')?.token).toBe('tok');
  });

  it('ignores corrupt entries', () => {
    const storage = new MemoryStorage();
    storage.setItem(`${SESSION_KEY_PREFIX}ABCDE`, '{{{');
    storage.setItem(`${SESSION_KEY_PREFIX}BCDEF`, JSON.stringify({ token: '', playerId: 'x' }));
    const store = createSessionStore({ session: storage, local: new MemoryStorage() });
    expect(store.getSession('ABCDE')).toBeNull();
    expect(store.getSession('BCDEF')).toBeNull();
  });

  it('survives a throwing storage by keeping a memory mirror', () => {
    const store = createSessionStore({ session: throwing, local: throwing });
    expect(() => store.setSession(sess('ABCDE'))).not.toThrow();
    expect(store.getSession('ABCDE')?.token).toBe('tok');
    store.clearSession('ABCDE');
    expect(store.getSession('ABCDE')).toBeNull();
    expect(() => store.rememberRecent('ABCDE')).not.toThrow();
    expect(store.listRecent().map((r) => r.code)).toEqual(['ABCDE']);
  });

  it('works without any storage at all', () => {
    const store = createSessionStore({ session: null, local: null });
    store.setSession(sess('ABCDE'));
    expect(store.getSession('ABCDE')?.playerId).toBe('p1');
  });
});

describe('recent rooms (localStorage)', () => {
  it('keeps the newest three, most recent first, without duplicates', () => {
    let now = 1;
    const local = new MemoryStorage();
    const store = createSessionStore({ session: new MemoryStorage(), local, now: () => now++ });
    store.rememberRecent('AAAAA');
    store.rememberRecent('BBBBB');
    store.rememberRecent('CCCCC');
    store.rememberRecent('AAAAA');
    store.rememberRecent('DDDDD');
    expect(store.listRecent().map((r) => r.code)).toEqual(['DDDDD', 'AAAAA', 'CCCCC']);
    expect(store.listRecent()).toHaveLength(MAX_RECENT_ROOMS);
    const persisted = JSON.parse(local.getItem(RECENT_ROOMS_KEY)!) as { code: string }[];
    expect(persisted.map((r) => r.code)).toEqual(['DDDDD', 'AAAAA', 'CCCCC']);
    expect(local.getItem(RECENT_ROOMS_KEY)).not.toContain('tok');
  });

  it('forgets a room and ignores invalid codes', () => {
    const store = createSessionStore({ session: new MemoryStorage(), local: new MemoryStorage() });
    store.rememberRecent('AAAAA');
    store.rememberRecent('not a code');
    store.rememberRecent('K7PQ0'); // 0 is not in the alphabet
    expect(store.listRecent().map((r) => r.code)).toEqual(['AAAAA']);
    store.forgetRecent('aaaaa');
    expect(store.listRecent()).toEqual([]);
  });

  it('drops corrupt persisted entries and sorts by time', () => {
    const local = new MemoryStorage();
    local.setItem(RECENT_ROOMS_KEY, JSON.stringify([{ code: 'AAAAA', at: 5 }, { code: 'bad' }, 7, { code: 'BBBBB', at: 9 }, { code: 'AAAAA', at: 1 }]));
    const store = createSessionStore({ session: new MemoryStorage(), local });
    expect(store.listRecent().map((r) => r.code)).toEqual(['BBBBB', 'AAAAA']);
    local.setItem(RECENT_ROOMS_KEY, 'garbage');
    expect(createSessionStore({ session: new MemoryStorage(), local }).listRecent()).toEqual([]);
  });
});

describe('codeFromInput', () => {
  it('normalizes typed codes', () => {
    expect(codeFromInput('k7pq2')).toBe('K7PQ2');
    expect(codeFromInput(' k7-pq 2 ')).toBe('K7PQ2');
    expect(codeFromInput('K7PQ2XYZ')).toBe('K7PQ2');
    expect(codeFromInput('')).toBe('');
  });

  it('extracts the code from a pasted room link', () => {
    expect(codeFromInput('http://127.0.0.1:5173/#/room/K7PQ2')).toBe('K7PQ2');
    expect(codeFromInput('https://example.test/app/index.html#/room/k7pq2?x=1')).toBe('K7PQ2');
    expect(codeFromInput('#/room/K7PQ2/')).toBe('K7PQ2');
  });
});

describe('roomLink', () => {
  it('builds origin + pathname + hash route', () => {
    expect(roomLink('k7pq2', { origin: 'https://example.test', pathname: '/play/' })).toBe('https://example.test/play/#/room/K7PQ2');
  });
});
