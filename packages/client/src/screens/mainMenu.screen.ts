// #/ main menu (DESIGN §12.1). The multiplayer caption shows GET /api/stats (re-fetched every STATS_REFRESH_MS
// while the menu is open) or the "server unreachable" fallback. Mounting leaves and clears any active GameHost.
import { DEFAULT_PLAYER_NAME, MAX_NAME_CHARS } from '@puttipeli/shared/constants';
import { registerScreen, type Screen, type ScreenContext } from '../app/screen';
import { getActiveHost, setActiveHost } from '../app/activeHost';
import { appStore, refreshServerStats, type AppState } from '../app/store';
import { getSettings, updateSettings, sanitizeName } from '../storage/settings';
import { el, button } from '../ui/components';
import { promptDialog } from '../ui/dialogs';
import { t } from '../i18n/t';

/** Inline logo mark (same original artwork as public/favicon.svg): felt disc, white ball, small flag. */
const LOGO_SVG = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 64 64" width="84" height="84" role="img">
  <defs>
    <radialGradient id="pp-felt" cx="40%" cy="35%" r="70%"><stop offset="0" stop-color="#3fae5f"/><stop offset="1" stop-color="#175028"/></radialGradient>
    <radialGradient id="pp-ball" cx="38%" cy="35%" r="65%"><stop offset="0" stop-color="#ffffff"/><stop offset="1" stop-color="#cfc9b5"/></radialGradient>
  </defs>
  <circle cx="32" cy="32" r="30" fill="url(#pp-felt)" stroke="#0b2a18" stroke-width="2"/>
  <ellipse cx="42" cy="44" rx="9" ry="3.2" fill="#06160d" opacity="0.85"/>
  <rect x="41" y="14" width="2" height="30" rx="1" fill="#f4efe1"/>
  <path d="M43 15 L56 20 L43 25 Z" fill="#e0583f"/>
  <circle cx="22" cy="40" r="8" fill="url(#pp-ball)" stroke="#9bb3a0" stroke-width="1"/>
</svg>`;

function menuButton(label: string, caption: string | HTMLElement, onClick: () => void, primary = false): HTMLButtonElement {
  const b = button('', onClick, { primary, className: 'menu-btn' });
  b.replaceChildren(el('span', { class: 'btn__label' }, label), typeof caption === 'string' ? el('span', { class: 'btn__caption' }, caption) : caption);
  return b;
}

/** How often the server status caption is refreshed while the menu is open. */
const STATS_REFRESH_MS = 30_000;

function createMainMenu(): Screen {
  let abort: AbortController | null = null;
  let unsubscribe: (() => void) | null = null;
  let statsTimer: number | null = null;

  return {
    mount(root, ctx: ScreenContext) {
      // Navigating home always ends any running session cleanly.
      const host = getActiveHost();
      if (host) {
        try { host.leave(); } catch (err) { console.error('leave failed', err); }
        setActiveHost(null);
      }

      const mark = el('div', { class: 'logo__mark', 'aria-hidden': 'true' });
      mark.innerHTML = LOGO_SVG;
      const logo = el('div', { class: 'logo' }, mark, el('h1', { class: 'logo__title' }, t('app.title')), el('p', { class: 'logo__sub' }, t('app.tagline')));

      const mpCaption = el('span', { class: 'btn__caption' }, t('menu.multi.caption.loading'));
      const renderCaption = (s: AppState): void => {
        mpCaption.classList.remove('is-online', 'is-offline');
        if (s.serverStatus === 'online' && s.stats) {
          mpCaption.textContent = t('menu.multi.caption.online', { players: s.stats.players, rooms: s.stats.rooms });
          mpCaption.classList.add('is-online');
        } else if (s.serverStatus === 'offline') {
          mpCaption.textContent = t('menu.multi.caption.offline');
          mpCaption.classList.add('is-offline');
        } else {
          mpCaption.textContent = t('menu.multi.caption.loading');
        }
      };
      renderCaption(appStore.get());
      unsubscribe = appStore.subscribe(renderCaption);
      abort = new AbortController();
      void refreshServerStats(abort.signal);
      statsTimer = window.setInterval(() => { if (abort && !abort.signal.aborted) void refreshServerStats(abort.signal); }, STATS_REFRESH_MS);

      const buttons = el('nav', { class: 'menu__buttons', 'aria-label': t('app.title') },
        menuButton(t('menu.single'), t('menu.single.caption'), () => ctx.navigate('#/play'), true),
        menuButton(t('menu.multi'), mpCaption, () => ctx.navigate('#/mp')),
        menuButton(t('menu.editor'), t('menu.editor.caption'), () => ctx.navigate('#/editor')),
        menuButton(t('menu.help'), t('menu.help.caption'), () => ctx.navigate('#/help')),
        menuButton(t('menu.settings'), t('menu.settings.caption'), () => ctx.navigate('#/settings')),
      );

      const nameLabel = (): string => t('menu.nickname', { name: getSettings().name || DEFAULT_PLAYER_NAME });
      const nameDot = el('span', { class: 'chip__dot', 'aria-hidden': 'true' });
      nameDot.style.setProperty('--player-colour', `var(--player-${getSettings().colour})`);
      const nameBtn = button(nameLabel(), async () => {
        const v = await promptDialog(t('menu.nickname.prompt'), {
          initial: getSettings().name,
          maxLength: MAX_NAME_CHARS,
          validate: (s) => (sanitizeName(s).length === 0 ? t('menu.nickname.invalid') : null),
        });
        if (v !== null) { updateSettings({ name: sanitizeName(v) }); nameBtn.replaceChildren(nameDot, nameLabel()); }
      }, { variant: 'ghost' });
      nameBtn.replaceChildren(nameDot, nameLabel());

      const footer = el('footer', { class: 'footer' },
        nameBtn,
        el('span', { class: 'build-id', title: t('menu.build', { build: __BUILD__ }) }, t('menu.build', { build: __BUILD__ })),
      );

      root.append(el('main', { class: 'menu' }, logo, buttons), footer);
      (buttons.firstElementChild as HTMLElement | null)?.focus();
    },

    unmount() {
      if (statsTimer !== null) { window.clearInterval(statsTimer); statsTimer = null; }
      abort?.abort();
      abort = null;
      unsubscribe?.();
      unsubscribe = null;
    },
  };
}

registerScreen('#/', createMainMenu);
