// The one pure game reducer (DESIGN D2, §10.2). Runs identically in single player, on the server and on every client.
// Never mutates its input (tests deep-freeze it) and returns a new object; `seq` increments on every event.
// An impossible transition throws ReducerError: the authority never emits such events, and a client that catches one
// calls requestSnapshot().
import { applyWorldDelta, createBallAt, createWorldFromCourse, startCentre } from '../sim/worldState';
import type { GameEvent, GameEventType } from './events';
import type { GameState, PlayerState, TurnState } from './types';

export class ReducerError extends Error {
  readonly eventType: GameEventType;
  constructor(eventType: GameEventType, message: string) {
    super(`${eventType}: ${message}`);
    this.name = 'ReducerError';
    this.eventType = eventType;
  }
}

const ROUND_PHASES: readonly GameState['phase'][] = ['countdown', 'hole', 'holeSummary', 'roundSummary'];

function findPlayer(state: GameState, ev: GameEvent, id: string): PlayerState {
  const p = state.players.find((q) => q.id === id);
  if (p === undefined) throw new ReducerError(ev.type, `unknown player ${id}`);
  return p;
}

function patchPlayer(players: readonly PlayerState[], id: string, patch: Partial<PlayerState>): PlayerState[] {
  return players.map((p) => (p.id === id ? { ...p, ...patch } : p));
}

function requireLobby(state: GameState, ev: GameEvent): void {
  if (state.phase !== 'lobby') throw new ReducerError(ev.type, `not allowed in phase ${state.phase}`);
}

/** The turn that `ev` (shotTaken / turnTimedOut / turnSkipped) consumes: matching player and turnSeq, no shot in flight. */
function requireOpenTurn(state: GameState, ev: GameEvent & { playerId: string; turnSeq: number }): TurnState {
  if (state.phase !== 'hole') throw new ReducerError(ev.type, `not allowed in phase ${state.phase}`);
  const turn = state.turn;
  if (turn === null) throw new ReducerError(ev.type, 'no turn in progress');
  if (turn.playerId !== ev.playerId) throw new ReducerError(ev.type, `${ev.playerId} is not on turn (${turn.playerId} is)`);
  if (turn.turnSeq !== ev.turnSeq) throw new ReducerError(ev.type, `turnSeq ${ev.turnSeq} does not match ${turn.turnSeq}`);
  if (turn.shotInFlight) throw new ReducerError(ev.type, 'a shot is already in flight');
  return turn;
}

function maxStrokesOf(state: GameState, ev: GameEvent): number {
  const course = state.courses[state.holeIndex];
  if (course === undefined) throw new ReducerError(ev.type, `no course at hole index ${state.holeIndex}`);
  return course.rules.maxStrokes;
}

function strokesRow(state: GameState, id: string): number[] {
  const row = state.strokes[id];
  if (row !== undefined && row.length === state.courses.length) return row.slice();
  const fresh = new Array<number>(state.courses.length).fill(-1);
  if (row !== undefined) for (let i = 0; i < Math.min(row.length, fresh.length); i++) fresh[i] = row[i]!;
  return fresh;
}

/** Stroke bookkeeping shared by shotTaken and turnTimedOut: returns the new strokes map, the stroke count and holeDone. */
function addStrokes(
  state: GameState,
  ev: GameEvent,
  id: string,
  added: number,
  holed: boolean,
): { strokes: GameState['strokes']; holeDone: GameState['holeDone'] } {
  const maxStrokes = maxStrokesOf(state, ev);
  const row = strokesRow(state, id);
  let s = Math.max(row[state.holeIndex] ?? -1, 0) + added;
  let done = holed;
  if (!holed && s >= maxStrokes) {
    s = maxStrokes;
    done = true;
  }
  row[state.holeIndex] = s;
  return {
    strokes: { ...state.strokes, [id]: row },
    holeDone: done ? { ...state.holeDone, [id]: true } : state.holeDone,
  };
}

function withSeq(state: GameState, next: Partial<GameState>): GameState {
  return { ...state, ...next, seq: state.seq + 1 };
}

export function applyEvent(state: GameState, ev: GameEvent): GameState {
  switch (ev.type) {
    case 'playerJoined': {
      requireLobby(state, ev);
      const p = ev.player;
      if (state.players.some((q) => q.id === p.id)) throw new ReducerError(ev.type, `player ${p.id} already present`);
      const players = [...state.players, { ...p }].sort((a, b) => a.joinedSeq - b.joinedSeq);
      const host = state.hostId === null ? null : (state.players.find((q) => q.id === state.hostId) ?? null);
      const hostId = host === null || host.leftRound ? p.id : state.hostId;
      return withSeq(state, { players, hostId, strokes: { ...state.strokes, [p.id]: [] } });
    }

    case 'playerLeft': {
      findPlayer(state, ev, ev.playerId);
      if (state.phase === 'lobby') {
        const strokes = { ...state.strokes };
        delete strokes[ev.playerId];
        return withSeq(state, { players: state.players.filter((p) => p.id !== ev.playerId), strokes });
      }
      return withSeq(state, {
        players: patchPlayer(state.players, ev.playerId, { leftRound: true, connected: false }),
        holeDone: { ...state.holeDone, [ev.playerId]: true },
        order: state.order.filter((id) => id !== ev.playerId),
      });
    }

    case 'spectatorJoined': {
      if (state.spectators.some((s) => s.id === ev.spectator.id)) {
        throw new ReducerError(ev.type, `spectator ${ev.spectator.id} already present`);
      }
      return withSeq(state, { spectators: [...state.spectators, { ...ev.spectator }] });
    }

    case 'spectatorLeft': {
      if (!state.spectators.some((s) => s.id === ev.id)) throw new ReducerError(ev.type, `unknown spectator ${ev.id}`);
      return withSeq(state, { spectators: state.spectators.filter((s) => s.id !== ev.id) });
    }

    case 'playerConnection': {
      findPlayer(state, ev, ev.playerId);
      return withSeq(state, { players: patchPlayer(state.players, ev.playerId, { connected: ev.connected }) });
    }

    case 'playerAfk': {
      findPlayer(state, ev, ev.playerId);
      const patch: Partial<PlayerState> = ev.afk ? { afk: true } : { afk: false, consecutiveTimeouts: 0 };
      return withSeq(state, { players: patchPlayer(state.players, ev.playerId, patch) });
    }

    case 'hostChanged': {
      findPlayer(state, ev, ev.hostId);
      return withSeq(state, { hostId: ev.hostId });
    }

    case 'profileChanged': {
      requireLobby(state, ev);
      findPlayer(state, ev, ev.playerId);
      return withSeq(state, { players: patchPlayer(state.players, ev.playerId, { name: ev.name, colour: ev.colour }) });
    }

    case 'readyChanged': {
      requireLobby(state, ev);
      findPlayer(state, ev, ev.playerId);
      return withSeq(state, { players: patchPlayer(state.players, ev.playerId, { ready: ev.ready }) });
    }

    case 'settingsChanged': {
      requireLobby(state, ev);
      return withSeq(state, { settings: { ...ev.settings } });
    }

    case 'coursesChanged': {
      requireLobby(state, ev);
      return withSeq(state, { courses: ev.courses.slice() });
    }

    case 'countdownStarted': {
      requireLobby(state, ev);
      return withSeq(state, { phase: 'countdown', countdownEndsAtMs: ev.endsAtMs });
    }

    case 'gameStarted': {
      if (state.phase !== 'countdown') throw new ReducerError(ev.type, `not allowed in phase ${state.phase}`);
      const strokes: GameState['strokes'] = {};
      for (const p of state.players) strokes[p.id] = new Array<number>(state.courses.length).fill(-1);
      const players = state.players.map((p) => ({ ...p, ready: false, consecutiveTimeouts: 0, afk: false }));
      return withSeq(state, { seatOrder: ev.seatOrder.slice(), strokes, players, ranking: null, holeIndex: -1 });
    }

    case 'holeStarted': {
      if (state.phase !== 'countdown' && state.phase !== 'holeSummary') {
        throw new ReducerError(ev.type, `not allowed in phase ${state.phase}`);
      }
      const course = state.courses[ev.holeIndex];
      if (course === undefined) throw new ReducerError(ev.type, `no course at hole index ${ev.holeIndex}`);
      const world = createWorldFromCourse(course);
      const start = startCentre(course);
      const balls: GameState['balls'] = {};
      const shotOrigins: GameState['shotOrigins'] = {};
      const holeDone: GameState['holeDone'] = {};
      for (const p of state.players) {
        if (p.leftRound) {
          holeDone[p.id] = true;
        } else {
          balls[p.id] = createBallAt(start);
          shotOrigins[p.id] = { x: start.x, y: start.y };
        }
      }
      return withSeq(state, {
        phase: 'hole',
        holeIndex: ev.holeIndex,
        order: ev.order.slice(),
        world,
        balls,
        shotOrigins,
        holeDone,
        summaryReady: {},
        turn: null,
        lastShot: null,
      });
    }

    case 'turnStarted': {
      if (state.phase !== 'hole') throw new ReducerError(ev.type, `not allowed in phase ${state.phase}`);
      const p = findPlayer(state, ev, ev.playerId);
      if (p.leftRound || !state.order.includes(ev.playerId)) throw new ReducerError(ev.type, `${ev.playerId} is not in the turn order`);
      if (state.holeDone[ev.playerId]) throw new ReducerError(ev.type, `${ev.playerId} has finished this hole`);
      const turn: TurnState = { playerId: ev.playerId, turnSeq: ev.turnSeq, deadlineMs: ev.deadlineMs, shotInFlight: false };
      return withSeq(state, { turn });
    }

    case 'shotTaken': {
      const turn = requireOpenTurn(state, ev);
      const id = ev.playerId;
      const prevBall = state.balls[id];
      if (prevBall === undefined) throw new ReducerError(ev.type, `${id} has no ball`);
      if (state.world === null) throw new ReducerError(ev.type, 'no world');
      const out = ev.outcome;
      const holed = out.result === 'holed';
      const { strokes, holeDone } = addStrokes(state, ev, id, 1 + out.penalty, holed);
      return withSeq(state, {
        shotOrigins: { ...state.shotOrigins, [id]: { x: prevBall.x, y: prevBall.y } },
        balls: { ...state.balls, [id]: { ...out.ball } },
        world: applyWorldDelta(state.world, out.worldDelta),
        strokes,
        holeDone,
        players: patchPlayer(state.players, id, { consecutiveTimeouts: 0, afk: false }),
        lastShot: { playerId: id, turnSeq: ev.turnSeq, shot: { dx: ev.shot.dx, dy: ev.shot.dy }, ticks: out.ticks, atMs: ev.atMs },
        turn: { ...turn, shotInFlight: true },
      });
    }

    case 'turnTimedOut': {
      const turn = requireOpenTurn(state, ev);
      const p = findPlayer(state, ev, ev.playerId);
      const { strokes, holeDone } = addStrokes(state, ev, ev.playerId, 1, false);
      const consecutiveTimeouts = p.consecutiveTimeouts + 1;
      const patch: Partial<PlayerState> = { consecutiveTimeouts };
      if (consecutiveTimeouts >= 2) patch.afk = true;
      return withSeq(state, {
        strokes,
        holeDone,
        players: patchPlayer(state.players, ev.playerId, patch),
        turn: { ...turn, shotInFlight: true },
      });
    }

    case 'turnSkipped': {
      const turn = requireOpenTurn(state, ev);
      return withSeq(state, { turn: { ...turn, shotInFlight: true } });
    }

    case 'holeEnded': {
      if (state.phase !== 'hole') throw new ReducerError(ev.type, `not allowed in phase ${state.phase}`);
      if (ev.holeIndex !== state.holeIndex) throw new ReducerError(ev.type, `hole index ${ev.holeIndex} is not current (${state.holeIndex})`);
      return withSeq(state, { phase: 'holeSummary', turn: null, summaryReady: {} });
    }

    case 'summaryReady': {
      if (state.phase !== 'holeSummary' && state.phase !== 'roundSummary') {
        throw new ReducerError(ev.type, `not allowed in phase ${state.phase}`);
      }
      findPlayer(state, ev, ev.playerId);
      return withSeq(state, { summaryReady: { ...state.summaryReady, [ev.playerId]: true } });
    }

    case 'roundEnded': {
      if (state.phase !== 'countdown' && state.phase !== 'hole' && state.phase !== 'holeSummary') {
        throw new ReducerError(ev.type, `not allowed in phase ${state.phase}`);
      }
      return withSeq(state, {
        phase: 'roundSummary',
        ranking: ev.ranking.map((r) => ({ ...r })),
        turn: null,
        summaryReady: {},
      });
    }

    case 'backToLobby': {
      if (!ROUND_PHASES.includes(state.phase)) throw new ReducerError(ev.type, `not allowed in phase ${state.phase}`);
      const players = state.players
        .filter((p) => !p.leftRound)
        .map((p) => ({ ...p, ready: false, afk: false, consecutiveTimeouts: 0 }));
      const strokes: GameState['strokes'] = {};
      for (const p of players) strokes[p.id] = [];
      return withSeq(state, {
        phase: 'lobby',
        players,
        strokes,
        holeIndex: -1,
        seatOrder: [],
        order: [],
        balls: {},
        shotOrigins: {},
        holeDone: {},
        world: null,
        turn: null,
        lastShot: null,
        ranking: null,
        summaryReady: {},
        countdownEndsAtMs: null,
      });
    }

    default: {
      const never: never = ev;
      throw new ReducerError((never as GameEvent).type, 'unknown event');
    }
  }
}
