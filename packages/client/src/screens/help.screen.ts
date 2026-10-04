// #/help (DESIGN §12.1). Controls, a tile legend drawn by WP-D's tileArt into small canvases (so it always matches
// the game art), rules and the multiplayer how-to. `LEGEND_ITEMS` is exported so help.test.ts can check that every
// surface, wall shape and object type has a legend entry.
import { DEFAULT_MAX_STROKES, MAX_PULL_PX, TILE } from '@puttipeli/shared/constants';
import { Surface, WallShape, type CourseObject } from '@puttipeli/shared/course/types';
import { registerScreen, type Screen, type ScreenContext } from '../app/screen';
import { drawLegendTile } from '../render/tileArt';
import { el, button } from '../ui/components';
import { t } from '../i18n/t';

/** One tile of a legend swatch: surface under wall under object (any part may be omitted; grass is the default). */
export interface LegendTile { surface?: number; wall?: number; object?: CourseObject }
export interface LegendItem { key: string; tiles: LegendTile[] }

/** Legend scale: one 15 px tile is drawn at 45 CSS px. */
const LEGEND_SCALE = 3;

const obj = (o: CourseObject): LegendTile => ({ object: o });

/** Legend order; every Surface code, every WallShape (except None) and every CourseObject type appears once. */
export const LEGEND_ITEMS: readonly LegendItem[] = [
  { key: 'grass', tiles: [{ surface: Surface.Grass }] },
  { key: 'sand', tiles: [{ surface: Surface.Sand }] },
  { key: 'ice', tiles: [{ surface: Surface.Ice }] },
  { key: 'tar', tiles: [{ surface: Surface.Tar }] },
  { key: 'water', tiles: [{ surface: Surface.Water }] },
  { key: 'acid', tiles: [{ surface: Surface.Acid }] },
  { key: 'slope', tiles: [{ surface: Surface.SlopeN }, { surface: Surface.SlopeE }, { surface: Surface.SlopeS }, { surface: Surface.SlopeW }] },
  { key: 'wall', tiles: [{ wall: WallShape.Full }] },
  { key: 'triangle', tiles: [{ wall: WallShape.TriNW }, { wall: WallShape.TriNE }, { wall: WallShape.TriSE }, { wall: WallShape.TriSW }] },
  { key: 'breakable', tiles: [{ wall: WallShape.Breakable1 }, { wall: WallShape.Breakable2 }, { wall: WallShape.Breakable3 }] },
  { key: 'movable', tiles: [{ wall: WallShape.Movable }] },
  { key: 'bumper', tiles: [{ wall: WallShape.Bumper }] },
  { key: 'oneway', tiles: [{ wall: WallShape.OneWayN }, { wall: WallShape.OneWayE }, { wall: WallShape.OneWayS }, { wall: WallShape.OneWayW }] },
  { key: 'teleport', tiles: [obj({ type: 'teleport', x: 0, y: 0, group: 0 }), obj({ type: 'teleport', x: 0, y: 0, group: 1 })] },
  {
    key: 'magnet',
    tiles: [
      { wall: WallShape.Full, object: { type: 'magnet', x: 0, y: 0, polarity: 1, strength: 300, radius: 60 } },
      { wall: WallShape.Full, object: { type: 'magnet', x: 0, y: 0, polarity: -1, strength: 300, radius: 60 } },
    ],
  },
  { key: 'mine', tiles: [obj({ type: 'mine', x: 0, y: 0 })] },
  { key: 'hole', tiles: [obj({ type: 'hole', x: 0, y: 0 })] },
  { key: 'start', tiles: [obj({ type: 'start', x: 0, y: 0 })] },
];

/** Draws the legend tiles of one item side by side into a canvas (HiDPI-aware, nearest-neighbour upscaling). */
export function drawLegendCanvas(canvas: HTMLCanvasElement, tiles: readonly LegendTile[], dpr = 1): void {
  const cssW = tiles.length * TILE * LEGEND_SCALE;
  const cssH = TILE * LEGEND_SCALE;
  canvas.width = Math.round(cssW * dpr);
  canvas.height = Math.round(cssH * dpr);
  canvas.style.width = `${cssW}px`;
  canvas.style.height = `${cssH}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.imageSmoothingEnabled = false;
  ctx.setTransform(LEGEND_SCALE * dpr, 0, 0, LEGEND_SCALE * dpr, 0, 0);
  ctx.clearRect(0, 0, tiles.length * TILE, TILE);
  tiles.forEach((tile, i) => drawLegendTile(ctx, i * TILE, 0, tile));
}

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
        el('div', { class: 'grid-2' },
          el('div', {},
            el('h3', {}, t('help.controls.mouse')),
            el('p', {}, t('help.controls.mouse.aim', { pull: MAX_PULL_PX })),
            el('p', {}, t('help.controls.mouse.fire')),
            el('h3', {}, t('help.controls.touch')),
            el('p', {}, t('help.controls.touch.aim')),
            el('p', {}, t('help.controls.touch.fire'))),
          el('div', {},
            el('h3', {}, t('help.controls.keyboard')),
            controlsTable([
              ['← / →', t('help.controls.keyboard.aim')],
              ['↑ / ↓', t('help.controls.keyboard.power')],
              ['Space / Enter', t('help.controls.keyboard.fire')],
              ['Esc', t('help.controls.keyboard.cancel')],
              ['Tab', t('help.controls.keyboard.scorecard')],
              ['C', t('help.controls.keyboard.chat')],
              ['G', t('help.controls.keyboard.grid')],
            ]))),
      );

      const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
      const legendList = el('ul', { class: 'legend' });
      for (const item of LEGEND_ITEMS) {
        const art = el('canvas', { class: 'legend__art', 'aria-hidden': 'true' });
        try {
          drawLegendCanvas(art, item.tiles, dpr);
        } catch (err) {
          console.error('legend draw failed', item.key, err);
        }
        legendList.append(el('li', { class: 'legend__item' }, art,
          el('div', {}, el('div', { class: 'legend__name' }, t(`legend.${item.key}`)), el('div', { class: 'legend__desc' }, t(`legend.${item.key}.desc`)))));
      }
      const legend = el('section', { class: 'card help-section' },
        el('h2', {}, t('help.legend')),
        el('p', { class: 'muted small' }, t('help.legend.hint')),
        legendList);

      const rules = el('section', { class: 'card help-section' },
        el('h2', {}, t('help.rules')),
        el('ul', { class: 'rules' },
          ...['goal', 'maxStrokes', 'hazards', 'tar', 'teleport', 'magnet', 'blocks', 'bumper', 'slopes', 'turn'].map((k) =>
            el('li', {}, t(`help.rules.${k}`, { max: DEFAULT_MAX_STROKES, pull: MAX_PULL_PX })))),
      );

      const mp = el('section', { class: 'card help-section' },
        el('h2', {}, t('help.mp')),
        el('ul', { class: 'rules' }, ...['code', 'ready', 'turns', 'spectators', 'disconnect'].map((k) => el('li', {}, t(`help.mp.${k}`)))),
        el('div', { class: 'row' }, button(t('menu.multi'), () => ctx.navigate('#/mp'))),
      );

      root.append(el('div', { class: 'screen' },
        el('header', { class: 'screen-header' }, button(t('common.back'), () => ctx.navigate('#/')), el('h1', {}, t('help.title'))),
        el('p', { class: 'muted' }, t('help.intro')),
        controls, legend, rules, mp,
      ));
    },
    unmount() { /* nothing to release */ },
  };
}

registerScreen('#/help', createHelpScreen);
