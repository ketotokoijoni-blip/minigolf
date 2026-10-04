// #/room/:code lobby (DESIGN §12.1, §12.5): room code + Kopioi linkki, players (host crown, ready, connection, AFK),
// spectators, chat with localized system lines, host panel (course set editor over the built-ins, the local library
// and received custom courses; settings incl. the greyed "Pallojen törmäys"), Aloita peli with its reason text,
// Valmis for other players, Liity pelaajaksi for spectators, Poistu. A deep link without an active session shows an
// inline name prompt (a stored token rejoins first). When the room enters countdown/hole the lobby navigates to
// #/game; in roundSummary it shows the results with Takaisin aulaan (host) and Valmis (players).
import '../ui/mp.css';
import { DEFAULT_PLAYER_NAME, MAX_COURSES_PER_SET, MAX_NAME_CHARS } from '@puttipeli/shared/constants';
import { BUILTIN_COURSES } from '@puttipeli/shared/course/builtin';
import { isBuiltinId } from '@puttipeli/shared/course/canonical';
import { decodeLayers } from '@puttipeli/shared/course/parse';
import type { Course, CourseLayers, ValidationIssue } from '@puttipeli/shared/course/types';
import type { GameState, PlayerColour, PlayerState, RoomSettings } from '@puttipeli/shared/game/types';
import { ErrorCode } from '@puttipeli/shared/protocol/codes';
import { isRoomCode, normalizeRoomCode } from '@puttipeli/shared/protocol/roomCode';
import { registerScreen, type Screen, type ScreenContext } from '../app/screen';
import { getActiveHost, setActiveHost } from '../app/activeHost';
import { getSettings, updateSettings, sanitizeName } from '../storage/settings';
import { listCoursesWithIssues, saveCourse, onLibraryChange, issueMessage, type ValidatedEntry } from '../storage/courseLibrary';
import { drawCourseThumbnail } from '../render/renderer';
import { renderScorecard } from '../ui/scorecard';
import { mountChat, type ChatHandle } from '../ui/chat';
import { el, button, list, field, colourPicker, checkbox, select, toast } from '../ui/components';
import { alertDialog, confirmDialog } from '../ui/dialogs';
import { t } from '../i18n/t';
import { RoomSession, coursesToRefs, errorText, startBlockReason, type JoinRequest, type LeftReason, type SessionStatus } from '../net/roomClient';
import { getSessionStore, roomLink } from '../net/session';

/** Backing-store scale of list thumbnails (shown at 98x50 CSS px; 0.4 => 294x150 stays crisp on HiDPI). */
const THUMB_SCALE = 0.4;
const TURN_TIMEOUTS: readonly RoomSettings['turnTimeoutSec'][] = [0, 30, 45, 60];
const HOLE_SUMMARIES: readonly RoomSettings['holeSummarySec'][] = [0, 3, 6, 10];
const MAX_PLAYERS_OPTIONS: readonly RoomSettings['maxPlayers'][] = [2, 3, 4];
/** Original crown mark for the host. */
const CROWN_SVG = '<svg viewBox="0 0 24 24" aria-hidden="true" focusable="false"><path fill="currentColor" d="M3 8.5l4.6 3.9L12 5.5l4.4 6.9L21 8.5 19.2 19H4.8z"/><rect x="5" y="19.5" width="14" height="1.6" rx="0.8" fill="currentColor" opacity="0.7"/></svg>';

const layersCache = new WeakMap<Course, CourseLayers | null>();

/** Course thumbnail drawn by WP-D's renderer; a course that cannot be decoded gets an empty swatch. */
function thumbnail(course: Course): HTMLCanvasElement {
  let layers = layersCache.get(course);
  if (layers === undefined) {
    try { layers = decodeLayers(course); } catch { layers = null; }
    layersCache.set(course, layers);
  }
  const canvas = el('canvas', { class: 'thumb', 'aria-hidden': 'true' });
  if (layers) {
    try {
      drawCourseThumbnail(canvas, layers, null, THUMB_SCALE);
      return canvas;
    } catch { /* fall through */ }
  }
  canvas.classList.add('is-broken');
  return canvas;
}

async function copyText(text: string, okMessage: string): Promise<void> {
  try {
    if (typeof navigator !== 'undefined' && navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      toast(okMessage);
      return;
    }
  } catch { /* insecure origin or denied: try the legacy path */ }
  try {
    const ta = el('textarea', { class: 'sr-only', readonly: true, 'aria-hidden': 'true' });
    ta.value = text;
    document.body.append(ta);
    ta.select();
    const ok = document.execCommand('copy');
    ta.remove();
    if (ok) { toast(okMessage); return; }
  } catch { /* ignore */ }
  toast(t('lobby.copyFailed', { link: text }), 'error', 8000);
}

const colourDot = (colour: PlayerColour, cls = 'seat__dot'): HTMLElement => {
  const dot = el('span', { class: cls, 'aria-hidden': 'true' });
  dot.style.setProperty('--player-colour', `var(--player-${colour})`);
  return dot;
};

const timeoutLabel = (s: number): string => (s === 0 ? t('lobby.settings.turnTimeout.none') : t('lobby.settings.seconds', { s }));
const summaryLabel = (s: number): string => (s === 0 ? t('lobby.settings.holeSummary.wait') : t('lobby.settings.seconds', { s }));
const parLabel = (c: Course): string => t('lobby.courses.par', { par: c.rules.par });

// ------------------------------------------------------------------------------------------------ panels

function seatRow(s: RoomSession, state: GameState, p: PlayerState): HTMLElement {
  const isHost = state.hostId === p.id;
  const classes = ['seat'];
  if (s.isMe(p.id)) classes.push('is-me');
  if (!p.connected) classes.push('is-offline');
  const name = el('span', { class: 'seat__name' }, p.name);
  if (s.isMe(p.id)) name.append(el('span', { class: 'seat__you' }, ` (${t('lobby.you')})`));
  const row = el('li', { class: classes.join(' ') }, colourDot(p.colour), name);
  if (isHost) {
    const crown = el('span', { class: 'seat__host', title: t('lobby.host') });
    crown.innerHTML = CROWN_SVG;
    crown.append(t('lobby.host'));
    row.append(crown);
  }
  if (p.afk) row.append(el('span', { class: 'badge badge--warn' }, t('lobby.afk')));
  const connLabel = p.connected ? t('lobby.online') : t('lobby.offline');
  row.append(el('span', { class: `seat__conn ${p.connected ? 'is-online' : 'is-offline'}`, title: connLabel, role: 'img', 'aria-label': connLabel }));
  if (!isHost) row.append(el('span', { class: `seat__ready${p.ready ? ' is-ready' : ''}` }, p.ready ? t('lobby.ready') : t('lobby.notReady')));
  return row;
}

function playersCard(s: RoomSession, state: GameState): HTMLElement {
  const max = state.settings.maxPlayers;
  const seats = el('ul', { class: 'seats', 'aria-label': t('lobby.players', { count: state.players.length, max }) });
  for (const p of state.players) seats.append(seatRow(s, state, p));
  for (let i = state.players.length; i < max; i++) seats.append(el('li', { class: 'seat seat--free' }, t('lobby.seat.free')));
  return el('section', { class: 'card stack' }, el('h3', {}, t('lobby.players', { count: state.players.length, max })), seats);
}

function spectatorsCard(s: RoomSession, state: GameState): HTMLElement {
  const items = el('ul', { class: 'spectator-list' });
  list(items, state.spectators, (sp) => el('li', { class: `spectator${s.isMe(sp.id) ? ' is-me' : ''}` },
    sp.name, s.isMe(sp.id) ? el('span', { class: 'seat__you' }, ` (${t('lobby.you')})`) : null), t('lobby.spectators.none'));
  return el('section', { class: 'card stack' }, el('h3', {}, t('lobby.spectators', { count: state.spectators.length })), items);
}

function settingsCard(s: RoomSession, state: GameState): HTMLElement {
  const editable = s.isHost && state.phase === 'lobby';
  const st = state.settings;
  const rows = el('div', { class: 'settings-rows' });
  const row = (label: string, control: Node, disabled = false): HTMLElement =>
    el('div', { class: `setting-row${disabled ? ' is-disabled' : ''}` }, el('span', { class: 'setting-row__label' }, label), control);
  const value = (text: string): HTMLElement => el('span', { class: 'setting-row__value' }, text);
  const minPlayers = Math.max(2, state.players.length);
  if (editable) {
    const maxSel = select(MAX_PLAYERS_OPTIONS.map((n) => ({ value: String(n), label: String(n) })), String(st.maxPlayers),
      (v) => { s.setSettings({ maxPlayers: Number(v) as RoomSettings['maxPlayers'] }); });
    for (const o of Array.from(maxSel.options)) o.disabled = Number(o.value) < minPlayers;
    maxSel.setAttribute('aria-label', t('lobby.settings.maxPlayers'));
    const timeoutSel = select(TURN_TIMEOUTS.map((n) => ({ value: String(n), label: timeoutLabel(n) })), String(st.turnTimeoutSec),
      (v) => { s.setSettings({ turnTimeoutSec: Number(v) as RoomSettings['turnTimeoutSec'] }); });
    timeoutSel.setAttribute('aria-label', t('lobby.settings.turnTimeout'));
    const summarySel = select(HOLE_SUMMARIES.map((n) => ({ value: String(n), label: summaryLabel(n) })), String(st.holeSummarySec),
      (v) => { s.setSettings({ holeSummarySec: Number(v) as RoomSettings['holeSummarySec'] }); });
    summarySel.setAttribute('aria-label', t('lobby.settings.holeSummary'));
    rows.append(row(t('lobby.settings.maxPlayers'), maxSel), row(t('lobby.settings.turnTimeout'), timeoutSel), row(t('lobby.settings.holeSummary'), summarySel));
  } else {
    rows.append(
      row(t('lobby.settings.maxPlayers'), value(String(st.maxPlayers))),
      row(t('lobby.settings.turnTimeout'), value(timeoutLabel(st.turnTimeoutSec))),
      row(t('lobby.settings.holeSummary'), value(summaryLabel(st.holeSummarySec))));
  }
  // Reserved for a later version (D20): shown greyed with "tulossa".
  const collision = el('input', { type: 'checkbox', disabled: true, 'aria-label': t('lobby.settings.ballCollision') });
  collision.checked = false;
  rows.append(row(t('lobby.settings.ballCollision'), el('span', { class: 'row' }, collision, el('span', { class: 'badge' }, t('common.comingSoon'))), true));
  const card = el('section', { class: 'card stack' }, el('h3', {}, t('lobby.settings')), rows);
  if (!editable && state.phase === 'lobby') card.append(el('p', { class: 'muted small' }, t('lobby.settings.readonly')));
  return card;
}

/** `library` is the validated local library, loaded once per bind() and refreshed by onLibraryChange (not per event). */
function coursesCard(s: RoomSession, state: GameState, library: readonly ValidatedEntry[]): HTMLElement {
  const editable = s.isHost && state.phase === 'lobby';
  const courses = state.courses;
  const libraryIds = new Set(library.map((e) => e.course.id));
  const update = (next: Course[]): void => {
    if (next.length > MAX_COURSES_PER_SET) { toast(t('lobby.courses.tooMany', { max: MAX_COURSES_PER_SET }), 'error'); return; }
    if (next.length < 1) { toast(t('lobby.courses.atLeastOne'), 'error'); return; }
    s.setCourses(coursesToRefs(next));
  };
  const move = (i: number, d: number): void => {
    const j = i + d;
    if (j < 0 || j >= courses.length) return;
    const next = courses.slice();
    [next[i], next[j]] = [next[j]!, next[i]!];
    update(next);
  };
  const rows = el('ul', { class: 'list course-list' });
  list(rows, courses, (course, i) => {
    const custom = !isBuiltinId(course.id);
    const meta = [parLabel(course)];
    if (custom) meta.push(t('lobby.courses.custom.tag'));
    if (course.author) meta.push(t('lobby.courses.author', { author: course.author }));
    const actions = el('div', { class: 'list-item__actions' });
    if (custom) {
      // Every participant may keep a received custom course (§11.6).
      if (libraryIds.has(course.id)) actions.append(el('span', { class: 'badge badge--ok' }, t('lobby.courses.inLibrary')));
      else actions.append(button(t('lobby.courses.save'), () => { saveCourse(course); toast(t('lobby.courses.saved', { name: course.name })); }, { variant: 'small' }));
    }
    if (editable) {
      actions.append(
        button('↑', () => move(i, -1), { variant: 'small', title: t('lobby.courses.moveUp'), disabled: i === 0 }),
        button('↓', () => move(i, 1), { variant: 'small', title: t('lobby.courses.moveDown'), disabled: i === courses.length - 1 }),
        button('✕', () => update(courses.filter((_, k) => k !== i)), { variant: 'small', title: t('lobby.courses.remove'), disabled: courses.length <= 1 }));
    }
    return el('li', { class: 'list-item list-item--compact' },
      el('span', { class: 'order-num' }, `${i + 1}.`),
      thumbnail(course),
      el('div', { class: 'list-item__body' }, el('div', { class: 'list-item__title' }, course.name), el('div', { class: 'list-item__meta' }, meta.join(' · '))),
      actions);
  }, t('lobby.start.INVALID_COURSE'));
  const card = el('section', { class: 'card stack' }, el('h3', {}, t('lobby.courses', { count: courses.length, max: MAX_COURSES_PER_SET })), rows);
  if (editable) {
    const builtinOptions = [
      { value: '', label: t('lobby.courses.add.builtin') },
      { value: '*', label: t('lobby.courses.add.all') },
      ...BUILTIN_COURSES.map((c, i) => ({ value: c.id, label: `${i + 1}. ${c.name} · ${parLabel(c)}` })),
    ];
    const addBuiltin = select(builtinOptions, '', (v) => {
      if (v === '*') update([...courses, ...BUILTIN_COURSES]);
      else if (v) { const c = BUILTIN_COURSES.find((x) => x.id === v); if (c) update([...courses, c]); }
      addBuiltin.value = '';
    });
    addBuiltin.setAttribute('aria-label', t('lobby.courses.add.builtin'));
    const customOptions = [
      { value: '', label: library.length ? t('lobby.courses.add.custom') : t('lobby.courses.custom.none') },
      ...library.map((e) => ({ value: e.key, label: e.valid ? `${e.course.name} · ${parLabel(e.course)}` : `${e.course.name} (${t('common.errors')})` })),
    ];
    const addCustom = select(customOptions, '', (v) => {
      const e = library.find((x) => x.key === v);
      if (e && e.valid) update([...courses, e.course]);
      addCustom.value = '';
    });
    for (const o of Array.from(addCustom.options)) {
      const e = library.find((x) => x.key === o.value);
      if (e && !e.valid) o.disabled = true;
    }
    addCustom.disabled = library.length === 0;
    addCustom.setAttribute('aria-label', t('lobby.courses.add.custom'));
    card.append(el('div', { class: 'row course-add' }, addBuiltin, addCustom));
  }
  return card;
}

function actionsRow(s: RoomSession, state: GameState): HTMLElement {
  const row = el('div', { class: 'card lobby-actions' });
  if (s.isSpectator) {
    row.append(el('span', { class: 'start-reason' }, t('lobby.spectating')));
    if (state.players.length < state.settings.maxPlayers) row.append(button(t('lobby.becomePlayer'), () => { s.becomePlayer(); }, { primary: true }));
    return row;
  }
  if (s.isHost) {
    const reason = startBlockReason(state);
    row.append(
      button(t('lobby.start'), () => { s.startGame(); }, { primary: true, disabled: reason !== null }),
      el('span', { class: 'start-reason' }, reason ? t(`lobby.start.${reason}`) : ''));
    return row;
  }
  const me = state.players.find((p) => s.isMe(p.id));
  if (me) {
    row.append(
      button(me.ready ? t('lobby.ready.unset') : t('lobby.ready.set'), () => { s.setReady(!me.ready); }, { primary: !me.ready }),
      el('span', { class: 'start-reason' }, me.ready ? t('lobby.waitingHost') : ''));
  }
  return row;
}

function lobbyPanels(s: RoomSession, state: GameState, library: readonly ValidatedEntry[]): HTMLElement[] {
  const panels = [playersCard(s, state)];
  if (state.spectators.length > 0 || s.isSpectator) panels.push(spectatorsCard(s, state));
  panels.push(actionsRow(s, state), settingsCard(s, state), coursesCard(s, state, library));
  return panels;
}

function summaryPanels(s: RoomSession, state: GameState): HTMLElement[] {
  const card = el('section', { class: 'card stack' }, el('h2', {}, t('lobby.summary.title')));
  const ranking = el('ol', { class: 'summary-ranking' });
  for (const r of state.ranking ?? []) {
    const p = state.players.find((x) => x.id === r.playerId);
    if (!p) continue;
    ranking.append(el('li', { class: s.isMe(p.id) ? 'is-me' : '' },
      el('span', { class: 'summary-rank' }, `${r.rank}.`),
      colourDot(p.colour),
      el('span', { class: 'summary-name' }, p.name),
      el('span', { class: 'summary-total' }, t('lobby.summary.strokes', { total: r.total }))));
  }
  card.append(ranking);
  const scorecard = el('div', { class: 'scorecard' });
  try { renderScorecard(scorecard, state, s.localPlayerId); } catch (err) { console.error('scorecard failed', err); }
  card.append(scorecard);
  const actions = el('div', { class: 'lobby-actions' });
  if (s.isHost) actions.append(button(t('lobby.summary.backToLobby'), () => s.backToLobby(), { primary: true }));
  if (!s.isSpectator) {
    const ready = state.summaryReady[s.localPlayerId] === true;
    actions.append(button(t('lobby.summary.ready'), () => s.summaryReady(), { primary: !s.isHost, disabled: ready }));
    if (ready) actions.append(el('span', { class: 'start-reason' }, t('lobby.summary.waiting')));
  }
  card.append(actions, el('p', { class: 'muted small' }, t('lobby.summary.hint')));
  return [card];
}

// ------------------------------------------------------------------------------------------------ screen

function createLobby(): Screen {
  const sessions = getSessionStore();
  let root: HTMLElement | null = null;
  let ctx: ScreenContext | null = null;
  let code = '';
  let session: RoomSession | null = null;
  let unsubs: (() => void)[] = [];
  let chat: ChatHandle | null = null;
  let offLibrary: (() => void) | null = null;
  /** Role of the stored session this mount rejoined with (a stale spectator token re-joins silently). */
  let storedRole: 'player' | 'spectator' | null = null;
  /** Bumped on every mount/unmount so dialog promises that resolve after the screen is gone do nothing. */
  let mountGen = 0;

  const cleanup = (): void => {
    for (const off of unsubs) off();
    unsubs = [];
    chat?.destroy();
    chat = null;
    offLibrary?.();
    offLibrary = null;
    session = null;
  };

  const screenShell = (...content: (HTMLElement | null)[]): HTMLElement => {
    const c = ctx!;
    return el('div', { class: 'screen screen--narrow lobby' },
      el('header', { class: 'screen-header' }, button(t('common.back'), () => c.navigate('#/mp')), el('h1', {}, t('lobby.title'))),
      ...content);
  };

  const startSession = (req: JoinRequest): void => {
    const s = new RoomSession(req);
    setActiveHost(s);
    bind(s);
  };

  /** Deep link without a usable session: ask for a name (and colour, spectator flag), then join. */
  const renderJoinPrompt = (error: string | null, initial?: { name: string; colour: PlayerColour; spectate: boolean }): void => {
    if (!root || !ctx) return;
    const settings = getSettings();
    let colour = initial?.colour ?? settings.colour;
    let spectate = initial?.spectate ?? false;
    const nameInput = el('input', { type: 'text', class: 'input', autocomplete: 'nickname', placeholder: DEFAULT_PLAYER_NAME, 'aria-required': 'true' });
    nameInput.maxLength = MAX_NAME_CHARS;
    nameInput.value = initial?.name ?? settings.name;
    const err = el('div', { class: 'field__error', role: 'alert' }, error ?? '');
    err.hidden = !error;
    const picker = colourPicker(colour, (c) => { colour = c; updateSettings({ colour: c }); }, [0, 1, 2, 3].map((c) => t(`colour.${c}`)));
    const submit = (): void => {
      const name = sanitizeName(nameInput.value);
      if (!name) { err.textContent = t('mp.name.required'); err.hidden = false; nameInput.focus(); return; }
      updateSettings({ name });
      storedRole = null;
      startSession({ kind: 'join', code, name, colour, asSpectator: spectate });
    };
    nameInput.addEventListener('input', () => { err.hidden = true; });
    nameInput.addEventListener('keydown', (e: KeyboardEvent) => { if (e.key === 'Enter') { e.preventDefault(); submit(); } });
    const card = el('section', { class: 'card stack lobby-join' },
      el('h2', {}, t('lobby.join.title', { code })),
      el('p', { class: 'muted' }, t('lobby.join.hint')),
      field(t('settings.name'), nameInput),
      el('div', { class: 'field' }, el('span', { class: 'field__label' }, t('settings.colour')), picker),
      checkbox(t('mp.spectate'), spectate, (v) => { spectate = v; }),
      err,
      el('div', { class: 'row' }, button(t('lobby.join.button'), submit, { primary: true })));
    root.replaceChildren(screenShell(card));
    nameInput.focus();
  };

  const renderFailure = (text: string): void => {
    if (!root || !ctx) return;
    const c = ctx;
    root.replaceChildren(screenShell(el('section', { class: 'card stack' },
      el('p', {}, text),
      el('div', { class: 'row' },
        button(t('lobby.retry'), () => renderJoinPrompt(null), { primary: true }),
        button(t('mp.backToMenu'), () => c.navigate('#/mp'))))));
  };

  /** Bind the lobby view to a session (joined or still joining). */
  const bind = (s: RoomSession): void => {
    if (!root || !ctx) return;
    cleanup();
    session = s;
    const c = ctx;
    const gen = mountGen;
    /** True while this mount still shows this session (guards async dialog continuations). */
    const alive = (): boolean => gen === mountGen && root !== null && session === s;
    let navigatedToGame = false;
    // Validated once here and on library changes only, not on every room event (validateCourse is not free).
    let library = listCoursesWithIssues();

    const copyLinkBtn = button(t('lobby.copyLink'), () => { void copyText(roomLink(code), t('lobby.linkCopied')); }, { variant: 'small' });
    const copyCodeBtn = button(t('lobby.copyCode'), () => { void copyText(code, t('lobby.codeCopied')); }, { variant: 'small' });
    const leaveBtn = button(t('lobby.leave'), () => { void leave(); }, { variant: 'danger' });
    const header = el('header', { class: 'screen-header lobby-header' },
      leaveBtn,
      el('h1', {}, t('lobby.title')),
      el('div', { class: 'lobby-code' },
        el('span', { class: 'lobby-code__label' }, t('lobby.code')),
        el('div', { class: 'room-code' }, code),
        el('div', { class: 'row lobby-code__actions' }, copyLinkBtn, copyCodeBtn)));
    const statusBar = el('div', { class: 'lobby-status', role: 'status', 'aria-live': 'polite' });
    statusBar.hidden = true;
    const main = el('section', { class: 'lobby-main stack' });
    const side = el('aside', { class: 'lobby-side' });
    root.replaceChildren(el('div', { class: 'screen screen--wide lobby' }, header, statusBar, el('div', { class: 'lobby-layout' }, main, side)));
    if (s.chat) chat = mountChat(side, s.chat);

    const renderStatus = (st: SessionStatus): void => {
      if (st === 'joined' || st === 'left') { statusBar.hidden = true; return; }
      statusBar.hidden = false;
      statusBar.classList.toggle('is-warning', st === 'reconnecting');
      statusBar.textContent = st === 'reconnecting' ? t('lobby.reconnecting') : t('lobby.connecting');
    };

    const render = (state: GameState): void => {
      if (s.status !== 'joined') {
        main.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'empty' }, s.status === 'reconnecting' ? t('lobby.reconnecting') : t('lobby.connecting'))));
        return;
      }
      if (state.phase === 'countdown' || state.phase === 'hole' || state.phase === 'holeSummary') {
        if (!navigatedToGame) {
          navigatedToGame = true;
          main.replaceChildren(el('div', { class: 'card' }, el('div', { class: 'empty' }, t('lobby.gameInProgress'))));
          c.navigate('#/game');
        }
        return;
      }
      navigatedToGame = false;
      main.replaceChildren(...(state.phase === 'roundSummary' ? summaryPanels(s, state) : lobbyPanels(s, state, library)));
    };

    const handleError = (errCode: string, message: string, issues?: ValidationIssue[]): void => {
      // While (re)joining the left handler owns the feedback (inline prompt / failure card): no duplicate toast.
      if (s.status === 'joining' || s.status === 'rejoining') return;
      if (errCode === ErrorCode.BAD_VERSION) {
        // A joined session gets the reload dialog from the screen-independent handler (mp.screen.ts) on its end.
        if (!s.hasJoined) void alertDialog(t('error.BAD_VERSION'), { reload: true });
        return;
      }
      let text = errorText(errCode, message);
      if (errCode === ErrorCode.INVALID_COURSE && issues && issues.length > 0) text += ' ' + issues.slice(0, 2).map(issueMessage).join(' ');
      toast(text, 'error');
    };

    const toMenu = (): void => {
      if (getActiveHost() === s) setActiveHost(null);
      c.navigate('#/mp');
    };

    /**
     * Only a session that never joined is handled here (deep-link join flow). Once joined, every unexpected end
     * (removed, roomClosed, replaced, connectionClosed, sessionExpired) is handled screen-independently by the
     * handler in mp.screen.ts, which also works while the play view is mounted.
     */
    const handleLeft = (reason: LeftReason, errCode?: ErrorCode, message?: string): void => {
      if (reason === 'left') return; // initiated from this screen (or the menu); navigation is handled there
      if (s.hasJoined) return;
      switch (reason) {
        case 'removed':
        case 'roomClosed':
        case 'replaced':
          if (getActiveHost() === s) setActiveHost(null);
          renderFailure(t('mp.connectionLost'));
          return;
        case 'connectionClosed':
          if (getActiveHost() === s) setActiveHost(null);
          if (errCode !== ErrorCode.BAD_VERSION) renderFailure(t('mp.connectionLost'));
          return;
        case 'sessionExpired': {
          // Deep link / reload with a stale token: a spectator seat is simply re-taken, a player enters a name.
          const req = s.request;
          if (getActiveHost() === s) setActiveHost(null);
          if (req.kind === 'rejoin' && storedRole === 'spectator') {
            storedRole = null;
            startSession({ kind: 'join', code, name: req.name || DEFAULT_PLAYER_NAME, colour: req.colour, asSpectator: true });
          } else {
            renderJoinPrompt(null, { name: req.name, colour: req.colour, spectate: false });
          }
          return;
        }
        case 'joinFailed': {
          if (getActiveHost() === s) setActiveHost(null);
          const req = s.request;
          const text = errCode ? errorText(errCode, message) : t('mp.connectionLost');
          const initial = req.kind === 'join' ? { name: req.name, colour: req.colour, spectate: req.asSpectator === true } : undefined;
          if (errCode === ErrorCode.NAME_TAKEN) renderJoinPrompt(text, initial);
          else if (errCode === ErrorCode.ROOM_FULL && initial && !initial.spectate) renderJoinPrompt(text, { ...initial, spectate: true });
          else if (errCode === ErrorCode.ROOM_NOT_FOUND) renderFailure(t('lobby.notFound', { code }));
          else renderFailure(t('lobby.joinFailed', { reason: text }));
          return;
        }
      }
    };

    const leave = async (): Promise<void> => {
      const ok = await confirmDialog(t('lobby.leave.confirm', { code }), { ok: t('lobby.leave'), danger: true });
      if (!ok || !alive()) return;
      s.leave();
      toMenu();
    };

    renderStatus(s.status);
    unsubs.push(
      s.onStatus((st) => { renderStatus(st); if (st === 'joined') render(s.getState()); }),
      s.subscribe((state) => render(state)),
      s.onError(handleError),
      s.onLeft(handleLeft),
    );
    offLibrary = onLibraryChange(() => {
      if (!alive()) return;
      library = listCoursesWithIssues();
      if (s.status === 'joined') render(s.getState());
    });
  };

  return {
    mount(r, c) {
      mountGen++;
      root = r;
      ctx = c;
      code = normalizeRoomCode(c.params.code ?? '');
      if (!isRoomCode(code)) {
        toast(t('lobby.invalidCode'), 'error');
        c.navigate('#/mp');
        return;
      }
      const host = getActiveHost();
      if (host instanceof RoomSession && host.status !== 'left' && host.code === code) {
        bind(host);
        return;
      }
      if (host) {
        // A different room or a local game: end it, this room takes over.
        try { host.leave(); } catch (err) { console.error('leave failed', err); }
        setActiveHost(null);
      }
      const stored = sessions.getSession(code);
      if (stored) {
        storedRole = stored.role;
        startSession({ kind: 'rejoin', code, token: stored.token, name: stored.name || getSettings().name || DEFAULT_PLAYER_NAME, colour: stored.colour });
        return;
      }
      storedRole = null;
      renderJoinPrompt(null);
    },

    unmount() {
      mountGen++;
      cleanup(); // the session stays the active host (the play view uses it); listeners of this view are released
      root = null;
      ctx = null;
    },
  };
}

registerScreen('#/room/:code', createLobby);
