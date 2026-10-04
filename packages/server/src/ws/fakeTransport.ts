// In-memory Transport double for unit tests (DESIGN §16.4): no sockets. Tests open FakeConnections, push raw
// frames through `receive()` and inspect `sent` / `closed`.
import type { ServerMessage } from '@puttipeli/shared/protocol/messages';
import type { Clock, TimerHandle } from '../clock';
import type { Connection, ConnectionHandler, Transport } from './transport';

export class FakeConnection implements Connection {
  readonly sent: ServerMessage[] = [];
  closed: { code: number; reason: string } | null = null;

  constructor(
    readonly id: string,
    readonly remoteAddress: string,
    private readonly transport: FakeTransport,
  ) {}

  get isOpen(): boolean {
    return this.closed === null;
  }

  send(msg: ServerMessage): void {
    if (this.closed) return;
    // Round-trip through JSON like the real transport so tests see exactly what a client would.
    this.sent.push(JSON.parse(JSON.stringify(msg)) as ServerMessage);
  }

  /** Server-side close: records the code and notifies the handler (like the socket 'close' event). */
  close(code = 1000, reason = ''): void {
    if (this.closed) return;
    this.closed = { code, reason };
    this.transport.handleClose(this);
  }

  /** Simulates a text frame arriving from the client. */
  receive(raw: string | object): void {
    if (this.closed) throw new Error(`FakeConnection ${this.id} is closed`);
    this.transport.handleMessage(this, typeof raw === 'string' ? raw : JSON.stringify(raw));
  }

  /** Simulates the client dropping the socket. */
  disconnect(): void {
    if (this.closed) return;
    this.closed = { code: 1006, reason: 'client disconnected' };
    this.transport.handleClose(this);
  }

  /** Messages of one type, typed. */
  sentOf<T extends ServerMessage['t']>(t: T): Extract<ServerMessage, { t: T }>[] {
    return this.sent.filter((m): m is Extract<ServerMessage, { t: T }> => m.t === t);
  }

  last(): ServerMessage | undefined {
    return this.sent[this.sent.length - 1];
  }

  /** Drops recorded messages (handy between test phases). */
  clearSent(): void {
    this.sent.length = 0;
  }
}

export class FakeTransport implements Transport {
  private handler: ConnectionHandler | null = null;
  private readonly open = new Set<FakeConnection>();
  private nextId = 1;
  stopped = false;

  start(handler: ConnectionHandler): void {
    this.handler = handler;
  }

  async stop(): Promise<void> {
    this.stopped = true;
    for (const c of [...this.open]) c.close(1001, 'server shutting down');
  }

  connectionCount(): number {
    return this.open.size;
  }

  /** Opens a new fake client connection and fires onOpen. */
  connect(remoteAddress = '127.0.0.1'): FakeConnection {
    if (!this.handler) throw new Error('FakeTransport.start() not called');
    const conn = new FakeConnection(`fake-${this.nextId++}`, remoteAddress, this);
    this.open.add(conn);
    this.handler.onOpen(conn);
    return conn;
  }

  /** @internal */
  handleMessage(conn: FakeConnection, raw: string): void {
    this.handler?.onMessage(conn, raw);
  }

  /** @internal */
  handleClose(conn: FakeConnection): void {
    if (!this.open.delete(conn)) return;
    this.handler?.onClose(conn);
  }
}

// ---------------------------------------------------------------------------------------------------------------
// FakeClock: deterministic Clock for unit tests (lives here because this is the server's test-double module).
// ---------------------------------------------------------------------------------------------------------------

interface FakeTimer {
  id: number;
  at: number;
  seq: number;
  fn: () => void;
}

export class FakeClock implements Clock {
  private t: number;
  private nextId = 1;
  private seq = 0;
  private readonly timers = new Map<number, FakeTimer>();

  constructor(start = 1_700_000_000_000) {
    this.t = start;
  }

  now(): number {
    return this.t;
  }

  setTimeout(fn: () => void, ms: number): TimerHandle {
    const id = this.nextId++;
    this.timers.set(id, { id, at: this.t + Math.max(0, ms), seq: this.seq++, fn });
    return id;
  }

  clearTimeout(handle: TimerHandle): void {
    this.timers.delete(handle);
  }

  pendingTimers(): number {
    return this.timers.size;
  }

  /** Advances time, firing due timers in (time, creation) order; timers scheduled meanwhile fire if due. */
  advance(ms: number): void {
    const target = this.t + ms;
    for (;;) {
      let next: FakeTimer | null = null;
      for (const tm of this.timers.values()) {
        if (tm.at <= target && (next === null || tm.at < next.at || (tm.at === next.at && tm.seq < next.seq))) next = tm;
      }
      if (!next) break;
      this.timers.delete(next.id);
      this.t = Math.max(this.t, next.at);
      next.fn();
    }
    this.t = target;
  }
}
