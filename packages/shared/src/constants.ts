// Single source of every tunable. Numeric values change only in the lead's tuning pass:
// bump SIM_VERSION and regenerate golden fixtures (npm run test:golden-update).
// Sim code reads the "Shot", "Collision", "Surfaces" and "Objects" groups through sim/tuning.ts (simTuning.X),
// never directly, so the #/dev panel can override them locally. Everything else is imported directly.
export const SIM_VERSION = 1;

// Grid
export const COURSE_W = 49;
export const COURSE_H = 25;
export const TILE = 15;                      // px
export const FIELD_W = COURSE_W * TILE;      // 735
export const FIELD_H = COURSE_H * TILE;      // 375
export const TILE_COUNT = COURSE_W * COURSE_H; // 1225

// Ball and time
export const BALL_RADIUS = 6;                // px
export const TICK_HZ = 120;
export const DT = 1 / TICK_HZ;
export const SUBSTEPS = 3;                   // fixed; MAX_SPEED / (TICK_HZ * SUBSTEPS) = 2.5 px per substep
export const SUB_DT = DT / SUBSTEPS;
export const MAX_SHOT_TICKS = TICK_HZ * 30;  // 30 s safety cap -> result 'timeout'

// Shot
export const MAX_PULL_PX = 120;              // aim distance cap
export const MIN_PULL_PX = 3;                // dead zone
export const SHOT_QUANTUM = 100;             // ShotInput units per px (integers)
export const POWER_SCALE = 5.5;              // launch speed px/s per px of pull -> max 660 px/s
export const MAX_SPEED = 900;                // hard clamp after bumpers/magnets/slopes
export const STOP_SPEED = 5;                 // px/s; below this (and not under a slope/magnet force) the ball rests
export const FORCED_STOP_TICKS = 60;         // 0.5 s below STOP_SPEED while a slope or magnet force acts (wedged) -> rests

// Collision
export const RESOLVE_ITERATIONS = 4;
export const PENETRATION_SLOP = 0.01;        // px pushed beyond contact
export const RESTITUTION_WALL = 0.78;        // full, triangles, one-way, magnet blocks, border
export const RESTITUTION_BREAKABLE = 0.65;
export const RESTITUTION_MOVABLE = 0.35;
export const RESTITUTION_BUMPER = 1.4;
export const BUMPER_MIN_EXIT_SPEED = 220;    // px/s
export const BOUNCE_EVENT_MIN_SPEED = 40;    // normal speed below which no 'bounce' event is emitted
export const BREAK_MIN_IMPACT_SPEED = 120;   // px/s normal speed needed to count a hit
export const BREAK_DEBOUNCE_TICKS = 12;      // 0.1 s: repeated hits on the same tile are one hit
export const MOVABLE_MIN_IMPACT_SPEED = 60;

// Surfaces: constant deceleration opposing velocity, px/s^2
export const FRICTION_GRASS = 200;
export const FRICTION_SAND = 1100;
export const FRICTION_ICE = 30;
export const FRICTION_SLOPE = 160;           // slopes: friction 160 + SLOPE_ACCEL 260 => never rests unless wedged
export const SLOPE_ACCEL = 260;              // px/s^2 along the slope direction (downhill)

// Objects
export const HOLE_RADIUS = 7.5;              // drawn cup radius
export const HOLE_PULL_RADIUS = 10;          // funnel pull radius
export const HOLE_PULL_ACCEL = 500;          // px/s^2 toward the cup centre
export const HOLE_PULL_MAX_SPEED = 400;      // no pull above this speed
export const HOLE_CAPTURE_RADIUS = 5.5;
export const HOLE_CAPTURE_MAX_SPEED = 220;
export const TELEPORT_TRIGGER_RADIUS = 5;
export const TELEPORT_EXIT_OFFSET = 2;       // px along the velocity direction at the exit pad
export const MAX_TELEPORTS_PER_SHOT = 40;    // anti-loop: afterwards pads are ignored for the rest of the shot
export const MINE_TRIGGER_RADIUS = 7;
export const MAGNET_DEFAULT_STRENGTH = 350;  // px/s^2 at the centre, linear falloff to 0 at radius
export const MAGNET_DEFAULT_RADIUS = 90;     // px
export const MAGNET_MIN_STRENGTH = 50;
export const MAGNET_MAX_STRENGTH = 500;   // R12: above ~600 the forced-stop rule can never trigger at contact distance
export const MAGNET_MIN_RADIUS = 30;
export const MAGNET_MAX_RADIUS = 240;
export const MAGNET_DEAD_ZONE = 3;           // px: no force closer than this to the centre

// Course rules
export const DEFAULT_MAX_STROKES = 20;
export const DEFAULT_PAR = 3;
export const MIN_MAX_STROKES = 1;
export const MAX_MAX_STROKES = 50;
export const MIN_PAR = 1;
export const MAX_PAR = 20;
export const MAX_COURSES_PER_SET = 18;
export const MAX_COURSE_NAME_CHARS = 40;
export const MAX_AUTHOR_CHARS = 40;
export const MAX_DESCRIPTION_CHARS = 200;

// Multiplayer timing
export const DEFAULT_TURN_TIMEOUT_SEC = 45;  // host options: 0 (none), 30, 45, 60
export const AFK_TURN_TIMEOUT_SEC = 5;
export const DISCONNECTED_TURN_WAIT_SEC = 10;
export const DISCONNECT_GRACE_SEC = 60;
export const LOBBY_DISCONNECT_REMOVE_SEC = 10;
export const COUNTDOWN_SEC = 3;
export const HOLE_SUMMARY_SEC = 6;           // multiplayer default; allowed 0 (wait for everyone) | 3 | 6 | 10
export const ROUND_SUMMARY_AUTO_LOBBY_SEC = 120; // multiplayer: roundSummary returns to the lobby after this even if nobody clicks
export const HOLE_INTRO_MS = 1000;           // client-side title card; the authority waits this long before the first turnStarted
export const ANIMATION_GRACE_MS = 250;       // added to ticks/TICK_HZ before the next turnStarted
export const MAX_PLAYERS = 4;
export const MAX_SPECTATORS = 8;
export const MAX_NAME_CHARS = 16;
export const DEFAULT_PLAYER_NAME = 'Pelaaja';
