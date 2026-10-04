// WsClient (DESIGN §12.5, §11.5): one JSON text frame per message, typed send/on, `hello` on every open socket,
// ready after `welcome`, ping every 10 s for the clock offset (median of the last 5 samples), reconnect with
// exponential backoff 0.5 -> 1 -> 2 -> 4 -> 8 s (max 10 s, +-20 % jitter). A BAD_VERSION reply (close code 4000) is
// fatal: no reconnect, the UI shows "Päivitä sivu". Close code 4001 (the server replaced this connection because the
// same session token was resumed elsewhere) is terminal as well: reconnecting would only steal the seat back and
// start an endless rejoin ping-pong between two tabs. The socket is injectable so the client is testable in Node.
import { SIM_VERSION } from '@puttipeli/shared/constants';
import { PROTOCOL_VERSION } from '@puttipeli/shared/protocol/version';
import { ErrorCode } from '@puttipeli/shared/protocol/codes';
import type { ClientMessage, ServerMessage, ServerMessageType } from '@puttipeli/shared/protocol/messages';

export type SocketStatus = 'idle' | 'connecting' | 'open' | 'reconnecting' | 'closed';

/** Close code the server uses for a protocol/sim version mismatch (server ws/connection.ts). */
export const CLOSE_BAD_VERSION = 4000;
/** Close code the server uses when another connection resumed the same session token (server rooms/room.ts). */
export const CLOSE_REPLACED = 4001;
/** Server close codes after which WsClient never reconnects. */
export const TERMINAL_CLOSE_CODES: readonly number[] = [CLOSE_BAD_VERSION, CLOSE_REPLACED];
export const BACKOFF_BASE_MS = 500;
export const BACKOFF_MAX_MS = 10_000;
export const BACKOFF_JITTER = 0.2;
export const PING_INTERVAL_MS = 10_000;
export const OFFSET_SAMPLES = 5;

/** The subset of the WebSocket API the client uses, with plain callbacks so tests can fake it without DOM types. */
export interface WebSocketLike {
  readonly readyState: number;
  send(data: string): void;
  close(code?: number, reason?: string): void;
  onopen: (() => void) | null;
  onmessage: ((ev: { data: unknown }) => void) | null;
  onclose: ((ev: { code: number; reason: string }) => void) | null;
  onerror: (() => void) | null;
}
export type SocketFactory = (url: string) => WebSocketLike;

/** `${ws|wss}://${location.host}/ws` (Vite proxies /ws in dev); a Node fallback keeps tests and scripts working. */
export function defaultWsUrl(): string {
  if (typeof location === 'undefined' || !location.host) return 'ws://127.0.0.1:8080/ws';
  return `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`;
}

export function browserSocketFactory(url: string): WebSocketLike {
  const ws = new WebSocket(url);
  const like: WebSocketLike = {
    get readyState() { return ws.readyState; },
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    onopen: null,
    onmessage: null,
    onclose: null,
    onerror: null,
  };
  ws.onopen = () => like.onopen?.();
  ws.onmessage = (e) => like.onmessage?.({ data: e.data });
  ws.onclose = (e) => like.onclose?.({ code: e.code, reason: e.reason });
  ws.onerror = () => like.onerror?.();
  return like;
}

/** Delay before reconnect attempt `attempt` (0-based): base * 2^attempt capped at the maximum, with +-20 % jitter. */
export function backoffDelay(attempt: number, random: () => number = Math.random): number {
  const base = Math.min(BACKOFF_BASE_MS * Math.pow(2, Math.max(0, attempt)), BACKOFF_MAX_MS);
  const jitter = 1 + (random() * 2 - 1) * BACKOFF_JITTER;
  return Math.round(base * jitter);
}

export function median(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const s = values.slice().sort((a, b) => a - b);
  const mid = s.length >> 1;
  return s.length % 2 === 1 ? s[mid]! : (s[mid - 1]! + s[mid]!) / 2;
}

/** What RoomSession needs from the transport (WsClient implements it; tests use a fake). */
export interface RoomSocket {
  readonly status: SocketStatus;
  readonly isReady: boolean;
  readonly clockOffsetMs: number;
  /**
   * Close code of the server-initiated close that ended the socket for good (CLOSE_BAD_VERSION, CLOSE_REPLACED);
   * null while connected, after a client-side close() and for ordinary losses that are being retried.
   */
  readonly closeCode: number | null;
  connect(): void;
  close(): void;
  /** Sends when ready (after welcome); returns false (and drops the message) otherwise. */
  send(msg: ClientMessage): boolean;
  on<T extends ServerMessageType>(type: T, listener: (msg: Extract<ServerMessage, { t: T }>) => void): () => void;
  /** After every `welcome`; `reconnect` is true when an earlier socket of this client had been ready. */
  onReady(listener: (reconnect: boolean) => void): () => void;
  onStatus(listener: (status: SocketStatus) => void): () => void;
}

export interface WsClientOptions {
  url?: string;
  factory?: SocketFactory;
  now?: () => number;
  random?: () => number;
  clientBuild?: string;
  pingIntervalMs?: number;
}

function buildId(): string {
  return typeof __BUILD__ === 'string' ? __BUILD__ : 'dev';
}

export class WsClient implements RoomSocket {
  readonly url: string;
  private readonly factory: SocketFactory;
  private readonly now: () => number;
  private readonly random: () => number;
  private readonly clientBuild: string;
  private readonly pingIntervalMs: number;

  private socket: WebSocketLike | null = null;
  private _status: SocketStatus = 'idle';
  private ready = false;
  private everReady = false;
  private stopped = false;
  private fatal = false;
  private attempt = 0;
  private _closeCode: number | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private samples: number[] = [];
  private _offset = 0;

  private readonly typeListeners = new Map<string, Set<(msg: ServerMessage) => void>>();
  private readonly messageListeners = new Set<(msg: ServerMessage) => void>();
  private readonly readyListeners = new Set<(reconnect: boolean) => void>();
  private readonly statusListeners = new Set<(status: SocketStatus) => void>();

  constructor(opts: WsClientOptions = {}) {
    this.url = opts.url ?? defaultWsUrl();
    this.factory = opts.factory ?? browserSocketFactory;
    this.now = opts.now ?? (() => Date.now());
    this.random = opts.random ?? Math.random;
    this.clientBuild = opts.clientBuild ?? buildId();
    this.pingIntervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;
  }

  get status(): SocketStatus { return this._status; }
  get isReady(): boolean { return this.ready; }
  /** serverTime - localTime, median of the last OFFSET_SAMPLES pong samples (0 until the first pong). */
  get clockOffsetMs(): number { return this._offset; }
  get closeCode(): number | null { return this._closeCode; }
  /** Number of reconnect attempts since the last successful welcome. */
  get reconnectAttempt(): number { return this.attempt; }
  serverNow(): number { return this.now() + this._offset; }

  /** Opens the socket (idempotent while a socket exists). After close() it starts over with a fresh backoff. */
  connect(): void {
    if (this.socket) return;
    this.stopped = false;
    this.fatal = false;
    this._closeCode = null;
    this.clearReconnectTimer();
    if (this._status === 'idle' || this._status === 'closed') this.setStatus('connecting');
    this.openSocket();
  }

  /** Stops reconnecting and closes the socket. Listeners stay registered (connect() may be called again). */
  close(): void {
    this.stopped = true;
    this.clearReconnectTimer();
    this.stopPings();
    const ws = this.socket;
    this.socket = null;
    this.ready = false;
    if (ws) {
      ws.onopen = null; ws.onmessage = null; ws.onclose = null; ws.onerror = null;
      try { ws.close(1000, 'client closed'); } catch { /* already closed */ }
    }
    this.setStatus('closed');
  }

  send(msg: ClientMessage): boolean {
    if (!this.ready || !this.socket) return false;
    return this.sendRaw(msg);
  }

  on<T extends ServerMessageType>(type: T, listener: (msg: Extract<ServerMessage, { t: T }>) => void): () => void {
    let set = this.typeListeners.get(type);
    if (!set) { set = new Set(); this.typeListeners.set(type, set); }
    const l = listener as (msg: ServerMessage) => void;
    set.add(l);
    return () => { set.delete(l); };
  }

  /** Every parsed server message (debugging, logging). */
  onMessage(listener: (msg: ServerMessage) => void): () => void {
    this.messageListeners.add(listener);
    return () => { this.messageListeners.delete(listener); };
  }

  onReady(listener: (reconnect: boolean) => void): () => void {
    this.readyListeners.add(listener);
    return () => { this.readyListeners.delete(listener); };
  }

  onStatus(listener: (status: SocketStatus) => void): () => void {
    this.statusListeners.add(listener);
    return () => { this.statusListeners.delete(listener); };
  }

  // ------------------------------------------------------------------------------------------------ internals

  private openSocket(): void {
    let ws: WebSocketLike;
    try {
      ws = this.factory(this.url);
    } catch (err) {
      console.error('WebSocket construction failed', err);
      this.scheduleReconnect();
      return;
    }
    this.socket = ws;
    ws.onopen = () => {
      if (this.socket !== ws) return;
      this.sendRaw({ t: 'hello', protocolVersion: PROTOCOL_VERSION, simVersion: SIM_VERSION, clientBuild: this.clientBuild });
    };
    ws.onmessage = (ev) => {
      if (this.socket !== ws) return;
      this.handleMessage(ev.data);
    };
    ws.onclose = (ev) => {
      if (this.socket !== ws) return;
      this.handleClose(ev.code);
    };
    ws.onerror = () => { /* the close event that follows drives the reconnect */ };
  }

  private sendRaw(msg: ClientMessage): boolean {
    const ws = this.socket;
    if (!ws) return false;
    try {
      ws.send(JSON.stringify(msg));
      return true;
    } catch (err) {
      console.warn('WebSocket send failed', err);
      return false;
    }
  }

  private handleMessage(data: unknown): void {
    if (typeof data !== 'string') return;
    let msg: ServerMessage;
    try {
      const parsed: unknown = JSON.parse(data);
      if (!parsed || typeof parsed !== 'object' || typeof (parsed as { t?: unknown }).t !== 'string') return;
      msg = parsed as ServerMessage;
    } catch {
      console.warn('Ignoring malformed server frame');
      return;
    }
    if (msg.t === 'welcome') {
      const reconnect = this.everReady;
      this.ready = true;
      this.everReady = true;
      this.attempt = 0;
      this.setStatus('open');
      this.startPings();
      this.dispatch(msg);
      for (const l of [...this.readyListeners]) l(reconnect);
      return;
    }
    if (msg.t === 'pong') this.addSample(msg.t0, msg.serverTimeMs);
    if (msg.t === 'error' && msg.code === ErrorCode.BAD_VERSION) this.fatal = true;
    this.dispatch(msg);
  }

  private dispatch(msg: ServerMessage): void {
    const set = this.typeListeners.get(msg.t);
    if (set) for (const l of [...set]) this.safeCall(l, msg);
    for (const l of [...this.messageListeners]) this.safeCall(l, msg);
  }

  private safeCall(l: (msg: ServerMessage) => void, msg: ServerMessage): void {
    try { l(msg); } catch (err) { console.error(`listener for ${msg.t} failed`, err); }
  }

  private handleClose(code: number): void {
    this.socket = null;
    this.ready = false;
    this.stopPings();
    if (this.stopped) { this.setStatus('closed'); return; }
    if (TERMINAL_CLOSE_CODES.includes(code) || this.fatal) {
      this.stopped = true;
      this._closeCode = code;
      this.setStatus('closed');
      return;
    }
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped) return;
    this.setStatus('reconnecting');
    const delay = backoffDelay(this.attempt++, this.random);
    this.clearReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      if (!this.stopped && !this.socket) this.openSocket();
    }, delay);
  }

  private clearReconnectTimer(): void {
    if (this.reconnectTimer !== null) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
  }

  private startPings(): void {
    this.stopPings();
    this.ping();
    this.pingTimer = setInterval(() => this.ping(), this.pingIntervalMs);
  }

  private stopPings(): void {
    if (this.pingTimer !== null) { clearInterval(this.pingTimer); this.pingTimer = null; }
  }

  private ping(): void {
    if (!this.ready) return;
    this.sendRaw({ t: 'ping', t0: this.now() });
  }

  private addSample(t0: number, serverTimeMs: number): void {
    if (!Number.isFinite(t0) || !Number.isFinite(serverTimeMs)) return;
    const now = this.now();
    const rtt = Math.max(0, now - t0);
    this.samples.push(serverTimeMs - (t0 + rtt / 2));
    if (this.samples.length > OFFSET_SAMPLES) this.samples.splice(0, this.samples.length - OFFSET_SAMPLES);
    this._offset = median(this.samples);
  }

  private setStatus(s: SocketStatus): void {
    if (this._status === s) return;
    this._status = s;
    for (const l of [...this.statusListeners]) {
      try { l(s); } catch (err) { console.error('status listener failed', err); }
    }
  }
}
