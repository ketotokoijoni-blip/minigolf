import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { SIM_VERSION } from '@puttipeli/shared/constants';
import { PROTOCOL_VERSION } from '@puttipeli/shared/protocol/version';
import type { ClientMessage, ServerMessage } from '@puttipeli/shared/protocol/messages';
import { WsClient, backoffDelay, median, CLOSE_BAD_VERSION, CLOSE_REPLACED, PING_INTERVAL_MS, type WebSocketLike, type SocketStatus } from './socket';

class FakeSocket implements WebSocketLike {
  readyState = 0;
  sent: ClientMessage[] = [];
  closedWith: { code?: number; reason?: string } | null = null;
  onopen: (() => void) | null = null;
  onmessage: ((ev: { data: unknown }) => void) | null = null;
  onclose: ((ev: { code: number; reason: string }) => void) | null = null;
  onerror: (() => void) | null = null;
  constructor(readonly url: string) {}
  send(data: string): void { this.sent.push(JSON.parse(data) as ClientMessage); }
  close(code?: number, reason?: string): void { this.closedWith = { code, reason }; this.readyState = 3; }
  // test helpers
  open(): void { this.readyState = 1; this.onopen?.(); }
  receive(msg: ServerMessage): void { this.onmessage?.({ data: JSON.stringify(msg) }); }
  receiveRaw(data: unknown): void { this.onmessage?.({ data }); }
  drop(code = 1006): void { this.readyState = 3; this.onclose?.({ code, reason: '' }); }
  welcome(serverTimeMs = 1_000_000): void { this.receive({ t: 'welcome', protocolVersion: PROTOCOL_VERSION, simVersion: SIM_VERSION, serverTimeMs, build: 'srv' }); }
}

function setup(opts: { random?: () => number; now?: () => number } = {}) {
  const sockets: FakeSocket[] = [];
  const client = new WsClient({
    url: 'ws://test/ws',
    factory: (url) => { const s = new FakeSocket(url); sockets.push(s); return s; },
    random: opts.random ?? (() => 0.5), // 0.5 -> jitter factor exactly 1
    now: opts.now,
    clientBuild: 'test-build',
  });
  const statuses: SocketStatus[] = [];
  client.onStatus((s) => statuses.push(s));
  return { client, sockets, statuses, last: () => sockets[sockets.length - 1]! };
}

beforeEach(() => { vi.useFakeTimers(); });
afterEach(() => { vi.useRealTimers(); });

describe('helpers', () => {
  it('backoff doubles from 500 ms, caps at 10 s and jitters +-20 %', () => {
    const noJitter = (): number => 0.5;
    expect([0, 1, 2, 3, 4, 5, 6].map((a) => backoffDelay(a, noJitter))).toEqual([500, 1000, 2000, 4000, 8000, 10000, 10000]);
    expect(backoffDelay(0, () => 0)).toBe(400);
    expect(backoffDelay(0, () => 1)).toBe(600);
    expect(backoffDelay(9, () => 1)).toBe(12000);
  });

  it('median', () => {
    expect(median([])).toBe(0);
    expect(median([3])).toBe(3);
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});

describe('WsClient', () => {
  it('sends hello on open, becomes ready on welcome and pings immediately', () => {
    const { client, last, statuses } = setup({ now: () => 5000 });
    const ready: boolean[] = [];
    client.onReady((r) => ready.push(r));
    expect(client.status).toBe('idle');
    client.connect();
    expect(client.status).toBe('connecting');
    const ws = last();
    expect(ws.url).toBe('ws://test/ws');
    ws.open();
    expect(ws.sent).toEqual([{ t: 'hello', protocolVersion: PROTOCOL_VERSION, simVersion: SIM_VERSION, clientBuild: 'test-build' }]);
    expect(client.send({ t: 'requestSnapshot' })).toBe(false); // not ready yet
    ws.welcome();
    expect(client.isReady).toBe(true);
    expect(client.status).toBe('open');
    expect(ready).toEqual([false]);
    expect(ws.sent[1]).toEqual({ t: 'ping', t0: 5000 });
    expect(client.send({ t: 'requestSnapshot' })).toBe(true);
    expect(ws.sent[2]).toEqual({ t: 'requestSnapshot' });
    expect(statuses).toEqual(['connecting', 'open']);
    client.connect(); // idempotent
    expect(statuses).toEqual(['connecting', 'open']);
  });

  it('dispatches typed messages and unsubscribes; ignores malformed frames', () => {
    const { client, last } = setup();
    client.connect();
    const ws = last();
    ws.open();
    ws.welcome();
    const chats: string[] = [];
    const off = client.on('chat', (m) => chats.push(m.text ?? ''));
    const all: string[] = [];
    client.onMessage((m) => all.push(m.t));
    ws.receive({ t: 'chat', from: null, key: 'chat.gameStarted', text: 'x', atMs: 1 });
    ws.receiveRaw('not json');
    ws.receiveRaw(JSON.stringify({ nope: 1 }));
    ws.receiveRaw(new ArrayBuffer(4));
    ws.receive({ t: 'roomLeft', reason: 'left' });
    off();
    ws.receive({ t: 'chat', from: null, text: 'y', atMs: 2 });
    expect(chats).toEqual(['x']);
    expect(all).toEqual(['chat', 'roomLeft', 'chat']);
  });

  it('measures the clock offset as the median of the last five pong samples', () => {
    let now = 10_000;
    const { client, last } = setup({ now: () => now });
    client.connect();
    const ws = last();
    ws.open();
    ws.welcome();
    expect(client.clockOffsetMs).toBe(0);
    const pong = (t0: number, rtt: number, offset: number): void => {
      now = t0 + rtt;
      ws.receive({ t: 'pong', t0, serverTimeMs: t0 + rtt / 2 + offset });
    };
    pong(10_000, 100, 2000);
    expect(client.clockOffsetMs).toBe(2000);
    pong(10_100, 50, 2010);
    pong(10_200, 40, 1990);
    pong(10_300, 1000, 9000); // outlier
    pong(10_400, 60, 2005);
    expect(client.clockOffsetMs).toBe(2005);
    pong(10_500, 60, 1995); // the first sample (2000) drops out: [2010, 1990, 9000, 2005, 1995]
    expect(client.clockOffsetMs).toBe(2005);
    expect(client.serverNow()).toBe(now + 2005);
    // periodic ping
    const before = ws.sent.length;
    vi.advanceTimersByTime(PING_INTERVAL_MS);
    expect(ws.sent.length).toBe(before + 1);
    expect(ws.sent[ws.sent.length - 1]).toMatchObject({ t: 'ping' });
  });

  it('reconnects with backoff after a lost connection and reports reconnect=true on the next welcome', () => {
    const { client, sockets, last, statuses } = setup();
    const ready: boolean[] = [];
    client.onReady((r) => ready.push(r));
    client.connect();
    last().open();
    last().welcome();
    last().drop();
    expect(client.status).toBe('reconnecting');
    expect(client.isReady).toBe(false);
    expect(client.send({ t: 'requestSnapshot' })).toBe(false);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(499);
    expect(sockets).toHaveLength(1);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(2);
    last().drop(); // connection refused -> 1000 ms
    vi.advanceTimersByTime(999);
    expect(sockets).toHaveLength(2);
    vi.advanceTimersByTime(1);
    expect(sockets).toHaveLength(3);
    last().drop(); // -> 2000 ms
    vi.advanceTimersByTime(2000);
    expect(sockets).toHaveLength(4);
    last().open();
    expect(last().sent[0]).toMatchObject({ t: 'hello' });
    last().welcome();
    expect(ready).toEqual([false, true]);
    expect(client.status).toBe('open');
    expect(client.reconnectAttempt).toBe(0);
    // after a successful welcome the backoff starts over
    last().drop();
    vi.advanceTimersByTime(500);
    expect(sockets).toHaveLength(5);
    expect(statuses).toEqual(['connecting', 'open', 'reconnecting', 'open', 'reconnecting']);
  });

  it('caps the backoff at 10 s', () => {
    const { client, sockets, last } = setup();
    client.connect();
    for (const delay of [500, 1000, 2000, 4000, 8000, 10000, 10000]) {
      const n = sockets.length;
      last().drop();
      vi.advanceTimersByTime(delay - 1);
      expect(sockets.length).toBe(n);
      vi.advanceTimersByTime(1);
      expect(sockets.length).toBe(n + 1);
    }
  });

  it('treats BAD_VERSION (close 4000) as fatal: no reconnect', () => {
    const { client, sockets, last, statuses } = setup();
    const errors: string[] = [];
    client.on('error', (m) => errors.push(m.code));
    client.connect();
    last().open();
    last().receive({ t: 'error', code: 'BAD_VERSION', message: 'mismatch' });
    last().drop(CLOSE_BAD_VERSION);
    expect(errors).toEqual(['BAD_VERSION']);
    expect(client.status).toBe('closed');
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(statuses).toEqual(['connecting', 'closed']);
    expect(client.closeCode).toBe(CLOSE_BAD_VERSION);
  });

  it('treats "replaced" (close 4001) as terminal: no reconnect, closeCode exposed, connect() starts fresh', () => {
    const { client, sockets, last, statuses } = setup();
    client.connect();
    last().open();
    last().welcome();
    expect(client.closeCode).toBeNull();
    last().drop(CLOSE_REPLACED);
    expect(client.status).toBe('closed');
    expect(client.isReady).toBe(false);
    expect(client.closeCode).toBe(CLOSE_REPLACED);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    expect(statuses).toEqual(['connecting', 'open', 'closed']);
    // an explicit connect() afterwards is allowed and clears the terminal code
    client.connect();
    expect(sockets).toHaveLength(2);
    expect(client.closeCode).toBeNull();
  });

  it('an ordinary loss leaves closeCode null and a client close() does not set it', () => {
    const { client, last } = setup();
    client.connect();
    last().open();
    last().welcome();
    last().drop(1006);
    expect(client.status).toBe('reconnecting');
    expect(client.closeCode).toBeNull();
    client.close();
    expect(client.status).toBe('closed');
    expect(client.closeCode).toBeNull();
  });

  it('close() stops reconnecting and closes the socket; connect() afterwards starts fresh', () => {
    const { client, sockets, last } = setup();
    client.connect();
    last().open();
    last().welcome();
    const ws = last();
    client.close();
    expect(ws.closedWith?.code).toBe(1000);
    expect(client.status).toBe('closed');
    expect(client.isReady).toBe(false);
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
    // a close event from the old socket after close() is ignored
    ws.onclose?.({ code: 1006, reason: '' });
    expect(sockets).toHaveLength(1);
    client.connect();
    expect(sockets).toHaveLength(2);
    expect(client.status).toBe('connecting');
  });

  it('close() while reconnecting cancels the pending attempt', () => {
    const { client, sockets, last } = setup();
    client.connect();
    last().drop();
    client.close();
    vi.advanceTimersByTime(60_000);
    expect(sockets).toHaveLength(1);
  });

  it('a throwing listener does not break dispatch', () => {
    const { client, last } = setup();
    const spy = vi.spyOn(console, 'error').mockImplementation(() => {});
    client.connect();
    last().open();
    last().welcome();
    const seen: string[] = [];
    client.on('chat', () => { throw new Error('boom'); });
    client.on('chat', () => seen.push('ok'));
    last().receive({ t: 'chat', from: null, text: 'x', atMs: 1 });
    expect(seen).toEqual(['ok']);
    expect(spy).toHaveBeenCalled();
    spy.mockRestore();
  });
});
