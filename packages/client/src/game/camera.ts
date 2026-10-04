// Camera (DESIGN §12.2): fits the fixed 765x405 logical canvas into its container, handles HiDPI backing stores
// and maps pointer client coordinates to world px (field coordinates: logical px minus the 15 px frame).
import { FIELD_H, FIELD_W, TILE } from '@puttipeli/shared/constants';
import type { Vec2 } from '@puttipeli/shared/course/types';

/** Frame width around the field in logical px (the border wall). */
export const FRAME_PX = TILE;
/** Logical canvas size: field plus the frame on every side. */
export const LOGICAL_W = FIELD_W + 2 * FRAME_PX; // 765
export const LOGICAL_H = FIELD_H + 2 * FRAME_PX; // 405

/**
 * Chooses the logical->CSS scale for a container: min(w/765, h/405). Per §12.2 the integer scale is used whenever
 * the raw scale is >= 1 (crisp 1 px lines, nearest-neighbour static blit); below 1 the fractional scale is kept
 * so the whole field stays visible on small screens.
 */
export function chooseScale(containerW: number, containerH: number): number {
  const raw = Math.min(containerW / LOGICAL_W, containerH / LOGICAL_H);
  if (!(raw > 0) || !Number.isFinite(raw)) return 1;
  return raw >= 1 ? Math.floor(raw) : raw;
}

export class Camera {
  private _scale = 1;
  private _dpr = 1;
  private cssW = LOGICAL_W;
  private cssH = LOGICAL_H;
  private observer: ResizeObserver | null = null;
  private readonly listeners = new Set<() => void>();
  private readonly onWindowResize = (): void => this.fit();
  /** Media query that flips when devicePixelRatio changes (window dragged to another monitor); re-armed per fit. */
  private dprQuery: MediaQueryList | null = null;
  private readonly onDprChange = (): void => this.fit();

  /**
   * @param container element whose size the canvas stack is fitted into (observed with ResizeObserver)
   * @param stage     wrapper element holding the canvases; sized to the CSS size and centred by the renderer
   * @param canvases  canvases to size (backing store = CSS size x devicePixelRatio)
   */
  constructor(
    private readonly container: HTMLElement,
    private readonly stage: HTMLElement,
    private readonly canvases: readonly HTMLCanvasElement[],
  ) {
    if (typeof ResizeObserver !== 'undefined') {
      this.observer = new ResizeObserver(() => this.fit());
      this.observer.observe(container);
    } else if (typeof window !== 'undefined') {
      window.addEventListener('resize', this.onWindowResize);
    }
    this.fit();
  }

  /** Logical px -> CSS px. */
  get scale(): number { return this._scale; }
  /** Device pixel ratio used for the backing stores. */
  get dpr(): number { return this._dpr; }
  /** CSS size of the canvas stack. */
  get cssSize(): { w: number; h: number } { return { w: this.cssW, h: this.cssH }; }

  /** Called after every fit() that changed the scale, the dpr or the backing size (the renderer redraws then). */
  onChange(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => { this.listeners.delete(listener); };
  }

  /** Recomputes the scale from the container size and resizes the canvases. Safe to call at any time. */
  fit(): void {
    const w = this.container.clientWidth || LOGICAL_W;
    const h = this.container.clientHeight || LOGICAL_H;
    const scale = chooseScale(w, h);
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    const cssW = Math.floor(LOGICAL_W * scale);
    const cssH = Math.floor(LOGICAL_H * scale);
    const backW = Math.max(1, Math.round(cssW * dpr));
    const backH = Math.max(1, Math.round(cssH * dpr));
    const first = this.canvases[0];
    const unchanged = scale === this._scale && dpr === this._dpr && cssW === this.cssW && cssH === this.cssH
      && first !== undefined && first.width === backW && first.height === backH;
    this._scale = scale;
    this._dpr = dpr;
    this.cssW = cssW;
    this.cssH = cssH;
    this.stage.style.width = `${cssW}px`;
    this.stage.style.height = `${cssH}px`;
    for (const c of this.canvases) {
      c.style.width = `${cssW}px`;
      c.style.height = `${cssH}px`;
      if (c.width !== backW) c.width = backW;
      if (c.height !== backH) c.height = backH;
    }
    this.watchDpr(dpr);
    if (!unchanged) this.listeners.forEach((f) => f());
  }

  /** (Re)arms a `(resolution: Xdppx)` change listener so a DPR change without a layout change still refits. */
  private watchDpr(dpr: number): void {
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    if (this.dprQuery && this.dprQuery.media === `(resolution: ${dpr}dppx)`) return;
    this.unwatchDpr();
    try {
      const q = window.matchMedia(`(resolution: ${dpr}dppx)`);
      if (typeof q.addEventListener === 'function') q.addEventListener('change', this.onDprChange);
      else q.addListener(this.onDprChange); // older Safari
      this.dprQuery = q;
    } catch { /* matchMedia unsupported for resolution queries: the ResizeObserver still covers zoom */ }
  }

  private unwatchDpr(): void {
    const q = this.dprQuery;
    if (!q) return;
    this.dprQuery = null;
    try {
      if (typeof q.removeEventListener === 'function') q.removeEventListener('change', this.onDprChange);
      else q.removeListener(this.onDprChange);
    } catch { /* ignore */ }
  }

  /** Effective device px per logical px: the factor the context transform uses. */
  get pixelScale(): number { return this.cssW / LOGICAL_W * this._dpr; }

  /** Sets the context transform so all drawing is in logical px (0..765 x 0..405). */
  applyTransform(ctx: CanvasRenderingContext2D): void {
    const k = this.pixelScale;
    ctx.setTransform(k, 0, 0, k, 0, 0);
    ctx.imageSmoothingEnabled = !Number.isInteger(this._scale);
  }

  /** Client (pointer) coordinates -> world px (field coordinates; (0,0) = field top-left, frame subtracted). */
  toWorld(clientX: number, clientY: number): Vec2 {
    const el = this.canvases[0] ?? this.stage;
    const rect = el.getBoundingClientRect();
    const kx = rect.width > 0 ? LOGICAL_W / rect.width : 1 / this._scale;
    const ky = rect.height > 0 ? LOGICAL_H / rect.height : 1 / this._scale;
    return { x: (clientX - rect.left) * kx - FRAME_PX, y: (clientY - rect.top) * ky - FRAME_PX };
  }

  /** True when the client point lies on the canvas stack (frame included). */
  contains(clientX: number, clientY: number): boolean {
    const el = this.canvases[0] ?? this.stage;
    const r = el.getBoundingClientRect();
    return clientX >= r.left && clientX < r.right && clientY >= r.top && clientY < r.bottom;
  }

  destroy(): void {
    this.observer?.disconnect();
    this.observer = null;
    this.unwatchDpr();
    if (typeof window !== 'undefined') window.removeEventListener('resize', this.onWindowResize);
    this.listeners.clear();
  }
}
