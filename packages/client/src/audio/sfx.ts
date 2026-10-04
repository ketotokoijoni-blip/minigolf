// WebAudio-synthesized sound effects (DESIGN §12.6). No audio assets: every sound is an oscillator / filtered
// noise envelope built on demand. The AudioContext is created on the first user gesture (unlock()); until then
// play() is a silent no-op. Volume comes from settings (setVolume, 0..1).
import type { SimEvent } from '@puttipeli/shared/sim/types';
import { MAX_SPEED } from '@puttipeli/shared/constants';

/** Everything play() accepts: a sim event, or a named cue the controller triggers itself. 'sand' is an extra cue (not a SimEvent). */
export type SfxCue = SimEvent | 'shot' | 'applause' | 'tick' | 'sand';

export interface Sfx {
  play(event: SfxCue): void;
  setVolume(v: number): void;
  unlock(): void;
}

type OscType = 'sine' | 'square' | 'sawtooth' | 'triangle';

class WebAudioSfx implements Sfx {
  private ctx: AudioContext | null = null;
  private master: GainNode | null = null;
  private volume = 0.7;
  private noiseBuffer: AudioBuffer | null = null;
  private lastBounceAt = 0;
  private lastAnyAt = 0;
  private countThisFrame = 0;

  unlock(): void {
    if (typeof window === 'undefined') return;
    const Ctor = window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!Ctor) return;
    try {
      if (!this.ctx) {
        this.ctx = new Ctor();
        this.master = this.ctx.createGain();
        this.master.gain.value = this.volume;
        this.master.connect(this.ctx.destination);
      }
      if (this.ctx.state === 'suspended') void this.ctx.resume();
    } catch {
      this.ctx = null;
      this.master = null;
    }
  }

  setVolume(v: number): void {
    this.volume = !Number.isFinite(v) ? 0 : v < 0 ? 0 : v > 1 ? 1 : v;
    if (this.master && this.ctx) this.master.gain.setTargetAtTime(this.volume, this.ctx.currentTime, 0.01);
  }

  play(event: SfxCue): void {
    if (!this.ctx || !this.master || this.volume <= 0) return;
    if (this.ctx.state === 'suspended') { void this.ctx.resume(); return; }
    const now = this.ctx.currentTime;
    // Burst limiter: at most 6 sounds per 20 ms window (fast-forward, cascades).
    if (now - this.lastAnyAt > 0.02) { this.lastAnyAt = now; this.countThisFrame = 0; }
    if (++this.countThisFrame > 6) return;

    if (typeof event === 'string') {
      switch (event) {
        case 'shot': return this.click();
        case 'applause': return this.applause();
        case 'tick': return this.tone(1200, 1200, 0.025, 'square', 0.12);
        case 'sand': return this.noise(0.08, 0.18, 'bandpass', 1000, 0.8);
      }
      return;
    }
    switch (event.type) {
      case 'bounce': return this.bounce(event);
      case 'break': return this.crack(0.35);
      case 'destroyed': this.crack(0.6); return this.tone(140, 60, 0.18, 'triangle', 0.35);
      case 'blockMoved': return this.slide();
      case 'teleport': return this.chirp();
      case 'tar': return this.tone(110, 55, 0.14, 'sine', 0.35);
      case 'water': return this.splash();
      case 'acid': return this.fizz();
      case 'mine': return this.blast();
      case 'holed': return this.cupDrop();
      default: return; // stopped, timeout
    }
  }

  // --- building blocks -----------------------------------------------------------------------------------------

  private tone(f0: number, f1: number, dur: number, type: OscType, gain: number, delay = 0): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + delay;
    const osc = ctx.createOscillator();
    const g = ctx.createGain();
    osc.type = type;
    osc.frequency.setValueAtTime(Math.max(20, f0), t0);
    osc.frequency.exponentialRampToValueAtTime(Math.max(20, f1), t0 + dur);
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    osc.connect(g).connect(this.master!);
    osc.start(t0);
    osc.stop(t0 + dur + 0.02);
  }

  private noise(dur: number, gain: number, filter: BiquadFilterType, freq: number, q: number, delay = 0, freqEnd?: number): void {
    const ctx = this.ctx!;
    const t0 = ctx.currentTime + delay;
    const src = ctx.createBufferSource();
    src.buffer = this.getNoise();
    const bq = ctx.createBiquadFilter();
    bq.type = filter;
    bq.Q.value = q;
    bq.frequency.setValueAtTime(freq, t0);
    if (freqEnd !== undefined) bq.frequency.exponentialRampToValueAtTime(Math.max(20, freqEnd), t0 + dur);
    const g = ctx.createGain();
    g.gain.setValueAtTime(0.0001, t0);
    g.gain.linearRampToValueAtTime(gain, t0 + 0.004);
    g.gain.exponentialRampToValueAtTime(0.0001, t0 + dur);
    src.connect(bq).connect(g).connect(this.master!);
    src.start(t0, Math.random() * 0.5);
    src.stop(t0 + dur + 0.02);
  }

  private getNoise(): AudioBuffer {
    if (this.noiseBuffer) return this.noiseBuffer;
    const ctx = this.ctx!;
    const buf = ctx.createBuffer(1, ctx.sampleRate, ctx.sampleRate); // 1 s of white noise
    const d = buf.getChannelData(0);
    for (let i = 0; i < d.length; i++) d[i] = Math.random() * 2 - 1;
    this.noiseBuffer = buf;
    return buf;
  }

  // --- sounds ---------------------------------------------------------------------------------------------------

  private click(): void {
    this.noise(0.03, 0.5, 'highpass', 2500, 0.7);
    this.tone(900, 350, 0.05, 'square', 0.12);
  }

  private bounce(ev: Extract<SimEvent, { type: 'bounce' }>): void {
    const now = this.ctx!.currentTime;
    if (now - this.lastBounceAt < 0.04) return;
    this.lastBounceAt = now;
    const k = Math.min(1, Math.max(0.15, ev.speed / MAX_SPEED));
    switch (ev.material) {
      case 'bumper':
        this.tone(320, 640, 0.06, 'sine', 0.3 * k);
        this.tone(640, 300, 0.16, 'sine', 0.3 * k, 0.06);
        return;
      case 'movable':
        this.tone(150, 90, 0.08, 'triangle', 0.3 * k);
        return; // the slide itself plays on blockMoved
      case 'breakable':
        this.tone(260, 160, 0.06, 'triangle', 0.35 * k);
        this.noise(0.03, 0.25 * k, 'bandpass', 1800, 1.2);
        return;
      case 'oneway':
        this.tone(260, 200, 0.07, 'triangle', 0.3 * k);
        return;
      default: // wall, border
        this.tone(190, 120, 0.07, 'triangle', 0.4 * k);
        this.noise(0.02, 0.2 * k, 'highpass', 3000, 0.7);
        return;
    }
  }

  private crack(gain: number): void {
    this.noise(0.07, gain, 'bandpass', 3000, 0.9);
    this.tone(520, 180, 0.05, 'square', gain * 0.3);
  }

  private slide(): void {
    this.noise(0.16, 0.35, 'lowpass', 900, 0.6, 0, 300);
  }

  private chirp(): void {
    this.tone(400, 1700, 0.12, 'sine', 0.25);
    this.tone(1700, 800, 0.09, 'sine', 0.2, 0.12);
  }

  private splash(): void {
    this.noise(0.32, 0.5, 'lowpass', 2200, 0.5, 0, 250);
    this.tone(520, 180, 0.12, 'sine', 0.18);
  }

  private fizz(): void {
    this.noise(0.45, 0.4, 'highpass', 3500, 0.5, 0, 6000);
    this.tone(900, 1400, 0.3, 'sine', 0.06);
  }

  private blast(): void {
    this.noise(0.42, 0.9, 'lowpass', 900, 0.4, 0, 120);
    this.tone(160, 40, 0.32, 'sine', 0.6);
    this.noise(0.05, 0.5, 'highpass', 2000, 0.7);
  }

  private cupDrop(): void {
    this.tone(720, 240, 0.12, 'sine', 0.3);
    this.noise(0.03, 0.3, 'highpass', 2000, 0.7);
    this.tone(190, 120, 0.1, 'triangle', 0.35, 0.09);
  }

  private applause(): void {
    for (let i = 0; i < 40; i++) {
      const at = Math.random() * 1.4;
      this.noise(0.03 + Math.random() * 0.03, 0.12 + Math.random() * 0.1, 'bandpass', 1200 + Math.random() * 1500, 1.5, at);
    }
  }
}

export function createSfx(): Sfx {
  return new WebAudioSfx();
}

/** A silent Sfx (tests, harness without audio). */
export function createNullSfx(): Sfx {
  return { play() {}, setVolume() {}, unlock() {} };
}
