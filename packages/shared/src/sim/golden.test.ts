// Golden shots (DESIGN §9.7): deterministic end states of scripted shots on the WP-B test courses, keyed by
// SIM_VERSION. Regenerate deliberately with `npm run test:golden-update` (GOLDEN_UPDATE=1); any other run compares.
// Phase 2: the nine built-in courses (course/builtin.ts, decoded with WP-A decodeLayers) with five shots each, chosen
// so the results vary (stopped, holed, water, acid, mine, timeout; teleports, breaks, pushed blocks, bumpers).
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { SIM_VERSION } from '../constants';
import { findBuiltin } from '../course/builtin';
import { decodeLayers } from '../course/parse';
import type { CourseLayers, Vec2 } from '../course/types';
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
  // --- built-ins (phase 2); `from` defaults to the course start, other positions are px centres on free tiles ---
  { course: 'b_01', shot: { dx: 12000, dy: 0 } },                                  // straight through the sand strip
  { course: 'b_01', shot: { dx: 9000, dy: -7000 } },                               // upper lane, stub wall
  { course: 'b_01', shot: { dx: 3000, dy: 0 } },                                   // soft lay-up
  { course: 'b_01', from: { x: 450, y: 100 }, shot: { dx: 10900, dy: 5000 } },     // bank off the bottom wall toward the cup
  { course: 'b_01', from: { x: 600, y: 187.5 }, shot: { dx: 2000, dy: 0 } },       // short putt
  { course: 'b_02', shot: { dx: 12000, dy: 0 } },                                  // along the corridor into the diagonal bank
  { course: 'b_02', shot: { dx: 11883, dy: -1670 } },                              // the bank line that reaches the cup
  { course: 'b_02', shot: { dx: 6000, dy: 0 } },                                   // too soft for the corner
  { course: 'b_02', from: { x: 307.5, y: 200 }, shot: { dx: 0, dy: -9000 } },      // up the shaft into the sand pocket
  { course: 'b_02', from: { x: 262.5, y: 330 }, shot: { dx: 9000, dy: 6000 } },    // into the SW corner diagonal
  { course: 'b_03', shot: { dx: 12000, dy: 0 } },                                  // full power across the ice and slopes
  { course: 'b_03', shot: { dx: 8560, dy: -2781 } },                               // bank line to the cup
  { course: 'b_03', shot: { dx: 5000, dy: 0 } },                                   // dies on the ice between the slopes
  { course: 'b_03', from: { x: 247.5, y: 187.5 }, shot: { dx: 1000, dy: 0 } },     // released on the south-pushing slope
  { course: 'b_03', from: { x: 650, y: 187.5 }, shot: { dx: -9000, dy: 0 } },      // back onto the ice from the hole pocket
  { course: 'b_04', shot: { dx: 12000, dy: 0 } },                                  // full power along the isthmus
  { course: 'b_04', shot: { dx: 10000, dy: -5000 } },                              // into the pond (water)
  { course: 'b_04', shot: { dx: 8900, dy: -8000 } },                              // over the top route
  { course: 'b_04', from: { x: 247.5, y: 180 }, shot: { dx: 11950, dy: 1000 } },   // isthmus, slightly off line
  { course: 'b_04', from: { x: 400, y: 345 }, shot: { dx: 10300, dy: -6000 } },    // lower route through the sand corner
  { course: 'b_05', shot: { dx: 6741, dy: 3288 } },                                // pad B onto the ice lane
  { course: 'b_05', shot: { dx: 8000, dy: -4000 } },                               // pad A into the sand chamber
  { course: 'b_05', shot: { dx: 12000, dy: 0 } },                                  // straight into the dividing wall
  { course: 'b_05', from: { x: 450, y: 97.5 }, shot: { dx: 12000, dy: 0 } },       // along the ice lane at the cup
  { course: 'b_05', from: { x: 600, y: 300 }, shot: { dx: -10300, dy: -6000 } },   // from the sand bed back toward pad A's exit
  { course: 'b_06', shot: { dx: 10900, dy: -5000 } },                              // through the attractor's field
  { course: 'b_06', shot: { dx: 7053, dy: -9708 } },                               // around the inner wall
  { course: 'b_06', from: { x: 337.5, y: 230 }, shot: { dx: 0, dy: -5000 } },      // pulled up into the acid moat
  { course: 'b_06', from: { x: 517.5, y: 350 }, shot: { dx: 0, dy: -4000 } },      // against the repeller
  { course: 'b_06', from: { x: 600, y: 187.5 }, shot: { dx: 6000, dy: 0 } },       // approach to the cup
  { course: 'b_07', shot: { dx: 12000, dy: 0 } },                                  // breaks the 1-hit block
  { course: 'b_07', shot: { dx: 11000, dy: -4000 } },                              // dents a 3-hit block
  { course: 'b_07', from: { x: 380.3, y: 140 }, shot: { dx: 6000, dy: -10392 } },  // 2nd shot of the par line: bank off the top wall into the cup
  { course: 'b_07', from: { x: 337.5, y: 187.5 }, shot: { dx: 12000, dy: 0 } },    // pushes the movable block through the sand
  { course: 'b_07', from: { x: 442.5, y: 187.5 }, shot: { dx: 6000, dy: 0 } },     // pushes the movable block from the sand
  { course: 'b_08', shot: { dx: 12000, dy: 0 } },                                  // through the entry gate, over the tar
  { course: 'b_08', shot: { dx: 6000, dy: 0 } },                                   // enters the castle and stops
  { course: 'b_08', from: { x: 270, y: 187.5 }, shot: { dx: 6000, dy: -4000 } },    // inside the castle, into the upper mine
  { course: 'b_08', from: { x: 300, y: 150 }, shot: { dx: 500, dy: 11900 } },      // bumper ping-pong between the castle walls: 30 s timeout
  { course: 'b_08', from: { x: 600, y: 187.5 }, shot: { dx: 5000, dy: 0 } },       // the final approach
  { course: 'b_09', shot: { dx: 12000, dy: 0 } },                                  // along the bottom edge through the teleporter
  { course: 'b_09', shot: { dx: 7294, dy: 7553 } },                                // bank off the bottom wall up the slope lane
  { course: 'b_09', from: { x: 127.5, y: 250 }, shot: { dx: 0, dy: -12000 } },     // up the slope lane toward the mines and hole A
  { course: 'b_09', from: { x: 690, y: 120 }, shot: { dx: 2000, dy: -11800 } },    // up the right edge into the acid pocket
  { course: 'b_09', from: { x: 660, y: 120 }, shot: { dx: 1000, dy: -11950 } },    // up the right edge toward the bank and hole B
];

const layerCache: Record<string, CourseLayers> = {};

/** 'test:<name>' -> WP-B test course; 'b_NN' -> built-in decoded with WP-A decodeLayers (cached; layers are immutable). */
function layersFor(key: string): CourseLayers {
  const cached = layerCache[key];
  if (cached !== undefined) return cached;
  let layers: CourseLayers;
  if (key.startsWith('test:')) {
    layers = testCourse(key.slice('test:'.length));
  } else {
    const course = findBuiltin(key);
    if (course === undefined) throw new Error(`golden: unknown course '${key}'`);
    layers = decodeLayers(course);
  }
  layerCache[key] = layers;
  return layers;
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
