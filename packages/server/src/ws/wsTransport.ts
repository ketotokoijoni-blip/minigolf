// Real `ws` adapter implementing the Transport contract (DESIGN §11.2): upgrade on path /ws only, Origin check
// (403), connection cap (503), maxPayload = MAX_MESSAGE_BYTES (ws closes oversize frames with 1009), binary frames
// closed with 1003, heartbeat ping every HEARTBEAT_INTERVAL_MS with termination after 2 missed pongs.
import { randomUUID } from 'node:crypto';
import type { IncomingMessage, Server } from 'node:http';
import type { Duplex } from 'node:stream';
import { WebSocket, WebSocketServer } from 'ws';
import type { ServerMessage } from '@puttipeli/shared/protocol/messages';
import { HEARTBEAT_INTERVAL_MS, MAX_MESSAGE_BYTES } from '@puttipeli/shared/protocol/limits';
import type { Logger } from '../log';
import type { Connection, ConnectionHandler, Transport } from './transport';

export interface WsTransportOptions {
  server: Server;
  log: Logger;
  /** Allowed Origin header values (scheme://host[:port], no trailing slash); null = allow any. */
  allowedOrigins: string[] | null;
  maxConnections: number;
  path?: string;                 // default '/ws'
  maxPayload?: number;           // default MAX_MESSAGE_BYTES
  heartbeatIntervalMs?: number;  // default HEARTBEAT_INTERVAL_MS
  trustProxy?: boolean;          // remoteAddress from X-Forwarded-For (logging only)
}

export const MISSED_PONGS_TO_TERMINATE = 2;

export function isOriginAllowed(origin: string | undefined, allowed: string[] | null): boolean {
  if (allowed === null) return true;
  if (!origin) return false; // production with PUBLIC_ORIGIN set: a browser always sends Origin
  const o = origin.trim().replace(/\/+$/, '');
  return allowed.some((a) => a.toLowerCase() === o.toLowerCase());
}

export function clientAddress(req: IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? 'unknown';
}

class WsConnection implements Connection {
  readonly id = randomUUID();
  missedPongs = 0;

  constructor(
    readonly socket: WebSocket,
    readonly remoteAddress: string,
    private readonly log: Logger,
  ) {}

  get isOpen(): boolean {
    return this.socket.readyState === WebSocket.OPEN;
  }

  send(msg: ServerMessage): void {
    if (!this.isOpen) return;
    try {
      this.socket.send(JSON.stringify(msg));
    } catch (err) {
      this.log.warn('ws send failed', { conn: this.id, err });
    }
  }

  close(code = 1000, reason = ''): void {
    if (this.socket.readyState === WebSocket.CLOSED || this.socket.readyState === WebSocket.CLOSING) return;
    try {
      this.socket.close(code, reason);
    } catch (err) {
      this.log.warn('ws close failed', { conn: this.id, err });
      this.socket.terminate();
    }
  }
}

function rejectUpgrade(socket: Duplex, status: number, text: string): void {
  if (socket.destroyed) return;
  socket.write(`HTTP/1.1 ${status} ${text}\r\nConnection: close\r\nContent-Type: text/plain\r\nContent-Length: ${Buffer.byteLength(text)}\r\n\r\n${text}`);
  socket.destroy();
}

export class WsTransport implements Transport {
  private readonly wss: WebSocketServer;
  private readonly conns = new Set<WsConnection>();
  private handler: ConnectionHandler | null = null;
  private heartbeat: ReturnType<typeof setInterval> | null = null;
  private accepting = false;
  private readonly path: string;
  private readonly heartbeatIntervalMs: number;
  private readonly onUpgrade = (req: IncomingMessage, socket: Duplex, head: Buffer): void => this.handleUpgrade(req, socket, head);

  constructor(private readonly opts: WsTransportOptions) {
    this.path = opts.path ?? '/ws';
    this.heartbeatIntervalMs = opts.heartbeatIntervalMs ?? HEARTBEAT_INTERVAL_MS;
    this.wss = new WebSocketServer({ noServer: true, maxPayload: opts.maxPayload ?? MAX_MESSAGE_BYTES });
  }

  start(handler: ConnectionHandler): void {
    if (this.handler) throw new Error('WsTransport already started');
    this.handler = handler;
    this.accepting = true;
    this.opts.server.on('upgrade', this.onUpgrade);
    this.heartbeat = setInterval(() => this.pingAll(), this.heartbeatIntervalMs);
    this.heartbeat.unref?.();
  }

  /** Stops accepting upgrades and closes every connection with 1001 (going away). */
  async stop(): Promise<void> {
    this.accepting = false;
    this.opts.server.off('upgrade', this.onUpgrade);
    if (this.heartbeat) {
      clearInterval(this.heartbeat);
      this.heartbeat = null;
    }
    const pending = [...this.conns].map(
      (c) =>
        new Promise<void>((done) => {
          if (c.socket.readyState === WebSocket.CLOSED) return done();
          const timer = setTimeout(() => {
            c.socket.terminate();
            done();
          }, 1000);
          c.socket.once('close', () => {
            clearTimeout(timer);
            done();
          });
          c.close(1001, 'server shutting down');
        }),
    );
    await Promise.all(pending);
    await new Promise<void>((done) => this.wss.close(() => done()));
  }

  connectionCount(): number {
    return this.conns.size;
  }

  private handleUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): void {
    const url = new URL(req.url ?? '/', 'http://localhost');
    if (url.pathname !== this.path) {
      rejectUpgrade(socket, 404, 'Not Found');
      return;
    }
    if (!this.accepting) {
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    if (!isOriginAllowed(req.headers.origin, this.opts.allowedOrigins)) {
      this.opts.log.warn('ws upgrade rejected: origin', { origin: req.headers.origin ?? null, from: clientAddress(req, this.opts.trustProxy ?? false) });
      rejectUpgrade(socket, 403, 'Forbidden');
      return;
    }
    if (this.conns.size >= this.opts.maxConnections) {
      this.opts.log.warn('ws upgrade rejected: connection cap', { count: this.conns.size });
      rejectUpgrade(socket, 503, 'Service Unavailable');
      return;
    }
    this.wss.handleUpgrade(req, socket, head, (ws) => this.accept(ws, req));
  }

  private accept(ws: WebSocket, req: IncomingMessage): void {
    const handler = this.handler;
    if (!handler) {
      ws.close(1011, 'not started');
      return;
    }
    const conn = new WsConnection(ws, clientAddress(req, this.opts.trustProxy ?? false), this.opts.log);
    this.conns.add(conn);
    this.opts.log.debug('ws open', { conn: conn.id, from: conn.remoteAddress, count: this.conns.size });

    ws.on('pong', () => {
      conn.missedPongs = 0;
    });
    ws.on('message', (data, isBinary) => {
      if (isBinary) {
        this.opts.log.debug('ws binary frame rejected', { conn: conn.id });
        conn.close(1003, 'text frames only');
        return;
      }
      let text: string;
      if (typeof data === 'string') text = data;
      else if (Array.isArray(data)) text = Buffer.concat(data).toString('utf8');
      else if (Buffer.isBuffer(data)) text = data.toString('utf8');
      else text = Buffer.from(data as ArrayBuffer).toString('utf8');
      try {
        handler.onMessage(conn, text);
      } catch (err) {
        this.opts.log.error('handler.onMessage threw', { conn: conn.id, err });
        conn.close(1011, 'internal error');
      }
    });
    ws.on('error', (err) => {
      this.opts.log.debug('ws socket error', { conn: conn.id, err });
    });
    ws.on('close', (code) => {
      if (!this.conns.delete(conn)) return;
      this.opts.log.debug('ws close', { conn: conn.id, code, count: this.conns.size });
      try {
        handler.onClose(conn);
      } catch (err) {
        this.opts.log.error('handler.onClose threw', { conn: conn.id, err });
      }
    });

    try {
      handler.onOpen(conn);
    } catch (err) {
      this.opts.log.error('handler.onOpen threw', { conn: conn.id, err });
      conn.close(1011, 'internal error');
    }
  }

  private pingAll(): void {
    for (const conn of this.conns) {
      if (conn.socket.readyState !== WebSocket.OPEN) continue;
      if (conn.missedPongs >= MISSED_PONGS_TO_TERMINATE) {
        this.opts.log.info('ws heartbeat timeout', { conn: conn.id, from: conn.remoteAddress });
        conn.socket.terminate(); // 'close' fires and removes it
        continue;
      }
      conn.missedPongs++;
      try {
        conn.socket.ping();
      } catch {
        conn.socket.terminate();
      }
    }
  }
}
