// Ball art (DESIGN §12.2): white disc with a radial gradient and a 1.5 px player-colour ring; optional turn
// highlight pulse. Drawn in logical px; (x, y) is the ball centre in field coordinates.
import { BALL_RADIUS } from '@puttipeli/shared/constants';
import { BALL_PALETTE, playerColour } from './palette';
import type { ArtContext } from './tileArt';

export function drawBall(ctx: ArtContext, x: number, y: number, colour: number, alpha: number, highlight: boolean, nowMs: number): void {
  const r = BALL_RADIUS;
  ctx.save();
  ctx.globalAlpha = alpha < 0 ? 0 : alpha > 1 ? 1 : alpha;
  // Soft contact shadow.
  ctx.fillStyle = BALL_PALETTE.shadow;
  ctx.beginPath();
  ctx.arc(x + 1, y + 1.5, r, 0, Math.PI * 2);
  ctx.fill();
  // Body with a highlight towards the upper left.
  const g = ctx.createRadialGradient(x - r * 0.35, y - r * 0.35, r * 0.2, x, y, r);
  g.addColorStop(0, BALL_PALETTE.highlight);
  g.addColorStop(0.65, BALL_PALETTE.body);
  g.addColorStop(1, BALL_PALETTE.shade);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  ctx.fill();
  // Player colour ring.
  ctx.strokeStyle = playerColour(colour);
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.arc(x, y, r - 0.75, 0, Math.PI * 2);
  ctx.stroke();
  if (highlight) {
    // Turn highlight: a pulsing ring (period 1.2 s) just outside the ball.
    const phase = (nowMs % 1200) / 1200;
    const pulse = 0.5 - 0.5 * Math.cos(phase * Math.PI * 2);
    ctx.globalAlpha = (0.25 + 0.5 * (1 - pulse)) * (alpha > 1 ? 1 : alpha);
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(x, y, r + 3 + pulse * 3, 0, Math.PI * 2);
    ctx.stroke();
  }
  ctx.restore();
}
