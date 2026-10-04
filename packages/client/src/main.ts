// Client boot (DESIGN §3, D26): styles, dictionaries, settings -> language, self-registering screens, router.
import './ui/styles.css';
import './i18n/fi';
import './i18n/en';
import { getSettings, onSettingsChange, type Settings } from './storage/settings';
import { setLanguage, onLanguageChange, t } from './i18n/t';
import { startRouter } from './app/router';
import { PLAYER_COLOURS } from './render/palette';

// Every *.screen.ts registers its route at import (screens/, game/, editor/ ...).
import.meta.glob('./**/*.screen.ts', { eager: true });

function applySettings(s: Settings): void {
  document.documentElement.classList.toggle('reduce-effects', s.reduceEffects);
  document.documentElement.lang = s.language;
}

// The DOM chips (HUD, scorecard, chat, colour picker) use the same player colours as the canvas (WP-D palette).
PLAYER_COLOURS.forEach((colour, i) => document.documentElement.style.setProperty(`--player-${i}`, colour));

const settings = getSettings();
setLanguage(settings.language);
applySettings(settings);
onSettingsChange(applySettings);
onLanguageChange(() => { document.title = t('app.title'); });
document.title = t('app.title');

const root = document.getElementById('app');
if (!root) throw new Error('#app missing from index.html');
startRouter(root);

window.addEventListener('unhandledrejection', (e) => console.error('Unhandled rejection', e.reason));
