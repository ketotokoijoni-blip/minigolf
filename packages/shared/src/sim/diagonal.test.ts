import { afterEach, describe, expect, it } from 'vitest';
import { BALL_RADIUS, PENETRATION_SLOP, RESTITUTION_WALL, TILE } from '../constants';
import { resolveCollisions } from './collision';
import { blankRows, borderRows, buildLayers, freshWorld, launch, makeContext, paint, paintRow, runTicks, start } from './testCourses';
import { resetSimTuning } from './tuning';
import type { SimEvent } from './types';
import { createBallAt } from './worldState';

const R = BALL_RADIUS;
const S = Math.SQRT1_2;
const E = RESTITUTION_WALL;

afterEach(() => resetSimTuning());

// Isolated triangle at tile (20, 12), origin (300, 180). For each shape: char, outward hypotenuse normal, the two
// cardinal approach velocities (unit) that hit the hypotenuse from the open half.
const TRIANGLES: [string, number, number, [number, number][]][] = [
  ['7', S, S, [[-1, 0], [0, -1]]],   // TriNW: open SE half
  ['9', -S, S, [[1, 0], [0, -1]]],   // TriNE: open SW half
  ['3', -S, -S, [[1, 0], [0, 1]]],   // TriSE: open NW half
  ['1', S, -S, [[-1, 0], [0, 1]]],   // TriSW: open NE half
];
const OX = 300;
const OY = 180;
const MID = { x: OX + TILE / 2, y: OY + TILE / 2 };

function triangleLayers(ch: string) {
  const rows = blankRows('.');
  paint(rows, 20, 12, ch);
  return buildLayers(blankRows('.'), rows, [start(3, 3)]);
}

describe('diagonal walls', () => {
  for (const [ch, nx, ny, approaches] of TRIANGLES) {
    for (const [ux, uy] of approaches) {
      it(`'${ch}' turns a cardinal shot (${ux}, ${uy}) by 90 degrees: v' = v - (1+e)(v.n)n within 1e-9`, () => {
        const layers = triangleLayers(ch);
        const world = freshWorld(layers);
        const u = 200;
        // centre 1 px inside the contact distance along the normal, at the hypotenuse midpoint
        const ball = createBallAt({ x: MID.x + nx * (R - 1), y: MID.y + ny * (R - 1) });
        launch(ball, ux * u, uy * u);
        const events: SimEvent[] = [];
        resolveCollisions(layers, world, ball, makeContext(layers, ball), events);
        const vn = ux * u * nx + uy * u * ny;
        expect(vn).toBeLessThan(0);
        expect(ball.vx).toBeCloseTo(ux * u - (1 + E) * vn * nx, 9);
        expect(ball.vy).toBeCloseTo(uy * u - (1 + E) * vn * ny, 9);
        // the ball turned 90 degrees keeping 0.89 of its speed along the new axis (0.11 residual = restitution loss)
        const turned = ux !== 0 ? Math.abs(ball.vy) : Math.abs(ball.vx);
        const residual = ux !== 0 ? Math.abs(ball.vx) : Math.abs(ball.vy);
        expect(turned).toBeCloseTo((1 + E) * u * S * S, 9);
        expect(residual).toBeCloseTo(u - (1 + E) * u * S * S, 9);
        // pushed out along the hypotenuse normal to R + slop
        const d = (ball.x - MID.x) * nx + (ball.y - MID.y) * ny;
        expect(d).toBeCloseTo(R + PENETRATION_SLOP, 9);
        expect(events).toHaveLength(1);
        expect(events[0]).toMatchObject({ type: 'bounce', material: 'wall' });
        expect((events[0] as { speed: number }).speed).toBeCloseTo(-vn, 9);
        expect((events[0] as { nx: number }).nx).toBeCloseTo(nx, 12);
        expect((events[0] as { ny: number }).ny).toBeCloseTo(ny, 12);
      });
    }

    it(`'${ch}' head-on sweep 50..900 px/s never penetrates the hypotenuse`, () => {
      const layers = triangleLayers(ch);
      for (let speed = 50; speed <= 900; speed += 50) {
        const world = freshWorld(layers);
        const ball = createBallAt({ x: MID.x + nx * (R + 2), y: MID.y + ny * (R + 2) }); // 2 px before contact
        launch(ball, -nx * speed, -ny * speed);
        const ctx = makeContext(layers, ball);
        const events: SimEvent[] = [];
        let bounced = false;
        let minD = Infinity;
        runTicks(layers, world, ball, ctx, events, () => {
          const d = (ball.x - MID.x) * nx + (ball.y - MID.y) * ny; // signed distance to the hypotenuse line
          const along = (ball.x - MID.x) * -ny + (ball.y - MID.y) * nx; // coordinate along the hypotenuse
          if (Math.abs(along) <= TILE * S + R) minD = Math.min(minD, d); // only while alongside the segment
          if (ball.vx * nx + ball.vy * ny > 0) bounced = true;
        });
        expect(minD, `speed ${speed}`).toBeGreaterThanOrEqual(R - 1e-9);
        expect(bounced, `speed ${speed}`).toBe(true);
        const bounces = events.filter((e) => e.type === 'bounce') as Extract<SimEvent, { type: 'bounce' }>[];
        expect(bounces.length).toBeGreaterThanOrEqual(1);
        expect(bounces[0]!.nx).toBeCloseTo(nx, 12);
        expect(bounces[0]!.ny).toBeCloseTo(ny, 12);
      }
    });
  }

  it('a triangle next to a full wall forms one continuous ramp (no corner bounce at the join)', () => {
    const rows = borderRows();
    paintRow(rows, 12, 10, 20, '#'); // top face y = 180 from x = 150 to 300 (tile 20's N face is under the triangle)
    paint(rows, 20, 11, '3');         // TriSE above the row's last tile: hypotenuse (315,165) -> (300,180), normal (-s,-s)
    const layers = buildLayers(blankRows('.'), rows, [start(3, 3)]);
    const world = freshWorld(layers);
    const ball = createBallAt({ x: 160, y: 180 - R - 0.2 });
    launch(ball, 300, 3);
    const ctx = makeContext(layers, ball);
    const events: SimEvent[] = [];
    runTicks(layers, world, ball, ctx, events, () => {
      expect(ball.y).toBeLessThanOrEqual(180 - R + 1e-9); // never into the row
    });
    const bounces = events.filter((e) => e.type === 'bounce') as Extract<SimEvent, { type: 'bounce' }>[];
    const flat = bounces.filter((b) => b.nx === 0 && b.ny === -1);
    const ramp = bounces.filter((b) => Math.abs(b.nx + S) < 1e-12 && Math.abs(b.ny + S) < 1e-12);
    expect(flat.length + ramp.length).toBe(bounces.filter((b) => b.x < 330 && b.y > 120).length);
    expect(ramp.length).toBeGreaterThanOrEqual(1);
    // the disc meets the ramp line just before its centre passes the join at x = 300
    expect(ramp[0]!.x).toBeGreaterThan(290);
    expect(ramp[0]!.x).toBeLessThan(312);
    // after the ramp the ball travels north
    const afterRamp = events.findIndex((e) => e === ramp[0]);
    expect(afterRamp).toBeGreaterThanOrEqual(0);
    expect(ball.y).toBeLessThan(150);
  });
});
