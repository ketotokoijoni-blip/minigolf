// Small DOM building blocks shared by every screen (DESIGN §12.7). No framework: plain elements, plain listeners.

export type Attrs = Record<string, string | boolean | ((e: Event) => void)>;

/**
 * Create an element. Attribute rules: a function value for a key starting with "on" becomes a listener
 * (`onclick` -> 'click'); `true` sets an empty attribute, `false` skips it; everything else is a string attribute.
 * `class` and `className` both set the class list.
 */
export function el<K extends keyof HTMLElementTagNameMap>(
  tag: K,
  attrs?: Attrs,
  ...children: (Node | string | null | undefined | false)[]
): HTMLElementTagNameMap[K] {
  const node = document.createElement(tag);
  if (attrs) {
    for (const [key, value] of Object.entries(attrs)) {
      if (typeof value === 'function') {
        if (key.startsWith('on')) node.addEventListener(key.slice(2).toLowerCase(), value);
        continue;
      }
      if (value === false || value === undefined) continue;
      if (key === 'className' || key === 'class') node.className = String(value);
      else if (value === true) node.setAttribute(key, '');
      else node.setAttribute(key, value);
    }
  }
  for (const child of children) {
    if (child === null || child === undefined || child === false) continue;
    node.append(typeof child === 'string' ? document.createTextNode(child) : child);
  }
  return node;
}

export interface ButtonOpts {
  primary?: boolean;
  disabled?: boolean;
  title?: string;
  /** Extra visual variant. */
  variant?: 'danger' | 'ghost' | 'small' | 'icon';
  /** Extra class names. */
  className?: string;
  type?: 'button' | 'submit';
}

export function button(label: string, onClick: () => void, opts: ButtonOpts = {}): HTMLButtonElement {
  const classes = ['btn'];
  if (opts.primary) classes.push('btn--primary');
  if (opts.variant) classes.push(`btn--${opts.variant}`);
  if (opts.className) classes.push(opts.className);
  const b = el('button', { type: opts.type ?? 'button', class: classes.join(' ') }, label);
  if (opts.disabled) b.disabled = true;
  if (opts.title) b.title = opts.title;
  b.addEventListener('click', (e) => {
    e.preventDefault();
    if (!b.disabled) onClick();
  });
  return b;
}

/** Render an array into a container, replacing previous children. Returns the container for chaining. */
export function list<T>(container: HTMLElement, items: readonly T[], render: (item: T, index: number) => Node, empty?: string): HTMLElement {
  container.replaceChildren();
  if (items.length === 0) {
    if (empty) container.append(el('div', { class: 'empty' }, empty));
    return container;
  }
  items.forEach((item, i) => container.append(render(item, i)));
  return container;
}

let toastHost: HTMLElement | null = null;

/** Transient notification at the bottom of the page; never blocks. */
export function toast(text: string, kind: 'info' | 'error' = 'info', ms = kind === 'error' ? 5000 : 3000): void {
  if (typeof document === 'undefined') return;
  if (!toastHost || !toastHost.isConnected) {
    toastHost = el('div', { class: 'toasts', role: 'status', 'aria-live': 'polite' });
    document.body.append(toastHost);
  }
  const node = el('div', { class: `toast toast--${kind}` }, text);
  toastHost.append(node);
  while (toastHost.childElementCount > 4) toastHost.firstElementChild?.remove();
  window.setTimeout(() => {
    node.classList.add('is-leaving');
    window.setTimeout(() => node.remove(), 220);
  }, ms);
}

/** Labelled form field wrapper. */
export function field(labelText: string, control: HTMLElement, opts: { hint?: string; inline?: boolean; id?: string } = {}): HTMLElement {
  const id = opts.id ?? control.id ?? `f_${Math.random().toString(36).slice(2, 8)}`;
  control.id = id;
  const label = el('label', { for: id }, labelText);
  const wrap = el('div', { class: opts.inline ? 'field field--inline' : 'field' }, label, control);
  if (opts.hint) wrap.append(el('div', { class: 'field__hint' }, opts.hint));
  return wrap;
}

/** Checkbox with a text label. */
export function checkbox(labelText: string, checked: boolean, onChange: (checked: boolean) => void): HTMLLabelElement {
  const input = el('input', { type: 'checkbox' });
  input.checked = checked;
  input.addEventListener('change', () => onChange(input.checked));
  return el('label', { class: 'check' }, input, el('span', {}, labelText));
}

export interface TabDef { id: string; label: string; render(panel: HTMLElement): void }

/** Accessible tab strip. Returns the container plus a `select(id)` method. */
export function tabs(defs: readonly TabDef[], initial?: string): { root: HTMLElement; select(id: string): void; current(): string } {
  const strip = el('div', { class: 'tabs', role: 'tablist' });
  const panel = el('div', { class: 'tabpanel', role: 'tabpanel' });
  const root = el('div', { class: 'tabs-wrap' }, strip, panel);
  let currentId = initial && defs.some((d) => d.id === initial) ? initial : (defs[0]?.id ?? '');
  const buttons = new Map<string, HTMLButtonElement>();
  const select = (id: string): void => {
    const def = defs.find((d) => d.id === id);
    if (!def) return;
    currentId = id;
    buttons.forEach((b, key) => {
      b.setAttribute('aria-selected', String(key === id));
      b.tabIndex = key === id ? 0 : -1;
    });
    panel.replaceChildren();
    def.render(panel);
  };
  defs.forEach((def) => {
    const b = el('button', { type: 'button', class: 'tab', role: 'tab', id: `tab-${def.id}` }, def.label);
    b.addEventListener('click', () => select(def.id));
    b.addEventListener('keydown', (e: KeyboardEvent) => {
      const ids = defs.map((d) => d.id);
      const i = ids.indexOf(currentId);
      if (e.key === 'ArrowRight') select(ids[(i + 1) % ids.length]!);
      else if (e.key === 'ArrowLeft') select(ids[(i - 1 + ids.length) % ids.length]!);
      else return;
      buttons.get(currentId)?.focus();
      e.preventDefault();
    });
    buttons.set(def.id, b);
    strip.append(b);
  });
  if (currentId) select(currentId);
  return { root, select, current: () => currentId };
}

/** Player colour chooser (0..3) as a radio group with a roving tabindex: arrows move the selection, like tabs(). */
export function colourPicker(value: number, onChange: (colour: 0 | 1 | 2 | 3) => void, labels: readonly string[]): HTMLElement {
  const group = el('div', { class: 'colour-picker', role: 'radiogroup' });
  const swatches: HTMLButtonElement[] = [];
  let current = value >= 0 && value < 4 ? value : 0;
  const pick = (c: number): void => {
    current = c;
    swatches.forEach((s, i) => {
      s.setAttribute('aria-checked', String(i === c));
      s.tabIndex = i === c ? 0 : -1;
    });
    onChange(c as 0 | 1 | 2 | 3);
  };
  for (let c = 0; c < 4; c++) {
    const b = el('button', { type: 'button', class: 'colour-swatch', role: 'radio', 'aria-label': labels[c] ?? String(c), title: labels[c] ?? '' });
    b.style.setProperty('--player-colour', `var(--player-${c})`);
    b.setAttribute('aria-checked', String(c === current));
    b.tabIndex = c === current ? 0 : -1;
    b.addEventListener('click', () => pick(c));
    b.addEventListener('keydown', (e: KeyboardEvent) => {
      if (e.key === 'ArrowRight' || e.key === 'ArrowDown') pick((current + 1) % 4);
      else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') pick((current + 3) % 4);
      else return;
      swatches[current]?.focus();
      e.preventDefault();
    });
    swatches.push(b);
    group.append(b);
  }
  return group;
}

/** Simple `<select>` bound to a value list. */
export function select<T extends string>(options: readonly { value: T; label: string }[], value: T, onChange: (v: T) => void): HTMLSelectElement {
  const s = el('select');
  for (const o of options) {
    const opt = el('option', { value: o.value }, o.label);
    if (o.value === value) opt.selected = true;
    s.append(opt);
  }
  s.addEventListener('change', () => onChange(s.value as T));
  return s;
}
