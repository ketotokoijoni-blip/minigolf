// In-page modal dialogs (DESIGN §12.7). Never window.confirm/alert/prompt. Focus is trapped inside the dialog and
// restored to the previously focused element when it closes. Escape cancels.
import { el, button } from './components';
import { t } from '../i18n/t';

interface DialogButton { label: string; primary?: boolean; danger?: boolean; onClick(): void }

interface DialogSpec {
  text: string;
  buttons: DialogButton[];
  /** Optional input row (promptDialog). */
  input?: { initial: string; maxLength?: number; onInput(value: string): void; onEnter(): void };
  onEscape(): void;
}

let openCount = 0;

function openDialog(spec: DialogSpec): { close(): void; setError(msg: string | null): void } {
  const previous = document.activeElement as HTMLElement | null;
  const textNode = el('div', { class: 'dialog__text', id: `dlg-text-${++openCount}` }, spec.text);
  const errorNode = el('div', { class: 'dialog__error', 'aria-live': 'polite' });
  const actions = el('div', { class: 'dialog__actions' });
  const box = el('div', { class: 'dialog', role: 'dialog', 'aria-modal': 'true', 'aria-describedby': textNode.id }, textNode);
  const backdrop = el('div', { class: 'dialog-backdrop' }, box);

  let inputEl: HTMLInputElement | null = null;
  if (spec.input) {
    inputEl = el('input', { type: 'text', class: 'input', autocomplete: 'off', spellcheck: 'false' });
    inputEl.value = spec.input.initial;
    if (spec.input.maxLength) inputEl.maxLength = spec.input.maxLength;
    const { onInput, onEnter } = spec.input;
    inputEl.addEventListener('input', () => onInput(inputEl!.value));
    inputEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') { e.preventDefault(); onEnter(); } });
    box.append(inputEl, errorNode);
  }

  const buttonEls = spec.buttons.map((b) => button(b.label, b.onClick, { primary: b.primary, variant: b.danger ? 'danger' : undefined }));
  actions.append(...buttonEls);
  box.append(actions);

  const focusables = (): HTMLElement[] => Array.from(box.querySelectorAll<HTMLElement>('button, input')).filter((n) => !(n as HTMLButtonElement).disabled);
  const onKey = (e: KeyboardEvent): void => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); spec.onEscape(); return; }
    if (e.key === 'Tab') {
      const f = focusables();
      if (f.length === 0) return;
      const first = f[0]!;
      const last = f[f.length - 1]!;
      if (e.shiftKey && document.activeElement === first) { e.preventDefault(); last.focus(); }
      else if (!e.shiftKey && document.activeElement === last) { e.preventDefault(); first.focus(); }
    }
  };
  backdrop.addEventListener('keydown', onKey);
  backdrop.addEventListener('mousedown', (e) => { if (e.target === backdrop) spec.onEscape(); });

  document.body.append(backdrop);
  document.body.style.overflow = 'hidden';
  const primary = buttonEls.find((b) => b.classList.contains('btn--primary'));
  (inputEl ?? primary ?? buttonEls[0])?.focus();
  if (inputEl) inputEl.select();

  return {
    close() {
      backdrop.remove();
      if (!document.querySelector('.dialog-backdrop')) document.body.style.overflow = '';
      if (previous && previous.isConnected) previous.focus();
    },
    setError(msg) {
      errorNode.textContent = msg ?? '';
      if (inputEl) inputEl.setAttribute('aria-invalid', msg ? 'true' : 'false');
    },
  };
}

export function confirmDialog(text: string, opts: { ok?: string; cancel?: string; danger?: boolean } = {}): Promise<boolean> {
  return new Promise((resolve) => {
    const finish = (v: boolean): void => { dlg.close(); resolve(v); };
    const dlg = openDialog({
      text,
      buttons: [
        { label: opts.cancel ?? t('common.cancel'), onClick: () => finish(false) },
        { label: opts.ok ?? t('common.ok'), primary: !opts.danger, danger: opts.danger, onClick: () => finish(true) },
      ],
      onEscape: () => finish(false),
    });
  });
}

export function alertDialog(text: string, opts: { ok?: string; reload?: boolean } = {}): Promise<void> {
  return new Promise((resolve) => {
    const finish = (): void => {
      dlg.close();
      resolve();
      if (opts.reload) window.location.reload();
    };
    const dlg = openDialog({
      text,
      buttons: [{ label: opts.ok ?? (opts.reload ? t('common.reload') : t('common.ok')), primary: true, onClick: finish }],
      onEscape: finish,
    });
  });
}

export function promptDialog(
  text: string,
  opts: { initial?: string; maxLength?: number; validate?: (s: string) => string | null; ok?: string; cancel?: string } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    let value = opts.initial ?? '';
    const validate = (v: string): string | null => {
      if (opts.maxLength && v.length > opts.maxLength) return t('dialog.tooLong', { max: opts.maxLength });
      return opts.validate ? opts.validate(v) : null;
    };
    const submit = (): void => {
      const err = validate(value);
      if (err) { dlg.setError(err); return; }
      dlg.close();
      resolve(value);
    };
    const cancel = (): void => { dlg.close(); resolve(null); };
    const dlg = openDialog({
      text,
      input: {
        initial: value,
        maxLength: opts.maxLength,
        onInput: (v) => { value = v; dlg.setError(null); },
        onEnter: submit,
      },
      buttons: [
        { label: opts.cancel ?? t('common.cancel'), onClick: cancel },
        { label: opts.ok ?? t('common.ok'), primary: true, onClick: submit },
      ],
      onEscape: cancel,
    });
  });
}
