// Pure-logic tests for the aiming helpers (DESIGN §16.5): clamp, dead zone, quantization, keyboard aim.
import { afterEach, describe, expect, it } from 'vitest';
import { MAX_PULL_PX, MIN_PULL_PX, SHOT_QUANTUM } from '@puttipeli/shared/constants';
import { quantizeShot, validateShot } from '@puttipeli/shared/sim/shot';
import { resetSimTuning } from '@puttipeli/shared/sim/tuning';
import type { ShotInput } from '@puttipeli/shared/sim/types';
import type { Camera } from './camera';
import {
  KEY_ANGLE_FINE, KEY_ANGLE_STEP, KEY_POWER_FINE, KEY_POWER_STEP,
  aimToShot, angleToNearest, applyAimKey, clampPull, createAimInput, isDeadZone, keyboardAimToPull, normalizeAngle, pullToAim, shotToPull,
} from './input';

afterEach(() => resetSimTuning());

const len = (v: { x: number; y: number }): number => Math.sqrt(v.x * v.x + v.y * v.y);

describe('clampPull', () => {
  it('leaves pulls at or below the cap unchanged', () => {
    expect(clampPull({ x: 30, y: -40 })).toEqual({ x: 30, y: -40 });
    expect(len(clampPull({ x: 0, y: MAX_PULL_PX }))).toBeCloseTo(MAX_PULL_PX, 9);
  });
  it('clamps longer pulls to MAX_PULL_PX and keeps the direction', () => {
    const c = clampPull({ x: 300, y: 400 });
    expect(len(c)).toBeCloseTo(MAX_PULL_PX, 9);
    expect(c.x / c.y).toBeCloseTo(0.75, 9);
    expect(c.x).toBeGreaterThan(0);
    expect(c.y).toBeGreaterThan(0);
  });
  it('maps non-finite input to the zero vector', () => {
    expect(clampPull({ x: Number.NaN, y: 1 })).toEqual({ x: 0, y: 0 });
    expect(clampPull({ x: Number.POSITIVE_INFINITY, y: 1 })).toEqual({ x: 0, y: 0 });
  });
});

describe('dead zone', () => {
  it('isDeadZone is true strictly below MIN_PULL_PX', () => {
    expect(isDeadZone({ x: 0, y: 0 })).toBe(true);
    expect(isDeadZone({ x: MIN_PULL_PX - 0.1, y: 0 })).toBe(true);
    expect(isDeadZone({ x: MIN_PULL_PX, y: 0 })).toBe(false);
  });
  it('pullToAim yields a zero pull and power 0 inside the dead zone, and aimToShot sends nothing', () => {
    const aim = pullToAim({ x: 100, y: 100 }, { x: 1.5, y: 2 });
    expect(aim.pull).toEqual({ x: 0, y: 0 });
    expect(aim.power).toBe(0);
    expect(aimToShot(aim)).toEqual({ dx: 0, dy: 0 });
  });
});

describe('quantization', () => {
  it('the preview pull is the de-quantized shot (what you see is what the authority gets)', () => {
    const from = { x: 50, y: 60 };
    const raw = { x: 33.337, y: -66.661 };
    const aim = pullToAim(from, raw);
    const shot = quantizeShot(raw.x, raw.y);
    expect(shot).toEqual({ dx: 3334, dy: -6666 });
    expect(aim.pull).toEqual(shotToPull(shot));
    expect(aim.pull.x * SHOT_QUANTUM).toBeCloseTo(shot.dx, 9);
    expect(aim.from).toBe(from);
  });
  it('re-quantizing the preview gives the identical shot (idempotent)', () => {
    for (const raw of [{ x: 10.004, y: 5.006 }, { x: -119, y: 1 }, { x: 500, y: -250 }, { x: 3, y: 0 }]) {
      const aim = pullToAim({ x: 0, y: 0 }, raw);
      const shot = aimToShot(aim);
      const c = clampPull(raw);
      expect(shot).toEqual(quantizeShot(c.x, c.y));
      expect(validateShot(shot)).toBe(true);
    }
  });
  it('power is |pull| / MAX_PULL_PX, capped at 1', () => {
    expect(pullToAim({ x: 0, y: 0 }, { x: 60, y: 0 }).power).toBeCloseTo(0.5, 9);
    expect(pullToAim({ x: 0, y: 0 }, { x: 1000, y: 0 }).power).toBe(1);
    const capped = pullToAim({ x: 0, y: 0 }, { x: 1000, y: 0 });
    expect(len(capped.pull)).toBeCloseTo(MAX_PULL_PX, 9);
    expect(aimToShot(capped)).toEqual({ dx: MAX_PULL_PX * SHOT_QUANTUM, dy: 0 });
  });
});

describe('keyboardAimToPull', () => {
  it('angle 0 points east with length power * MAX_PULL_PX', () => {
    const v = keyboardAimToPull(0, 1);
    expect(v.x).toBeCloseTo(MAX_PULL_PX, 9);
    expect(v.y).toBeCloseTo(0, 9);
    expect(len(keyboardAimToPull(0, 0.5))).toBeCloseTo(MAX_PULL_PX / 2, 9);
  });
  it('angle pi/2 points south (y down)', () => {
    const v = keyboardAimToPull(Math.PI / 2, 1);
    expect(v.x).toBeCloseTo(0, 9);
    expect(v.y).toBeCloseTo(MAX_PULL_PX, 9);
  });
  it('clamps power into [0, 1]', () => {
    expect(len(keyboardAimToPull(1, 3))).toBeCloseTo(MAX_PULL_PX, 9);
    expect(keyboardAimToPull(1, -1)).toEqual({ x: 0, y: 0 });
  });
  it('produces the identical ShotInput as the mouse for the same vector', () => {
    const mouse = { x: 40, y: 30 };
    const angle = Math.atan2(mouse.y, mouse.x);
    const power = len(mouse) / MAX_PULL_PX;
    const kb = keyboardAimToPull(angle, power);
    const from = { x: 200, y: 100 };
    expect(aimToShot(pullToAim(from, kb))).toEqual(aimToShot(pullToAim(from, mouse)));
    expect(aimToShot(pullToAim(from, kb))).toEqual({ dx: 4000, dy: 3000 });
  });
});

describe('applyAimKey', () => {
  const s = { angleRad: 1, power01: 0.5 };
  it('rotates 2 degrees, 0.25 with Shift', () => {
    expect(applyAimKey(s, 'ArrowRight', false)!.angleRad).toBeCloseTo(1 + KEY_ANGLE_STEP, 12);
    expect(applyAimKey(s, 'ArrowLeft', false)!.angleRad).toBeCloseTo(1 - KEY_ANGLE_STEP, 12);
    expect(applyAimKey(s, 'ArrowRight', true)!.angleRad).toBeCloseTo(1 + KEY_ANGLE_FINE, 12);
    expect(KEY_ANGLE_STEP).toBeCloseTo((2 * Math.PI) / 180, 12);
  });
  it('changes power by 2 %, 0.5 % with Shift, clamped to [0, 1]', () => {
    expect(applyAimKey(s, 'ArrowUp', false)!.power01).toBeCloseTo(0.5 + KEY_POWER_STEP, 12);
    expect(applyAimKey(s, 'ArrowDown', true)!.power01).toBeCloseTo(0.5 - KEY_POWER_FINE, 12);
    expect(applyAimKey({ angleRad: 0, power01: 0.995 }, 'ArrowUp', false)!.power01).toBe(1);
    expect(applyAimKey({ angleRad: 0, power01: 0.01 }, 'ArrowDown', false)!.power01).toBe(0);
  });
  it('returns null for non-aim keys and never mutates its input', () => {
    expect(applyAimKey(s, 'a', false)).toBeNull();
    expect(applyAimKey(s, ' ', false)).toBeNull();
    applyAimKey(s, 'ArrowUp', false);
    expect(s).toEqual({ angleRad: 1, power01: 0.5 });
  });
  it('wraps the angle into [0, 2pi)', () => {
    expect(applyAimKey({ angleRad: 0, power01: 0.5 }, 'ArrowLeft', false)!.angleRad).toBeCloseTo(Math.PI * 2 - KEY_ANGLE_STEP, 12);
    expect(normalizeAngle(Math.PI * 4 + 0.5)).toBeCloseTo(0.5, 12);
    expect(normalizeAngle(-0.5)).toBeCloseTo(Math.PI * 2 - 0.5, 12);
  });
});

describe('angleToNearest', () => {
  it('points at the nearest target', () => {
    const a = angleToNearest({ x: 0, y: 0 }, [{ x: 100, y: 100 }, { x: 0, y: -10 }, { x: 50, y: 0 }]);
    expect(a).toBeCloseTo(normalizeAngle(-Math.PI / 2), 12); // north
  });
  it('defaults to east (0) without targets or when the target coincides with the ball', () => {
    expect(angleToNearest({ x: 5, y: 5 }, [])).toBe(0);
    expect(angleToNearest({ x: 5, y: 5 }, [{ x: 5, y: 5 }])).toBe(0);
  });
});

// ---------------------------------------------------------------------------------------------------------------
// DOM binding (createAimInput) driven with plain EventTargets: no jsdom, the handlers only read event fields.
// ---------------------------------------------------------------------------------------------------------------

interface Rig {
  canvas: EventTarget; keys: EventTarget; fireButton: EventTarget;
  shots: ShotInput[]; cancels: number;
  input: ReturnType<typeof createAimInput>;
  pointer(type: string, x: number, y: number, pointerType?: 'mouse' | 'touch', button?: number): void;
  key(key: string, shift?: boolean): void;
}

/** Camera fake: client px == world px, canvas covers 0..765 x 0..405. */
const fakeCamera = {
  toWorld: (cx: number, cy: number) => ({ x: cx, y: cy }),
  contains: (cx: number, cy: number) => cx >= 0 && cx < 765 && cy >= 0 && cy < 405,
} as unknown as Camera;

function rig(touchFireButton = true): Rig {
  const canvas = new EventTarget();
  const keys = new EventTarget();
  const fireButton = new EventTarget();
  const r: Rig = {
    canvas, keys, fireButton, shots: [], cancels: 0,
    input: createAimInput(canvas as unknown as HTMLElement, fakeCamera, {
      touchFireButton, fireButton: fireButton as unknown as HTMLElement, keyTarget: keys,
    }),
    pointer(type, x, y, pointerType = 'mouse', button = 0) {
      const e = new Event(type, { cancelable: true });
      Object.assign(e, { clientX: x, clientY: y, button, pointerId: 1, pointerType });
      canvas.dispatchEvent(e);
    },
    key(key, shift = false) {
      const e = new Event('keydown', { cancelable: true });
      Object.assign(e, { key, shiftKey: shift });
      keys.dispatchEvent(e);
    },
  };
  r.input.onShoot((s) => r.shots.push(s));
  r.input.onCancel(() => { r.cancels++; });
  return r;
}

/** Ball at (100, 100), one hole straight north at (100, 0). */
function startTurn(r: Rig): void {
  r.input.setTargets([{ x: 100, y: 0 }]);
  r.input.setBall({ x: 100, y: 100 });
  r.input.setEnabled(true);
}

describe('createAimInput: mouse', () => {
  it('shows the aim while hovering, fires on pointerup on the canvas', () => {
    const r = rig();
    startTurn(r);
    expect(r.input.getAim()).toBeNull();
    r.pointer('pointermove', 160, 100);
    expect(r.input.getAim()!.pull).toEqual({ x: 60, y: 0 });
    r.pointer('pointerdown', 160, 100);
    r.pointer('pointerup', 160, 100);
    expect(r.shots).toEqual([{ dx: 6000, dy: 0 }]);
    r.input.destroy();
  });
  it('cancels when released off-canvas or on right-click, ignores the dead zone', () => {
    const r = rig();
    startTurn(r);
    r.pointer('pointerdown', 160, 100);
    r.pointer('pointerup', -5, 100);
    expect(r.shots).toEqual([]);
    expect(r.cancels).toBe(1);
    r.pointer('pointerdown', 160, 100);
    r.pointer('pointerdown', 160, 100, 'mouse', 2);
    expect(r.cancels).toBe(2);
    r.pointer('pointerdown', 101, 100);
    r.pointer('pointerup', 101, 100);
    expect(r.shots).toEqual([]);
    r.input.destroy();
  });
});

describe('createAimInput: touch with the Lyö button (§12.3)', () => {
  it('keeps the aim after the finger lifts (pointerleave) and fires it from the button once', () => {
    const r = rig(true);
    startTurn(r);
    r.pointer('pointerdown', 130, 100, 'touch');
    r.pointer('pointermove', 160, 100, 'touch');
    r.pointer('pointerup', 160, 100, 'touch');
    r.pointer('pointerleave', 160, 100, 'touch'); // non-hovering pointer: the browser fires out/leave after up
    expect(r.shots).toEqual([]);                  // release does not fire
    expect(r.input.getAim()).not.toBeNull();      // sticky aim
    expect(r.input.getAim()!.pull).toEqual({ x: 60, y: 0 });
    r.fireButton.dispatchEvent(new Event('click', { cancelable: true }));
    expect(r.shots).toEqual([{ dx: 6000, dy: 0 }]);
    expect(r.input.getAim()).toBeNull();          // consumed
    r.fireButton.dispatchEvent(new Event('click', { cancelable: true }));
    expect(r.shots).toHaveLength(1);              // nothing to fire any more
    r.input.destroy();
  });
  it('the sticky aim is dropped by Esc, setEnabled(false) and a new turn', () => {
    const r = rig(true);
    startTurn(r);
    const touchAim = (): void => {
      r.pointer('pointerdown', 160, 100, 'touch');
      r.pointer('pointerup', 160, 100, 'touch');
      r.pointer('pointerleave', 160, 100, 'touch');
      expect(r.input.getAim()).not.toBeNull();
    };
    touchAim();
    r.key('Escape');
    expect(r.input.getAim()).toBeNull();
    expect(r.cancels).toBe(1);
    touchAim();
    r.input.setEnabled(false);
    r.input.setEnabled(true);
    expect(r.input.getAim()).toBeNull();
    touchAim();
    r.input.setBall({ x: 100, y: 100 });
    expect(r.input.getAim()).toBeNull();
    r.input.destroy();
  });
  it('without the button setting, a touch release fires like a mouse', () => {
    const r = rig(false);
    startTurn(r);
    r.pointer('pointerdown', 160, 100, 'touch');
    r.pointer('pointerup', 160, 100, 'touch');
    expect(r.shots).toEqual([{ dx: 6000, dy: 0 }]);
    r.input.destroy();
  });
});

describe('createAimInput: keyboard', () => {
  it('Space at turn start fires the default aim (nearest hole, 50 %) without any arrow key', () => {
    const r = rig();
    startTurn(r);
    expect(r.input.getAim()).toBeNull();
    r.key(' ');
    expect(r.shots).toEqual([{ dx: 0, dy: -6000 }]); // north, 60 px = 50 % of MAX_PULL_PX
    r.input.destroy();
  });
  it('arrow keys start from the default aim and show a preview; Enter fires exactly it', () => {
    const r = rig();
    startTurn(r);
    r.key('ArrowUp');                       // 52 %
    const aim = r.input.getAim()!;
    expect(aim.pull.x).toBeCloseTo(0, 6);
    expect(aim.pull.y).toBeCloseTo(-62.4, 6);
    r.key('Enter');
    expect(r.shots).toEqual([aimToShot(aim)]);
    expect(r.shots[0]).toEqual({ dx: 0, dy: -6240 });
    r.input.destroy();
  });
  it('Esc removes the keyboard preview and resets the aim to the turn-start state', () => {
    const r = rig();
    startTurn(r);
    r.key('ArrowRight');
    r.key('ArrowRight');
    r.key('ArrowUp');
    const tuned = r.input.getAim()!;
    expect(tuned.pull.x).toBeGreaterThan(0);
    r.key('Escape');
    expect(r.cancels).toBe(1);
    expect(r.input.getAim()).toBeNull();     // preview gone
    r.key(' ');                              // not the 'cancelled' aim: the default one
    expect(r.shots).toEqual([{ dx: 0, dy: -6000 }]);
    r.key('Escape');                         // nothing to cancel
    expect(r.cancels).toBe(1);
    r.input.destroy();
  });
  it('a hovering pointer aim wins over the default keyboard shot and nothing fires while disabled', () => {
    const r = rig();
    startTurn(r);
    r.pointer('pointermove', 100, 160);
    r.key(' ');
    expect(r.shots).toEqual([{ dx: 0, dy: 6000 }]);
    r.input.setEnabled(false);
    r.key(' ');
    r.pointer('pointerdown', 160, 100);
    r.pointer('pointerup', 160, 100);
    expect(r.shots).toHaveLength(1);
    r.input.destroy();
  });
});
