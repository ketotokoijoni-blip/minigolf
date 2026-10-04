// Room lifecycle (DESIGN §11.3): create / join / rejoin, code allocation, periodic sweep of empty or idle rooms,
// stats for /api/stats and closing every room on shutdown.
import type { PlayerColour, RoomSettings } from '@puttipeli/shared/game/types';
import { ErrorCode } from '@puttipeli/shared/protocol/codes';
import { isRoomCode, normalizeRoomCode } from '@puttipeli/shared/protocol/roomCode';
import type { Clock, TimerHandle } from '../clock';
import type { Config } from '../config';
import type { Logger } from '../log';
import type { ClientSession } from '../ws/connection';
import { generateRoomCode } from './codes';
import { CourseStore } from './courseStore';
import { Room } from './room';

export type RoomManagerConfig = Pick<Config, 'maxRooms' | 'roomIdleTtlMin' | 'roomEmptyTtlSec'>;

export const SWEEP_INTERVAL_MS = 30_000;
const CODE_ATTEMPTS = 50;

export interface RoomStats {
  rooms: number;
  players: number;
  spectators: number;
}

export class RoomManager {
  readonly rooms = new Map<string, Room>();
  private sweepTimer: TimerHandle | null = null;
  private stopped = false;

  constructor(
    private readonly clock: Clock,
    private readonly config: RoomManagerConfig,
    private readonly log: Logger,
    private readonly codeGen: () => string = generateRoomCode,
    /** Shared by every room: validated course resolution and the per-id decoded-layer cache. */
    readonly courseStore: CourseStore = new CourseStore(),
  ) {}

  get(code: string): Room | null {
    return this.rooms.get(code) ?? null;
  }

  roomOf(session: ClientSession): Room | null {
    return session.roomCode === null ? null : (this.rooms.get(session.roomCode) ?? null);
  }

  /** SERVER_FULL when rooms >= maxRooms (or no free code could be drawn); otherwise the new room with `session` as host. */
  create(session: ClientSession, name: string, colour: PlayerColour, settings?: Partial<RoomSettings>): Room | ErrorCode {
    if (this.stopped) return ErrorCode.SERVER_FULL;
    if (session.inRoom) return ErrorCode.ALREADY_IN_ROOM;
    if (this.rooms.size >= this.config.maxRooms) return ErrorCode.SERVER_FULL;
    const code = this.allocateCode();
    if (code === null) return ErrorCode.SERVER_FULL;

    const room = new Room(code, settings, { clock: this.clock, log: this.log, courseStore: this.courseStore, onMembersChanged: (r) => this.onMembersChanged(r) });
    this.rooms.set(code, room);
    const err = room.addPlayer(session, name, colour);
    if (err !== null) {
      this.rooms.delete(code);
      return err;
    }
    this.log.info('room created', { room: code, conn: session.id, rooms: this.rooms.size });
    return room;
  }

  /** Code is normalized first; a full lobby or a running game turns the join into a spectator join (§11.6). */
  join(session: ClientSession, code: string, name: string, colour: PlayerColour, asSpectator = false): ErrorCode | null {
    if (session.inRoom) return ErrorCode.ALREADY_IN_ROOM;
    const room = this.lookup(code);
    if (!room) return ErrorCode.ROOM_NOT_FOUND;
    const spectator = asSpectator || room.phase !== 'lobby' || !room.hasFreeSeat();
    const err = spectator ? room.addSpectator(session, name, colour) : room.addPlayer(session, name, colour);
    if (err === null) this.log.info('member joined', { room: room.code, conn: session.id, role: spectator ? 'spectator' : 'player' });
    return err;
  }

  /**
   * SESSION_EXPIRED both for an unknown/swept room and when the token matches no member: §11.3 and §11.5 specify a
   * single code on the reconnect path (the client then offers "Liity katsojana" / "Takaisin").
   */
  rejoin(session: ClientSession, code: string, token: string): ErrorCode | null {
    if (session.inRoom) return ErrorCode.ALREADY_IN_ROOM;
    const room = this.lookup(code);
    if (!room) return ErrorCode.SESSION_EXPIRED;
    return room.rejoin(session, token);
  }

  /** Socket of `session` is gone. */
  disconnect(session: ClientSession): void {
    const room = this.roomOf(session);
    if (room) room.disconnected(session);
    else session.clearRoom();
  }

  /** Removes rooms with no connection for > roomEmptyTtlSec or no activity for > roomIdleTtlMin (§11.3). */
  sweep(): void {
    const now = this.clock.now();
    const emptyTtl = this.config.roomEmptyTtlSec * 1000;
    const idleTtl = this.config.roomIdleTtlMin * 60_000;
    for (const room of [...this.rooms.values()]) {
      if (room.members.size === 0) {
        this.remove(room, 'memberless');
      } else if (room.emptySince !== null && now - room.emptySince >= emptyTtl) {
        this.remove(room, 'empty');
      } else if (now - room.lastActivity >= idleTtl) {
        this.remove(room, 'idle');
      }
    }
  }

  /** Runs sweep() every `intervalMs` on the injected clock until stop(). */
  startSweeper(intervalMs = SWEEP_INTERVAL_MS): void {
    if (this.sweepTimer !== null || this.stopped) return;
    const tick = (): void => {
      this.sweepTimer = null;
      if (this.stopped) return;
      try {
        this.sweep();
      } catch (err) {
        this.log.error('sweep failed', { err });
      }
      this.sweepTimer = this.clock.setTimeout(tick, intervalMs);
    };
    this.sweepTimer = this.clock.setTimeout(tick, intervalMs);
  }

  stats(): RoomStats {
    let players = 0;
    let spectators = 0;
    for (const room of this.rooms.values()) {
      players += room.players().length;
      spectators += room.spectators().length;
    }
    return { rooms: this.rooms.size, players, spectators };
  }

  /** Shutdown: every connected member receives roomLeft{roomClosed}; no new rooms afterwards. */
  closeAll(): void {
    this.stopped = true;
    if (this.sweepTimer !== null) {
      this.clock.clearTimeout(this.sweepTimer);
      this.sweepTimer = null;
    }
    for (const room of [...this.rooms.values()]) this.remove(room, 'shutdown');
  }

  private lookup(code: string): Room | null {
    const norm = normalizeRoomCode(code);
    if (!isRoomCode(norm)) return null;
    return this.rooms.get(norm) ?? null;
  }

  private allocateCode(): string | null {
    for (let i = 0; i < CODE_ATTEMPTS; i++) {
      const code = this.codeGen();
      if (!this.rooms.has(code)) return code;
    }
    this.log.error('could not allocate a room code', { rooms: this.rooms.size });
    return null;
  }

  private onMembersChanged(room: Room): void {
    if (room.members.size === 0 && this.rooms.get(room.code) === room) this.remove(room, 'last member left');
  }

  private remove(room: Room, why: string): void {
    this.rooms.delete(room.code);
    room.close('roomClosed');
    this.log.debug('room removed', { room: room.code, why, rooms: this.rooms.size });
  }
}
