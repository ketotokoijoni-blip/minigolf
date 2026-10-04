// Chat panel bound to a ChatApi (DESIGN §12.7). System lines are {key, params} localized here (D19).
import { MAX_CHAT_CHARS } from '@puttipeli/shared/protocol/limits';
import type { ChatApi, ChatMessage } from '../game/gameHost';
import { el, button } from './components';
import { t } from '../i18n/t';

export interface ChatHandle { focus(): void; destroy(): void }

function renderMessage(m: ChatMessage): HTMLElement {
  if (!m.from) {
    const text = m.key ? t(m.key, m.params) : (m.text ?? '');
    return el('div', { class: 'chat__msg chat__msg--system' }, text);
  }
  const from = el('span', { class: 'chat__from' }, m.from.name);
  from.style.setProperty('--player-colour', `var(--player-${m.from.colour})`);
  return el('div', { class: 'chat__msg' }, from, ': ', m.text ?? '');
}

export function mountChat(container: HTMLElement, api: ChatApi, opts: { collapsible?: boolean } = {}): ChatHandle {
  const messages = el('div', { class: 'chat__messages', role: 'log', 'aria-live': 'polite', 'aria-label': t('ui.chat.title') });
  const input = el('input', { type: 'text', placeholder: t('ui.chat.placeholder'), autocomplete: 'off', 'aria-label': t('ui.chat.title') });
  input.maxLength = MAX_CHAT_CHARS;
  const send = (): void => {
    const text = input.value.trim();
    if (!text) return;
    api.send(text.slice(0, MAX_CHAT_CHARS));
    input.value = '';
    input.focus();
  };
  const form = el('form', { class: 'chat__form' }, input, button(t('ui.chat.send'), send, { variant: 'small', type: 'submit' }));
  form.addEventListener('submit', (e) => { e.preventDefault(); send(); });

  const unread = el('span', { class: 'badge', hidden: true });
  const header = el('div', { class: 'chat__header' }, el('span', {}, t('ui.chat.title')), unread);
  const root = el('div', { class: 'chat' }, header, messages, form);

  let collapsed = false;
  let unreadCount = 0;
  let toggle: HTMLButtonElement | null = null;
  if (opts.collapsible) {
    toggle = button('–', () => setCollapsed(!collapsed), { variant: 'small', className: 'chat__toggle', title: t('ui.chat.collapse') });
    toggle.setAttribute('aria-expanded', 'true');
    header.append(toggle);
  }
  const setCollapsed = (v: boolean): void => {
    collapsed = v;
    root.classList.toggle('is-collapsed', v);
    if (toggle) {
      toggle.textContent = v ? '+' : '–';
      toggle.title = v ? t('ui.chat.expand') : t('ui.chat.collapse');
      toggle.setAttribute('aria-expanded', String(!v));
    }
    if (!v) { unreadCount = 0; unread.hidden = true; messages.scrollTop = messages.scrollHeight; }
  };

  let lastSeq = -1;
  let lastCount = -1;
  const render = (list: readonly ChatMessage[]): void => {
    const last = list[list.length - 1];
    const newest = last ? last.seq : -1;
    if (newest === lastSeq && list.length === lastCount) return;
    const nearBottom = messages.scrollHeight - messages.scrollTop - messages.clientHeight < 40;
    const added = lastSeq >= 0 ? list.filter((m) => m.seq > lastSeq).length : 0;
    lastSeq = newest;
    lastCount = list.length;
    messages.replaceChildren();
    if (list.length === 0) messages.append(el('div', { class: 'empty small' }, t('ui.chat.empty')));
    for (const m of list) messages.append(renderMessage(m));
    if (nearBottom || added > 0) messages.scrollTop = messages.scrollHeight;
    if (collapsed && added > 0) {
      unreadCount += added;
      unread.textContent = t('ui.chat.unread', { count: unreadCount });
      unread.hidden = false;
    }
  };

  render(api.messages());
  const unsubscribe = api.subscribe(render);
  container.append(root);

  return {
    focus() { if (collapsed) setCollapsed(false); input.focus(); },
    destroy() { unsubscribe(); root.remove(); },
  };
}
