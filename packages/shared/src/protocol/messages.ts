// 'Course' is part of the printed contract import (DESIGN §6.4) but unused in this file (full Course data travels inside
// GameStateJson and GameEvent); the line is kept verbatim, so the unused specifier is silenced instead of removed.
// eslint-disable-next-line @typescript-eslint/no-unused-vars
import type { Course, CourseRef, ValidationIssue } from '../course/types';
import type { ShotInput } from '../sim/types';
import type { GameEvent } from '../game/events';
import type { GameStateJson, PlayerColour, RoomSettings } from '../game/types';
import type { ErrorCode } from './codes';

export type ClientMessage =
  | { t: 'hello'; protocolVersion: number; simVersion: number; clientBuild: string }  // first message on every socket
  | { t: 'createRoom'; name: string; colour: PlayerColour; settings?: Partial<RoomSettings> }
  | { t: 'joinRoom'; code: string; name: string; colour: PlayerColour; asSpectator?: boolean } // asSpectator: join as a spectator even if a seat is free
  | { t: 'rejoin'; code: string; sessionToken: string }
  | { t: 'leaveRoom' }
  | { t: 'setProfile'; name?: string; colour?: PlayerColour }        // lobby only
  | { t: 'setReady'; ready: boolean }                                 // lobby only
  | { t: 'chat'; text: string }
  | { t: 'setCourses'; courses: CourseRef[] }                         // host, lobby only, 1..18 (0 or >18 entries fail parseClientMessage -> INVALID_MESSAGE)
  | { t: 'setSettings'; settings: Partial<RoomSettings> }             // host, lobby only
  | { t: 'startGame' }                                                // host, lobby only
  | { t: 'backToLobby' }                                              // host, roundSummary only
  | { t: 'shoot'; holeIndex: number; turnSeq: number; shot: ShotInput }
  | { t: 'summaryReady' }                                             // holeSummary / roundSummary
  | { t: 'becomePlayer' }                                             // spectator -> player (lobby, free seat)
  | { t: 'requestSnapshot' }
  | { t: 'ping'; t0: number };

export interface ChatFrom { id: string; name: string; colour: PlayerColour }

export type ServerMessage =
  | { t: 'welcome'; protocolVersion: number; simVersion: number; serverTimeMs: number; build: string }
  | { t: 'error'; code: ErrorCode; message: string; issues?: ValidationIssue[] }
  | { t: 'roomJoined'; code: string; playerId: string; sessionToken: string; role: 'player' | 'spectator'; state: GameStateJson; serverTimeMs: number }
  | { t: 'roomState'; state: GameStateJson; serverTimeMs: number }   // full snapshot: on requestSnapshot, after rejoin, after desync
  | { t: 'event'; ev: GameEvent }
  | { t: 'chat'; from: ChatFrom | null; text?: string; key?: string; params?: Record<string, string | number>; atMs: number } // from null = system line {key, params}
  | { t: 'roomLeft'; reason: 'left' | 'removed' | 'roomClosed' | 'sessionExpired' }
  | { t: 'pong'; t0: number; serverTimeMs: number };

export type ClientMessageType = ClientMessage['t'];
export type ServerMessageType = ServerMessage['t'];
