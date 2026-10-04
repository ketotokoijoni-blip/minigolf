// Real `ws` sockets on port 0: origin check, path, connection cap, binary rejection, heartbeat and shutdown.
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { WebSocket } from 'ws';
import { nullLogger } from '../log';
import type { Connection, ConnectionHandler } from './transport';
import { WsTransport, clientAddress, isOriginAllowed } from './wsTransport';

interface Rig {
  server: Server;
  transport: WsTransport;
  url: string;
  opened: Connection[];
  closed: Connection[];
  messages: { conn: Connection; raw: string }[];
}

const rigs: Rig[] = [];

async function rig(opts: { allowedOrigins?: string[] | null; maxConnections?: number; heartbeatIntervalMs?: number; trustProxy?: boolean } = {}): Promise<Rig> {
  const server = createServer((_req, res) => {
    res.writeHead(200);
    res.end('http');
  });
  const r: Rig = { server, transport: null as unknown as WsTransport, url: '', opened: [], closed: [], messages: [] };
  const handler: ConnectionHandler = {
    onOpen: (c) => r.opened.push(c),
    onMessage: (c, raw) => {
      r.messages.push({ conn: c, raw });
      c.send({ t: 'pong', t0: Number(raw) || 0, serverTimeMs: 1 });
    },
    onClose: (c) => r.closed.push(c),
  };
  r.transport = new WsTransport({
    server,
    log: nullLogger,
    allowedOrigins: opts.allowedOrigins ?? null,
    maxConnections: opts.maxConnections ?? 10,
    heartbeatIntervalMs: opts.heartbeatIntervalMs ?? 60_000,
    trustProxy: opts.trustProxy ?? false,
  });
  r.transport.start(handler);
  await new Promise<void>((done) => server.listen(0, '127.0.0.1', () => done()));
  r.url = `ws://127.0.0.1:${(server.address() as AddressInfo).port}`;
  rigs.push(r);
  return r;
}

afterEach(async () => {
  for (const r of rigs.splice(0)) {
    await r.transport.stop();
    await new Promise((done) => r.server.close(done));
  }
});

function connect(url: string, opts: { origin?: string; autoPong?: boolean } = {}): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: opts.origin, autoPong: opts.autoPong ?? true });
    ws.once('open', () => resolve(ws));
    ws.once('error', reject);
  });
}

function expectUpgradeError(url: string, opts: { origin?: string } = {}): Promise<number> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(url, { origin: opts.origin });
    ws.once('unexpected-response', (_req, res) => {
      resolve(res.statusCode ?? 0);
      ws.terminate();
    });
    ws.once('open', () => reject(new Error('unexpected open')));
    ws.once('error', () => {}); // follows unexpected-response
  });
}

function closeCode(ws: WebSocket): Promise<number> {
  return new Promise((resolve) => ws.once('close', (code) => resolve(code)));
}

function nextMessage(ws: WebSocket): Promise<string> {
  return new Promise((resolve) => ws.once('message', (d) => resolve(d.toString())));
}

const tick = (ms = 30) => new Promise((r) => setTimeout(r, ms));

describe('WsTransport', () => {
  it('accepts /ws, delivers text frames and typed replies, reports open/close', async () => {
    const r = await rig();
    const ws = await connect(`${r.url}/ws`);
    await tick();
    expect(r.opened).toHaveLength(1);
    expect(r.transport.connectionCount()).toBe(1);
    expect(r.opened[0]?.remoteAddress).toBe('127.0.0.1');
    expect(r.opened[0]?.isOpen).toBe(true);
    const reply = nextMessage(ws);
    ws.send('42');
    expect(JSON.parse(await reply)).toEqual({ t: 'pong', t0: 42, serverTimeMs: 1 });
    expect(r.messages[0]?.raw).toBe('42');
    ws.close(1000);
    await tick();
    expect(r.closed).toHaveLength(1);
    expect(r.transport.connectionCount()).toBe(0);
    expect(r.opened[0]?.isOpen).toBe(false);
  });

  it('rejects other upgrade paths with 404 while plain HTTP still works', async () => {
    const r = await rig();
    expect(await expectUpgradeError(`${r.url}/other`)).toBe(404);
    const res = await fetch(`${r.url.replace('ws://', 'http://')}/anything`);
    expect(await res.text()).toBe('http');
  });

  it('rejects a disallowed or missing Origin with 403 when PUBLIC_ORIGIN is set', async () => {
    const r = await rig({ allowedOrigins: ['https://peli.example'] });
    expect(await expectUpgradeError(`${r.url}/ws`, { origin: 'https://evil.example' })).toBe(403);
    expect(await expectUpgradeError(`${r.url}/ws`)).toBe(403);
    const ok = await connect(`${r.url}/ws`, { origin: 'https://peli.example' });
    ok.close();
    const ok2 = await connect(`${r.url}/ws`, { origin: 'HTTPS://Peli.example/' });
    ok2.close();
  });

  it('rejects with 503 at the connection cap', async () => {
    const r = await rig({ maxConnections: 2 });
    const a = await connect(`${r.url}/ws`);
    const b = await connect(`${r.url}/ws`);
    expect(await expectUpgradeError(`${r.url}/ws`)).toBe(503);
    a.close();
    await tick();
    const c = await connect(`${r.url}/ws`); // a slot is free again
    b.close();
    c.close();
  });

  it('closes binary senders with 1003', async () => {
    const r = await rig();
    const ws = await connect(`${r.url}/ws`);
    const code = closeCode(ws);
    ws.send(Buffer.from([1, 2, 3]));
    expect(await code).toBe(1003);
    await tick();
    expect(r.messages).toHaveLength(0);
    expect(r.closed).toHaveLength(1);
  });

  it('terminates a client that misses two pongs; a responsive client stays', async () => {
    const r = await rig({ heartbeatIntervalMs: 40 });
    const silent = await connect(`${r.url}/ws`, { autoPong: false });
    const chatty = await connect(`${r.url}/ws`, { autoPong: true });
    const code = closeCode(silent);
    expect(await code).toBe(1006); // terminated without a close frame
    expect(chatty.readyState).toBe(WebSocket.OPEN);
    await tick(100);
    expect(chatty.readyState).toBe(WebSocket.OPEN);
    chatty.close();
  });

  it('stop() closes every connection with 1001 and refuses new upgrades', async () => {
    const r = await rig();
    const ws = await connect(`${r.url}/ws`);
    const code = closeCode(ws);
    await r.transport.stop();
    expect(await code).toBe(1001);
    expect(r.transport.connectionCount()).toBe(0);
    await expect(connect(`${r.url}/ws`)).rejects.toBeTruthy();
  });
});

describe('helpers', () => {
  it('isOriginAllowed', () => {
    expect(isOriginAllowed(undefined, null)).toBe(true);
    expect(isOriginAllowed('http://x', null)).toBe(true);
    expect(isOriginAllowed(undefined, ['http://x'])).toBe(false);
    expect(isOriginAllowed('http://x/', ['http://x'])).toBe(true);
    expect(isOriginAllowed('http://y', ['http://x'])).toBe(false);
  });
  it('clientAddress honours X-Forwarded-For only with trustProxy', () => {
    const req = { headers: { 'x-forwarded-for': '203.0.113.9, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.1' } } as unknown as Parameters<typeof clientAddress>[0];
    expect(clientAddress(req, false)).toBe('10.0.0.1');
    expect(clientAddress(req, true)).toBe('203.0.113.9');
  });
});
