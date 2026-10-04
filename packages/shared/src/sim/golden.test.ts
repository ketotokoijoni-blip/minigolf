// Golden shots (DESIGN §9.7): deterministic end states of scripted shots on the WP-B test courses, keyed by
// SIM_VERSION. Regenerate deliberately with `npm run test:golden-update` (GOLDEN_UPDATE=1); any other run compares.
// Phase 2 (after WP-A lands) adds the nine built-in courses here.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SIM_VERSION } from '../constants';
import type { Vec2 } from '../course/types';
import { validateShot } from './shot';
import { simulateShot } from './simulate';
import { freshWorld, testCourse } from './testCourses';
import { resetSimTuning } from './tuning';
import type { ShotInput, ShotResult } from './types';
import { createBallAt } from './worldState';

interface GoldenShot {
  course: string;
  from: Vec2;
  shot: ShotInput;
  expect: { ticks: number; result: ShotResult; penalty: 0 | 1; checksum: number };
}
interface GoldenFile { simVersion: number; shots: GoldenShot[] }

const FIXTURE = join(dirname(fileURLToPath(import.meta.url)), '__fixtures__', 'golden-shots.json');
const UPDATE = process.env['GOLDEN_UPDATE'] === '1';
const HOW_TO = 'run `npm run test:golden-update` to regenerate sim/__fixtures__/golden-shots.json';

/** The scripted shots. `from` defaults to the course start. */
const SPECS: { course: string; from?: Vec2; shot: ShotInput }[] = [
  { course: 'test:open', shot: { dx: 12000, dy: 0 } },
  { course: 'test:open', shot: { dx: 8000, dy: -6000 } },
  { course: 'test:open', shot: { dx: -3000, dy: 9000 } },
  { course: 'test:open', shot: { dx: 11000, dy: 2000 } },
  { course: 'test:open', from: { x: 600, y: 300 }, shot: { dx: -9000, dy: -7000 } },
  { course: 'test:arena', shot: { dx: 12000, dy: 0 } },
  { course: 'test:arena', shot: { dx: 10000, dy: -3000 } },
  { course: 'test:arena', shot: { dx: 9000, dy: 4000 } },
  { course: 'test:arena', from: { x: 450, y: 60 }, shot: { dx: 0, dy: 12000 } },
  { course: 'test:arena', from: { x: 630, y: 320 }, shot: { dx: -11000, dy: -4000 } },
  { course: 'test:corridors', shot: { dx: 12000, dy: 0 } },
  { course: 'test:corridors', shot: { dx: 9000, dy: 3000 } },
  { course: 'test:corridors', from: { x: 300, y: 37.5 }, shot: { dx: -12000, dy: 0 } },
  { course: 'test:corridors', from: { x: 712.5, y: 97.5 }, shot: { dx: 0, dy: -12000 } },
  { course: 'test:corridors', from: { x: 112.5, y: 157.5 }, shot: { dx: 12000, dy: 0 } },
  { course: 'test:slopes', shot: { dx: 12000, dy: 0 } },
  { course: 'test:slopes', shot: { dx: 6000, dy: -6000 } },
  { course: 'test:slopes', shot: { dx: 3000, dy: 0 } },
  { course: 'test:slopes', from: { x: 600, y: 100 }, shot: { dx: -5000, dy: 5000 } },
  { course: 'test:slopes', from: { x: 367.5, y: 60 }, shot: { dx: 0, dy: 12000 } },
  { course: 'test:ice', shot: { dx: 12000, dy: 0 } },
  { course: 'test:ice', shot: { dx: 10000, dy: -6000 } },
  { course: 'test:ice', shot: { dx: 7000, dy: 7000 } },
  { course: 'test:ice', from: { x: 500, y: 200 }, shot: { dx: -11900, dy: 1000 } },
  { course: 'test:ice', from: { x: 100, y: 330 }, shot: { dx: 8400, dy: -8400 } },
];

function layersFor(key: string) {
  if (!key.startsWith('test:')) throw new Error(`golden: course '${key}' is not available in phase 1 (test courses only)`);
  return testCourse(key.slice('test:'.length));
}

function run(spec: { course: string; from?: Vec2; shot: ShotInput }): GoldenShot {
  const layers = layersFor(spec.course);
  const from = spec.from ?? { x: layers.start.x, y: layers.start.y };
  const o = simulateShot(layers, freshWorld(layers), createBallAt(from), spec.shot);
  return { course: spec.course, from, shot: spec.shot, expect: { ticks: o.ticks, result: o.result, penalty: o.penalty, checksum: o.checksum } };
}

describe('golden shots', () => {
  it('every scripted shot is a valid ShotInput', () => {
    for (const s of SPECS) expect(validateShot(s.shot), JSON.stringify(s.shot)).toBe(true);
  });

  it(UPDATE ? 'regenerates the fixture (GOLDEN_UPDATE=1)' : 'matches the fixture', () => {
    resetSimTuning();
    if (UPDATE) {
      const file: GoldenFile = { simVersion: SIM_VERSION, shots: SPECS.map(run) };
      mkdirSync(dirname(FIXTURE), { recursive: true });
      writeFileSync(FIXTURE, JSON.stringify(file, null, 2) + '\n');
      return;
    }
    expect(existsSync(FIXTURE), `fixture missing; ${HOW_TO}`).toBe(true);
    const file = JSON.parse(readFileSync(FIXTURE, 'utf8')) as GoldenFile;
    expect(file.simVersion, `fixture was generated for SIM_VERSION ${file.simVersion}, code is ${SIM_VERSION}; ${HOW_TO}`).toBe(SIM_VERSION);
    expect(file.shots.length, `fixture has ${file.shots.length} shots, the test defines ${SPECS.length}; ${HOW_TO}`).toBe(SPECS.length);
    file.shots.forEach((golden, i) => {
      const actual = run(SPECS[i]!);
      const label = `shot ${i} (${golden.course} from ${JSON.stringify(golden.from)} ${JSON.stringify(golden.shot)})`;
      expect({ course: actual.course, from: actual.from, shot: actual.shot }, `${label}: the scripted shots changed; ${HOW_TO}`)
        .toEqual({ course: golden.course, from: golden.from, shot: golden.shot });
      expect(actual.expect, `${label}: sim result drifted; if intended, bump SIM_VERSION and ${HOW_TO}`).toEqual(golden.expect);
    });
  });
});
