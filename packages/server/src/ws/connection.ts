// Per-connection client session (DESIGN §11.2): typed send, hello/version handshake, token-bucket rate limit with
// strikes, chat throttle and message parsing (shared parseClientMessage). The Gateway routes whatever `receive()` returns.
import { SIM_VERSION } from '@puttipeli/shared/constants';
import type { ValidationIssue } from '@puttipeli/shared/course/types';
import { ErrorCode } from '@puttipeli/shared/protocol/codes';
import { CHAT_MSGS_PER_10S, RATE_BURST, RATE_MSGS_PER_SEC } from '@puttipeli/shared/protocol/limits';
import type { ClientMessage, ServerMessage } from '@puttipeli/shared/protocol/messages';
import { parseClientMessage } from '@puttipeli/shared/protocol/validate';
import { PROTOCOL_VERSION } from '@puttipeli/shared/protocol/version';
import type { Logger } from '../log';
import type { Connection } from './transport';

export const STRIKES_TO_CLOSE = 3;
/** Close code for a protocol/sim version mismatch (client shows "Päivitä sivu", D10). */
export const CLOSE_BAD_VERSION = 4000;
/** Close code for a connection that was replaced by a successful `rejoin` from another socket. */
export const CLOSE_REPLACED = 4001;
export const CLOSE_POLICY = 1008;

export type MemberRole = 'player' | 'spectator';

/** Classic token bucket: `capacity` tokens, `refillPerSec` added continuously. */
export class TokenBucket {
  private tokens: number;
  private last: number;

  constructor(
    private readonly capacity: number,
    private readonly refillPerSec: number,
    now: number,
  ) {
    this.tokens = capacity;
    this.last = now;
  }

  tryTake(now: number, cost = 1): boolean {
    const dt = Math.max(0, now - this.last) / 1000;
    this.last = now;
    this.tokens = Math.min(this.capacity, this.tokens + dt * this.refillPerSec);
    if (this.tokens < cost) return false;
    this.tokens -= cost;
    return true;
  }

  available(): number {
    return this.tokens;
  }
}

export interface ClientSessionDeps {
  now(): number;
  build: string;
  log: Logger;
  /** Message parser; defaults to the shared parseClientMessage (protocol/validate.ts, WP-C). */
  parse?: (raw: string) => ClientMessage | null;
}

export class ClientSession {
  helloDone = false;
  playerId: string | null = null;
  roomCode: string | null = null;
  role: MemberRole | null = null;
  readonly bucket: TokenBucket;
  private rateStrikes = 0;
  private invalidStrikes = 0;
  private chatTimes: number[] = [];
  private readonly parse: (raw: string) => ClientMessage | null;

  constructor(
    readonly conn: Connection,
    private readonly deps: ClientSessionDeps,
  ) {
    this.bucket = new TokenBucket(RATE_BURST, RATE_MSGS_PER_SEC, deps.now());
    this.parse = deps.parse ?? parseClientMessage;
  }

  get id(): string {
    return this.conn.id;
  }

  get inRoom(): boolean {
    return this.roomCode !== null;
  }

  send(msg: ServerMessage): void {
    this.conn.send(msg);
  }

  error(code: ErrorCode, message: string, issues?: ValidationIssue[]): void {
    this.send(issues ? { t: 'error', code, message, issues } : { t: 'error', code, message });
  }

  close(code: number, reason: string): void {
    this.conn.close(code, reason);
  }

  /** Forgets room membership (after leave / room closed / replaced). */
  clearRoom(): void {
    this.playerId = null;
    this.roomCode = null;
    this.role = null;
  }

  /**
   * Processes one raw text frame. Applies the rate limit, parses, performs the hello handshake and returns the
   * message the Gateway should route, or null when the frame was consumed (welcome sent) or rejected.
   */
  receive(raw: string): ClientMessage | null {
    if (!this.conn.isOpen) return null;
    const now = this.deps.now();

    if (!this.bucket.tryTake(now)) {
      this.rateStrikes++;
      this.deps.log.debug('rate limited', { conn: this.id, strikes: this.rateStrikes });
      this.error(ErrorCode.RATE_LIMITED, 'Too many messages');
      if (this.rateStrikes >= STRIKES_TO_CLOSE) this.close(CLOSE_POLICY, 'rate limit exceeded');
      return null;
    }

    const msg = this.parse(raw);
    if (msg === null) {
      this.invalidStrikes++;
      this.deps.log.debug('invalid message', { conn: this.id, strikes: this.invalidStrikes, bytes: raw.length });
      this.error(ErrorCode.INVALID_MESSAGE, 'Malformed message');
      if (this.invalidStrikes >= STRIKES_TO_CLOSE) this.close(CLOSE_POLICY, 'too many invalid messages');
      return null;
    }

    if (!this.helloDone) {
      if (msg.t !== 'hello') {
        this.error(ErrorCode.INVALID_MESSAGE, 'First message must be hello');
        this.close(CLOSE_POLICY, 'hello expected');
        return null;
      }
      if (msg.protocolVersion !== PROTOCOL_VERSION || msg.simVersion !== SIM_VERSION) {
        this.deps.log.info('version mismatch', { conn: this.id, protocol: msg.protocolVersion, sim: msg.simVersion, clientBuild: msg.clientBuild });
        this.error(ErrorCode.BAD_VERSION, `Server protocol ${PROTOCOL_VERSION} / sim ${SIM_VERSION}, client protocol ${msg.protocolVersion} / sim ${msg.simVersion}`);
        this.close(CLOSE_BAD_VERSION, 'version mismatch');
        return null;
      }
      this.helloDone = true;
      this.send({ t: 'welcome', protocolVersion: PROTOCOL_VERSION, simVersion: SIM_VERSION, serverTimeMs: now, build: this.deps.build });
      return null;
    }

    if (msg.t === 'hello') {
      this.invalidStrikes++;
      this.error(ErrorCode.INVALID_MESSAGE, 'hello already sent');
      if (this.invalidStrikes >= STRIKES_TO_CLOSE) this.close(CLOSE_POLICY, 'too many invalid messages');
      return null;
    }
    return msg;
  }

  /** Chat throttle: at most CHAT_MSGS_PER_10S within any 10 s window. Over the limit the line is dropped. */
  acceptChat(): boolean {
    const now = this.deps.now();
    this.chatTimes = this.chatTimes.filter((t) => now - t < 10_000);
    if (this.chatTimes.length >= CHAT_MSGS_PER_10S) {
      this.error(ErrorCode.RATE_LIMITED, 'Chat too fast');
      return false;
    }
    this.chatTimes.push(now);
    return true;
  }
}
