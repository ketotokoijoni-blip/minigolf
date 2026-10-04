// End-to-end server integration (WP-K; DESIGN §15 WP-K, §16.4): the REAL server pieces wired exactly like index.ts
// (config -> RoomManager -> Gateway -> http server -> WsTransport) listening on port 0, three real `ws` clients that
// play one full hole of b_01 with scripted shots. Every client keeps its own GameState with applyEvent, re-simulates
// every shotTaken from its previous state and compares checksums (§9.6), and at the end requests a snapshot
// (roomState) that must equal gameStateToJson of its own state. Also /healthz, the SPA static fallback and the
// Origin rejection with PUBLIC_ORIGIN set.
//
// index.ts has a side-effecting main (it reads process.env, listens and installs signal handlers), so the pieces are
// assembled here in the same order with the same constructors; nothing is mocked.
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WebSocket } from 'ws';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { SIM_VERSION, TICK_HZ } from '@puttipeli/shared/constants';
import { findBuiltin } from '@puttipeli/shared/course/builtin';
import { decodeLayers } from '@puttipeli/shared/course/parse';
import type { Course, CourseLayers } from '@puttipeli/shared/course/types';
import type { GameEvent } from '@puttipeli/shared/game/events';
import { applyEvent } from '@puttipeli/shared/game/reducer';
import { currentCourse, otherBallCentres } from '@puttipeli/shared/game/selectors';
import { gameStateFromJson, gameStateToJson } from '@puttipeli/shared/game/serialize';
import type { GameState, GameStateJson, PlayerColour } from '@puttipeli/shared/game/types';
import type { ClientMessage, ServerMessage } from '@puttipeli/shared/protocol/messages';
import { PROTOCOL_VERSION } from '@puttipeli/shared/protocol/version';
import { hashSimState } from '@puttipeli/shared/sim/checksum';
import { validateShot } from '@puttipeli/shared/sim/shot';
import { simulateShot } from '@puttipeli/shared/sim/simulate';
import type { ShotInput } from '@puttipeli/shared/sim/types';
import { systemClock } from './clock';
import { loadConfig, type Config } from './config';
import { createHttpServer } from './http';
import { nullLogger } from './log';
import { RoomManager } from './rooms/roomManager';
import { Gateway } from './ws/gateway';
import { WsTransport } from './ws/wsTransport';

// ---------------------------------------------------------------------------------------------------------------------
// Server assembly (mirrors index.ts)

interface RunningServer {
  config: Config;
  server: Server;
  rooms: RoomManager;
  transport: WsTransport;
  port: number;
  httpBase: string;
  wsUrl: string;
  stop(): Promise<void>;
}

async function startServer(env: Record<string, string>): Promise<RunningServer> {
  const config = loadConfig({ PORT: '0', HOST: '127.0.0.1', LOG_LEVEL: 'error', ...env });
  const log = nullLogger;
  const rooms = new RoomManager(systemClock, config, log);
  const gateway = new Gateway({ rooms, clock: systemClock, log, build: config.buildId });
  const server = createHttpServer({ publicDir: config.publicDir, stats: () => rooms.stats(), build: config.buildId, log, startedAt: Date.now() });
  const transport = new WsTransport({ server, log, allowedOrigins: config.allowedOrigins, maxConnections: config.maxConnections, trustProxy: config.trustProxy });
  transport.start(gateway);
  rooms.startSweeper();
  await new Promise<void>((done, fail) => {
    server.once('error', fail);
    server.listen(config.port, config.host, () => done());
  });
  const port = (server.address() as AddressInfo).port;
  return {
    config,
    server,
    rooms,
    transport,
    port,
    httpBase: `http://127.0.0.1:${port}`,
    wsUrl: `ws://127.0.0.1:${port}/ws`,
    async stop() {
      server.close();
      rooms.closeAll();
      await transport.stop();
      await new Promise<void>((done) => server.closeAllConnections?.() ?? done());
    },
  };
}

// ---------------------------------------------------------------------------------------------------------------------
// Test client: a real `ws` socket plus the shared reducer, exactly what the browser client does with the game state

const SCRIPT_TIMEOUT_MS = 15_000;

class TestClient {
  readonly name: string;
  readonly colour: PlayerColour;
  readonly inbox: ServerMessage[] = [];
  readonly events: GameEvent[] = [];
  readonly replayChecks: { playerId: string; turnSeq: number; ok: boolean; expected: number; actual: number }[] = [];
  readonly errors: Extract<ServerMessage, { t: 'error' }>[] = [];
  state: GameState | null = null;
  playerId = '';
  sessionToken = '';
  roomCode = '';
  closeCode: number | null = null;
  /** Shots to play, consumed on every turnStarted addressed to this player. */
  script: ShotInput[] = [];
  shotsSent: ShotInput[] = [];
  private socket: WebSocket | null = null;
  private waiters: { pred: (m: ServerMessage) => boolean; resolve: (m: ServerMessage) => void; reject: (e: Error) => void; timer: NodeJS.Timeout }[] = [];
  private readonly layersCache = new Map<string, CourseLayers>();
  private autoplay = false;

  constructor(name: string, colour: PlayerColour) {
    this.name = name;
    this.colour = colour;
  }

  async connect(url: string, headers?: Record<string, string>): Promise<void> {
    const ws = new WebSocket(url, headers ? { headers } : undefined);
    this.socket = ws;
    ws.on('message', (data) => this.onRaw(typeof data === 'string' ? data : data.toString()));
    ws.on('close', (code) => {
      this.closeCode = code;
    });
    await new Promise<void>((done, fail) => {
      ws.once('open', () => done());
      ws.once('error', (err) => fail(err));
    });
  }

  send(msg: ClientMessage): void {
    if (!this.socket) throw new Error(`${this.name}: not connected`);
    this.socket.send(JSON.stringify(msg));
  }

  /** hello/welcome handshake (D10). */
  async hello(): Promise<void> {
    this.send({ t: 'hello', protocolVersion: PROTOCOL_VERSION, simVersion: SIM_VERSION, clientBuild: 'integration-test' });
    await this.waitFor((m) => m.t === 'welcome');
  }

  /** Resolves with the first message (already received or future) that satisfies `pred`. */
  waitFor<T extends ServerMessage>(pred: (m: ServerMessage) => m is T, timeoutMs?: number): Promise<T>;
  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs?: number): Promise<ServerMessage>;
  waitFor(pred: (m: ServerMessage) => boolean, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<ServerMessage> {
    const idx = this.inbox.findIndex((m) => pred(m) && !this.consumed.has(m));
    if (idx >= 0) {
      const m = this.inbox[idx]!;
      this.consumed.add(m);
      return Promise.resolve(m);
    }
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiters = this.waiters.filter((w) => w.timer !== timer);
        reject(new Error(`${this.name}: timed out waiting for a message; last 5: ${JSON.stringify(this.inbox.slice(-5).map((m) => (m.t === 'event' ? `event:${m.ev.type}` : m.t)))}`));
      }, timeoutMs);
      this.waiters.push({ pred, resolve, reject, timer });
    });
  }
  private readonly consumed = new WeakSet<ServerMessage>();

  /** Waits until an event of `type` has been applied (counts events seen so far too). */
  waitForEvent<K extends GameEvent['type']>(type: K, timeoutMs = SCRIPT_TIMEOUT_MS): Promise<Extract<GameEvent, { type: K }>> {
    return this.waitFor((m): m is Extract<ServerMessage, { t: 'event' }> => m.t === 'event' && m.ev.type === type, timeoutMs).then((m) => m.ev as Extract<GameEvent, { type: K }>);
  }

  /** From now on every turnStarted for me is answered with the next scripted shot. */
  startAutoplay(script: ShotInput[]): void {
    this.script = script.slice();
    this.autoplay = true;
  }

  close(): Promise<void> {
    const ws = this.socket;
    if (!ws || ws.readyState === WebSocket.CLOSED) return Promise.resolve();
    return new Promise((done) => {
      ws.once('close', () => done());
      ws.close(1000, 'test done');
    });
  }

  stateJson(): GameStateJson {
    if (!this.state) throw new Error(`${this.name}: no state`);
    return gameStateToJson(this.state);
  }

  private layersFor(course: Course): CourseLayers {
    let l = this.layersCache.get(course.id);
    if (!l) {
      l = decodeLayers(course);
      this.layersCache.set(course.id, l);
    }
    return l;
  }

  private onRaw(raw: string): void {
    const msg = JSON.parse(raw) as ServerMessage;
    this.inbox.push(msg);
    this.handle(msg);
    for (const w of this.waiters.slice()) {
      if (w.pred(msg)) {
        this.waiters = this.waiters.filter((x) => x !== w);
        clearTimeout(w.timer);
        this.consumed.add(msg);
        w.resolve(msg);
      }
    }
  }

  private handle(msg: ServerMessage): void {
    switch (msg.t) {
      case 'roomJoined':
        this.state = gameStateFromJson(msg.state);
        this.playerId = msg.playerId;
        this.sessionToken = msg.sessionToken;
        this.roomCode = msg.code;
        return;
      case 'roomState':
        return; // compared by the test, never adopted: the test asserts the reducer state already equals it
      case 'error':
        this.errors.push(msg);
        return;
      case 'event':
        this.applyEvent(msg.ev);
        return;
      default:
        return;
    }
  }

  private applyEvent(ev: GameEvent): void {
    if (!this.state) throw new Error(`${this.name}: event before roomJoined`);
    const prev = this.state;
    this.state = applyEvent(prev, ev);
    this.events.push(ev);
    if (ev.type === 'shotTaken') this.replay(prev, ev);
    if (ev.type === 'turnStarted' && ev.playerId === this.playerId && this.autoplay) {
      const shot = this.script.shift();
      if (shot !== undefined) {
        this.shotsSent.push(shot);
        this.send({ t: 'shoot', holeIndex: this.state.holeIndex, turnSeq: ev.turnSeq, shot });
      }
    }
  }

  /** §9.6: the browser re-simulates every shot from the previous state and compares with the authority's checksum. */
  private replay(prev: GameState, ev: Extract<GameEvent, { type: 'shotTaken' }>): void {
    const course = currentCourse(prev);
    const ball = prev.balls[ev.playerId];
    if (course === null || prev.world === null || ball === undefined) throw new Error(`${this.name}: shotTaken without ball/world`);
    const out = simulateShot(this.layersFor(course), prev.world, ball, ev.shot, otherBallCentres(prev, ev.playerId));
    this.replayChecks.push({ playerId: ev.playerId, turnSeq: ev.turnSeq, ok: out.checksum === ev.outcome.checksum && out.result === ev.outcome.result && out.ticks === ev.outcome.ticks, expected: ev.outcome.checksum, actual: out.checksum });
  }
}

const isEvent = (type: GameEvent['type']) => (m: ServerMessage): m is Extract<ServerMessage, { t: 'event' }> => m.t === 'event' && m.ev.type === type;

// ---------------------------------------------------------------------------------------------------------------------
// Scripted shots: the solvability fixture (WP-K, seeded from WP-B's playability probe) gives the b_01 ace; the other
// two players get sequences derived from it so the hole exercises more than one shot per player.

interface SolvabilityFile { simVersion: number; courses: { id: string; shots: ShotInput[] }[] }

function fixtureShots(courseId: string): ShotInput[] {
  const file = join(dirname(fileURLToPath(import.meta.url)), '..', '..', 'shared', 'src', 'sim', '__fixtures__', 'solvability.json');
  const parsed = JSON.parse(readFileSync(file, 'utf8')) as SolvabilityFile;
  const entry = parsed.courses.find((c) => c.id === courseId);
  if (!entry) throw new Error(`solvability.json has no entry for ${courseId}`);
  return entry.shots;
}

/**
 * A sequence that holes b_01 in two or three shots: a deliberately short opener, then a search for a holing follow-up
 * among shots aimed at the cup (several pulls, small angle offsets). Falls back to the fixture ace when nothing is
 * found, so a tuning change can never make this test fail for the wrong reason.
 */
function multiShotSequence(course: Course, opener: ShotInput, ace: ShotInput[]): ShotInput[] {
  const layers = decodeLayers(course);
  const world0 = { walls: layers.walls.slice(), breakHits: new Uint8Array(layers.walls.length), minesArmed: new Uint8Array(layers.mines.length).fill(1) };
  const start = { x: layers.start.x, y: layers.start.y, vx: 0, vy: 0, moving: false, lastTile: layers.startTile, teleportCooldownTile: -1, insideOneWay: -1, slowTicks: 0 };
  const first = simulateShot(layers, world0, start, opener);
  if (first.result === 'holed' || first.penalty > 0) return ace;
  const hole = layers.holes[0]!;
  const dx = hole.cx - first.ball.x;
  const dy = hole.cy - first.ball.y;
  const dist = Math.sqrt(dx * dx + dy * dy);
  if (dist < 1) return ace;
  const ux = dx / dist;
  const uy = dy / dist;
  for (const pull of [20, 25, 30, 35, 40, 45, 50, 55, 60, 70, 80, 90, 100, 110, 120]) {
    for (const off of [0, 0.03, -0.03, 0.06, -0.06, 0.1, -0.1]) {
      // rotate the unit vector by a small angle (test-only trig)
      const c = Math.cos(off);
      const s = Math.sin(off);
      const rx = ux * c - uy * s;
      const ry = ux * s + uy * c;
      const shot: ShotInput = { dx: Math.round(rx * pull * 100), dy: Math.round(ry * pull * 100) };
      if (!validateShot(shot)) continue;
      const second = simulateShot(layers, first.world, first.ball, shot);
      if (second.result === 'holed') return [opener, shot];
    }
  }
  return ace;
}

// ---------------------------------------------------------------------------------------------------------------------
// Tests

let publicDir: string;
let srv: RunningServer;
const clients: TestClient[] = [];

beforeAll(async () => {
  publicDir = mkdtempSync(join(tmpdir(), 'puttipeli-integration-'));
  writeFileSync(join(publicDir, 'index.html'), '<!doctype html><title>Puttipeli</title><div id="app"></div>');
  writeFileSync(join(publicDir, 'favicon.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
  srv = await startServer({ PUBLIC_DIR: publicDir });
});

afterAll(async () => {
  await Promise.all(clients.map((c) => c.close()));
  await srv.stop();
  rmSync(publicDir, { recursive: true, force: true });
});

describe('real server on port 0: http', () => {
  it('GET /healthz -> 200 {"ok":true}', async () => {
    const r = await fetch(`${srv.httpBase}/healthz`);
    expect(r.status).toBe(200);
    expect(await r.json()).toEqual({ ok: true });
  });

  it('GET /api/stats reports zero rooms before anyone joins', async () => {
    const r = await fetch(`${srv.httpBase}/api/stats`);
    expect(r.status).toBe(200);
    expect(await r.json()).toMatchObject({ rooms: 0, players: 0, spectators: 0, build: srv.config.buildId });
  });

  it('static fallback: an unknown extension-less path serves index.html, a missing file is 404', async () => {
    const root = await fetch(`${srv.httpBase}/`);
    expect(root.status).toBe(200);
    expect(root.headers.get('content-type')).toContain('text/html');
    expect(root.headers.get('cache-control')).toBe('no-cache');
    const deep = await fetch(`${srv.httpBase}/room/K7PQ2`);
    expect(deep.status).toBe(200);
    expect(await deep.text()).toContain('id="app"');
    const asset = await fetch(`${srv.httpBase}/favicon.svg`);
    expect(asset.status).toBe(200);
    expect(asset.headers.get('content-type')).toBe('image/svg+xml');
    const missing = await fetch(`${srv.httpBase}/assets/nope-abc123.js`);
    expect(missing.status).toBe(404);
    const ws = await fetch(`${srv.httpBase}/ws`);
    expect(ws.status).toBe(426);
  });
});

describe('real server on port 0: three ws clients play one hole of b_01', () => {
  const course = findBuiltin('b_01')!;
  const ace = fixtureShots('b_01');
  const scripts: Record<string, ShotInput[]> = {
    Aino: ace,
    Bertta: multiShotSequence(course, { dx: 4500, dy: 0 }, ace),
    Cecilia: multiShotSequence(course, { dx: 6500, dy: 300 }, ace),
  };

  it('scripts are valid shots (the fixture ace plus derived multi-shot sequences)', () => {
    expect(course).toBeDefined();
    for (const [name, shots] of Object.entries(scripts)) {
      expect(shots.length, name).toBeGreaterThan(0);
      for (const s of shots) expect(validateShot(s), `${name} ${JSON.stringify(s)}`).toBe(true);
    }
  });

  it('plays the hole; every client state equals the server snapshot and every replay checksum matches', { timeout: 60_000 }, async () => {
    const [a, b, c] = [new TestClient('Aino', 0), new TestClient('Bertta', 1), new TestClient('Cecilia', 2)];
    clients.push(a, b, c);
    for (const cl of [a, b, c]) {
      await cl.connect(srv.wsUrl, { Origin: `http://127.0.0.1:${srv.port}` });
      await cl.hello();
    }

    // --- lobby -------------------------------------------------------------------------------------------------
    a.send({ t: 'createRoom', name: a.name, colour: a.colour, settings: { turnTimeoutSec: 0, holeSummarySec: 3, maxPlayers: 3 } });
    const joinedA = await a.waitFor((m): m is Extract<ServerMessage, { t: 'roomJoined' }> => m.t === 'roomJoined');
    expect(joinedA.role).toBe('player');
    expect(joinedA.code).toMatch(/^[A-HJ-NP-Z2-9]{5}$/);
    expect(a.state!.hostId).toBe(a.playerId);

    b.send({ t: 'joinRoom', code: joinedA.code.toLowerCase(), name: b.name, colour: b.colour });
    await b.waitFor((m) => m.t === 'roomJoined');
    await a.waitFor(isEvent('playerJoined'));
    c.send({ t: 'joinRoom', code: ` ${joinedA.code} `, name: c.name, colour: c.colour });
    await c.waitFor((m) => m.t === 'roomJoined');
    await Promise.all([a.waitFor((m) => isEvent('playerJoined')(m) && m.ev.type === 'playerJoined' && m.ev.player.name === c.name), b.waitFor(isEvent('playerJoined'))]);
    expect(a.state!.players.map((p) => p.name)).toEqual([a.name, b.name, c.name]);
    expect(b.stateJson()).toEqual(a.stateJson());
    expect(c.stateJson()).toEqual(a.stateJson());

    // Full course data travels in coursesChanged (§11.6) so every client simulates identical geometry.
    a.send({ t: 'setCourses', courses: [{ kind: 'builtin', id: 'b_01' }] });
    await Promise.all([a, b, c].map((cl) => cl.waitFor(isEvent('coursesChanged'))));
    expect(a.state!.courses.map((x) => x.id)).toEqual(['b_01']);

    b.send({ t: 'setReady', ready: true });
    c.send({ t: 'setReady', ready: true });
    await Promise.all([a, b, c].map(async (cl) => {
      await cl.waitFor((m) => isEvent('readyChanged')(m) && m.ev.type === 'readyChanged' && m.ev.playerId === b.playerId);
      await cl.waitFor((m) => isEvent('readyChanged')(m) && m.ev.type === 'readyChanged' && m.ev.playerId === c.playerId);
    }));

    // A non-host cannot start; a stale shoot before the hole is NOT_YOUR_TURN.
    b.send({ t: 'startGame' });
    const notHost = await b.waitFor((m) => m.t === 'error');
    expect(notHost.t === 'error' && notHost.code).toBe('NOT_HOST');
    b.send({ t: 'shoot', holeIndex: 0, turnSeq: 1, shot: { dx: 1000, dy: 0 } });
    const notTurn = await b.waitFor((m) => m.t === 'error');
    expect(notTurn.t === 'error' && notTurn.code).toBe('NOT_YOUR_TURN');

    // --- play --------------------------------------------------------------------------------------------------
    for (const cl of [a, b, c]) cl.startAutoplay(scripts[cl.name]!);
    a.send({ t: 'startGame' });
    await Promise.all([a, b, c].map((cl) => cl.waitFor(isEvent('countdownStarted'))));
    await Promise.all([a, b, c].map((cl) => cl.waitForEvent('holeStarted')));
    expect(a.state!.phase).toBe('hole');
    expect(a.state!.holeIndex).toBe(0);
    expect(a.state!.order).toHaveLength(3);

    const totalShots = Object.values(scripts).reduce((n, s) => n + s.length, 0);
    const expectedPlayMs = totalShots * ((TICK_HZ * 30) / TICK_HZ) * 1000; // worst case: every shot runs to the 30 s cap
    await Promise.all([a, b, c].map((cl) => cl.waitForEvent('holeEnded', Math.min(expectedPlayMs, 50_000))));
    expect(a.state!.phase).toBe('holeSummary');
    for (const cl of [a, b, c]) {
      expect(cl.state!.holeDone[cl.playerId], `${cl.name} holeDone`).toBe(true);
      expect(cl.shotsSent, `${cl.name} played the whole script`).toEqual(scripts[cl.name]);
      const strokes = cl.state!.strokes[cl.playerId]![0];
      expect(strokes, `${cl.name} strokes`).toBe(scripts[cl.name]!.length);
    }

    // Single-course set: the hole summary (3 s) ends the round.
    await Promise.all([a, b, c].map((cl) => cl.waitForEvent('roundEnded')));
    expect(a.state!.phase).toBe('roundSummary');
    expect(a.state!.ranking).not.toBeNull();
    expect(a.state!.ranking!.length).toBe(3);

    // --- consistency ---------------------------------------------------------------------------------------------
    const shotEvents = a.events.filter((e) => e.type === 'shotTaken');
    expect(shotEvents.length).toBe(totalShots);
    for (const cl of [a, b, c]) {
      expect(cl.errors.filter((e) => e.code !== 'NOT_HOST' && e.code !== 'NOT_YOUR_TURN'), `${cl.name} errors`).toEqual([]);
      expect(cl.replayChecks.length, `${cl.name} replays`).toBe(totalShots);
      for (const r of cl.replayChecks) expect(r.ok, `${cl.name}: replay of ${r.playerId} turn ${r.turnSeq}: expected ${r.expected}, got ${r.actual}`).toBe(true);
    }
    // Every client saw the same event stream in the same order (seq counts applied events).
    expect(b.events.map((e) => e.type)).toEqual(a.events.map((e) => e.type).slice(a.events.length - b.events.length));
    expect(a.state!.seq).toBe(b.state!.seq);
    expect(a.state!.seq).toBe(c.state!.seq);

    // Snapshot from the server equals every client's reducer state, byte for byte after JSON normalisation.
    for (const cl of [a, b, c]) {
      cl.send({ t: 'requestSnapshot' });
      const snap = await cl.waitFor((m): m is Extract<ServerMessage, { t: 'roomState' }> => m.t === 'roomState');
      expect(JSON.parse(JSON.stringify(cl.stateJson())), `${cl.name} vs server snapshot`).toEqual(JSON.parse(JSON.stringify(snap.state)));
      // Sim checksums of the final ball + world agree with the server's snapshot for every player.
      const serverState = gameStateFromJson(snap.state);
      for (const p of cl.state!.players) {
        const mine = hashSimState(cl.state!.balls[p.id]!, cl.state!.world!);
        const theirs = hashSimState(serverState.balls[p.id]!, serverState.world!);
        expect(mine, `${cl.name}: checksum of ${p.name}`).toBe(theirs);
      }
    }
    // The three clients also agree with each other.
    expect(b.stateJson()).toEqual(a.stateJson());
    expect(c.stateJson()).toEqual(a.stateJson());

    // The room is visible in the stats, and the host can take everyone back to the lobby.
    expect(await (await fetch(`${srv.httpBase}/api/stats`)).json()).toMatchObject({ rooms: 1, players: 3, spectators: 0 });
    a.send({ t: 'backToLobby' });
    await Promise.all([a, b, c].map((cl) => cl.waitForEvent('backToLobby')));
    expect(a.state!.phase).toBe('lobby');
    expect(b.stateJson()).toEqual(a.stateJson());
  });

  it("reconnect: a dropped player rejoins with its token and receives a snapshot equal to everyone else's state", { timeout: 20_000 }, async () => {
    const [a, b, c] = clients as [TestClient, TestClient, TestClient];
    // b loses its socket: the others see playerConnection{false} (lobby grace starts, §10.6).
    await b.close();
    const connection = (id: string, connected: boolean) => (m: ServerMessage): boolean =>
      isEvent('playerConnection')(m) && m.ev.type === 'playerConnection' && m.ev.playerId === id && m.ev.connected === connected;
    await Promise.all([a, c].map((cl) => cl.waitFor(connection(b.playerId, false))));
    expect(a.state!.players.find((p) => p.id === b.playerId)!.connected).toBe(false);

    // A bogus token is SESSION_EXPIRED; the real one swaps the connection and replies roomJoined with the same id (§11.5).
    const b2 = new TestClient(b.name, b.colour);
    clients.push(b2);
    await b2.connect(srv.wsUrl); // no Origin header: allowed while PUBLIC_ORIGIN is unset (development)
    await b2.hello();
    b2.send({ t: 'rejoin', code: b.roomCode, sessionToken: '0'.repeat(32) });
    const expired = await b2.waitFor((m) => m.t === 'error');
    expect(expired.t === 'error' && expired.code).toBe('SESSION_EXPIRED');
    b2.send({ t: 'rejoin', code: b.roomCode.toLowerCase(), sessionToken: b.sessionToken });
    const rejoined = await b2.waitFor((m): m is Extract<ServerMessage, { t: 'roomJoined' }> => m.t === 'roomJoined');
    expect(rejoined.playerId).toBe(b.playerId);
    expect(rejoined.code).toBe(b.roomCode);
    expect(rejoined.role).toBe('player');
    expect(rejoined.sessionToken).toBe(b.sessionToken);
    await Promise.all([a, c].map((cl) => cl.waitFor(connection(b.playerId, true))));
    // The snapshot predates connection(true) (R20); b2 reduces the playerConnection{true} frame that follows roomJoined
    // exactly like every other client, so its state (seq included) equals the server's and the others'.
    await b2.waitFor(connection(b.playerId, true));
    expect(a.state!.players.find((p) => p.id === b.playerId)!.connected).toBe(true);
    expect(b2.stateJson()).toEqual(a.stateJson());
    expect(b2.state!.seq).toBe(a.state!.seq);
    expect(c.stateJson()).toEqual(a.stateJson());
    b2.send({ t: 'requestSnapshot' });
    const snap = await b2.waitFor((m): m is Extract<ServerMessage, { t: 'roomState' }> => m.t === 'roomState');
    expect(JSON.parse(JSON.stringify(snap.state)) as GameStateJson).toEqual(JSON.parse(JSON.stringify(b2.stateJson())) as GameStateJson);
    expect(snap.state.seq).toBe(a.state!.seq);
    expect(await (await fetch(`${srv.httpBase}/api/stats`)).json()).toMatchObject({ rooms: 1, players: 3, spectators: 0 });
  });

  it('leaving tears the room down: the last member out closes it and stats drop to zero', { timeout: 20_000 }, async () => {
    const [a, , c, b2] = clients as [TestClient, TestClient, TestClient, TestClient];
    c.send({ t: 'leaveRoom' });
    await c.waitFor((m) => m.t === 'roomLeft');
    await Promise.all([a, b2].map((cl) => cl.waitFor((m) => isEvent('playerLeft')(m) && m.ev.type === 'playerLeft' && m.ev.playerId === c.playerId)));
    expect(a.state!.players.map((p) => p.name)).toEqual([a.name, b2.name]);
    expect(b2.stateJson()).toEqual(a.stateJson());
    b2.send({ t: 'leaveRoom' });
    await b2.waitFor((m) => m.t === 'roomLeft');
    await a.waitFor((m) => isEvent('playerLeft')(m) && m.ev.type === 'playerLeft' && m.ev.playerId === b2.playerId);
    expect(a.state!.players.map((p) => p.name)).toEqual([a.name]);
    expect(a.state!.hostId).toBe(a.playerId);
    a.send({ t: 'leaveRoom' });
    const left = await a.waitFor((m) => m.t === 'roomLeft');
    expect(left.t === 'roomLeft' && left.reason).toBe('left');
    // No member remains, so the RoomManager drops the room at once (no grace timer involved).
    const deadline = Date.now() + 5_000;
    let stats: { rooms: number } = { rooms: -1 };
    while (Date.now() < deadline) {
      stats = (await (await fetch(`${srv.httpBase}/api/stats`)).json()) as { rooms: number };
      if (stats.rooms === 0) break;
      await new Promise((r) => setTimeout(r, 50));
    }
    expect(stats).toMatchObject({ rooms: 0 });
    expect(await (await fetch(`${srv.httpBase}/api/stats`)).json()).toMatchObject({ rooms: 0, players: 0, spectators: 0 });
    // A room message after leaving is answered with NOT_IN_ROOM, not a dropped socket.
    a.send({ t: 'requestSnapshot' });
    const notIn = await a.waitFor((m) => m.t === 'error');
    expect(notIn.t === 'error' && notIn.code).toBe('NOT_IN_ROOM');
    expect(a.closeCode).toBeNull();
  });
});

describe('real server with PUBLIC_ORIGIN set: Origin check on the WebSocket upgrade', () => {
  let locked: RunningServer;
  const origin = 'https://puttipeli.example';

  beforeAll(async () => {
    locked = await startServer({ PUBLIC_DIR: '', PUBLIC_ORIGIN: `${origin}, http://127.0.0.1:5173/` });
  });
  afterAll(async () => {
    await locked.stop();
  });

  function upgradeStatus(url: string, headers?: Record<string, string>): Promise<{ status: number | null; open: boolean }> {
    return new Promise((done) => {
      const ws = new WebSocket(url, headers ? { headers } : undefined);
      ws.once('unexpected-response', (_req, res) => {
        done({ status: res.statusCode ?? null, open: false });
        ws.terminate();
      });
      ws.once('open', () => {
        ws.close();
        done({ status: 101, open: true });
      });
      ws.once('error', () => {
        /* reported through unexpected-response first; a bare error means no HTTP status */
      });
    });
  }

  it('rejects an upgrade without an Origin header (403)', async () => {
    expect(await upgradeStatus(locked.wsUrl)).toEqual({ status: 403, open: false });
  });

  it('rejects a foreign Origin (403)', async () => {
    expect(await upgradeStatus(locked.wsUrl, { Origin: 'https://evil.example' })).toEqual({ status: 403, open: false });
  });

  it('accepts every listed Origin (case-insensitive, trailing slash tolerated) and completes the hello handshake', async () => {
    expect(await upgradeStatus(locked.wsUrl, { Origin: origin })).toEqual({ status: 101, open: true });
    expect(await upgradeStatus(locked.wsUrl, { Origin: 'HTTP://127.0.0.1:5173' })).toEqual({ status: 101, open: true });
    const cl = new TestClient('Origin', 0);
    await cl.connect(locked.wsUrl, { Origin: origin });
    await cl.hello();
    await cl.close();
  });

  it('rejects upgrades on any other path (404) and serves no static files with PUBLIC_DIR=""', async () => {
    expect(await upgradeStatus(`http://127.0.0.1:${locked.port}/socket`, { Origin: origin })).toEqual({ status: 404, open: false });
    const r = await fetch(`${locked.httpBase}/`);
    expect(r.status).toBe(404);
    expect((await fetch(`${locked.httpBase}/healthz`)).status).toBe(200);
  });

  it('version mismatch in hello is answered with BAD_VERSION and close code 4000', async () => {
    const ws = new WebSocket(locked.wsUrl, { headers: { Origin: origin } });
    await new Promise<void>((done) => ws.once('open', () => done()));
    const messages: ServerMessage[] = [];
    ws.on('message', (d) => messages.push(JSON.parse(d.toString()) as ServerMessage));
    const closed = new Promise<number>((done) => ws.once('close', (code) => done(code)));
    ws.send(JSON.stringify({ t: 'hello', protocolVersion: PROTOCOL_VERSION + 1, simVersion: SIM_VERSION, clientBuild: 'old' }));
    expect(await closed).toBe(4000);
    expect(messages.some((m) => m.t === 'error' && m.code === 'BAD_VERSION')).toBe(true);
  });
});
