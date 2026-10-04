import type { Course } from '@puttipeli/shared/course/types';
import type { PlayerColour } from '@puttipeli/shared/game/types';
import type { GameHost } from '../game/gameHost';

export interface PendingLocalGame {
  courses: Course[];       // 1..18, play order
  playerName: string;
  colour: PlayerColour;
  returnTo: string;        // hash to navigate to after the round / on leave, e.g. '#/' or '#/editor'
  testPlay: boolean;       // editor test play: HUD shows "Testaus", no scorecard persistence
}
let host: GameHost | null = null;
let pending: PendingLocalGame | null = null;
export function setActiveHost(h: GameHost | null): void { if (host && host !== h) host.destroy(); host = h; }
export function getActiveHost(): GameHost | null { return host; }
export function setPendingLocalGame(req: PendingLocalGame | null): void { pending = req; }
export function takePendingLocalGame(): PendingLocalGame | null { const p = pending; pending = null; return p; }
