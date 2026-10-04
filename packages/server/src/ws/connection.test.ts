import { describe, expect, it } from 'vitest';
import { SIM_VERSION } from '@puttipeli/shared/constants';
import { CHAT_MSGS_PER_10S, RATE_BURST, RATE_MSGS_PER_SEC } from '@puttipeli/shared/protocol/limits';
import { PROTOCOL_VERSION } from '@puttipeli/shared/protocol/version';
import { nullLogger } from '../log';
import { CLOSE_BAD_VERSION, CLOSE_POLICY, ClientSession, STRIKES_TO_CLOSE, TokenBucket } from './connection';
import { FakeClock, FakeTransport } from './fakeTransport';

const HELLO = { t: 'hello', protocolVersion: PROTOCOL_VERSION, simVersion: SIM_VERSION, clientBuild: 'test' } as const;

function setup() {
  const clock = new FakeClock();
  const transport = new FakeTransport();
  let session!: ClientSession;
  transport.start({
    onOpen: (c) => {
      session = new ClientSession(c, { now: () => clock.now(), build: 'srv-build', log: nullLogger });
    },
    onMessage: () => {},
    onClose: () => {},
  });
  const conn = transport.connect();
  return { clock, conn, session };
}

describe('TokenBucket', () => {
  it('allows a burst, then refills at the configured rate', () => {
    const b = new TokenBucket(RATE_BURST, RATE_MSGS_PER_SEC, 0);
    for (let i = 0; i < RATE_BURST; i++) expect(b.tryTake(0)).toBe(true);
    expect(b.tryTake(0)).toBe(false);
    expect(b.tryTake(1000 / RATE_MSGS_PER_SEC)).toBe(true); // one token refilled
    expect(b.tryTake(1000 / RATE_MSGS_PER_SEC)).toBe(false);
    expect(b.tryTake(10_000)).toBe(true);
    expect(b.available()).toBeCloseTo(RATE_BURST - 1, 5); // capped at capacity
  });
});

describe('ClientSession handshake', () => {
  it('answers a matching hello with welcome and then routes messages', () => {
    const { clock, conn, session } = setup();
    expect(session.receive(JSON.stringify(HELLO))).toBeNull();
    expect(conn.sent).toEqual([{ t: 'welcome', protocolVersion: PROTOCOL_VERSION, simVersion: SIM_VERSION, serverTimeMs: clock.now(), build: 'srv-build' }]);
    expect(session.helloDone).toBe(true);
    expect(session.receive(JSON.stringify({ t: 'ping', t0: 5 }))).toEqual({ t: 'ping', t0: 5 });
  });

  it('rejects a version mismatch with BAD_VERSION and close 4000', () => {
    const { conn, session } = setup();
    session.receive(JSON.stringify({ ...HELLO, simVersion: SIM_VERSION + 1 }));
    expect(conn.sentOf('error')[0]?.code).toBe('BAD_VERSION');
    expect(conn.closed?.code).toBe(CLOSE_BAD_VERSION);
    const s2 = setup();
    s2.session.receive(JSON.stringify({ ...HELLO, protocolVersion: PROTOCOL_VERSION + 1 }));
    expect(s2.conn.sentOf('error')[0]?.code).toBe('BAD_VERSION');
    expect(s2.conn.closed?.code).toBe(CLOSE_BAD_VERSION);
  });

  it('closes when the first message is not hello', () => {
    const { conn, session } = setup();
    expect(session.receive(JSON.stringify({ t: 'ping', t0: 1 }))).toBeNull();
    expect(conn.sentOf('error')[0]?.code).toBe('INVALID_MESSAGE');
    expect(conn.closed?.code).toBe(CLOSE_POLICY);
  });

  it('treats a second hello as an invalid message', () => {
    const { conn, session } = setup();
    session.receive(JSON.stringify(HELLO));
    expect(session.receive(JSON.stringify(HELLO))).toBeNull();
    expect(conn.sentOf('error').map((e) => e.code)).toEqual(['INVALID_MESSAGE']);
    expect(conn.closed).toBeNull();
  });
});

describe('ClientSession limits', () => {
  it('invalid messages: error INVALID_MESSAGE, close 1008 after 3 strikes', () => {
    const { conn, session } = setup();
    session.receive(JSON.stringify(HELLO));
    for (let i = 1; i <= STRIKES_TO_CLOSE; i++) {
      expect(session.receive('{not json')).toBeNull();
      expect(conn.sentOf('error')).toHaveLength(i);
      expect(conn.sentOf('error')[i - 1]?.code).toBe('INVALID_MESSAGE');
      expect(conn.closed === null).toBe(i < STRIKES_TO_CLOSE);
    }
    expect(conn.closed?.code).toBe(CLOSE_POLICY);
  });

  it('rate limit: RATE_LIMITED after the burst, close 1008 after 3 strikes, recovers with time', () => {
    const { clock, conn, session } = setup();
    session.receive(JSON.stringify(HELLO)); // consumes 1 token
    for (let i = 1; i < RATE_BURST; i++) expect(session.receive(JSON.stringify({ t: 'ping', t0: i }))).not.toBeNull();
    expect(session.receive(JSON.stringify({ t: 'ping', t0: 0 }))).toBeNull();
    expect(conn.sentOf('error').at(-1)?.code).toBe('RATE_LIMITED');
    expect(conn.closed).toBeNull();
    clock.advance(1000); // +20 tokens
    for (let i = 0; i < RATE_MSGS_PER_SEC; i++) expect(session.receive(JSON.stringify({ t: 'ping', t0: i }))).not.toBeNull();
    expect(session.receive(JSON.stringify({ t: 'ping', t0: 0 }))).toBeNull(); // strike 2
    expect(session.receive(JSON.stringify({ t: 'ping', t0: 0 }))).toBeNull(); // strike 3 -> close
    expect(conn.sentOf('error').filter((e) => e.code === 'RATE_LIMITED')).toHaveLength(3);
    expect(conn.closed?.code).toBe(CLOSE_POLICY);
    expect(session.receive(JSON.stringify({ t: 'ping', t0: 0 }))).toBeNull(); // closed: ignored
  });

  it('chat throttle: CHAT_MSGS_PER_10S per sliding 10 s window', () => {
    const { clock, conn, session } = setup();
    for (let i = 0; i < CHAT_MSGS_PER_10S; i++) expect(session.acceptChat()).toBe(true);
    expect(session.acceptChat()).toBe(false);
    expect(conn.sentOf('error').at(-1)?.code).toBe('RATE_LIMITED');
    clock.advance(10_000);
    expect(session.acceptChat()).toBe(true);
  });
});
