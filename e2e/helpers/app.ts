// Shared helpers of the browser end-to-end suite (WP-L). Everything here drives the REAL UI through its DOM and the
// game canvas: Finnish labels as the player sees them, class names from the WP-E/WP-G/WP-H/WP-I sources, and the
// 765x405 logical frame of the renderer (DESIGN §12.2) for pointer coordinates on the canvas.
import { expect, type Locator, type Page } from '@playwright/test';
import { mkdirSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// ---------------------------------------------------------------------------------------------------------------
// Screenshots
// ---------------------------------------------------------------------------------------------------------------

export const SCREENSHOT_DIR = resolve(dirname(fileURLToPath(import.meta.url)), '..', 'screenshots');
mkdirSync(SCREENSHOT_DIR, { recursive: true });

/** Optional suffix for comparison runs (e.g. E2E_SHOT_SUFFIX=-newheadless with E2E_CHANNEL=chromium). */
const SHOT_SUFFIX = process.env.E2E_SHOT_SUFFIX ?? '';

export interface ShotOptions {
  /**
   * 'disabled' (default) fast-forwards finite CSS animations/transitions so a screen is never caught mid fade-in;
   * 'allow' keeps them running (needed for the hole title card, whose animation ends at opacity 0).
   */
  animations?: 'allow' | 'disabled';
}

/** Full-page screenshot into e2e/screenshots/<name>.png (git-ignored); returns the absolute path. */
export async function shot(page: Page, name: string, opts: ShotOptions = {}): Promise<string> {
  const path = resolve(SCREENSHOT_DIR, `${name}${SHOT_SUFFIX}.png`);
  await page.screenshot({ path, fullPage: true, animations: opts.animations ?? 'disabled' });
  return path;
}

// ---------------------------------------------------------------------------------------------------------------
// Console guard
// ---------------------------------------------------------------------------------------------------------------

export interface ConsoleLog { errors: string[]; warnings: string[]; pageErrors: string[]; all: string[] }

/** Collects console output and uncaught errors of a page from now on. */
export function watchConsole(page: Page): ConsoleLog {
  const log: ConsoleLog = { errors: [], warnings: [], pageErrors: [], all: [] };
  page.on('console', (msg) => {
    log.all.push(`[${msg.type()}] ${msg.text()}`);
    if (msg.type() === 'error') log.errors.push(msg.text());
    else if (msg.type() === 'warning') log.warnings.push(msg.text());
  });
  page.on('pageerror', (err) => log.pageErrors.push(err.message));
  return log;
}

/** No uncaught errors, no console.error output and no '[puttipeli] desync' warnings (DESIGN §9.6, §15 WP-G). */
export function expectCleanConsole(log: ConsoleLog): void {
  expect(log.pageErrors, 'uncaught page errors').toEqual([]);
  expect(log.errors, 'console.error output').toEqual([]);
  expect(log.warnings.filter((w) => /desync/i.test(w)), 'desync warnings').toEqual([]);
}

// ---------------------------------------------------------------------------------------------------------------
// Untranslated keys
// ---------------------------------------------------------------------------------------------------------------

/**
 * Known i18n key prefixes. The list is derived from the Finnish dictionaries actually registered by the client
 * (packages/client/src/i18n/fi*.ts: every `'prefix.rest': …` entry) so a new dictionary (like the WP-K `dev.*`
 * set) is covered without touching this file; the static set is the fallback should the files move or change
 * shape, and the two are unioned so neither can silently shrink the scan.
 */
const STATIC_PREFIXES = [
  'app', 'common', 'menu', 'colour', 'settings', 'play', 'help', 'legend', 'hud', 'scorecard', 'ui', 'dialog',
  'library', 'validation', 'game', 'mp', 'lobby', 'error', 'chat', 'editor', 'dev',
];

function dictionaryPrefixes(): string[] {
  const dir = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'packages', 'client', 'src', 'i18n');
  const found = new Set<string>(STATIC_PREFIXES);
  try {
    for (const file of readdirSync(dir)) {
      if (!/^fi(\.\w+)?\.ts$/.test(file) || file.endsWith('.test.ts')) continue;
      const src = readFileSync(resolve(dir, file), 'utf8');
      for (const m of src.matchAll(/^\s*'([a-z][a-zA-Z0-9]*)\.[^']+':/gm)) found.add(m[1] ?? '');
    }
  } catch {
    /* dictionaries not readable from here: the static list still applies */
  }
  found.delete('');
  return Array.from(found).sort();
}

export const I18N_PREFIXES: readonly string[] = dictionaryPrefixes();

/** An i18n key shown raw looks like `lobby.start.NOT_ENOUGH_PLAYERS`: a known prefix, a dot and identifiers. */
const RAW_KEY_RE = new RegExp(
  `(?:^|[^\\w.])((?:${I18N_PREFIXES.join('|')})\\.[A-Za-z0-9_]+(?:\\.[A-Za-z0-9_]+)*)(?![\\w.])`,
  'g',
);

/** Visible text plus tooltip / aria-label / placeholder strings of the whole page. */
export async function collectUiText(page: Page): Promise<string> {
  return page.evaluate(() => {
    const parts: string[] = [document.body.innerText];
    for (const el of Array.from(document.querySelectorAll<HTMLElement>('[title],[aria-label],[placeholder]'))) {
      for (const attr of ['title', 'aria-label', 'placeholder']) {
        const v = el.getAttribute(attr);
        if (v) parts.push(v);
      }
    }
    return parts.join('\n');
  });
}

/** Every raw-looking i18n key in a text blob (pure; exported so the scanner itself can be checked). */
export function findRawKeys(text: string): string[] {
  return Array.from(text.matchAll(RAW_KEY_RE), (m) => m[1] ?? m[0]);
}

export async function expectNoRawKeys(page: Page): Promise<void> {
  const found = findRawKeys(await collectUiText(page));
  expect(found, 'untranslated i18n keys visible in the UI').toEqual([]);
}

// ---------------------------------------------------------------------------------------------------------------
// Form fields
// ---------------------------------------------------------------------------------------------------------------

const escapeRegExp = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * The control of a WP-E `field()` block (`<div class="field"><label>…</label><input|select|textarea>`) by its label
 * text. `field()` writes `<label for="">` for controls that have no id (components.ts: `control.id ?? …`, but an
 * unset id is '' rather than undefined), so the label is not programmatically associated and `getByLabel()` finds
 * nothing (reported to WP-E as an accessibility defect). This helper follows the DOM structure instead.
 */
export function fieldControl(page: Page, label: string): Locator {
  return page
    .locator('.field')
    .filter({ has: page.locator('label', { hasText: new RegExp(`^${escapeRegExp(label)}$`) }) })
    .locator('input, select, textarea')
    .first();
}

// ---------------------------------------------------------------------------------------------------------------
// Finnish UI strings the specs rely on (as the player sees them)
// ---------------------------------------------------------------------------------------------------------------

export const FI = {
  yourTurn: 'Sinun vuorosi',
  ballMoving: 'Pallo liikkuu…',
  turnOf: (name: string): string => `Vuorossa: ${name}`,
  testPlayLabel: 'Testaus · Esc: takaisin editoriin',
} as const;

// ---------------------------------------------------------------------------------------------------------------
// Canvas geometry (DESIGN §12.2: logical 765x405, field at (15, 15), tiles 15 px)
// ---------------------------------------------------------------------------------------------------------------

export const LOGICAL_W = 765;
export const LOGICAL_H = 405;
export const FRAME_PX = 15;
export const TILE = 15;

export interface Box { x: number; y: number; width: number; height: number }
export interface Point { x: number; y: number }

/** Bounding box of the renderer's pointer canvas (`.pp-canvas`, the top canvas of the stack). */
export async function gameCanvasBox(page: Page): Promise<Box> {
  const canvas = page.locator('.pp-canvas').first();
  await expect(canvas).toBeVisible();
  const box = await canvas.boundingBox();
  if (!box) throw new Error('game canvas has no bounding box');
  return box;
}

/** World px (field coordinates) -> client px, inverting Camera.toWorld. */
export function worldToScreen(box: Box, wx: number, wy: number): Point {
  return {
    x: box.x + ((wx + FRAME_PX) * box.width) / LOGICAL_W,
    y: box.y + ((wy + FRAME_PX) * box.height) / LOGICAL_H,
  };
}

export const tileCentre = (tx: number, ty: number): Point => ({ x: (tx + 0.5) * TILE, y: (ty + 0.5) * TILE });

export function tileToScreen(box: Box, tx: number, ty: number): Point {
  const c = tileCentre(tx, ty);
  return worldToScreen(box, c.x, c.y);
}

// ---------------------------------------------------------------------------------------------------------------
// Play view (HUD, turns, shots)
// ---------------------------------------------------------------------------------------------------------------

export const hudTurn = (page: Page): Locator => page.locator('.hud__turn');

/** Value of a HUD stat by its label (Rata, Par, Lyönnit, Yhteensä). */
export function hudStat(page: Page, label: string): Locator {
  return page
    .locator('.hud__stat')
    .filter({ has: page.locator('.hud__stat-label', { hasText: new RegExp(`^${label}$`) }) })
    .locator('.hud__stat-value');
}

/** Moves keyboard focus to <body> so Space reaches the aim input and never "clicks" a focused button. */
export async function blurActive(page: Page): Promise<void> {
  await page.evaluate(() => {
    const a = document.activeElement as HTMLElement | null;
    if (a && a !== document.body) a.blur();
  });
}

/**
 * §12.3 default keyboard shot: Space fires the initial aim (nearest hole, 50 % power). The mouse is parked off the
 * canvas first: a pointer resting over the field (e.g. where the last button was clicked before the game screen
 * replaced the lobby) would otherwise provide the aim, and Space would fire toward the cursor instead.
 */
export async function keyboardShot(page: Page): Promise<void> {
  await page.mouse.move(2, 2);
  await blurActive(page);
  await page.keyboard.press('Space');
}

/**
 * Records every `shoot` message this page sends over its WebSocket (multiplayer): 'dx=6000 dy=0' is the §12.3
 * default keyboard aim from the start tile of Ensiputti (hole due east, 50 % of the 120 px pull cap).
 */
export function captureShotMessages(page: Page): string[] {
  const shots: string[] = [];
  page.on('websocket', (ws) => {
    ws.on('framesent', (frame) => {
      try {
        const payload = typeof frame.payload === 'string' ? frame.payload : frame.payload.toString();
        const msg = JSON.parse(payload) as { t?: string; shot?: { dx: number; dy: number } };
        if (msg.t === 'shoot' && msg.shot) shots.push(`dx=${msg.shot.dx} dy=${msg.shot.dy}`);
      } catch {
        /* not a JSON frame */
      }
    });
  });
  return shots;
}

export type TurnState = 'turn' | 'summary';

/** Resolves when it is the local player's turn (HUD "Sinun vuorosi") or a hole/round summary panel is open. */
export async function waitForTurnOrSummary(page: Page, timeout = 60_000): Promise<TurnState> {
  const handle = await page.waitForFunction(
    (yourTurn) => {
      if (document.querySelector('.game-panel--summary')) return 'summary';
      const text = document.querySelector('.hud__turn')?.textContent ?? '';
      return text === yourTurn ? 'turn' : null;
    },
    FI.yourTurn,
    { timeout, polling: 100 },
  );
  return (await handle.jsonValue()) as TurnState;
}

export interface PlayHoleOptions {
  /** Strokes already taken on this hole (default 0). */
  from?: number;
  /** Course stroke limit (default 20): the hole ends by itself at the latest there. */
  maxStrokes?: number;
  /** Runs right after the first shot of this call (e.g. a mid-shot screenshot). */
  afterFirstShot?: () => Promise<void>;
}

/**
 * Plays the current hole with default keyboard shots until the summary appears. Each shot waits for the player's
 * turn, presses Space and asserts the HUD stroke counter went up. Returns the total strokes on the hole.
 */
export async function playHoleWithKeyboard(page: Page, opts: PlayHoleOptions = {}): Promise<number> {
  const max = opts.maxStrokes ?? 20;
  let taken = opts.from ?? 0;
  let shots = 0;
  for (;;) {
    const state = await waitForTurnOrSummary(page);
    if (state === 'summary') return taken;
    if (taken >= max) throw new Error(`hole did not end after ${taken} strokes (limit ${max})`);
    await keyboardShot(page);
    taken++;
    shots++;
    await expect(hudStat(page, 'Lyönnit')).toHaveText(String(taken));
    if (shots === 1 && opts.afterFirstShot) await opts.afterFirstShot();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Navigation
// ---------------------------------------------------------------------------------------------------------------

/** #/play: picks the named built-in courses (Perusradat tab) in order and starts the round. */
export async function startSinglePlayer(page: Page, courses: readonly string[]): Promise<void> {
  await page.goto('/#/play');
  await expect(page.getByRole('heading', { level: 1 })).toHaveText('Yksinpeli');
  await expect(page.getByRole('tab', { name: 'Perusradat' })).toHaveAttribute('aria-selected', 'true');
  for (const name of courses) {
    await page.locator('.list-item--course').filter({ hasText: name }).click();
  }
  await expect(page.locator('.order-list .list-item')).toHaveCount(courses.length);
  await page.getByRole('button', { name: 'Aloita', exact: true }).click();
  await expect(page).toHaveURL(/#\/game$/);
}
