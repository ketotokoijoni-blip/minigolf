import type { GameState, PlayerColour } from '@puttipeli/shared/game/types';
import type { GameEvent } from '@puttipeli/shared/game/events';
import type { ShotInput } from '@puttipeli/shared/sim/types';

export interface ChatMessage {
  seq: number;
  from: { id: string; name: string; colour: PlayerColour } | null; // null = system line
  text?: string;
  key?: string;                                 // i18n key for system lines, e.g. 'chat.playerJoined'
  params?: Record<string, string | number>;
  atMs: number;
}
export interface ChatApi {
  messages(): readonly ChatMessage[];
  send(text: string): void;
  subscribe(listener: (messages: readonly ChatMessage[]) => void): () => void;
}

/** Called after every applied event with the new state, the event, and the previous state (null for the initial call). */
export type HostListener = (state: GameState, event: GameEvent | null, prev: GameState | null) => void;

/** Implemented by game/localHost.ts (single player, test play) and net/roomClient.ts (multiplayer). */
export interface GameHost {
  readonly kind: 'local' | 'remote';
  readonly localPlayerId: string;      // '' for a spectator
  readonly isSpectator: boolean;
  readonly chat: ChatApi | null;       // null in single player
  getState(): GameState;
  subscribe(listener: HostListener): () => void; // calls listener(state, null, null) immediately
  shoot(shot: ShotInput): void;        // no-op unless phase 'hole', it is my turn and no shot is in flight
  summaryReady(): void;
  backToLobby(): void;                 // roundSummary, host only (remote sends {t:'backToLobby'}; local calls Authority.backToLobby(localPlayerId))
  restart(): void;                     // local only ("Pelaa uudelleen": backToLobby + start on the same courses); no-op for remote
  requestSnapshot(): void;             // no-op for local
  nowAuthorityMs(): number;            // Date.now() + measured offset (0 for local); compare with deadlineMs
  onError(listener: (code: string, message: string) => void): () => void;
  leave(): void;                       // single player: abort round; multiplayer: leaveRoom
  destroy(): void;                     // release sockets/timers/listeners
}
