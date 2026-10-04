// Player settings in localStorage (DESIGN §12.6). Every storage access is wrapped: a throwing or missing storage
// simply yields defaults and keeps the in-memory copy for the session.
import type { PlayerColour } from '@puttipeli/shared/game/types';
import { MAX_NAME_CHARS } from '@puttipeli/shared/constants';
import type { Lang } from '../i18n/t';

export interface Settings {
  name: string;
  colour: PlayerColour;
  volume: number;          // 0..1
  language: Lang;
  aimGuide: boolean;       // single player aiming guide
  touchFireButton: boolean;
  reduceEffects: boolean;
}

export const SETTINGS_KEY = 'puttipeli.settings.v1';

export const DEFAULT_SETTINGS: Readonly<Settings> = Object.freeze({
  name: '',
  colour: 0,
  volume: 0.7,
  language: 'fi',
  aimGuide: false,
  touchFireButton: true,
  reduceEffects: false,
});

export interface StorageLike { getItem(key: string): string | null; setItem(key: string, value: string): void; removeItem(key: string): void }

function defaultStorage(): StorageLike | null {
  try {
    const g = globalThis as { localStorage?: StorageLike };
    return g.localStorage ?? null;
  } catch {
    return null;
  }
}

/** Trim, drop control characters, cap at MAX_NAME_CHARS. */
export function sanitizeName(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  // eslint-disable-next-line no-control-regex
  return raw.replace(/[\u0000-\u001f\u007f]/g, '').trim().slice(0, MAX_NAME_CHARS);
}

export function sanitizeSettings(raw: unknown): Settings {
  const s: Settings = { ...DEFAULT_SETTINGS };
  if (!raw || typeof raw !== 'object') return s;
  const r = raw as Record<string, unknown>;
  s.name = sanitizeName(r.name);
  if (r.colour === 0 || r.colour === 1 || r.colour === 2 || r.colour === 3) s.colour = r.colour;
  if (typeof r.volume === 'number' && Number.isFinite(r.volume)) s.volume = Math.min(1, Math.max(0, r.volume));
  if (r.language === 'fi' || r.language === 'en') s.language = r.language;
  if (typeof r.aimGuide === 'boolean') s.aimGuide = r.aimGuide;
  if (typeof r.touchFireButton === 'boolean') s.touchFireButton = r.touchFireButton;
  if (typeof r.reduceEffects === 'boolean') s.reduceEffects = r.reduceEffects;
  return s;
}

export interface SettingsStore {
  get(): Settings;
  update(patch: Partial<Settings>): Settings;
  subscribe(listener: (s: Settings) => void): () => void;
}

export function createSettingsStore(storage: StorageLike | null = defaultStorage(), key = SETTINGS_KEY): SettingsStore {
  let current: Settings | null = null;
  const listeners = new Set<(s: Settings) => void>();
  const load = (): Settings => {
    if (current) return current;
    try {
      const raw = storage?.getItem(key);
      current = sanitizeSettings(raw ? JSON.parse(raw) : null);
    } catch {
      current = { ...DEFAULT_SETTINGS };
    }
    return current;
  };
  return {
    get: load,
    update(patch) {
      const next = sanitizeSettings({ ...load(), ...patch });
      current = next;
      try { storage?.setItem(key, JSON.stringify(next)); } catch { /* quota, private mode, disabled storage: keep in memory */ }
      listeners.forEach((l) => l(next));
      return next;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
}

const store = createSettingsStore();

export const getSettings = (): Settings => store.get();
export const updateSettings = (patch: Partial<Settings>): Settings => store.update(patch);
export const onSettingsChange = (listener: (s: Settings) => void): (() => void) => store.subscribe(listener);
