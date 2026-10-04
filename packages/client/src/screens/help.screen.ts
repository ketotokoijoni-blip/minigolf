// #/help (DESIGN §12.1). Phase 1: text plus legend placeholders. TODO phase 2: draw each legend swatch with WP-D's
// tileArt into the <canvas class="legend__art"> so the legend always matches the game art.
import { DEFAULT_MAX_STROKES } from '@puttipeli/shared/constants';
import { registerScreen, type Screen, type ScreenContext } from '../app/screen';
import { el, button } from '../ui/components';
import { t } from '../i18n/t';

interface LegendItem { key: string; swatch: string }

/** Legend order and provisional CSS swatch colours (replaced by tileArt canvases in phase 2). */
export const LEGEND_ITEMS: readonly LegendItem[] = [
  { key: 'grass', swatch: '#2f8a46' },
  { key: 'sand', swatch: '#d8c07a' },
  { key: 'ice', swatch: '#b9e2f5' },
  { key: 'tar', swatch: '#1a1a1c' },
  { key: 'water', swatch: '#2f6fd0' },
  { key: 'acid', swatch: '#a6d64a' },
  { key: 'slope', swatch: 'linear-gradient(180deg, #2f8a46, #1f5f30)' },
  { key: 'wall', swatch: 'linear-gradient(135deg, #9a9a8c, #5d5d52)' },
  { key: 'triangle', swatch: 'linear-gradient(135deg, #9a9a8c 50%, #2f8a46 50%)' },
  { key: 'breakable', swatch: 'repeating-linear-gradient(0deg, #a85d3d 0 6px, #7a3f29 6px 8px)' },
  { key: 'movable', swatch: 'linear-gradient(135deg, #c9a85a, #8a6f2e)' },
  { key: 'bumper', swatch: 'radial-gradient(circle, #e0583f 35%, #6a6a60 38%)' },
  { key: 'oneway', swatch: 'linear-gradient(0deg, #5d5d52 50%, #b5b5a8 50%)' },
  { key: 'teleport', swatch: 'radial-gradient(circle, #ffffff 15%, #5fb3e0 20%, #2f8a46 55%)' },
  { key: 'magnet', swatch: 'linear-gradient(90deg, #d14a4a 50%, #4a74d1 50%)' },
  { key: 'mine', swatch: 'radial-gradient(circle, #222 40%, #2f8a46 45%)' },
  { key: 'hole', swatch: 'radial-gradient(circle, #06160d 45%, #2f8a46 50%)' },
  { key: 'start', swatch: 'radial-gradient(circle, #2f8a46 40%, #f4efe1 45%, #2f8a46 60%)' },
];

function controlsTable(rows: [string, string][]): HTMLElement {
  const table = el('table', { class: 'controls-table' });
  for (const [k, v] of rows) {
    const keyCell = el('td');
    keyCell.append(...k.split(' / ').flatMap((part, i) => (i ? [' / ', el('kbd', {}, part)] : [el('kbd', {}, part)])));
    table.append(el('tr', {}, keyCell, el('td', {}, v)));
  }
  return table;
}

function createHelpScreen(): Screen {
  return {
    mount(root, ctx: ScreenContext) {
      const controls = el('section', { class: 'card help-section' },
        el('h2', {}, t('help.controls')),
        el('h3', {}, t('help.controls.mouse')),
        el('p', {}, t('help.controls.mouse.aim')),
        el('p', {}, t('help.controls.mouse.fire')),
        el('h3', {}, t('help.controls.keyboard')),
        controlsTable([
          ['← / →', t('help.controls.keyboard.aim')],
          ['↑ / ↓', t('help.controls.keyboard.power')],
          ['Space / Enter', t('help.controls.keyboard.fire')],
          ['Esc', t('help.controls.keyboard.cancel')],
          ['Tab', t('help.controls.keyboard.scorecard')],
          ['C', t('help.controls.keyboard.chat')],
        ]),
        el('h3', {}, t('help.controls.touch')),
        el('p', {}, t('help.controls.touch.aim')),
        el('p', {}, t('help.controls.touch.fire')),
      );

      const legendList = el('ul', { class: 'legend' });
      for (const item of LEGEND_ITEMS) {
        const art = el('canvas', { class: 'legend__art', width: '45', height: '45', 'aria-hidden': 'true' });
        art.style.setProperty('--swatch', item.swatch);
        legendList.append(el('li', { class: 'legend__item' }, art,
          el('div', {}, el('div', { class: 'legend__name' }, t(`legend.${item.key}`)), el('div', { class: 'legend__desc' }, t(`legend.${item.key}.desc`)))));
      }
      const legend = el('section', { class: 'card help-section' }, el('h2', {}, t('help.legend')), legendList);

      const rules = el('section', { class: 'card help-section' },
        el('h2', {}, t('help.rules')),
        ...['goal', 'maxStrokes', 'hazards', 'tar', 'teleport', 'magnet', 'blocks', 'bumper', 'slopes', 'turn'].map((k) =>
          el('p', {}, t(`help.rules.${k}`, { max: DEFAULT_MAX_STROKES }))),
      );

      const mp = el('section', { class: 'card help-section' },
        el('h2', {}, t('help.mp')),
        ...['code', 'ready', 'turns', 'spectators', 'disconnect'].map((k) => el('p', {}, t(`help.mp.${k}`))),
      );

      root.append(el('div', { class: 'screen' },
        el('header', { class: 'screen-header' }, button(t('common.back'), () => ctx.navigate('#/')), el('h1', {}, t('help.title'))),
        controls, legend, rules, mp,
      ));
    },
    unmount() { /* nothing to release */ },
  };
}

registerScreen('#/help', createHelpScreen);
