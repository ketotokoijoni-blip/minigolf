// HUD view model from a fixture GameState built with WP-C initial.ts + the reducer (DESIGN §15 WP-E acceptance:
// "HUD/scorecard render from a fixture GameState"; D24: pure logic, no DOM).
import { beforeAll, describe, expect, it } from 'vitest';
import type { Course } from '@puttipeli/shared/course/types';
import type { GameState, PlayerState } from '@puttipeli/shared/game/types';
import type { ShotResult } from '@puttipeli/shared/sim/types';
import { applyEvent } from '@puttipeli/shared/game/reducer';
import { createLobbyState, createSinglePlayerState, DEFAULT_ROOM_SETTINGS } from '@puttipeli/shared/game/initial';
import { hudModel } from './hud';
import { setLanguage } from '../i18n/t';
import '../i18n/fi';
import '../i18n/en';

const row = (c: string): string => c.repeat(49);
const border = (y: number): string => (y === 0 || y === 24 ? row('#') : '#' + row('.').slice(2) + '#');
const course = (name: string, par: number, maxStrokes = 20): Course => ({
  format: 'puttipeli-course', formatVersion: 1, id: `c_${name}`, name, author: '', description: '', width: 49, height: 25,
  rules: { maxStrokes, par },
  surface: Array.from({ length: 25 }, () => row('.')),
  walls: Array.from({ length: 25 }, (_, y) => border(y)),
  objects: [{ type: 'start', x: 2, y: 12 }, { type: 'hole', x: 46, y: 12 }],
});
const player = (id: string, name: string, colour: 0 | 1 | 2 | 3, joinedSeq: number): PlayerState =>
  ({ id, name, colour, ready: true, connected: true, afk: false, consecutiveTimeouts: 0, joinedSeq, leftRound: false });

/** turnStarted + shotTaken with a canned ShotSummary (the sim is not involved). */
function shot(s: GameState, pid: string, turnSeq: number, result: ShotResult, deadlineMs: number | null = null): GameState {
  s = applyEvent(s, { type: 'turnStarted', playerId: pid, turnSeq, deadlineMs });
  const ball = s.balls[pid]!;
  return applyEvent(s, {
    type: 'shotTaken', playerId: pid, turnSeq, shot: { dx: 1000, dy: 0 }, atMs: 1000 * turnSeq,
    outcome: {
      ticks: 120, result, penalty: result === 'water' || result === 'acid' || result === 'mine' ? 1 : 0,
      holeIndex: result === 'holed' ? 0 : -1,
      ball: { ...ball, x: ball.x + 30, moving: false },
      worldDelta: { tiles: [], minesDisarmed: [] },
      checksum: 0,
    },
  });
}

/**
 * Two players, three courses. Hole 1 finished (Aino 3, Bertta 2), hole 2 in progress (Aino 1, Bertta 2 incl. a water
 * penalty), Bertta on turn with a 45 s deadline ending at 50 000 ms.
 */
function twoPlayerRound(): GameState {
  let s = createLobbyState(DEFAULT_ROOM_SETTINGS, [course('Ensiputti', 3), course('Mutka', 4), course('Finaali', 5)]);
  s = applyEvent(s, { type: 'playerJoined', player: player('a', 'Aino', 0, 1) });
  s = applyEvent(s, { type: 'playerJoined', player: player('b', 'Bertta', 1, 2) });
  s = applyEvent(s, { type: 'countdownStarted', endsAtMs: 3000 });
  s = applyEvent(s, { type: 'gameStarted', seatOrder: ['a', 'b'] });
  s = applyEvent(s, { type: 'holeStarted', holeIndex: 0, order: ['a', 'b'] });
  s = shot(s, 'a', 1, 'stopped');
  s = shot(s, 'b', 2, 'stopped');
  s = shot(s, 'a', 3, 'stopped');
  s = shot(s, 'b', 4, 'holed');
  s = shot(s, 'a', 5, 'holed');
  s = applyEvent(s, { type: 'holeEnded', holeIndex: 0 });
  s = applyEvent(s, { type: 'holeStarted', holeIndex: 1, order: ['b', 'a'] });
  s = shot(s, 'b', 1, 'water');
  s = shot(s, 'a', 2, 'stopped');
  s = applyEvent(s, { type: 'turnStarted', playerId: 'b', turnSeq: 3, deadlineMs: 50_000 });
  return s;
}

beforeAll(() => setLanguage('fi'));

describe('hudModel from a reducer-built two-player round', () => {
  const state = twoPlayerRound();

  it('fixture sanity: strokes come from the reducer', () => {
    expect(state.phase).toBe('hole');
    expect(state.holeIndex).toBe(1);
    expect(state.strokes).toEqual({ a: [3, 1, -1], b: [2, 2, -1] });
    expect(state.turn).toEqual({ playerId: 'b', turnSeq: 3, deadlineMs: 50_000, shotInFlight: false });
  });

  it('shows the course, hole counter, par, my strokes and my total for the player on turn', () => {
    const m = hudModel(state, 'b', 40_000);
    expect(m.title).toBe('Mutka');
    expect(m.inRound).toBe(true);
    expect(m.hole).toBe('2/3');
    expect(m.par).toBe('4');
    expect(m.strokes).toBe('2');
    expect(m.strokesOver).toBe(false);
    expect(m.total).toBe('4');
    expect(m.turnText).toBe('Sinun vuorosi');
    expect(m.canFire).toBe(true);
    expect(m.countdownSec).toBeNull();
  });

  it('shows the other player on turn and no fire button for the waiting player', () => {
    const m = hudModel(state, 'a', 40_000);
    expect(m.strokes).toBe('1');
    expect(m.total).toBe('4');
    expect(m.turnText).toBe('Vuorossa: Bertta');
    expect(m.canFire).toBe(false);
  });

  it('marks a spectator', () => {
    const m = hudModel(state, '', 40_000);
    expect(m.strokes).toBe('–');
    expect(m.total).toBe('–');
    expect(m.turnText.startsWith('Katselet peliä')).toBe(true);
    expect(m.canFire).toBe(false);
    expect(m.chips.every((c) => !c.isMe)).toBe(true);
  });

  it('treats an id outside the roster as a spectator too (a spectator passing its own id)', () => {
    const m = hudModel(state, 'spectator-7', 40_000);
    expect(m.strokes).toBe('–');
    expect(m.total).toBe('–');
    expect(m.strokesOver).toBe(false);
    expect(m.turnText.startsWith('Katselet peliä')).toBe(true);
    expect(m.canFire).toBe(false);
    expect(m.chips.every((c) => !c.isMe)).toBe(true);
  });

  it('builds player chips with turn marker, host and per-hole strokes', () => {
    const m = hudModel(state, 'b', 40_000);
    expect(m.chips.map((c) => c.id)).toEqual(['a', 'b']);
    const [a, b] = m.chips as [typeof m.chips[0], typeof m.chips[0]];
    expect(a.host).toBe(true);
    expect(a.isTurn).toBe(false);
    expect(a.strokes).toBe('1');
    expect(b.isTurn).toBe(true);
    expect(b.isMe).toBe(true);
    expect(b.strokes).toBe('2');
    expect(b.colour).toBe(1);
    expect(m.chips.every((c) => c.tag === '' && !c.offline && !c.afk && !c.done)).toBe(true);
  });

  it('derives the turn timer from the deadline and the room timeout', () => {
    const m = hudModel(state, 'b', 40_000);
    expect(m.timer).not.toBeNull();
    expect(m.timer!.secondsLeft).toBe(10);
    expect(m.timer!.fraction).toBeCloseTo(10 / 45, 5);
    expect(m.timer!.urgent).toBe(false);
    const late = hudModel(state, 'b', 47_500);
    expect(late.timer!.secondsLeft).toBe(3);
    expect(late.timer!.urgent).toBe(true);
    const over = hudModel(state, 'b', 60_000);
    expect(over.timer!.secondsLeft).toBe(0);
    expect(over.timer!.fraction).toBe(0);
  });

  it('hides the timer when the turn has no deadline and during a shot in flight', () => {
    let s = applyEvent(state, { type: 'turnTimedOut', playerId: 'b', turnSeq: 3 });
    expect(hudModel(s, 'b', 40_000).turnText).toBe('Pallo liikkuu…');
    expect(hudModel(s, 'b', 40_000).canFire).toBe(false);
    s = applyEvent(s, { type: 'turnStarted', playerId: 'a', turnSeq: 4, deadlineMs: null });
    expect(hudModel(s, 'a', 40_000).timer).toBeNull();
  });

  it('flags strokes over par and the done tag after holing out', () => {
    let s = applyEvent(state, { type: 'turnTimedOut', playerId: 'b', turnSeq: 3 }); // b: 3 strokes on par 4
    s = applyEvent(s, { type: 'turnStarted', playerId: 'b', turnSeq: 4, deadlineMs: null });
    s = applyEvent(s, { type: 'turnTimedOut', playerId: 'b', turnSeq: 4 });            // b: 4
    s = shot(s, 'b', 5, 'stopped');                                                   // b: 5 > par
    const m = hudModel(s, 'b', 0);
    expect(m.strokes).toBe('5');
    expect(m.strokesOver).toBe(true);
    s = shot(s, 'a', 6, 'holed');
    const done = hudModel(s, 'a', 0);
    expect(done.chips.find((c) => c.id === 'a')!.tag).toBe('done');
    expect(done.chips.find((c) => c.id === 'a')!.done).toBe(true);
  });

  it('reports AFK, offline and left players on the chips', () => {
    let s = applyEvent(state, { type: 'playerAfk', playerId: 'a', afk: true });
    expect(hudModel(s, 'b', 0).chips[0]!.tag).toBe('afk');
    expect(hudModel(s, 'b', 0).chips[0]!.afk).toBe(true);
    s = applyEvent(s, { type: 'playerConnection', playerId: 'a', connected: false });
    expect(hudModel(s, 'b', 0).chips[0]!.offline).toBe(true);
    expect(hudModel(s, 'b', 0).chips[0]!.afk).toBe(false); // offline wins over afk
    s = applyEvent(s, { type: 'playerLeft', playerId: 'a' });
    const left = hudModel(s, 'b', 0).chips[0]!;
    expect(left.left).toBe(true);
    expect(left.tag).toBe('left');
  });

  it('uses the disconnected wait as the timer base when the player on turn is offline', () => {
    let s = applyEvent(state, { type: 'playerConnection', playerId: 'b', connected: false });
    s = { ...s, turn: { ...s.turn!, deadlineMs: 45_000 } }; // authority would restart the turn with a 10 s deadline
    const m = hudModel(s, 'a', 40_000);
    expect(m.timer!.fraction).toBeCloseTo(0.5, 5);
  });

  it('shows summaries, the lobby and the countdown by phase', () => {
    const summary = applyEvent(state, { type: 'holeEnded', holeIndex: 1 });
    expect(hudModel(summary, 'a', 0).turnText).toBe('Radan yhteenveto');
    expect(hudModel(summary, 'a', 0).inRound).toBe(true);
    const ended = applyEvent(summary, { type: 'roundEnded', ranking: [{ playerId: 'a', total: 4, rank: 1 }, { playerId: 'b', total: 4, rank: 1 }] });
    expect(hudModel(ended, 'a', 0).turnText).toBe('Kierroksen yhteenveto');
    const lobby = applyEvent(ended, { type: 'backToLobby' });
    const lm = hudModel(lobby, 'a', 0);
    expect(lm.turnText).toBe('Aula');
    expect(lm.inRound).toBe(false);
    expect(lm.title).toBe('');
    const countdown = applyEvent(lobby, { type: 'countdownStarted', endsAtMs: 10_000 });
    expect(hudModel(countdown, 'a', 7_200).countdownSec).toBe(3);
    expect(hudModel(countdown, 'a', 12_000).countdownSec).toBe(0);
  });

  it('localises the turn text', () => {
    setLanguage('en');
    try {
      expect(hudModel(state, 'b', 0).turnText).toBe('Your turn');
      expect(hudModel(state, 'a', 0).turnText).toBe('Turn: Bertta');
    } finally {
      setLanguage('fi');
    }
  });
});

describe('hudModel in single player', () => {
  it('works from createSinglePlayerState and caps at the stroke limit', () => {
    let s = createSinglePlayerState([course('Lyhyt', 2, 3)], player('me', 'Minä', 2, 1));
    expect(hudModel(s, 'me', 0).turnText).toBe('Aula');
    s = applyEvent(s, { type: 'countdownStarted', endsAtMs: 0 });
    s = applyEvent(s, { type: 'gameStarted', seatOrder: ['me'] });
    s = applyEvent(s, { type: 'holeStarted', holeIndex: 0, order: ['me'] });
    s = shot(s, 'me', 1, 'stopped');
    s = shot(s, 'me', 2, 'mine');     // +1 penalty => 3 = max strokes => done
    const m = hudModel(s, 'me', 0);
    expect(m.hole).toBe('1/1');
    expect(m.strokes).toBe('3');
    expect(m.strokesOver).toBe(true);
    expect(m.chips).toHaveLength(1);
    expect(m.chips[0]!.tag).toBe('done');
    expect(m.chips[0]!.host).toBe(true);
    expect(m.timer).toBeNull();
  });
});
