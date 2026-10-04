// #/play single-player setup (DESIGN §12.1). Phase 1 skeleton: tabs, library listing (no validation yet), round
// order editor, player profile and Aloita. TODO phase 2: built-in listing (WP-A builtin.ts), thumbnails
// (WP-D drawCourseThumbnail), file upload via parseCourseFile and greying of invalid library entries.
import type { Course } from '@puttipeli/shared/course/types';
import { DEFAULT_PLAYER_NAME, MAX_COURSES_PER_SET, MAX_NAME_CHARS } from '@puttipeli/shared/constants';
import { registerScreen, type Screen, type ScreenContext } from '../app/screen';
import { setPendingLocalGame } from '../app/activeHost';
import { getSettings, updateSettings, sanitizeName } from '../storage/settings';
import { listCourses, onLibraryChange, type LibraryEntry } from '../storage/courseLibrary';
import { el, button, list, tabs, field, colourPicker, toast } from '../ui/components';
import { t, getLanguage } from '../i18n/t';

/** Built-in courses; filled in phase 2 from @puttipeli/shared/course/builtin (WP-A). */
function builtinCourses(): Course[] {
  return [];
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(getLanguage() === 'fi' ? 'fi-FI' : 'en-GB');
  } catch {
    return '';
  }
}

function createSingleSetup(): Screen {
  let selected: Course[] = [];
  let offLibrary: (() => void) | null = null;

  return {
    mount(root, ctx: ScreenContext) {
      const settings = getSettings();
      let playerName = settings.name;
      let colour = settings.colour;

      // ---- right column: round summary ----
      const selectedTitle = el('h3');
      const orderList = el('ul', { class: 'list order-list' });
      const startBtn = button(t('play.start'), start, { primary: true, className: 'btn--block' });
      const startHint = el('div', { class: 'field__hint' }, t('play.start.hint'));

      const refreshSelected = (): void => {
        selectedTitle.textContent = t('play.selected', { count: selected.length, max: MAX_COURSES_PER_SET });
        list(orderList, selected, (course, i) => el('li', { class: 'list-item' },
          el('span', { class: 'order-num' }, `${i + 1}.`),
          el('div', { class: 'list-item__body' }, el('div', { class: 'list-item__title' }, course.name), el('div', { class: 'list-item__meta' }, t('play.par', { par: course.rules.par }))),
          el('div', { class: 'list-item__actions' },
            button('↑', () => move(i, -1), { variant: 'small', title: t('play.moveUp'), disabled: i === 0 }),
            button('↓', () => move(i, 1), { variant: 'small', title: t('play.moveDown'), disabled: i === selected.length - 1 }),
            button('✕', () => { selected.splice(i, 1); refreshSelected(); }, { variant: 'small', title: t('play.remove') }),
          )), t('play.selected.empty'));
        startBtn.disabled = selected.length === 0;
        startHint.hidden = selected.length > 0;
        clearBtn.hidden = selected.length === 0;
      };
      const move = (i: number, d: number): void => {
        const j = i + d;
        if (j < 0 || j >= selected.length) return;
        [selected[i], selected[j]] = [selected[j]!, selected[i]!];
        refreshSelected();
      };
      const addCourses = (courses: Course[]): void => {
        const room = MAX_COURSES_PER_SET - selected.length;
        if (courses.length > room) toast(t('play.tooMany', { max: MAX_COURSES_PER_SET }), 'error');
        selected.push(...courses.slice(0, Math.max(0, room)));
        refreshSelected();
      };
      const clearBtn = button(t('play.clear'), () => { selected = []; refreshSelected(); }, { variant: 'small' });

      const nameInput = el('input', { type: 'text', class: 'input', autocomplete: 'nickname', placeholder: DEFAULT_PLAYER_NAME });
      nameInput.maxLength = MAX_NAME_CHARS;
      nameInput.value = playerName;
      nameInput.addEventListener('change', () => { playerName = sanitizeName(nameInput.value); nameInput.value = playerName; updateSettings({ name: playerName }); });
      const colours = [0, 1, 2, 3].map((c) => t(`colour.${c}`));
      const picker = colourPicker(colour, (c) => { colour = c; updateSettings({ colour: c }); }, colours);

      const summary = el('aside', { class: 'card stack setup-summary' },
        el('div', { class: 'row row--between' }, selectedTitle, clearBtn),
        orderList,
        el('h3', {}, t('play.player')),
        field(t('settings.name'), nameInput),
        el('div', { class: 'field' }, el('span', { class: 'field__label' }, t('settings.colour')), picker),
        startBtn, startHint,
      );

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

      // ---- left column: course sources ----
      const renderBuiltin = (panel: HTMLElement): void => {
        const all = builtinCourses();
        if (all.length === 0) {
          panel.append(el('div', { class: 'empty' }, t('play.builtin.pending')));
          return;
        }
        panel.append(
          el('div', { class: 'list-item' },
            el('div', { class: 'list-item__body' }, el('div', { class: 'list-item__title' }, t('play.builtin.all')), el('div', { class: 'list-item__meta' }, t('play.builtin.all.hint'))),
            button(t('play.addAll'), () => addCourses(all), { primary: true, variant: 'small' })),
          el('h3', {}, t('play.builtin.single')),
          list(el('ul', { class: 'list' }), all, (c) => courseRow(c, null)),
        );
      };

      const courseRow = (course: Course, entry: LibraryEntry | null): HTMLElement => {
        const meta = [t('play.par', { par: course.rules.par })];
        if (course.author) meta.push(t('play.author', { author: course.author }));
        if (entry) meta.push(t('play.saved', { date: formatDate(entry.savedAt) }));
        const row = el('li', { class: 'list-item' },
          el('canvas', { class: 'thumb', width: '98', height: '50', 'aria-hidden': 'true' }), // TODO phase 2: drawCourseThumbnail
          el('div', { class: 'list-item__body' }, el('div', { class: 'list-item__title' }, course.name), el('div', { class: 'list-item__meta' }, meta.join(' · '))),
          el('div', { class: 'list-item__actions' }, button(t('play.add'), () => addCourses([course]), { variant: 'small' })),
        );
        return row;
      };

      let libraryList: HTMLElement | null = null;
      const renderLibrary = (panel: HTMLElement): void => {
        libraryList = el('ul', { class: 'list' });
        const fill = (): void => { list(libraryList!, listCourses(), (e) => courseRow(e.course, e), t('play.library.empty')); };
        fill();
        panel.append(el('p', { class: 'muted small' }, t('play.library.hint')), libraryList,
          el('div', { class: 'row' }, button(t('play.openEditor'), () => ctx.navigate('#/editor'), { variant: 'ghost' })));
        offLibrary?.();
        offLibrary = onLibraryChange(fill);
      };

      const renderFile = (panel: HTMLElement): void => {
        const input = el('input', { type: 'file', accept: '.json,application/json', multiple: true, disabled: true });
        panel.append(el('p', { class: 'muted small' }, t('play.file.hint')), input, el('div', { class: 'empty' }, t('play.file.pending')));
      };

      const sourceTabs = tabs([
        { id: 'builtin', label: t('play.tab.builtin'), render: renderBuiltin },
        { id: 'library', label: t('play.tab.library'), render: renderLibrary },
        { id: 'file', label: t('play.tab.file'), render: renderFile },
      ], ctx.query.get('tab') ?? (builtinCourses().length === 0 ? 'library' : 'builtin'));

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
