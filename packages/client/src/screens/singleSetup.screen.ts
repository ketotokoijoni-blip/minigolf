// #/play single-player setup (DESIGN §12.1). Course sources: Perusradat (WP-A BUILTIN_COURSES; all or one),
// Omat radat (courseLibrary, re-validated on listing; entries with errors are greyed and cannot be selected),
// Tiedostosta (one or more .json files through parseCourseFile; issues listed). Thumbnails and the preview come from
// WP-D's drawCourseThumbnail. Aloita -> setPendingLocalGame + navigate('#/game').
import type { Course, CourseLayers, ValidationIssue } from '@puttipeli/shared/course/types';
import { DEFAULT_PLAYER_NAME, MAX_COURSES_PER_SET, MAX_NAME_CHARS } from '@puttipeli/shared/constants';
import { BUILTIN_COURSES } from '@puttipeli/shared/course/builtin';
import { decodeLayers } from '@puttipeli/shared/course/parse';
import type { ParseResult } from '@puttipeli/shared/course/migrate';
import { registerScreen, type Screen, type ScreenContext } from '../app/screen';
import { setPendingLocalGame } from '../app/activeHost';
import { getSettings, updateSettings, sanitizeName } from '../storage/settings';
import { listCoursesWithIssues, onLibraryChange, importCourseText, issueMessage, type ValidatedEntry } from '../storage/courseLibrary';
import { drawCourseThumbnail } from '../render/renderer';
import { el, button, list, tabs, field, colourPicker, toast } from '../ui/components';
import { t, getLanguage } from '../i18n/t';

/** Backing-store scale of list thumbnails (CSS shows them at 98x50, so 0.4 => 294x150 stays crisp on HiDPI). */
const THUMB_SCALE = 0.4;
/** Backing-store scale of the large preview (full logical resolution). */
const PREVIEW_SCALE = 1;

interface FileResult { file: string; result: ParseResult }

const layersCache = new WeakMap<Course, CourseLayers | null>();

/** decodeLayers with a per-course cache; null when the course cannot be decoded (invalid library entry). */
function layersOf(course: Course): CourseLayers | null {
  if (layersCache.has(course)) return layersCache.get(course) ?? null;
  let layers: CourseLayers | null = null;
  try {
    layers = decodeLayers(course);
  } catch {
    layers = null;
  }
  layersCache.set(course, layers);
  return layers;
}

/** Canvas thumbnail of a course drawn by the renderer's thumbnail function; a broken course gets an empty swatch. */
export function courseThumbnail(course: Course, scale: number, className: string): HTMLCanvasElement {
  const canvas = el('canvas', { class: className, role: 'img', 'aria-label': t('play.thumb', { name: course.name }) });
  const layers = layersOf(course);
  if (layers) {
    try {
      drawCourseThumbnail(canvas, layers, null, scale);
    } catch {
      canvas.classList.add('is-broken');
    }
  } else {
    canvas.classList.add('is-broken');
  }
  return canvas;
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(getLanguage() === 'fi' ? 'fi-FI' : 'en-GB');
  } catch {
    return '';
  }
}

/** Localised issue list (errors first, as validateCourse orders them). */
function issueList(issues: readonly ValidationIssue[]): HTMLElement {
  return list(el('ul', { class: 'issues' }), issues, (i) => el('li', { class: `issue issue--${i.level}` },
    el('span', { class: 'issue__level' }, t(`validation.level.${i.level}`)),
    el('span', {}, issueMessage(i))));
}

/** Collapsible "Ongelmat (n)" block; clicks inside never bubble to the selectable row. */
function issueDetails(issues: readonly ValidationIssue[]): HTMLElement {
  const details = el('details', { class: 'issues-details' },
    el('summary', {}, t('play.issues', { count: issues.length })),
    issueList(issues));
  details.addEventListener('click', (e) => e.stopPropagation());
  details.addEventListener('keydown', (e) => e.stopPropagation());
  return details;
}

function createSingleSetup(): Screen {
  let selected: Course[] = [];
  let fileResults: FileResult[] = [];
  let offLibrary: (() => void) | null = null;

  return {
    mount(root, ctx: ScreenContext) {
      const settings = getSettings();
      let playerName = settings.name;
      let colour = settings.colour;
      const rowUpdaters = new Set<() => void>();

      // ---- right column: preview, round, player, start ----
      const previewCanvasHost = el('div', { class: 'preview__canvas' });
      const previewTitle = el('div', { class: 'preview__title' }, t('play.preview.empty'));
      const previewMeta = el('div', { class: 'preview__meta muted small' });
      const previewDesc = el('p', { class: 'preview__desc small' });
      const preview = el('section', { class: 'card preview' }, el('h3', {}, t('play.preview')), previewCanvasHost, previewTitle, previewMeta, previewDesc);
      let previewed: Course | null = null;
      const setPreview = (course: Course | null): void => {
        if (course === previewed) return;
        previewed = course;
        previewCanvasHost.replaceChildren();
        if (!course) {
          previewTitle.textContent = t('play.preview.empty');
          previewMeta.textContent = '';
          previewDesc.textContent = '';
          return;
        }
        previewCanvasHost.append(courseThumbnail(course, PREVIEW_SCALE, 'preview__art'));
        previewTitle.textContent = course.name;
        const meta = [t('play.par', { par: course.rules.par }), t('play.maxStrokes', { max: course.rules.maxStrokes })];
        if (course.author) meta.push(t('play.author', { author: course.author }));
        previewMeta.textContent = meta.join(' · ');
        previewDesc.textContent = course.description;
      };

      const selectedTitle = el('h3');
      const orderList = el('ul', { class: 'list order-list' });
      const startBtn = button(t('play.start'), start, { primary: true, className: 'btn--block btn--large' });
      const startHint = el('div', { class: 'field__hint' }, t('play.start.hint'));
      const clearBtn = button(t('play.clear'), () => { selected = []; refreshSelected(); }, { variant: 'small' });

      const countInRound = (course: Course): number => selected.filter((c) => c === course || c.id === course.id).length;

      const refreshSelected = (): void => {
        selectedTitle.textContent = t('play.selected', { count: selected.length, max: MAX_COURSES_PER_SET });
        list(orderList, selected, (course, i) => {
          const row = el('li', { class: 'list-item list-item--compact' },
            el('span', { class: 'order-num' }, `${i + 1}.`),
            courseThumbnail(course, THUMB_SCALE, 'thumb thumb--small'),
            el('div', { class: 'list-item__body' }, el('div', { class: 'list-item__title' }, course.name), el('div', { class: 'list-item__meta' }, t('play.par', { par: course.rules.par }))),
            el('div', { class: 'list-item__actions' },
              button('↑', () => move(i, -1), { variant: 'small', title: t('play.moveUp'), disabled: i === 0 }),
              button('↓', () => move(i, 1), { variant: 'small', title: t('play.moveDown'), disabled: i === selected.length - 1 }),
              button('✕', () => { selected.splice(i, 1); refreshSelected(); }, { variant: 'small', title: t('play.remove') }),
            ));
          row.addEventListener('mouseenter', () => setPreview(course));
          return row;
        }, t('play.selected.empty'));
        startBtn.disabled = selected.length === 0;
        startHint.hidden = selected.length > 0;
        clearBtn.hidden = selected.length === 0;
        rowUpdaters.forEach((u) => u());
        if (!previewed && selected.length > 0) setPreview(selected[0]!);
      };
      const move = (i: number, d: number): void => {
        const j = i + d;
        if (j < 0 || j >= selected.length) return;
        [selected[i], selected[j]] = [selected[j]!, selected[i]!];
        refreshSelected();
      };
      const addCourses = (courses: Course[]): boolean => {
        const room = MAX_COURSES_PER_SET - selected.length;
        if (courses.length > room) toast(t('play.tooMany', { max: MAX_COURSES_PER_SET }), 'error');
        selected.push(...courses.slice(0, Math.max(0, room)));
        refreshSelected();
        return room > 0;
      };
      const removeCourse = (course: Course): void => {
        // Remove the last instance of this course (by identity, then by id).
        let i = selected.lastIndexOf(course);
        if (i < 0) i = selected.map((c) => c.id).lastIndexOf(course.id);
        if (i >= 0) { selected.splice(i, 1); refreshSelected(); }
      };
      const toggleCourse = (course: Course): void => {
        if (countInRound(course) > 0) removeCourse(course);
        else addCourses([course]);
        setPreview(course);
      };

      const nameInput = el('input', { type: 'text', class: 'input', autocomplete: 'nickname', placeholder: DEFAULT_PLAYER_NAME, spellcheck: 'false' });
      nameInput.maxLength = MAX_NAME_CHARS;
      nameInput.value = playerName;
      nameInput.addEventListener('change', () => { playerName = sanitizeName(nameInput.value); nameInput.value = playerName; updateSettings({ name: playerName }); });
      const colours = [0, 1, 2, 3].map((c) => t(`colour.${c}`));
      const picker = colourPicker(colour, (c) => { colour = c; updateSettings({ colour: c }); }, colours);

      const roundCard = el('section', { class: 'card stack' },
        el('div', { class: 'row row--between' }, selectedTitle, clearBtn),
        orderList);
      const playerCard = el('section', { class: 'card stack' },
        el('h3', {}, t('play.player')),
        field(t('settings.name'), nameInput),
        el('div', { class: 'field' }, el('span', { class: 'field__label' }, t('settings.colour')), picker),
        startBtn, startHint);
      const summary = el('aside', { class: 'stack setup-summary' }, preview, roundCard, playerCard);

      function start(): void {
        if (selected.length === 0) return;
        setPendingLocalGame({
          courses: selected.slice(),
          playerName: playerName || DEFAULT_PLAYER_NAME,
          colour,
          returnTo: '#/',
          testPlay: false,
        });
        ctx.navigate('#/game');
      }

      // ---- shared row: a selectable course with thumbnail, meta, badges and issue details ----
      interface RowOpts { entry?: ValidatedEntry; issues?: readonly ValidationIssue[]; valid?: boolean }
      const courseRow = (course: Course, opts: RowOpts = {}): HTMLElement => {
        const valid = opts.valid !== false;
        const issues = opts.issues ?? [];
        const warnings = issues.filter((i) => i.level === 'warning');
        const meta = [t('play.par', { par: course.rules.par })];
        if (course.author) meta.push(t('play.author', { author: course.author }));
        if (opts.entry) meta.push(t('play.saved', { date: formatDate(opts.entry.savedAt) }));

        const badges = el('div', { class: 'list-item__badges' });
        const inRoundBadge = el('span', { class: 'badge badge--ok', hidden: true });
        badges.append(inRoundBadge);
        if (!valid) badges.append(el('span', { class: 'badge badge--error' }, t('common.errors')));
        else if (warnings.length > 0) badges.append(el('span', { class: 'badge badge--warn' }, t('play.warnings')));

        const body = el('div', { class: 'list-item__body' },
          el('div', { class: 'list-item__title' }, course.name),
          el('div', { class: 'list-item__meta' }, meta.join(' · ')),
          badges);
        if (!valid) body.append(el('div', { class: 'list-item__meta' }, t('play.library.invalid')));
        if (issues.length > 0) body.append(issueDetails(issues));

        const row = el('li', { class: `list-item list-item--course ${valid ? 'is-selectable' : 'is-disabled'}` },
          courseThumbnail(course, THUMB_SCALE, 'thumb'), body);
        row.addEventListener('mouseenter', () => setPreview(course));
        row.addEventListener('focus', () => setPreview(course));
        if (valid) {
          row.setAttribute('role', 'button');
          row.tabIndex = 0;
          row.addEventListener('click', () => toggleCourse(course));
          row.addEventListener('keydown', (e: KeyboardEvent) => {
            if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggleCourse(course); }
          });
        } else {
          row.setAttribute('aria-disabled', 'true');
        }
        const update = (): void => {
          const n = countInRound(course);
          row.classList.toggle('is-selected', n > 0);
          if (valid) row.setAttribute('aria-pressed', String(n > 0));
          inRoundBadge.hidden = n === 0;
          inRoundBadge.textContent = n > 1 ? t('play.inRound.count', { count: n }) : t('play.inRound');
        };
        rowUpdaters.add(update);
        update();
        return row;
      };

      // ---- left column: course sources ----
      // Every tab render drops the library subscription: `fill` clears rowUpdaters, so a library write while another
      // tab is visible would otherwise detach the "kierroksella" badges of the rows on screen.
      const stopLibraryUpdates = (): void => { offLibrary?.(); offLibrary = null; };

      const renderBuiltin = (panel: HTMLElement): void => {
        stopLibraryUpdates();
        rowUpdaters.clear();
        const all = BUILTIN_COURSES;
        const totalPar = all.reduce((s, c) => s + c.rules.par, 0);
        panel.append(
          el('div', { class: 'list-item list-item--set' },
            el('div', { class: 'list-item__body' },
              el('div', { class: 'list-item__title' }, t('play.builtin.all')),
              el('div', { class: 'list-item__meta' }, `${t('play.holes', { count: all.length })} · ${t('play.builtin.all.hint', { par: totalPar })}`)),
            el('div', { class: 'list-item__actions' },
              button(t('play.addAll'), () => addCourses(all.slice()), { variant: 'small' }),
              button(t('play.playAll'), () => { selected = all.slice(); refreshSelected(); start(); }, { primary: true, variant: 'small' }))),
          el('h3', {}, t('play.builtin.single')),
          el('p', { class: 'muted small' }, t('play.builtin.single.hint')),
          list(el('ul', { class: 'list' }), all, (c) => courseRow(c)),
        );
      };

      const renderLibrary = (panel: HTMLElement): void => {
        stopLibraryUpdates();
        rowUpdaters.clear();
        const libraryList = el('ul', { class: 'list' });
        const fill = (): void => {
          rowUpdaters.clear();
          list(libraryList, listCoursesWithIssues(), (e) => courseRow(e.course, { entry: e, issues: e.issues, valid: e.valid }), t('play.library.empty'));
        };
        fill();
        panel.append(el('p', { class: 'muted small' }, t('play.library.hint')), libraryList,
          el('div', { class: 'row' }, button(t('play.openEditor'), () => ctx.navigate('#/editor'), { variant: 'ghost' })));
        // Belt and braces: even if a stale callback fires after the panel was replaced, only a connected list refills.
        offLibrary = onLibraryChange(() => { if (libraryList.isConnected) fill(); });
      };

      const renderFile = (panel: HTMLElement): void => {
        stopLibraryUpdates();
        rowUpdaters.clear();
        const input = el('input', { type: 'file', accept: '.json,application/json', multiple: true, class: 'sr-only', 'aria-label': t('play.file.choose') });
        const resultsList = el('ul', { class: 'list' });
        const fillResults = (): void => {
          rowUpdaters.clear();
          list(resultsList, fileResults, (r) => {
            if (r.result.ok) {
              const row = courseRow(r.result.course, { issues: r.result.warnings });
              row.prepend(el('span', { class: 'list-item__file muted small' }, r.file));
              return row;
            }
            return el('li', { class: 'list-item list-item--course is-invalid' },
              el('div', { class: 'thumb is-broken', 'aria-hidden': 'true' }),
              el('div', { class: 'list-item__body' },
                el('div', { class: 'list-item__title' }, r.file),
                el('div', { class: 'list-item__badges' }, el('span', { class: 'badge badge--error' }, t('common.errors'))),
                issueList(r.result.issues)));
          }, t('play.file.none'));
        };
        fillResults();

        const handleFiles = async (files: FileList | File[]): Promise<void> => {
          const added: Course[] = [];
          for (const f of Array.from(files)) {
            let result: ParseResult;
            if (!/\.json$/i.test(f.name) && f.type !== 'application/json') {
              result = { ok: false, issues: [{ level: 'error', code: 'FORMAT_UNKNOWN', message: t('play.file.notJson') }] };
            } else {
              try {
                result = importCourseText(await f.text());
              } catch {
                result = { ok: false, issues: [{ level: 'error', code: 'BAD_JSON', message: t('play.file.readError', { file: f.name }) }] };
              }
            }
            fileResults.unshift({ file: f.name, result });
            if (result.ok) {
              added.push(result.course);
              toast(t('play.file.added', { name: result.course.name }));
            } else {
              toast(t('play.file.rejected', { file: f.name, count: result.issues.filter((i) => i.level === 'error').length }), 'error');
            }
          }
          fileResults = fileResults.slice(0, 50);
          if (added.length > 0) addCourses(added);
          fillResults();
        };
        input.addEventListener('change', () => { if (input.files && input.files.length > 0) void handleFiles(input.files); input.value = ''; });

        const dropzone = el('div', { class: 'dropzone' },
          button(t('play.file.choose'), () => input.click(), { primary: true }),
          el('span', { class: 'muted' }, t('play.file.drop')),
          input);
        dropzone.addEventListener('dragover', (e) => { e.preventDefault(); dropzone.classList.add('is-over'); });
        dropzone.addEventListener('dragleave', () => dropzone.classList.remove('is-over'));
        dropzone.addEventListener('drop', (e) => {
          e.preventDefault();
          dropzone.classList.remove('is-over');
          if (e.dataTransfer?.files && e.dataTransfer.files.length > 0) void handleFiles(e.dataTransfer.files);
        });

        panel.append(el('p', { class: 'muted small' }, t('play.file.hint')), dropzone, el('h3', {}, t('play.file.loaded')), resultsList);
      };

      const sourceTabs = tabs([
        { id: 'builtin', label: t('play.tab.builtin'), render: renderBuiltin },
        { id: 'library', label: t('play.tab.library'), render: renderLibrary },
        { id: 'file', label: t('play.tab.file'), render: renderFile },
      ], ctx.query.get('tab') ?? 'builtin');

      refreshSelected();
      root.append(el('div', { class: 'screen screen--wide' },
        el('header', { class: 'screen-header' }, button(t('common.back'), () => ctx.navigate('#/')), el('h1', {}, t('play.title'))),
        el('div', { class: 'setup-layout' }, el('section', { class: 'card' }, sourceTabs.root), summary),
      ));
    },

    unmount() {
      offLibrary?.();
      offLibrary = null;
    },
  };
}

registerScreen('#/play', createSingleSetup);
