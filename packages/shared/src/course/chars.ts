import { Surface, WallShape } from './types';

/** Index = code. Surface: grass sand ice tar water acid slopeN slopeE slopeS slopeW (numpad digits point downhill). */
export const SURFACE_CHARS = '.sitwa8624';
/** Index = code. Walls: none full triNW triNE triSE triSW breakable1/2/3 movable bumper oneWayN/E/S/W (numpad digits = solid corner). */
export const WALL_CHARS = '.#7931xyzMO^>v<';

export function surfaceFromChar(c: string): Surface | undefined {
  const i = SURFACE_CHARS.indexOf(c);
  return i < 0 ? undefined : (i as Surface);
}
export function wallFromChar(c: string): WallShape | undefined {
  const i = WALL_CHARS.indexOf(c);
  return i < 0 ? undefined : (i as WallShape);
}
export const charOfSurface = (s: Surface): string => SURFACE_CHARS[s]!;
export const charOfWall = (w: WallShape): string => WALL_CHARS[w]!;

export const isSlope = (s: number): boolean => s >= Surface.SlopeN && s <= Surface.SlopeW;
export const isTriangle = (w: number): boolean => w >= WallShape.TriNW && w <= WallShape.TriSW;
export const isBreakable = (w: number): boolean => w >= WallShape.Breakable1 && w <= WallShape.Breakable3;
export const isOneWay = (w: number): boolean => w >= WallShape.OneWayN && w <= WallShape.OneWayW;
/** Full-footprint blocks (everything solid except None and triangles). */
export const isFullBlock = (w: number): boolean => w === WallShape.Full || w >= WallShape.Breakable1;
export const breakableHits = (w: number): number => (isBreakable(w) ? w - WallShape.Breakable1 + 1 : 0);
/** Unit direction of one-way passage / slope downhill: 0 N(0,-1) 1 E(1,0) 2 S(0,1) 3 W(-1,0). */
export const DIR_DX = [0, 1, 0, -1] as const;
export const DIR_DY = [-1, 0, 1, 0] as const;
export const oneWayDir = (w: number): number => w - WallShape.OneWayN; // 0..3
export const slopeDir = (s: number): number => s - Surface.SlopeN;    // 0..3
