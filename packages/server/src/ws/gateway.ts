// Gateway (DESIGN §11.2): owns one ClientSession per Connection and routes parsed messages — createRoom / joinRoom /
// rejoin to the RoomManager, ping to pong, everything else to the session's Room (or error NOT_IN_ROOM).
import { ErrorCode } from '@puttipeli/shared/protocol/codes';
import type { ClientMessage } from '@puttipeli/shared/protocol/messages';
import type { Clock } from '../clock';
import type { Logger } from '../log';
import type { RoomManager } from '../rooms/roomManager';
import { errorMessage } from '../rooms/session';
import { ClientSession } from './connection';
import type { Connection, ConnectionHandler } from './transport';

export interface GatewayDeps {
  rooms: RoomManager;
  clock: Clock;
  log: Logger;
  build: string;
  /** Optional parser override (tests, or the shared parseClientMessage once WP-C lands). */
  parse?: (raw: string) => ClientMessage | null;
}

export class Gateway implements ConnectionHandler {
  readonly sessions = new Map<string, ClientSession>();

  constructor(private readonly deps: GatewayDeps) {}

  onOpen(conn: Connection): void {
    const session = new ClientSession(conn, { now: () => this.deps.clock.now(), build: this.deps.build, log: this.deps.log, parse: this.deps.parse });
    this.sessions.set(conn.id, session);
    this.deps.log.debug('session open', { conn: conn.id, from: conn.remoteAddress, sessions: this.sessions.size });
  }

  onMessage(conn: Connection, raw: string): void {
    const session = this.sessions.get(conn.id);
    if (!session) {
      conn.close(1011, 'unknown connection');
      return;
    }
    const msg = session.receive(raw);
    if (msg === null) return;
    this.route(session, msg);
  }

  onClose(conn: Connection): void {
    const session = this.sessions.get(conn.id);
    if (!session) return;
    this.sessions.delete(conn.id);
    this.deps.rooms.disconnect(session);
    this.deps.log.debug('session closed', { conn: conn.id, sessions: this.sessions.size });
  }

  sessionOf(conn: Connection): ClientSession | undefined {
    return this.sessions.get(conn.id);
  }

  private route(session: ClientSession, msg: ClientMessage): void {
    const rooms = this.deps.rooms;
    switch (msg.t) {
      case 'ping':
        session.send({ t: 'pong', t0: msg.t0, serverTimeMs: this.deps.clock.now() });
        return;
      case 'createRoom': {
        const res = rooms.create(session, msg.name, msg.colour, msg.settings);
        if (typeof res === 'string') session.error(res, describe(res));
        return;
      }
      case 'joinRoom': {
        const err = rooms.join(session, msg.code, msg.name, msg.colour, msg.asSpectator ?? false);
        if (err !== null) session.error(err, describe(err));
        return;
      }
      case 'rejoin': {
        const err = rooms.rejoin(session, msg.code, msg.sessionToken);
        if (err !== null) session.error(err, describe(err));
        return;
      }
      case 'hello': // consumed by ClientSession.receive; unreachable
        return;
      default: {
        const room = rooms.roomOf(session);
        if (!room) {
          session.error(ErrorCode.NOT_IN_ROOM, 'Join or create a room first');
          return;
        }
        room.handle(session, msg);
      }
    }
  }
}

/** English developer strings for error replies (clients localize by code, §6.4). Shared table in rooms/session.ts. */
export function describe(code: ErrorCode): string {
  return errorMessage(code);
}
