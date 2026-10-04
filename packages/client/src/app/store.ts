// Tiny observable store (DESIGN §3: profile lives in storage/settings.ts; this holds server status and shared UI state).

export interface Store<T extends object> {
  get(): T;
  set(patch: Partial<T> | ((state: T) => Partial<T>)): void;
  subscribe(listener: (state: T) => void): () => void;
}

export function createStore<T extends object>(initial: T): Store<T> {
  let state = initial;
  const listeners = new Set<(state: T) => void>();
  return {
    get: () => state,
    set(patch) {
      const p = typeof patch === 'function' ? patch(state) : patch;
      let changed = false;
      for (const k of Object.keys(p) as (keyof T)[]) {
        if (!Object.is(p[k], state[k])) { changed = true; break; }
      }
      if (!changed) return;
      state = { ...state, ...p };
      listeners.forEach((l) => l(state));
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

/** Shape of GET /api/stats (DESIGN §11.1). */
export interface ServerStats { rooms: number; players: number; spectators: number; uptimeSec: number; build: string }

export type ServerStatus = 'unknown' | 'online' | 'offline';

export interface AppState {
  serverStatus: ServerStatus;
  stats: ServerStats | null;
  statsCheckedAt: number; // Date.now() of the last attempt, 0 = never
}

export const appStore = createStore<AppState>({ serverStatus: 'unknown', stats: null, statsCheckedAt: 0 });

function toInt(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? Math.max(0, Math.floor(n)) : 0;
}

/**
 * Fetch /api/stats (proxied to the game server in dev) and store the result. Resolves to the stats or null when
 * the server is unreachable; never throws. `timeoutMs` guards against a hanging connection.
 */
export async function refreshServerStats(signal?: AbortSignal, timeoutMs = 4000): Promise<ServerStats | null> {
  const ctrl = new AbortController();
  const onAbort = (): void => ctrl.abort();
  signal?.addEventListener('abort', onAbort);
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch('/api/stats', { signal: ctrl.signal, headers: { accept: 'application/json' }, cache: 'no-store' });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const raw = (await res.json()) as Record<string, unknown>;
    if (!raw || typeof raw !== 'object' || !('rooms' in raw)) throw new Error('bad stats payload');
    const stats: ServerStats = {
      rooms: toInt(raw.rooms),
      players: toInt(raw.players),
      spectators: toInt(raw.spectators),
      uptimeSec: toInt(raw.uptimeSec),
      build: typeof raw.build === 'string' ? raw.build : '',
    };
    appStore.set({ serverStatus: 'online', stats, statsCheckedAt: Date.now() });
    return stats;
  } catch {
    if (signal?.aborted) return appStore.get().stats; // caller went away: keep whatever we had
    appStore.set({ serverStatus: 'offline', statsCheckedAt: Date.now() });
    return null;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener('abort', onAbort);
  }
}
