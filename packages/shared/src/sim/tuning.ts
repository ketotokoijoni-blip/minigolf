// The one mutable object in @puttipeli/shared (DESIGN §5.7, D14). The sim reads every numeric tunable of the "Shot",
// "Collision", "Surfaces" and "Objects" groups of constants.ts as simTuning.NAME (same names) so the single-player
// developer panel (#/dev) can tweak them live. Grid, time, course-rule and multiplayer constants are not tunable.
// Rules: the server never imports setSimTuning; the client calls it only from #/dev and calls resetSimTuning() when
// leaving that screen and before any multiplayer session starts; tests call resetSimTuning() in beforeEach/afterEach.
import * as C from '../constants';

export const SIM_TUNING_KEYS = ['MAX_PULL_PX','MIN_PULL_PX','POWER_SCALE','MAX_SPEED','STOP_SPEED','FORCED_STOP_TICKS',
  'RESOLVE_ITERATIONS','PENETRATION_SLOP','RESTITUTION_WALL','RESTITUTION_BREAKABLE','RESTITUTION_MOVABLE','RESTITUTION_BUMPER',
  'BUMPER_MIN_EXIT_SPEED','BOUNCE_EVENT_MIN_SPEED','BREAK_MIN_IMPACT_SPEED','BREAK_DEBOUNCE_TICKS','MOVABLE_MIN_IMPACT_SPEED',
  'FRICTION_GRASS','FRICTION_SAND','FRICTION_ICE','FRICTION_SLOPE','SLOPE_ACCEL',
  'HOLE_RADIUS','HOLE_PULL_RADIUS','HOLE_PULL_ACCEL','HOLE_PULL_MAX_SPEED','HOLE_CAPTURE_RADIUS','HOLE_CAPTURE_MAX_SPEED',
  'TELEPORT_TRIGGER_RADIUS','TELEPORT_EXIT_OFFSET','MAX_TELEPORTS_PER_SHOT','MINE_TRIGGER_RADIUS',
  'MAGNET_DEFAULT_STRENGTH','MAGNET_DEFAULT_RADIUS','MAGNET_MIN_STRENGTH','MAGNET_MAX_STRENGTH','MAGNET_MIN_RADIUS','MAGNET_MAX_RADIUS','MAGNET_DEAD_ZONE'] as const;
export type SimTuningKey = (typeof SIM_TUNING_KEYS)[number];
export type SimTuning = { [K in SimTuningKey]: number };

function snapshotDefaults(): SimTuning {
  const t = {} as SimTuning;
  for (const k of SIM_TUNING_KEYS) t[k] = C[k];
  return t;
}

/** Copied from constants.ts, frozen. */
export const SIM_TUNING_DEFAULTS: Readonly<SimTuning> = Object.freeze(snapshotDefaults());
/** Live values read by the sim. Mutated only through setSimTuning / resetSimTuning. */
export const simTuning: SimTuning = snapshotDefaults();

/** Dev screen only. Ignores unknown keys and non-finite (or non-number) values. */
export function setSimTuning(partial: Partial<SimTuning>): void {
  for (const k of SIM_TUNING_KEYS) {
    const v = partial[k];
    if (typeof v === 'number' && Number.isFinite(v)) simTuning[k] = v;
  }
}

export function resetSimTuning(): void {
  for (const k of SIM_TUNING_KEYS) simTuning[k] = SIM_TUNING_DEFAULTS[k];
}

export function isSimTuningDefault(): boolean {
  for (const k of SIM_TUNING_KEYS) if (simTuning[k] !== SIM_TUNING_DEFAULTS[k]) return false;
  return true;
}
