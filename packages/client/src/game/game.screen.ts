// #/game play view (DESIGN §12.1): shared by single player, editor test play and multiplayer. A pending local game
// (set by #/play or the editor) creates a LocalHost and makes it the active host; otherwise the active host (a
// multiplayer RoomSession) is used; without either the screen redirects to #/. The GameController builds the HUD,
// the canvas stack and the overlays; this file adds the page frame (leave / scorecard / pause buttons) and, in
// multiplayer, the chat panel bound to host.chat.
import { getActiveHost, setActiveHost, takePendingLocalGame } from '../app/activeHost';
import { registerScreen, type Screen, type ScreenContext } from '../app/screen';
import { t } from '../i18n/t';
import { mountChat, type ChatHandle } from '../ui/chat';
import { button, el, toast } from '../ui/components';
import { GameController } from './controller';
import type { GameHost } from './gameHost';
import { LocalHost, createLocalHost } from './localHost';
import { ensureGameStyles } from './summaries';

/**
 * Lobby route of a remote host. RoomSession (WP-H, net/roomClient.ts) exposes its code as `get roomCode()`; the
 * property is read structurally because `GameHost` (WP0 contract) does not carry it. Without a code (not a
 * RoomSession, or not joined) the multiplayer menu is the safe fallback.
 */
export function lobbyHashFor(host: GameHost): string {
  const code = (host as unknown as { roomCode?: unknown }).roomCode;
  return typeof code === 'string' && code !== '' ? `#/room/${encodeURIComponent(code)}` : '#/mp';
}

const isTextTarget = (n: EventTarget | null): boolean => {
  const e = n as HTMLElement | null;
  return !!e && (e.tagName === 'INPUT' || e.tagName === 'TEXTAREA' || e.isContentEditable === true);
};

function createGameScreen(): Screen {
  let host: GameHost | null = null;
  let controller: GameController | null = null;
  let chat: ChatHandle | null = null;
  let onKey: ((e: KeyboardEvent) => void) | null = null;

  const releaseLocalHost = (): void => {
    const h = host;
    host = null;
    if (!h || h.kind !== 'local') return;
    try { h.leave(); } catch (err) { console.error('[puttipeli] leave failed', err); }
    if (getActiveHost() === h) setActiveHost(null); // destroys it
  };

  return {
    mount(root, ctx: ScreenContext) {
      const pending = takePendingLocalGame();
      let returnTo = '#/';
      let testPlay = false;
      let local: LocalHost | null = null;

      if (pending) {
        returnTo = pending.returnTo || '#/';
        testPlay = pending.testPlay;
        if (pending.courses.length === 0) {
          toast(t('game.noCourses'), 'error');
          ctx.navigate(returnTo);
          return;
        }
        try {
          local = createLocalHost({ courses: pending.courses, playerName: pending.playerName, colour: pending.colour, testPlay, returnTo });
        } catch (err) {
          console.error('[puttipeli] local game failed', err);
          toast(t('game.startFailed'), 'error');
          ctx.navigate(returnTo);
          return;
        }
        setActiveHost(local);
        host = local;
      } else {
        const active = getActiveHost();
        if (!active) {
          ctx.navigate('#/');
          return;
        }
        if (active instanceof LocalHost) {
          // A LocalHost made active by its creator (started or not) is attached here; a finished one goes home.
          if (active.left || active.destroyed || (active.started && active.getState().phase === 'lobby')) {
            setActiveHost(null);
            ctx.navigate(active.returnTo);
            return;
          }
          local = active;
          returnTo = active.returnTo;
          testPlay = active.testPlay;
        } else if (active.getState().phase === 'lobby') {
          ctx.navigate(lobbyHashFor(active));
          return;
        }
        host = active;
      }

      const current = host;
      const isLocal = current.kind === 'local';

      const leave = (): void => {
        const h = host;
        if (!h) return;
        const target = isLocal ? returnTo : '#/mp';
        if (isLocal) {
          releaseLocalHost();
        } else {
          host = null;
          try { h.leave(); } catch (err) { console.error('[puttipeli] leave failed', err); }
          if (getActiveHost() === h) setActiveHost(null);
        }
        ctx.navigate(target);
      };
      const backToLobby = (): void => {
        const h = host;
        host = null; // the lobby screen keeps the session; this screen must not touch it any more
        if (h) ctx.navigate(lobbyHashFor(h));
      };

      ensureGameStyles();
      const gameRoot = el('div');
      const leaveBtn = button(isLocal ? (testPlay ? t('game.toEditor') : t('game.toMenu')) : t('game.leave'), () => controller?.requestLeave(), { variant: 'ghost' });
      const scoreBtn = button(t('game.scorecard'), () => controller?.toggleScorecard(), { variant: 'small', title: t('game.scorecard.hint') });
      const pauseBtn = button(t('game.pause'), () => controller?.pause(), { variant: 'small', title: 'Esc' });
      const bar = el('div', { class: 'game-bar' },
        leaveBtn,
        el('span', { class: 'game-bar__title' }, t('app.title')),
        el('span', { class: 'game-bar__spacer' }),
        scoreBtn,
        pauseBtn,
      );
      const main = el('div', { class: 'game-main' }, gameRoot);
      if (current.chat) {
        const chatWrap = el('aside', { class: 'game-chat' });
        main.classList.add('game-main--chat');
        main.append(chatWrap);
        chat = mountChat(chatWrap, current.chat, { collapsible: true });
        onKey = (e: KeyboardEvent): void => {
          if ((e.key === 'c' || e.key === 'C') && !e.ctrlKey && !e.metaKey && !e.altKey && !isTextTarget(e.target)) {
            e.preventDefault();
            chat?.focus();
          }
        };
        window.addEventListener('keydown', onKey);
      }
      root.append(el('div', { class: 'game-screen' }, bar, main));

      controller = new GameController(current, gameRoot, { testPlay, onLeave: leave, onBackToLobby: backToLobby });

      if (local && !local.started) {
        const err = local.start();
        if (err !== null) {
          toast(t('game.startFailed'), 'error');
          leave();
        }
      }
    },

    unmount() {
      if (onKey) window.removeEventListener('keydown', onKey);
      onKey = null;
      controller?.destroy();
      controller = null;
      chat?.destroy();
      chat = null;
      // A local round lives in memory only (§10.7): leaving the view ends it. A remote session is owned by the
      // multiplayer screens and stays active.
      releaseLocalHost();
    },
  };
}

registerScreen('#/game', createGameScreen);
