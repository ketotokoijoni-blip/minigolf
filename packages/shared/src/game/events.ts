import type { Course } from '../course/types';
import type { ShotInput, ShotSummary } from '../sim/types';
import type { PlayerColour, PlayerState, RankingEntry, RoomSettings, SpectatorState } from './types';

/**
 * Emitted only by an authority (server Room or client localHost), applied by everyone with applyEvent().
 * The reducer derives all consequences (strokes, holeDone, phase) itself; events carry decisions and
 * timing, never redundant derived state — except `shotTaken.outcome`, which is the simulation result.
 */
export type GameEvent =
  | { type: 'playerJoined'; player: PlayerState }
  | { type: 'playerLeft'; playerId: string }
  | { type: 'spectatorJoined'; spectator: SpectatorState }
  | { type: 'spectatorLeft'; id: string }
  | { type: 'playerConnection'; playerId: string; connected: boolean }
  | { type: 'playerAfk'; playerId: string; afk: boolean }
  | { type: 'hostChanged'; hostId: string }
  | { type: 'profileChanged'; playerId: string; name: string; colour: PlayerColour }
  | { type: 'readyChanged'; playerId: string; ready: boolean }
  | { type: 'settingsChanged'; settings: RoomSettings }
  | { type: 'coursesChanged'; courses: Course[] }
  | { type: 'countdownStarted'; endsAtMs: number }
  | { type: 'gameStarted'; seatOrder: string[] }
  | { type: 'holeStarted'; holeIndex: number; order: string[] }
  | { type: 'turnStarted'; playerId: string; turnSeq: number; deadlineMs: number | null }
  | { type: 'shotTaken'; playerId: string; turnSeq: number; shot: ShotInput; outcome: ShotSummary; atMs: number }
  | { type: 'turnTimedOut'; playerId: string; turnSeq: number }   // +1 stroke, ball does not move
  | { type: 'turnSkipped'; playerId: string; turnSeq: number }    // disconnected player, no stroke
  | { type: 'holeEnded'; holeIndex: number }
  | { type: 'summaryReady'; playerId: string }
  | { type: 'roundEnded'; ranking: RankingEntry[] }
  | { type: 'backToLobby' };
export type GameEventType = GameEvent['type'];
