// #/editor (DESIGN §13). A thin DOM shell: the tools (tools.ts) mutate the course only through the shared edit ops
// (D11), history.ts keeps up to 200 snapshots, WP-D's Renderer draws the course in editor mode (grid, hover preview,
// magnet radii, teleport links) and WP-E's course library stores courses and the autosaved draft. The editor session
// (course, history, tool state, selection) lives at module level, so test play (#/game and back) and a language
// change (the router re-mounts the screen) restore it exactly.
import './editor.css';
import '../i18n/fi.editor';
import '../i18n/en.editor';
import { FIELD_W } from '@puttipeli/shared/constants';
import { createBlankCourse } from '@puttipeli/shared/course/blank';
import { canonicalCourseJson } from '@puttipeli/shared/course/canonical';
import { inBounds, tileIndex } from '@puttipeli/shared/course/grid';
import type { Course, ValidationIssue } from '@puttipeli/shared/course/types';
import { hasValidationErrors, validateCourse } from '@puttipeli/shared/course/validate';
import { createWorld } from '@puttipeli/shared/sim/worldState';
import { registerScreen, type Screen, type ScreenContext } from '../app/screen';
import { startLoop } from '../game/loop';
import { Renderer, drawCourseThumbnail } from '../render/renderer';
import { getLanguage, t } from '../i18n/t';
import { getSettings } from '../storage/settings';
import {
  deleteCourse, duplicateCourse, listCourses, loadDraft, onLibraryChange, saveCourse, saveDraft, type LibraryEntry,
} from '../storage/courseLibrary';
import { button, el, list, toast } from '../ui/components';
import { alertDialog, confirmDialog } from '../ui/dialogs';
import { History } from './history';
import { createInspector, issueText, type InspectorHost } from './inspector';
import {
  copyText, courseToJsonText, courseToShareCode, downloadTextFile, exportFileName, fileFromDrop, openCodeDialog,
  parseCourseText, pickJsonFile, readFileText, type CodeDialogOptions,
} from './importExport';
import { installModalKeys } from './modal';
import { createPalette, objectName, selectionName, surfaceName, wallName } from './palette';
import { startTestPlay } from './testPlay';
import {
  PALETTE_TABS, TAB_KEYS, TOOL_KEYS, ToolController, adoptCourse, buildEditorLayers, defaultSelection, describeTile,
  worldToTile, type PaletteTab, type PointerPoint, type Selection, type TilePoint, type ToolHost, type ToolId,
} from './tools';

const VALIDATE_DEBOUNCE_MS = 50;
const DRAFT_DEBOUNCE_MS = 300;
const THUMB_SCALE = 98 / FIELD_W; // the .thumb class is 98x50 CSS px

interface EditorSession {
  history: History;
  /** Library entry the course was opened from / saved to; null = not in the library. */
  libraryKey: string | null;
  /** Course id at the last save/open; null = never saved anywhere but the draft. Dirty = current id differs. */
  savedId: string | null;
  tool: ToolId;
  tab: PaletteTab;
  selections: Record<PaletteTab, Selection>;
  grid: boolean;
  selected: TilePoint | null;
}

/** Survives unmount/mount (test play round trip, language change); reset only by a page reload. */
let session: EditorSession | null = null;

const sameContent = (a: Course, b: Course): boolean => canonicalCourseJson(a) === canonicalCourseJson(b);

/** Layers and objects of a fresh blank course (metadata may differ): nothing worth a discard confirmation. */
function isBlankLike(course: Course): boolean {
  const b = createBlankCourse();
  return course.surface.join('\n') === b.surface.join('\n')
    && course.walls.join('\n') === b.walls.join('\n')
    && JSON.stringify(course.objects) === JSON.stringify(b.objects);
}

function createSession(): EditorSession {
  const draft = loadDraft();
  let course: Course;
  let libraryKey: string | null = null;
  let savedId: string | null;
  if (draft) {
    course = adoptCourse(draft);
    libraryKey = listCourses().find((e) => sameContent(e.course, course))?.key ?? null;
    savedId = libraryKey !== null || isBlankLike(course) ? course.id : null;
  } else {
    course = createBlankCourse({ author: getSettings().name });
    savedId = course.id;
  }
  return {
    history: new History(course),
    libraryKey,
    savedId,
    tool: 'brush',
    tab: 'surface',
    selections: { surface: defaultSelection('surface'), walls: defaultSelection('walls'), objects: defaultSelection('objects') },
    grid: true,
    selected: null,
  };
}

function formatDate(ms: number): string {
  try {
    return new Date(ms).toLocaleDateString(getLanguage() === 'fi' ? 'fi-FI' : 'en-GB');
  } catch {
    return '';
  }
}

const isTypingTarget = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.tagName === 'SELECT' || target.isContentEditable);

const CURSORS: Readonly<Record<ToolId, string>> = {
  brush: 'cell', rect: 'cell', fill: 'cell', line: 'cell', eraser: 'cell', picker: 'crosshair', inspect: 'pointer',
};

function createEditorScreen(): Screen {
  let cleanup: (() => void) | null = null;

  return {
    mount(root, ctx: ScreenContext) {
      const s = session ?? (session = createSession());
      const settings = getSettings();
      let issues: ValidationIssue[] = validateCourse(s.history.current);
      let selected: TilePoint | null = s.selected;
      /** The pointer (and button) that started the current drag; a mouse has one pointerId for all its buttons. */
      let active: { id: number; button: number } | null = null;
      let validationTimer = 0;
      let draftTimer = 0;
      /** Closers of every modal this screen opened (library window, code dialogs): all closed on unmount. */
      const dialogs = new Set<() => void>();
      let libraryOpen = false;
      /** False after unmount: async continuations (after a dialog / file read) must not touch the destroyed UI. */
      let mounted = true;

      const current = (): Course => s.history.current;
      const isDirty = (): boolean => s.savedId === null || current().id !== s.savedId;
      const hasErrors = (): boolean => hasValidationErrors(issues);

      // ---------------------------------------------------------------- tools, palette, inspector
      // The tools and the inspector own separate gestures (history.ts GestureOwner): a drag that starts while a
      // metadata field still has focus ends the field's gesture, and the field's blur cannot end the drag.
      const host: ToolHost = {
        getCourse: current,
        beginGesture: () => s.history.beginGesture('tools'),
        update: (c) => { s.history.update(c); renderCourse(); },
        endGesture: () => { s.history.endGesture('tools'); updateToolbar(); },
        commit: (c) => { s.history.commit(c); renderCourse(); },
        pick: (sel) => { palette.setSelection(sel); updateStatus(); updateOverlay(); },
        inspect: (p) => { selected = p; refreshInspector(); updateOverlay(); },
        notify: (key, params) => toast(t(key, params)),
      };
      const tools = new ToolController(host);
      for (const tab of PALETTE_TABS) tools.setSelection(s.selections[tab]);
      tools.setTab(s.tab);
      tools.setTool(s.tool);

      const palette = createPalette({ tool: tools.tool, tab: tools.tab, selection: tools.selection }, {
        onTool: (id) => setTool(id),
        onTab: (tab) => setTab(tab),
        onSelect: (sel) => { tools.setSelection(sel); palette.setSelection(sel); updateStatus(); updateOverlay(); },
      });
      const inspectorHost: InspectorHost = {
        getCourse: current,
        beginGesture: () => s.history.beginGesture('inspector'),
        update: host.update,
        endGesture: () => { s.history.endGesture('inspector'); updateToolbar(); },
        commit: host.commit,
        focusTile: (p) => { selected = p; refreshInspector(); updateOverlay(); },
      };
      const inspector = createInspector(inspectorHost);

      const setTool = (id: ToolId): void => {
        tools.setTool(id);
        palette.setTool(id);
        renderer.canvas.style.cursor = CURSORS[id];
        updateStatus();
        updateOverlay();
      };
      const setTab = (tab: PaletteTab): void => {
        tools.setTab(tab);
        palette.setTab(tab);
        palette.setSelection(tools.selection);
        updateStatus();
        updateOverlay();
      };

      // ---------------------------------------------------------------- toolbar
      const tb = (key: string, onClick: () => void, primary = false): HTMLButtonElement =>
        button(t(`editor.toolbar.${key}`), onClick, { title: t(`editor.toolbar.${key}.title`), variant: 'small', primary });
      const undoBtn = tb('undo', undo);
      const redoBtn = tb('redo', redo);
      const gridBtn = tb('grid', toggleGrid);
      const testBtn = tb('test', testPlay, true);
      const exportBtn = tb('exportJson', exportJson);
      const shareBtn = tb('shareCode', shareCode);
      const group = (...nodes: Node[]): HTMLElement => el('div', { class: 'ed-toolbar__group' }, ...nodes);
      const toolbar = el('header', { class: 'ed-toolbar' },
        el('div', { class: 'ed-toolbar__title' }, t('editor.title')),
        group(tb('new', newCourse), tb('open', openLibrary), tb('save', saveToLibrary)),
        group(tb('loadJson', loadJson), exportBtn),
        group(shareBtn, tb('importCode', importCode)),
        group(undoBtn, redoBtn, gridBtn),
        el('div', { class: 'ed-toolbar__spacer' }),
        group(testBtn, button(t('editor.toolbar.back'), () => ctx.navigate('#/'), { variant: 'small' })),
      );

      // ---------------------------------------------------------------- stage + status bar
      const canvasHost = el('div', { class: 'ed-canvas-host' });
      const stage = el('section', { class: 'ed-stage' }, canvasHost, el('div', { class: 'ed-drop-hint', 'aria-hidden': 'true' }, t('editor.drop.hint')));
      const tileEl = el('span', { class: 'ed-status__tile' });
      const selEl = el('span', { class: 'ed-status__sel' });
      const saveEl = el('span', { class: 'ed-status__save' });
      const statusBar = el('footer', { class: 'ed-status' }, tileEl, el('span', { class: 'ed-status__sep' }), selEl, el('span', { class: 'ed-status__spacer' }), saveEl);
      root.append(el('div', { class: 'editor' },
        toolbar,
        el('aside', { class: 'ed-palette' }, palette.root),
        stage,
        el('aside', { class: 'ed-inspector' }, inspector.root),
        statusBar,
      ));

      // The renderer is created after the DOM is attached so the camera fits the real container size.
      const renderer = new Renderer(canvasHost, { editorMode: true });
      renderer.canvas.style.cursor = CURSORS[tools.tool];
      const stopLoop = startLoop((now) => renderer.render(now));

      // ---------------------------------------------------------------- rendering helpers
      const renderCourse = (): void => {
        const layers = buildEditorLayers(current());
        renderer.setCourse(layers, createWorld(layers.walls, layers.mines.length));
        scheduleValidation();
        updateOverlay();
        updateToolbar();
        updateStatus();
        scheduleDraft();
      };
      const updateOverlay = (): void => {
        const o = tools.overlay();
        const highlightTiles = o.highlightTiles.slice();
        if (selected) highlightTiles.push(tileIndex(selected.x, selected.y));
        renderer.setEditorOverlay({ grid: s.grid, hoverTile: o.hoverTile, preview: o.preview, magnetRadii: true, teleportLinks: true, highlightTiles });
      };
      const refreshInspector = (): void => inspector.update(current(), selected, issues);
      const scheduleValidation = (): void => {
        window.clearTimeout(validationTimer);
        validationTimer = window.setTimeout(() => {
          issues = validateCourse(current());
          refreshInspector();
          updateToolbar();
        }, VALIDATE_DEBOUNCE_MS);
      };
      const flushDraft = (): void => {
        window.clearTimeout(draftTimer);
        draftTimer = 0;
        saveDraft(current());
      };
      const scheduleDraft = (): void => {
        window.clearTimeout(draftTimer);
        draftTimer = window.setTimeout(flushDraft, DRAFT_DEBOUNCE_MS);
      };
      const updateToolbar = (): void => {
        undoBtn.disabled = !s.history.canUndo;
        redoBtn.disabled = !s.history.canRedo;
        gridBtn.setAttribute('aria-pressed', String(s.grid));
        const blocked = hasErrors();
        for (const [b, key] of [[testBtn, 'test'], [exportBtn, 'exportJson'], [shareBtn, 'shareCode']] as const) {
          b.disabled = blocked;
          b.title = blocked ? t('editor.blocked') : t(`editor.toolbar.${key}.title`);
        }
      };
      const updateStatus = (): void => {
        const h = tools.hoverPoint;
        if (h && inBounds(h.x, h.y)) {
          const info = describeTile(current(), h);
          tileEl.textContent = [
            t('editor.status.tile', { x: h.x, y: h.y }), surfaceName(info.surface), wallName(info.wall),
            info.object ? objectName(info.object.type) : t('editor.object.none'),
          ].join(' · ');
        } else {
          tileEl.textContent = t('editor.status.outside');
        }
        selEl.textContent = `${t(`editor.tool.${tools.tool}`)} · ${selectionName(tools.selection)}`;
        const dirty = isDirty();
        saveEl.textContent = dirty ? t('editor.status.dirty') : s.libraryKey !== null ? t('editor.status.clean') : t('editor.status.unsavedCourse');
        saveEl.classList.toggle('is-dirty', dirty);
        saveEl.classList.toggle('is-clean', !dirty && s.libraryKey !== null);
      };

      // ---------------------------------------------------------------- pointer -> tiles (through Camera.toWorld)
      const canvas = renderer.canvas;
      const pointFrom = (e: PointerEvent): PointerPoint => {
        const w = renderer.camera.toWorld(e.clientX, e.clientY);
        return { ...worldToTile(w.x, w.y), button: e.button === 2 ? 2 : 0, shift: e.shiftKey, alt: e.altKey };
      };
      const afterPointer = (): void => { updateOverlay(); updateStatus(); };
      canvas.addEventListener('contextmenu', (e) => e.preventDefault());
      canvas.addEventListener('pointerdown', (e) => {
        if ((e.button !== 0 && e.button !== 2) || active !== null) return;
        e.preventDefault();
        active = { id: e.pointerId, button: e.button };
        try { canvas.setPointerCapture(e.pointerId); } catch { /* capture unsupported: window blur still cancels */ }
        tools.pointerDown(pointFrom(e));
        afterPointer();
      });
      canvas.addEventListener('pointermove', (e) => {
        if (active !== null && e.pointerId !== active.id) return;
        tools.pointerMove(pointFrom(e));
        afterPointer();
      });
      const release = (e: PointerEvent, cancelled: boolean): void => {
        if (active === null || e.pointerId !== active.id) return;
        // Releasing another mouse button mid-drag (a right-click while the left button paints) is not the end of
        // the drag: the pointerup for the starting button is the one that counts. pointercancel has no button.
        if (!cancelled && e.button !== active.button) return;
        active = null;
        if (cancelled) tools.cancel();
        else tools.pointerUp(pointFrom(e));
        afterPointer();
      };
      canvas.addEventListener('pointerup', (e) => release(e, false));
      canvas.addEventListener('pointercancel', (e) => release(e, true));
      canvas.addEventListener('pointerleave', () => {
        if (active !== null) return;
        tools.pointerLeave();
        afterPointer();
      });
      const onWindowBlur = (): void => {
        if (active === null) return;
        active = null;
        tools.cancel();
        afterPointer();
      };
      window.addEventListener('blur', onWindowBlur);

      // ---------------------------------------------------------------- drag-and-drop import
      let dragDepth = 0;
      stage.addEventListener('dragenter', (e) => { e.preventDefault(); dragDepth++; stage.classList.add('is-dragover'); });
      stage.addEventListener('dragover', (e) => { e.preventDefault(); if (e.dataTransfer) e.dataTransfer.dropEffect = 'copy'; });
      stage.addEventListener('dragleave', () => { dragDepth = Math.max(0, dragDepth - 1); if (dragDepth === 0) stage.classList.remove('is-dragover'); });
      stage.addEventListener('drop', (e) => {
        e.preventDefault();
        dragDepth = 0;
        stage.classList.remove('is-dragover');
        const file = fileFromDrop(e);
        if (!file) { toast(t('editor.toast.notJson'), 'error'); return; }
        void importFile(file);
      });

      // ---------------------------------------------------------------- keyboard (§13.2)
      const onKey = (e: KeyboardEvent): void => {
        if (document.querySelector('.dialog-backdrop')) return;
        const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;
        // Ctrl+S saves even while an inspector field has focus (otherwise the browser offers "Save page").
        // Ctrl+Z / Ctrl+Y inside an input stay native (the field's own text undo).
        if ((e.ctrlKey || e.metaKey) && key === 's') { e.preventDefault(); saveToLibrary(); return; }
        if (isTypingTarget(e.target)) return;
        if (e.ctrlKey || e.metaKey) {
          if (key === 'z' && !e.shiftKey) { e.preventDefault(); undo(); }
          else if (key === 'y' || (key === 'z' && e.shiftKey)) { e.preventDefault(); redo(); }
          else if (key === 's') { e.preventDefault(); saveToLibrary(); }
          return;
        }
        if (e.altKey) return;
        if (key === 'Escape') {
          tools.cancel();
          selected = null;
          refreshInspector();
          afterPointer();
          return;
        }
        const tab = TAB_KEYS[key];
        if (tab) { setTab(tab); return; }
        const tool = TOOL_KEYS[key];
        if (tool) { setTool(tool); return; }
        if (key === 'g') toggleGrid();
        else if (key === 't') testPlay();
      };
      window.addEventListener('keydown', onKey);

      // ---------------------------------------------------------------- actions
      function undo(): void { if (s.history.undo()) renderCourse(); }
      function redo(): void { if (s.history.redo()) renderCourse(); }
      function toggleGrid(): void { s.grid = !s.grid; updateOverlay(); updateToolbar(); }

      function loadCourse(course: Course, opts: { libraryKey: string | null; saved: boolean }): void {
        if (!mounted) return;
        tools.cancel();
        s.history.reset(course);
        s.libraryKey = opts.libraryKey;
        s.savedId = opts.saved ? course.id : null;
        selected = null;
        tools.lastTile = null;
        renderCourse();
        flushDraft();
      }

      /** False when the user declined or the screen was unmounted while the dialog was open. */
      async function confirmDiscard(): Promise<boolean> {
        if (!isDirty()) return true;
        const ok = await confirmDialog(t('editor.confirm.discard'), { ok: t('editor.confirm.discard.ok'), danger: true });
        return ok && mounted;
      }

      /** openCodeDialog registered in `dialogs`, so unmount closes it (resolving null). */
      function codeDialog(opts: CodeDialogOptions): Promise<string | null> {
        let closer: (() => void) | null = null;
        return openCodeDialog({ ...opts, onOpen: (cancel) => { closer = cancel; dialogs.add(cancel); } })
          .finally(() => { if (closer) dialogs.delete(closer); });
      }

      function newCourse(): void {
        void (async () => {
          if (!(await confirmDiscard())) return;
          loadCourse(createBlankCourse({ author: getSettings().name }), { libraryKey: null, saved: true });
          toast(t('editor.toast.newCourse'));
        })();
      }

      function saveToLibrary(): void {
        const course = current();
        const entry = saveCourse(course, s.libraryKey ?? undefined);
        s.libraryKey = entry.key;
        s.savedId = course.id;
        toast(t(hasValidationErrors(validateCourse(course)) ? 'editor.toast.savedWithErrors' : 'editor.toast.saved'));
        updateStatus();
      }

      function exportJson(): void {
        if (hasErrors()) { toast(t('editor.blocked'), 'error'); return; }
        const course = current();
        const file = exportFileName(course);
        downloadTextFile(file, courseToJsonText(course));
        toast(t('editor.toast.exported', { file }));
      }

      function shareCode(): void {
        if (hasErrors()) { toast(t('editor.blocked'), 'error'); return; }
        const code = courseToShareCode(current());
        void copyText(code).then(async (ok) => {
          if (ok) { toast(t('editor.toast.copied')); return; }
          toast(t('editor.toast.copyFailed'), 'error');
          if (!mounted) return;
          await codeDialog({ title: t('editor.share.title'), hint: t('editor.share.hint'), initial: code, readonly: true });
        });
      }

      /** Issue text for pasted code: BAD_JSON talks about "the text", the core string talks about a file. */
      const codeIssueText = (issue: ValidationIssue): string => (issue.code === 'BAD_JSON' ? t('editor.import.badJson') : issueText(issue));

      function importCode(): void {
        void (async () => {
          if (!(await confirmDiscard())) return;
          const text = await codeDialog({
            title: t('editor.import.title'),
            hint: t('editor.import.hint'),
            okLabel: t('editor.import.button'),
            placeholder: '{ "format": "puttipeli-course", … }',
            validate: (txt) => {
              const res = parseCourseText(txt);
              return res.ok ? null : `${t('editor.import.failed')}\n${res.issues.slice(0, 4).map(codeIssueText).join('\n')}`;
            },
          });
          if (text === null || !mounted) return;
          const res = parseCourseText(text);
          if (res.ok) importParsed(res.course);
        })();
      }

      function importParsed(course: Course): void {
        loadCourse(adoptCourse(course), { libraryKey: null, saved: false });
        toast(t('editor.toast.imported', { name: course.name }));
      }

      async function importFile(file: File): Promise<void> {
        if (!(await confirmDiscard())) return;
        let text: string;
        try {
          text = await readFileText(file);
        } catch {
          toast(t('editor.toast.readFailed'), 'error');
          return;
        }
        if (!mounted) return;
        const res = parseCourseText(text);
        if (!res.ok) {
          await alertDialog(`${t('editor.import.failed')}\n${res.issues.map(issueText).join('\n')}`);
          return;
        }
        importParsed(res.course);
      }

      function loadJson(): void {
        void pickJsonFile().then((file) => (file ? importFile(file) : undefined));
      }

      function testPlay(): void {
        const course = current();
        issues = validateCourse(course);
        flushDraft();
        if (!startTestPlay(course, issues, { name: settings.name, colour: settings.colour }, ctx.navigate)) {
          toast(t('editor.testPlay.blocked'), 'error');
          refreshInspector();
          updateToolbar();
        }
      }

      // ---------------------------------------------------------------- library modal (Avaa / Monista / Poista / Vie)
      function openLibrary(): void {
        if (libraryOpen) return;
        libraryOpen = true;
        const previous = document.activeElement as HTMLElement | null;
        const listEl = el('ul', { class: 'list ed-library' });
        const fill = (): void => { list(listEl, listCourses(), entryRow, t('editor.library.empty')); };
        const offLibrary = onLibraryChange(fill);
        const close = (): void => {
          if (!libraryOpen) return;
          libraryOpen = false;
          offLibrary();
          offKeys();
          dialogs.delete(close);
          backdrop.remove();
          if (!document.querySelector('.dialog-backdrop')) document.body.style.overflow = '';
          if (mounted && previous && previous.isConnected) previous.focus();
        };
        const closeBtn = button(t('common.close'), close, { variant: 'small' });
        const box = el('div', { class: 'dialog ed-dialog', role: 'dialog', 'aria-modal': 'true' },
          el('div', { class: 'ed-dialog__head' }, el('h2', {}, t('editor.library.title')), closeBtn), listEl);
        const backdrop = el('div', { class: 'dialog-backdrop ed-modal' }, box);
        // Escape + Tab trap on window (modal.ts): still works after a click on the list background moved the focus to <body>.
        const offKeys = installModalKeys(backdrop, box, { onEscape: close });
        backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) close(); });

        function entryRow(entry: LibraryEntry): HTMLElement {
          const course = entry.course;
          const thumb = el('canvas', { class: 'thumb', 'aria-hidden': 'true' });
          try { drawCourseThumbnail(thumb, buildEditorLayers(course), null, THUMB_SCALE); } catch { /* keep the CSS placeholder */ }
          const bad = hasValidationErrors(validateCourse(course));
          const isCurrent = entry.key === s.libraryKey;
          const badges = el('span', { class: 'ed-badges' });
          if (isCurrent) badges.append(el('span', { class: 'badge' }, t('editor.library.current')));
          if (bad) badges.append(el('span', { class: 'badge badge--error' }, t('common.errors')));
          const meta = [t('editor.library.par', { par: course.rules.par }), course.author || null, t('editor.library.saved', { date: formatDate(entry.savedAt) })]
            .filter((x): x is string => x !== null).join(' · ');
          const actions = el('div', { class: 'list-item__actions' });
          const normal = (): void => {
            actions.replaceChildren(
              button(t('editor.library.open'), () => {
                void (async () => {
                  if (!(await confirmDiscard())) return;
                  close();
                  loadCourse(adoptCourse(course), { libraryKey: entry.key, saved: true });
                })();
              }, { primary: true, variant: 'small' }),
              button(t('editor.library.duplicate'), () => { if (duplicateCourse(entry.key)) toast(t('editor.toast.duplicated')); }, { variant: 'small' }),
              button(t('editor.library.export'), () => downloadTextFile(exportFileName(course), courseToJsonText(course)),
                { variant: 'small', disabled: bad, title: bad ? t('editor.blocked') : undefined }),
              button(t('editor.library.delete'), ask, { variant: 'danger', className: 'btn--small' }),
            );
          };
          const ask = (): void => {
            actions.replaceChildren(
              el('span', { class: 'ed-confirm' }, t('editor.library.deleteConfirm')),
              button(t('common.delete'), () => {
                deleteCourse(entry.key);
                if (s.libraryKey === entry.key) { s.libraryKey = null; s.savedId = null; updateStatus(); }
                toast(t('editor.toast.deleted'));
              }, { variant: 'danger', className: 'btn--small' }),
              button(t('common.cancel'), normal, { variant: 'small' }),
            );
          };
          normal();
          return el('li', { class: `list-item${isCurrent ? ' is-selected' : ''}` },
            thumb,
            el('div', { class: 'list-item__body' }, el('div', { class: 'row' }, el('div', { class: 'list-item__title' }, course.name || '–'), badges), el('div', { class: 'list-item__meta' }, meta)),
            actions);
        }

        fill();
        document.body.append(backdrop);
        document.body.style.overflow = 'hidden';
        dialogs.add(close);
        closeBtn.focus();
      }

      // ---------------------------------------------------------------- go
      renderCourse();
      refreshInspector();

      cleanup = (): void => {
        mounted = false;
        tools.cancel();
        s.history.endGesture('inspector'); // a focused metadata field: its blur never arrives once the DOM is gone
        window.clearTimeout(validationTimer);
        flushDraft();
        window.removeEventListener('keydown', onKey);
        window.removeEventListener('blur', onWindowBlur);
        for (const close of Array.from(dialogs)) close();
        dialogs.clear();
        s.tool = tools.tool;
        s.tab = tools.tab;
        for (const tab of PALETTE_TABS) s.selections[tab] = tools.selectionOf(tab);
        s.selected = selected;
        stopLoop();
        renderer.destroy();
        palette.destroy();
        inspector.destroy();
      };
    },

    unmount() {
      cleanup?.();
      cleanup = null;
    },
  };
}

registerScreen('#/editor', createEditorScreen);
