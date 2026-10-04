import { describe, expect, it } from 'vitest';
import { parseHash, matchPattern, matchRoute } from './router';

describe('parseHash', () => {
  it('normalizes empty and root hashes', () => {
    expect(parseHash('').path).toBe('/');
    expect(parseHash('#').path).toBe('/');
    expect(parseHash('#/').path).toBe('/');
    expect(parseHash('#/play/').path).toBe('/play');
    expect(parseHash('play').path).toBe('/play');
  });

  it('splits the query', () => {
    const p = parseHash('#/room/K7PQ2?spectate=1&name=Ville%20V');
    expect(p.path).toBe('/room/K7PQ2');
    expect(p.query.get('spectate')).toBe('1');
    expect(p.query.get('name')).toBe('Ville V');
    expect(parseHash('#/?x=1').path).toBe('/');
  });
});

describe('matchPattern', () => {
  it('matches static and parameter segments', () => {
    expect(matchPattern('#/', '/')).toEqual({});
    expect(matchPattern('#/play', '/play')).toEqual({});
    expect(matchPattern('#/room/:code', '/room/K7PQ2')).toEqual({ code: 'K7PQ2' });
    expect(matchPattern('#/room/:code', '/room/')).toBeNull();
    expect(matchPattern('#/room/:code', '/room')).toBeNull();
    expect(matchPattern('#/room/:code', '/room/A/B')).toBeNull();
    expect(matchPattern('#/play', '/settings')).toBeNull();
    expect(matchPattern('#/room/:code', '/room/a%20b')).toEqual({ code: 'a b' });
  });
});

describe('matchRoute', () => {
  const patterns = ['#/', '#/play', '#/room/:code', '#/room/new', '#/editor'];

  it('prefers static segments over parameters', () => {
    expect(matchRoute(patterns, '#/room/new')?.pattern).toBe('#/room/new');
    expect(matchRoute(patterns, '#/room/K7PQ2')?.pattern).toBe('#/room/:code');
    expect(matchRoute(patterns, '#/room/K7PQ2')?.params).toEqual({ code: 'K7PQ2' });
  });

  it('returns null for unknown hashes and keeps the query', () => {
    expect(matchRoute(patterns, '#/nope')).toBeNull();
    expect(matchRoute(patterns, '#/room/A/B')).toBeNull();
    const m = matchRoute(patterns, '#/play?tab=library');
    expect(m?.pattern).toBe('#/play');
    expect(m?.query.get('tab')).toBe('library');
    expect(matchRoute(patterns, '')?.pattern).toBe('#/');
  });
});
