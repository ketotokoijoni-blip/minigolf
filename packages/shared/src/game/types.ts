import type { Course, Vec2 } from '../course/types';
import type { BallState, ShotInput, WorldState } from '../sim/types';

export type PlayerColour = 0 | 1 | 2 | 3;
export type Phase = 'lobby' | 'countdown' | 'hole' | 'holeSummary' | 'roundSummary';

export interface PlayerState {
  id: string;
  name: string;
  colour: PlayerColour;
  ready: boolean;
  connected: boolean;
  afk: boolean;
  consecutiveTimeouts: number;
  joinedSeq: number;      // seat order = ascending joinedSeq, frozen into `seatOrder` at gameStarted
  leftRound: boolean;     // left or removed during a round; scorecard row stays, no more turns
}

export interface SpectatorState { id: string; name: string }

export interface RoomSettings {
  maxPlayers: 2 | 3 | 4;              // never below the current number of players (normalizeSettings clamps)
  turnTimeoutSec: 0 | 30 | 45 | 60;   // 0 = no limit
  holeSummarySec: 0 | 3 | 6 | 10;     // 0 = wait until every connected active player is ready; default HOLE_SUMMARY_SEC
  ballCollision: false;               // reserved, always false in v1 (shown greyed in the lobby)
}

export interface TurnState {
  playerId: string;
  turnSeq: number;             // increments on every turnStarted within a round; shoot must echo it
  deadlineMs: number | null;   // authority clock (server time); null = no limit
  shotInFlight: boolean;       // true between shotTaken and the next turnStarted/holeEnded
}

export interface LastShot { playerId: string; turnSeq: number; shot: ShotInput; ticks: number; atMs: number }

export interface RankingEntry { playerId: string; total: number; rank: number } // ties share rank, players with leftRound last

export interface GameState {
  phase: Phase;
  settings: RoomSettings;
  hostId: string | null;
  players: PlayerState[];               // sorted by joinedSeq
  spectators: SpectatorState[];
  courses: Course[];                    // 1..18, full data (custom courses included)
  seatOrder: string[];                  // frozen at gameStarted; [] in lobby
  holeIndex: number;                    // -1 in lobby/countdown
  order: string[];                      // turn order for the current hole (rotated seatOrder)
  balls: Record<string, BallState>;
  shotOrigins: Record<string, Vec2>;    // position at the start of each player's last shot
  strokes: Record<string, number[]>;    // playerId -> strokes per hole index; -1 = not played
  holeDone: Record<string, boolean>;
  world: WorldState | null;             // shared per hole: destroyed blocks are destroyed for everyone
  turn: TurnState | null;
  lastShot: LastShot | null;
  summaryReady: Record<string, boolean>;
  ranking: RankingEntry[] | null;       // set by roundEnded
  countdownEndsAtMs: number | null;
  seq: number;                          // number of events applied (debugging, ordering checks)
}

/** JSON-safe form (typed arrays -> number[]). game/serialize.ts converts both ways. */
export interface WorldJson { walls: number[]; breakHits: number[]; minesArmed: number[] }
export type GameStateJson = Omit<GameState, 'world'> & { world: WorldJson | null };
