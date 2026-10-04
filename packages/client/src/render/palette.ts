// Colour palette for the procedural art (DESIGN §12.2). Every colour in the game is defined here; tileArt.ts,
// ballArt.ts, aimLine.ts and effects.ts never hard-code a colour string. All colours are original choices.
import type { PlayerColour } from '@puttipeli/shared/game/types';
import type { TeleportGroup } from '@puttipeli/shared/course/types';

/** Player ball ring colours, index = PlayerColour (0..3). */
export const PLAYER_COLOURS: readonly string[] = ['#e23b3b', '#2f6fdd', '#f0b429', '#2fa84f'];
export const PLAYER_COLOUR_NAMES_FI: readonly string[] = ['Punainen', 'Sininen', 'Keltainen', 'Vihreä'];
export const playerColour = (c: PlayerColour | number): string => PLAYER_COLOURS[c] ?? PLAYER_COLOURS[0]!;

/** Teleport group colours, index = TeleportGroup (0..7). Chosen to stay distinguishable on grass. */
export const TELEPORT_COLOURS: readonly string[] = [
  '#ff5fa2', '#3fd0ff', '#ffd93f', '#b06bff', '#ff8a3f', '#4dffb0', '#ffffff', '#ff3f3f',
];
export const teleportColour = (g: TeleportGroup | number): string => TELEPORT_COLOURS[g] ?? TELEPORT_COLOURS[0]!;

/** Surfaces. `base` fills the tile; `dark`/`light` are detail accents. */
export const SURFACE_PALETTE = {
  grass: { base: '#4e9b3c', dark: '#3f8630', light: '#5caa48' },
  slope: { base: '#4a9238', dark: '#2f6a24', light: '#5aa546' },
  sand: { base: '#d9c47c', dark: '#bda55c', light: '#e9d899' },
  ice: { base: '#bfe4f4', dark: '#9ccbe0', light: '#f2fbff' },
  tar: { base: '#1a181d', dark: '#0d0c0f', light: '#3b3842' },
  water: { base: '#2d6fcc', dark: '#245bab', light: '#6ea3e8' },
  acid: { base: '#9ccf1f', dark: '#7fae12', light: '#c9ef5a' },
} as const;

/** Walls. Bevel: `light` on the top-left edges, `dark` on the bottom-right (DESIGN §12.2). */
export const WALL_PALETTE = {
  stone: { base: '#8a7a69', light: '#b7a68f', dark: '#58493d' },
  border: { base: '#6f6052', light: '#9a8a76', dark: '#3f352c' },
  brick: { base: '#a95640', light: '#c97a62', dark: '#6f3426', mortar: '#d9ab93', crack: '#2a1410' },
  movable: { base: '#6e7f95', light: '#97a7bb', dark: '#44505f', glyph: '#f4f7fb' },
  bumper: { base: '#4a4a52', light: '#737380', dark: '#2a2a30', ring: '#e23b3b', ringLight: '#ff7a7a' },
  oneWay: { base: '#7c8a63', light: '#a6b48b', dark: '#4e5a3b', face: '#d8e6b6', arrow: '#f4f7ea' },
} as const;

export const OBJECT_PALETTE = {
  hole: { cup: '#0f0f12', rim: '#2b2b33', shadow: '#000000', post: '#e8e8e8', flag: '#e23b3b' },
  start: { ring: '#f7f7f0', inner: '#ffffff' },
  mine: { body: '#262630', spike: '#3c3c48', dot: '#e23b3b', disarmed: '#8c8c94', disarmedSpike: '#a5a5ad' },
  magnet: { attract: '#d93838', repel: '#2f6fdd', sign: '#ffffff' },
  teleportDigit: '#101014',
} as const;

export const BALL_PALETTE = { body: '#ffffff', shade: '#c9ccd2', highlight: '#ffffff', shadow: 'rgba(0,0,0,0.25)' } as const;

export const AIM_PALETTE = { low: { r: 255, g: 255, b: 255 }, high: { r: 232, g: 48, b: 48 }, tick: 'rgba(255,255,255,0.85)', cap: '#ff3030' } as const;

export const EDITOR_PALETTE = {
  grid: 'rgba(255,255,255,0.12)',
  gridMajor: 'rgba(255,255,255,0.25)',
  hover: 'rgba(255,255,255,0.35)',
  highlight: 'rgba(255,220,60,0.55)',
  magnetRadius: 'rgba(255,255,255,0.35)',
  teleportLink: 'rgba(255,255,255,0.5)',
} as const;

export const EFFECT_PALETTE = {
  dust: '#d8d2c4',
  splash: '#9ec9ff',
  acid: '#d6ff6a',
  mine: ['#ffb347', '#ff6a3d', '#5a5a66'],
  debris: ['#a95640', '#6f3426', '#d9ab93'],
  teleport: '#ffffff',
  confetti: ['#e23b3b', '#2f6fdd', '#f0b429', '#2fa84f', '#ff5fa2', '#3fd0ff'],
  tar: '#1a181d',
  slide: '#97a7bb',
} as const;

/** Interpolates two RGB colours; t clamped to [0, 1]. */
export function mixRgb(a: { r: number; g: number; b: number }, b: { r: number; g: number; b: number }, t: number): string {
  const k = t < 0 ? 0 : t > 1 ? 1 : t;
  const r = Math.round(a.r + (b.r - a.r) * k);
  const g = Math.round(a.g + (b.g - a.g) * k);
  const bl = Math.round(a.b + (b.b - a.b) * k);
  return `rgb(${r},${g},${bl})`;
}
