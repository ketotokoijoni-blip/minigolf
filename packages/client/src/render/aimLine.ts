// Aim line (DESIGN §12.3): drawn from the ball toward the cursor with length = clamped pull, colour from white to
// red with power, power ticks at 25/50/75 %, and a cap mark when the pull is at the maximum.
import { BALL_RADIUS, MAX_PULL_PX } from '@puttipeli/shared/constants';
import type { Vec2 } from '@puttipeli/shared/course/types';
import { AIM_PALETTE, mixRgb } from './palette';
import type { ArtContext } from './tileArt';

export interface AimSprite { from: Vec2; pull: Vec2 /* clamped, px */; power: number /* 0..1 */ }

export function drawAimLine(ctx: ArtContext, aim: AimSprite): void {
  const len = Math.sqrt(aim.pull.x * aim.pull.x + aim.pull.y * aim.pull.y);
  if (!(len > 0.5)) return;
  const ux = aim.pull.x / len;
  const uy = aim.pull.y / len;
  const px = -uy;
  const py = ux;
  const power = aim.power < 0 ? 0 : aim.power > 1 ? 1 : aim.power;
  const colour = mixRgb(AIM_PALETTE.low, AIM_PALETTE.high, power);
  const x0 = aim.from.x + ux * (BALL_RADIUS + 1);
  const y0 = aim.from.y + uy * (BALL_RADIUS + 1);
  const x1 = aim.from.x + ux * len;
  const y1 = aim.from.y + uy * len;
  ctx.save();
  ctx.lineCap = 'round';
  ctx.lineJoin = 'round';
  // Dark halo so the line is readable on light surfaces (sand, ice).
  ctx.strokeStyle = 'rgba(0,0,0,0.35)';
  ctx.lineWidth = 4;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  ctx.strokeStyle = colour;
  ctx.lineWidth = 2;
  ctx.beginPath();
  ctx.moveTo(x0, y0);
  ctx.lineTo(x1, y1);
  ctx.stroke();
  // Power ticks at 25/50/75 % of MAX_PULL_PX (only those within the current pull).
  ctx.strokeStyle = AIM_PALETTE.tick;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (const f of [0.25, 0.5, 0.75]) {
    const d = f * MAX_PULL_PX;
    if (d > len) break;
    const tx = aim.from.x + ux * d;
    const ty = aim.from.y + uy * d;
    const h = f === 0.5 ? 4 : 3;
    ctx.moveTo(tx + px * h, ty + py * h);
    ctx.lineTo(tx - px * h, ty - py * h);
  }
  ctx.stroke();
  // Arrow head.
  ctx.fillStyle = colour;
  ctx.beginPath();
  ctx.moveTo(x1 + ux * 4, y1 + uy * 4);
  ctx.lineTo(x1 - ux * 3 + px * 3.5, y1 - uy * 3 + py * 3.5);
  ctx.lineTo(x1 - ux * 3 - px * 3.5, y1 - uy * 3 - py * 3.5);
  ctx.closePath();
  ctx.fill();
  // Cap mark: a red bar across the end when the pull is at the maximum.
  if (power >= 0.999) {
    ctx.strokeStyle = AIM_PALETTE.cap;
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.moveTo(x1 + ux * 6 + px * 6, y1 + uy * 6 + py * 6);
    ctx.lineTo(x1 + ux * 6 - px * 6, y1 + uy * 6 - py * 6);
    ctx.stroke();
  }
  ctx.restore();
}
