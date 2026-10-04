// Renderer (DESIGN §12.2): a static layer (hidden canvas: surfaces, walls, objects; redrawn only when marked dirty)
// blitted once per frame under a dynamic layer (balls, aim line, particles, editor overlay). All text is DOM (HUD).
//
// Logical canvas 765x405; the field's top-left corner is at logical (15, 15): world px = logical px - 15.
import { COURSE_H, COURSE_W, FIELD_H, FIELD_W, TILE } from '@puttipeli/shared/constants';
import { isFullBlock } from '@puttipeli/shared/course/chars';
import { Surface, WallShape, type CourseLayers, type CourseObject, type Vec2 } from '@puttipeli/shared/course/types';
import { tileCentre, tileIndex, tileX, tileY } from '@puttipeli/shared/course/grid';
import type { BallState, WorldState } from '@puttipeli/shared/sim/types';
import type { PlayerColour } from '@puttipeli/shared/game/types';
import { Camera, FRAME_PX, LOGICAL_H, LOGICAL_W } from '../game/camera';
import { drawBall } from './ballArt';
import { drawAimLine, type AimSprite } from './aimLine';
import { Effects } from './effects';
import { EDITOR_PALETTE, teleportColour } from './palette';
import { drawBorderFrame, drawObject, drawSurface, drawWall, type ArtContext } from './tileArt';

export type { AimSprite } from './aimLine';

export interface BallSprite { id: string; ball: BallState; colour: PlayerColour; alpha: number; highlight: boolean }
export interface EditorOverlay {
  grid: boolean;
  hoverTile: number | -1;
  preview?: { layer: 'surface' | 'walls' | 'object'; value: number | CourseObject };
  magnetRadii: boolean;
  teleportLinks: boolean;
  highlightTiles: number[];
}

export interface FieldArtOptions {
  /** false = flat colours only (tiny thumbnails). */
  detail?: boolean;
  /** Draw the faint magnet radius circles (editor). */
  magnetRadii?: boolean;
}

/** Index into world.minesArmed for the mine object at position `objIndex` of layers.objects (course order). */
function mineIndexOf(layers: CourseLayers, objIndex: number): number {
  let n = 0;
  for (let i = 0; i < objIndex; i++) if (layers.objects[i]?.type === 'mine') n++;
  return n;
}

/**
 * Draws the whole field (surfaces, then walls, then objects) with its top-left corner at (0, 0) of the current
 * transform. `world` supplies the current walls / crack levels / mine states; null draws the course as authored.
 */
export function drawField(ctx: ArtContext, layers: CourseLayers, world: WorldState | null, opts: FieldArtOptions = {}): void {
  const detail = opts.detail !== false;
  const walls = world ? world.walls : layers.walls;
  for (let y = 0; y < COURSE_H; y++) {
    for (let x = 0; x < COURSE_W; x++) {
      const i = tileIndex(x, y);
      drawSurface(ctx, layers.surface[i] ?? Surface.Grass, x * TILE, y * TILE, i, detail);
    }
  }
  for (let y = 0; y < COURSE_H; y++) {
    for (let x = 0; x < COURSE_W; x++) {
      const i = tileIndex(x, y);
      const w = walls[i] ?? WallShape.None;
      if (w !== WallShape.None) drawWall(ctx, w, x * TILE, y * TILE, world ? (world.breakHits[i] ?? 0) : 0, detail);
    }
  }
  for (let k = 0; k < layers.objects.length; k++) {
    const o = layers.objects[k]!;
    const i = tileIndex(o.x, o.y);
    // A magnet needs its block; if the block is gone (editor mid-edit) draw a plain one so the face has a backing.
    if (o.type === 'magnet' && !isFullBlock(walls[i] ?? 0)) drawWall(ctx, WallShape.Full, o.x * TILE, o.y * TILE, 0, detail);
    const armed = o.type === 'mine' && world ? (world.minesArmed[mineIndexOf(layers, k)] ?? 1) !== 0 : true;
    drawObject(ctx, o, o.x * TILE, o.y * TILE, { armed, magnetRadius: opts.magnetRadii === true, detail });
  }
}

/** Draws surfaces + walls + objects of a course into any canvas at the given scale (thumbnails in #/play, lobby, library). */
export function drawCourseThumbnail(canvas: HTMLCanvasElement, layers: CourseLayers, world: WorldState | null, scale: number): void {
  const s = scale > 0 && Number.isFinite(scale) ? scale : 0.25;
  const w = Math.max(1, Math.round(FIELD_W * s));
  const h = Math.max(1, Math.round(FIELD_H * s));
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  const ctx = canvas.getContext('2d');
  if (!ctx) return;
  ctx.setTransform(w / FIELD_W, 0, 0, h / FIELD_H, 0, 0);
  ctx.clearRect(0, 0, FIELD_W, FIELD_H);
  drawField(ctx, layers, world, { detail: s >= 0.5 });
}

function worldsEqual(a: WorldState, b: WorldState): boolean {
  if (a.walls.length !== b.walls.length || a.breakHits.length !== b.breakHits.length || a.minesArmed.length !== b.minesArmed.length) return false;
  for (let i = 0; i < a.walls.length; i++) if (a.walls[i] !== b.walls[i] || a.breakHits[i] !== b.breakHits[i]) return false;
  for (let i = 0; i < a.minesArmed.length; i++) if (a.minesArmed[i] !== b.minesArmed[i]) return false;
  return true;
}

function snapshotWorld(w: WorldState): WorldState {
  return { walls: w.walls.slice(), breakHits: w.breakHits.slice(), minesArmed: w.minesArmed.slice() };
}

export class Renderer {
  readonly camera: Camera;
  readonly effects = new Effects();
  /** The top (dynamic) canvas: attach pointer listeners here (createAimInput). */
  readonly canvas: HTMLCanvasElement;
  readonly editorMode: boolean;

  private readonly stage: HTMLElement;
  private readonly staticCanvas: HTMLCanvasElement;
  private readonly staticCtx: CanvasRenderingContext2D;
  private readonly dynCtx: CanvasRenderingContext2D;
  private layers: CourseLayers | null = null;
  private world: WorldState | null = null;
  private worldSnapshot: WorldState | null = null;
  private staticDirty = true;
  private balls: readonly BallSprite[] = [];
  private animated: BallSprite | null = null;
  private aim: AimSprite | null = null;
  private overlay: EditorOverlay | null = null;
  private lastNow = -1;
  private readonly unsubscribeCamera: () => void;
  private destroyed = false;

  constructor(private readonly container: HTMLElement, opts: { editorMode?: boolean } = {}) {
    this.editorMode = opts.editorMode === true;
    const doc = container.ownerDocument;
    this.stage = doc.createElement('div');
    this.stage.className = 'pp-stage';
    this.stage.style.position = 'relative';
    this.stage.style.margin = '0 auto';
    this.stage.style.touchAction = 'none';
    this.stage.style.userSelect = 'none';
    this.canvas = doc.createElement('canvas');
    this.canvas.className = 'pp-canvas';
    this.canvas.style.position = 'absolute';
    this.canvas.style.left = '0';
    this.canvas.style.top = '0';
    this.canvas.style.display = 'block';
    this.canvas.style.touchAction = 'none';
    this.canvas.style.cursor = this.editorMode ? 'cell' : 'crosshair';
    this.staticCanvas = doc.createElement('canvas'); // hidden: never appended
    this.stage.appendChild(this.canvas);
    container.appendChild(this.stage);
    const sctx = this.staticCanvas.getContext('2d');
    const dctx = this.canvas.getContext('2d');
    if (!sctx || !dctx) throw new Error('Renderer: Canvas 2D context unavailable');
    this.staticCtx = sctx;
    this.dynCtx = dctx;
    this.camera = new Camera(container, this.stage, [this.canvas, this.staticCanvas]);
    this.unsubscribeCamera = this.camera.onChange(() => { this.staticDirty = true; });
  }

  /** Full static redraw on the next frame. */
  setCourse(layers: CourseLayers, world: WorldState): void {
    this.layers = layers;
    this.world = world;
    this.worldSnapshot = snapshotWorld(world);
    this.staticDirty = true;
    this.effects.clear();
  }

  /** Marks the static layer dirty when the world differs from the last one drawn. The reference may be live. */
  setWorld(world: WorldState): void {
    if (this.worldSnapshot && worldsEqual(this.worldSnapshot, world)) {
      this.world = world;
      return;
    }
    this.world = world;
    this.worldSnapshot = snapshotWorld(world);
    this.staticDirty = true;
  }

  markStaticDirty(): void { this.staticDirty = true; }
  setBalls(balls: readonly BallSprite[]): void { this.balls = balls; }
  /** The ball currently animated by ShotAnimator (drawn last; a sprite with the same id in setBalls is skipped). */
  setAnimatedBall(sprite: BallSprite | null): void { this.animated = sprite; }
  setAim(aim: AimSprite | null): void { this.aim = aim; }
  setEditorOverlay(o: EditorOverlay | null): void { this.overlay = o; }

  /** One frame; called by loop.ts. */
  render(nowMs: number): void {
    if (this.destroyed) return;
    const dt = this.lastNow < 0 ? 16 : nowMs - this.lastNow;
    this.lastNow = nowMs;
    // The world may be mutated in place by the animator: re-check cheaply every frame when a world is set.
    if (!this.staticDirty && this.world && this.worldSnapshot && !worldsEqual(this.worldSnapshot, this.world)) {
      this.worldSnapshot = snapshotWorld(this.world);
      this.staticDirty = true;
    }
    if (this.staticDirty) this.redrawStatic();

    const ctx = this.dynCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.staticCanvas, 0, 0);
    this.camera.applyTransform(ctx);
    ctx.save();
    ctx.translate(FRAME_PX, FRAME_PX);
    ctx.beginPath();
    ctx.rect(0, 0, FIELD_W, FIELD_H);
    ctx.clip();

    if (this.overlay && this.layers) this.drawOverlay(ctx, this.overlay, this.layers);

    const anim = this.animated;
    for (const s of this.balls) {
      if (anim && s.id === anim.id) continue;
      drawBall(ctx, s.ball.x, s.ball.y, s.colour, s.alpha, s.highlight, nowMs);
    }
    if (anim) drawBall(ctx, anim.ball.x, anim.ball.y, anim.colour, anim.alpha, anim.highlight, nowMs);
    if (this.aim) drawAimLine(ctx, this.aim);

    this.effects.update(dt);
    this.effects.draw(ctx);
    ctx.restore();
  }

  destroy(): void {
    this.destroyed = true;
    this.unsubscribeCamera();
    this.camera.destroy();
    this.effects.clear();
    if (this.stage.parentNode === this.container) this.container.removeChild(this.stage);
  }

  private redrawStatic(): void {
    const ctx = this.staticCtx;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, this.staticCanvas.width, this.staticCanvas.height);
    this.camera.applyTransform(ctx);
    drawBorderFrame(ctx, 0, 0, LOGICAL_W, LOGICAL_H, FRAME_PX);
    if (this.layers) {
      ctx.save();
      ctx.translate(FRAME_PX, FRAME_PX);
      ctx.beginPath();
      ctx.rect(0, 0, FIELD_W, FIELD_H);
      ctx.clip();
      drawField(ctx, this.layers, this.world, { detail: true, magnetRadii: false });
      ctx.restore();
    } else {
      ctx.fillStyle = '#2b3a2b';
      ctx.fillRect(FRAME_PX, FRAME_PX, FIELD_W, FIELD_H);
    }
    this.staticDirty = false;
  }

  private drawOverlay(ctx: CanvasRenderingContext2D, o: EditorOverlay, layers: CourseLayers): void {
    ctx.save();
    if (o.grid) {
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let x = 1; x < COURSE_W; x++) { ctx.moveTo(x * TILE + 0.5, 0); ctx.lineTo(x * TILE + 0.5, FIELD_H); }
      for (let y = 1; y < COURSE_H; y++) { ctx.moveTo(0, y * TILE + 0.5); ctx.lineTo(FIELD_W, y * TILE + 0.5); }
      ctx.strokeStyle = EDITOR_PALETTE.grid;
      ctx.stroke();
      ctx.beginPath();
      for (let x = 7; x < COURSE_W; x += 7) { ctx.moveTo(x * TILE + 0.5, 0); ctx.lineTo(x * TILE + 0.5, FIELD_H); }
      for (let y = 5; y < COURSE_H; y += 5) { ctx.moveTo(0, y * TILE + 0.5); ctx.lineTo(FIELD_W, y * TILE + 0.5); }
      ctx.strokeStyle = EDITOR_PALETTE.gridMajor;
      ctx.stroke();
    }
    if (o.magnetRadii) {
      ctx.strokeStyle = EDITOR_PALETTE.magnetRadius;
      ctx.lineWidth = 1;
      for (const m of layers.magnets) {
        ctx.beginPath();
        ctx.arc(m.cx, m.cy, m.radius, 0, Math.PI * 2);
        ctx.stroke();
      }
    }
    if (o.teleportLinks) {
      ctx.lineWidth = 1.5;
      for (const p of layers.teleports) {
        const q = layers.teleports[p.partnerIndex];
        if (!q || p.tile > q.tile) continue; // each pair once
        ctx.strokeStyle = teleportColour(p.group);
        ctx.globalAlpha = 0.6;
        ctx.beginPath();
        ctx.moveTo(p.cx, p.cy);
        ctx.lineTo(q.cx, q.cy);
        ctx.stroke();
      }
      ctx.globalAlpha = 1;
    }
    for (const t of o.highlightTiles) {
      if (t < 0 || t >= COURSE_W * COURSE_H) continue;
      ctx.fillStyle = EDITOR_PALETTE.highlight;
      ctx.fillRect(tileX(t) * TILE, tileY(t) * TILE, TILE, TILE);
    }
    if (o.hoverTile >= 0 && o.hoverTile < COURSE_W * COURSE_H) {
      const x = tileX(o.hoverTile) * TILE;
      const y = tileY(o.hoverTile) * TILE;
      if (o.preview) {
        ctx.globalAlpha = 0.6;
        const v = o.preview.value;
        if (o.preview.layer === 'surface' && typeof v === 'number') drawSurface(ctx, v, x, y, o.hoverTile);
        else if (o.preview.layer === 'walls' && typeof v === 'number') {
          if (v === WallShape.None) { ctx.fillStyle = EDITOR_PALETTE.hover; ctx.fillRect(x, y, TILE, TILE); }
          else drawWall(ctx, v, x, y, 0);
        } else if (o.preview.layer === 'object' && typeof v === 'object') {
          drawObject(ctx, { ...v, x: tileX(o.hoverTile), y: tileY(o.hoverTile) } as CourseObject, x, y, { armed: true, magnetRadius: o.magnetRadii });
        }
        ctx.globalAlpha = 1;
      }
      ctx.strokeStyle = EDITOR_PALETTE.hover;
      ctx.lineWidth = 1;
      ctx.strokeRect(x + 0.5, y + 0.5, TILE - 1, TILE - 1);
    }
    ctx.restore();
  }
}

/** Centre of a tile in world px (re-exported convenience for callers that only import the renderer). */
export const tileCentreOf = (i: number): Vec2 => tileCentre(i);
