// Integer tile arithmetic shared by the course model (WP-A), the sim (WP-B) and the client (DESIGN §5.7, §7.2).
// Depends on constants.ts only.
import { COURSE_W, COURSE_H, TILE, FIELD_W, FIELD_H } from '../constants';
import type { Vec2 } from './types';

export const tileIndex = (x: number, y: number): number => y * COURSE_W + x;
export const tileX = (i: number): number => i % COURSE_W;                       // integer ops only
export const tileY = (i: number): number => (i - (i % COURSE_W)) / COURSE_W;
export const inBounds = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < COURSE_W && y < COURSE_H;

const CLAMP_X = FIELD_W - 1e-9; // largest coordinate that still floors into the last column
const CLAMP_Y = FIELD_H - 1e-9;

/** Tile under a world point; the point is clamped into [0, FIELD_W - 1e-9] x [0, FIELD_H - 1e-9] first. Uses Math.floor only.
 *  The clamp is written as `!(v > 0)` so a NaN coordinate lands on 0 (tile 0 / column 0) instead of yielding NaN. */
export function tileOf(px: number, py: number): number {
  const cx = !(px > 0) ? 0 : px > CLAMP_X ? CLAMP_X : px;
  const cy = !(py > 0) ? 0 : py > CLAMP_Y ? CLAMP_Y : py;
  return tileIndex(Math.floor(cx / TILE), Math.floor(cy / TILE));
}

export const tileCentre = (i: number): Vec2 => ({ x: (tileX(i) + 0.5) * TILE, y: (tileY(i) + 0.5) * TILE });
export const tileOrigin = (i: number): Vec2 => ({ x: tileX(i) * TILE, y: tileY(i) * TILE });
/** tileOf(px, py) === i: the point lies in tile i (left/top edges inclusive, right/bottom edges exclusive). */
export const centreInsideTile = (px: number, py: number, i: number): boolean => tileOf(px, py) === i;
