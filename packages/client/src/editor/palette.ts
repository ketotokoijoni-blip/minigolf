// Palette panel (DESIGN §13.1): tool strip + tabs Pinnat / Seinät / Kohteet. Every swatch is drawn with WP-D's
// tileArt so the palette always matches the in-game art. Teleport chips show group + 1 while the data stays 0..7;
// the magnet chips choose the polarity of new magnets (strength/radius start at the defaults and are edited per
// object in the inspector). The pure parts (item lists, templates, names) are exported for tests.
import { MAGNET_DEFAULT_RADIUS, MAGNET_DEFAULT_STRENGTH, TILE } from '@puttipeli/shared/constants';
import { Surface, WallShape, type CourseObject, type Polarity, type TeleportGroup } from '@puttipeli/shared/course/types';
import { teleportColour } from '../render/palette';
import { drawLegendTile, type ArtContext } from '../render/tileArt';
import { el } from '../ui/components';
import { t } from '../i18n/t';
import { PALETTE_TABS, TAB_KEYS, TOOL_IDS, TOOL_KEYS, tabOfSelection, type PaletteTab, type Selection, type ToolId } from './tools';

export const SURFACE_ITEMS: readonly Surface[] = [
  Surface.Grass, Surface.Sand, Surface.Ice, Surface.Tar, Surface.Water, Surface.Acid,
  Surface.SlopeN, Surface.SlopeE, Surface.SlopeS, Surface.SlopeW,
];
/** None comes last: it is the "Poista seinä" item. */
export const WALL_ITEMS: readonly WallShape[] = [
  WallShape.Full, WallShape.TriNW, WallShape.TriNE, WallShape.TriSE, WallShape.TriSW,
  WallShape.Breakable1, WallShape.Breakable2, WallShape.Breakable3, WallShape.Movable, WallShape.Bumper,
  WallShape.OneWayN, WallShape.OneWayE, WallShape.OneWayS, WallShape.OneWayW, WallShape.None,
];
export type ObjectItem = 'start' | 'hole' | 'teleport' | 'magnet' | 'mine' | 'erase';
export const OBJECT_ITEMS: readonly ObjectItem[] = ['start', 'hole', 'teleport', 'magnet', 'mine', 'erase'];

/** Properties new teleports/magnets are created with; follows the last pipette pick. */
export interface ObjectDefaults { group: TeleportGroup; polarity: Polarity; strength: number; radius: number }
export const INITIAL_OBJECT_DEFAULTS: Readonly<ObjectDefaults> = { group: 0, polarity: 1, strength: MAGNET_DEFAULT_STRENGTH, radius: MAGNET_DEFAULT_RADIUS };

export function objectTemplate(item: Exclude<ObjectItem, 'erase'>, d: ObjectDefaults): CourseObject {
  switch (item) {
    case 'teleport': return { type: 'teleport', x: 0, y: 0, group: d.group };
    case 'magnet': return { type: 'magnet', x: 0, y: 0, polarity: d.polarity, strength: d.strength, radius: d.radius };
    default: return { type: item, x: 0, y: 0 };
  }
}

export function itemSelection(item: ObjectItem, d: ObjectDefaults): Selection {
  return item === 'erase' ? { kind: 'eraseObject' } : { kind: 'object', template: objectTemplate(item, d) };
}

/** Whether a palette item stands for the selection (object items match by type only; chips carry the rest). */
export function itemMatches(item: Selection, sel: Selection): boolean {
  if (item.kind !== sel.kind) return false;
  if (item.kind === 'surface' || item.kind === 'walls') return item.value === (sel as typeof item).value;
  if (item.kind === 'object' && sel.kind === 'object') return item.template.type === sel.template.type;
  return true; // eraseObject
}

export const surfaceName = (code: number): string => t(`editor.surface.${code}`);
export const wallName = (code: number): string => t(`editor.wall.${code}`);
export const objectName = (type: CourseObject['type']): string => t(`editor.object.${type}`);

/** Human-readable name of a selection (status bar). */
export function selectionName(sel: Selection): string {
  switch (sel.kind) {
    case 'surface': return surfaceName(sel.value);
    case 'walls': return sel.value === WallShape.None ? t('editor.wall.erase') : wallName(sel.value);
    case 'object':
      return sel.template.type === 'teleport' ? `${objectName('teleport')} ${sel.template.group + 1}` : objectName(sel.template.type);
    case 'eraseObject': return t('editor.object.erase');
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Swatches
// ---------------------------------------------------------------------------------------------------------------

type SwatchArt = { surface?: number; wall?: number; object?: CourseObject } | 'eraseWall' | 'eraseObject';
const SWATCH_PX = 2 * TILE; // the 15 px tile at 2x

function drawCross(ctx: ArtContext): void {
  ctx.strokeStyle = '#e0583f';
  ctx.lineWidth = 2;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(4, 4);
  ctx.lineTo(TILE - 4, TILE - 4);
  ctx.moveTo(TILE - 4, 4);
  ctx.lineTo(4, TILE - 4);
  ctx.stroke();
}

export function drawSwatch(canvas: HTMLCanvasElement, art: SwatchArt): void {
  const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
  canvas.width = Math.round(SWATCH_PX * dpr);
  canvas.height = Math.round(SWATCH_PX * dpr);
  canvas.style.width = `${SWATCH_PX}px`;
  canvas.style.height = `${SWATCH_PX}px`;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(2 * dpr, 0, 0, 2 * dpr, 0, 0);
  if (art === 'eraseWall') {
    drawLegendTile(ctx, 0, 0, { wall: WallShape.Full });
    ctx.globalAlpha = 0.55;
    drawLegendTile(ctx, 0, 0, {});
    ctx.globalAlpha = 1;
    drawCross(ctx);
  } else if (art === 'eraseObject') {
    drawLegendTile(ctx, 0, 0, { object: { type: 'mine', x: 0, y: 0 } });
    drawCross(ctx);
  } else {
    drawLegendTile(ctx, 0, 0, art);
  }
}

function artOf(sel: Selection): SwatchArt {
  switch (sel.kind) {
    case 'surface': return { surface: sel.value };
    case 'walls': return sel.value === WallShape.None ? 'eraseWall' : { wall: sel.value };
    case 'object': return sel.template.type === 'magnet' ? { wall: WallShape.Full, object: sel.template } : { object: sel.template };
    case 'eraseObject': return 'eraseObject';
  }
}

// ---------------------------------------------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------------------------------------------

export interface PaletteCallbacks {
  onTool(tool: ToolId): void;
  onTab(tab: PaletteTab): void;
  onSelect(sel: Selection): void;
}
export interface PaletteState { tool: ToolId; tab: PaletteTab; selection: Selection }
export interface PaletteView {
  root: HTMLElement;
  setTool(tool: ToolId): void;
  setTab(tab: PaletteTab): void;
  setSelection(sel: Selection): void;
  destroy(): void;
}

const keyOf = (map: Readonly<Record<string, string>>, value: string): string | undefined =>
  Object.keys(map).find((k) => map[k] === value);

export function createPalette(initial: PaletteState, cb: PaletteCallbacks): PaletteView {
  const defaults: ObjectDefaults = { ...INITIAL_OBJECT_DEFAULTS };
  let tool = initial.tool;
  let tab = initial.tab;
  let selection = initial.selection;

  const absorbDefaults = (sel: Selection): void => {
    if (sel.kind !== 'object') return;
    const o = sel.template;
    if (o.type === 'teleport') defaults.group = o.group;
    else if (o.type === 'magnet') {
      defaults.polarity = o.polarity;
      defaults.strength = o.strength;
      defaults.radius = o.radius;
    }
  };
  absorbDefaults(selection);

  // ---- tools
  const toolButtons = new Map<ToolId, HTMLButtonElement>();
  const toolGrid = el('div', { class: 'ed-tools' });
  for (const id of TOOL_IDS) {
    const key = keyOf(TOOL_KEYS, id);
    const b = el('button', { type: 'button', class: 'ed-tool', title: t(`editor.tool.${id}.hint`), 'aria-pressed': 'false' },
      el('span', { class: 'ed-tool__label' }, t(`editor.tool.${id}`)),
      key ? el('kbd', { class: 'ed-key' }, key.toUpperCase()) : null);
    b.addEventListener('click', () => cb.onTool(id));
    toolButtons.set(id, b);
    toolGrid.append(b);
  }

  // ---- tabs
  const tabButtons = new Map<PaletteTab, HTMLButtonElement>();
  const tabStrip = el('div', { class: 'ed-tabs', role: 'tablist' });
  for (const tb of PALETTE_TABS) {
    const key = keyOf(TAB_KEYS, tb);
    const b = el('button', { type: 'button', class: 'ed-tab', role: 'tab', 'aria-selected': 'false' },
      t(`editor.tab.${tb}`), key ? el('kbd', { class: 'ed-key' }, key) : null);
    b.addEventListener('click', () => cb.onTab(tb));
    tabButtons.set(tb, b);
    tabStrip.append(b);
  }

  const itemsHost = el('div', { class: 'ed-items-host', role: 'tabpanel' });
  const root = el('div', { class: 'ed-palette-inner' },
    el('div', { class: 'ed-subhead' }, t('editor.tools')),
    toolGrid,
    tabStrip,
    itemsHost,
    el('p', { class: 'ed-keys' }, t('editor.keys')),
  );

  // ---- items (rebuilt per tab; pressed states patched in place)
  interface ItemRef { button: HTMLButtonElement; sel(): Selection }
  let itemRefs: ItemRef[] = [];
  let groupChips: HTMLButtonElement[] = [];
  let polarityChips: { button: HTMLButtonElement; polarity: Polarity }[] = [];

  const itemButton = (label: string, sel: () => Selection): HTMLButtonElement => {
    const canvas = el('canvas', { 'aria-hidden': 'true' });
    drawSwatch(canvas, artOf(sel()));
    const b = el('button', { type: 'button', class: 'ed-item', title: label, 'aria-pressed': 'false' },
      canvas, el('span', { class: 'ed-item__label' }, label));
    b.addEventListener('click', () => cb.onSelect(sel()));
    itemRefs.push({ button: b, sel });
    return b;
  };

  const buildObjectOptions = (): HTMLElement => {
    const chips = el('div', { class: 'ed-chips' });
    for (let g = 0; g < 8; g++) {
      const group = g as TeleportGroup;
      const label = t('editor.teleport.groupN', { n: g + 1 });
      const b = el('button', { type: 'button', class: 'ed-chip', title: label, 'aria-label': label, 'aria-pressed': 'false' }, String(g + 1));
      b.style.setProperty('--chip', teleportColour(group));
      b.addEventListener('click', () => {
        defaults.group = group;
        rebuildItems();
        if (selection.kind === 'object' && selection.template.type === 'teleport') cb.onSelect(itemSelection('teleport', defaults));
      });
      groupChips.push(b);
      chips.append(b);
    }
    const pol = el('div', { class: 'ed-polarity' });
    for (const polarity of [1, -1] as const) {
      const b = el('button', { type: 'button', class: `ed-pol ed-pol--${polarity === 1 ? 'attract' : 'repel'}`, 'aria-pressed': 'false' },
        t(polarity === 1 ? 'editor.magnet.attract' : 'editor.magnet.repel'));
      b.addEventListener('click', () => {
        defaults.polarity = polarity;
        rebuildItems();
        if (selection.kind === 'object' && selection.template.type === 'magnet') cb.onSelect(itemSelection('magnet', defaults));
      });
      polarityChips.push({ button: b, polarity });
      pol.append(b);
    }
    return el('div', { class: 'ed-options' },
      el('div', { class: 'ed-subhead' }, t('editor.teleport.group')), chips,
      el('div', { class: 'ed-subhead' }, t('editor.magnet.polarity')), pol);
  };

  const syncPressed = (): void => {
    toolButtons.forEach((b, id) => b.setAttribute('aria-pressed', String(id === tool)));
    tabButtons.forEach((b, id) => {
      b.setAttribute('aria-selected', String(id === tab));
      b.tabIndex = id === tab ? 0 : -1;
    });
    for (const ref of itemRefs) ref.button.setAttribute('aria-pressed', String(itemMatches(ref.sel(), selection)));
    groupChips.forEach((b, g) => b.setAttribute('aria-pressed', String(g === defaults.group)));
    for (const c of polarityChips) c.button.setAttribute('aria-pressed', String(c.polarity === defaults.polarity));
  };

  function rebuildItems(): void {
    itemRefs = [];
    groupChips = [];
    polarityChips = [];
    const grid = el('div', { class: 'ed-items' });
    if (tab === 'surface') {
      for (const s of SURFACE_ITEMS) grid.append(itemButton(surfaceName(s), () => ({ kind: 'surface', value: s })));
    } else if (tab === 'walls') {
      for (const w of WALL_ITEMS) {
        grid.append(itemButton(w === WallShape.None ? t('editor.wall.erase') : wallName(w), () => ({ kind: 'walls', value: w })));
      }
    } else {
      for (const item of OBJECT_ITEMS) {
        grid.append(itemButton(item === 'erase' ? t('editor.object.erase') : objectName(item), () => itemSelection(item, defaults)));
      }
    }
    itemsHost.replaceChildren(grid);
    if (tab === 'objects') itemsHost.append(buildObjectOptions());
    syncPressed();
  }

  rebuildItems();

  return {
    root,
    setTool(id) {
      tool = id;
      syncPressed();
    },
    setTab(tb) {
      if (tb === tab) { syncPressed(); return; }
      tab = tb;
      rebuildItems();
    },
    setSelection(sel) {
      selection = sel;
      absorbDefaults(sel);
      const next = tabOfSelection(sel);
      if (next !== tab) {
        tab = next;
        rebuildItems();
      } else if (tab === 'objects' && sel.kind === 'object') {
        rebuildItems(); // teleport colour / magnet polarity swatches follow the picked properties
      } else {
        syncPressed();
      }
    },
    destroy() {
      root.remove();
    },
  };
}
