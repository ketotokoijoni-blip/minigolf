// 100 % procedural tile art (DESIGN §12.2). Everything is drawn with plain Canvas 2D calls in logical pixels so the
// art stays crisp at any scale (the camera applies the scale through the context transform).
//
// All functions take an `ArtContext` — the subset of CanvasRenderingContext2D actually used — so a minimal stub
// can exercise them in a node test (tileArt.test.ts). Keep the subset small: add a member here before using it.
import { TILE, HOLE_RADIUS } from '@puttipeli/shared/constants';
import { Surface, WallShape, type CourseObject } from '@puttipeli/shared/course/types';
import { breakableHits, isBreakable, isTriangle, oneWayDir, slopeDir, DIR_DX, DIR_DY } from '@puttipeli/shared/course/chars';
import { xorshift32 } from '@puttipeli/shared/math/rng';
import { OBJECT_PALETTE, SURFACE_PALETTE, WALL_PALETTE, teleportColour } from './palette';

export type ArtContext = Pick<
  CanvasRenderingContext2D,
  | 'fillRect' | 'strokeRect' | 'clearRect' | 'beginPath' | 'moveTo' | 'lineTo' | 'arc' | 'closePath' | 'fill' | 'stroke'
  | 'save' | 'restore' | 'translate' | 'rect' | 'clip' | 'fillText' | 'createRadialGradient'
> & {
  fillStyle: string | CanvasGradient | CanvasPattern;
  strokeStyle: string | CanvasGradient | CanvasPattern;
  lineWidth: number;
  lineCap: CanvasLineCap;
  lineJoin: CanvasLineJoin;
  globalAlpha: number;
  font: string;
  textAlign: CanvasTextAlign;
  textBaseline: CanvasTextBaseline;
};

const T = TILE;
const H = TILE / 2;

/** Tile centre in px for an object at tile (tx, ty). */
export const objectCentre = (o: { x: number; y: number }): { x: number; y: number } => ({ x: (o.x + 0.5) * T, y: (o.y + 0.5) * T });

// ---------------------------------------------------------------------------------------------------------------
// Surfaces
// ---------------------------------------------------------------------------------------------------------------

/** Draws the surface `code` with its top-left corner at (x, y). `seed` (tile index) selects the speckle pattern. */
export function drawSurface(ctx: ArtContext, code: number, x: number, y: number, seed: number, detail = true): void {
  switch (code) {
    case Surface.Sand: {
      ctx.fillStyle = SURFACE_PALETTE.sand.base;
      ctx.fillRect(x, y, T, T);
      if (!detail) return;
      const rnd = xorshift32(seed * 7 + 11);
      for (let i = 0; i < 6; i++) {
        ctx.fillStyle = i % 2 === 0 ? SURFACE_PALETTE.sand.dark : SURFACE_PALETTE.sand.light;
        ctx.fillRect(x + 1 + Math.floor(rnd() * (T - 2)), y + 1 + Math.floor(rnd() * (T - 2)), 1, 1);
      }
      return;
    }
    case Surface.Ice: {
      ctx.fillStyle = SURFACE_PALETTE.ice.base;
      ctx.fillRect(x, y, T, T);
      if (!detail) return;
      ctx.strokeStyle = SURFACE_PALETTE.ice.light;
      ctx.lineWidth = 1;
      ctx.lineCap = 'butt';
      ctx.beginPath();
      ctx.moveTo(x + 2.5, y + 9.5);
      ctx.lineTo(x + 9.5, y + 2.5);
      ctx.moveTo(x + 7.5, y + 12.5);
      ctx.lineTo(x + 12.5, y + 7.5);
      ctx.stroke();
      ctx.strokeStyle = SURFACE_PALETTE.ice.dark;
      ctx.beginPath();
      ctx.moveTo(x + 1.5, y + 13.5);
      ctx.lineTo(x + 4.5, y + 10.5);
      ctx.stroke();
      return;
    }
    case Surface.Tar: {
      ctx.fillStyle = SURFACE_PALETTE.tar.base;
      ctx.fillRect(x, y, T, T);
      if (!detail) return;
      ctx.strokeStyle = SURFACE_PALETTE.tar.light;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.beginPath();
      ctx.moveTo(x + 3, y + 10);
      ctx.lineTo(x + 9, y + 4);
      ctx.stroke();
      ctx.fillStyle = SURFACE_PALETTE.tar.dark;
      ctx.fillRect(x + 10, y + 11, 3, 2);
      return;
    }
    case Surface.Water: {
      ctx.fillStyle = SURFACE_PALETTE.water.base;
      ctx.fillRect(x, y, T, T);
      if (!detail) return;
      ctx.strokeStyle = SURFACE_PALETTE.water.light;
      ctx.lineWidth = 1;
      ctx.lineCap = 'round';
      const off = (seed % 3) * 1.5;
      ctx.beginPath();
      ctx.moveTo(x + 2, y + 5.5 + off);
      ctx.lineTo(x + 5, y + 3.5 + off);
      ctx.lineTo(x + 8, y + 5.5 + off);
      ctx.lineTo(x + 11, y + 3.5 + off);
      ctx.moveTo(x + 4, y + 11.5 - off);
      ctx.lineTo(x + 7, y + 9.5 - off);
      ctx.lineTo(x + 10, y + 11.5 - off);
      ctx.lineTo(x + 13, y + 9.5 - off);
      ctx.stroke();
      ctx.fillStyle = SURFACE_PALETTE.water.dark;
      ctx.fillRect(x + 1, y + 13, 4, 1);
      return;
    }
    case Surface.Acid: {
      ctx.fillStyle = SURFACE_PALETTE.acid.base;
      ctx.fillRect(x, y, T, T);
      if (!detail) return;
      const rnd = xorshift32(seed * 13 + 5);
      for (let i = 0; i < 3; i++) {
        const bx = x + 3 + rnd() * (T - 6);
        const by = y + 3 + rnd() * (T - 6);
        const r = 1 + rnd() * 1.5;
        ctx.fillStyle = SURFACE_PALETTE.acid.dark;
        ctx.beginPath();
        ctx.arc(bx, by, r, 0, Math.PI * 2);
        ctx.fill();
        ctx.fillStyle = SURFACE_PALETTE.acid.light;
        ctx.beginPath();
        ctx.arc(bx - r * 0.35, by - r * 0.35, r * 0.4, 0, Math.PI * 2);
        ctx.fill();
      }
      return;
    }
    case Surface.SlopeN:
    case Surface.SlopeE:
    case Surface.SlopeS:
    case Surface.SlopeW: {
      ctx.fillStyle = SURFACE_PALETTE.slope.base;
      ctx.fillRect(x, y, T, T);
      if (!detail) return;
      drawChevrons(ctx, x, y, slopeDir(code));
      return;
    }
    default: {
      // Grass (and any unknown code): green base, deterministic speckle from the tile index.
      ctx.fillStyle = SURFACE_PALETTE.grass.base;
      ctx.fillRect(x, y, T, T);
      if (!detail) return;
      const rnd = xorshift32(seed + 1);
      for (let i = 0; i < 7; i++) {
        ctx.fillStyle = i % 3 === 0 ? SURFACE_PALETTE.grass.light : SURFACE_PALETTE.grass.dark;
        ctx.fillRect(x + Math.floor(rnd() * T), y + Math.floor(rnd() * T), 1, i % 2 === 0 ? 2 : 1);
      }
      return;
    }
  }
}

/** Three darker chevrons pointing downhill (dir 0 N, 1 E, 2 S, 3 W). */
function drawChevrons(ctx: ArtContext, x: number, y: number, dir: number): void {
  const dx = DIR_DX[dir] ?? 0;
  const dy = DIR_DY[dir] ?? 1;
  // perpendicular axis
  const px = -dy;
  const py = dx;
  ctx.strokeStyle = SURFACE_PALETTE.slope.dark;
  ctx.lineWidth = 1.5;
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  const cx = x + H;
  const cy = y + H;
  ctx.beginPath();
  for (let i = -1; i <= 1; i++) {
    // chevron tip at offset i*4 along the downhill axis, arms 3 px back and 3 px to each side
    const tx = cx + dx * (i * 4 + 2);
    const ty = cy + dy * (i * 4 + 2);
    ctx.moveTo(tx - dx * 3 + px * 3.5, ty - dy * 3 + py * 3.5);
    ctx.lineTo(tx, ty);
    ctx.lineTo(tx - dx * 3 - px * 3.5, ty - dy * 3 - py * 3.5);
  }
  ctx.stroke();
}

// ---------------------------------------------------------------------------------------------------------------
// Walls
// ---------------------------------------------------------------------------------------------------------------

interface Bevel { base: string; light: string; dark: string }

/** Bevelled full block: lighter top-left edge, darker bottom-right edge, 2 px. */
function drawBevelBlock(ctx: ArtContext, x: number, y: number, w: number, h: number, pal: Bevel, bevel = 2): void {
  ctx.fillStyle = pal.base;
  ctx.fillRect(x, y, w, h);
  ctx.fillStyle = pal.light;
  ctx.fillRect(x, y, w, bevel);
  ctx.fillRect(x, y, bevel, h);
  ctx.fillStyle = pal.dark;
  ctx.fillRect(x, y + h - bevel, w, bevel);
  ctx.fillRect(x + w - bevel, y, bevel, h);
}

/** Triangle corners: returns the three vertices for a WallShape triangle code (solid corner first). */
function triangleVerts(code: number, x: number, y: number): [number, number, number, number, number, number] {
  switch (code) {
    case WallShape.TriNW: return [x, y, x + T, y, x, y + T];
    case WallShape.TriNE: return [x + T, y, x + T, y + T, x, y];
    case WallShape.TriSE: return [x + T, y + T, x, y + T, x + T, y];
    default: return [x, y + T, x, y, x + T, y + T]; // TriSW
  }
}

function drawTriangle(ctx: ArtContext, code: number, x: number, y: number, pal: Bevel): void {
  const [ax, ay, bx, by, cx, cy] = triangleVerts(code, x, y);
  ctx.fillStyle = pal.base;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.lineTo(cx, cy);
  ctx.closePath();
  ctx.fill();
  // Bevel along both legs (the edges meeting at the solid corner): light on legs facing up/left, dark otherwise.
  // The stroke is centred on the edge and clipped to the triangle, so a 4 px stroke shows the same 2 px bevel as a
  // full block.
  ctx.lineWidth = 4;
  ctx.lineCap = 'butt';
  const legIsLight = (x1: number, y1: number, x2: number, y2: number): boolean => y1 === y2 ? y1 === y : x1 === x;
  ctx.save();
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.lineTo(cx, cy);
  ctx.closePath();
  ctx.clip();
  ctx.strokeStyle = legIsLight(ax, ay, bx, by) ? pal.light : pal.dark;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(bx, by);
  ctx.stroke();
  ctx.strokeStyle = legIsLight(ax, ay, cx, cy) ? pal.light : pal.dark;
  ctx.beginPath();
  ctx.moveTo(ax, ay);
  ctx.lineTo(cx, cy);
  ctx.stroke();
  // Hypotenuse edge: a thin dark line so the diagonal reads clearly against grass.
  ctx.strokeStyle = pal.dark;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.moveTo(bx, by);
  ctx.lineTo(cx, cy);
  ctx.stroke();
  ctx.restore();
}

function drawBreakable(ctx: ArtContext, x: number, y: number, cracks: number): void {
  const p = WALL_PALETTE.brick;
  drawBevelBlock(ctx, x, y, T, T, p, 1);
  // Brick pattern: two mortar rows, offset vertical joints.
  ctx.fillStyle = p.mortar;
  ctx.fillRect(x + 1, y + 5, T - 2, 1);
  ctx.fillRect(x + 1, y + 10, T - 2, 1);
  ctx.fillRect(x + 7, y + 1, 1, 4);
  ctx.fillRect(x + 4, y + 6, 1, 4);
  ctx.fillRect(x + 11, y + 6, 1, 4);
  ctx.fillRect(x + 7, y + 11, 1, 3);
  // 0–2 crack lines by hits taken.
  if (cracks > 0) {
    ctx.strokeStyle = p.crack;
    ctx.lineWidth = 1;
    ctx.lineCap = 'butt';
    ctx.lineJoin = 'miter';
    ctx.beginPath();
    ctx.moveTo(x + 3.5, y + 1.5);
    ctx.lineTo(x + 6.5, y + 6.5);
    ctx.lineTo(x + 4.5, y + 9.5);
    ctx.lineTo(x + 8.5, y + 13.5);
    if (cracks > 1) {
      ctx.moveTo(x + 13.5, y + 3.5);
      ctx.lineTo(x + 9.5, y + 7.5);
      ctx.lineTo(x + 11.5, y + 10.5);
      ctx.lineTo(x + 7.5, y + 12.5);
    }
    ctx.stroke();
  }
}

function drawMovable(ctx: ArtContext, x: number, y: number): void {
  const p = WALL_PALETTE.movable;
  drawBevelBlock(ctx, x, y, T, T, p);
  // Four-arrow glyph.
  ctx.strokeStyle = p.glyph;
  ctx.fillStyle = p.glyph;
  ctx.lineWidth = 1;
  ctx.lineCap = 'butt';
  const cx = x + H;
  const cy = y + H;
  ctx.beginPath();
  ctx.moveTo(cx, cy - 4);
  ctx.lineTo(cx, cy + 4);
  ctx.moveTo(cx - 4, cy);
  ctx.lineTo(cx + 4, cy);
  ctx.stroke();
  const head = (dx: number, dy: number): void => {
    const tx = cx + dx * 5;
    const ty = cy + dy * 5;
    ctx.beginPath();
    ctx.moveTo(tx, ty);
    ctx.lineTo(tx - dx * 2 + dy * 2, ty - dy * 2 + dx * 2);
    ctx.lineTo(tx - dx * 2 - dy * 2, ty - dy * 2 - dx * 2);
    ctx.closePath();
    ctx.fill();
  };
  head(0, -1);
  head(1, 0);
  head(0, 1);
  head(-1, 0);
}

function drawBumper(ctx: ArtContext, x: number, y: number): void {
  const p = WALL_PALETTE.bumper;
  drawBevelBlock(ctx, x, y, T, T, p);
  ctx.strokeStyle = p.ring;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.arc(x + H, y + H, 4.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.strokeStyle = p.ringLight;
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(x + H, y + H, 4.5, Math.PI * 1.1, Math.PI * 1.6);
  ctx.stroke();
}

/** One-way block: hollow arrow along the passable direction; the entry face (opposite the arrow) is lighter. */
function drawOneWay(ctx: ArtContext, code: number, x: number, y: number): void {
  const p = WALL_PALETTE.oneWay;
  drawBevelBlock(ctx, x, y, T, T, p);
  const dir = oneWayDir(code);
  const dx = DIR_DX[dir] ?? 0;
  const dy = DIR_DY[dir] ?? -1;
  // Entry face strip (2 px on the face the ball comes in through).
  ctx.fillStyle = p.face;
  if (dx === 0) ctx.fillRect(x, dy < 0 ? y + T - 2 : y, T, 2);
  else ctx.fillRect(dx > 0 ? x : x + T - 2, y, 2, T);
  // Hollow arrow.
  const cx = x + H;
  const cy = y + H;
  const px = -dy;
  const py = dx;
  ctx.strokeStyle = p.arrow;
  ctx.lineWidth = 1;
  ctx.lineJoin = 'miter';
  ctx.beginPath();
  const pt = (a: number, s: number): [number, number] => [cx + dx * a + px * s, cy + dy * a + py * s];
  const pts: [number, number][] = [pt(5, 0), pt(0.5, 4.5), pt(0.5, 2), pt(-4.5, 2), pt(-4.5, -2), pt(0.5, -2), pt(0.5, -4.5)];
  const first = pts[0]!;
  ctx.moveTo(first[0] + 0.5, first[1] + 0.5);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i]![0] + 0.5, pts[i]![1] + 0.5);
  ctx.closePath();
  ctx.stroke();
}

/**
 * Draws the wall `code` at (x, y). `hitsTaken` (WorldState.breakHits) selects the crack level for breakables.
 * WallShape.None draws nothing.
 */
export function drawWall(ctx: ArtContext, code: number, x: number, y: number, hitsTaken = 0, detail = true): void {
  if (code === WallShape.None) return;
  if (!detail) {
    const pal = isBreakable(code) ? WALL_PALETTE.brick : code === WallShape.Movable ? WALL_PALETTE.movable
      : code === WallShape.Bumper ? WALL_PALETTE.bumper : code >= WallShape.OneWayN ? WALL_PALETTE.oneWay : WALL_PALETTE.stone;
    if (isTriangle(code)) {
      const [ax, ay, bx, by, cx, cy] = triangleVerts(code, x, y);
      ctx.fillStyle = pal.base;
      ctx.beginPath();
      ctx.moveTo(ax, ay);
      ctx.lineTo(bx, by);
      ctx.lineTo(cx, cy);
      ctx.closePath();
      ctx.fill();
    } else {
      ctx.fillStyle = pal.base;
      ctx.fillRect(x, y, T, T);
    }
    return;
  }
  if (isTriangle(code)) return drawTriangle(ctx, code, x, y, WALL_PALETTE.stone);
  if (isBreakable(code)) {
    const total = breakableHits(code);
    const cracks = Math.max(0, Math.min(2, Math.min(total - 1, hitsTaken)));
    return drawBreakable(ctx, x, y, cracks);
  }
  switch (code) {
    case WallShape.Movable: return drawMovable(ctx, x, y);
    case WallShape.Bumper: return drawBumper(ctx, x, y);
    case WallShape.OneWayN:
    case WallShape.OneWayE:
    case WallShape.OneWayS:
    case WallShape.OneWayW: return drawOneWay(ctx, code, x, y);
    default: return drawBevelBlock(ctx, x, y, T, T, WALL_PALETTE.stone);
  }
}

/** The 15 px frame around the field, drawn as a bevelled border wall. (x, y) is the outer top-left corner. */
export function drawBorderFrame(ctx: ArtContext, x: number, y: number, outerW: number, outerH: number, frame: number): void {
  const p = WALL_PALETTE.border;
  ctx.fillStyle = p.base;
  ctx.fillRect(x, y, outerW, frame);
  ctx.fillRect(x, y + outerH - frame, outerW, frame);
  ctx.fillRect(x, y, frame, outerH);
  ctx.fillRect(x + outerW - frame, y, frame, outerH);
  // Outer bevel.
  ctx.fillStyle = p.light;
  ctx.fillRect(x, y, outerW, 2);
  ctx.fillRect(x, y, 2, outerH);
  ctx.fillStyle = p.dark;
  ctx.fillRect(x, y + outerH - 2, outerW, 2);
  ctx.fillRect(x + outerW - 2, y, 2, outerH);
  // Inner bevel (reversed: the field is "below" the frame).
  ctx.fillStyle = p.dark;
  ctx.fillRect(x + frame - 2, y + frame - 2, outerW - 2 * frame + 4, 2);
  ctx.fillRect(x + frame - 2, y + frame - 2, 2, outerH - 2 * frame + 4);
  ctx.fillStyle = p.light;
  ctx.fillRect(x + frame - 2, y + outerH - frame, outerW - 2 * frame + 4, 2);
  ctx.fillRect(x + outerW - frame, y + frame - 2, 2, outerH - 2 * frame + 4);
  // Stud marks every 3 tiles along the frame for texture.
  ctx.fillStyle = p.dark;
  for (let i = frame + 7; i < outerW - frame; i += 45) {
    ctx.fillRect(x + i, y + 6, 2, 3);
    ctx.fillRect(x + i, y + outerH - 9, 2, 3);
  }
  for (let j = frame + 7; j < outerH - frame; j += 45) {
    ctx.fillRect(x + 6, y + j, 3, 2);
    ctx.fillRect(x + outerW - 9, y + j, 3, 2);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Objects
// ---------------------------------------------------------------------------------------------------------------

export interface ObjectArtOptions {
  /** Mines: false draws the grey disarmed look. */
  armed?: boolean;
  /** Magnets: draw the faint radius circle (editor). */
  magnetRadius?: boolean;
  detail?: boolean;
}

/** Draws a course object centred in its tile whose top-left corner is (x, y). */
export function drawObject(ctx: ArtContext, obj: CourseObject, x: number, y: number, opts: ObjectArtOptions = {}): void {
  const cx = x + H;
  const cy = y + H;
  const detail = opts.detail !== false;
  switch (obj.type) {
    case 'hole': return drawHole(ctx, cx, cy, detail);
    case 'start': return drawStart(ctx, cx, cy);
    case 'teleport': return drawTeleport(ctx, cx, cy, obj.group, detail);
    case 'magnet': return drawMagnet(ctx, x, y, obj.polarity, obj.radius, opts.magnetRadius === true, detail);
    case 'mine': return drawMine(ctx, cx, cy, opts.armed !== false, detail);
  }
}

export function drawHole(ctx: ArtContext, cx: number, cy: number, detail = true): void {
  const p = OBJECT_PALETTE.hole;
  ctx.fillStyle = p.rim;
  ctx.beginPath();
  ctx.arc(cx, cy, HOLE_RADIUS, 0, Math.PI * 2);
  ctx.fill();
  if (detail) {
    // Inner shadow: darker towards the lower right.
    const g = ctx.createRadialGradient(cx - 2, cy - 2, 1, cx, cy, HOLE_RADIUS);
    g.addColorStop(0, p.rim);
    g.addColorStop(0.55, p.cup);
    g.addColorStop(1, p.shadow);
    ctx.fillStyle = g;
  } else {
    ctx.fillStyle = p.cup;
  }
  ctx.beginPath();
  ctx.arc(cx, cy, HOLE_RADIUS - 1, 0, Math.PI * 2);
  ctx.fill();
  if (!detail) return;
  // Small flag post leaning out of the cup to the upper right.
  ctx.strokeStyle = p.post;
  ctx.lineWidth = 1;
  ctx.lineCap = 'round';
  ctx.beginPath();
  ctx.moveTo(cx + 1.5, cy + 1);
  ctx.lineTo(cx + 1.5, cy - 9);
  ctx.stroke();
  ctx.fillStyle = p.flag;
  ctx.beginPath();
  ctx.moveTo(cx + 2, cy - 9);
  ctx.lineTo(cx + 7, cy - 7);
  ctx.lineTo(cx + 2, cy - 5);
  ctx.closePath();
  ctx.fill();
}

export function drawStart(ctx: ArtContext, cx: number, cy: number): void {
  const p = OBJECT_PALETTE.start;
  ctx.strokeStyle = p.ring;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, 5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.fillStyle = p.inner;
  ctx.beginPath();
  ctx.arc(cx, cy, 1.2, 0, Math.PI * 2);
  ctx.fill();
}

export function drawTeleport(ctx: ArtContext, cx: number, cy: number, group: number, detail = true): void {
  const col = teleportColour(group);
  ctx.fillStyle = OBJECT_PALETTE.teleportDigit;
  ctx.beginPath();
  ctx.arc(cx, cy, 6.5, 0, Math.PI * 2);
  ctx.fill();
  ctx.strokeStyle = col;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
  ctx.stroke();
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.arc(cx, cy, 3, 0, Math.PI * 2);
  ctx.stroke();
  if (!detail) return;
  // Small digit (group + 1) for colour-blind players.
  ctx.fillStyle = col;
  ctx.font = 'bold 5px sans-serif';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(String(group + 1), cx, cy + 0.5);
}

export function drawMagnet(ctx: ArtContext, x: number, y: number, polarity: number, radius: number, showRadius: boolean, detail = true): void {
  const p = OBJECT_PALETTE.magnet;
  const col = polarity > 0 ? p.attract : p.repel;
  const cx = x + H;
  const cy = y + H;
  if (showRadius) {
    ctx.strokeStyle = col;
    ctx.lineWidth = 1;
    ctx.globalAlpha = 0.35;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
  }
  // Coloured face on the block.
  ctx.fillStyle = col;
  ctx.fillRect(x + 3, y + 3, T - 6, T - 6);
  if (!detail) return;
  ctx.fillStyle = p.sign;
  ctx.fillRect(x + 5, y + 7, T - 10, 1);
  if (polarity > 0) ctx.fillRect(x + 7, y + 5, 1, T - 10);
}

export function drawMine(ctx: ArtContext, cx: number, cy: number, armed: boolean, detail = true): void {
  const p = OBJECT_PALETTE.mine;
  if (detail) {
    ctx.strokeStyle = armed ? p.spike : p.disarmedSpike;
    ctx.lineWidth = 1.2;
    ctx.lineCap = 'round';
    ctx.beginPath();
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      ctx.moveTo(cx + Math.cos(a) * 3, cy + Math.sin(a) * 3);
      ctx.lineTo(cx + Math.cos(a) * 6, cy + Math.sin(a) * 6);
    }
    ctx.stroke();
  }
  ctx.fillStyle = armed ? p.body : p.disarmed;
  ctx.beginPath();
  ctx.arc(cx, cy, 4, 0, Math.PI * 2);
  ctx.fill();
  if (armed) {
    ctx.fillStyle = p.dot;
    ctx.beginPath();
    ctx.arc(cx, cy, 1.3, 0, Math.PI * 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------------------------------------------
// Convenience for legends / palettes (help screen, editor palette buttons)
// ---------------------------------------------------------------------------------------------------------------

/** Draws a single legend tile (surface under wall under object) at (x, y). Any of the parts may be omitted. */
export function drawLegendTile(ctx: ArtContext, x: number, y: number, parts: { surface?: number; wall?: number; object?: CourseObject }): void {
  drawSurface(ctx, parts.surface ?? Surface.Grass, x, y, 0);
  if (parts.wall !== undefined) drawWall(ctx, parts.wall, x, y);
  if (parts.object) drawObject(ctx, parts.object, x, y, { armed: true });
}

/** Every surface code, for legends and smoke tests. */
export const ALL_SURFACES: readonly number[] = Object.values(Surface);
/** Every wall code except None. */
export const ALL_WALLS: readonly number[] = Object.values(WallShape).filter((w) => w !== WallShape.None);
