// Hash router over the self-registered screens (DESIGN §12.1, D26). Pure matching helpers are exported for tests.
import { getScreenRegistry, type Screen, type ScreenContext } from './screen';
import { onLanguageChange } from '../i18n/t';

export interface ParsedHash { path: string; query: URLSearchParams }

/** '#/room/K7PQ2?x=1' -> { path: '/room/K7PQ2', query }. '', '#' and '#/' all mean '/'. Trailing slashes are dropped. */
export function parseHash(hash: string): ParsedHash {
  let s = hash.startsWith('#') ? hash.slice(1) : hash;
  let queryStr = '';
  const q = s.indexOf('?');
  if (q >= 0) { queryStr = s.slice(q + 1); s = s.slice(0, q); }
  if (!s.startsWith('/')) s = '/' + s;
  if (s.length > 1 && s.endsWith('/')) s = s.slice(0, -1);
  return { path: s, query: new URLSearchParams(queryStr) };
}

/** Match one pattern ('#/room/:code') against a path ('/room/K7PQ2'). Returns the params or null. */
export function matchPattern(pattern: string, path: string): Record<string, string> | null {
  const pat = parseHash(pattern).path.split('/').slice(1);
  const seg = path.split('/').slice(1);
  if (pat.length !== seg.length) return null;
  const params: Record<string, string> = {};
  for (let i = 0; i < pat.length; i++) {
    const p = pat[i]!;
    const s = seg[i]!;
    if (p.startsWith(':')) {
      if (s === '') return null;
      try { params[p.slice(1)] = decodeURIComponent(s); } catch { params[p.slice(1)] = s; }
    } else if (p !== s) {
      return null;
    }
  }
  return params;
}

export interface RouteMatch { pattern: string; params: Record<string, string>; query: URLSearchParams }

/** Pick the best registered pattern for a hash: static segments beat parameters when both match. */
export function matchRoute(patterns: Iterable<string>, hash: string): RouteMatch | null {
  const { path, query } = parseHash(hash);
  let best: RouteMatch | null = null;
  let bestScore = -1;
  for (const pattern of patterns) {
    const params = matchPattern(pattern, path);
    if (!params) continue;
    const score = pattern.split('/').filter((s) => s && !s.startsWith(':')).length;
    if (score > bestScore) { best = { pattern, params, query }; bestScore = score; }
  }
  return best;
}

export const HOME_HASH = '#/';

/** Change the current route. Navigating to the hash already shown re-mounts the screen. */
export function navigate(hash: string): void {
  const target = hash.startsWith('#') ? hash : '#' + (hash.startsWith('/') ? hash : '/' + hash);
  if (window.location.hash === target) {
    window.dispatchEvent(new HashChangeEvent('hashchange'));
  } else {
    window.location.hash = target;
  }
}

export interface Router { stop(): void; current(): RouteMatch | null; remount(): void }

/**
 * Start routing into `root`. Unknown hashes redirect to '#/'. The previous screen is unmounted before the next one
 * mounts; a language change re-mounts the current screen so every string re-renders.
 */
export function startRouter(root: HTMLElement): Router {
  let active: { screen: Screen; match: RouteMatch } | null = null;

  const unmountActive = (): void => {
    if (!active) return;
    try { active.screen.unmount(); } catch (err) { console.error('screen unmount failed', err); }
    active = null;
    root.replaceChildren();
  };

  const route = (): void => {
    const registry = getScreenRegistry();
    const match = matchRoute(registry.keys(), window.location.hash);
    if (!match) {
      if (parseHash(window.location.hash).path !== '/') { window.location.replace(HOME_HASH); return; }
      root.replaceChildren();
      console.error('No screen registered for #/');
      return;
    }
    unmountActive();
    const factory = registry.get(match.pattern)!;
    const screen = factory();
    const ctx: ScreenContext = { params: match.params, query: match.query, navigate };
    active = { screen, match };
    try {
      screen.mount(root, ctx);
    } catch (err) {
      console.error(`screen ${match.pattern} failed to mount`, err);
    }
    window.scrollTo(0, 0);
  };

  const onHash = (): void => route();
  window.addEventListener('hashchange', onHash);
  const offLang = onLanguageChange(() => route());
  route();

  return {
    stop() {
      window.removeEventListener('hashchange', onHash);
      offLang();
      unmountActive();
    },
    current: () => active?.match ?? null,
    remount: route,
  };
}
