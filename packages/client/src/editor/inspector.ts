// Right-hand inspector (DESIGN §13.1): course metadata, the selected tile with its object's properties, and the
// live validation list. Text fields and sliders edit inside a history gesture (focus/first input … blur/change), so
// one editing session is one undo entry while validation still updates on every keystroke. The host opens the
// gesture for the 'inspector' owner (history.ts): a canvas drag that starts while a field still has focus takes the
// gesture over, and every keystroke re-opens ours (beginGesture is idempotent), so the field's blur never closes a
// drag and later keystrokes still coalesce.
import {
  MAGNET_MAX_RADIUS, MAGNET_MAX_STRENGTH, MAGNET_MIN_RADIUS, MAGNET_MIN_STRENGTH,
  MAX_AUTHOR_CHARS, MAX_COURSE_NAME_CHARS, MAX_DESCRIPTION_CHARS, MAX_MAX_STROKES, MAX_PAR, MIN_MAX_STROKES, MIN_PAR,
} from '@puttipeli/shared/constants';
import { placeObject, removeObjectAt, setMeta } from '@puttipeli/shared/course/edit';
import {
  WallShape, type Course, type CourseObject, type CourseRules, type Polarity, type TeleportGroup, type ValidationIssue,
} from '@puttipeli/shared/course/types';
import { el, button, field, select } from '../ui/components';
import { t } from '../i18n/t';
import { describeTile, type TilePoint } from './tools';
import { objectName, surfaceName, wallName } from './palette';

/** Localised issue text: t('validation.' + code, params ∪ {x, y}); falls back to the developer message. */
export function issueText(issue: ValidationIssue): string {
  const key = `validation.${issue.code}`;
  const params: Record<string, string | number> = { ...(issue.params ?? {}) };
  if (issue.x !== undefined) params.x = issue.x;
  if (issue.y !== undefined) params.y = issue.y;
  const s = t(key, params);
  return s === key ? issue.message : s;
}

export interface InspectorHost {
  getCourse(): Course;
  beginGesture(): void;
  update(course: Course): void;
  endGesture(): void;
  commit(course: Course): void;
  /** A validation row with coordinates was clicked: select + highlight that tile. */
  focusTile(p: TilePoint): void;
}

export interface InspectorView {
  root: HTMLElement;
  update(course: Course, selected: TilePoint | null, issues: readonly ValidationIssue[]): void;
  destroy(): void;
}

type MetaText = 'name' | 'author' | 'description';
type MetaNumber = keyof CourseRules;

const clamp = (v: number, lo: number, hi: number): number => (v < lo ? lo : v > hi ? hi : v);

export function createInspector(host: InspectorHost): InspectorView {
  // ---- metadata ------------------------------------------------------------------------------------------------
  const nameIn = el('input', { type: 'text', class: 'input', spellcheck: 'false', autocomplete: 'off' });
  nameIn.maxLength = MAX_COURSE_NAME_CHARS;
  const authorIn = el('input', { type: 'text', class: 'input', spellcheck: 'false', autocomplete: 'off' });
  authorIn.maxLength = MAX_AUTHOR_CHARS;
  const descIn = el('textarea', { class: 'input ed-textarea', rows: '2' });
  descIn.maxLength = MAX_DESCRIPTION_CHARS;
  const parIn = el('input', { type: 'number', class: 'input', min: String(MIN_PAR), max: String(MAX_PAR), step: '1' });
  const strokesIn = el('input', { type: 'number', class: 'input', min: String(MIN_MAX_STROKES), max: String(MAX_MAX_STROKES), step: '1' });

  const bindText = (input: HTMLInputElement | HTMLTextAreaElement, key: MetaText): void => {
    input.addEventListener('focus', () => host.beginGesture());
    input.addEventListener('input', () => {
      const meta: Partial<Pick<Course, MetaText>> = {};
      meta[key] = input.value;
      host.beginGesture();
      host.update(setMeta(host.getCourse(), meta));
    });
    input.addEventListener('blur', () => host.endGesture());
  };
  const bindNumber = (input: HTMLInputElement, key: MetaNumber): void => {
    input.addEventListener('focus', () => host.beginGesture());
    input.addEventListener('input', () => {
      const v = Number(input.value);
      if (input.value.trim() === '' || !Number.isInteger(v)) return; // keep typing; the validator reports the rest live
      const rules: Partial<CourseRules> = {};
      rules[key] = v;
      host.beginGesture();
      host.update(setMeta(host.getCourse(), rules));
    });
    input.addEventListener('blur', () => {
      host.endGesture();
      input.value = String(host.getCourse().rules[key]);
    });
  };
  bindText(nameIn, 'name');
  bindText(authorIn, 'author');
  bindText(descIn, 'description');
  bindNumber(parIn, 'par');
  bindNumber(strokesIn, 'maxStrokes');

  const metaSection = el('section', { class: 'ed-section' },
    el('h3', {}, t('editor.inspector.meta')),
    field(t('editor.inspector.name'), nameIn),
    field(t('editor.inspector.author'), authorIn),
    field(t('editor.inspector.description'), descIn),
    el('div', { class: 'ed-row2' },
      field(t('editor.inspector.par', { min: MIN_PAR, max: MAX_PAR }), parIn),
      field(t('editor.inspector.maxStrokes', { min: MIN_MAX_STROKES, max: MAX_MAX_STROKES }), strokesIn)),
  );

  // ---- selected tile ------------------------------------------------------------------------------------------
  const tileBody = el('div', { class: 'ed-section__body' });
  const tileSection = el('section', { class: 'ed-section' }, el('h3', {}, t('editor.inspector.tile')), tileBody);
  /** Identity of the current build so a value change (slider drag, undo) patches instead of rebuilding. */
  let tileKey = '';
  interface TileRefs {
    surface: HTMLElement; wall: HTMLElement; object: HTMLElement;
    strength?: HTMLInputElement; strengthNum?: HTMLInputElement; radius?: HTMLInputElement; radiusNum?: HTMLInputElement;
    polarity?: { button: HTMLButtonElement; polarity: Polarity }[];
    group?: HTMLSelectElement;
  }
  let refs: TileRefs | null = null;

  const replaceObject = (p: TilePoint, next: CourseObject): Course => placeObject(host.getCourse(), { ...next, x: p.x, y: p.y });

  const rangeRow = (
    label: string, min: number, max: number, step: number, value: number,
    apply: (v: number, gesture: boolean) => void,
  ): { wrap: HTMLElement; range: HTMLInputElement; num: HTMLInputElement } => {
    const range = el('input', { type: 'range', min: String(min), max: String(max), step: String(step) });
    range.value = String(value);
    const num = el('input', { type: 'number', class: 'input ed-num', min: String(min), max: String(max), step: String(step) });
    num.value = String(value);
    let inGesture = false;
    range.addEventListener('input', () => {
      if (!inGesture) { inGesture = true; host.beginGesture(); }
      num.value = range.value;
      apply(Number(range.value), true);
    });
    range.addEventListener('change', () => {
      if (inGesture) { inGesture = false; host.endGesture(); }
    });
    num.addEventListener('change', () => {
      const v = Number(num.value);
      if (!Number.isFinite(v)) { num.value = range.value; return; }
      const c = clamp(Math.round(v / step) * step, min, max);
      num.value = String(c);
      range.value = String(c);
      apply(c, false);
    });
    const wrap = el('div', { class: 'ed-field' }, el('span', { class: 'field__label' }, label), el('div', { class: 'ed-range' }, range, num));
    return { wrap, range, num };
  };

  const buildTile = (course: Course, p: TilePoint): void => {
    const info = describeTile(course, p);
    const obj = info.object;
    const r: TileRefs = {
      surface: el('dd', {}, surfaceName(info.surface)),
      wall: el('dd', {}, wallName(info.wall)),
      object: el('dd', {}, obj ? objectName(obj.type) : t('editor.object.none')),
    };
    const dl = el('dl', { class: 'ed-tileinfo' },
      el('dt', {}, t('editor.inspector.coords')), el('dd', {}, `(${p.x}, ${p.y})`),
      el('dt', {}, t('editor.inspector.surface')), r.surface,
      el('dt', {}, t('editor.inspector.wall')), r.wall,
      el('dt', {}, t('editor.inspector.object')), r.object,
    );
    const parts: Node[] = [dl];

    if (obj?.type === 'teleport') {
      const options = Array.from({ length: 8 }, (_, g) => ({ value: String(g), label: t('editor.teleport.groupN', { n: g + 1 }) }));
      r.group = select(options, String(obj.group), (v) => {
        const o = describeTile(host.getCourse(), p).object;
        if (o?.type === 'teleport') host.commit(replaceObject(p, { ...o, group: Number(v) as TeleportGroup }));
      });
      parts.push(field(t('editor.teleport.group'), r.group));
    }
    if (obj?.type === 'magnet') {
      const pol = el('div', { class: 'ed-polarity' });
      r.polarity = [];
      for (const polarity of [1, -1] as const) {
        const b = el('button', { type: 'button', class: `ed-pol ed-pol--${polarity === 1 ? 'attract' : 'repel'}`, 'aria-pressed': String(obj.polarity === polarity) },
          t(polarity === 1 ? 'editor.magnet.attract' : 'editor.magnet.repel'));
        b.addEventListener('click', () => {
          const o = describeTile(host.getCourse(), p).object;
          if (o?.type === 'magnet' && o.polarity !== polarity) host.commit(replaceObject(p, { ...o, polarity }));
        });
        r.polarity.push({ button: b, polarity });
        pol.append(b);
      }
      parts.push(el('div', { class: 'ed-field' }, el('span', { class: 'field__label' }, t('editor.magnet.polarity')), pol));
      const applyProp = (prop: 'strength' | 'radius') => (v: number, gesture: boolean): void => {
        const o = describeTile(host.getCourse(), p).object;
        if (o?.type !== 'magnet') return;
        const next = replaceObject(p, { ...o, [prop]: v });
        if (gesture) host.update(next); else host.commit(next);
      };
      const s = rangeRow(t('editor.magnet.strength', { min: MAGNET_MIN_STRENGTH, max: MAGNET_MAX_STRENGTH }),
        MAGNET_MIN_STRENGTH, MAGNET_MAX_STRENGTH, 10, clamp(obj.strength, MAGNET_MIN_STRENGTH, MAGNET_MAX_STRENGTH), applyProp('strength'));
      const rad = rangeRow(t('editor.magnet.radius', { min: MAGNET_MIN_RADIUS, max: MAGNET_MAX_RADIUS }),
        MAGNET_MIN_RADIUS, MAGNET_MAX_RADIUS, 5, clamp(obj.radius, MAGNET_MIN_RADIUS, MAGNET_MAX_RADIUS), applyProp('radius'));
      r.strength = s.range; r.strengthNum = s.num; r.radius = rad.range; r.radiusNum = rad.num;
      parts.push(s.wrap, rad.wrap);
    }
    if (obj) {
      parts.push(el('div', { class: 'row' },
        button(t('editor.inspector.removeObject'), () => host.commit(removeObjectAt(host.getCourse(), p.x, p.y)), { variant: 'danger', className: 'btn--small' })));
    }
    tileBody.replaceChildren(...parts);
    refs = r;
  };

  const patchTile = (course: Course, p: TilePoint): void => {
    if (!refs) return;
    const info = describeTile(course, p);
    const obj = info.object;
    refs.surface.textContent = surfaceName(info.surface);
    refs.wall.textContent = info.wall === WallShape.None ? wallName(0) : wallName(info.wall);
    refs.object.textContent = obj ? objectName(obj.type) : t('editor.object.none');
    if (obj?.type === 'magnet') {
      if (refs.strength && document.activeElement !== refs.strength) refs.strength.value = String(obj.strength);
      if (refs.strengthNum && document.activeElement !== refs.strengthNum) refs.strengthNum.value = String(obj.strength);
      if (refs.radius && document.activeElement !== refs.radius) refs.radius.value = String(obj.radius);
      if (refs.radiusNum && document.activeElement !== refs.radiusNum) refs.radiusNum.value = String(obj.radius);
      refs.polarity?.forEach((c) => c.button.setAttribute('aria-pressed', String(c.polarity === obj.polarity)));
    }
    if (obj?.type === 'teleport' && refs.group) refs.group.value = String(obj.group);
  };

  const renderTile = (course: Course, selected: TilePoint | null): void => {
    if (!selected) {
      if (tileKey !== '') tileBody.replaceChildren(el('p', { class: 'muted small ed-hint' }, t('editor.inspector.noTile')));
      tileKey = '';
      refs = null;
      return;
    }
    const obj = describeTile(course, selected).object;
    const key = `${selected.x},${selected.y},${obj?.type ?? '-'}`;
    if (key === tileKey && refs) {
      patchTile(course, selected);
      return;
    }
    tileKey = key;
    buildTile(course, selected);
  };
  tileBody.replaceChildren(el('p', { class: 'muted small ed-hint' }, t('editor.inspector.noTile')));

  // ---- validation ---------------------------------------------------------------------------------------------
  const summary = el('div', { class: 'ed-summary' });
  const issuesList = el('ul', { class: 'ed-issues' });
  const validationSection = el('section', { class: 'ed-section' }, el('h3', {}, t('editor.inspector.validation')), summary, issuesList);

  const renderIssues = (issues: readonly ValidationIssue[]): void => {
    const errors = issues.filter((i) => i.level === 'error').length;
    const warnings = issues.length - errors;
    summary.className = `ed-summary ${errors > 0 ? 'is-error' : warnings > 0 ? 'is-warning' : 'is-ok'}`;
    summary.textContent = issues.length === 0 ? t('editor.inspector.valid') : t('editor.inspector.summary', { errors, warnings });
    issuesList.replaceChildren();
    for (const issue of issues) {
      const hasTile = issue.x !== undefined && issue.y !== undefined;
      const text = el('span', { class: 'ed-issue__text' }, issueText(issue));
      const level = el('span', { class: `badge ${issue.level === 'error' ? 'badge--error' : 'badge--warn'}` },
        t(issue.level === 'error' ? 'validation.level.error' : 'validation.level.warning'));
      const row = hasTile
        ? el('button', { type: 'button', class: `ed-issue ed-issue--${issue.level} is-clickable`, title: t('editor.status.tile', { x: issue.x!, y: issue.y! }) }, level, text)
        : el('div', { class: `ed-issue ed-issue--${issue.level}` }, level, text);
      if (hasTile) row.addEventListener('click', () => host.focusTile({ x: issue.x!, y: issue.y! }));
      issuesList.append(el('li', {}, row));
    }
  };

  const root = el('div', { class: 'ed-inspector-inner' }, metaSection, tileSection, validationSection);

  const setIfIdle = (input: HTMLInputElement | HTMLTextAreaElement, value: string): void => {
    if (document.activeElement !== input && input.value !== value) input.value = value;
  };

  return {
    root,
    update(course, selected, issues) {
      setIfIdle(nameIn, course.name);
      setIfIdle(authorIn, course.author);
      setIfIdle(descIn, course.description);
      setIfIdle(parIn, String(course.rules.par));
      setIfIdle(strokesIn, String(course.rules.maxStrokes));
      renderTile(course, selected);
      renderIssues(issues);
    },
    destroy() {
      root.remove();
    },
  };
}
