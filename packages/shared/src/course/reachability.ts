// Start -> hole reachability by flood fill (DESIGN §7.6, D22). Warning source only, never an error.
import { COURSE_H, COURSE_W, TILE_COUNT } from '../constants';
import { isBreakable, isOneWay } from './chars';
import { tileIndex, tileX, tileY } from './grid';
import { Surface, WallShape, type CourseLayers } from './types';

/** A tile the ball could in principle occupy: wall in {None, OneWay*, Breakable*, Movable} and surface not Water/Acid. */
export function isPotentiallyPassable(wall: number, surface: number): boolean {
  if (surface === Surface.Water || surface === Surface.Acid) return false;
  return wall === WallShape.None || isOneWay(wall) || isBreakable(wall) || wall === WallShape.Movable;
}

/** Tiles reachable from `from` over 4-connected potentially passable tiles, with teleporter edges. Returns a 0/1 mask. */
export function reachableTiles(layers: CourseLayers, from: number = layers.startTile): Uint8Array {
  const seen = new Uint8Array(TILE_COUNT);
  if (from < 0 || from >= TILE_COUNT) return seen;
  const padPartner = new Int16Array(TILE_COUNT);
  padPartner.fill(-1);
  for (const pad of layers.teleports) padPartner[pad.tile] = pad.partnerTile;

  const queue: number[] = [from];
  seen[from] = 1;
  let head = 0;
  const visit = (x: number, y: number): void => {
    if (x < 0 || y < 0 || x >= COURSE_W || y >= COURSE_H) return;
    const i = tileIndex(x, y);
    if (seen[i]) return;
    if (!isPotentiallyPassable(layers.walls[i] ?? 0, layers.surface[i] ?? 0)) return;
    seen[i] = 1;
    queue.push(i);
  };
  while (head < queue.length) {
    const i = queue[head++]!;
    const x = tileX(i);
    const y = tileY(i);
    visit(x + 1, y);
    visit(x - 1, y);
    visit(x, y + 1);
    visit(x, y - 1);
    const partner = padPartner[i] ?? -1;
    if (partner >= 0 && !seen[partner]) {
      seen[partner] = 1;
      queue.push(partner);
    }
  }
  return seen;
}

/** True if any hole tile is reachable from the start through potentially passable tiles (teleporters included). */
export function isHoleReachable(layers: CourseLayers): boolean {
  const seen = reachableTiles(layers);
  for (const h of layers.holes) if (seen[h.tile]) return true;
  return false;
}
