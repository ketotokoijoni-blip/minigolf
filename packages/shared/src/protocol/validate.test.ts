import { describe, expect, it } from 'vitest';
import { COURSE_H, COURSE_W, MAX_NAME_CHARS } from '../constants';
import type { Course } from '../course/types';
import { xorshift32 } from '../math/rng';
import { MAX_CHAT_CHARS, MAX_MESSAGE_BYTES } from './limits';
import type { ClientMessage, ClientMessageType } from './messages';
import { isCourseShaped, isValidName, MAX_RAW_COURSE_CHARS, parseClientMessage, validateClientMessage } from './validate';

function course(over: Partial<Course> = {}): Course {
  return {
    format: 'puttipeli-course',
    formatVersion: 1,
    id: 'c_0123456789abcdef',
    name: 'Oma rata',
    author: 'Minä',
    description: '',
    width: 49,
    height: 25,
    rules: { maxStrokes: 20, par: 3 },
    surface: Array.from({ length: COURSE_H }, () => '.'.repeat(COURSE_W)),
    walls: Array.from({ length: COURSE_H }, () => '#'.repeat(COURSE_W)),
    objects: [{ type: 'start', x: 3, y: 12 }, { type: 'hole', x: 44, y: 12 }],
    ...over,
  };
}

/** One valid instance of every ClientMessage variant (the acceptance fixture). */
const VALID: ClientMessage[] = [
  { t: 'hello', protocolVersion: 1, simVersion: 1, clientBuild: 'abc123' },
  { t: 'hello', protocolVersion: 2, simVersion: 0, clientBuild: '' },
  { t: 'createRoom', name: 'Matti', colour: 0 },
  { t: 'createRoom', name: 'Maija', colour: 3, settings: { maxPlayers: 2, turnTimeoutSec: 0, holeSummarySec: 10, ballCollision: false } },
  { t: 'createRoom', name: 'Ä'.repeat(MAX_NAME_CHARS), colour: 1, settings: {} },
  { t: 'joinRoom', code: 'K7PQ2', name: 'Pekka', colour: 2 },
  { t: 'joinRoom', code: ' k7-pq2 ', name: 'Pekka', colour: 2, asSpectator: true },
  { t: 'joinRoom', code: 'K7PQ2', name: 'Pekka', colour: 2, asSpectator: false },
  { t: 'rejoin', code: 'K7PQ2', sessionToken: '0123456789abcdef0123456789abcdef' },
  { t: 'leaveRoom' },
  { t: 'setProfile' },
  { t: 'setProfile', name: 'Uusi' },
  { t: 'setProfile', colour: 1 },
  { t: 'setProfile', name: 'Uusi', colour: 3 },
  { t: 'setReady', ready: true },
  { t: 'setReady', ready: false },
  { t: 'chat', text: 'Moi!' },
  { t: 'chat', text: 'x'.repeat(MAX_CHAT_CHARS) },
  { t: 'setCourses', courses: [{ kind: 'builtin', id: 'b_01' }] },
  { t: 'setCourses', courses: [{ kind: 'builtin', id: 'b_01' }, { kind: 'custom', course: course() }] },
  { t: 'setCourses', courses: Array.from({ length: 18 }, (_, i) => ({ kind: 'builtin', id: `b_${String(i + 1).padStart(2, '0')}` })) },
  { t: 'setSettings', settings: {} },
  { t: 'setSettings', settings: { maxPlayers: 4 } },
  { t: 'setSettings', settings: { turnTimeoutSec: 60, holeSummarySec: 3 } },
  { t: 'startGame' },
  { t: 'backToLobby' },
  { t: 'shoot', holeIndex: 0, turnSeq: 1, shot: { dx: 3000, dy: 0 } },
  { t: 'shoot', holeIndex: 17, turnSeq: 250, shot: { dx: -300, dy: 0 } },
  { t: 'shoot', holeIndex: 3, turnSeq: 9, shot: { dx: 8485, dy: -8485 } },
  { t: 'shoot', holeIndex: 3, turnSeq: 9, shot: { dx: 12001, dy: 0 } },
  { t: 'summaryReady' },
  { t: 'becomePlayer' },
  { t: 'requestSnapshot' },
  { t: 'ping', t0: 1_700_000_000_000 },
  { t: 'ping', t0: 0 },
];

const ALL_TYPES: ClientMessageType[] = [
  'hello', 'createRoom', 'joinRoom', 'rejoin', 'leaveRoom', 'setProfile', 'setReady', 'chat', 'setCourses',
  'setSettings', 'startGame', 'backToLobby', 'shoot', 'summaryReady', 'becomePlayer', 'requestSnapshot', 'ping',
];

describe('parseClientMessage accepts', () => {
  it('a fixture of every valid message, returning an equal fresh object', () => {
    const seen = new Set<string>();
    for (const m of VALID) {
      const raw = JSON.stringify(m);
      const parsed = parseClientMessage(raw);
      expect(parsed, raw).toEqual(m);
      expect(parsed).not.toBe(m);
      seen.add(m.t);
    }
    expect([...seen].sort()).toEqual([...ALL_TYPES].sort());
  });

  it('drops unknown fields and unknown settings keys', () => {
    expect(parseClientMessage('{"t":"leaveRoom","extra":1,"__proto__":{"x":1}}')).toEqual({ t: 'leaveRoom' });
    expect(parseClientMessage('{"t":"setSettings","settings":{"maxPlayers":3,"foo":"bar"}}')).toEqual({ t: 'setSettings', settings: { maxPlayers: 3 } });
    expect(parseClientMessage('{"t":"shoot","holeIndex":0,"turnSeq":1,"shot":{"dx":3000,"dy":0,"z":5},"x":1}')).toEqual({
      t: 'shoot', holeIndex: 0, turnSeq: 1, shot: { dx: 3000, dy: 0 },
    });
    const parsed = parseClientMessage('{"t":"createRoom","name":"A","colour":1,"settings":{"maxPlayers":2}}');
    expect(parsed).toEqual({ t: 'createRoom', name: 'A', colour: 1, settings: { maxPlayers: 2 } });
    expect(Object.keys(parsed!)).toEqual(['t', 'name', 'colour', 'settings']);
  });

  it('keeps a course payload intact for parseCourseFile', () => {
    const c = course({ description: 'Kuvaus', rules: { maxStrokes: 5, par: 2 } });
    const parsed = parseClientMessage(JSON.stringify({ t: 'setCourses', courses: [{ kind: 'custom', course: c }] }));
    expect(parsed).toEqual({ t: 'setCourses', courses: [{ kind: 'custom', course: c }] });
    // optional fields missing and a future format version still pass the structural check (parseCourseFile reports them)
    const loose = { format: 'something', formatVersion: 2, name: 'x', width: 49, height: 25, surface: [], walls: [], objects: [] };
    expect(isCourseShaped(loose)).toBe(true);
  });
});

describe('parseClientMessage rejects', () => {
  const bad = (raw: string): void => expect(parseClientMessage(raw), raw).toBeNull();

  it('malformed JSON and non-object roots', () => {
    for (const raw of ['', ' ', '{', '{"t":', 'null', 'true', '42', '"hello"', '[]', '[{"t":"ping","t0":1}]', '{"t":"ping","t0":1}x', 'undefined', 'NaN'])
      bad(raw);
    expect(parseClientMessage(undefined as unknown as string)).toBeNull();
    expect(parseClientMessage(123 as unknown as string)).toBeNull();
  });

  it('missing / unknown / wrong-typed discriminator', () => {
    for (const raw of ['{}', '{"t":1}', '{"t":null}', '{"t":"Hello"}', '{"t":"hello "}', '{"t":"nope"}', '{"t":["ping"]}', '{"type":"ping","t0":1}'])
      bad(raw);
  });

  it('wrong field types and out-of-range values', () => {
    bad('{"t":"hello","protocolVersion":"1","simVersion":1,"clientBuild":"x"}');
    bad('{"t":"hello","protocolVersion":1.5,"simVersion":1,"clientBuild":"x"}');
    bad('{"t":"hello","protocolVersion":1,"simVersion":1}');
    bad('{"t":"hello","protocolVersion":1,"simVersion":1,"clientBuild":null}');
    bad('{"t":"createRoom","name":"","colour":0}');
    bad('{"t":"createRoom","name":"   ","colour":0}');
    bad('{"t":"createRoom","name":5,"colour":0}');
    bad('{"t":"createRoom","name":"A","colour":4}');
    bad('{"t":"createRoom","name":"A","colour":-1}');
    bad('{"t":"createRoom","name":"A","colour":1.5}');
    bad('{"t":"createRoom","name":"A","colour":"0"}');
    bad('{"t":"createRoom","name":"A"}');
    bad('{"t":"createRoom","name":"A","colour":0,"settings":null}');
    bad('{"t":"createRoom","name":"A","colour":0,"settings":[]}');
    bad('{"t":"createRoom","name":"A","colour":0,"settings":{"maxPlayers":5}}');
    bad('{"t":"createRoom","name":"A","colour":0,"settings":{"turnTimeoutSec":31}}');
    bad('{"t":"createRoom","name":"A","colour":0,"settings":{"holeSummarySec":"6"}}');
    bad('{"t":"createRoom","name":"A","colour":0,"settings":{"ballCollision":true}}');
    bad('{"t":"joinRoom","code":"","name":"A","colour":0}');
    bad('{"t":"joinRoom","code":7,"name":"A","colour":0}');
    bad('{"t":"joinRoom","code":"K7PQ2","name":"A","colour":0,"asSpectator":"yes"}');
    bad('{"t":"joinRoom","code":"K7PQ2","name":"A","colour":0,"asSpectator":null}');
    bad('{"t":"rejoin","code":"K7PQ2"}');
    bad('{"t":"rejoin","code":"K7PQ2","sessionToken":""}');
    bad('{"t":"rejoin","code":"K7PQ2","sessionToken":123}');
    bad('{"t":"setProfile","name":""}');
    bad('{"t":"setProfile","name":null}');
    bad('{"t":"setProfile","colour":7}');
    bad('{"t":"setProfile","colour":null}');
    bad('{"t":"setReady"}');
    bad('{"t":"setReady","ready":"true"}');
    bad('{"t":"setReady","ready":1}');
    bad('{"t":"chat"}');
    bad('{"t":"chat","text":""}');
    bad('{"t":"chat","text":["x"]}');
    bad('{"t":"setSettings"}');
    bad('{"t":"setSettings","settings":"x"}');
    bad('{"t":"setSettings","settings":{"maxPlayers":null}}');
    bad('{"t":"ping"}');
    bad('{"t":"ping","t0":"1"}');
    bad('{"t":"ping","t0":null}');
  });

  it('oversize strings and frames', () => {
    bad(JSON.stringify({ t: 'createRoom', name: 'x'.repeat(MAX_NAME_CHARS + 1), colour: 0 }));
    bad(JSON.stringify({ t: 'setProfile', name: 'x'.repeat(MAX_NAME_CHARS + 1) }));
    bad(JSON.stringify({ t: 'chat', text: 'x'.repeat(MAX_CHAT_CHARS + 1) }));
    bad(JSON.stringify({ t: 'joinRoom', code: 'x'.repeat(33), name: 'A', colour: 0 }));
    bad(JSON.stringify({ t: 'rejoin', code: 'K7PQ2', sessionToken: 'x'.repeat(129) }));
    bad(JSON.stringify({ t: 'hello', protocolVersion: 1, simVersion: 1, clientBuild: 'x'.repeat(65) }));
    bad(JSON.stringify({ t: 'setCourses', courses: [{ kind: 'builtin', id: 'x'.repeat(33) }] }));
    bad(JSON.stringify({ t: 'ping', t0: 1 }) + ' '.repeat(MAX_MESSAGE_BYTES));
    const huge = course({ description: 'x'.repeat(MAX_RAW_COURSE_CHARS) });
    bad(JSON.stringify({ t: 'setCourses', courses: [{ kind: 'custom', course: huge }] }));
  });

  it('shots that are not integers or out of range, and bad turn/hole indices', () => {
    const shoot = (over: Record<string, unknown>) => JSON.stringify({ t: 'shoot', holeIndex: 0, turnSeq: 1, shot: { dx: 3000, dy: 0 }, ...over });
    bad(shoot({ shot: { dx: 3000.5, dy: 0 } }));
    bad(shoot({ shot: { dx: 3000, dy: 0.1 } }));
    bad(shoot({ shot: { dx: '3000', dy: 0 } }));
    bad(shoot({ shot: { dx: 3000 } }));
    bad(shoot({ shot: { dx: 3000, dy: null } }));
    bad(shoot({ shot: null }));
    bad(shoot({ shot: [3000, 0] }));
    bad(shoot({ shot: { dx: 0, dy: 0 } }));
    bad(shoot({ shot: { dx: 299, dy: 0 } }));
    bad(shoot({ shot: { dx: 12002, dy: 0 } }));
    bad(shoot({ shot: { dx: 1e21, dy: 0 } }));
    bad('{"t":"shoot","holeIndex":0,"turnSeq":1,"shot":{"dx":-0,"dy":3000}}');
    bad(shoot({ holeIndex: -1 }));
    bad(shoot({ holeIndex: 18 }));
    bad(shoot({ holeIndex: 0.5 }));
    bad(shoot({ holeIndex: '0' }));
    bad(shoot({ turnSeq: 0 }));
    bad(shoot({ turnSeq: -3 }));
    bad(shoot({ turnSeq: 1.5 }));
    bad(shoot({ turnSeq: 1e9 }));
    bad('{"t":"shoot","holeIndex":0,"shot":{"dx":3000,"dy":0}}');
  });

  it('course sets that are empty, too long or structurally wrong', () => {
    const set = (courses: unknown) => JSON.stringify({ t: 'setCourses', courses });
    bad(set([]));
    bad(set(Array.from({ length: 19 }, () => ({ kind: 'builtin', id: 'b_01' }))));
    bad(set('b_01'));
    bad(set([null]));
    bad(set(['b_01']));
    bad(set([{ kind: 'builtin' }]));
    bad(set([{ kind: 'builtin', id: '' }]));
    bad(set([{ kind: 'builtin', id: 5 }]));
    bad(set([{ kind: 'custom' }]));
    bad(set([{ kind: 'custom', course: null }]));
    bad(set([{ kind: 'custom', course: 'x' }]));
    bad(set([{ kind: 'other', id: 'b_01' }]));
    bad(set([{ kind: 'builtin', id: 'b_01' }, { kind: 'custom', course: course({ surface: 'rows' as unknown as string[] }) }]));
    bad(set([{ kind: 'custom', course: course({ walls: [1, 2] as unknown as string[] }) }]));
    bad(set([{ kind: 'custom', course: course({ objects: [{ type: 'start' }] as unknown as Course['objects'] }) }]));
    bad(set([{ kind: 'custom', course: course({ objects: 'none' as unknown as Course['objects'] }) }]));
    bad(set([{ kind: 'custom', course: course({ name: 7 as unknown as string }) }]));
    bad(set([{ kind: 'custom', course: course({ format: 1 as unknown as 'puttipeli-course' }) }]));
    bad(set([{ kind: 'custom', course: course({ formatVersion: '1' as unknown as 1 }) }]));
    bad(set([{ kind: 'custom', course: course({ width: '49' as unknown as 49 }) }]));
    bad(set([{ kind: 'custom', course: course({ rules: { maxStrokes: 'x' as unknown as number, par: 3 } }) }]));
    bad(set([{ kind: 'custom', course: course({ rules: [] as unknown as Course['rules'] }) }]));
    bad(set([{ kind: 'custom', course: course({ surface: Array.from({ length: 65 }, () => '.') }) }]));
    bad(set([{ kind: 'custom', course: course({ objects: Array.from({ length: 2001 }, () => ({ type: 'mine', x: 1, y: 1 })) }) }]));
  });

  it('fuzz: random mutations of valid messages never throw and are either null or structurally valid', () => {
    const rnd = xorshift32(0xc0ffee);
    const pick = <T,>(arr: readonly T[]): T => arr[Math.floor(rnd() * arr.length)]!;
    const junk = [null, undefined, 0, -1, 1.5, 1e300, Number.NaN, '', 'x', 'y'.repeat(300), true, false, [], {}, [1], { a: 1 }];
    let accepted = 0;
    for (let i = 0; i < 3000; i++) {
      const base = JSON.parse(JSON.stringify(pick(VALID))) as Record<string, unknown>;
      const keys = Object.keys(base);
      const op = rnd();
      if (op < 0.4) {
        base[pick(keys)] = pick(junk);
      } else if (op < 0.6) {
        delete base[pick(keys)];
      } else if (op < 0.8) {
        const k = pick(keys);
        const v = base[k];
        if (typeof v === 'object' && v !== null && !Array.isArray(v)) {
          const inner = v as Record<string, unknown>;
          const ik = Object.keys(inner);
          if (ik.length > 0) inner[pick(ik)] = pick(junk);
          else inner['x'] = pick(junk);
        } else {
          base[k] = pick(junk);
        }
      } else {
        base['t'] = pick([...ALL_TYPES, 'bogus', 7]);
      }
      let raw = JSON.stringify(base);
      if (rnd() < 0.1) raw = raw.slice(0, Math.floor(rnd() * raw.length));
      const parsed = parseClientMessage(raw);
      if (parsed !== null) {
        accepted++;
        expect(ALL_TYPES).toContain(parsed.t);
        expect(validateClientMessage(JSON.parse(JSON.stringify(parsed)))).toEqual(parsed);
      }
    }
    expect(accepted).toBeGreaterThan(0);
    expect(accepted).toBeLessThan(3000);
  });

  it('fuzz: random bytes never throw', () => {
    const rnd = xorshift32(42);
    for (let i = 0; i < 2000; i++) {
      const len = Math.floor(rnd() * 40);
      let s = '';
      for (let k = 0; k < len; k++) s += String.fromCharCode(Math.floor(rnd() * 0x7f));
      expect(() => parseClientMessage(s)).not.toThrow();
    }
  });
});

describe('validateClientMessage / isValidName', () => {
  it('validate an already-parsed value', () => {
    expect(validateClientMessage({ t: 'ping', t0: 5 })).toEqual({ t: 'ping', t0: 5 });
    expect(validateClientMessage('ping')).toBeNull();
    expect(validateClientMessage(null)).toBeNull();
    expect(validateClientMessage([{ t: 'ping', t0: 5 }])).toBeNull();
  });
  it('isValidName', () => {
    expect(isValidName('Matti')).toBe(true);
    expect(isValidName(' M ')).toBe(true);
    expect(isValidName('')).toBe(false);
    expect(isValidName('   ')).toBe(false);
    expect(isValidName('x'.repeat(MAX_NAME_CHARS))).toBe(true);
    expect(isValidName('x'.repeat(MAX_NAME_CHARS + 1))).toBe(false);
    expect(isValidName(5)).toBe(false);
  });
});
