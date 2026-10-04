// Cosmetic particles (DESIGN §12.2): splash rings, mine burst, break debris, teleport flash, confetti on hole-in,
// dust on bounces and block slides. Purely visual; never touches the sim. Uses Math.random freely (not sim code).
import { TILE } from '@puttipeli/shared/constants';
import { tileCentre } from '@puttipeli/shared/course/grid';
import type { BallState, SimEvent } from '@puttipeli/shared/sim/types';
import { EFFECT_PALETTE } from './palette';
import type { ArtContext } from './tileArt';

type Kind = 'dot' | 'ring' | 'confetti' | 'flash';

interface Particle {
  kind: Kind;
  x: number; y: number;
  vx: number; vy: number;
  life: number;      // ms remaining
  maxLife: number;
  size: number;      // dot radius / ring end radius / confetti half-size
  colour: string;
  spin: number;      // confetti rotation speed (rad/s)
  gravity: number;   // px/s^2
}

const MAX_PARTICLES = 500;

export class Effects {
  /** Set to false (settings.reduceEffects) to spawn nothing; existing particles still finish. */
  enabled = true;
  private readonly ps: Particle[] = [];

  get count(): number { return this.ps.length; }

  clear(): void { this.ps.length = 0; }

  /**
   * Spawns the particles belonging to a SimEvent. Tile-carrying events (water, acid, break, teleport, ...) are placed
   * at their tile; the rest at `ball`'s current position (for 'mine' the caller passes the pre-reset position).
   */
  spawn(event: SimEvent, ball: BallState): void {
    if (!this.enabled) return;
    switch (event.type) {
      case 'bounce': {
        if (event.speed < 120) return;
        const n = Math.min(8, 2 + Math.floor(event.speed / 120));
        for (let i = 0; i < n; i++) {
          const a = Math.atan2(event.ny, event.nx) + (Math.random() - 0.5) * 2.2;
          const s = 30 + Math.random() * event.speed * 0.25;
          this.add({ kind: 'dot', x: event.x, y: event.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 260, size: 1 + Math.random(), colour: EFFECT_PALETTE.dust, gravity: 0 });
        }
        return;
      }
      case 'water': {
        // The event resets the ball, so the splash is placed at the hazard tile, independent of `ball`.
        const c = tileCentre(event.tile);
        for (let i = 0; i < 3; i++) this.add({ kind: 'ring', x: c.x, y: c.y, vx: 0, vy: 0, life: 500 + i * 150, size: 10 + i * 6, colour: EFFECT_PALETTE.splash, gravity: 0 });
        for (let i = 0; i < 12; i++) {
          const a = Math.random() * Math.PI * 2;
          const s = 40 + Math.random() * 80;
          this.add({ kind: 'dot', x: c.x, y: c.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 60, life: 500, size: 1.5, colour: EFFECT_PALETTE.splash, gravity: 300 });
        }
        return;
      }
      case 'acid': {
        const c = tileCentre(event.tile);
        for (let i = 0; i < 14; i++) {
          const a = Math.random() * Math.PI * 2;
          const s = 20 + Math.random() * 50;
          this.add({ kind: 'dot', x: c.x, y: c.y, vx: Math.cos(a) * s, vy: -40 - Math.random() * 60, life: 700, size: 1 + Math.random() * 1.5, colour: EFFECT_PALETTE.acid, gravity: -40 });
        }
        this.add({ kind: 'ring', x: c.x, y: c.y, vx: 0, vy: 0, life: 400, size: 12, colour: EFFECT_PALETTE.acid, gravity: 0 });
        return;
      }
      case 'tar': {
        for (let i = 0; i < 6; i++) {
          const a = Math.random() * Math.PI * 2;
          this.add({ kind: 'dot', x: ball.x, y: ball.y, vx: Math.cos(a) * 25, vy: Math.sin(a) * 25, life: 350, size: 1.5, colour: EFFECT_PALETTE.tar, gravity: 0 });
        }
        return;
      }
      case 'mine': {
        this.add({ kind: 'flash', x: ball.x, y: ball.y, vx: 0, vy: 0, life: 120, size: 22, colour: EFFECT_PALETTE.mine[0], gravity: 0 });
        this.add({ kind: 'ring', x: ball.x, y: ball.y, vx: 0, vy: 0, life: 450, size: 34, colour: EFFECT_PALETTE.mine[1], gravity: 0 });
        for (let i = 0; i < 28; i++) {
          const a = Math.random() * Math.PI * 2;
          const s = 60 + Math.random() * 220;
          const c = EFFECT_PALETTE.mine[i % 3]!;
          this.add({ kind: 'dot', x: ball.x, y: ball.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 400 + Math.random() * 300, size: 1 + Math.random() * 2, colour: c, gravity: 120 });
        }
        return;
      }
      case 'break':
      case 'destroyed': {
        const c = tileCentre(event.tile);
        const n = event.type === 'destroyed' ? 18 : 6;
        for (let i = 0; i < n; i++) {
          const a = Math.random() * Math.PI * 2;
          const s = 40 + Math.random() * 120;
          this.add({ kind: 'confetti', x: c.x + (Math.random() - 0.5) * TILE, y: c.y + (Math.random() - 0.5) * TILE, vx: Math.cos(a) * s, vy: Math.sin(a) * s - 40, life: 500 + Math.random() * 300, size: 1.5 + Math.random() * 1.5, colour: EFFECT_PALETTE.debris[i % 3]!, gravity: 350 });
        }
        return;
      }
      case 'blockMoved': {
        const from = tileCentre(event.from);
        const to = tileCentre(event.to);
        for (let i = 0; i < 8; i++) {
          const t = Math.random();
          this.add({ kind: 'dot', x: from.x + (to.x - from.x) * t + (Math.random() - 0.5) * TILE, y: from.y + (to.y - from.y) * t + (Math.random() - 0.5) * TILE, vx: (Math.random() - 0.5) * 30, vy: (Math.random() - 0.5) * 30, life: 350, size: 1.2, colour: EFFECT_PALETTE.slide, gravity: 0 });
        }
        return;
      }
      case 'teleport': {
        const a = tileCentre(event.from);
        const b = tileCentre(event.to);
        for (const p of [a, b]) {
          this.add({ kind: 'flash', x: p.x, y: p.y, vx: 0, vy: 0, life: 150, size: 12, colour: EFFECT_PALETTE.teleport, gravity: 0 });
          this.add({ kind: 'ring', x: p.x, y: p.y, vx: 0, vy: 0, life: 350, size: 16, colour: EFFECT_PALETTE.teleport, gravity: 0 });
        }
        return;
      }
      case 'holed': {
        for (let i = 0; i < 36; i++) {
          const a = -Math.PI / 2 + (Math.random() - 0.5) * 1.6;
          const s = 90 + Math.random() * 160;
          this.add({ kind: 'confetti', x: ball.x, y: ball.y, vx: Math.cos(a) * s, vy: Math.sin(a) * s, life: 900 + Math.random() * 500, size: 1.5 + Math.random() * 1.5, colour: EFFECT_PALETTE.confetti[i % EFFECT_PALETTE.confetti.length]!, gravity: 260 });
        }
        this.add({ kind: 'ring', x: ball.x, y: ball.y, vx: 0, vy: 0, life: 400, size: 14, colour: EFFECT_PALETTE.teleport, gravity: 0 });
        return;
      }
      default:
        return; // stopped, timeout: nothing
    }
  }

  /** Advances every particle by dtMs (clamped to 100 ms) and drops the dead ones. */
  update(dtMs: number): void {
    const dt = (dtMs > 100 ? 100 : dtMs < 0 ? 0 : dtMs) / 1000;
    const ps = this.ps;
    let w = 0;
    for (let i = 0; i < ps.length; i++) {
      const p = ps[i]!;
      p.life -= dtMs;
      if (p.life <= 0) continue;
      p.vy += p.gravity * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      ps[w++] = p;
    }
    ps.length = w;
  }

  /** Draws all particles in field coordinates. */
  draw(ctx: ArtContext): void {
    if (this.ps.length === 0) return;
    ctx.save();
    for (const p of this.ps) {
      const t = p.life / p.maxLife; // 1 -> 0
      switch (p.kind) {
        case 'dot':
          ctx.globalAlpha = t;
          ctx.fillStyle = p.colour;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'ring':
          ctx.globalAlpha = t * 0.9;
          ctx.strokeStyle = p.colour;
          ctx.lineWidth = 1.5;
          ctx.beginPath();
          ctx.arc(p.x, p.y, 2 + (1 - t) * p.size, 0, Math.PI * 2);
          ctx.stroke();
          break;
        case 'flash':
          ctx.globalAlpha = t * 0.8;
          ctx.fillStyle = p.colour;
          ctx.beginPath();
          ctx.arc(p.x, p.y, p.size * (0.4 + 0.6 * (1 - t)), 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'confetti': {
          ctx.globalAlpha = t < 0.3 ? t / 0.3 : 1;
          ctx.fillStyle = p.colour;
          const ang = (p.maxLife - p.life) / 1000 * p.spin;
          const c = Math.cos(ang) * p.size;
          const s = Math.sin(ang) * p.size;
          ctx.beginPath();
          ctx.moveTo(p.x + c, p.y + s);
          ctx.lineTo(p.x - s, p.y + c);
          ctx.lineTo(p.x - c, p.y - s);
          ctx.lineTo(p.x + s, p.y - c);
          ctx.closePath();
          ctx.fill();
          break;
        }
      }
    }
    ctx.restore();
  }

  private add(p: Omit<Particle, 'maxLife' | 'spin'> & { spin?: number }): void {
    if (this.ps.length >= MAX_PARTICLES) this.ps.shift();
    this.ps.push({ ...p, maxLife: p.life, spin: p.spin ?? (Math.random() - 0.5) * 12 });
  }
}
