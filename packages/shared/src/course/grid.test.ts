import { describe, expect, it } from 'vitest';
import { COURSE_H, COURSE_W, FIELD_H, FIELD_W, TILE, TILE_COUNT } from '../constants';
import { centreInsideTile, inBounds, tileCentre, tileIndex, tileOf, tileOrigin, tileX, tileY } from './grid';

describe('grid', () => {
  it('tileIndex / tileX / tileY round-trip every tile with integer results', () => {
    for (let i = 0; i < TILE_COUNT; i++) {
      const x = tileX(i);
      const y = tileY(i);
      expect(Number.isInteger(x) && Number.isInteger(y)).toBe(true);
      expect(inBounds(x, y)).toBe(true);
      expect(tileIndex(x, y)).toBe(i);
    }
    expect(tileIndex(0, 0)).toBe(0);
    expect(tileIndex(COURSE_W - 1, 0)).toBe(COURSE_W - 1);
    expect(tileIndex(0, 1)).toBe(COURSE_W);
    expect(tileIndex(COURSE_W - 1, COURSE_H - 1)).toBe(TILE_COUNT - 1);
    expect(tileX(COURSE_W)).toBe(0);
    expect(tileY(COURSE_W)).toBe(1);
  });

  it('inBounds', () => {
    expect(inBounds(0, 0)).toBe(true);
    expect(inBounds(COURSE_W - 1, COURSE_H - 1)).toBe(true);
    expect(inBounds(-1, 0)).toBe(false);
    expect(inBounds(0, -1)).toBe(false);
    expect(inBounds(COURSE_W, 0)).toBe(false);
    expect(inBounds(0, COURSE_H)).toBe(false);
  });

  it('tileOf maps world points to tiles (left/top edge inclusive)', () => {
    expect(tileOf(0, 0)).toBe(0);
    expect(tileOf(7.5, 7.5)).toBe(0);
    expect(tileOf(TILE - 1e-6, 0)).toBe(0);
    expect(tileOf(TILE, 0)).toBe(1);
    expect(tileOf(0, TILE)).toBe(COURSE_W);
    expect(tileOf(2 * TILE + 0.001, 3 * TILE + 14.999)).toBe(tileIndex(2, 3));
    expect(tileOf(FIELD_W - 0.001, FIELD_H - 0.001)).toBe(TILE_COUNT - 1);
    for (let i = 0; i < TILE_COUNT; i++) {
      const c = tileCentre(i);
      expect(tileOf(c.x, c.y)).toBe(i);
      const o = tileOrigin(i);
      expect(tileOf(o.x, o.y)).toBe(i);
    }
  });

  it('tileOf clamps points outside the field onto the border tiles', () => {
    expect(tileOf(-100, -100)).toBe(0);
    expect(tileOf(-0.001, 7)).toBe(0);
    expect(tileOf(FIELD_W, FIELD_H)).toBe(TILE_COUNT - 1);
    expect(tileOf(FIELD_W, 0)).toBe(COURSE_W - 1);
    expect(tileOf(FIELD_W + 1000, 0)).toBe(COURSE_W - 1);
    expect(tileOf(0, FIELD_H + 1000)).toBe(tileIndex(0, COURSE_H - 1));
    expect(tileOf(7, FIELD_H)).toBe(tileIndex(0, COURSE_H - 1));
  });

  it('tileOf never returns NaN: a NaN coordinate clamps to 0 like a negative one', () => {
    expect(tileOf(NaN, NaN)).toBe(0);
    expect(tileOf(NaN, 3 * TILE)).toBe(tileIndex(0, 3));
    expect(tileOf(2 * TILE, NaN)).toBe(tileIndex(2, 0));
    expect(tileOf(-0, -0)).toBe(0);
    expect(Number.isInteger(tileOf(Infinity, -Infinity))).toBe(true);
    expect(tileOf(Infinity, -Infinity)).toBe(COURSE_W - 1);
  });

  it('tileCentre / tileOrigin / centreInsideTile', () => {
    expect(tileOrigin(0)).toEqual({ x: 0, y: 0 });
    expect(tileCentre(0)).toEqual({ x: 7.5, y: 7.5 });
    const i = tileIndex(3, 2);
    expect(tileOrigin(i)).toEqual({ x: 45, y: 30 });
    expect(tileCentre(i)).toEqual({ x: 52.5, y: 37.5 });
    expect(centreInsideTile(52.5, 37.5, i)).toBe(true);
    expect(centreInsideTile(45, 30, i)).toBe(true); // top-left corner belongs to the tile
    expect(centreInsideTile(60, 30, i)).toBe(false); // right edge belongs to the neighbour
    expect(centreInsideTile(52.5, 45, i)).toBe(false); // bottom edge belongs to the tile below
    expect(centreInsideTile(44.999, 37.5, i)).toBe(false);
    expect(tileCentre(TILE_COUNT - 1)).toEqual({ x: FIELD_W - 7.5, y: FIELD_H - 7.5 });
  });
});
