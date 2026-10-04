// #/mp multiplayer menu (DESIGN §12.1): player name + colour, Luo huone, Liity huoneeseen (5-character code with
// normalizeRoomCode and paste support, Liity katsojana), recent rooms with "Palaa huoneeseen" when a session token
// exists, connection status text. Creating or joining constructs a RoomSession, makes it the active host and
// navigates to #/room/CODE on roomJoined.
//
// This module also installs the screen-independent end-of-session UX (DESIGN §10.8, §11.5, §12.1): when a joined
// RoomSession ends because the room closed, we were removed, the seat expired, the connection died for good or
// another tab resumed the session, a dialog appears whatever screen is mounted (the play view only knows GameHost)
// and leads back to #/mp.
import '../ui/mp.css';
import { DEFAULT_PLAYER_NAME, MAX_NAME_CHARS } from '@puttipeli/shared/constants';
import { ErrorCode } from '@puttipeli/shared/protocol/codes';
import { isRoomCode, normalizeRoomCode } from '@puttipeli/shared/protocol/roomCode';
import { registerScreen, type Screen, type ScreenContext } from '../app/screen';
import { navigate } from '../app/router';
import { getActiveHost, setActiveHost } from '../app/activeHost';
import { appStore, refreshServerStats, type AppState } from '../app/store';
import { getSettings, updateSettings, sanitizeName } from '../storage/settings';
import { el, button, list, field, colourPicker, checkbox } from '../ui/components';
import { alertDialog, confirmDialog } from '../ui/dialogs';
import { t, getLanguage } from '../i18n/t';
import { RoomSession, errorText, onAnySessionLeft, type JoinRequest, type LeftReason, type SessionStatus } from '../net/roomClient';
import { getSessionStore, codeFromInput } from '../net/session';

// ------------------------------------------------------------------------------------------------ session end UX

/**
 * Dialogs for a session that had joined a room and ended without the user asking for it. Sessions that never joined
 * are left to the screen that started them (#/mp status line, lobby join prompt), 'left' is the user's own action.
 */
function handleSessionEnd(s: RoomSession, reason: LeftReason, code?: ErrorCode): void {
  if (!s.hasJoined || reason === 'left' || reason === 'joinFailed') return;
  if (getActiveHost() === s) setActiveHost(null);
  const toMenu = (): void => navigate('#/mp');
  switch (reason) {
    case 'removed':
      void alertDialog(t('mp.removed'), { ok: t('mp.backToMenu') }).then(toMenu);
      return;
    case 'roomClosed':
      void alertDialog(t('mp.roomClosed'), { ok: t('mp.backToMenu') }).then(toMenu);
      return;
    case 'replaced':
      void alertDialog(t('mp.replaced'), { ok: t('mp.backToMenu') }).then(toMenu);
      return;
    case 'connectionClosed':
      if (code === ErrorCode.BAD_VERSION) void alertDialog(t('error.BAD_VERSION'), { reload: true });
      else void alertDialog(t('mp.connectionLost'), { ok: t('mp.backToMenu') }).then(toMenu);
      return;
    case 'sessionExpired': {
      // §11.5: the seat is gone; offer to watch the rest of the round as a spectator.
      const roomCode = s.code;
      const profile = s.currentProfile;
      void confirmDialog(t('mp.sessionExpired', { code: roomCode ?? '' }), { ok: t('mp.spectate'), cancel: t('mp.backToMenu') }).then((asSpectator) => {
        if (!asSpectator || !roomCode) { toMenu(); return; }
        const current = getActiveHost();
        if (current instanceof RoomSession && current.status !== 'left' && current.code === roomCode) { navigate(`#/room/${roomCode}`); return; }
        if (current) { try { current.leave(); } catch (err) { console.error('leave failed', err); } }
        setActiveHost(new RoomSession({ kind: 'join', code: roomCode, name: profile.name || DEFAULT_PLAYER_NAME, colour: profile.colour, asSpectator: true }));
        navigate(`#/room/${roomCode}`);
      });
      return;
    }
  }
}
onAnySessionLeft((s, reason, code) => handleSessionEnd(s, reason, code));

function formatDateTime(ms: number): string {
  try {
    return new Date(ms).toLocaleString(getLanguage() === 'fi' ? 'fi-FI' : 'en-GB', { dateStyle: 'short', timeStyle: 'short' });
  } catch {
    return '';
  }
}

function createMpScreen(): Screen {
  const sessions = getSessionStore();
  /** Session created from this screen until it has joined (then the lobby owns it). */
  let pending: RoomSession | null = null;
  let unsubs: (() => void)[] = [];
  let abort: AbortController | null = null;
  let offStore: (() => void) | null = null;

  const releasePending = (): void => {
    for (const off of unsubs) off();
    unsubs = [];
    pending = null;
  };

  return {
    mount(root, ctx: ScreenContext) {
      const settings = getSettings();
      let colour = settings.colour;
      let spectate = false;
      let busy = false;

      // ---- a session that is still alive (browser back from the lobby, or the play view's fallback route) ----
      const existing = getActiveHost();
      let activeCard: HTMLElement | null = null;
      if (existing instanceof RoomSession && existing.status !== 'left' && existing.hasJoined && existing.code) {
        const active = existing;
        const activeCode: string = existing.code;
        activeCard = el('section', { class: 'card stack mp-active' },
          el('h3', {}, t('mp.active.title', { code: activeCode })),
          el('p', { class: 'muted small' }, t('mp.active.hint')),
          el('div', { class: 'row' },
            button(t('mp.active.return'), () => ctx.navigate(`#/room/${activeCode}`), { primary: true }),
            button(t('mp.active.leave'), () => {
              active.leave();
              if (getActiveHost() === active) setActiveHost(null);
              activeCard?.remove();
              renderRecent();
            }, { variant: 'danger' })));
      } else if (existing) {
        // Anything else (a local round, a session that never joined) ends here: the menu is a clean start.
        try { existing.leave(); } catch (err) { console.error('leave failed', err); }
        setActiveHost(null);
      }

      // ---- server reachability hint (GET /api/stats through the WP-E store) ----
      const serverHint = el('p', { class: 'mp-server muted small', 'aria-live': 'polite' });
      const renderServer = (s: AppState): void => {
        serverHint.classList.toggle('is-offline', s.serverStatus === 'offline');
        if (s.serverStatus === 'online' && s.stats) serverHint.textContent = t('mp.status.online', { players: s.stats.players, rooms: s.stats.rooms });
        else if (s.serverStatus === 'offline') serverHint.textContent = t('mp.status.offline');
        else serverHint.textContent = t('mp.status.checking');
      };
      renderServer(appStore.get());
      offStore = appStore.subscribe(renderServer);
      abort = new AbortController();
      void refreshServerStats(abort.signal);

      // ---- status line ----
      const statusText = el('span', { class: 'mp-status__text' });
      const cancelBtn = button(t('mp.cancel'), () => cancelPending(), { variant: 'small' });
      cancelBtn.hidden = true;
      const status = el('div', { class: 'mp-status', role: 'status', 'aria-live': 'polite' }, statusText, cancelBtn);
      const setStatus = (text: string, kind: 'busy' | 'error' | 'none'): void => {
        statusText.textContent = text;
        status.classList.toggle('is-error', kind === 'error');
        status.classList.toggle('is-busy', kind === 'busy');
        cancelBtn.hidden = kind !== 'busy';
      };

      // ---- player ----
      const nameInput = el('input', { type: 'text', class: 'input', autocomplete: 'nickname', placeholder: DEFAULT_PLAYER_NAME, 'aria-required': 'true' });
      nameInput.maxLength = MAX_NAME_CHARS;
      nameInput.value = settings.name;
      const nameError = el('div', { class: 'field__error' }, t('mp.name.required'));
      nameError.hidden = true;
      nameInput.addEventListener('input', () => { nameError.hidden = true; });
      nameInput.addEventListener('change', () => {
        const n = sanitizeName(nameInput.value);
        nameInput.value = n;
        if (n) updateSettings({ name: n });
      });
      /** Sanitized name or null (with the inline error shown) when empty. */
      const currentName = (): string | null => {
        const n = sanitizeName(nameInput.value);
        if (!n) { nameError.hidden = false; nameInput.focus(); return null; }
        if (n !== getSettings().name) updateSettings({ name: n });
        return n;
      };
      const picker = colourPicker(colour, (c) => { colour = c; updateSettings({ colour: c }); }, [0, 1, 2, 3].map((c) => t(`colour.${c}`)));
      const profileCard = el('section', { class: 'card stack' },
        el('h3', {}, t('mp.player')),
        field(t('settings.name'), nameInput, { hint: t('settings.name.hint') }),
        nameError,
        el('div', { class: 'field' }, el('span', { class: 'field__label' }, t('settings.colour')), picker));

      // ---- create ----
      const createBtn = button(t('mp.create'), () => {
        const n = currentName();
        if (n) start({ kind: 'create', name: n, colour });
      }, { primary: true, className: 'btn--block' });
      const createCard = el('section', { class: 'card stack' },
        el('h3', {}, t('mp.create')),
        el('p', { class: 'muted small' }, t('mp.create.hint')),
        createBtn);

      // ---- join ----
      const codeInput = el('input', {
        type: 'text', class: 'input input--code', id: 'mp-code', autocomplete: 'off', autocapitalize: 'characters', spellcheck: 'false',
        placeholder: t('mp.join.code.placeholder'), 'aria-label': t('mp.join.code'),
      });
      codeInput.maxLength = 80; // room for a pasted link; normalized to the 5-character code on input
      const joinBtn = button(t('mp.join.button'), () => join(), { primary: true });
      const syncCode = (): void => {
        const v = codeFromInput(codeInput.value);
        if (codeInput.value !== v) codeInput.value = v;
        joinBtn.disabled = busy || !isRoomCode(v);
      };
      codeInput.addEventListener('input', syncCode);
      codeInput.addEventListener('paste', (e: ClipboardEvent) => {
        const text = e.clipboardData?.getData('text');
        if (!text) return;
        e.preventDefault();
        codeInput.value = codeFromInput(text);
        syncCode();
      });
      codeInput.addEventListener('keydown', (e: KeyboardEvent) => {
        if (e.key === 'Enter') { e.preventDefault(); join(); }
      });
      const spectateBox = checkbox(t('mp.spectate'), spectate, (v) => { spectate = v; });
      const join = (): void => {
        const code = codeFromInput(codeInput.value);
        if (!isRoomCode(code)) { codeInput.focus(); return; }
        const n = currentName();
        if (!n) return;
        start({ kind: 'join', code, name: n, colour, asSpectator: spectate });
      };
      const joinCard = el('section', { class: 'card stack' },
        el('h3', {}, t('mp.join')),
        el('div', { class: 'field' },
          el('label', { for: 'mp-code' }, t('mp.join.code')),
          el('div', { class: 'row mp-code-row' }, codeInput, joinBtn),
          el('div', { class: 'field__hint' }, t('mp.join.code.hint'))),
        spectateBox,
        el('p', { class: 'muted small' }, t('mp.spectate.hint')));
      syncCode();

      // ---- recent rooms ----
      const recentList = el('ul', { class: 'list' });
      const renderRecent = (): void => {
        list(recentList, sessions.listRecent(), (r) => {
          const stored = sessions.getSession(r.code);
          const actions = el('div', { class: 'list-item__actions' });
          if (stored) {
            actions.append(button(t('mp.recent.return'), () => start({
              kind: 'rejoin', code: r.code, token: stored.token,
              name: stored.name || sanitizeName(nameInput.value) || DEFAULT_PLAYER_NAME, colour: stored.colour,
            }), { variant: 'small', primary: true }));
          } else {
            actions.append(button(t('mp.recent.join'), () => {
              const n = currentName();
              if (n) start({ kind: 'join', code: r.code, name: n, colour, asSpectator: spectate });
            }, { variant: 'small' }));
          }
          actions.append(button('✕', () => { sessions.forgetRecent(r.code); sessions.clearSession(r.code); renderRecent(); }, { variant: 'small', title: t('mp.recent.forget') }));
          return el('li', { class: 'list-item' },
            el('div', { class: 'list-item__body' },
              el('div', { class: 'room-code room-code--small' }, r.code),
              el('div', { class: 'list-item__meta' }, r.at ? t('mp.recent.at', { date: formatDateTime(r.at) }) : '')),
            actions);
        }, t('mp.recent.empty'));
        if (busy) recentList.querySelectorAll('button').forEach((b) => { b.disabled = true; });
      };
      renderRecent();
      const recentCard = el('section', { class: 'card stack' }, el('h3', {}, t('mp.recent')), recentList);

      // ---- session start / failure handling ----
      const setBusy = (b: boolean): void => {
        busy = b;
        createBtn.disabled = b;
        syncCode();
        recentList.querySelectorAll('button').forEach((x) => { x.disabled = b; });
      };
      const statusFor = (s: SessionStatus, kind: JoinRequest['kind']): string => {
        switch (s) {
          case 'connecting': return t('mp.status.connecting');
          case 'reconnecting': return t('mp.status.reconnecting');
          case 'joining': return kind === 'create' ? t('mp.status.creating') : t('mp.status.joining');
          case 'rejoining': return t('mp.status.rejoining');
          default: return '';
        }
      };
      function start(req: JoinRequest): void {
        if (busy) return;
        releasePending();
        // A live session (the "Olet huoneessa" card) is left properly first, like the main menu does (§12.1), so
        // the seat and the name are released instead of lingering as a disconnected member through the grace period.
        // Resuming the very room that is still live only needs navigation.
        const live = getActiveHost();
        if (live instanceof RoomSession && live.status !== 'left') {
          if (req.kind !== 'create' && live.hasJoined && live.code === normalizeRoomCode(req.code)) { ctx.navigate(`#/room/${live.code}`); return; }
          live.leave();
          if (getActiveHost() === live) setActiveHost(null);
          activeCard?.remove();
          activeCard = null;
        }
        const s = new RoomSession(req);
        pending = s;
        setActiveHost(s);
        setBusy(true);
        setStatus(statusFor(s.status, req.kind), 'busy');
        unsubs.push(
          s.onStatus((st) => { if (st !== 'joined' && st !== 'left') setStatus(statusFor(st, req.kind), 'busy'); }),
          s.onJoined((info) => {
            releasePending();
            setStatus('', 'none');
            ctx.navigate(`#/room/${info.code}`);
          }),
          s.onError((code) => {
            if (code === ErrorCode.BAD_VERSION) void alertDialog(t('error.BAD_VERSION'), { reload: true });
          }),
          s.onLeft((reason, code, message) => {
            releasePending();
            if (getActiveHost() === s) setActiveHost(null);
            setBusy(false);
            renderRecent();
            if (reason === 'joinFailed' || reason === 'sessionExpired') {
              setStatus(code ? errorText(code, message) : t('mp.connectionLost'), 'error');
              if (code === ErrorCode.NAME_TAKEN) nameInput.focus();
              else if (code === ErrorCode.ROOM_NOT_FOUND) codeInput.focus();
            } else if (reason === 'connectionClosed') {
              setStatus(code === ErrorCode.BAD_VERSION ? t('error.BAD_VERSION') : t('mp.connectionLost'), 'error');
            } else if (reason === 'replaced') {
              setStatus(t('mp.replaced'), 'error');
            } else {
              setStatus('', 'none');
            }
          }),
        );
      }
      const cancelPending = (): void => {
        const s = pending;
        releasePending();
        if (s) {
          if (getActiveHost() === s) setActiveHost(null); // destroys it
          else s.destroy();
        }
        setBusy(false);
        setStatus('', 'none');
      };

      root.append(el('div', { class: 'screen screen--narrow mp' },
        el('header', { class: 'screen-header' }, button(t('common.back'), () => ctx.navigate('#/')), el('h1', {}, t('mp.title'))),
        serverHint,
        activeCard,
        profileCard,
        el('div', { class: 'mp-grid' }, createCard, joinCard),
        recentCard,
        status));
      if (!nameInput.value) nameInput.focus();
      else if (!activeCard) codeInput.focus();
    },

    unmount() {
      abort?.abort();
      abort = null;
      offStore?.();
      offStore = null;
      const s = pending;
      releasePending();
      // A session that has not joined yet is abandoned when the user navigates elsewhere.
      if (s && !s.hasJoined) {
        if (getActiveHost() === s) setActiveHost(null);
        else s.destroy();
      }
    },
  };
}

registerScreen('#/mp', createMpScreen);
