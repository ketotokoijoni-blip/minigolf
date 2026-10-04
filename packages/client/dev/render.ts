// Standalone render harness (DESIGN §15 WP-D), served by Vite at /dev/render.html. Builds a showcase course
// (every surface, wall shape and object) by hand, animates a scripted ShotIterator stub with toy physics and
// lets you aim with the mouse / keyboard. Imports only WP0 contract modules and WP-D modules — never WP-A/WP-B.
import {
  BALL_RADIUS, COURSE_H, COURSE_W, FIELD_H, FIELD_W, MAX_SHOT_TICKS, POWER_SCALE, SHOT_QUANTUM, TICK_HZ, TILE, TILE_COUNT,
} from '@puttipeli/shared/constants';
import { surfaceFromChar, wallFromChar, isBreakable, breakableHits } from '@puttipeli/shared/course/chars';
import { tileCentre, tileIndex, tileOf } from '@puttipeli/shared/course/grid';
import { Surface, WallShape, type CourseLayers, type CourseObject, type HoleDef, type MagnetDef, type MineDef, type TeleportPad, type Vec2 } from '@puttipeli/shared/course/types';
import type { BallState, ShotInput, ShotIterator, ShotResult, SimContext, SimEvent, StepStatus, WorldState } from '@puttipeli/shared/sim/types';
import { createBallAt, createWorld } from '@puttipeli/shared/sim/worldState';
import { createSfx } from '../src/audio/sfx';
import { startLoop } from '../src/game/loop';
import { createAimInput } from '../src/game/input';
import { ShotAnimator } from '../src/game/shotAnimator';
import { Renderer, drawCourseThumbnail, type BallSprite } from '../src/render/renderer';

// ---------------------------------------------------------------------------------------------------------------
// Showcase course (hand-built; the real decoder is WP-A's and must not be imported here)
// ---------------------------------------------------------------------------------------------------------------

const SURFACE_ROWS = [
  '.................................................',
  '.................................................',
  '...ssss...iiii...tt......wwww......aaa...........',
  '...ssss...iiii...tt......wwww......aaa...........',
  '...ssss...iiii...........wwww......aaa...........',
  '.................................................',
  '...888...666...222...444.........................',
  '...888...666...222...444.........................',
  '...888...666...222...444.........................',
  '.................................................',
  '.................................................',
  '.................................................',
  '.................................................',
  '.................................................',
  '.....................iiiiiiiiiii.................',
  '.....................iiiiiiiiiii.................',
  '.................................................',
  '.................................................',
  '.................................................',
  '..........sssssss................................',
  '..........sssssss..............wwwwwwwww.........',
  '..........sssssss..............wwwwwwwww.........',
  '.................................................',
  '.................................................',
  '.................................................',
];
const WALL_ROWS = [
  '.................................................',
  '.................................................',
  '.................................................',
  '.................................................',
  '.................................................',
  '.................................................',
  '.................................................',
  '.................................................',
  '.................................................',
  '.................................................',
  '.....#.7.9.x.y.z.M.O.^.>.v.<.....................',
  '.......1.3.......................................',
  '.................................................',
  '..........................................#......',
  '............7######9...................#.........',
  '............#......#.....................#.......',
  '............1######3.....................#.......',
  '...............................x.y.z.............',
  '.........................................#.......',
  '........................#.........#..............',
  '........................#.........#..............',
  '........................#.........#..............',
  '.................................................',
  '.................................................',
  '.................................................',
];
const OBJECTS: CourseObject[] = [
  { type: 'start', x: 3, y: 12 },
  { type: 'hole', x: 44, y: 12 },
  { type: 'hole', x: 40, y: 3 },
  { type: 'teleport', x: 30, y: 6, group: 0 },
  { type: 'teleport', x: 44, y: 20, group: 0 },
  { type: 'teleport', x: 33, y: 6, group: 1 },
  { type: 'teleport', x: 6, y: 22, group: 1 },
  { type: 'teleport', x: 36, y: 6, group: 2 },
  { type: 'teleport', x: 36, y: 10, group: 2 },
  { type: 'teleport', x: 39, y: 6, group: 3 },
  { type: 'teleport', x: 39, y: 10, group: 3 },
  { type: 'teleport', x: 42, y: 6, group: 4 },
  { type: 'teleport', x: 42, y: 10, group: 4 },
  { type: 'teleport', x: 45, y: 6, group: 5 },
  { type: 'teleport', x: 45, y: 10, group: 5 },
  { type: 'teleport', x: 30, y: 10, group: 6 },
  { type: 'teleport', x: 33, y: 10, group: 6 },
  { type: 'teleport', x: 24, y: 6, group: 7 },
  { type: 'teleport', x: 24, y: 8, group: 7 },
  { type: 'magnet', x: 42, y: 13, polarity: 1, strength: 350, radius: 90 },
  { type: 'magnet', x: 39, y: 14, polarity: -1, strength: 350, radius: 60 },
  { type: 'mine', x: 20, y: 12 },
  { type: 'mine', x: 25, y: 17 },
];

function buildLayers(surfaceRows: string[], wallRows: string[], objects: CourseObject[]): CourseLayers {
  const surface = new Uint8Array(TILE_COUNT);
  const walls = new Uint8Array(TILE_COUNT);
  for (let y = 0; y < COURSE_H; y++) {
    for (let x = 0; x < COURSE_W; x++) {
      surface[tileIndex(x, y)] = surfaceFromChar(surfaceRows[y]?.charAt(x) ?? '.') ?? Surface.Grass;
      walls[tileIndex(x, y)] = wallFromChar(wallRows[y]?.charAt(x) ?? '.') ?? WallShape.None;
    }
  }
  const objectAt = new Int16Array(TILE_COUNT).fill(-1);
  const holes: HoleDef[] = [];
  const mines: MineDef[] = [];
  const magnets: MagnetDef[] = [];
  const pads: TeleportPad[] = [];
  let start: Vec2 = { x: TILE * 1.5, y: TILE * 1.5 };
  let startTile = tileIndex(1, 1);
  objects.forEach((o, i) => {
    const tile = tileIndex(o.x, o.y);
    objectAt[tile] = i;
    const c = tileCentre(tile);
    switch (o.type) {
      case 'start': start = c; startTile = tile; break;
      case 'hole': holes.push({ tile, cx: c.x, cy: c.y }); break;
      case 'mine': mines.push({ tile, cx: c.x, cy: c.y }); break;
      case 'magnet': walls[tile] = WallShape.Full; magnets.push({ tile, cx: c.x, cy: c.y, polarity: o.polarity, strength: o.strength, radius: o.radius }); break;
      case 'teleport': pads.push({ tile, cx: c.x, cy: c.y, group: o.group, partnerTile: -1, partnerIndex: -1 }); break;
    }
  });
  pads.forEach((p, i) => {
    const j = pads.findIndex((q, k) => k !== i && q.group === p.group);
    p.partnerIndex = j;
    p.partnerTile = j >= 0 ? pads[j]!.tile : -1;
  });
  return { surface, walls, objectAt, objects, start, startTile, holes, teleports: pads, magnets, mines, maxStrokes: 20, par: 3 };
}

// ---------------------------------------------------------------------------------------------------------------
// Scripted ShotIterator stub with toy physics (NOT the real sim; just enough to exercise every event type)
// ---------------------------------------------------------------------------------------------------------------

class StubIterator implements ShotIterator {
  readonly ball: BallState;
  readonly world: WorldState;
  readonly events: SimEvent[] = [];
  readonly ctx: SimContext;
  done = false;
  result: ShotResult | null = null;
  penalty: 0 | 1 = 0;
  holeIndex = -1;
  private teleportCooldown = -1;
  private lastBreak = -1;

  constructor(private readonly layers: CourseLayers, world: WorldState, ball: BallState, shot: ShotInput) {
    this.ball = { ...ball, vx: (shot.dx / SHOT_QUANTUM) * POWER_SCALE, vy: (shot.dy / SHOT_QUANTUM) * POWER_SCALE, moving: true };
    this.world = world; // live: the harness shares the world between shots
    this.ctx = { shotOrigin: { x: ball.x, y: ball.y }, startPos: layers.start, tick: 0, teleportCount: 0, lastBreakTile: -1, lastBreakTick: -1, otherBalls: [] };
  }

  private end(result: ShotResult, ev: SimEvent): StepStatus {
    this.events.push(ev);
    this.done = true;
    this.result = result;
    this.ball.moving = false;
    this.ball.vx = 0;
    this.ball.vy = 0;
    return result;
  }

  private reset(p: Vec2): void {
    this.ball.x = p.x;
    this.ball.y = p.y;
    this.teleportCooldown = -1;
  }

  step(): StepStatus {
    if (this.done) return this.result ?? 'stopped';
    const b = this.ball;
    const dt = 1 / TICK_HZ;
    const tick = this.ctx.tick;
    // friction by surface
    const surf = this.layers.surface[tileOf(b.x, b.y)] ?? 0;
    const fr = surf === Surface.Sand ? 1100 : surf === Surface.Ice ? 30 : 200;
    const speed = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    const dec = fr * dt;
    if (speed <= dec) return this.end('stopped', { tick, type: 'stopped' });
    const k = (speed - dec) / speed;
    b.vx *= k;
    b.vy *= k;
    // move in 3 substeps with axis-aligned tile collision
    for (let s = 0; s < 3; s++) {
      const nx = b.x + (b.vx * dt) / 3;
      const ny = b.y + (b.vy * dt) / 3;
      const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
      // borders
      if (nx < BALL_RADIUS || nx > FIELD_W - BALL_RADIUS) {
        b.vx = -b.vx * 0.78;
        this.events.push({ tick, type: 'bounce', x: nx < BALL_RADIUS ? 0 : FIELD_W, y: ny, nx: nx < BALL_RADIUS ? 1 : -1, ny: 0, speed: sp, tile: -1, material: 'border' });
        continue;
      }
      if (ny < BALL_RADIUS || ny > FIELD_H - BALL_RADIUS) {
        b.vy = -b.vy * 0.78;
        this.events.push({ tick, type: 'bounce', x: nx, y: ny < BALL_RADIUS ? 0 : FIELD_H, nx: 0, ny: ny < BALL_RADIUS ? 1 : -1, speed: sp, tile: -1, material: 'border' });
        continue;
      }
      // wall tiles (treated as full squares)
      const hitX = this.wallAt(nx + Math.sign(b.vx) * BALL_RADIUS, b.y);
      const hitY = this.wallAt(b.x, ny + Math.sign(b.vy) * BALL_RADIUS);
      if (hitX >= 0 || hitY >= 0) {
        const tile = hitX >= 0 ? hitX : hitY;
        const code = this.world.walls[tile] ?? 0;
        let material: Extract<SimEvent, { type: 'bounce' }>['material'] = 'wall';
        let rest = 0.78;
        if (isBreakable(code)) { material = 'breakable'; rest = 0.65; }
        else if (code === WallShape.Movable) { material = 'movable'; rest = 0.35; }
        else if (code === WallShape.Bumper) { material = 'bumper'; rest = 1.4; }
        else if (code >= WallShape.OneWayN) material = 'oneway';
        if (hitX >= 0) b.vx = -b.vx * rest; else b.vy = -b.vy * rest;
        if (material === 'bumper') {
          const s2 = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
          if (s2 < 220) { b.vx *= 220 / s2; b.vy *= 220 / s2; }
        }
        const c = tileCentre(tile);
        this.events.push({ tick, type: 'bounce', x: hitX >= 0 ? nx : b.x, y: hitX >= 0 ? b.y : ny, nx: hitX >= 0 ? -Math.sign(b.vx) : 0, ny: hitX >= 0 ? 0 : -Math.sign(b.vy), speed: sp, tile, material });
        if (material === 'breakable' && sp > 120 && this.lastBreak !== tile) {
          this.lastBreak = tile;
          const hits = (this.world.breakHits[tile] ?? 0) + 1;
          const left = breakableHits(code) - hits;
          if (left <= 0) {
            this.world.walls[tile] = WallShape.None;
            this.world.breakHits[tile] = 0;
            this.events.push({ tick, type: 'destroyed', tile });
          } else {
            this.world.breakHits[tile] = hits;
            this.events.push({ tick, type: 'break', tile, hitsLeft: left });
          }
        } else if (material === 'movable') {
          const dx = hitX >= 0 ? -Math.sign(b.vx) : 0;
          const dy = hitX >= 0 ? 0 : -Math.sign(b.vy);
          const tx = (tile % COURSE_W) + dx;
          const ty = Math.floor(tile / COURSE_W) + dy;
          if (tx >= 0 && ty >= 0 && tx < COURSE_W && ty < COURSE_H) {
            const to = tileIndex(tx, ty);
            if ((this.world.walls[to] ?? 0) === WallShape.None && this.layers.objectAt[to] === -1) {
              this.world.walls[to] = WallShape.Movable;
              this.world.walls[tile] = WallShape.None;
              this.events.push({ tick, type: 'blockMoved', from: tile, to });
            }
          }
        }
        void c;
        continue;
      }
      b.x = nx;
      b.y = ny;
    }
    // object checks at the centre
    const tile = tileOf(b.x, b.y);
    if (this.teleportCooldown !== -1 && tile !== this.teleportCooldown) this.teleportCooldown = -1;
    const surf2 = this.layers.surface[tile] ?? 0;
    if (surf2 === Surface.Tar) return this.end('stopped', { tick, type: 'tar', tile });
    if (surf2 === Surface.Water) { this.penalty = 1; const r = this.end('water', { tick, type: 'water', tile }); this.reset(this.ctx.shotOrigin); return r; }
    if (surf2 === Surface.Acid) { this.penalty = 1; const r = this.end('acid', { tick, type: 'acid', tile }); this.reset(this.ctx.startPos); return r; }
    for (let i = 0; i < this.layers.mines.length; i++) {
      const m = this.layers.mines[i]!;
      if ((this.world.minesArmed[i] ?? 0) && Math.hypot(m.cx - b.x, m.cy - b.y) < 7) {
        this.world.minesArmed[i] = 0;
        this.penalty = 1;
        const r = this.end('mine', { tick, type: 'mine', index: i });
        this.reset(this.ctx.shotOrigin);
        return r;
      }
    }
    for (const p of this.layers.teleports) {
      if (p.partnerIndex >= 0 && p.tile !== this.teleportCooldown && Math.hypot(p.cx - b.x, p.cy - b.y) < 5) {
        const q = this.layers.teleports[p.partnerIndex]!;
        const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy) || 1;
        b.x = q.cx + (b.vx / sp) * 2;
        b.y = q.cy + (b.vy / sp) * 2;
        this.teleportCooldown = q.tile;
        this.ctx.teleportCount++;
        this.events.push({ tick, type: 'teleport', from: p.tile, to: q.tile });
        break;
      }
    }
    const sp = Math.sqrt(b.vx * b.vx + b.vy * b.vy);
    for (let hi = 0; hi < this.layers.holes.length; hi++) {
      const h = this.layers.holes[hi]!;
      const d = Math.hypot(h.cx - b.x, h.cy - b.y);
      if (d < 10 && sp < 400) { // funnel pull
        b.vx += ((h.cx - b.x) / d) * 500 * dt;
        b.vy += ((h.cy - b.y) / d) * 500 * dt;
      }
      if (d <= 5.5 && sp <= 220) {
        b.x = h.cx;
        b.y = h.cy;
        this.holeIndex = hi;
        return this.end('holed', { tick, type: 'holed', hole: hi });
      }
    }
    this.ctx.tick++;
    if (this.ctx.tick >= MAX_SHOT_TICKS) return this.end('timeout', { tick, type: 'timeout' });
    return 'moving';
  }

  private wallAt(px: number, py: number): number {
    if (px < 0 || py < 0 || px >= FIELD_W || py >= FIELD_H) return -1;
    const t = tileOf(px, py);
    return (this.world.walls[t] ?? 0) !== WallShape.None ? t : -1;
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Harness wiring
// ---------------------------------------------------------------------------------------------------------------

const $ = <T extends HTMLElement>(id: string): T => document.getElementById(id) as T;
const stage = $<HTMLDivElement>('stage');
const status = $<HTMLSpanElement>('status');
const logEl = $<HTMLDivElement>('log');
const log = (s: string): void => {
  logEl.textContent = `${s}\n${logEl.textContent ?? ''}`.split('\n').slice(0, 6).join('\n');
};

const layers = buildLayers(SURFACE_ROWS, WALL_ROWS, OBJECTS);
let world = createWorld(layers.walls, layers.mines.length);
const renderer = new Renderer(stage);
const sfx = createSfx();
const animator = new ShotAnimator(renderer, sfx);
renderer.setCourse(layers, world);

let myBall = createBallAt(layers.start);
const others: BallSprite[] = [
  { id: 'p2', ball: createBallAt({ x: layers.start.x + 30, y: layers.start.y - 45 }), colour: 1, alpha: 0.6, highlight: false },
  { id: 'p3', ball: createBallAt({ x: layers.start.x + 300, y: layers.start.y + 120 }), colour: 2, alpha: 0.6, highlight: false },
];
const refreshBalls = (): void => {
  renderer.setBalls([...others, { id: 'me', ball: myBall, colour: 0, alpha: 1, highlight: !animator.running }]);
};
refreshBalls();

const input = createAimInput(renderer.canvas, renderer.camera, { touchFireButton: false });
input.setTargets(layers.holes.map((h) => ({ x: h.cx, y: h.cy })));
input.setBall(myBall);
input.setEnabled(true);

function shoot(shot: ShotInput): void {
  if (animator.running) animator.fastForward();
  input.setEnabled(false);
  renderer.setAim(null);
  const it = new StubIterator(layers, world, myBall, shot);
  log(`Lyönti dx=${shot.dx} dy=${shot.dy}`);
  animator.play(it, { id: 'me', ball: myBall, colour: 0, alpha: 1, highlight: false }, (done) => {
    myBall = { ...done.ball };
    world = done.world;
    renderer.setWorld(world);
    log(`Tulos: ${done.result} · ${done.ctx.tick} tickiä · ${done.events.length} tapahtumaa${done.penalty ? ' · +1' : ''}`);
    if (done.result === 'holed') {
      sfx.play('applause');
      setTimeout(() => { myBall = createBallAt(layers.start); input.setBall(myBall); refreshBalls(); }, 1200);
    }
    input.setBall(myBall);
    input.setEnabled(true);
    refreshBalls();
    runNextDemo();
  });
  refreshBalls();
}
input.onShoot(shoot);
input.onCancel(() => log('Tähtäys peruttu'));

// Scripted demo shots from the start tile: breakable bricks, the mine, water, a teleport, the cup.
const DEMO: ShotInput[] = [
  { dx: 11000, dy: -3200 },  // up-right across the field: border bounces
  { dx: 12000, dy: 2000 },   // towards the brick row on the right (breakables)
  { dx: 9000, dy: 0 },       // straight at the mine at (20,12)
  { dx: 7000, dy: 5600 },    // down-right into the water pool
  { dx: 12000, dy: -2600 },  // long shot through the teleport field
  { dx: 6000, dy: 0 },       // gentle roll to the right
];
let demoQueue: ShotInput[] = [];
function runNextDemo(): void {
  const next = demoQueue.shift();
  if (!next) return;
  setTimeout(() => shoot(next), 600);
}

const startDemo = (): void => { demoQueue = [...DEMO]; if (!animator.running) runNextDemo(); };
$('btnDemo').addEventListener('click', startDemo);
// /dev/render.html?demo starts the scripted shots at once (QA / headless screenshots).
if (new URLSearchParams(location.search).has('demo')) setTimeout(startDemo, 100);
$('btnShot').addEventListener('click', () => {
  const a = Math.random() * Math.PI * 2;
  const p = 4000 + Math.random() * 8000;
  shoot({ dx: Math.round(Math.cos(a) * p), dy: Math.round(Math.sin(a) * p) });
});
$('btnFast').addEventListener('click', () => animator.fastForward());
$('btnReset').addEventListener('click', () => {
  demoQueue = [];
  if (animator.running) animator.fastForward();
  world = createWorld(layers.walls, layers.mines.length);
  renderer.setCourse(layers, world);
  myBall = createBallAt(layers.start);
  input.setBall(myBall);
  refreshBalls();
  log('Rata nollattu');
});
$<HTMLInputElement>('chkEditor').addEventListener('change', (e) => {
  editor = (e.target as HTMLInputElement).checked;
});
$<HTMLInputElement>('chkFx').addEventListener('change', (e) => {
  renderer.effects.enabled = (e.target as HTMLInputElement).checked;
});
$<HTMLInputElement>('chkSound').addEventListener('change', (e) => {
  const on = (e.target as HTMLInputElement).checked;
  if (on) sfx.unlock();
  sfx.setVolume(on ? 0.7 : 0);
});
$<HTMLSelectElement>('selSize').addEventListener('change', (e) => {
  stage.className = (e.target as HTMLSelectElement).value === 'fit' ? '' : (e.target as HTMLSelectElement).value;
  renderer.camera.fit();
});
window.addEventListener('pointerdown', () => { if ($<HTMLInputElement>('chkSound').checked) sfx.unlock(); }, { once: true });

let editor = false;
let hoverTile = -1;
renderer.canvas.addEventListener('pointermove', (e) => {
  const w = renderer.camera.toWorld(e.clientX, e.clientY);
  hoverTile = w.x >= 0 && w.y >= 0 && w.x < FIELD_W && w.y < FIELD_H ? tileOf(w.x, w.y) : -1;
});
window.addEventListener('keydown', (e) => { if (e.key === 'g' || e.key === 'G') { editor = !editor; $<HTMLInputElement>('chkEditor').checked = editor; } });

// Thumbnails at two scales.
drawCourseThumbnail($<HTMLCanvasElement>('thumb1'), layers, world, 0.25);
drawCourseThumbnail($<HTMLCanvasElement>('thumb2'), layers, null, 0.4);

let frames = 0;
let fpsAt = 0;
let fps = 0;
startLoop((now) => {
  animator.update(now);
  renderer.setAim(animator.running ? null : input.getAim());
  renderer.setEditorOverlay(editor ? {
    grid: true, hoverTile,
    preview: hoverTile >= 0 ? { layer: 'walls', value: WallShape.Bumper } : undefined,
    magnetRadii: true, teleportLinks: true, highlightTiles: [layers.startTile],
  } : null);
  renderer.render(now);
  frames++;
  if (now - fpsAt > 500) {
    fps = Math.round((frames * 1000) / (now - fpsAt));
    frames = 0;
    fpsAt = now;
    const aim = input.getAim();
    const c = renderer.camera;
    status.textContent = `${fps} fps · skaala ${c.scale.toFixed(2)} · dpr ${c.dpr} · ${animator.running ? 'pallo liikkuu' : aim ? `teho ${(aim.power * 100).toFixed(0)} %` : 'tähtää hiirellä tai nuolinäppäimillä'}`;
  }
});
