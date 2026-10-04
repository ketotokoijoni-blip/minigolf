import { describe, expect, it } from 'vitest';
import { COURSE_H, COURSE_W } from '../constants';
import { BUILTIN_COURSES, BUILTIN_SET_NAME, findBuiltin } from './builtin';
import { canonicalCourseJson, courseByteLength } from './canonical';
import { tileIndex } from './grid';
import { decodeLayers } from './parse';
import { isHoleReachable, reachableTiles } from './reachability';
import { validateCourse } from './validate';

/** Expected table from docs/COURSES.md. */
const EXPECTED: { id: string; name: string; par: number }[] = [
  { id: 'b_01', name: 'Ensiputti', par: 2 },
  { id: 'b_02', name: 'Kulmakivi', par: 2 },
  { id: 'b_03', name: 'Jäätie', par: 3 },
  { id: 'b_04', name: 'Lampi', par: 3 },
  { id: 'b_05', name: 'Portaali', par: 3 },
  { id: 'b_06', name: 'Magneettilaakso', par: 3 },
  { id: 'b_07', name: 'Murtuva muuri', par: 4 },
  { id: 'b_08', name: 'Pomppulinna', par: 3 },
  { id: 'b_09', name: 'Finaali', par: 4 },
];

const count = (rows: string[], chars: string): number => rows.join('').split('').filter((c) => chars.includes(c)).length;
const byId = (id: string) => BUILTIN_COURSES.find((c) => c.id === id)!;

describe('built-in courses', () => {
  it('are 9 courses in play order with ids b_01..b_09, names and pars from docs/COURSES.md, total par 27', () => {
    expect(BUILTIN_SET_NAME).toBe('Perusradat');
    expect(BUILTIN_COURSES.length).toBe(9);
    expect(BUILTIN_COURSES.map((c) => ({ id: c.id, name: c.name, par: c.rules.par }))).toEqual(EXPECTED);
    expect(BUILTIN_COURSES.reduce((s, c) => s + c.rules.par, 0)).toBe(27);
    for (const c of BUILTIN_COURSES) {
      expect(c.author).toBe('Puttipeli');
      expect(c.rules.maxStrokes).toBe(20);
      expect(c.format).toBe('puttipeli-course');
      expect(c.formatVersion).toBe(1);
    }
  });

  it('have a one-sentence Finnish description', () => {
    for (const c of BUILTIN_COURSES) {
      expect(c.description.length).toBeGreaterThan(10);
      expect(c.description.length).toBeLessThanOrEqual(200);
      expect(c.description.endsWith('.') || c.description.endsWith('?')).toBe(true);
    }
  });

  it('have 25 rows x 49 chars per layer and a full-wall border ring', () => {
    for (const c of BUILTIN_COURSES) {
      expect(c.surface.length).toBe(COURSE_H);
      expect(c.walls.length).toBe(COURSE_H);
      for (const row of [...c.surface, ...c.walls]) expect(row.length).toBe(COURSE_W);
      expect(c.walls[0]).toBe('#'.repeat(COURSE_W));
      expect(c.walls[COURSE_H - 1]).toBe('#'.repeat(COURSE_W));
      for (const row of c.walls) {
        expect(row.charAt(0)).toBe('#');
        expect(row.charAt(COURSE_W - 1)).toBe('#');
      }
    }
  });

  it('validate with zero errors, no UNREACHABLE_HOLE warning and are reachable', () => {
    for (const c of BUILTIN_COURSES) {
      const issues = validateCourse(c);
      expect(issues.filter((i) => i.level === 'error'), c.id).toEqual([]);
      expect(issues.map((i) => i.code), c.id).not.toContain('UNREACHABLE_HOLE');
      expect(isHoleReachable(decodeLayers(c)), c.id).toBe(true);
    }
  });

  it('are at most 32 KB each (canonical and pretty forms)', () => {
    for (const c of BUILTIN_COURSES) {
      expect(courseByteLength(c), c.id).toBeLessThanOrEqual(32 * 1024);
      expect(canonicalCourseJson(c).length, c.id).toBeLessThanOrEqual(32 * 1024);
      expect(JSON.stringify(c, null, 2).length, c.id).toBeLessThanOrEqual(32 * 1024);
    }
  });

  it('findBuiltin finds by id and returns undefined otherwise', () => {
    expect(findBuiltin('b_05')?.name).toBe('Portaali');
    expect(findBuiltin('b_10')).toBeUndefined();
    expect(findBuiltin('c_0000000000000000')).toBeUndefined();
  });

  it('declare the mechanic tiles and objects of docs/COURSES.md', () => {
    const objs = (id: string, type: string) => byId(id).objects.filter((o) => o.type === type);

    // b_01: sand only, no special walls, one hole
    expect(count(byId('b_01').surface, 's')).toBeGreaterThan(0);
    expect(count(byId('b_01').surface, 'itwa8624')).toBe(0);
    expect(count(byId('b_01').walls, '7931xyzMO^>v<')).toBe(0);

    // b_02: triangles and sand
    expect(count(byId('b_02').walls, '7931')).toBeGreaterThan(0);
    expect(count(byId('b_02').surface, 's')).toBeGreaterThan(0);

    // b_03: ice and both slope directions
    expect(count(byId('b_03').surface, 'i')).toBeGreaterThan(0);
    expect(count(byId('b_03').surface, '2')).toBeGreaterThan(0);
    expect(count(byId('b_03').surface, '8')).toBeGreaterThan(0);

    // b_04: water and sand
    expect(count(byId('b_04').surface, 'w')).toBeGreaterThan(20);
    expect(count(byId('b_04').surface, 's')).toBeGreaterThan(0);

    // b_05: exactly 4 teleport pads in groups 0 and 1, ice, sand
    const pads = objs('b_05', 'teleport') as { group: number }[];
    expect(pads.length).toBe(4);
    expect(pads.filter((p) => p.group === 0).length).toBe(2);
    expect(pads.filter((p) => p.group === 1).length).toBe(2);
    expect(count(byId('b_05').surface, 'i')).toBeGreaterThan(0);
    expect(count(byId('b_05').surface, 's')).toBeGreaterThan(0);

    // b_06: one attract and one repel magnet, acid
    const magnets = objs('b_06', 'magnet') as { polarity: number }[];
    expect(magnets.map((m) => m.polarity).sort()).toEqual([-1, 1]);
    expect(count(byId('b_06').surface, 'a')).toBeGreaterThan(0);

    // b_07: breakable x and z, one movable, sand
    expect(count(byId('b_07').walls, 'x')).toBe(1);
    expect(count(byId('b_07').walls, 'z')).toBeGreaterThan(10);
    expect(count(byId('b_07').walls, 'M')).toBe(1);
    expect(count(byId('b_07').surface, 's')).toBeGreaterThan(0);

    // b_08: bumpers, one-way gates, two mines, tar
    expect(count(byId('b_08').walls, 'O')).toBeGreaterThan(10);
    expect(count(byId('b_08').walls, '>')).toBe(2);
    expect(objs('b_08', 'mine').length).toBe(2);
    expect(count(byId('b_08').surface, 't')).toBeGreaterThan(0);

    // b_09: two holes and every mechanic
    expect(objs('b_09', 'hole').length).toBe(2);
    expect(objs('b_09', 'teleport').length).toBe(2);
    expect(objs('b_09', 'magnet').length).toBe(1);
    expect(objs('b_09', 'mine').length).toBe(2);
    const s9 = byId('b_09').surface;
    const w9 = byId('b_09').walls;
    for (const ch of 'sitwa8') expect(count(s9, ch), `surface ${ch}`).toBeGreaterThan(0);
    for (const ch of '9yMO^') expect(count(w9, ch), `wall ${ch}`).toBeGreaterThan(0);
  });

  it('every object sits on a legal tile (magnets on full walls, others on open non-hazard tiles)', () => {
    for (const c of BUILTIN_COURSES) {
      for (const o of c.objects) {
        const wall = c.walls[o.y]!.charAt(o.x);
        const surf = c.surface[o.y]!.charAt(o.x);
        if (o.type === 'magnet') expect(wall, `${c.id} magnet`).toBe('#');
        else {
          expect(wall, `${c.id} ${o.type}`).toBe('.');
          expect('wa'.includes(surf), `${c.id} ${o.type} on liquid`).toBe(false);
          if (o.type !== 'mine') expect(surf, `${c.id} ${o.type} on tar`).not.toBe('t');
        }
      }
    }
  });

  it('every hole tile and every teleport pad of every built-in is reachable from the start (BFS of §7.6)', () => {
    for (const c of BUILTIN_COURSES) {
      const layers = decodeLayers(c);
      const seen = reachableTiles(layers);
      for (const h of layers.holes) expect(seen[h.tile], `${c.id} hole at tile ${h.tile}`).toBe(1);
      for (const p of layers.teleports) expect(seen[p.tile], `${c.id} teleport pad at tile ${p.tile}`).toBe(1);
    }
  });

  it('b_09 Finaali: the start joins the teleporter pocket, the right half is reached only through the portal', () => {
    const c = byId('b_09');
    const layers = decodeLayers(c);
    const seen = reachableTiles(layers);
    expect(seen[tileIndex(20, 20)]).toBe(1); // group-0 pad in the bottom-right pocket
    expect(seen[tileIndex(30, 10)]).toBe(1); // its partner on the ice ramp
    expect(seen[tileIndex(45, 4)]).toBe(1); // hole B
    expect(seen[tileIndex(14, 4)]).toBe(1); // hole A
    expect(seen[tileIndex(44, 12)]).toBe(1); // tar landing
    // Without the portal edge the right half (ramp, landing, hole B) is sealed off by water and the row-14 wall.
    const noPortal = reachableTiles({ ...layers, teleports: [] });
    expect(noPortal[tileIndex(30, 10)]).toBe(0);
    expect(noPortal[tileIndex(45, 4)]).toBe(0);
    expect(noPortal[tileIndex(14, 4)]).toBe(1);
    // Row 14 still forces hole A through the slope lane: nothing east of x=13 on rows 15-18 leads north.
    for (let x = 13; x <= 47; x++) expect(c.walls[14]!.charAt(x), `(${x},14)`).toBe('#');
    for (let y = 19; y <= 23; y++) expect(c.walls[y]!.charAt(13), `(13,${y})`).toBe('.');
  });

  it('b_06 Magneettilaakso: the S bends the obvious line high past x=13 and low past x=31', () => {
    const c = byId('b_06');
    for (let y = 11; y <= 23; y++) expect(c.walls[y]!.charAt(13), `(13,${y})`).toBe('#');
    for (let y = 1; y <= 10; y++) expect(c.walls[y]!.charAt(13), `(13,${y})`).toBe('.');
    for (let y = 1; y <= 14; y++) expect(c.walls[y]!.charAt(31), `(31,${y})`).toBe('#');
    for (let y = 15; y <= 23; y++) expect(c.walls[y]!.charAt(31), `(31,${y})`).toBe('.');
    // The straight start->hole line (row 12) is blocked; the course is still reachable (checked above).
    expect(c.walls[12]!.charAt(13)).toBe('#');
    // Rows 15-22 of the x=31 gap lie inside the repeller field (34,18) r=75 px; only the bottom-wall row 23 passes
    // outside it (the designed "hug the bottom wall" escape of docs/COURSES.md).
    const TILE = 15;
    const dist = (x: number, y: number, mx: number, my: number): number => Math.hypot((x - mx) * TILE, (y - my) * TILE);
    for (let y = 15; y <= 22; y++) expect(dist(31, y, 34, 18), `(31,${y})`).toBeLessThanOrEqual(75);
    expect(dist(31, 23, 34, 18)).toBeGreaterThan(75);
    // The attractor (22,6) r=90 covers the upper half of the middle zone the high gap feeds into.
    for (let y = 1; y <= 10; y++) expect(dist(22, y, 22, 6), `(22,${y})`).toBeLessThanOrEqual(90);
  });

  it('b_08 Pomppulinna: the one-way gate at (16,12) is the only way east across x=16', () => {
    const c = byId('b_08');
    for (let y = 1; y <= 23; y++) {
      const ch = c.walls[y]!.charAt(16);
      if (y === 12) expect(ch).toBe('>');
      else expect(ch, `(16,${y})`).not.toBe('.');
    }
  });

  it('BUILTIN_COURSES holds typed Course objects that decode', () => {
    for (const c of BUILTIN_COURSES) {
      const l = decodeLayers(c);
      expect(l.holes.length).toBeGreaterThanOrEqual(1);
      expect(l.startTile).toBeGreaterThanOrEqual(0);
    }
  });
});
