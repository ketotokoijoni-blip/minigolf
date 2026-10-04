// Keyboard handling shared by the editor's own modals (library window, share/import code dialog): Escape closes,
// Tab cycles inside the box, Ctrl/Cmd+Enter submits. The listener sits on window rather than on the backdrop so it
// keeps working after the focus has moved to <body> (a click on the list background), and it only acts while this
// backdrop is the topmost .dialog-backdrop, because a WP-E confirm dialog may be stacked on top of it.

export interface ModalKeyOptions {
  onEscape(): void;
  /** Ctrl/Cmd+Enter; omitted = no submit shortcut (read-only dialog). */
  onSubmit?(): void;
}

const FOCUSABLE = 'button, input, textarea, select, a[href], [tabindex]:not([tabindex="-1"])';

export function isTopmostBackdrop(backdrop: HTMLElement): boolean {
  const all = document.querySelectorAll('.dialog-backdrop');
  return all.length > 0 && all[all.length - 1] === backdrop;
}

/** Installs the window keydown handler; returns the remover (call it from the modal's close()). */
export function installModalKeys(backdrop: HTMLElement, box: HTMLElement, opts: ModalKeyOptions): () => void {
  const focusables = (): HTMLElement[] =>
    Array.from(box.querySelectorAll<HTMLElement>(FOCUSABLE)).filter((n) => !(n as HTMLButtonElement).disabled);
  const onKey = (e: KeyboardEvent): void => {
    if (!backdrop.isConnected || !isTopmostBackdrop(backdrop)) return;
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); opts.onEscape(); return; }
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey) && opts.onSubmit) { e.preventDefault(); opts.onSubmit(); return; }
    if (e.key !== 'Tab') return;
    const f = focusables();
    if (f.length === 0) { e.preventDefault(); return; }
    const first = f[0]!;
    const last = f[f.length - 1]!;
    const activeEl = document.activeElement;
    if (!activeEl || !box.contains(activeEl)) { e.preventDefault(); (e.shiftKey ? last : first).focus(); return; }
    if (e.shiftKey && activeEl === first) { e.preventDefault(); last.focus(); }
    else if (!e.shiftKey && activeEl === last) { e.preventDefault(); first.focus(); }
  };
  window.addEventListener('keydown', onKey);
  return () => window.removeEventListener('keydown', onKey);
}
