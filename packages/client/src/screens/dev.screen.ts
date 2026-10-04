// #/dev developer tuning panel (WP-K; DESIGN §12.1 "#/dev", D14, §5.7, R3). Single player only: a slider per
// SIM_TUNING_KEYS entry (except MAX_PULL_PX / MIN_PULL_PX, R3) that calls setSimTuning live, a course picker, an
// embedded local game built from the same GameController + LocalHost as #/game (testPlay: true), "Palauta
// oletukset" (resetSimTuning) and "Kopioi arvot" (a constants.ts snippet). Leaving the screen calls resetSimTuning().
// The pure helpers (key list, slider specs, snippet) are exported for dev.screen.test.ts; nothing touches the DOM at
// import time.
import '../i18n/fi.dev';
import '../i18n/en.dev';
import { DEFAULT_PLAYER_NAME } from '@puttipeli/shared/constants';
import { BUILTIN_COURSES } from '@puttipeli/shared/course/builtin';
import type { Course } from '@puttipeli/shared/course/types';
import { SIM_TUNING_DEFAULTS, SIM_TUNING_KEYS, resetSimTuning, setSimTuning, simTuning, type SimTuning, type SimTuningKey } from '@puttipeli/shared/sim/tuning';
import { getActiveHost, setActiveHost } from '../app/activeHost';
import { registerScreen, type Screen, type ScreenContext } from '../app/screen';
import { GameController } from '../game/controller';
import { clearLayersCache, createLocalHost, type LocalHost } from '../game/localHost';
import { ensureGameStyles } from '../game/summaries';
import { t } from '../i18n/t';
import { listCoursesWithIssues } from '../storage/courseLibrary';
import { getSettings } from '../storage/settings';
import { button, el, toast } from '../ui/components';

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

/** R3: the pull cap and dead zone are validated by the server with the fixed constants, so they are never tunable. */
export const EXCLUDED_TUNING_KEYS: readonly SimTuningKey[] = ['MAX_PULL_PX', 'MIN_PULL_PX'];

export type DevTuningKey = Exclude<SimTuningKey, 'MAX_PULL_PX' | 'MIN_PULL_PX'>;

/** Every tunable that gets a slider, in constants.ts order. */
export const DEV_TUNING_KEYS: readonly DevTuningKey[] = SIM_TUNING_KEYS.filter(
  (k): k is DevTuningKey => !EXCLUDED_TUNING_KEYS.includes(k),
);

export type TuningGroup = 'shot' | 'collision' | 'surfaces' | 'objects' | 'magnetLimits';
export const TUNING_GROUPS: readonly TuningGroup[] = ['shot', 'collision', 'surfaces', 'objects', 'magnetLimits'];

export interface SliderSpec { group: TuningGroup; min: number; max: number; step: number }

/** Slider range per tunable; every range contains the constants.ts default (checked by the test). */
export const SLIDER_SPECS: Readonly<Record<DevTuningKey, SliderSpec>> = {
  POWER_SCALE: { group: 'shot', min: 1, max: 12, step: 0.1 },
  MAX_SPEED: { group: 'shot', min: 300, max: 900, step: 10 },
  STOP_SPEED: { group: 'shot', min: 1, max: 30, step: 0.5 },
  FORCED_STOP_TICKS: { group: 'shot', min: 6, max: 240, step: 6 },

  RESOLVE_ITERATIONS: { group: 'collision', min: 1, max: 8, step: 1 },
  PENETRATION_SLOP: { group: 'collision', min: 0, max: 0.2, step: 0.005 },
  RESTITUTION_WALL: { group: 'collision', min: 0.3, max: 1, step: 0.01 },
  RESTITUTION_BREAKABLE: { group: 'collision', min: 0.3, max: 1, step: 0.01 },
  RESTITUTION_MOVABLE: { group: 'collision', min: 0.1, max: 1, step: 0.01 },
  RESTITUTION_BUMPER: { group: 'collision', min: 1, max: 2, step: 0.05 },
  BUMPER_MIN_EXIT_SPEED: { group: 'collision', min: 0, max: 500, step: 10 },
  BOUNCE_EVENT_MIN_SPEED: { group: 'collision', min: 0, max: 200, step: 5 },
  BREAK_MIN_IMPACT_SPEED: { group: 'collision', min: 0, max: 400, step: 10 },
  BREAK_DEBOUNCE_TICKS: { group: 'collision', min: 0, max: 60, step: 1 },
  MOVABLE_MIN_IMPACT_SPEED: { group: 'collision', min: 0, max: 300, step: 5 },

  FRICTION_GRASS: { group: 'surfaces', min: 50, max: 600, step: 10 },
  FRICTION_SAND: { group: 'surfaces', min: 200, max: 2500, step: 50 },
  FRICTION_ICE: { group: 'surfaces', min: 5, max: 150, step: 5 },
  FRICTION_SLOPE: { group: 'surfaces', min: 20, max: 600, step: 10 },
  SLOPE_ACCEL: { group: 'surfaces', min: 50, max: 800, step: 10 },

  HOLE_RADIUS: { group: 'objects', min: 5, max: 12, step: 0.5 },
  HOLE_PULL_RADIUS: { group: 'objects', min: 5, max: 25, step: 0.5 },
  HOLE_PULL_ACCEL: { group: 'objects', min: 0, max: 1500, step: 25 },
  HOLE_PULL_MAX_SPEED: { group: 'objects', min: 100, max: 900, step: 10 },
  HOLE_CAPTURE_RADIUS: { group: 'objects', min: 2, max: 10, step: 0.25 },
  HOLE_CAPTURE_MAX_SPEED: { group: 'objects', min: 50, max: 600, step: 10 },
  TELEPORT_TRIGGER_RADIUS: { group: 'objects', min: 2, max: 10, step: 0.5 },
  TELEPORT_EXIT_OFFSET: { group: 'objects', min: 0, max: 8, step: 0.5 },
  MAX_TELEPORTS_PER_SHOT: { group: 'objects', min: 1, max: 100, step: 1 },
  MINE_TRIGGER_RADIUS: { group: 'objects', min: 3, max: 12, step: 0.5 },
  MAGNET_DEFAULT_STRENGTH: { group: 'objects', min: 50, max: 500, step: 10 },
  MAGNET_DEFAULT_RADIUS: { group: 'objects', min: 30, max: 240, step: 5 },
  MAGNET_DEAD_ZONE: { group: 'objects', min: 0, max: 10, step: 0.5 },

  MAGNET_MIN_STRENGTH: { group: 'magnetLimits', min: 10, max: 200, step: 10 },
  MAGNET_MAX_STRENGTH: { group: 'magnetLimits', min: 200, max: 600, step: 10 },
  MAGNET_MIN_RADIUS: { group: 'magnetLimits', min: 10, max: 100, step: 5 },
  MAGNET_MAX_RADIUS: { group: 'magnetLimits', min: 100, max: 400, step: 10 },
};

/** Keys of one group in constants.ts order. */
export function keysOfGroup(group: TuningGroup): DevTuningKey[] {
  return DEV_TUNING_KEYS.filter((k) => SLIDER_SPECS[k].group === group);
}

/** Decimal places implied by a slider step (0.005 -> 3, 0.5 -> 1, 10 -> 0). */
export function decimalsOf(step: number): number {
  const s = String(step);
  const i = s.indexOf('.');
  return i === -1 ? 0 : s.length - i - 1;
}

/**
 * Snaps `value` to the slider's step grid (`min + n * step`, the same grid the browser uses for the range thumb),
 * clamps it into [min, max] and trims float noise to the step's decimals, so a typed 203 becomes 200 and the number
 * box, the range input and the snippet always agree. Non-finite input yields the constants.ts default.
 */
export function normalizeValue(key: DevTuningKey, value: number): number {
  if (!Number.isFinite(value)) return SIM_TUNING_DEFAULTS[key];
  const spec = SLIDER_SPECS[key];
  const snapped = spec.min + Math.round((value - spec.min) / spec.step) * spec.step;
  const clamped = Math.min(spec.max, Math.max(spec.min, snapped));
  return Number(clamped.toFixed(decimalsOf(spec.step)));
}

export function formatValue(key: DevTuningKey, value: number): string {
  return Number(value.toFixed(Math.max(decimalsOf(SLIDER_SPECS[key].step), 3))).toString();
}

/** Keys whose live value differs from the constants.ts default. */
export function changedKeys(values: Readonly<SimTuning> = simTuning): DevTuningKey[] {
  return DEV_TUNING_KEYS.filter((k) => values[k] !== SIM_TUNING_DEFAULTS[k]);
}

/**
 * The "Kopioi arvot" payload: one `export const NAME = value;` line per slider in constants.ts order, a `// was X`
 * comment on every changed line, and a header that says how many values differ. Paste over the matching lines of
 * packages/shared/src/constants.ts, bump SIM_VERSION and regenerate the fixtures (D14).
 */
export function tuningSnippet(values: Readonly<SimTuning> = simTuning, defaults: Readonly<SimTuning> = SIM_TUNING_DEFAULTS): string {
  const changed = DEV_TUNING_KEYS.filter((k) => values[k] !== defaults[k]);
  const lines: string[] = [
    `// Puttipeli #/dev tuning snippet: ${changed.length} of ${DEV_TUNING_KEYS.length} values differ from constants.ts.`,
    '// Paste over the matching lines of packages/shared/src/constants.ts, bump SIM_VERSION, run npm run test:golden-update.',
  ];
  let group: TuningGroup | null = null;
  for (const k of DEV_TUNING_KEYS) {
    const g = SLIDER_SPECS[k].group;
    if (g !== group) {
      group = g;
      lines.push('', `// ${g}`);
    }
    const value = formatValue(k, values[k]);
    lines.push(values[k] !== defaults[k] ? `export const ${k} = ${value}; // was ${formatValue(k, defaults[k])}` : `export const ${k} = ${value};`);
  }
  return lines.join('\n') + '\n';
}

// ---------------------------------------------------------------------------------------------------------------
// Screen
// ---------------------------------------------------------------------------------------------------------------

interface CourseOption { id: string; label: string; course: Course }

function courseOptions(): { builtin: CourseOption[]; custom: CourseOption[] } {
  const builtin = BUILTIN_COURSES.map((c, i) => ({ id: `b:${c.id}`, label: `${i + 1}. ${c.name} (par ${c.rules.par})`, course: c }));
  let custom: CourseOption[] = [];
  try {
    custom = listCoursesWithIssues()
      .filter((e) => e.valid)
      .map((e) => ({ id: `c:${e.key}`, label: `${e.course.name} (par ${e.course.rules.par})`, course: e.course }));
  } catch (err) {
    console.warn('[puttipeli] dev: course library unavailable', err);
  }
  return { builtin, custom };
}

async function copyText(text: string): Promise<boolean> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard && typeof navigator.clipboard.writeText === 'function') {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch (err) {
    console.warn('[puttipeli] dev: clipboard write failed', err);
  }
  return false;
}

function createDevScreen(): Screen {
  let host: LocalHost | null = null;
  let controller: GameController | null = null;
  const rows = new Map<DevTuningKey, { range: HTMLInputElement; num: HTMLInputElement; row: HTMLElement; def: HTMLElement }>();
  let changedLabel: HTMLElement | null = null;
  let snippetBox: HTMLTextAreaElement | null = null;

  const stopGame = (): void => {
    controller?.destroy();
    controller = null;
    const h = host;
    host = null;
    if (!h) return;
    try { h.leave(); } catch (err) { console.error('[puttipeli] dev: leave failed', err); }
    if (getActiveHost() === h) setActiveHost(null); // destroys it
    else h.destroy();
  };

  const refreshChanged = (): void => {
    const changed = changedKeys();
    if (changedLabel) changedLabel.textContent = changed.length === 0 ? t('dev.changed.none') : t('dev.changed', { count: changed.length });
    for (const [k, r] of rows) r.row.classList.toggle('is-changed', simTuning[k] !== SIM_TUNING_DEFAULTS[k]);
    if (snippetBox) snippetBox.value = tuningSnippet();
  };

  const syncRow = (k: DevTuningKey): void => {
    const r = rows.get(k);
    if (!r) return;
    const v = simTuning[k];
    r.range.value = String(v);
    r.num.value = formatValue(k, v);
    r.def.textContent = t('dev.default', { value: formatValue(k, SIM_TUNING_DEFAULTS[k]) });
  };

  const applyValue = (k: DevTuningKey, raw: number): void => {
    const v = normalizeValue(k, raw);
    setSimTuning({ [k]: v } as Partial<SimTuning>);
    syncRow(k);
    refreshChanged();
  };

  return {
    mount(root, ctx: ScreenContext) {
      ensureGameStyles();
      ensureDevStyles();
      resetSimTuning(); // a fresh panel always starts from constants.ts

      const settings = getSettings();
      const { builtin, custom } = courseOptions();
      const all = builtin.concat(custom);
      let selected: CourseOption = all[0]!;

      // --- embedded game --------------------------------------------------------------------------------------
      const gameRoot = el('div', { class: 'dev-game__root' });
      const startGame = (): void => {
        stopGame();
        clearLayersCache(); // re-decode the course so a changed magnet limit (if the code ever reads it live) applies
        let local: LocalHost;
        try {
          local = createLocalHost({
            courses: [selected.course],
            playerName: settings.name || DEFAULT_PLAYER_NAME,
            colour: settings.colour,
            testPlay: true,
            returnTo: '#/dev',
          });
        } catch (err) {
          console.error('[puttipeli] dev: local game failed', err);
          toast(t('dev.game.failed'), 'error');
          return;
        }
        setActiveHost(local);
        host = local;
        controller = new GameController(local, gameRoot, {
          testPlay: true,
          onLeave: () => {
            // "Takaisin editoriin" inside the embedded game: the panel is the editor here, so start the course over.
            startGame();
          },
        });
        const err = local.start();
        if (err !== null) {
          toast(t('dev.game.failed'), 'error');
          stopGame();
        }
      };

      // --- course picker ---------------------------------------------------------------------------------------
      const picker = el('select', { class: 'dev-course' });
      const addGroup = (label: string, items: CourseOption[]): void => {
        if (items.length === 0) return;
        const group = el('optgroup', { label });
        for (const o of items) group.append(el('option', { value: o.id }, o.label));
        picker.append(group);
      };
      addGroup(t('dev.course.builtin'), builtin);
      addGroup(t('dev.course.custom'), custom);
      picker.value = selected.id;
      picker.addEventListener('change', () => {
        const next = all.find((o) => o.id === picker.value);
        if (!next) return;
        selected = next;
        startGame();
      });

      // --- buttons ---------------------------------------------------------------------------------------------
      const restartBtn = button(t('dev.restart'), () => startGame(), { title: t('dev.restart.title') });
      const resetBtn = button(t('dev.reset'), () => {
        resetSimTuning();
        for (const k of DEV_TUNING_KEYS) syncRow(k);
        refreshChanged();
        toast(t('dev.reset.done'));
      }, { title: t('dev.reset.title') });
      const copyBtn = button(t('dev.copy'), () => {
        const text = tuningSnippet();
        void copyText(text).then((ok) => {
          if (ok) {
            toast(t('dev.copy.done'));
            return;
          }
          toast(t('dev.copy.failed'), 'error');
          if (snippetBox) {
            snippetBox.hidden = false;
            snippetBox.value = text;
            snippetBox.focus();
            snippetBox.select();
          }
        });
      }, { primary: true, title: t('dev.copy.title') });
      changedLabel = el('div', { class: 'muted small dev-changed' });
      snippetBox = el('textarea', { class: 'dev-snippet input', rows: '8', spellcheck: 'false', readonly: true });
      snippetBox.hidden = true;

      // --- sliders ---------------------------------------------------------------------------------------------
      const groups: HTMLElement[] = [];
      for (const g of TUNING_GROUPS) {
        const section = el('section', { class: 'card stack dev-group' }, el('h3', {}, t(`dev.group.${g}`)));
        if (g === 'magnetLimits') section.append(el('p', { class: 'field__hint' }, t('dev.group.magnetLimits.hint')));
        for (const k of keysOfGroup(g)) {
          const spec = SLIDER_SPECS[k];
          const range = el('input', { type: 'range', class: 'dev-range', min: String(spec.min), max: String(spec.max), step: String(spec.step), id: `dev_${k}` });
          const num = el('input', { type: 'number', class: 'input dev-num', min: String(spec.min), max: String(spec.max), step: String(spec.step), 'aria-label': k });
          const def = el('span', { class: 'dev-default muted small' });
          range.addEventListener('input', () => applyValue(k, Number(range.value)));
          num.addEventListener('change', () => applyValue(k, Number(num.value)));
          const row = el('div', { class: 'dev-row' },
            el('div', { class: 'dev-row__head' },
              el('label', { for: `dev_${k}`, class: 'dev-row__name' }, el('code', {}, k)),
              def,
            ),
            el('div', { class: 'dev-row__desc muted small' }, t(`dev.key.${k}`)),
            el('div', { class: 'dev-row__controls' }, range, num),
          );
          rows.set(k, { range, num, row, def });
          syncRow(k);
          section.append(row);
        }
        groups.push(section);
      }
      refreshChanged();

      const panel = el('aside', { class: 'dev-panel' },
        el('p', { class: 'muted small' }, t('dev.intro')),
        el('div', { class: 'field' }, el('label', { for: 'dev_course', class: 'field__label' }, t('dev.course')), picker),
        el('div', { class: 'row dev-actions' }, restartBtn, resetBtn, copyBtn),
        changedLabel,
        snippetBox,
        el('p', { class: 'field__hint' }, t('dev.excluded')),
        ...groups,
      );
      picker.id = 'dev_course';

      const header = el('header', { class: 'game-bar' },
        button(t('common.back'), () => ctx.navigate('#/'), { variant: 'ghost' }),
        el('span', { class: 'game-bar__title' }, t('dev.title')),
        el('span', { class: 'game-bar__spacer' }),
        el('span', { class: 'muted small' }, '#/dev'),
      );
      const game = el('div', { class: 'dev-game' }, gameRoot);
      root.append(el('div', { class: 'dev-screen' }, header, el('div', { class: 'dev-main' }, panel, game)));

      startGame();
    },

    unmount() {
      stopGame();
      rows.clear();
      changedLabel = null;
      snippetBox = null;
      resetSimTuning(); // §12.1: leaving the screen always restores the defaults
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------
// Styles (WP-K owns no stylesheet: the panel rules travel with this module, like the play view's)
// ---------------------------------------------------------------------------------------------------------------

const DEV_STYLE_ID = 'pp-dev-styles';

const DEV_CSS = `
.dev-screen{display:flex;flex-direction:column;height:100vh;height:100dvh;padding:10px 14px 12px;gap:8px;overflow:hidden}
.dev-main{flex:1;min-height:0;display:grid;grid-template-columns:360px minmax(0,1fr);gap:14px}
.dev-panel{min-height:0;overflow:auto;display:flex;flex-direction:column;gap:12px;padding-right:6px}
.dev-panel .card{padding:12px 14px}
.dev-panel .card h3{font-size:1rem;margin-bottom:4px}
.dev-game{min-height:0;display:flex;flex-direction:column}
.dev-game__root{flex:1;min-height:0;display:flex;flex-direction:column}
.dev-course{width:100%}
.dev-actions .btn{flex:1}
.dev-row{display:flex;flex-direction:column;gap:3px;padding:6px 0;border-top:1px solid var(--line)}
.dev-row:first-of-type{border-top:0}
.dev-row.is-changed .dev-row__name code{color:var(--gold)}
.dev-row.is-changed{background:rgba(232,194,82,.06);margin:0 -8px;padding-left:8px;padding-right:8px;border-radius:4px}
.dev-row__head{display:flex;justify-content:space-between;align-items:baseline;gap:8px}
.dev-row__name code{font-size:.82rem}
.dev-row__controls{display:flex;gap:8px;align-items:center}
/* the shell's input[type="number"] rule (width:100%) outranks a bare class: match the attribute too */
.dev-row__controls input[type="range"].dev-range{flex:1 1 auto;min-width:80px;width:auto;margin:0;accent-color:var(--gold)}
.dev-row__controls input[type="number"].dev-num{width:92px;min-width:0;min-height:32px;flex:none;padding:4px 6px;font-family:var(--mono);font-size:.85rem}
.dev-snippet{font-family:var(--mono);font-size:.78rem;white-space:pre;resize:vertical}
@media (max-width:900px){.dev-screen{height:auto;overflow:visible}.dev-main{grid-template-columns:minmax(0,1fr)}.dev-game{min-height:60vh;order:-1}.dev-panel{overflow:visible}}
`;

/** Appends the panel stylesheet to <head> once (no-op without a DOM). */
export function ensureDevStyles(): void {
  if (typeof document === 'undefined') return;
  if (document.getElementById(DEV_STYLE_ID)) return;
  const style = document.createElement('style');
  style.id = DEV_STYLE_ID;
  style.textContent = DEV_CSS;
  document.head.append(style);
}

registerScreen('#/dev', createDevScreen);
