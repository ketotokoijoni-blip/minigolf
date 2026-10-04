import { afterEach, describe, expect, it } from 'vitest';
import { BALL_RADIUS, COURSE_H, COURSE_W, FIELD_H, FIELD_W, PENETRATION_SLOP, RESTITUTION_WALL, TILE, FRICTION_GRASS, DT } from '../constants';
import { tileIndex } from '../course/grid';
import { closestPointOnSegment, resolveCollisions } from './collision';
import { collectSegments, createSegmentBuffer } from './segments';
import type { Segment } from './segments';
import { blankRows, borderRows, buildLayers, freshWorld, launch, makeContext, paint, paintCol, paintRow, runTicks, start } from './testCourses';
import { resetSimTuning } from './tuning';
import type { SimEvent } from './types';
import { createBallAt } from './worldState';

const R = BALL_RADIUS;
const S = Math.SQRT1_2;

afterEach(() => resetSimTuning());

function segmentsAround(walls: Uint8Array, tx: number, ty: number): Segment[] {
  const buf = createSegmentBuffer();
  const n = collectSegments(walls, tx, ty, buf);
  return buf.slice(0, n).map((s) => ({ ...s }));
}

describe('closestPointOnSegment', () => {
  it('projects onto the interior and clamps to the endpoints', () => {
    expect(closestPointOnSegment(5, 3, 0, 0, 10, 0)).toEqual({ x: 5, y: 0, t: 0.5 });
    expect(closestPointOnSegment(-4, 3, 0, 0, 10, 0)).toEqual({ x: 0, y: 0, t: 0 });
    expect(closestPointOnSegment(14, -3, 0, 0, 10, 0)).toEqual({ x: 10, y: 0, t: 1 });
    const q = closestPointOnSegment(0, 10, 0, 0, 10, 10);
    expect(q.t).toBeCloseTo(0.5, 12);
    expect(q.x).toBeCloseTo(5, 12);
    expect(q.y).toBeCloseTo(5, 12);
  });
});

describe('collectSegments culling', () => {
  it('a straight wall yields one flush face per tile and no inner seams', () => {
    const rows = blankRows('.');
    paintRow(rows, 10, 5, 14, '#');
    const layers = buildLayers(blankRows('.'), rows, [start(3, 3)]);
    const segs = segmentsAround(layers.walls, 9, 11); // ball below the middle of the wall
    const ofWall = segs.filter((s) => s.tile !== -1);
    // tiles 8, 9, 10 of row 10: each contributes N and S faces only (E/W faces are shared with a wall neighbour)
    expect(ofWall.map((s) => [s.tile, s.side])).toEqual([
      [tileIndex(8, 10), 0], [tileIndex(8, 10), 2],
      [tileIndex(9, 10), 0], [tileIndex(9, 10), 2],
      [tileIndex(10, 10), 0], [tileIndex(10, 10), 2],
    ]);
    for (const s of ofWall) {
      expect(s.material).toBe('wall');
      expect(s.dir).toBe(-1);
      expect(Math.abs(s.nx) + Math.abs(s.ny)).toBe(1);
    }
    // the wall's west end keeps its W face, the east end its E face
    const west = segmentsAround(layers.walls, 4, 10).filter((s) => s.tile === tileIndex(5, 10));
    expect(west.map((s) => s.side)).toEqual([0, 2, 3]);
    const east = segmentsAround(layers.walls, 15, 10).filter((s) => s.tile === tileIndex(14, 10));
    expect(east.map((s) => s.side)).toEqual([0, 1, 2]);
  });

  it('triangles emit their legs and an unculled hypotenuse with the right normals', () => {
    const rows = blankRows('.');
    paint(rows, 10, 10, '7'); // TriNW
    paint(rows, 12, 10, '9'); // TriNE
    paint(rows, 10, 12, '1'); // TriSW
    paint(rows, 12, 12, '3'); // TriSE
    const layers = buildLayers(blankRows('.'), rows, [start(3, 3)]);
    const segs = segmentsAround(layers.walls, 11, 11);
    const byTile = (x: number, y: number) => segs.filter((s) => s.tile === tileIndex(x, y));
    const nw = byTile(10, 10);
    expect(nw.map((s) => s.side)).toEqual([0, 3, 4]);
    expect(nw[2]).toMatchObject({ ax: 165, ay: 150, bx: 150, by: 165, nx: S, ny: S });
    const ne = byTile(12, 10);
    expect(ne.map((s) => s.side)).toEqual([0, 1, 4]);
    expect(ne[2]).toMatchObject({ ax: 180, ay: 150, bx: 195, by: 165, nx: -S, ny: S });
    const sw = byTile(10, 12);
    expect(sw.map((s) => s.side)).toEqual([2, 3, 4]);
    expect(sw[2]).toMatchObject({ ax: 150, ay: 180, bx: 165, by: 195, nx: S, ny: -S });
    const se = byTile(12, 12);
    expect(se.map((s) => s.side)).toEqual([1, 2, 4]);
    expect(se[2]).toMatchObject({ ax: 195, ay: 180, bx: 180, by: 195, nx: -S, ny: -S });
  });

  it('a triangle leg against a full wall is culled on both sides, a one-way block culls nothing', () => {
    const rows = blankRows('.');
    paint(rows, 10, 10, '#');
    paint(rows, 10, 11, '3'); // TriSE below the block: S/E legs; its N side is open so the block keeps its S face
    paint(rows, 10, 9, '7');  // TriNW above the block: N/W legs; its S side is open
    paint(rows, 20, 10, '#');
    paint(rows, 21, 10, '>'); // one-way east of a block
    const layers = buildLayers(blankRows('.'), rows, [start(3, 3)]);
    const a = segmentsAround(layers.walls, 10, 10);
    const block = a.filter((s) => s.tile === tileIndex(10, 10)).map((s) => s.side);
    expect(block).toEqual([0, 1, 2, 3]); // both triangles leave the shared sides open (NW's S side and SE's N side are hypotenuse sides)
    paint(rows, 10, 11, '9'); // TriNE below the block: N leg faces the block -> culled on both sides
    const layers2 = buildLayers(blankRows('.'), rows, [start(3, 3)]);
    const b = segmentsAround(layers2.walls, 10, 10);
    expect(b.filter((s) => s.tile === tileIndex(10, 10)).map((s) => s.side)).toEqual([0, 1, 3]);
    expect(b.filter((s) => s.tile === tileIndex(10, 11)).map((s) => s.side)).toEqual([1, 4]);
    const c = segmentsAround(layers.walls, 20, 10);
    expect(c.filter((s) => s.tile === tileIndex(20, 10)).map((s) => s.side)).toEqual([0, 1, 2, 3]); // E face kept: neighbour is one-way
    const ow = c.filter((s) => s.tile === tileIndex(21, 10));
    expect(ow.map((s) => s.side)).toEqual([0, 1, 2, 3]); // one-way never culls its own edges
    for (const s of ow) {
      expect(s.material).toBe('oneway');
      expect(s.dir).toBe(1);
    }
  });

  it('out-of-bounds tiles are Full border blocks whose field-facing edges are emitted', () => {
    const layers = buildLayers(blankRows('.'), blankRows('.'), [start(3, 3)]);
    const corner = segmentsAround(layers.walls, 0, 0);
    expect(corner.every((s) => s.tile === -1 && s.material === 'border')).toBe(true);
    // W border (x = -1, y = 0): its E face; N border (x = 0, y = -1): its S face; the diagonal (-1,-1) emits nothing
    expect(corner.map((s) => [s.side, s.ax, s.ay, s.bx, s.by, s.nx, s.ny])).toEqual([
      [2, 0, 0, TILE, 0, 0, 1],      // (0,-1) south face
      [2, TILE, 0, 2 * TILE, 0, 0, 1],
      [1, 0, 0, 0, TILE, 1, 0],      // (-1,0) east face
      [1, 0, TILE, 0, 2 * TILE, 1, 0],
    ]);
    const far = segmentsAround(layers.walls, COURSE_W - 1, COURSE_H - 1);
    expect(far.map((s) => [s.side, s.ax, s.by])).toEqual([
      [3, FIELD_W, (COURSE_H - 1) * TILE], // (49,23) west face
      [3, FIELD_W, FIELD_H],               // (49,24) west face
      [0, (COURSE_W - 2) * TILE, FIELD_H], // (47,25) north face
      [0, (COURSE_W - 1) * TILE, FIELD_H], // (48,25) north face; (49,25) is culled by its out-of-bounds neighbours
    ]);
  });

  it('is allocation-free: fills the preallocated buffer in place and reports at most 36 segments', () => {
    const rows = blankRows('#');
    const layers = buildLayers(blankRows('.'), rows, [start(3, 3)]);
    const buf = createSegmentBuffer();
    const ids = buf.slice();
    const n = collectSegments(layers.walls, 1, 1, buf);
    expect(n).toBe(0); // every edge is shared with another full block
    const hollow = blankRows('.');
    paint(hollow, 10, 10, '#');
    paint(hollow, 12, 10, '#');
    paint(hollow, 10, 12, '#');
    paint(hollow, 12, 12, '#');
    paint(hollow, 11, 11, '#');
    const l2 = buildLayers(blankRows('.'), hollow, [start(3, 3)]);
    const m = collectSegments(l2.walls, 11, 11, buf);
    expect(m).toBe(20);
    expect(buf.length).toBe(ids.length);
    for (let i = 0; i < buf.length; i++) expect(buf[i]).toBe(ids[i]);
  });
});

describe('head-on bounces', () => {
  const cases: [string, number, number, number, number, number, number][] = [
    // name, ball x, ball y, vx, vy, expected normal nx, ny   (border ring of the course: inner faces at 15 and 720/360)
    ['east wall', FIELD_W - TILE - R + 1, 187.5, 300, 0, -1, 0],
    ['west wall', TILE + R - 1, 187.5, -300, 0, 1, 0],
    ['south wall', 367.5, FIELD_H - TILE - R + 1, 0, 300, 0, -1],
    ['north wall', 367.5, TILE + R - 1, 0, -300, 0, 1],
  ];
  for (const [name, x, y, vx, vy, nx, ny] of cases) {
    it(`${name}: 0.78x speed, pushed to exactly BALL_RADIUS + slop from the face`, () => {
      const layers = buildLayers(blankRows('.'), borderRows(), [start(24, 12)]);
      const world = freshWorld(layers);
      const ball = createBallAt({ x, y });
      launch(ball, vx, vy);
      const events: SimEvent[] = [];
      resolveCollisions(layers, world, ball, makeContext(layers, ball), events);
      const speedBefore = Math.abs(vx + vy);
      expect(Math.abs(ball.vx + ball.vy)).toBeCloseTo(RESTITUTION_WALL * speedBefore, 9);
      expect(Math.sign(ball.vx + ball.vy)).toBe(Math.sign(nx + ny));
      const faceX = nx === -1 ? FIELD_W - TILE : nx === 1 ? TILE : null;
      const faceY = ny === -1 ? FIELD_H - TILE : ny === 1 ? TILE : null;
      if (faceX !== null) expect(Math.abs(ball.x - faceX)).toBeCloseTo(R + PENETRATION_SLOP, 9);
      if (faceY !== null) expect(Math.abs(ball.y - faceY)).toBeCloseTo(R + PENETRATION_SLOP, 9);
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ type: 'bounce', nx, ny, speed: speedBefore, material: 'wall' });
    });
  }

  it('through the sim: the bounce tick reflects exactly the friction-reduced velocity', () => {
    const layers = buildLayers(blankRows('.'), borderRows(), [start(24, 12)]);
    const world = freshWorld(layers);
    const ball = createBallAt({ x: 600, y: 187.5 });
    launch(ball, 400, 0);
    const ctx = makeContext(layers, ball);
    const events: SimEvent[] = [];
    let before = ball.vx;
    let checked = false;
    let minGap = Infinity;
    runTicks(layers, world, ball, ctx, events, () => {
      minGap = Math.min(minGap, FIELD_W - TILE - ball.x);
      if (!checked && ball.vx < 0) {
        const afterFriction = before - FRICTION_GRASS * DT;
        expect(-ball.vx).toBeCloseTo(RESTITUTION_WALL * afterFriction, 9);
        checked = true;
      }
      before = ball.vx;
    });
    expect(checked).toBe(true);
    expect(minGap).toBeGreaterThanOrEqual(R);
    expect(events.filter((e) => e.type === 'bounce')).toHaveLength(1);
  });
});

describe('corners and corridors', () => {
  it('a convex corner reflects along the corner normal', () => {
    const rows = blankRows('.');
    paint(rows, 20, 12, '#'); // tile origin (300, 180): NE corner at (315, 180)
    const layers = buildLayers(blankRows('.'), rows, [start(3, 3)]);
    const world = freshWorld(layers);
    const ball = createBallAt({ x: 315 + 4, y: 180 - 4 });
    launch(ball, -100, 100);
    const events: SimEvent[] = [];
    resolveCollisions(layers, world, ball, makeContext(layers, ball), events);
    const vn = -100 * S + 100 * -S; // v . n with n = (s, -s)
    expect(ball.vx).toBeCloseTo(-100 - (1 + RESTITUTION_WALL) * vn * S, 9);
    expect(ball.vy).toBeCloseTo(100 - (1 + RESTITUTION_WALL) * vn * -S, 9);
    const dist = Math.sqrt((ball.x - 315) ** 2 + (ball.y - 180) ** 2);
    expect(dist).toBeCloseTo(R + PENETRATION_SLOP, 9);
    expect(events[0]).toMatchObject({ type: 'bounce', material: 'wall', tile: tileIndex(20, 12) });
    expect((events[0] as { nx: number }).nx).toBeCloseTo(S, 12);
    expect((events[0] as { ny: number }).ny).toBeCloseTo(-S, 12);
  });

  it('a 15 px corridor does not trap the ball', () => {
    const rows = blankRows('#');
    paintRow(rows, 12, 1, 47, '.');
    const layers = buildLayers(blankRows('.'), rows, [start(3, 12)]);
    const world = freshWorld(layers);
    const ball = createBallAt({ x: 52.5, y: 187.5 });
    launch(ball, 450, 160);
    const ctx = makeContext(layers, ball);
    const events: SimEvent[] = [];
    const status = runTicks(layers, world, ball, ctx, events, () => {
      expect(ball.y).toBeGreaterThanOrEqual(180 + R - 1e-9);
      expect(ball.y).toBeLessThanOrEqual(195 - R + 1e-9);
      expect(Number.isFinite(ball.x) && Number.isFinite(ball.y)).toBe(true);
    });
    expect(status).toBe('stopped');
    expect(ball.x).toBeGreaterThan(400);
    expect(events.filter((e) => e.type === 'bounce').length).toBeGreaterThan(5);
  });

  it('grazing a 10-tile wall keeps the tangential velocity (no seam snag)', () => {
    const rows = borderRows();
    paintRow(rows, 10, 10, 19, '#'); // wall top face at y = 150, from x = 150 to 300
    const layers = buildLayers(blankRows('.'), rows, [start(3, 3)]);
    const world = freshWorld(layers);
    const ball = createBallAt({ x: 170, y: 150 - R - 0.1 }); // already above the wall, drifting onto its top face
    launch(ball, 400, 3);
    const ctx = makeContext(layers, ball);
    const events: SimEvent[] = [];
    let prevVx = ball.vx;
    let prevVy = ball.vy;
    let touches = 0;
    runTicks(layers, world, ball, ctx, events, () => {
      if (ball.x < 290) { // over the wall, clear of both ends
        const drop = prevVx - ball.vx;
        expect(drop).toBeGreaterThanOrEqual(-1e-9);
        expect(drop).toBeLessThanOrEqual(FRICTION_GRASS * DT + 1e-9); // only friction may slow the tangential motion
        expect(ball.y).toBeLessThanOrEqual(150 - R + 1e-9);
        if (prevVy > 0 && ball.vy < 0) touches++; // the drift into the face was reflected
      }
      prevVx = ball.vx;
      prevVy = ball.vy;
    });
    expect(touches).toBeGreaterThanOrEqual(1);
    // the 3 px/s drift is below BOUNCE_EVENT_MIN_SPEED, so the seams produce no events at all; any event over the
    // wall would have to be a flush face normal
    const bounces = events.filter((e) => e.type === 'bounce' && e.x < 290) as Extract<SimEvent, { type: 'bounce' }>[];
    for (const b of bounces) {
      expect(b.nx).toBe(0);
      expect(b.ny).toBe(-1);
    }
    expect(ball.x).toBeGreaterThan(330);
  });

  it('inner corner torture: 50 angles, no residual penetration, no trap, no speed gain', () => {
    const rows = blankRows('.');
    paintRow(rows, 5, 10, 20, '#'); // north wall, south face at y = 90, x in [150, 315]
    paintCol(rows, 20, 5, 15, '#'); // east wall, west face at x = 300, y in [75, 240]
    const layers = buildLayers(blankRows('.'), rows, [start(3, 3)]);
    for (let i = 0; i < 50; i++) {
      const angle = (-Math.PI / 2) * ((i + 0.5) / 50); // from due east (0) to due north (-pi/2)
      const speed = 320;
      const world = freshWorld(layers);
      const ball = createBallAt({ x: 240, y: 150 });
      launch(ball, Math.cos(angle) * speed, Math.sin(angle) * speed);
      const ctx = makeContext(layers, ball);
      const events: SimEvent[] = [];
      let maxSpeed = 0;
      const status = runTicks(layers, world, ball, ctx, events, () => {
        if (ball.x >= 150 && ball.x <= 315) expect(ball.y).toBeGreaterThanOrEqual(90 + R - 0.05);
        if (ball.y >= 75 && ball.y <= 240) expect(ball.x).toBeLessThanOrEqual(300 - R + 0.05);
        maxSpeed = Math.max(maxSpeed, Math.sqrt(ball.vx * ball.vx + ball.vy * ball.vy));
      });
      expect(status).toBe('stopped');
      expect(maxSpeed).toBeLessThanOrEqual(speed + 1e-9);
      const bounces = events.filter((e) => e.type === 'bounce') as Extract<SimEvent, { type: 'bounce' }>[];
      expect(bounces.length).toBeLessThanOrEqual(2);
      for (const b of bounces) expect(b.nx * b.ny === 0).toBe(true); // only face normals, never a diagonal corner normal
      // the ball left the pocket instead of retracing into it
      expect(Math.hypot(ball.x - (300 - R), ball.y - (90 + R))).toBeGreaterThan(20);
    }
  });
});
