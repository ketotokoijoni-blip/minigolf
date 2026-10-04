// Pointer / keyboard / touch aiming -> ShotInput (DESIGN §12.3). The preview and the shot both go through
// quantizeShot, so what the player sees is exactly what the authority receives.
//
// The pure helpers (clampPull, pullToAim, keyboardAimToPull, applyAimKey, angleToNearest) have no DOM dependency
// and are unit-tested in input.test.ts; createAimInput wires them to DOM events.
import { MAX_PULL_PX, MIN_PULL_PX, SHOT_QUANTUM } from '@puttipeli/shared/constants';
import type { Vec2 } from '@puttipeli/shared/course/types';
import { isNullShot, quantizeShot } from '@puttipeli/shared/sim/shot';
import type { ShotInput } from '@puttipeli/shared/sim/types';
import type { Camera } from './camera';
import type { AimSprite } from '../render/aimLine';

export type { AimSprite } from '../render/aimLine';

// ---------------------------------------------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------------------------------------------

/** Clamps a pull vector to `max` px (default MAX_PULL_PX), keeping its direction. Non-finite input -> (0, 0). */
export function clampPull(pull: Vec2, max = MAX_PULL_PX): Vec2 {
  const l = Math.sqrt(pull.x * pull.x + pull.y * pull.y);
  if (!Number.isFinite(l)) return { x: 0, y: 0 };
  if (l > max && l > 0) {
    const k = max / l;
    return { x: pull.x * k, y: pull.y * k };
  }
  return { x: pull.x, y: pull.y };
}

/** True when a pull is inside the dead zone (nothing would be sent). */
export const isDeadZone = (pull: Vec2): boolean => Math.sqrt(pull.x * pull.x + pull.y * pull.y) < MIN_PULL_PX;

/** ShotInput -> the pull in px it encodes (the de-quantized preview vector). */
export const shotToPull = (s: ShotInput): Vec2 => ({ x: s.dx / SHOT_QUANTUM, y: s.dy / SHOT_QUANTUM });

/**
 * Builds the aim preview for a raw pull: clamped, quantized, de-quantized, so the drawn line equals the shot
 * exactly. Inside the dead zone the sprite has a zero pull and power 0 (the line draws nothing, the HUD shows 0).
 */
export function pullToAim(from: Vec2, rawPull: Vec2): AimSprite {
  const clamped = clampPull(rawPull);
  const shot = quantizeShot(clamped.x, clamped.y);
  if (isNullShot(shot)) return { from, pull: { x: 0, y: 0 }, power: 0 };
  const pull = shotToPull(shot);
  const l = Math.sqrt(pull.x * pull.x + pull.y * pull.y);
  return { from, pull, power: Math.min(1, l / MAX_PULL_PX) };
}

/** The ShotInput an aim preview fires (null shot when nothing should be sent). */
export const aimToShot = (aim: AimSprite): ShotInput => quantizeShot(aim.pull.x, aim.pull.y);

/** Keyboard aim: angle (rad, 0 = east, positive = clockwise on screen since y points down) + power 0..1 -> pull px. */
export function keyboardAimToPull(angleRad: number, power01: number): { x: number; y: number } {
  const p = power01 < 0 ? 0 : power01 > 1 ? 1 : power01;
  const l = p * MAX_PULL_PX;
  return { x: Math.cos(angleRad) * l, y: Math.sin(angleRad) * l };
}

export interface KeyAimState { angleRad: number; power01: number }

export const KEY_ANGLE_STEP = (2 * Math.PI) / 180;        // 2 degrees
export const KEY_ANGLE_FINE = (0.25 * Math.PI) / 180;     // Shift: 0.25 degrees
export const KEY_POWER_STEP = 0.02;
export const KEY_POWER_FINE = 0.005;
export const KEY_POWER_DEFAULT = 0.5;

/** Applies one aiming key (ArrowLeft/Right/Up/Down). Returns a new state, or null when the key is not an aim key. */
export function applyAimKey(state: KeyAimState, key: string, shift: boolean): KeyAimState | null {
  const da = shift ? KEY_ANGLE_FINE : KEY_ANGLE_STEP;
  const dp = shift ? KEY_POWER_FINE : KEY_POWER_STEP;
  switch (key) {
    case 'ArrowLeft': return { angleRad: normalizeAngle(state.angleRad - da), power01: state.power01 };
    case 'ArrowRight': return { angleRad: normalizeAngle(state.angleRad + da), power01: state.power01 };
    case 'ArrowUp': return { angleRad: state.angleRad, power01: Math.min(1, round4(state.power01 + dp)) };
    case 'ArrowDown': return { angleRad: state.angleRad, power01: Math.max(0, round4(state.power01 - dp)) };
    default: return null;
  }
}

const round4 = (v: number): number => Math.round(v * 10000) / 10000;

/** Wraps an angle into [0, 2π). */
export function normalizeAngle(a: number): number {
  const two = Math.PI * 2;
  let r = a % two;
  if (r < 0) r += two;
  return r;
}

/** Angle from `from` to the nearest target (0 rad = east when there is none or the nearest coincides with `from`). */
export function angleToNearest(from: Vec2, targets: readonly Vec2[]): number {
  let best: Vec2 | null = null;
  let bestD = Infinity;
  for (const t of targets) {
    const d = (t.x - from.x) * (t.x - from.x) + (t.y - from.y) * (t.y - from.y);
    if (d < bestD) { bestD = d; best = t; }
  }
  if (!best || bestD < 1e-9) return 0;
  return normalizeAngle(Math.atan2(best.y - from.y, best.x - from.x));
}


// ---------------------------------------------------------------------------------------------------------------
// DOM binding
// ---------------------------------------------------------------------------------------------------------------

export interface AimInput {
  setBall(pos: Vec2 | null): void;             // null disables aiming
  setEnabled(on: boolean): void;
  getAim(): AimSprite | null;                  // current preview (quantized then de-quantized, so it matches the shot exactly)
  onShoot(cb: (shot: ShotInput) => void): () => void;
  onCancel(cb: () => void): () => void;
  destroy(): void;
  /**
   * Extension (not in the printed §12.3 interface): hole centres used for the keyboard's initial angle (nearest
   * hole; east when empty). The controller (WP-G) calls this on every holeStarted, before setBall(), so that the
   * default keyboard shot (Space/Enter without any arrow key) points at the nearest hole as §12.3 requires.
   */
  setTargets(holes: readonly Vec2[]): void;
}

export interface AimInputOptions {
  /** Touch: release does not fire; the fire button (HUD "Lyö") does. */
  touchFireButton: boolean;
  fireButton?: HTMLElement;
  /** Where keydown is listened to (default: window). Exposed for tests. */
  keyTarget?: EventTarget;
}

/** Minimal shape of a pointer event used here (lets tests dispatch plain Events carrying these fields). */
interface PointerLike extends Event {
  clientX: number;
  clientY: number;
  button: number;
  pointerId: number;
  pointerType: string;
}

export function createAimInput(canvas: HTMLElement, camera: Camera, opts: AimInputOptions): AimInput {
  let ball: Vec2 | null = null;
  let enabled = false;
  let pointer: Vec2 | null = null;      // last pointer position in world px
  let pointerOver = false;
  let armed = false;                    // button held since a pointerdown on the canvas
  let armedTouch = false;
  /**
   * Touch with the fire button: after the finger lifts the browser fires pointerout/leave (a non-hovering pointer),
   * so the last touch aim is kept sticky until the Lyö button fires it, something cancels it or the turn changes.
   */
  let touchHeld = false;
  let mode: 'pointer' | 'keyboard' = 'pointer';
  let keyAim: KeyAimState | null = null;
  let targets: readonly Vec2[] = [];
  const shootCbs = new Set<(shot: ShotInput) => void>();
  const cancelCbs = new Set<() => void>();
  const keyTarget: EventTarget | null = opts.keyTarget ?? (typeof window !== 'undefined' ? window : null);

  const active = (): boolean => enabled && ball !== null;

  /** §12.3 keyboard initial state: angle to the nearest hole, power 50 %. */
  const defaultKeyAim = (b: Vec2): KeyAimState => ({ angleRad: angleToNearest(b, targets), power01: KEY_POWER_DEFAULT });

  const keyAimSprite = (b: Vec2, k: KeyAimState): AimSprite => pullToAim(b, keyboardAimToPull(k.angleRad, k.power01));

  const getAim = (): AimSprite | null => {
    if (!active() || !ball) return null;
    if (mode === 'keyboard' && keyAim) return keyAimSprite(ball, keyAim);
    if (pointer && (pointerOver || armed || touchHeld)) return pullToAim(ball, { x: pointer.x - ball.x, y: pointer.y - ball.y });
    return null;
  };

  /** Sends the shot an aim preview encodes; dead-zone aims send nothing. Returns true when a shot was sent. */
  const fireAim = (aim: AimSprite): boolean => {
    const shot = aimToShot(aim);
    if (isNullShot(shot)) return false; // dead zone: nothing is sent
    touchHeld = false;
    shootCbs.forEach((cb) => cb(shot));
    return true;
  };

  const fire = (): void => {
    const aim = getAim();
    if (aim) fireAim(aim);
  };

  /** Esc / right-click / pointercancel: drops the armed state, the sticky touch aim and the keyboard preview. */
  const cancel = (): void => {
    const was = armed || touchHeld || keyAim !== null;
    armed = false;
    armedTouch = false;
    touchHeld = false;
    keyAim = null;          // the keyboard aim restarts from the §12.3 initial state on the next arrow key / Space
    mode = 'pointer';
    if (was) cancelCbs.forEach((cb) => cb());
  };

  const trackPointer = (e: PointerLike): void => {
    pointer = camera.toWorld(e.clientX, e.clientY);
    mode = 'pointer';
  };

  const onPointerMove = (e: Event): void => {
    trackPointer(e as PointerLike);
    pointerOver = true;
  };
  const onPointerEnter = (e: Event): void => {
    trackPointer(e as PointerLike);
    pointerOver = true;
  };
  const onPointerLeave = (): void => {
    pointerOver = false;
  };
  const onPointerDown = (ev: Event): void => {
    const e = ev as PointerLike;
    if (!active()) return;
    if (e.button === 2) {
      cancel();
      e.preventDefault();
      return;
    }
    if (e.button !== 0) return;
    trackPointer(e);
    pointerOver = true;
    armed = true;
    armedTouch = e.pointerType === 'touch';
    touchHeld = false;
    try { (canvas as Element & { setPointerCapture?: (id: number) => void }).setPointerCapture?.(e.pointerId); } catch { /* unsupported */ }
    e.preventDefault();
  };
  const onPointerUp = (ev: Event): void => {
    const e = ev as PointerLike;
    if (!armed) return;
    trackPointer(e);
    const wasTouch = armedTouch;
    armed = false;
    armedTouch = false;
    if (!active()) return;
    if (wasTouch && opts.touchFireButton) {                 // touch: the Lyö button fires the aim kept here
      touchHeld = true;
      return;
    }
    if (camera.contains(e.clientX, e.clientY)) fire();     // released on the canvas -> shoot
    else cancelCbs.forEach((cb) => cb());                  // dragged off-canvas -> cancel
  };
  const onPointerCancel = (): void => { if (armed) cancel(); };
  const onContextMenu = (e: Event): void => { e.preventDefault(); };

  const onKeyDown = (ev: Event): void => {
    const e = ev as KeyboardEvent;
    if (!active() || !ball) return;
    const target = e.target as HTMLElement | null;
    if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) return;
    if (e.key === 'Escape') {
      if (armed || touchHeld || mode === 'keyboard') { cancel(); e.preventDefault(); }
      return;
    }
    if (e.key === ' ' || e.key === 'Enter') {
      // With no preview on screen the keyboard's initial aim (nearest hole, 50 %) is the shot: a keyboard-only
      // player can take the default shot without touching an arrow key first.
      const aim = getAim() ?? keyAimSprite(ball, keyAim ?? defaultKeyAim(ball));
      if (fireAim(aim)) e.preventDefault();
      return;
    }
    const base = keyAim ?? defaultKeyAim(ball);
    const next = applyAimKey(base, e.key, e.shiftKey);
    if (!next) return;
    keyAim = next;
    mode = 'keyboard';
    touchHeld = false;
    e.preventDefault();
  };

  const onFireButton = (e: Event): void => {
    e.preventDefault();
    if (!active()) return;
    fire();
  };

  canvas.addEventListener('pointermove', onPointerMove);
  canvas.addEventListener('pointerenter', onPointerEnter);
  canvas.addEventListener('pointerleave', onPointerLeave);
  canvas.addEventListener('pointerdown', onPointerDown);
  canvas.addEventListener('pointerup', onPointerUp);
  canvas.addEventListener('pointercancel', onPointerCancel);
  canvas.addEventListener('contextmenu', onContextMenu);
  keyTarget?.addEventListener('keydown', onKeyDown);
  opts.fireButton?.addEventListener('click', onFireButton);

  return {
    setBall(pos) {
      ball = pos ? { x: pos.x, y: pos.y } : null;
      keyAim = null;          // a new turn: keyboard aim restarts from the nearest hole at 50 %
      armed = false;
      armedTouch = false;
      touchHeld = false;
      mode = 'pointer';
    },
    setEnabled(on) {
      enabled = on;
      if (!on) { armed = false; armedTouch = false; touchHeld = false; }
    },
    setTargets(holes) { targets = holes; },
    getAim,
    onShoot(cb) { shootCbs.add(cb); return () => { shootCbs.delete(cb); }; },
    onCancel(cb) { cancelCbs.add(cb); return () => { cancelCbs.delete(cb); }; },
    destroy() {
      canvas.removeEventListener('pointermove', onPointerMove);
      canvas.removeEventListener('pointerenter', onPointerEnter);
      canvas.removeEventListener('pointerleave', onPointerLeave);
      canvas.removeEventListener('pointerdown', onPointerDown);
      canvas.removeEventListener('pointerup', onPointerUp);
      canvas.removeEventListener('pointercancel', onPointerCancel);
      canvas.removeEventListener('contextmenu', onContextMenu);
      keyTarget?.removeEventListener('keydown', onKeyDown);
      opts.fireButton?.removeEventListener('click', onFireButton);
      shootCbs.clear();
      cancelCbs.clear();
    },
  };
}
