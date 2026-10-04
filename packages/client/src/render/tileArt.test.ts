// Smoke test (DESIGN §15 WP-D): every surface, wall shape and object draws without throwing against a minimal
// CanvasRenderingContext2D stub, and the stub records that something was actually painted.
import { describe, expect, it } from 'vitest';
import { COURSE_W, TILE, TILE_COUNT } from '@puttipeli/shared/constants';
import { Surface, WallShape, type CourseLayers, type CourseObject } from '@puttipeli/shared/course/types';
import { tileIndex } from '@puttipeli/shared/course/grid';
import type { BallState, SimEvent } from '@puttipeli/shared/sim/types';
import {
  ALL_SURFACES, ALL_WALLS, drawBorderFrame, drawLegendTile, drawObject, drawSurface, drawWall, type ArtContext,
} from './tileArt';
import { drawBall } from './ballArt';
import { drawAimLine } from './aimLine';
import { Effects } from './effects';
import { drawField } from './renderer';

interface Stub extends ArtContext { calls: number; fills: number; strokes: number; texts: string[] }

function makeStub(): Stub {
  const gradient = { addColorStop() {} } as unknown as CanvasGradient;
  const s = {
    calls: 0, fills: 0, strokes: 0, texts: [] as string[],
    fillStyle: '#000', strokeStyle: '#000', lineWidth: 1, lineCap: 'butt' as CanvasLineCap, lineJoin: 'miter' as CanvasLineJoin,
    globalAlpha: 1, font: '', textAlign: 'start' as CanvasTextAlign, textBaseline: 'alphabetic' as CanvasTextBaseline,
    fillRect() { s.calls++; s.fills++; },
    strokeRect() { s.calls++; s.strokes++; },
    clearRect() { s.calls++; },
    beginPath() { s.calls++; },
    moveTo() { s.calls++; },
    lineTo() { s.calls++; },
    arc() { s.calls++; },
    closePath() { s.calls++; },
    fill() { s.calls++; s.fills++; },
    stroke() { s.calls++; s.strokes++; },
    save() { s.calls++; },
    restore() { s.calls++; },
    translate() { s.calls++; },
    rect() { s.calls++; },
    clip() { s.calls++; },
    fillText(t: string) { s.calls++; s.texts.push(t); },
    createRadialGradient() { s.calls++; return gradient; },
  };
  return s as unknown as Stub;
}

const ball: BallState = { x: 100, y: 80, vx: 0, vy: 0, moving: false, lastTile: 0, teleportCooldownTile: -1, insideOneWay: -1, slowTicks: 0 };

describe('tileArt', () => {
  it('draws every surface code (detailed and flat) without throwing', () => {
    expect(ALL_SURFACES.length).toBe(10);
    for (const code of ALL_SURFACES) {
      for (const detail of [true, false]) {
        const ctx = makeStub();
        drawSurface(ctx, code, 15, 30, code * 31 + 7, detail);
        expect(ctx.fills).toBeGreaterThan(0);
      }
    }
    // Unknown code falls back to grass.
    const ctx = makeStub();
    drawSurface(ctx, 99, 0, 0, 1);
    expect(ctx.fills).toBeGreaterThan(0);
  });

  it('draws every wall shape at every crack level without throwing', () => {
    expect(ALL_WALLS.length).toBe(14);
    for (const code of ALL_WALLS) {
      for (const hits of [0, 1, 2, 5]) {
        for (const detail of [true, false]) {
          const ctx = makeStub();
          drawWall(ctx, code, 45, 60, hits, detail);
          expect(ctx.fills).toBeGreaterThan(0);
        }
      }
    }
    const none = makeStub();
    drawWall(none, WallShape.None, 0, 0);
    expect(none.calls).toBe(0);
  });

  it('draws every object type, including disarmed mines, both magnet polarities and the editor radius', () => {
    const objects: CourseObject[] = [
      { type: 'start', x: 1, y: 1 },
      { type: 'hole', x: 2, y: 1 },
      { type: 'teleport', x: 3, y: 1, group: 0 },
      { type: 'teleport', x: 4, y: 1, group: 7 },
      { type: 'magnet', x: 5, y: 1, polarity: 1, strength: 350, radius: 90 },
      { type: 'magnet', x: 6, y: 1, polarity: -1, strength: 50, radius: 30 },
      { type: 'mine', x: 7, y: 1 },
    ];
    for (const o of objects) {
      for (const opts of [{}, { armed: false, magnetRadius: true }, { detail: false }]) {
        const ctx = makeStub();
        drawObject(ctx, o, o.x * TILE, o.y * TILE, opts);
        expect(ctx.fills + ctx.strokes).toBeGreaterThan(0);
      }
    }
    const tp = makeStub();
    drawObject(tp, { type: 'teleport', x: 0, y: 0, group: 2 }, 0, 0);
    expect(tp.texts).toEqual(['3']); // digit = group + 1
  });

  it('draws the border frame and legend tiles', () => {
    const ctx = makeStub();
    drawBorderFrame(ctx, 0, 0, 765, 405, 15);
    expect(ctx.fills).toBeGreaterThan(8);
    const legend = makeStub();
    drawLegendTile(legend, 0, 0, { surface: Surface.Sand, wall: WallShape.Bumper, object: { type: 'mine', x: 0, y: 0 } });
    expect(legend.fills).toBeGreaterThan(3);
  });
});

describe('ball, aim line and effects', () => {
  it('drawBall draws with and without highlight', () => {
    for (const hl of [true, false]) {
      const ctx = makeStub();
      drawBall(ctx, 50, 50, 2, 0.6, hl, 1234);
      expect(ctx.fills).toBeGreaterThan(1);
      expect(ctx.strokes).toBeGreaterThan(hl ? 1 : 0);
    }
  });

  it('drawAimLine draws nothing for a zero pull and a full line with ticks at the cap', () => {
    const none = makeStub();
    drawAimLine(none, { from: { x: 0, y: 0 }, pull: { x: 0, y: 0 }, power: 0 });
    expect(none.calls).toBe(0);
    const full = makeStub();
    drawAimLine(full, { from: { x: 100, y: 100 }, pull: { x: 120, y: 0 }, power: 1 });
    expect(full.strokes).toBeGreaterThanOrEqual(4);
    expect(full.fills).toBeGreaterThanOrEqual(1);
    const half = makeStub();
    drawAimLine(half, { from: { x: 100, y: 100 }, pull: { x: 0, y: -60 }, power: 0.5 });
    expect(half.strokes).toBeGreaterThanOrEqual(3);
  });

  it('Effects spawns particles for every event type, updates and draws them', () => {
    const events: SimEvent[] = [
      { tick: 1, type: 'bounce', x: 10, y: 10, nx: 1, ny: 0, speed: 500, tile: 3, material: 'wall' },
      { tick: 2, type: 'break', tile: 60, hitsLeft: 1 },
      { tick: 3, type: 'destroyed', tile: 60 },
      { tick: 4, type: 'blockMoved', from: 70, to: 71 },
      { tick: 5, type: 'teleport', from: 100, to: 400 },
      { tick: 6, type: 'tar', tile: 5 },
      { tick: 7, type: 'water', tile: 6 },
      { tick: 8, type: 'acid', tile: 7 },
      { tick: 9, type: 'mine', index: 0 },
      { tick: 10, type: 'holed', hole: 0 },
      { tick: 11, type: 'stopped' },
      { tick: 12, type: 'timeout' },
    ];
    const fx = new Effects();
    for (const ev of events) fx.spawn(ev, ball);
    expect(fx.count).toBeGreaterThan(50);
    const ctx = makeStub();
    fx.update(16);
    fx.draw(ctx);
    expect(ctx.fills + ctx.strokes).toBeGreaterThan(50);
    fx.update(5000);
    expect(fx.count).toBe(0);
    fx.enabled = false;
    fx.spawn(events[9]!, ball);
    expect(fx.count).toBe(0);
    // A slow bounce spawns nothing.
    fx.enabled = true;
    fx.spawn({ tick: 1, type: 'bounce', x: 0, y: 0, nx: 0, ny: 1, speed: 50, tile: 0, material: 'border' }, ball);
    expect(fx.count).toBe(0);
  });
});

describe('drawField', () => {
  it('draws a hand-built course with every surface, wall and object against the stub', () => {
    const surface = new Uint8Array(TILE_COUNT);
    const walls = new Uint8Array(TILE_COUNT);
    ALL_SURFACES.forEach((s, i) => { surface[tileIndex(i + 1, 2)] = s; });
    ALL_WALLS.forEach((w, i) => { walls[tileIndex(i + 1, 4)] = w; });
    walls[tileIndex(10, 6)] = WallShape.Full;
    const objects: CourseObject[] = [
      { type: 'start', x: 2, y: 6 },
      { type: 'hole', x: 20, y: 6 },
      { type: 'teleport', x: 5, y: 8, group: 1 },
      { type: 'teleport', x: 30, y: 8, group: 1 },
      { type: 'magnet', x: 10, y: 6, polarity: 1, strength: 350, radius: 90 },
      { type: 'mine', x: 15, y: 6 },
      { type: 'mine', x: 16, y: 6 },
    ];
    const objectAt = new Int16Array(TILE_COUNT).fill(-1);
    objects.forEach((o, i) => { objectAt[tileIndex(o.x, o.y)] = i; });
    const layers: CourseLayers = {
      surface, walls, objectAt, objects,
      start: { x: 2.5 * TILE, y: 6.5 * TILE }, startTile: tileIndex(2, 6),
      holes: [{ tile: tileIndex(20, 6), cx: 20.5 * TILE, cy: 6.5 * TILE }],
      teleports: [
        { tile: tileIndex(5, 8), cx: 5.5 * TILE, cy: 8.5 * TILE, group: 1, partnerTile: tileIndex(30, 8), partnerIndex: 1 },
        { tile: tileIndex(30, 8), cx: 30.5 * TILE, cy: 8.5 * TILE, group: 1, partnerTile: tileIndex(5, 8), partnerIndex: 0 },
      ],
      magnets: [{ tile: tileIndex(10, 6), cx: 10.5 * TILE, cy: 6.5 * TILE, polarity: 1, strength: 350, radius: 90 }],
      mines: [{ tile: tileIndex(15, 6), cx: 15.5 * TILE, cy: 6.5 * TILE }, { tile: tileIndex(16, 6), cx: 16.5 * TILE, cy: 6.5 * TILE }],
      maxStrokes: 20, par: 3,
    };
    const world = { walls: walls.slice(), breakHits: new Uint8Array(TILE_COUNT), minesArmed: new Uint8Array([1, 0]) };
    world.breakHits[tileIndex(8, 4)] = 2; // cracked Breakable3
    const ctx = makeStub();
    drawField(ctx, layers, world);
    expect(ctx.fills).toBeGreaterThan(TILE_COUNT); // every tile painted at least once
    const flat = makeStub();
    drawField(flat, layers, null, { detail: false });
    expect(flat.fills).toBeGreaterThanOrEqual(TILE_COUNT);
    expect(COURSE_W).toBe(49);
  });
});
