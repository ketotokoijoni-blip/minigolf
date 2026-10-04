# Puttipeli — Final Design Document

Status: **FROZEN for implementation** (lead architect decision, based on Proposal 0 with grafts from Proposals 1 and 2 and all judge findings resolved).
Audience: implementation agents working in parallel on disjoint work packages (WP). Read §1 (decisions), §3 (layout + ownership), the contract code in §5–§6, your own WP in §15, and the sections your WP touches. Nothing here needs discussion between agents: every cross-module dependency is a type or function signature printed in this document.

Companion documents: `docs/COURSES.md` (the 9 built-in holes), `CLAUDE.md` (project rules — binding for every agent).

---

## 0. Table of contents

1. Key decisions and judge-finding resolutions
2. Goals, non-goals, vocabulary
3. Repository and package layout with file ownership
4. Toolchain: dev, typecheck, test, build
5. Shared contracts: constants and types (verbatim code)
6. Shared contracts: protocol (verbatim code)
7. Course format, validation, identity, editing ops
8. Physics: units, constants, algorithms (segments, diagonal walls, hole capture, objects)
9. Determinism rules and checksum
10. Game model: reducer, events, turn rules, state machines
11. Multiplayer server: rooms, authority, pacing, reconnection, spectators, limits
12. Client: screens, rendering, input, audio, settings
13. Course editor specification
14. Deployment: Dockerfile, Fly.io, Render, environment
15. Work packages, file ownership, dependencies, acceptance criteria
16. Testing plan
17. Risks and explicit trade-offs

---

## 1. Key decisions and judge-finding resolutions

| # | Decision | Origin |
|---|----------|--------|
| D1 | **The simulation is the spine.** One pure `simulateShot()` in `@puttipeli/shared` is called by single player, editor test play, every multiplayer client (for animation) and the authoritative server. Clients send only an integer shot vector. | P0 |
| D2 | **One pure game reducer** (`applyEvent(state, event)`) in shared drives single player, server and all clients. `GameState` *is* the reconnect/late-join snapshot; there are no separate snapshot formats. | P0, judge 3 |
| D3 | **Segment-based collision with shared-edge culling**, derived at runtime from the mutable `walls` array for the 3×3 neighbourhood; closest-point-on-segment; deepest-penetration-first with re-query; implicit solid border ring. Replaces P0's per-tile AABB closest point (judge 1 weakness 2). | P1, P2, judge 1 graft 1 |
| D4 | **Fixed time step 120 Hz with exactly 3 substeps (360 Hz).** Max speed 900 px/s ⇒ ≤ 2.5 px per substep < ball radius 6 ⇒ no tunnelling, no speed-dependent branch. | P0 + judge 3 graft 8 |
| D5 | **`insideOneWay` ball state** so a ball that legitimately entered a one-way block and stops or is reversed is never wedged (judge 1 weakness 3). | P2 |
| D6 | **`turnSeq` on `turnStarted` and `shoot`**; the server rejects stale shots (judge 1 weakness 4). | P1 |
| D7 | **Turn timeout = +1 stroke, no ball movement, turn passes.** Two consecutive timeouts set `afk`, after which that player's turns get a 5 s deadline until they send any message. A *disconnected* player's turn waits 10 s and is then skipped **without** a stroke; after 60 s of disconnection the player is removed. (Replaces P0's "max strokes on timeout", judge 1 weakness 5, judge 2.) | P1, judges |
| D8 | **Build chain:** `@puttipeli/shared` is consumed as TypeScript **source** everywhere (Vite for the client, esbuild bundle for the server with `ws` external, course JSON inlined). `tsc -b` is typecheck-only (`emitDeclarationOnly` to an ignored folder). No dual src/dist exports, no Node JSON-import-attribute problem (judge 1 weakness 1, judge 3 weakness). | P1, P2 |
| D9 | **Docker runtime stage** copies the *pruned* lockfile-driven `node_modules` from the build stage (`npm ci` → build → `npm prune --omit=dev`), plus the two `dist` folders. No `npm install ws@^8`, no `npm ci -w` with missing workspaces. | P0, judges |
| D10 | **`SIM_VERSION` and `PROTOCOL_VERSION`** are sent in `hello`; mismatch ⇒ `BAD_VERSION` and the client shows "Päivitä sivu". Golden fixtures are keyed by `SIM_VERSION`. | P2 |
| D11 | **Pure editor operations in shared** (`course/edit.ts`): `setSurface`, `setWall`, `placeObject`, `removeObjectAt`, `fillRect`, `floodFill`, `line`, `createBlankCourse`. The DOM editor is a thin shell. | P2 |
| D12 | **Course solvability golden test**: a scripted shot sequence per built-in course must hole out in ≤ par + 2. | P2 |
| D13 | **Flat course model kept:** two character layers (surface, walls) + object list. Breakable hit counts are wall characters `x`/`y`/`z` (1/2/3 hits) instead of a fixed 3. Magnets and teleporters carry their properties as objects. No WallShape×WallMaterial split (judge 3 found it over-indirect; judge 2's goals are met by `x/y/z` + object properties). | P0 + P1 |
| D14 | **Tuning:** pull cap 120 px, `POWER_SCALE` 5.5 ⇒ max launch 660 px/s; grass deceleration 200 px/s² ⇒ full-power roll ≈ 1 089 px ≈ 1.5 field widths (crosses the field and rebounds). All tunables in `constants.ts`; the sim reads its numeric tunables through the mutable `simTuning` object in `sim/tuning.ts` (defaults copied from `constants.ts`) so the single-player developer tuning panel (`#/dev`) can tweak them live without a rebuild; the server and multiplayer never call `setSimTuning`. Golden fixtures regenerate deliberately with `npm run test:golden-update`. | judges 1, 2 |
| D15 | **Course id** = `c_` + two FNV-1a 32-bit hashes (different offset bases) of the canonical JSON, 16 hex chars. No BigInt. Built-ins are `b_01`…`b_09`. | judge 1 |
| D16 | **Every unit-vector computation guards `d == 0`** (hole pull, teleport exit offset, magnet, collision normal falls back to the segment normal). | judge 1 |
| D17 | **Hole rule:** funnel pull inside 10 px when slower than 400 px/s + capture when `d ≤ 5.5 px` and `speed ≤ 220 px/s`. A fast ball is bent by the pull but not captured (the "lip"). No separate kick rule and no extra per-pass flag (judge 3's minimal-mechanism argument). | P0/P2 |
| D18 | **Breakable hit debounce** (same tile within 12 ticks ignored) + minimum impact speed 120 px/s; **bumper minimum exit speed** 220 px/s; **movable block refuses** a target tile containing another ball; **bounce events only** above 40 px/s. | P1 |
| D19 | **Chat system lines** are `{ key, params }`, localized by the client. **Room codes** use a 32-character alphabet without `I`, `O`, `0`, `1`; input is normalized by trimming, uppercasing and removing spaces/hyphens (no character substitution — the ambiguous characters never occur in a code, so typing one is simply an invalid code). | P1 |
| D20 | **Scope trimmed for v1:** no kick, no per-IP join rate limit, no OffscreenCanvas branch (plain hidden canvas), no ghost-path prediction in multiplayer (single-player optional guide only), no optimistic shot start (animation begins on the authoritative `shotTaken` event), ball–ball collision **not** implemented (room option shown greyed "tulossa"). Spectators = late joiner that receives the snapshot, can chat, cannot shoot, can take a free seat in the lobby. Host migration kept (a few reducer lines). | judge 3 graft 9 |
| D21 | **Mines** are consumed for the rest of the hole when triggered (ball → pre-shot position, +1) and re-armed each hole; deterministic, strategic, no randomness. | P0 |
| D22 | **Reachability** (start → any hole by flood fill through non-blocking tiles with teleporter edges) is a **warning**, never an error, so courses that require breaking a wall or using a one-way gate are legal. | P0, judge 1 graft 5 |
| D23 | **Fly.io** always-on single machine in `arn` (Stockholm) is the recommended host; `fly.toml` documents the near-zero-cost suspend mode side by side. `render.yaml` ships as the free alternative. The agent never deploys (CLAUDE.md). | all |
| D24 | **Tests are co-located** (`packages/**/src/**/*.test.ts`, node environment, matches the existing `vitest.config.ts`). Client tests are pure logic (no jsdom). | scaffold |
| D25 | **Enums as `as const` objects** + union types (bundler and type-stripper friendly; no TS `enum`). | P2 |
| D26 | **Screens and dictionaries self-register** (`import.meta.glob('./**/*.screen.ts', { eager: true })` in `main.ts`; `registerDictionary()` at module import). This is what makes WP file ownership strictly disjoint — nobody edits a central route table or string table. | lead |
| D27 | **Deep imports, no growing barrel:** `@puttipeli/shared/<path>` via `exports: { "./*": "./src/*.ts" }`. `src/index.ts` re-exports only the WP0 contract modules, so it never needs editing by another WP. | lead |
| D28 | **Everything that two or more M1 packages need at runtime is WP0:** tile/grid helpers (`course/grid.ts`), shot quantization/validation (`sim/shot.ts`), the sim tuning object (`sim/tuning.ts`) and world/ball construction (`sim/worldState.ts`). M1 packages depend on WP0 only; M2 packages may depend on M1 packages as listed in §15. | completeness review |
| D29 | **Unresolved-situation rules** (all specified in §10.5–§10.8): a ball at rest on a slope stays put until it is shot; a slow ball held by a magnet or a slope rests after `FORCED_STOP_TICKS`; `'timeout'` is scored like `'stopped'`; holed and max-stroke balls leave the field (not drawn, not an obstacle); a host who disconnects keeps the host role during grace, `hostChanged` fires on removal, and the round summary returns to the lobby automatically so a missing host never blocks a room; a course without a hole is rejected by validation before it can reach any authority. | completeness review |

---

## 2. Goals, non-goals, vocabulary

**Goals (v1):** 2D top-down tile minigolf in the browser; main menu with Yksinpeli / Moninpeli / Rataeditori / Ohjeet / Asetukset; 9 original built-in courses; course editor with test play, save/load (localStorage + JSON file), custom courses playable in single player and multiplayer; turn-based online multiplayer for 2–4 players (rooms with 5-character codes, lobby chat, ready-up, scorecard); one Node process serving the static client and the WebSocket endpoint; Dockerfile + Fly.io/Render configuration; Finnish UI (English optional), English code.

**Non-goals (v1):** accounts, persistence of rooms across restarts, ranking ladders, ball–ball collision, simultaneous-shot mode, mobile-first layout (touch is best-effort), sound assets (sounds are synthesized), course sizes other than 49×25.

**Originality:** no assets, names, course files or text of any existing game are used. All art is procedural; course names and layouts are ours.

**Vocabulary:** *tile* (15×15 px cell), *field* (49×25 tiles = 735×375 px), *course* (one hole's data file), *course set* (ordered list of 1–18 courses played as a round), *hole index* (position in the set), *shot* (one click → integer pull vector), *stroke* (score unit; shot + penalties), *tick* (1/120 s), *substep* (1/360 s), *authority* (the component that runs `simulateShot` and emits `GameEvent`s: the server `Room`, or `localHost` in single player), *WP* (work package = one agent's ownership set).

---

## 3. Repository and package layout with file ownership

Every file has exactly one owner tag `[WP?]`. **A WP may create and edit only files tagged with its own id** (plus new `*.test.ts` files next to its own sources). The lead owns `CLAUDE.md`, `docs/*` and performs the M3 tuning pass on `constants.ts`. Files marked `(exists)` were created by the scaffold step and are adjusted by WP0 as described in §4.

```
C:\Users\ketot\projektit\minigolf\
├── CLAUDE.md                              [lead] (exists)
├── README.md                              [WP-J]
├── package.json                           [WP0]  (exists; scripts/devDeps updated per §4)
├── package-lock.json                      [WP0]  (exists; regenerated by npm install)
├── tsconfig.base.json                     [WP0]  (exists)
├── eslint.config.js                       [WP0]  sim determinism rule, see §9
├── vitest.config.ts                       [WP0]  (exists; add passWithNoTests)
├── .gitignore                             [WP0]  (exists; add .tsout/)
├── .dockerignore                          [WP-J]
├── .env.example                           [WP-J]
├── Dockerfile                             [WP-J]
├── fly.toml                               [WP-J]
├── render.yaml                            [WP-J]
├── docs/
│   ├── DESIGN.md                          [lead] this file
│   ├── COURSES.md                         [lead]
│   └── QA.md                              [WP-K] manual QA checklist (scaling, HiDPI, touch, 2-browser MP)
└── packages/
    ├── shared/                            @puttipeli/shared — DOM-free, deterministic, zero runtime deps
    │   ├── package.json                   [WP0]  exports { ".": "./src/index.ts", "./*": "./src/*.ts" }
    │   ├── tsconfig.json                  [WP0]
    │   └── src/
    │       ├── index.ts                   [WP0]  re-exports ONLY: constants, course/types, course/chars, course/grid, sim/types, sim/shot, sim/tuning,
    │       │                                     game/types, game/events, protocol/version, protocol/codes, protocol/limits, protocol/messages
    │       │                                     (never protocol/validate or protocol/roomCode — those are WP-C and do not exist at M0)
    │       ├── constants.ts               [WP0]  all tunables + SIM_VERSION (numbers changed only in the lead's tuning pass)
    │       ├── math/vec.ts                [WP0]  Vec2 helpers (sqrt only)
    │       ├── math/hash.ts               [WP0]  fnv1a32(str|bytes, offsetBasis?), hex8
    │       ├── math/rng.ts                [WP0]  xorshift32 (tests/cosmetics only, never in sim)
    │       ├── math/math.test.ts          [WP0]
    │       ├── course/types.ts            [WP0]  Course, Surface, WallShape, CourseObject, CourseLayers, ValidationIssue, CourseRef
    │       ├── course/chars.ts            [WP0]  char <-> code tables for both layers
    │       ├── course/grid.ts             [WP0]  tileIndex, tileX, tileY, tileOf, tileCentre, inBounds (§7.2; needed by WP0/WP-B before WP-A exists)
    │       ├── course/parse.ts            [WP-A] decodeLayers, encodeLayers
    │       ├── course/canonical.ts        [WP-A] canonicalCourseJson, courseId
    │       ├── course/migrate.ts          [WP-A] parseCourseFile(unknown): ParseResult (structure check + version chain)
    │       ├── course/validate.ts         [WP-A] validateCourse(course): ValidationIssue[]
    │       ├── course/reachability.ts     [WP-A] isHoleReachable(layers): boolean (warning source)
    │       ├── course/edit.ts             [WP-A] pure editor ops (D11)
    │       ├── course/blank.ts            [WP-A] createBlankCourse(meta)
    │       ├── course/builtin.ts          [WP-A] BUILTIN_COURSES: Course[] (imports the 9 JSON files)
    │       ├── course/builtin/01-ensiputti.json … 09-finaali.json   [WP-A] (names per docs/COURSES.md)
    │       ├── course/parse.test.ts, canonical.test.ts, migrate.test.ts, validate.test.ts,
    │       │   reachability.test.ts, edit.test.ts, builtin.test.ts                 [WP-A]
    │       ├── sim/types.ts               [WP0]  BallState, WorldState, ShotInput, SimEvent, ShotOutcome, ShotSummary, WorldDelta, SimContext, ShotIterator
    │       ├── sim/worldState.ts          [WP0]  createWorld, createWorldFromCourse, cloneWorld, diffWorld, applyWorldDelta, createBallAt, startCentre (§10.1)
    │       ├── sim/worldState.test.ts     [WP0]
    │       ├── sim/shot.ts                [WP0]  quantizeShot, validateShot (used by client input, protocol validation and the sim)
    │       ├── sim/tuning.ts              [WP0]  simTuning mutable tunables + setSimTuning/resetSimTuning (§5.7)
    │       ├── sim/ball.ts                [WP-B] applyShot, cloneBall
    │       ├── sim/segments.ts            [WP-B] segment generation with shared-edge culling (§8.4)
    │       ├── sim/collision.ts           [WP-B] closestPointOnSegment, resolveCollisions (§8.5)
    │       ├── sim/surfaces.ts            [WP-B] friction, slope acceleration, stop rule
    │       ├── sim/objects.ts             [WP-B] hole pull/capture, teleport, magnet, mine, water/acid/tar
    │       ├── sim/step.ts                [WP-B] stepTick (§8.3)
    │       ├── sim/simulate.ts            [WP-B] simulateShot, createShotIterator, toShotSummary
    │       ├── sim/checksum.ts            [WP-B] hashSimState
    │       ├── sim/testCourses.ts         [WP-B] hand-built CourseLayers fixtures for tests (does not depend on WP-A)
    │       ├── sim/*.test.ts              [WP-B] collision, diagonal, friction, slopes, hole, hazards, teleport, magnet,
    │       │                                     breakable, movable, oneway, bumper, containment, determinism, golden
    │       ├── sim/__fixtures__/golden-shots.json   [WP-B]
    │       ├── sim/solvability.test.ts    [WP-K]
    │       ├── sim/__fixtures__/solvability.json    [WP-K]
    │       ├── game/types.ts              [WP0]  GameState, PlayerState, RoomSettings, TurnState, RankingEntry …
    │       ├── game/events.ts             [WP0]  GameEvent union
    │       ├── game/reducer.ts            [WP-C] applyEvent (pure)
    │       ├── game/turns.ts              [WP-C] holeOrder, nextTurnPlayer, isHoleComplete, activePlayers
    │       ├── game/scoring.ts            [WP-C] totals, toPar, ranking
    │       ├── game/selectors.ts          [WP-C] currentCourse, currentPlayer, ballOf, strokesOf, isMyTurn
    │       ├── game/initial.ts            [WP-C] createLobbyState(settings), createSinglePlayerState(courses, player), normalizeSettings
    │       ├── game/serialize.ts          [WP-C] gameStateToJson / gameStateFromJson (typed arrays <-> number[])
    │       ├── game/authority.ts          [WP-C] shared flow driver used by the server Room and the client localHost (§10.4)
    │       ├── game/*.test.ts             [WP-C]
    │       ├── protocol/version.ts        [WP0]  PROTOCOL_VERSION
    │       ├── protocol/messages.ts       [WP0]  ClientMessage / ServerMessage
    │       ├── protocol/codes.ts          [WP0]  ErrorCode
    │       ├── protocol/limits.ts         [WP0]  sizes, rates, caps
    │       ├── protocol/roomCode.ts       [WP-C] ROOM_CODE_ALPHABET, normalizeRoomCode, isRoomCode
    │       ├── protocol/validate.ts       [WP-C] parseClientMessage(raw): ClientMessage | null (hand-written guards)
    │       └── protocol/*.test.ts         [WP-C]
    ├── client/                            @puttipeli/client — Vite app, zero runtime deps
    │   ├── package.json                   [WP0]  (exists)
    │   ├── tsconfig.json                  [WP0]  (exists)
    │   ├── vite.config.ts                 [WP0]  (exists; add define __BUILD__, dev harness input)
    │   ├── index.html                     [WP0]  <div id="app"> + <script type="module" src="/src/main.ts"> + <link rel="icon" href="/favicon.svg">
    │   ├── public/favicon.svg             [WP-E]
    │   ├── dev/render.html, dev/render.ts [WP-D] standalone render harness (served by Vite at /dev/render.html)
    │   └── src/
    │       ├── main.ts                    [WP-E] boot: settings, language, import.meta.glob screens, router.start()
    │       ├── app/screen.ts              [WP0]  Screen interface + registerScreen (contract)
    │       ├── app/activeHost.ts          [WP0]  active GameHost slot + pending local game request (contract)
    │       ├── app/env.d.ts               [WP0]  declare const __BUILD__: string
    │       ├── app/router.ts              [WP-E] hash router over registered screens
    │       ├── app/store.ts               [WP-E] tiny observable store (profile, server status)
    │       ├── i18n/t.ts                  [WP0]  registerDictionary, t, setLanguage, getLanguage (contract)
    │       ├── i18n/fi.ts, en.ts          [WP-E] core strings
    │       ├── i18n/fi.mp.ts, en.mp.ts    [WP-H] multiplayer strings
    │       ├── i18n/fi.editor.ts, en.editor.ts [WP-I] editor strings
    │       ├── i18n/fi.dev.ts             [WP-K] tuning panel strings
    │       ├── storage/settings.ts        [WP-E] name, colour, volume, language, aimGuide, touchFireButton
    │       ├── storage/courseLibrary.ts   [WP-E] localStorage custom courses + editor draft (API in §13.6)
    │       ├── storage/courseLibrary.test.ts [WP-E]
    │       ├── render/palette.ts          [WP-D] colours (4 player colours, 8 teleport colours)
    │       ├── render/tileArt.ts          [WP-D] procedural art for every surface/wall/object
    │       ├── render/ballArt.ts          [WP-D]
    │       ├── render/aimLine.ts          [WP-D]
    │       ├── render/effects.ts          [WP-D] cosmetic particles
    │       ├── render/renderer.ts         [WP-D] static layer (hidden canvas) + dynamic layer
    │       ├── game/gameHost.ts           [WP0]  GameHost + ChatApi interfaces (contract)
    │       ├── game/camera.ts             [WP-D] fit-to-container, HiDPI, pointer -> world
    │       ├── game/loop.ts               [WP-D] rAF loop + 120 Hz accumulator
    │       ├── game/shotAnimator.ts       [WP-D] replays a shot with createShotIterator, emits SimEvents for sfx/effects
    │       ├── game/input.ts              [WP-D] pointer/keyboard/touch aiming -> ShotInput
    │       ├── game/input.test.ts         [WP-D]
    │       ├── game/localHost.ts          [WP-G] in-process authority (single player, test play)
    │       ├── game/controller.ts         [WP-G] GameController: binds host, renderer, input, HUD, animator
    │       ├── game/summaries.ts          [WP-G] hole/round summary overlays
    │       ├── game/game.screen.ts        [WP-G] route #/game
    │       ├── audio/sfx.ts               [WP-D] WebAudio synthesized sounds
    │       ├── ui/components.ts           [WP-E] el(), button(), list(), toast()
    │       ├── ui/hud.ts                  [WP-E] DOM HUD bound to GameState
    │       ├── ui/scorecard.ts            [WP-E] scorecard table component
    │       ├── ui/chat.ts                 [WP-E] chat panel bound to ChatApi
    │       ├── ui/dialogs.ts              [WP-E] in-page confirm/alert (no window.confirm)
    │       ├── ui/styles.css              [WP-E]
    │       ├── ui/mp.css                  [WP-H]
    │       ├── screens/mainMenu.screen.ts [WP-E] #/
    │       ├── screens/singleSetup.screen.ts [WP-E] #/play
    │       ├── screens/help.screen.ts     [WP-E] #/help
    │       ├── screens/settings.screen.ts [WP-E] #/settings
    │       ├── screens/mp.screen.ts       [WP-H] #/mp
    │       ├── screens/lobby.screen.ts    [WP-H] #/room/:code
    │       ├── screens/dev.screen.ts      [WP-K] #/dev tuning panel
    │       ├── net/socket.ts              [WP-H] WsClient
    │       ├── net/roomClient.ts          [WP-H] RoomSession implements GameHost + ChatApi
    │       ├── net/session.ts             [WP-H] sessionStorage tokens, recent rooms
    │       └── editor/
    │           ├── editor.screen.ts       [WP-I] #/editor
    │           ├── tools.ts               [WP-I] tool state machine over shared edit ops
    │           ├── palette.ts             [WP-I]
    │           ├── inspector.ts           [WP-I]
    │           ├── history.ts             [WP-I] undo/redo
    │           ├── importExport.ts        [WP-I] file download/upload, clipboard
    │           ├── testPlay.ts            [WP-I]
    │           ├── editor.css             [WP-I]
    │           └── tools.test.ts          [WP-I]
    └── server/                            @puttipeli/server — Node 24, runtime dep: ws only
        ├── package.json                   [WP0]  (exists; build -> node build.mjs, add esbuild devDep)
        ├── tsconfig.json                  [WP0]  (exists)
        ├── build.mjs                      [WP0]  esbuild bundle (§4.4)
        └── src/
            ├── index.ts                   [WP-F] boot: config, http, ws, graceful shutdown
            ├── config.ts                  [WP-F]
            ├── http.ts                    [WP-F] static files, /healthz, /api/stats, SPA fallback
            ├── log.ts                     [WP-F]
            ├── clock.ts                   [WP0]  Clock interface + systemClock (contract)
            ├── ws/transport.ts            [WP0]  Connection / Transport interfaces (contract)
            ├── ws/wsTransport.ts          [WP-F] real `ws` adapter, origin check, heartbeat
            ├── ws/fakeTransport.ts        [WP-F] in-memory test double
            ├── ws/connection.ts           [WP-F] parse + validate + rate limit + typed send
            ├── ws/gateway.ts              [WP-F] routes ClientMessage -> RoomManager / Room
            ├── rooms/codes.ts             [WP-F] generateRoomCode(crypto); imports ROOM_CODE_ALPHABET from shared/protocol/roomCode (no duplicate)
            ├── rooms/roomManager.ts       [WP-F]
            ├── rooms/room.ts              [WP-F] authority: reducer + simulateShot + timers
            ├── rooms/session.ts           [WP-F] tokens, grace, host migration helpers
            ├── rooms/courseStore.ts       [WP-F] CourseRef -> validated Course[]
            ├── rooms/*.test.ts, ws/*.test.ts [WP-F]
            └── integration.test.ts        [WP-K] real server on port 0 + 3 ws clients
```

---

## 4. Toolchain: dev, typecheck, test, build

### 4.1 Root `package.json` (WP0 updates the existing file)

```json
{
  "name": "puttipeli",
  "private": true,
  "version": "0.1.0",
  "type": "module",
  "workspaces": ["packages/shared", "packages/client", "packages/server"],
  "scripts": {
    "dev": "concurrently -k -n client,server -c cyan,magenta \"npm run dev -w packages/client\" \"npm run dev -w packages/server\"",
    "build": "npm run build -w packages/client && npm run build -w packages/server",
    "start": "node packages/server/dist/index.js",
    "test": "vitest run",
    "test:watch": "vitest",
    "test:golden-update": "cross-env GOLDEN_UPDATE=1 vitest run packages/shared/src/sim",
    "typecheck": "tsc -b packages/shared packages/client packages/server",
    "lint": "eslint .",
    "check": "npm run typecheck && npm run lint && npm test"
  },
  "devDependencies": {
    "@types/node": "^24.0.0",
    "@types/ws": "^8.5.13",
    "@eslint/js": "^9.0.0",
    "concurrently": "^9.1.0",
    "cross-env": "^7.0.3",
    "esbuild": "^0.25.0",
    "eslint": "^9.0.0",
    "typescript": "^5.7.0",
    "typescript-eslint": "^8.0.0",
    "vite": "^6.0.0",
    "vitest": "^3.0.0"
  }
}
```

Shared has **no build script** any more (consumed as source). `tsc -b` is typecheck-only: every package `tsconfig.json` keeps `composite: true` and sets `"emitDeclarationOnly": true, "outDir": ".tsout"` (`.tsout/` git-ignored; the existing `dist-types`/`dist` outDirs and the stray `packages/shared/tsconfig.tsbuildinfo` are replaced/removed by WP0). The server's `tsconfig.json` switches to `"module": "ESNext", "moduleResolution": "Bundler"` (it is bundled by esbuild, not run by `tsc` output), keeps `"types": ["node"]`. Shared `tsconfig.json` includes `"src/**/*.ts", "src/**/*.json"` (JSON files must be part of the program for `resolveJsonModule`); client `tsconfig.json` includes `"src/**/*.ts", "dev/**/*.ts"`. Test files are excluded from `tsc -b` (as in the scaffold) and typechecked by Vitest's transform only; tests may therefore import `vitest` without it being in `types`.

Root `vitest.config.ts` (exists): `include: ['packages/**/src/**/*.test.ts']`, `environment: 'node'`; WP0 adds `passWithNoTests: true`. There is a single Vitest config at the root; `npm test -w packages/shared` is **not** used (it would run without the root config) — always run `npm test` or `npx vitest run <path>` from the root. Windows note: environment variables are never set inline in scripts (`FOO=1 cmd` fails in PowerShell); `cross-env` is used where needed (`test:golden-update`).

### 4.2 Shared `package.json` (WP0)

```json
{
  "name": "@puttipeli/shared",
  "version": "0.1.0",
  "private": true,
  "type": "module",
  "exports": { ".": "./src/index.ts", "./*": "./src/*.ts" },
  "scripts": { "test": "vitest run" }
}
```

Import style everywhere: `import { simulateShot } from '@puttipeli/shared/sim/simulate';` (deep import, D27). JSON files are imported with a normal `import courseJson from './builtin/01-ensiputti.json';` (`resolveJsonModule` is on; Vite and esbuild inline them; Vitest handles them natively).

### 4.3 Client

`vite.config.ts` (WP0): port 5173, proxy `/ws` (ws: true) and `/api` to `http://localhost:8080`, `define: { __BUILD__: JSON.stringify(<git short sha or timestamp>) }`, `build.rollupOptions.input = { main: 'index.html', devRender: 'dev/render.html' }` (the harness ships too; it is harmless). `base: './'`.

`src/app/env.d.ts` [WP0] declares `declare const __BUILD__: string;` (the client `tsconfig.json` includes `src/**/*.ts`, which covers `.d.ts` files).

Client `package.json` scripts (exist): `"dev": "vite"`, `"build": "vite build"`, `"preview": "vite preview"`; dependencies `@puttipeli/shared: "*"`; no runtime dependencies otherwise. `vite build` does not typecheck — `npm run typecheck` at the root does.

### 4.4 Server bundle (`packages/server/build.mjs`, WP0)

```js
import { build } from 'esbuild';
await build({
  entryPoints: ['src/index.ts'],
  outfile: 'dist/index.js',
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node24',
  external: ['ws'],
  sourcemap: true,
  banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" },
  define: { 'process.env.BUILD_ID': JSON.stringify(process.env.BUILD_ID ?? 'dev') },
});
```

Server `package.json` scripts: `"dev": "tsx watch src/index.ts"`, `"build": "node build.mjs"`, `"start": "node dist/index.js"`; devDependencies `tsx`; dependencies `ws` and `@puttipeli/shared: "*"` (workspace link, needed for dev with tsx and for type resolution). `tsx` resolves the shared package through the workspace symlink and its `exports` map.

### 4.5 Commands every WP must keep green

`npm run typecheck && npm test` at the root. WP-J additionally proves `npm run build && npm start` serves the client at `http://localhost:8080` and `/healthz` returns 200.

---

## 5. Shared contracts: constants and types (verbatim code)

WP0 creates these files **exactly as printed** (comments may be extended, nothing else changes without a lead decision). All other WPs import from them.

### 5.1 `packages/shared/src/constants.ts`

```ts
// Single source of every tunable. Numeric values change only in the lead's tuning pass:
// bump SIM_VERSION and regenerate golden fixtures (npm run test:golden-update).
// Sim code reads the "Shot", "Collision", "Surfaces" and "Objects" groups through sim/tuning.ts (simTuning.X),
// never directly, so the #/dev panel can override them locally. Everything else is imported directly.
export const SIM_VERSION = 1;

// Grid
export const COURSE_W = 49;
export const COURSE_H = 25;
export const TILE = 15;                      // px
export const FIELD_W = COURSE_W * TILE;      // 735
export const FIELD_H = COURSE_H * TILE;      // 375
export const TILE_COUNT = COURSE_W * COURSE_H; // 1225

// Ball and time
export const BALL_RADIUS = 6;                // px
export const TICK_HZ = 120;
export const DT = 1 / TICK_HZ;
export const SUBSTEPS = 3;                   // fixed; MAX_SPEED / (TICK_HZ * SUBSTEPS) = 2.5 px per substep
export const SUB_DT = DT / SUBSTEPS;
export const MAX_SHOT_TICKS = TICK_HZ * 30;  // 30 s safety cap -> result 'timeout'

// Shot
export const MAX_PULL_PX = 120;              // aim distance cap
export const MIN_PULL_PX = 3;                // dead zone
export const SHOT_QUANTUM = 100;             // ShotInput units per px (integers)
export const POWER_SCALE = 5.5;              // launch speed px/s per px of pull -> max 660 px/s
export const MAX_SPEED = 900;                // hard clamp after bumpers/magnets/slopes
export const STOP_SPEED = 5;                 // px/s; below this (and not under a slope/magnet force) the ball rests
export const FORCED_STOP_TICKS = 60;         // 0.5 s below STOP_SPEED while a slope or magnet force acts (wedged) -> rests

// Collision
export const RESOLVE_ITERATIONS = 4;
export const PENETRATION_SLOP = 0.01;        // px pushed beyond contact
export const RESTITUTION_WALL = 0.78;        // full, triangles, one-way, magnet blocks, border
export const RESTITUTION_BREAKABLE = 0.65;
export const RESTITUTION_MOVABLE = 0.35;
export const RESTITUTION_BUMPER = 1.4;
export const BUMPER_MIN_EXIT_SPEED = 220;    // px/s
export const BOUNCE_EVENT_MIN_SPEED = 40;    // normal speed below which no 'bounce' event is emitted
export const BREAK_MIN_IMPACT_SPEED = 120;   // px/s normal speed needed to count a hit
export const BREAK_DEBOUNCE_TICKS = 12;      // 0.1 s: repeated hits on the same tile are one hit
export const MOVABLE_MIN_IMPACT_SPEED = 60;

// Surfaces: constant deceleration opposing velocity, px/s^2
export const FRICTION_GRASS = 200;
export const FRICTION_SAND = 1100;
export const FRICTION_ICE = 30;
export const FRICTION_SLOPE = 160;           // slopes: friction 160 + SLOPE_ACCEL 260 => never rests unless wedged
export const SLOPE_ACCEL = 260;              // px/s^2 along the slope direction (downhill)

// Objects
export const HOLE_RADIUS = 7.5;              // drawn cup radius
export const HOLE_PULL_RADIUS = 10;          // funnel pull radius
export const HOLE_PULL_ACCEL = 500;          // px/s^2 toward the cup centre
export const HOLE_PULL_MAX_SPEED = 400;      // no pull above this speed
export const HOLE_CAPTURE_RADIUS = 5.5;
export const HOLE_CAPTURE_MAX_SPEED = 220;
export const TELEPORT_TRIGGER_RADIUS = 5;
export const TELEPORT_EXIT_OFFSET = 2;       // px along the velocity direction at the exit pad
export const MAX_TELEPORTS_PER_SHOT = 40;    // anti-loop: afterwards pads are ignored for the rest of the shot
export const MINE_TRIGGER_RADIUS = 7;
export const MAGNET_DEFAULT_STRENGTH = 350;  // px/s^2 at the centre, linear falloff to 0 at radius
export const MAGNET_DEFAULT_RADIUS = 90;     // px
export const MAGNET_MIN_STRENGTH = 50;
export const MAGNET_MAX_STRENGTH = 1200;
export const MAGNET_MIN_RADIUS = 30;
export const MAGNET_MAX_RADIUS = 240;
export const MAGNET_DEAD_ZONE = 3;           // px: no force closer than this to the centre

// Course rules
export const DEFAULT_MAX_STROKES = 20;
export const DEFAULT_PAR = 3;
export const MIN_MAX_STROKES = 1;
export const MAX_MAX_STROKES = 50;
export const MIN_PAR = 1;
export const MAX_PAR = 20;
export const MAX_COURSES_PER_SET = 18;
export const MAX_COURSE_NAME_CHARS = 40;
export const MAX_AUTHOR_CHARS = 40;
export const MAX_DESCRIPTION_CHARS = 200;

// Multiplayer timing
export const DEFAULT_TURN_TIMEOUT_SEC = 45;  // host options: 0 (none), 30, 45, 60
export const AFK_TURN_TIMEOUT_SEC = 5;
export const DISCONNECTED_TURN_WAIT_SEC = 10;
export const DISCONNECT_GRACE_SEC = 60;
export const LOBBY_DISCONNECT_REMOVE_SEC = 10;
export const COUNTDOWN_SEC = 3;
export const HOLE_SUMMARY_SEC = 6;           // multiplayer default; allowed 0 (wait for everyone) | 3 | 6 | 10
export const ROUND_SUMMARY_AUTO_LOBBY_SEC = 120; // multiplayer: roundSummary returns to the lobby after this even if nobody clicks
export const HOLE_INTRO_MS = 1000;           // client-side title card; the authority waits this long before the first turnStarted
export const ANIMATION_GRACE_MS = 250;       // added to ticks/TICK_HZ before the next turnStarted
export const MAX_PLAYERS = 4;
export const MAX_SPECTATORS = 8;
export const MAX_NAME_CHARS = 16;
export const DEFAULT_PLAYER_NAME = 'Pelaaja';
```

### 5.2 `packages/shared/src/course/types.ts`

```ts
export interface Vec2 { x: number; y: number }

/** Surface layer (what the ball rolls on). Char per tile in `Course.surface` rows, see chars.ts. */
export const Surface = {
  Grass: 0, Sand: 1, Ice: 2, Tar: 3, Water: 4, Acid: 5,
  SlopeN: 6, SlopeE: 7, SlopeS: 8, SlopeW: 9,
} as const;
export type Surface = (typeof Surface)[keyof typeof Surface];

/** Wall layer (solid shapes and block materials). Separate layer so a slope may run under a diagonal, etc. */
export const WallShape = {
  None: 0,
  Full: 1,
  TriNW: 2,      // solid north-west half; hypotenuse from (15,0) to (0,15), right angle at the NW corner
  TriNE: 3,      // solid north-east half
  TriSE: 4,      // solid south-east half
  TriSW: 5,      // solid south-west half
  Breakable1: 6, // full block, destroyed after 1 hit
  Breakable2: 7, // 2 hits
  Breakable3: 8, // 3 hits
  Movable: 9,    // full block; slides one tile when hit if the target tile is free
  Bumper: 10,    // full block; restitution 1.4, minimum exit speed
  OneWayN: 11,   // passable only while moving toward -y (north); solid otherwise
  OneWayE: 12,
  OneWayS: 13,
  OneWayW: 14,
} as const;
export type WallShape = (typeof WallShape)[keyof typeof WallShape];

export type TeleportGroup = 0 | 1 | 2 | 3 | 4 | 5 | 6 | 7;
export type Polarity = 1 | -1; // 1 attract, -1 repel

/** Objects live on exactly one tile (0-based tile coordinates). World centre = ((x + 0.5) * TILE, (y + 0.5) * TILE). */
export type CourseObject =
  | { type: 'start'; x: number; y: number }                                                        // exactly one
  | { type: 'hole'; x: number; y: number }                                                         // one or more
  | { type: 'teleport'; x: number; y: number; group: TeleportGroup }                               // exactly 2 per used group
  | { type: 'magnet'; x: number; y: number; polarity: Polarity; strength: number; radius: number } // tile must be WallShape.Full
  | { type: 'mine'; x: number; y: number };
export type CourseObjectType = CourseObject['type'];

export interface CourseRules {
  maxStrokes: number; // 1..50, default 20
  par: number;        // 1..20, default 3
}

/** Authoring + wire format. Row strings are 49 chars, 25 rows. */
export interface Course {
  format: 'puttipeli-course';
  formatVersion: 1;
  id: string;            // builtin "b_01".."b_09"; custom "c_" + 16 hex (courseId(), content hash, id itself excluded)
  name: string;          // 1..40 chars
  author: string;        // 0..40 chars
  description: string;   // 0..200 chars ('' allowed)
  width: 49;
  height: 25;
  rules: CourseRules;
  surface: string[];     // 25 rows x 49 chars, Surface chars
  walls: string[];       // 25 rows x 49 chars, WallShape chars
  objects: CourseObject[]; // at most one object per tile
}

export type CourseRef =
  | { kind: 'builtin'; id: string }
  | { kind: 'custom'; course: Course };

export interface HoleDef { tile: number; cx: number; cy: number }
export interface MineDef { tile: number; cx: number; cy: number }
export interface TeleportPad { tile: number; cx: number; cy: number; group: TeleportGroup; partnerTile: number; partnerIndex: number }
export interface MagnetDef { tile: number; cx: number; cy: number; polarity: Polarity; strength: number; radius: number }

/** Decoded, immutable runtime form produced by decodeLayers(course). Mutable per-hole state lives in sim WorldState. */
export interface CourseLayers {
  surface: Uint8Array;   // TILE_COUNT Surface codes
  walls: Uint8Array;     // TILE_COUNT WallShape codes (initial)
  objectAt: Int16Array;  // TILE_COUNT -> index into objects, or -1
  objects: CourseObject[];
  start: Vec2;           // px centre
  startTile: number;
  holes: HoleDef[];      // course order
  teleports: TeleportPad[];
  magnets: MagnetDef[];
  mines: MineDef[];      // mine index = position in this array (WorldState.minesArmed uses it)
  maxStrokes: number;
  par: number;
}

/**
 * Validation issue. `code` doubles as the i18n key suffix ('validation.' + code) and `message`
 * is an English developer fallback. `params` feed the localized template.
 */
export interface ValidationIssue {
  level: 'error' | 'warning';
  code: string;
  message: string;
  params?: Record<string, string | number>;
  x?: number;
  y?: number;
  objectIndex?: number;
}
```

### 5.3 `packages/shared/src/course/chars.ts`

```ts
import { Surface, WallShape } from './types';

/** Index = code. Surface: grass sand ice tar water acid slopeN slopeE slopeS slopeW (numpad digits point downhill). */
export const SURFACE_CHARS = '.sitwa8624';
/** Index = code. Walls: none full triNW triNE triSE triSW breakable1/2/3 movable bumper oneWayN/E/S/W (numpad digits = solid corner). */
export const WALL_CHARS = '.#7931xyzMO^>v<';

export function surfaceFromChar(c: string): Surface | undefined {
  const i = SURFACE_CHARS.indexOf(c);
  return i < 0 ? undefined : (i as Surface);
}
export function wallFromChar(c: string): WallShape | undefined {
  const i = WALL_CHARS.indexOf(c);
  return i < 0 ? undefined : (i as WallShape);
}
export const charOfSurface = (s: Surface): string => SURFACE_CHARS[s]!;
export const charOfWall = (w: WallShape): string => WALL_CHARS[w]!;

export const isSlope = (s: number): boolean => s >= Surface.SlopeN && s <= Surface.SlopeW;
export const isTriangle = (w: number): boolean => w >= WallShape.TriNW && w <= WallShape.TriSW;
export const isBreakable = (w: number): boolean => w >= WallShape.Breakable1 && w <= WallShape.Breakable3;
export const isOneWay = (w: number): boolean => w >= WallShape.OneWayN && w <= WallShape.OneWayW;
/** Full-footprint blocks (everything solid except None and triangles). */
export const isFullBlock = (w: number): boolean => w === WallShape.Full || w >= WallShape.Breakable1;
export const breakableHits = (w: number): number => (isBreakable(w) ? w - WallShape.Breakable1 + 1 : 0);
/** Unit direction of one-way passage / slope downhill: 0 N(0,-1) 1 E(1,0) 2 S(0,1) 3 W(-1,0). */
export const DIR_DX = [0, 1, 0, -1] as const;
export const DIR_DY = [-1, 0, 1, 0] as const;
export const oneWayDir = (w: number): number => w - WallShape.OneWayN; // 0..3
export const slopeDir = (s: number): number => s - Surface.SlopeN;    // 0..3
```

### 5.4 `packages/shared/src/sim/types.ts`

```ts
import type { Vec2 } from '../course/types';

export interface BallState {
  x: number; y: number;        // px, centre
  vx: number; vy: number;      // px/s
  moving: boolean;
  lastTile: number;            // tile index under the centre at the end of the previous tick (-1 at creation)
  teleportCooldownTile: number;// pad tile the ball must leave before any pad triggers again; -1 none
  insideOneWay: number;        // one-way tile whose segments are ignored while the centre is inside it; -1 none
  slowTicks: number;           // consecutive ticks below STOP_SPEED while a slope or magnet force acts (wedge detection)
}

export interface WorldState {
  walls: Uint8Array;      // TILE_COUNT current WallShape codes (mutable copy of CourseLayers.walls)
  breakHits: Uint8Array;  // TILE_COUNT hits taken so far
  minesArmed: Uint8Array; // one per CourseLayers.mines entry, 1 = armed
}

/** Changes made to a WorldState by one shot (wire form; applied with applyWorldDelta). */
export interface WorldDelta {
  tiles: { i: number; wall: number; hits: number }[];
  minesDisarmed: number[];
}

/** Integer pull vector in 1/100 px. The ball travels in the direction of (dx, dy). |pull| <= MAX_PULL_PX. */
export interface ShotInput { dx: number; dy: number }

export type ShotResult = 'stopped' | 'holed' | 'water' | 'acid' | 'mine' | 'timeout';
export type StepStatus = 'moving' | ShotResult;

export type SimEvent =
  | { tick: number; type: 'bounce'; x: number; y: number; nx: number; ny: number; speed: number; tile: number; material: 'wall' | 'breakable' | 'movable' | 'bumper' | 'oneway' | 'border' }
  | { tick: number; type: 'break'; tile: number; hitsLeft: number }
  | { tick: number; type: 'destroyed'; tile: number }
  | { tick: number; type: 'blockMoved'; from: number; to: number }
  | { tick: number; type: 'teleport'; from: number; to: number }
  | { tick: number; type: 'tar'; tile: number }
  | { tick: number; type: 'water'; tile: number }
  | { tick: number; type: 'acid'; tile: number }
  | { tick: number; type: 'mine'; index: number }
  | { tick: number; type: 'holed'; hole: number }
  | { tick: number; type: 'stopped' }
  | { tick: number; type: 'timeout' };

/** Per-shot scratch state owned by simulateShot / createShotIterator. */
export interface SimContext {
  shotOrigin: Vec2;            // ball position when the shot started (water/mine reset target)
  startPos: Vec2;              // course start centre (acid reset target)
  tick: number;
  teleportCount: number;
  lastBreakTile: number;       // -1
  lastBreakTick: number;       // -1
  otherBalls: readonly Vec2[]; // centres of other players' resting balls (movable block target check)
}

/** Full in-memory result. */
export interface ShotOutcome {
  ticks: number;
  result: ShotResult;
  penalty: 0 | 1;              // water, acid, mine => 1
  holeIndex: number;           // index into CourseLayers.holes when result === 'holed', else -1
  ball: BallState;             // final ball (after reset for water/acid/mine)
  world: WorldState;           // final world
  worldDelta: WorldDelta;
  events: SimEvent[];
  checksum: number;            // hashSimState(ball, world)
}

/** Wire form carried in GameEvent 'shotTaken' (no typed arrays, no event list). */
export interface ShotSummary {
  ticks: number;
  result: ShotResult;
  penalty: 0 | 1;
  holeIndex: number;
  ball: BallState;
  worldDelta: WorldDelta;
  checksum: number;
}

/** One shot advanced tick by tick (client animation). createShotIterator() in sim/simulate.ts returns it; simulateShot() runs it to completion. */
export interface ShotIterator {
  readonly ball: BallState;          // live, mutated by step()
  readonly world: WorldState;        // live
  readonly events: SimEvent[];
  readonly ctx: SimContext;
  readonly done: boolean;
  readonly result: ShotResult | null;
  readonly penalty: 0 | 1;
  readonly holeIndex: number;        // -1 unless result === 'holed'
  step(): StepStatus;                // advances exactly one tick; no-op when done
}
```

### 5.5 `packages/shared/src/game/types.ts`

```ts
import type { Course, Vec2 } from '../course/types';
import type { BallState, ShotInput, WorldState } from '../sim/types';

export type PlayerColour = 0 | 1 | 2 | 3;
export type Phase = 'lobby' | 'countdown' | 'hole' | 'holeSummary' | 'roundSummary';

export interface PlayerState {
  id: string;
  name: string;
  colour: PlayerColour;
  ready: boolean;
  connected: boolean;
  afk: boolean;
  consecutiveTimeouts: number;
  joinedSeq: number;      // seat order = ascending joinedSeq, frozen into `seatOrder` at gameStarted
  leftRound: boolean;     // left or removed during a round; scorecard row stays, no more turns
}

export interface SpectatorState { id: string; name: string }

export interface RoomSettings {
  maxPlayers: 2 | 3 | 4;              // never below the current number of players (normalizeSettings clamps)
  turnTimeoutSec: 0 | 30 | 45 | 60;   // 0 = no limit
  holeSummarySec: 0 | 3 | 6 | 10;     // 0 = wait until every connected active player is ready; default HOLE_SUMMARY_SEC
  ballCollision: false;               // reserved, always false in v1 (shown greyed in the lobby)
}

export interface TurnState {
  playerId: string;
  turnSeq: number;             // increments on every turnStarted within a round; shoot must echo it
  deadlineMs: number | null;   // authority clock (server time); null = no limit
  shotInFlight: boolean;       // true between shotTaken and the next turnStarted/holeEnded
}

export interface LastShot { playerId: string; turnSeq: number; shot: ShotInput; ticks: number; atMs: number }

export interface RankingEntry { playerId: string; total: number; rank: number } // ties share rank, players with leftRound last

export interface GameState {
  phase: Phase;
  settings: RoomSettings;
  hostId: string | null;
  players: PlayerState[];               // sorted by joinedSeq
  spectators: SpectatorState[];
  courses: Course[];                    // 1..18, full data (custom courses included)
  seatOrder: string[];                  // frozen at gameStarted; [] in lobby
  holeIndex: number;                    // -1 in lobby/countdown
  order: string[];                      // turn order for the current hole (rotated seatOrder)
  balls: Record<string, BallState>;
  shotOrigins: Record<string, Vec2>;    // position at the start of each player's last shot
  strokes: Record<string, number[]>;    // playerId -> strokes per hole index; -1 = not played
  holeDone: Record<string, boolean>;
  world: WorldState | null;             // shared per hole: destroyed blocks are destroyed for everyone
  turn: TurnState | null;
  lastShot: LastShot | null;
  summaryReady: Record<string, boolean>;
  ranking: RankingEntry[] | null;       // set by roundEnded
  countdownEndsAtMs: number | null;
  seq: number;                          // number of events applied (debugging, ordering checks)
}

/** JSON-safe form (typed arrays -> number[]). game/serialize.ts converts both ways. */
export interface WorldJson { walls: number[]; breakHits: number[]; minesArmed: number[] }
export type GameStateJson = Omit<GameState, 'world'> & { world: WorldJson | null };
```

### 5.6 `packages/shared/src/game/events.ts`

```ts
import type { Course } from '../course/types';
import type { ShotInput, ShotSummary } from '../sim/types';
import type { PlayerColour, PlayerState, RankingEntry, RoomSettings, SpectatorState } from './types';

/**
 * Emitted only by an authority (server Room or client localHost), applied by everyone with applyEvent().
 * The reducer derives all consequences (strokes, holeDone, phase) itself; events carry decisions and
 * timing, never redundant derived state — except `shotTaken.outcome`, which is the simulation result.
 */
export type GameEvent =
  | { type: 'playerJoined'; player: PlayerState }
  | { type: 'playerLeft'; playerId: string }
  | { type: 'spectatorJoined'; spectator: SpectatorState }
  | { type: 'spectatorLeft'; id: string }
  | { type: 'playerConnection'; playerId: string; connected: boolean }
  | { type: 'playerAfk'; playerId: string; afk: boolean }
  | { type: 'hostChanged'; hostId: string }
  | { type: 'profileChanged'; playerId: string; name: string; colour: PlayerColour }
  | { type: 'readyChanged'; playerId: string; ready: boolean }
  | { type: 'settingsChanged'; settings: RoomSettings }
  | { type: 'coursesChanged'; courses: Course[] }
  | { type: 'countdownStarted'; endsAtMs: number }
  | { type: 'gameStarted'; seatOrder: string[] }
  | { type: 'holeStarted'; holeIndex: number; order: string[] }
  | { type: 'turnStarted'; playerId: string; turnSeq: number; deadlineMs: number | null }
  | { type: 'shotTaken'; playerId: string; turnSeq: number; shot: ShotInput; outcome: ShotSummary; atMs: number }
  | { type: 'turnTimedOut'; playerId: string; turnSeq: number }   // +1 stroke, ball does not move
  | { type: 'turnSkipped'; playerId: string; turnSeq: number }    // disconnected player, no stroke
  | { type: 'holeEnded'; holeIndex: number }
  | { type: 'summaryReady'; playerId: string }
  | { type: 'roundEnded'; ranking: RankingEntry[] }
  | { type: 'backToLobby' };
export type GameEventType = GameEvent['type'];
```

### 5.7 WP0 runtime helpers shared by several M1 packages (D28)

`packages/shared/src/course/grid.ts` — integer tile arithmetic (no dependency on WP-A):

```ts
import { COURSE_W, COURSE_H, TILE, FIELD_W, FIELD_H, BALL_RADIUS } from '../constants';
import type { Vec2 } from './types';
export const tileIndex = (x: number, y: number): number => y * COURSE_W + x;
export const tileX = (i: number): number => i % COURSE_W;                       // integer ops only
export const tileY = (i: number): number => (i - (i % COURSE_W)) / COURSE_W;
export const inBounds = (x: number, y: number): boolean => x >= 0 && y >= 0 && x < COURSE_W && y < COURSE_H;
/** Tile under a world point; the point is clamped into [0, FIELD_W - 1e-9] x [0, FIELD_H - 1e-9] first. Uses Math.floor only. */
export function tileOf(px: number, py: number): number;
export const tileCentre = (i: number): Vec2 => ({ x: (tileX(i) + 0.5) * TILE, y: (tileY(i) + 0.5) * TILE });
export const tileOrigin = (i: number): Vec2 => ({ x: tileX(i) * TILE, y: tileY(i) * TILE });
export const centreInsideTile = (px: number, py: number, i: number): boolean; // tileOf(px, py) === i
```

`packages/shared/src/sim/shot.ts` — shot encoding (needed by WP-B sim, WP-C protocol validation and WP-D input):

```ts
import type { ShotInput } from './types';
/** Client side: clamp |pull| to simTuning.MAX_PULL_PX (sqrt), then Math.round(component * SHOT_QUANTUM). (0,0) when |pull| < MIN_PULL_PX. */
export function quantizeShot(pullX: number, pullY: number): ShotInput;
/** Integers, finite, (MIN_PULL_PX*SHOT_QUANTUM)^2 <= dx^2+dy^2 <= (MAX_PULL_PX*SHOT_QUANTUM + 1)^2. Uses the constants, never simTuning
 *  (the server validates against the fixed values). */
export function validateShot(s: unknown): s is ShotInput;
export const isNullShot = (s: ShotInput): boolean => s.dx === 0 && s.dy === 0;
```

`packages/shared/src/sim/tuning.ts` — the one mutable object in shared. The sim reads every numeric tunable of the "Shot", "Collision", "Surfaces" and "Objects" groups of `constants.ts` as `simTuning.NAME` (same names). Grid, time, course-rule and multiplayer constants are imported directly and are **not** tunable.

```ts
import * as C from '../constants';
export const SIM_TUNING_KEYS = ['MAX_PULL_PX','MIN_PULL_PX','POWER_SCALE','MAX_SPEED','STOP_SPEED','FORCED_STOP_TICKS',
  'RESOLVE_ITERATIONS','PENETRATION_SLOP','RESTITUTION_WALL','RESTITUTION_BREAKABLE','RESTITUTION_MOVABLE','RESTITUTION_BUMPER',
  'BUMPER_MIN_EXIT_SPEED','BOUNCE_EVENT_MIN_SPEED','BREAK_MIN_IMPACT_SPEED','BREAK_DEBOUNCE_TICKS','MOVABLE_MIN_IMPACT_SPEED',
  'FRICTION_GRASS','FRICTION_SAND','FRICTION_ICE','FRICTION_SLOPE','SLOPE_ACCEL',
  'HOLE_RADIUS','HOLE_PULL_RADIUS','HOLE_PULL_ACCEL','HOLE_PULL_MAX_SPEED','HOLE_CAPTURE_RADIUS','HOLE_CAPTURE_MAX_SPEED',
  'TELEPORT_TRIGGER_RADIUS','TELEPORT_EXIT_OFFSET','MAX_TELEPORTS_PER_SHOT','MINE_TRIGGER_RADIUS',
  'MAGNET_DEFAULT_STRENGTH','MAGNET_DEFAULT_RADIUS','MAGNET_MIN_STRENGTH','MAGNET_MAX_STRENGTH','MAGNET_MIN_RADIUS','MAGNET_MAX_RADIUS','MAGNET_DEAD_ZONE'] as const;
export type SimTuningKey = (typeof SIM_TUNING_KEYS)[number];
export type SimTuning = { [K in SimTuningKey]: number };
export const SIM_TUNING_DEFAULTS: Readonly<SimTuning>;                  // copied from constants.ts, frozen
export const simTuning: SimTuning;                                       // live values read by the sim
export function setSimTuning(partial: Partial<SimTuning>): void;         // dev screen only; ignores unknown keys and non-finite values
export function resetSimTuning(): void;
export function isSimTuningDefault(): boolean;
```

Rules: the server never imports `setSimTuning`; the client calls it only from `#/dev` and calls `resetSimTuning()` when leaving that screen and before any multiplayer session starts (`RoomSession` constructor). A `SimContext` carries no tuning; a dev-tuned game is local, and its checksums are compared only against the local authority, so no desync can occur. Tests call `resetSimTuning()` in `beforeEach` when they touch it.

---

## 6. Shared contracts: protocol (verbatim code)

### 6.1 `packages/shared/src/protocol/version.ts`

```ts
export const PROTOCOL_VERSION = 1;
```

### 6.2 `packages/shared/src/protocol/codes.ts`

```ts
export const ErrorCode = {
  BAD_VERSION: 'BAD_VERSION',           // protocol or sim version mismatch -> client shows "Päivitä sivu"
  INVALID_MESSAGE: 'INVALID_MESSAGE',
  RATE_LIMITED: 'RATE_LIMITED',
  SERVER_FULL: 'SERVER_FULL',
  ROOM_NOT_FOUND: 'ROOM_NOT_FOUND',
  ROOM_FULL: 'ROOM_FULL',
  NAME_TAKEN: 'NAME_TAKEN',
  NOT_IN_ROOM: 'NOT_IN_ROOM',
  ALREADY_IN_ROOM: 'ALREADY_IN_ROOM',
  NOT_HOST: 'NOT_HOST',
  NOT_IN_LOBBY: 'NOT_IN_LOBBY',
  GAME_IN_PROGRESS: 'GAME_IN_PROGRESS',
  NOT_ENOUGH_PLAYERS: 'NOT_ENOUGH_PLAYERS',
  PLAYERS_NOT_READY: 'PLAYERS_NOT_READY',
  NOT_A_PLAYER: 'NOT_A_PLAYER',         // spectator tried a player action
  NOT_YOUR_TURN: 'NOT_YOUR_TURN',
  STALE_TURN: 'STALE_TURN',             // turnSeq/holeIndex mismatch
  SHOT_IN_FLIGHT: 'SHOT_IN_FLIGHT',
  INVALID_SHOT: 'INVALID_SHOT',
  INVALID_COURSE: 'INVALID_COURSE',     // error carries issues[]
  SESSION_EXPIRED: 'SESSION_EXPIRED',
} as const;
export type ErrorCode = (typeof ErrorCode)[keyof typeof ErrorCode];
```

### 6.3 `packages/shared/src/protocol/limits.ts`

```ts
export const MAX_MESSAGE_BYTES = 524_288;     // 512 KB inbound frame cap; 18 courses x MAX_COURSE_BYTES = 432 KB fits; larger -> close 1009
export const MAX_COURSE_BYTES = 24_576;       // canonical JSON of one course (a typical course is ~2.6 KB; 1 200 mine objects ~ 24 KB)
export const MAX_CHAT_CHARS = 200;
export const MAX_ROOM_CODE_CHARS = 5;
export const RATE_MSGS_PER_SEC = 20;          // token bucket refill
export const RATE_BURST = 40;                 // bucket capacity
export const CHAT_MSGS_PER_10S = 5;
export const MAX_ROOMS_DEFAULT = 200;
export const MAX_CONNECTIONS_DEFAULT = 1000;
export const ROOM_IDLE_TTL_MIN_DEFAULT = 90;  // no activity -> room removed
export const ROOM_EMPTY_TTL_SEC_DEFAULT = 120;// no connections -> room removed
export const HEARTBEAT_INTERVAL_MS = 20_000;  // server ping; 2 missed pongs -> close
export const SESSION_TOKEN_BYTES = 16;
```

### 6.4 `packages/shared/src/protocol/messages.ts`

JSON text frames, one message per frame, discriminated by `t`.

```ts
import type { Course, CourseRef, ValidationIssue } from '../course/types';
import type { ShotInput } from '../sim/types';
import type { GameEvent } from '../game/events';
import type { GameStateJson, PlayerColour, RoomSettings } from '../game/types';
import type { ErrorCode } from './codes';

export type ClientMessage =
  | { t: 'hello'; protocolVersion: number; simVersion: number; clientBuild: string }  // first message on every socket
  | { t: 'createRoom'; name: string; colour: PlayerColour; settings?: Partial<RoomSettings> }
  | { t: 'joinRoom'; code: string; name: string; colour: PlayerColour; asSpectator?: boolean } // asSpectator: join as a spectator even if a seat is free
  | { t: 'rejoin'; code: string; sessionToken: string }
  | { t: 'leaveRoom' }
  | { t: 'setProfile'; name?: string; colour?: PlayerColour }        // lobby only
  | { t: 'setReady'; ready: boolean }                                 // lobby only
  | { t: 'chat'; text: string }
  | { t: 'setCourses'; courses: CourseRef[] }                         // host, lobby only, 1..18 (0 or >18 entries fail parseClientMessage -> INVALID_MESSAGE)
  | { t: 'setSettings'; settings: Partial<RoomSettings> }             // host, lobby only
  | { t: 'startGame' }                                                // host, lobby only
  | { t: 'backToLobby' }                                              // host, roundSummary only
  | { t: 'shoot'; holeIndex: number; turnSeq: number; shot: ShotInput }
  | { t: 'summaryReady' }                                             // holeSummary / roundSummary
  | { t: 'becomePlayer' }                                             // spectator -> player (lobby, free seat)
  | { t: 'requestSnapshot' }
  | { t: 'ping'; t0: number };

export interface ChatFrom { id: string; name: string; colour: PlayerColour }

export type ServerMessage =
  | { t: 'welcome'; protocolVersion: number; simVersion: number; serverTimeMs: number; build: string }
  | { t: 'error'; code: ErrorCode; message: string; issues?: ValidationIssue[] }
  | { t: 'roomJoined'; code: string; playerId: string; sessionToken: string; role: 'player' | 'spectator'; state: GameStateJson; serverTimeMs: number }
  | { t: 'roomState'; state: GameStateJson; serverTimeMs: number }   // full snapshot: on requestSnapshot, after rejoin, after desync
  | { t: 'event'; ev: GameEvent }
  | { t: 'chat'; from: ChatFrom | null; text?: string; key?: string; params?: Record<string, string | number>; atMs: number } // from null = system line {key, params}
  | { t: 'roomLeft'; reason: 'left' | 'removed' | 'roomClosed' | 'sessionExpired' }
  | { t: 'pong'; t0: number; serverTimeMs: number };

export type ClientMessageType = ClientMessage['t'];
export type ServerMessageType = ServerMessage['t'];
```

Built-in course refs resolve on the server from `BUILTIN_COURSES`; `coursesChanged` and snapshots always carry **full** `Course[]` so every client holds byte-identical data (`Course` is JSON-safe; `courseId()` is recomputed server-side for custom courses).

Message semantics that are not obvious from the types:
- `roomJoined.playerId` is the member id of the joining connection, for spectators as well (it is also the `SpectatorState.id`). Player and spectator ids share one id space (`crypto.randomUUID()` on the server, `'p1'` in single player).
- `joinRoom` / `becomePlayer` **colour**: if the requested colour is already taken by a player, the authority assigns the lowest free `PlayerColour`; the `playerJoined` / `profileChanged` event carries the colour actually assigned. `setProfile` with a taken colour is ignored for the colour part (name still applies). Names: `joinRoom` into a lobby with a case-insensitive duplicate name ⇒ `NAME_TAKEN` (client asks for another name); `becomePlayer` with a duplicate name ⇒ the server appends the smallest digit suffix that is free (`Matti` → `Matti2`), truncating to `MAX_NAME_CHARS`.
- `error.message` is an English developer string; clients display `t('error.' + code)` (keys in `fi.mp.ts`/`en.mp.ts`, WP-H) and fall back to `message`.
- After `roomJoined` (initial join or rejoin) the client **clears** its chat buffer; the server then sends the last 50 chat lines, so a reconnect does not duplicate them.
- `roomState` replaces the client's whole `GameState` (no merging).

### 6.5 Client contracts

`packages/client/src/game/gameHost.ts`

```ts
import type { GameState, PlayerColour } from '@puttipeli/shared/game/types';
import type { GameEvent } from '@puttipeli/shared/game/events';
import type { ShotInput } from '@puttipeli/shared/sim/types';

export interface ChatMessage {
  seq: number;
  from: { id: string; name: string; colour: PlayerColour } | null; // null = system line
  text?: string;
  key?: string;                                 // i18n key for system lines, e.g. 'chat.playerJoined'
  params?: Record<string, string | number>;
  atMs: number;
}
export interface ChatApi {
  messages(): readonly ChatMessage[];
  send(text: string): void;
  subscribe(listener: (messages: readonly ChatMessage[]) => void): () => void;
}

/** Called after every applied event with the new state, the event, and the previous state (null for the initial call). */
export type HostListener = (state: GameState, event: GameEvent | null, prev: GameState | null) => void;

/** Implemented by game/localHost.ts (single player, test play) and net/roomClient.ts (multiplayer). */
export interface GameHost {
  readonly kind: 'local' | 'remote';
  readonly localPlayerId: string;      // '' for a spectator
  readonly isSpectator: boolean;
  readonly chat: ChatApi | null;       // null in single player
  getState(): GameState;
  subscribe(listener: HostListener): () => void; // calls listener(state, null, null) immediately
  shoot(shot: ShotInput): void;        // no-op unless phase 'hole', it is my turn and no shot is in flight
  summaryReady(): void;
  backToLobby(): void;                 // roundSummary, host only (remote sends {t:'backToLobby'}; local calls Authority.backToLobby(localPlayerId))
  restart(): void;                     // local only ("Pelaa uudelleen": backToLobby + start on the same courses); no-op for remote
  requestSnapshot(): void;             // no-op for local
  nowAuthorityMs(): number;            // Date.now() + measured offset (0 for local); compare with deadlineMs
  onError(listener: (code: string, message: string) => void): () => void;
  leave(): void;                       // single player: abort round; multiplayer: leaveRoom
  destroy(): void;                     // release sockets/timers/listeners
}
```

`packages/client/src/app/activeHost.ts`

```ts
import type { Course } from '@puttipeli/shared/course/types';
import type { PlayerColour } from '@puttipeli/shared/game/types';
import type { GameHost } from '../game/gameHost';

export interface PendingLocalGame {
  courses: Course[];       // 1..18, play order
  playerName: string;
  colour: PlayerColour;
  returnTo: string;        // hash to navigate to after the round / on leave, e.g. '#/' or '#/editor'
  testPlay: boolean;       // editor test play: HUD shows "Testaus", no scorecard persistence
}
let host: GameHost | null = null;
let pending: PendingLocalGame | null = null;
export function setActiveHost(h: GameHost | null): void { if (host && host !== h) host.destroy(); host = h; }
export function getActiveHost(): GameHost | null { return host; }
export function setPendingLocalGame(req: PendingLocalGame | null): void { pending = req; }
export function takePendingLocalGame(): PendingLocalGame | null { const p = pending; pending = null; return p; }
```

`packages/client/src/app/screen.ts`

```ts
export interface ScreenContext {
  params: Record<string, string>;   // from the route pattern, e.g. { code: 'K7PQ2' }
  query: URLSearchParams;           // after '?' in the hash
  navigate(hash: string): void;
}
export interface Screen { mount(root: HTMLElement, ctx: ScreenContext): void; unmount(): void }
export type ScreenFactory = () => Screen;
const registry = new Map<string, ScreenFactory>();
/** pattern: '#/', '#/play', '#/room/:code' ... Called at module import by every *.screen.ts file. */
export function registerScreen(pattern: string, factory: ScreenFactory): void { registry.set(pattern, factory); }
export function getScreenRegistry(): ReadonlyMap<string, ScreenFactory> { return registry; }
```

`packages/client/src/i18n/t.ts`

```ts
export type Lang = 'fi' | 'en';
export type Dict = Record<string, string>;
const dicts: Record<Lang, Dict> = { fi: {}, en: {} };
let lang: Lang = 'fi';
const listeners = new Set<() => void>();
/** Merge strings into a language. Called at module import by fi.ts, fi.mp.ts, fi.editor.ts, ... */
export function registerDictionary(l: Lang, dict: Dict): void { Object.assign(dicts[l], dict); }
export function setLanguage(l: Lang): void { lang = l; listeners.forEach((f) => f()); }
export function getLanguage(): Lang { return lang; }
export function onLanguageChange(f: () => void): () => void { listeners.add(f); return () => listeners.delete(f); }
/** Template params as {name}. Falls back to Finnish, then to the key itself. */
export function t(key: string, params?: Record<string, string | number>): string {
  const s = dicts[lang][key] ?? dicts.fi[key] ?? key;
  return params ? s.replace(/\{(\w+)\}/g, (_, k: string) => String(params[k] ?? `{${k}}`)) : s;
}
```

`packages/client/src/app/env.d.ts`: `declare const __BUILD__: string;`

Route list (all registered by their own `*.screen.ts`): `#/` main menu [WP-E], `#/play` single setup [WP-E], `#/game` play view [WP-G], `#/mp` multiplayer menu [WP-H], `#/room/:code` lobby [WP-H], `#/editor` [WP-I], `#/help` [WP-E], `#/settings` [WP-E], `#/dev` [WP-K].

### 6.6 Server contracts

`packages/server/src/ws/transport.ts`

```ts
import type { ServerMessage } from '@puttipeli/shared/protocol/messages';

export interface Connection {
  readonly id: string;
  readonly remoteAddress: string;
  readonly isOpen: boolean;
  send(msg: ServerMessage): void;          // serializes JSON; silently drops if closed
  close(code?: number, reason?: string): void;
}
export interface ConnectionHandler {
  onOpen(conn: Connection): void;
  onMessage(conn: Connection, raw: string): void; // raw text frame (binary frames are rejected by the transport)
  onClose(conn: Connection): void;
}
export interface Transport {
  start(handler: ConnectionHandler): void;
  stop(): Promise<void>;                   // closes all connections
  connectionCount(): number;
}
```

`packages/server/src/clock.ts`

```ts
export type TimerHandle = number;
export interface Clock {
  now(): number;                                        // ms since epoch
  setTimeout(fn: () => void, ms: number): TimerHandle;
  clearTimeout(handle: TimerHandle): void;
}
export const systemClock: Clock = (() => {
  let next = 1;
  const timers = new Map<number, ReturnType<typeof setTimeout>>();
  return {
    now: () => Date.now(),
    setTimeout(fn, ms) { const id = next++; timers.set(id, setTimeout(() => { timers.delete(id); fn(); }, ms)); return id; },
    clearTimeout(id) { const h = timers.get(id); if (h) { clearTimeout(h); timers.delete(id); } },
  };
})();
```

### 6.7 Math helpers (WP0, `packages/shared/src/math/`)

```ts
// vec.ts — only + - * / and Math.sqrt
export function len(x: number, y: number): number;                // Math.sqrt(x*x + y*y)
export function dot(ax: number, ay: number, bx: number, by: number): number;
/** Returns {x:0,y:0} when len < eps (D16). */
export function unitOrZero(x: number, y: number, eps?: number): Vec2;
export function clampLen(x: number, y: number, max: number): Vec2;
// hash.ts
export function fnv1a32(input: string | Uint8Array, offsetBasis?: number): number; // unsigned 32-bit; default basis 0x811c9dc5, second basis 0x01000193 ^ 0x811c9dc5
export function hex8(n: number): string;
// rng.ts — cosmetics and tests only (ESLint forbids importing it from sim/)
export function xorshift32(seed: number): () => number;            // [0,1)
```

---

## 7. Course format, validation, identity, editing ops (WP-A)

### 7.1 JSON file

One course per file, `format: 'puttipeli-course'`. Row strings over number arrays: diff-friendly, hand-editable, ~2.6 KB per course, validated trivially. **Illustrative** example of the shape (rows abbreviated, objects chosen to show every object type — the real `01-ensiputti.json` contains only what `docs/COURSES.md` lists for hole 1 and uses the description given there):

```json
{
  "format": "puttipeli-course",
  "formatVersion": 1,
  "id": "b_01",
  "name": "Ensiputti",
  "author": "Puttipeli",
  "description": "Suora väylä, yksi hiekkaeste ja viisto kulma.",
  "width": 49,
  "height": 25,
  "rules": { "maxStrokes": 20, "par": 2 },
  "surface": [
    ".................................................",
    ".....................ssss........................",
    "… 25 rows; '.' grass, s sand, i ice, t tar, w water, a acid, 8/6/2/4 slopes (numpad: digit points downhill)"
  ],
  "walls": [
    "#################################################",
    "#..............................................9#",
    "#......7############9...........................#",
    "… 25 rows; '.' none, '#' full, 7/9/3/1 triangles (digit = solid corner), x/y/z breakable 1/2/3 hits,",
    "… M movable, O bumper, ^ > v < one-way",
    "#################################################"
  ],
  "objects": [
    { "type": "start", "x": 3, "y": 12 },
    { "type": "hole", "x": 44, "y": 12 },
    { "type": "teleport", "x": 10, "y": 20, "group": 0 },
    { "type": "teleport", "x": 38, "y": 4, "group": 0 },
    { "type": "magnet", "x": 24, "y": 12, "polarity": 1, "strength": 350, "radius": 90 },
    { "type": "mine", "x": 30, "y": 8 }
  ]
}
```

### 7.2 `course/parse.ts`

Tile arithmetic (`tileIndex`, `tileX`, `tileY`, `tileOf`, `tileCentre`, `inBounds`) lives in WP0's `course/grid.ts` (§5.7); `parse.ts` imports it and does not redefine it.

```ts
/** Decodes rows + objects into typed arrays and object tables. Precondition: validateCourse(course) has no errors.
 *  Throws DecodeError (message names the problem) on malformed input: bad dimensions/chars, no start, no hole, unpaired
 *  teleport group — never silently repairs. Callers (authority, editor, setup screens) therefore always validate first. */
export function decodeLayers(course: Course): CourseLayers;
export function encodeLayers(surface: Uint8Array, walls: Uint8Array): { surface: string[]; walls: string[] };
```

Teleport pads: `partnerIndex` is the other pad with the same group (pads sorted in course order; the validator guarantees exactly two per group). Magnet `strength`/`radius` are clamped into `[MAGNET_MIN_*, MAGNET_MAX_*]` by `decodeLayers`. `holes` and `mines` are in course (object array) order; `WorldState.minesArmed[i]` refers to `layers.mines[i]`, and `createWorldFromCourse` (WP0) counts `'mine'` objects in the same order, so the two agree without WP0 depending on WP-A.

### 7.3 `course/migrate.ts`

```ts
export type ParseResult = { ok: true; course: Course; warnings: ValidationIssue[] } | { ok: false; issues: ValidationIssue[] };
/** Structural check (format discriminator, version chain, defaults for optional fields), then validateCourse. */
export function parseCourseFile(input: unknown): ParseResult;
```

Rules: `format` must equal `'puttipeli-course'` (`FORMAT_UNKNOWN`), `formatVersion` must be ≤ 1 (`VERSION_TOO_NEW` → message "Päivitä peli" via i18n). Missing `author`/`description` default to `''`, missing `rules` to defaults, `id` recomputed if missing or not matching the `c_`/`b_` pattern. v1 is the identity migration; the chain exists so v2 can add sizes.

### 7.4 `course/canonical.ts`

```ts
/** Key order: format, formatVersion, name, author, description, width, height, rules{maxStrokes,par}, surface, walls,
 *  objects (each: type, x, y, then group | polarity, strength, radius). `id` is excluded. No whitespace. */
export function canonicalCourseJson(course: Course): string;
export const COURSE_ID_BASIS_2 = 0x01000193 ^ 0x811c9dc5;
/** 'c_' + hex8(fnv1a32(canon)) + hex8(fnv1a32(canon, COURSE_ID_BASIS_2)); built-ins keep their 'b_NN' ids. */
export function courseId(course: Course): string;
export function withComputedId(course: Course): Course;           // returns a copy with id = courseId(course) unless id starts with 'b_'
export function courseByteLength(course: Course): number;         // UTF-8 length of canonicalCourseJson
```

### 7.5 `course/validate.ts` — `validateCourse(course): ValidationIssue[]`

Errors (`level: 'error'`, code → Finnish text lives in the client under `validation.<code>`):

| code | rule |
|------|------|
| `BAD_DIMENSIONS` | `width !== 49 \|\| height !== 25 \|\| surface.length !== 25 \|\| walls.length !== 25` or any row length ≠ 49 (x,y of the offending row) |
| `BAD_CHAR` | character not in the layer alphabet (x, y, params `{char, layer}`) |
| `NO_START` / `MULTIPLE_STARTS` | exactly one start |
| `NO_HOLE` | at least one hole |
| `OBJECT_OUT_OF_BOUNDS` | object x,y not integers in range |
| `OBJECT_OVERLAP` | two objects on one tile |
| `OBJECT_ON_WALL` | start/hole/teleport/mine on a tile whose wall ≠ None |
| `MAGNET_NOT_ON_FULL` | magnet tile wall ≠ Full |
| `OBJECT_ON_HAZARD` | start/hole/teleport on Water/Acid/Tar; mine on Water/Acid |
| `TELEPORT_GROUP_SIZE` | a used group does not have exactly 2 pads (params `{group, count}`) |
| `BAD_TELEPORT_GROUP` | group not 0..7 |
| `BAD_MAGNET` | polarity not ±1, strength or radius not finite |
| `BAD_RULES` | maxStrokes ∉ [1,50] or par ∉ [1,20] or not integers |
| `BAD_NAME` | name empty or > 40 chars after trim; `BAD_AUTHOR` > 40; `BAD_DESCRIPTION` > 200 |
| `TOO_LARGE` | `courseByteLength > MAX_COURSE_BYTES` |

Warnings: `UNREACHABLE_HOLE` (§7.6), `HOLE_NEXT_TO_START` (Chebyshev distance ≤ 1), `OPEN_BORDER` (any border tile with wall None — allowed, the physics treats out-of-bounds as solid), `PAR_HIGH` (par > 8).

A course with **errors never reaches an authority**: the server's `courseStore` rejects it (`INVALID_COURSE`), the single-player setup greys out library entries whose stored course has errors (re-validated on listing) and refuses invalid uploads, and the editor blocks *Testaa*. Consequently `decodeLayers` may assume a start and at least one hole exist. `ValidationIssue.code` values are the exact strings in this table; WP-E's `fi.ts` provides `validation.<code>` for every one of them (params: `{x, y, char, layer, group, count}` as listed).

### 7.6 `course/reachability.ts`

`isHoleReachable(layers: CourseLayers): boolean` — BFS from `startTile` over 4-connected tiles that are *potentially passable*: wall ∈ {None, OneWay*, Breakable*, Movable} **and** surface ∉ {Water, Acid}; teleport pads add an edge to their partner. True if any hole tile is reached. Warning only (D22).

### 7.7 `course/edit.ts` — pure editor operations (D11)

All functions return a **new** `Course` (rows are replaced as new strings; the input is never mutated). Invariants enforced here so the editor cannot produce courses the validator rejects for structural reasons:

```ts
export type Layer = 'surface' | 'walls';
export function objectAt(course: Course, x: number, y: number): CourseObject | undefined;
/** Painting Water/Acid/Tar under start/hole/teleport removes that object; Water/Acid under a mine removes the mine. */
export function setSurface(course: Course, x: number, y: number, s: Surface): Course;
/** Any wall ≠ None removes a non-magnet object on the tile; None under a magnet removes the magnet; a magnet tile painted
 *  with a non-Full wall removes the magnet. */
export function setWall(course: Course, x: number, y: number, w: WallShape): Course;
/** Replaces whatever object is on the tile. 'start' is a singleton (previous start removed). magnet -> wall set to Full;
 *  other objects -> wall set to None. Surface hazards under the new object are reset to Grass. */
export function placeObject(course: Course, obj: CourseObject): Course;
/** Removing a magnet leaves its Full wall in place. */
export function removeObjectAt(course: Course, x: number, y: number): Course;
export function fillRect(course: Course, layer: Layer, x0: number, y0: number, x1: number, y1: number, value: number, outline?: boolean): Course;
export function floodFill(course: Course, layer: Layer, x: number, y: number, value: number): Course; // 4-connected, equal value
export function line(course: Course, layer: Layer, x0: number, y0: number, x1: number, y1: number, value: number): Course; // Bresenham
export function setMeta(course: Course, meta: Partial<Pick<Course, 'name' | 'author' | 'description'>> & Partial<CourseRules>): Course;
```

`course/blank.ts`: `createBlankCourse(meta?)` → grass everywhere, full-wall border ring, start at (3,12), hole at (45,12), rules defaults, `id` computed. `course/builtin.ts`: `export const BUILTIN_COURSES: Course[]` (9, in play order, ids `b_01`…`b_09`), `export function findBuiltin(id: string): Course | undefined`, `export const BUILTIN_SET_NAME = 'Perusradat'`. The JSON imports have the inferred type `{ format: string; … }`, so `builtin.ts` runs each file through `parseCourseFile` at module initialisation and **throws** on any error (fail fast at startup instead of a bad course reaching players); the resulting typed `Course` objects are what `BUILTIN_COURSES` holds.

---

## 8. Physics (WP-B, `packages/shared/src/sim`)

Units: px, s, px/s, px/s². World x right, y down, origin at the top-left corner of tile (0,0). The sim consumes `CourseLayers` (immutable), a `WorldState` (mutable per hole), one `BallState` and a `SimContext`. Only one ball moves per shot; other balls are passive points in `ctx.otherBalls`.

### 8.1 Public API

```ts
// worldState.ts (WP0, §10.1): createWorld(walls, mineCount), createWorldFromCourse, cloneWorld, diffWorld, applyWorldDelta, createBallAt
// shot.ts (WP0, §5.7): quantizeShot, validateShot
// tuning.ts (WP0, §5.7): simTuning — every tunable below is read as simTuning.NAME
// ball.ts
export function cloneBall(b: BallState): BallState;                          // createBallAt lives in worldState.ts (WP0)
export function applyShot(ball: BallState, shot: ShotInput): void;        // vx = dx / SHOT_QUANTUM * POWER_SCALE, vy likewise, moving = true, slowTicks = 0
// step.ts
export function stepTick(layers: CourseLayers, world: WorldState, ball: BallState, ctx: SimContext, events: SimEvent[]): StepStatus;
// simulate.ts
export function simulateShot(layers: CourseLayers, world: WorldState, ball: BallState, shot: ShotInput, otherBalls?: readonly Vec2[]): ShotOutcome; // pure: clones inputs
// ShotIterator is defined in sim/types.ts (WP0)
export function createShotIterator(layers: CourseLayers, world: WorldState, ball: BallState, shot: ShotInput, otherBalls?: readonly Vec2[]): ShotIterator; // same loop, one tick per step(); also clones inputs
export function toShotSummary(o: ShotOutcome): ShotSummary;               // drops events; ball is a plain copy
export function outcomeOf(it: ShotIterator, worldBefore: WorldState): ShotOutcome; // after done: diffWorld + hashSimState (used by simulateShot and by the client animator)
// checksum.ts
export function hashSimState(ball: BallState, world: WorldState): number;
```

`simulateShot` is literally `const it = createShotIterator(...); while (!it.done) it.step(); return outcomeOf(it, worldBefore);`. The animator (client) uses the iterator; the server uses `simulateShot`. Identical loop ⇒ identical results. A null shot (`dx = dy = 0`) is rejected by `validateShot`, so the sim never starts a shot with zero velocity.

### 8.2 Surfaces (`surfaces.ts`)

`frictionFor(surface)`: Grass/Tar/Water/Acid → `FRICTION_GRASS` (tar/water/acid are handled by triggers before friction matters), Sand → `FRICTION_SAND`, Ice → `FRICTION_ICE`, slopes → `FRICTION_SLOPE`. Friction is a constant deceleration opposing velocity: `decel = frictionFor(surf) * DT; if (speed <= decel) v = 0 else v *= (speed - decel) / speed`. Slopes add `SLOPE_ACCEL * DT` along `(DIR_DX[slopeDir], DIR_DY[slopeDir])`; because 260 > 160 a ball never rests on a slope unless wedged (slow for `FORCED_STOP_TICKS`, i.e. pressed against a wall or another force). The surface under the ball is the one under its **centre**.

**Ball at rest on a slope (or beside a magnet).** The sim runs only during a shot. A ball that has come to rest anywhere — including on a slope after being wedged, or against an attracting magnet block — stays exactly where it is until *its owner* shoots it; other players' shots never move it, and no force acts between turns. This is a deliberate, deterministic simplification (the "parked on the hill" ball is part of the genre).

Stopping distance on grass from the maximum launch speed: `660² / (2·200) ≈ 1 089 px` (1.5 field widths); sand: `660² / 2200 = 198 px`; ice: 7 260 px (bounded by walls and the 30 s cap).

### 8.3 Per-tick algorithm (`step.ts`), executed only while `ball.moving`

```
stepTick(layers, world, ball, ctx, events):
 1  tile = tileOf(ball); surf = layers.surface[tile]; magnetForce = false
 2  FORCES
    a slope:  if isSlope(surf): v += SLOPE_ACCEL*DT * dirVec(slopeDir(surf))
    b magnets: for m in layers.magnets (course order): d = len(m.c - ball)
               if d > MAGNET_DEAD_ZONE && d < m.radius: a = m.strength * (1 - d/m.radius)
               v += m.polarity * a * DT * (m.c - ball)/d ; magnetForce = true
    c hole pull: speed = len(v); for h in layers.holes: d = len(h.c - ball)
               if d > 1e-9 && d < HOLE_PULL_RADIUS && speed < HOLE_PULL_MAX_SPEED: v += HOLE_PULL_ACCEL*DT * (h.c - ball)/d
 3  FRICTION  (see 8.2)
 4  STOP RULE  speed = len(v); forced = isSlope(surf) || magnetForce
    forced:    slowTicks = speed < STOP_SPEED ? slowTicks+1 : 0 ; if slowTicks >= FORCED_STOP_TICKS -> STOP   // wedged against a wall / held by a magnet
    otherwise: slowTicks = 0; if speed < STOP_SPEED -> STOP
    STOP := v = 0; moving = false; events.push({tick, type:'stopped'}); return 'stopped'
 5  CLAMP  if speed > MAX_SPEED: v *= MAX_SPEED/speed
 6  SUBSTEPS  repeat SUBSTEPS times:
      x += vx*SUB_DT; y += vy*SUB_DT
      resolveCollisions(layers, world, ball, ctx, events)      // 8.5
      clamp speed to MAX_SPEED (bumpers)
 7  OBJECT CHECKS at the ball centre (once per tick, in this order)
      tile = tileOf(ball); entered = tile !== ball.lastTile
      a if teleportCooldownTile !== -1 && tile !== teleportCooldownTile: teleportCooldownTile = -1
      b insideOneWay = isOneWay(world.walls[tile]) ? tile : -1
      c surf = layers.surface[tile]
        Tar && entered    -> v = 0; moving = false; events tar; lastTile = tile; return 'stopped'
        Water             -> events water; resetBall(ctx.shotOrigin); return 'water'
        Acid              -> events acid;  resetBall(ctx.startPos);   return 'acid'
      d mines: for i in layers.mines: if minesArmed[i] && len(mine.c - ball) < MINE_TRIGGER_RADIUS:
               minesArmed[i] = 0; events mine{index:i}; resetBall(ctx.shotOrigin); return 'mine'
      e teleports (if ctx.teleportCount < MAX_TELEPORTS_PER_SHOT): for pad in layers.teleports:
               if len(pad.c - ball) < TELEPORT_TRIGGER_RADIUS && pad.tile !== teleportCooldownTile:
                  partner = layers.teleports[pad.partnerIndex]; u = unitOrZero(v)
                  ball = partner.c + u*TELEPORT_EXIT_OFFSET; teleportCooldownTile = partner.tile; teleportCount++
                  events teleport{from: pad.tile, to: partner.tile}; tile = partner.tile; break   // at most one per tick
      f holes: speed = len(v); for hi, h in layers.holes: d = len(h.c - ball)
               if d <= HOLE_CAPTURE_RADIUS && speed <= HOLE_CAPTURE_MAX_SPEED:
                  ball = h.c; v = 0; moving = false; events holed{hole: hi}; return 'holed'
      g ball.lastTile = tile
 8  ctx.tick++ ; if ctx.tick >= MAX_SHOT_TICKS: v = 0; moving = false; events timeout; return 'timeout'
 9  return 'moving'
resetBall(p): x,y = p; v = 0; moving = false; lastTile = tileOf(p); teleportCooldownTile = -1; insideOneWay = -1; slowTicks = 0
```

Hole rule (D17): the funnel pull bends slow balls into the cup; a ball faster than 220 px/s over the cup is deflected by the pull but rolls on ("lip"); faster than 400 px/s it is unaffected. Multiple holes are all valid targets; `holeIndex` reports which cup.

Result semantics for the caller: `'stopped'` and `'timeout'` are scored identically (one stroke, ball stays where it is; `'timeout'` only differs in that the sim cut the motion after 30 s and the client logs it); `'water'` and `'mine'` leave the ball at `ctx.shotOrigin`, `'acid'` at `ctx.startPos`, each with `penalty = 1`; `'holed'` leaves the ball at the cup centre. Several balls may rest on the same point (all balls start on the start tile, acid returns balls there); balls never interact, so this is legal. Holed balls and balls of players who reached the stroke limit are no longer part of the field (§12.2 drawing rule, `otherBallCentres` excludes them).

### 8.4 Wall segments with shared-edge culling (`segments.ts`)

A wall tile contributes line segments in px with outward normals (away from the solid). Tile origin `(ox, oy) = (tx*TILE, ty*TILE)`, `s = Math.SQRT1_2` (exactly 0.7071067811865476):

| shape | segments (a → b, normal) |
|-------|--------------------------|
| full-footprint blocks (Full, Breakable1-3, Movable, Bumper, OneWay*) | N `(ox,oy)→(ox+15,oy)` n(0,−1); E `(ox+15,oy)→(ox+15,oy+15)` n(1,0); S `(ox,oy+15)→(ox+15,oy+15)` n(0,1); W `(ox,oy)→(ox,oy+15)` n(−1,0) |
| TriNW | N, W legs as above; hypotenuse `(ox+15,oy)→(ox,oy+15)` n(s,s) |
| TriNE | N, E legs; hypotenuse `(ox,oy)→(ox+15,oy+15)` n(−s,s) |
| TriSE | E, S legs; hypotenuse `(ox+15,oy)→(ox,oy+15)` n(−s,−s) |
| TriSW | S, W legs; hypotenuse `(ox,oy)→(ox+15,oy+15)` n(s,−s) |

**Culling rule.** `coversSide(shape, side)` is true for full-footprint blocks on all four sides, for triangles on their two legs (TriNW: N,W; TriNE: N,E; TriSE: S,E; TriSW: S,W), false for None and **false for one-way blocks** (a ball may legitimately be inside them, so neighbours keep their facing edges). An axis edge of tile A on side `S` is emitted iff A has that edge and `!coversSide(neighbour(A, S), opposite(S))`; out-of-bounds neighbours count as Full. One-way tiles never cull their own edges. Hypotenuses are never culled. Result: a straight wall of N tiles yields one flush face per tile with no exposed inner corners, so a grazing ball never snags on a seam; a triangle next to a full wall forms one continuous ramp.

**Border.** The 3×3 scan treats out-of-bounds tiles as Full with `material: 'border'`; their edges facing the field are emitted by the same rule. The ball can never leave the field (containment test, §16).

```ts
export interface Segment { ax: number; ay: number; bx: number; by: number; nx: number; ny: number; tile: number; side: 0 | 1 | 2 | 3 | 4; /* 4 = hypotenuse */ material: 'wall' | 'breakable' | 'movable' | 'bumper' | 'oneway' | 'border'; dir: number /* one-way passage dir 0..3, else -1 */ }
/** Fills `out` (preallocated, >= 45 entries) with the segments of the 3x3 tiles around tile (tx, ty), scanning rows then
 *  columns (ty-1..ty+1, tx-1..tx+1), per tile N,E,S,W then hypotenuse. Returns the count. Allocation-free. */
export function collectSegments(walls: Uint8Array, tx: number, ty: number, out: Segment[]): number;
```

### 8.5 Collision resolution (`collision.ts`)

```ts
export function closestPointOnSegment(px, py, ax, ay, bx, by): { x: number; y: number; t: number }
// t = clamp(((p-a)·(b-a)) / |b-a|², 0, 1); q = a + t(b-a)
export function resolveCollisions(layers, world, ball, ctx, events): void
```

```
resolveCollisions:
  tx, ty = tile coords of the ball centre; n = collectSegments(world.walls, tx, ty, segs)
  for iter in 0..RESOLVE_ITERATIONS-1:
    best = none
    for k in 0..n-1:  seg = segs[k]
      if seg.material == 'oneway':
         if centreInsideTile(ball.x, ball.y, seg.tile) || ball.insideOneWay == seg.tile: continue   // grid.ts helper
         along = dot(v, dirVec(seg.dir))
         if along > 0 && (seg.side == (seg.dir+2)%4 || seg.side == seg.dir): continue   // entry and exit faces open along the arrow
      q = closestPointOnSegment(ball, seg); dx = ball.x - q.x; dy = ball.y - q.y; dist = sqrt(dx²+dy²)
      if 0 < q.t < 1 && dot((dx,dy), seg.n) < 0:  pen = R + dist; nx,ny = seg.n          // centre behind an interior point: push through the front
      else:                                        pen = R - dist; (nx,ny) = dist > 1e-9 ? (dx,dy)/dist : seg.n   // endpoint => corner normal
      if pen <= 0: continue
      if best == none || pen > best.pen: best = {seg, pen, nx, ny}                       // strict '>' => first in scan order wins ties
    if best == none: return
    ball.x += best.nx * (best.pen + PENETRATION_SLOP); ball.y += best.ny * (best.pen + PENETRATION_SLOP)
    vn = vx*nx + vy*ny
    if vn < 0: respond(best, vn)
    n = collectSegments(world.walls, tileX, tileY, segs)   // re-query: walls may have changed (break/move), tile may have changed
```

`respond(best, vn)` by material (`impact = -vn`):

- **wall / border / oneway:** `v -= (1 + RESTITUTION_WALL) * vn * n`.
- **bumper:** `v -= (1 + RESTITUTION_BUMPER) * vn * n`; then if `len(v) < BUMPER_MIN_EXIT_SPEED` scale up to it. `MAX_SPEED` clamp happens after the substep.
- **breakable:** reflect with `RESTITUTION_BREAKABLE`. If `impact >= BREAK_MIN_IMPACT_SPEED` and not (`ctx.lastBreakTile == tile && ctx.tick - ctx.lastBreakTick < BREAK_DEBOUNCE_TICKS`): `breakHits[tile]++`, `lastBreakTile/Tick = tile/tick`; if `breakHits[tile] >= breakableHits(walls[tile])` → `walls[tile] = None`, event `destroyed`; else event `break{hitsLeft}`.
- **movable:** push direction = dominant axis of `-n` (`|nx| >= |ny|` → horizontal; ties → horizontal); `target = tile + dir`. Allowed iff target in bounds, `walls[target] == None`, `layers.objectAt[target] == -1`, `surface[target] ∉ {Water, Acid}`, and no `ctx.otherBalls` centre lies in the target tile. If allowed: `walls[target] = Movable; walls[tile] = None`, event `blockMoved`, reflect with `RESTITUTION_MOVABLE`. Otherwise reflect with `RESTITUTION_WALL`. Needs `impact >= MOVABLE_MIN_IMPACT_SPEED` to push.
- Every response emits `bounce{x,y,nx,ny,speed: impact, tile, material}` only if `impact >= BOUNCE_EVENT_MIN_SPEED`.

The tangential velocity component is never touched, so a ball grazing a wall slides along it. Diagonal check: a ball travelling west (`v = (−u, 0)`) in the open SE half of a TriNW tile hits the hypotenuse (n = (s, s)); `v·n = −u·s < 0`, so `v' = v − (1+e)(v·n)n = (−u + 1.78·u·s², 1.78·u·s²) = (−0.11u, 0.89u)`: the ball turns south with 0.89 of its speed, the small residual x component being the restitution loss (a perfectly elastic diagonal would give exactly `(0, u)`). Tests assert this formula within 1e-9 for all four triangles and both approach directions.

### 8.6 Magnets, teleporters, mines, water, acid, tar

Specified in §8.3. Notes: a magnet tile is a Full wall (bounces normally) plus a field; attract polarity +1 pulls toward the centre, −1 pushes away; linear falloff keeps the integration stable at 120 Hz. A slow attracted ball pressed against the magnet block keeps receiving force, so it would never fall below `STOP_SPEED` for good; the forced-stop rule (step 4: `FORCED_STOP_TICKS` consecutive slow ticks while a magnet or slope force acts) makes it rest after 0.5 s instead of running to the 30 s cap. This is a legitimate trap the designer chose; the resting ball is shot normally next turn. Teleport exit offset avoids re-trigger geometry; `teleportCooldownTile` prevents ping-pong; `MAX_TELEPORTS_PER_SHOT` ends pathological loops. Mines are consumed per hole (D21).

---

## 9. Determinism rules and checksum

1. Sim code (`packages/shared/src/sim/**`) uses only `+ - * /`, comparisons, `Math.sqrt`, `Math.floor`, `Math.ceil`, `Math.abs`, `Math.min`, `Math.max`, `Math.round`, `Math.trunc`, the literal `Math.SQRT1_2`. All are exactly specified by ECMAScript; `sqrt` is correctly rounded on every engine. **Banned**: `Math.sin/cos/tan/atan/atan2/asin/acos/pow/exp/log*/hypot/cbrt/*h/random/fround`, the `**` operator, `Date`, `performance`, `Float32Array`, `Map`/`Set` (ordering), `math/rng`.
2. Enforced by `eslint.config.js` (WP0), scoped to `packages/shared/src/sim/**`:

```js
import js from '@eslint/js';
import tseslint from 'typescript-eslint';
const banned = ['sin','cos','tan','asin','acos','atan','atan2','pow','exp','expm1','log','log2','log10','log1p','hypot','cbrt','sinh','cosh','tanh','asinh','acosh','atanh','random','fround'];
export default tseslint.config(
  { ignores: ['**/dist/**', '**/.tsout/**', '**/node_modules/**'] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    files: ['packages/shared/src/sim/**/*.ts'],
    rules: {
      'no-restricted-properties': ['error',
        ...banned.map((p) => ({ object: 'Math', property: p, message: 'Not bit-exact across engines; forbidden in sim' })),
        { object: 'Date', property: 'now', message: 'No time in sim' },
        { object: 'performance', property: 'now', message: 'No time in sim' }],
      'no-restricted-syntax': ['error',
        { selector: "BinaryExpression[operator='**']", message: 'Use multiplication' },
        { selector: "NewExpression[callee.name='Date']", message: 'No time in sim' },
        { selector: "NewExpression[callee.name=/^(Float32Array|Map|Set|WeakMap|WeakSet)$/]", message: 'Only plain arrays, Uint8Array, Int16Array, DataView in sim' }],
      'no-restricted-imports': ['error', { patterns: ['**/math/rng', '**/math/rng.ts'] }],
    },
  },
);
```

3. Inputs are integers (`ShotInput`); no angle exists as a float inside the sim. Keyboard aiming converts angle→vector with trig **on the client** and quantizes.
4. Iteration order is fixed: arrays only, tiles row-major, objects in course order, segments in scan order; substep count is a constant.
5. JS engines evaluate doubles strictly left to right and never fuse multiply-add; expression shapes are written once in shared, so Node and every browser produce bit-identical results. `JSON.stringify/parse` round-trips doubles exactly (shortest round-trip), so snapshots are bit-exact.
6. `hashSimState(ball, world)`: a 32-byte `DataView` with `x, y, vx, vy` as little-endian Float64, hashed with `fnv1a32`; the result is used as the offset basis for hashing `walls`, then `breakHits`, then `minesArmed`. Clients compare with `shotTaken.outcome.checksum` after animating; mismatch ⇒ log `desync`, adopt the reducer state (which already holds the server's ball and world delta), and `requestSnapshot()`.
7. Golden fixtures (`sim/__fixtures__/golden-shots.json`): `{ simVersion, shots: [{ course: 'b_01'|'test:<name>', from: {x,y}, shot: {dx,dy}, expect: {ticks, result, penalty, checksum} }] }`. The test fails when `simVersion !== SIM_VERSION` with a message telling how to regenerate (`npm run test:golden-update`, which sets `GOLDEN_UPDATE=1`; the test then rewrites the fixture with `node:fs` and passes). Any constant change ⇒ bump `SIM_VERSION` ⇒ regenerate. Golden tests call `resetSimTuning()` first.
8. Reading `simTuning.X` (a plain object property) is allowed in sim code and is the only sanctioned source of tunables; the lint rule set does not need to change for it.

---

## 10. Game model: reducer, events, turn rules, state machines (WP-C, `packages/shared/src/game`)

### 10.1 WP0 helper module `sim/worldState.ts` (used by the reducer and the sim)

```ts
export function createWorld(walls: Uint8Array, mineCount: number): WorldState; // copy of walls, zero hits, all mines armed
export function createWorldFromCourse(course: Course): WorldState;   // walls from wall rows via wallFromChar, mineCount = number of 'mine' objects (course order)
export function cloneWorld(w: WorldState): WorldState;
export function diffWorld(before: WorldState, after: WorldState): WorldDelta;
export function applyWorldDelta(w: WorldState, d: WorldDelta): WorldState; // new object; tiles[i] sets walls & breakHits, minesDisarmed sets 0
export function createBallAt(p: Vec2): BallState;                     // {x,y,vx:0,vy:0,moving:false,lastTile:tileOf(p.x,p.y),teleportCooldownTile:-1,insideOneWay:-1,slowTicks:0}
export function startCentre(course: Course): Vec2;                    // ((x+0.5)*TILE, (y+0.5)*TILE) of the 'start' object; throws if absent (validation guarantees presence)
```

`worldState.ts` imports only `constants.ts`, `course/types.ts`, `course/chars.ts` and `course/grid.ts` (all WP0).

### 10.2 `game/reducer.ts` — `applyEvent(state: GameState, ev: GameEvent): GameState`

Pure; never mutates its input (tests freeze inputs); returns a new object; `seq` increments on every event. An impossible transition (e.g. `shotTaken` for a player who is not on turn) throws `ReducerError` — the authority never emits such events; a client catching one calls `requestSnapshot()`.

| event | effect |
|-------|--------|
| `playerJoined` | insert into `players` keeping `joinedSeq` order; `strokes[id] = []`; `hostId = id` when `hostId` is null or names a player who is absent or `leftRound` (lobby only — the authority never emits it in other phases) |
| `playerLeft` | lobby: remove player and their `strokes`. During countdown/hole/holeSummary/roundSummary: `leftRound = true`, `connected = false`, `holeDone[id] = true`, removed from `order`; strokes rows stay (the scorecard and `ranking` keep referring to the player until `backToLobby` drops them) |
| `spectatorJoined` / `spectatorLeft` | list maintenance |
| `playerConnection` | `connected` |
| `playerAfk` | `afk = ev.afk`; when false also `consecutiveTimeouts = 0` |
| `hostChanged` | `hostId` |
| `profileChanged` / `readyChanged` / `settingsChanged` / `coursesChanged` | field updates (lobby only; `coursesChanged` also resizes nothing — strokes are allocated at `gameStarted`) |
| `countdownStarted` | `phase = 'countdown'`, `countdownEndsAtMs` |
| `gameStarted` | `seatOrder = ev.seatOrder` (every player present at countdown start, including one who left during the countdown — `holeOrder` drops `leftRound` players); for each player `strokes[id] = Array(courses.length).fill(-1)`, `ready = false`, `consecutiveTimeouts = 0`, `afk = false`; `leftRound` is **not** touched (it is already false for everyone who is still in the room, and a player who left during the countdown must stay left); `ranking = null`; `holeIndex = -1` |
| `holeStarted` | `holeIndex`, `order = ev.order`, `world = createWorldFromCourse(course)`, for every non-left player `balls[id] = createBallAt(startCentre(course))`, `shotOrigins[id] = start`, `holeDone = {}` (+ `true` for left players), `summaryReady = {}`, `turn = null`, `lastShot = null`, `phase = 'hole'` |
| `turnStarted` | `turn = { playerId, turnSeq, deadlineMs, shotInFlight: false }` (requires `phase === 'hole'`, player in `order`, not done) |
| `shotTaken` | requires `turn.playerId === ev.playerId && turn.turnSeq === ev.turnSeq && !shotInFlight`. `shotOrigins[id] = previous balls[id]` position; `balls[id] = outcome.ball`; `world = applyWorldDelta(world, outcome.worldDelta)`; `s = max(strokes[id][holeIndex], 0) + 1 + penalty`; if `result === 'holed'` → `holeDone[id] = true`; else if `s >= maxStrokes` → `s = maxStrokes`, `holeDone[id] = true` (the ball is left where it stopped; it is simply no longer drawn or considered); `strokes[id][holeIndex] = s`; `consecutiveTimeouts = 0`, `afk = false`; `lastShot = { playerId, turnSeq, shot, ticks: outcome.ticks, atMs }`; `turn.shotInFlight = true`. `result` `'stopped'` and `'timeout'` are treated identically |
| `turnTimedOut` | requires matching turn. `s = max(prev,0) + 1`; cap and `holeDone` as above; `consecutiveTimeouts++`; if it reaches 2 → `afk = true`; `turn.shotInFlight = true` |
| `turnSkipped` | requires matching turn. `turn.shotInFlight = true` (turn consumed, no stroke) |
| `holeEnded` | `phase = 'holeSummary'`, `turn = null`, `summaryReady = {}` |
| `summaryReady` | `summaryReady[id] = true` |
| `roundEnded` | `phase = 'roundSummary'`, `ranking = ev.ranking`, `turn = null` |
| `backToLobby` | `phase = 'lobby'`; drop players with `leftRound` (and their `strokes`); `holeIndex = -1`, `seatOrder = []`, `order = []`, `balls = {}`, `shotOrigins = {}`, `holeDone = {}`, `world = null`, `turn = null`, `lastShot = null`, `ranking = null`, `summaryReady = {}`, `countdownEndsAtMs = null`, all `ready = false`, `afk = false`, `consecutiveTimeouts = 0`; `strokes[id] = []` for the remaining players. Allowed from `countdown`, `hole`, `holeSummary` and `roundSummary` (the authority uses it as the "abort" transition when no active player remains) |

`maxStrokes` = `courses[holeIndex].rules.maxStrokes`. Stroke accounting lives **here**, not in the sim: every shot is +1; water/acid/mine add `penalty` (+1); a timeout is +1.

### 10.3 `game/turns.ts`, `game/scoring.ts`, `game/selectors.ts`, `game/initial.ts`, `game/serialize.ts`

```ts
// turns.ts
export function holeOrder(seatOrder: string[], holeIndex: number, players: PlayerState[]): string[]; // rotate left by holeIndex % n, drop leftRound players
export function nextTurnPlayer(state: GameState, afterPlayerId: string | null): string | null;     // cyclic walk of `order` starting after `after` (from index 0 when null); first !holeDone && !leftRound; null when none
export function isHoleComplete(state: GameState): boolean;
export function activePlayers(state: GameState): PlayerState[];        // !leftRound
export function canStart(state: GameState, minPlayers: 1 | 2): ErrorCode | null; // NOT_IN_LOBBY | NOT_ENOUGH_PLAYERS (connected players < minPlayers) | PLAYERS_NOT_READY (every connected non-host player must be ready; disconnected lobby players are ignored — they are removed after LOBBY_DISCONNECT_REMOVE_SEC anyway); courses.length must be >= 1 (always true: a room is created with BUILTIN_COURSES)
// scoring.ts
export function totalStrokes(state: GameState, playerId: string): number;      // sum of strokes >= 0
export function parPlayed(state: GameState, playerId: string): number;         // sum of par over holes with strokes >= 0
export function ranking(state: GameState): RankingEntry[];                      // active players by total asc, ties share rank (1,1,3); leftRound players appended with rank = active count + 1
// selectors.ts
export function currentCourse(state): Course | null; export function currentPlayerId(state): string | null;
export function ballOf(state, id): BallState | null; export function strokesThisHole(state, id): number;
export function isMyTurn(state, id): boolean;                                   // phase 'hole' && turn && turn.playerId === id && !turn.shotInFlight
export function otherBallCentres(state, exceptId): Vec2[];                      // resting balls of other non-done players (movable block checks)
// initial.ts
export const DEFAULT_ROOM_SETTINGS: RoomSettings = { maxPlayers: 4, turnTimeoutSec: 45, holeSummarySec: 6, ballCollision: false };
export function normalizeSettings(partial: Partial<RoomSettings> | undefined, base?: RoomSettings, minPlayers?: number): RoomSettings; // unknown/invalid values fall back to `base` (default DEFAULT_ROOM_SETTINGS); maxPlayers is raised to at least `minPlayers` (the current player count, passed by Authority.setSettings); ballCollision is forced to false
export function createLobbyState(settings: RoomSettings, courses: Course[]): GameState;            // hostId null, no players; the server passes BUILTIN_COURSES as the initial set
export function createSinglePlayerState(courses: Course[], player: PlayerState): GameState;        // lobby state with that one player (hostId = player.id, ready: true), settings { maxPlayers: 2, turnTimeoutSec: 0, holeSummarySec: 0, ballCollision: false }
// serialize.ts
export function gameStateToJson(state: GameState): GameStateJson; export function gameStateFromJson(json: GameStateJson): GameState;
```

### 10.4 `game/authority.ts` — the shared flow driver (WP-C)

The *same* driver runs inside the server `Room` and inside the client `localHost`, so single player, test play and multiplayer have one state machine. Dependencies are injected so WP-C never imports WP-A or WP-B modules (WP0 modules such as `sim/worldState.ts`, `sim/shot.ts` and `course/grid.ts` are fine — the reducer uses `createWorldFromCourse`, `createBallAt`, `startCentre`, and `shoot()` uses `validateShot`):

```ts
export interface AuthorityDeps {
  now(): number;
  setTimeout(fn: () => void, ms: number): number;
  clearTimeout(id: number): void;
  /** Wraps decodeLayers + simulateShot + summary conversion. Provided by server (WP-F) and localHost (WP-G). */
  simulate(course: Course, world: WorldState, ball: BallState, shot: ShotInput, otherBalls: Vec2[]): ShotSummary;
  /** Called after the authority has applied `ev` to its own state (so listeners may read `state`). */
  emit(ev: GameEvent): void;
  minPlayers: 1 | 2;                 // 1 for single player / test play
}
export class Authority {
  constructor(initial: GameState, deps: AuthorityDeps);
  readonly state: GameState;
  // lobby
  join(player: PlayerState): ErrorCode | null;           // ROOM_FULL when players.length >= settings.maxPlayers, GAME_IN_PROGRESS unless lobby
  leave(playerId: string): void;                         // emits playerLeft (+ hostChanged if needed, + roundEnded if < 1 active player remains during a round)
  spectatorJoin(s: SpectatorState): ErrorCode | null;    // ROOM_FULL when spectators.length >= MAX_SPECTATORS
  spectatorLeave(id: string): void;
  becomePlayer(id: string): ErrorCode | null;            // lobby only; free seat; moves spectator -> player
  setProfile(id, name, colour); setReady(id, ready); setSettings(id, partial): ErrorCode | null; setCourses(id, courses: Course[]): ErrorCode | null; // host checks
  connection(playerId: string, connected: boolean): void; // emits playerConnection; see 10.6 for timers
  activity(playerId: string): void;                      // any message from an afk player -> playerAfk false
  start(hostId: string): ErrorCode | null;               // canStart -> countdownStarted
  // play
  shoot(playerId: string, holeIndex: number, turnSeq: number, shot: ShotInput): ErrorCode | null;
  summaryReady(playerId: string): void;                  // ignored unless phase is holeSummary/roundSummary and the id is an active player
  backToLobby(requesterId: string | null): ErrorCode | null; // null = automatic (timer / no players left); otherwise NOT_HOST unless requester is host; NOT_IN_LOBBY-style misuse (phase 'lobby') -> GAME_IN_PROGRESS is NOT used, it simply returns null and does nothing
  dispose(): void;                                       // clears all timers
}
```

`join()` assigns the colour (lowest free if the requested one is taken) and `joinedSeq = ++lastJoinedSeq` (a monotonically increasing counter kept in the Authority, never reused). `setSettings` passes `players.length` as `minPlayers` to `normalizeSettings`. `setCourses` receives already-validated `Course[]` (the server's `courseStore` validates; localHost passes validated courses) and rejects `length < 1 || > MAX_COURSES_PER_SET` with `INVALID_COURSE`.

### 10.5 State machine (authority)

```
lobby ──start()──▶ countdown ──(COUNTDOWN_SEC)──▶ gameStarted ▶ holeStarted(0) ──(HOLE_INTRO_MS)──▶ turnStarted(order[0])
                                                                                                   │
   ┌───────────────────────────────────────────────────────────────────────────────────────────────┘
   ▼
 hole: on shoot()        → shotTaken → wait ticks/TICK_HZ*1000 + ANIMATION_GRACE_MS → advance()
       on turn deadline  → turnTimedOut (connected) | turnSkipped (disconnected) → advance() immediately
 advance(): isHoleComplete ? holeEnded : turnStarted(nextTurnPlayer(after = last shooter))
 holeSummary: ends when every connected active player sent summaryReady OR holeSummarySec elapsed (holeSummarySec 0 => no timer, wait for everyone;
              single player uses 0 so it waits for the player)
              → holeIndex+1 < courses.length ? holeStarted(holeIndex+1) : roundEnded(ranking)
 roundSummary: backToLobby(hostId) by the host, OR automatically when every connected active player sent summaryReady,
               OR after ROUND_SUMMARY_AUTO_LOBBY_SEC (multiplayer only). Single player: leave() ("Valikkoon") or restart (§10.7).
               Spectators may becomePlayer once the room is back in the lobby.
```

Details:
- `turnStarted.deadlineMs`: `null` when `settings.turnTimeoutSec === 0`; otherwise `now + turnTimeoutSec*1000`, or `now + AFK_TURN_TIMEOUT_SEC*1000` when the player is `afk`, or `now + DISCONNECTED_TURN_WAIT_SEC*1000` when the player is disconnected (even with timeout 0). `turnSeq` starts at 1 per round and increments on every `turnStarted`.
- Countdown length: `COUNTDOWN_SEC * 1000` ms when `minPlayers === 2`, `0` ms when `minPlayers === 1` (single player / test play has no visible countdown). The countdown is not cancellable; a player who leaves during it is `leftRound` and simply absent from `holeOrder`. If at the end of the countdown no active player remains, the authority emits `gameStarted`, then `roundEnded(ranking)` with the empty ranking, then `backToLobby(null)` (clients handle this as "Peli keskeytyi").
- `shoot()` validation order and codes: phase ≠ `hole` → `NOT_YOUR_TURN`; `turn.playerId !== playerId` → `NOT_YOUR_TURN`; `holeIndex`/`turnSeq` mismatch → `STALE_TURN`; `turn.shotInFlight` → `SHOT_IN_FLIGHT`; `!validateShot(shot)` → `INVALID_SHOT`. Then `summary = deps.simulate(course, state.world, balls[id], shot, otherBallCentres(state, id))`, emit `shotTaken{atMs: now}`, clear the deadline timer, schedule `advance()` after `summary.ticks / TICK_HZ * 1000 + ANIMATION_GRACE_MS`.
- `advance()` after `shotTaken`/`turnTimedOut`/`turnSkipped` uses `nextTurnPlayer(state, turn.playerId)`; after `holeStarted` it uses `nextTurnPlayer(state, null)`.
- A player who holes out or reaches max strokes is skipped for the rest of the hole; the first shooter rotates each hole (`holeOrder`). A hole with **one** remaining active player (others left) is played to the end by that player; the round does not abort while at least one active player remains.
- `leave()` during a round: `playerLeft`; if the leaver was on turn → clear the deadline timer and `advance()` now (if a shot of theirs is in flight, the pending `advance()` timer runs as scheduled instead); if the leaver was host → `hostChanged` to the connected, non-left player with the lowest `joinedSeq` (else any remaining non-left player; if none remain no event is emitted and the reducer's `playerJoined` rule — "`hostId` becomes the joiner when `hostId` is null **or** names a player who is absent or `leftRound`" — makes the next joiner host); if no active players remain → `roundEnded(ranking)` then `backToLobby(null)`.
- `holeSummary` whose set of connected active players is empty (everyone disconnected) ends after `HOLE_SUMMARY_SEC` regardless of the `holeSummarySec` setting; the room then idles until TTL.
- `roundSummary`: `summaryReady` is accepted from active players; a non-host `backToLobby` request returns `NOT_HOST`.

### 10.6 Disconnect, grace and AFK (authority timers; D7)

- `connection(id, false)` during **lobby**: start `LOBBY_DISCONNECT_REMOVE_SEC` timer → `leave(id)`.
- During a **round**: start `DISCONNECT_GRACE_SEC` timer → `leave(id)`. The seat is held; the player's turns are **skipped without a stroke** after `DISCONNECTED_TURN_WAIT_SEC` (so a quick reconnect can still shoot). If every remaining connected player is done and only disconnected players remain, the hole waits at most their grace.
- `connection(id, true)` cancels the timer; the current `turnStarted` deadline is not extended (the client sees the remaining time). If the reconnecting player is on turn and their deadline was the `DISCONNECTED_TURN_WAIT_SEC` one, the authority emits a **fresh** `turnStarted` (new `turnSeq`, normal deadline) so they get a full turn.
- AFK: `consecutiveTimeouts >= 2` (set by the reducer on `turnTimedOut`) ⇒ deadlines shrink to `AFK_TURN_TIMEOUT_SEC`; `activity(id)` (any message from that player) ⇒ `playerAfk{afk:false}`.
- **Host disconnect.** The host keeps the host role while disconnected (grace rules above). In the **lobby** nothing host-only is urgent: after `LOBBY_DISCONNECT_REMOVE_SEC` the host is removed and `hostChanged` goes to the connected player with the lowest `joinedSeq`. During a **hole** no host-only action exists. In **holeSummary**/**roundSummary** the automatic rules (timer / everyone ready / `ROUND_SUMMARY_AUTO_LOBBY_SEC`) keep the room moving. If the host is the *only* player and disconnects during a round, the room waits out the grace, then `leave()` → `roundEnded` → `backToLobby(null)`; the room is swept when empty.
- **Spectator disconnect**: `spectatorLeft` immediately (no grace); a `rejoin` with a spectator token after that returns `SESSION_EXPIRED`, and the client re-joins with `joinRoom{asSpectator: true}` automatically.

### 10.7 Single player specifics (WP-G wires `Authority` with `minPlayers: 1`, `turnTimeoutSec: 0`, `holeSummarySec: 0`)

Menu → Yksinpeli setup (course set: Perusradat 1–9, Yksittäinen rata, Omat radat, Tiedostosta) → `pendingLocalGame` → `#/game` → localHost creates `createSinglePlayerState`, calls `join(player)` then `start(player.id)` → 0 ms countdown (see §10.5) → title card "Rata 1/9 – Ensiputti – Par 2" (1 s) → aim → click → `shotTaken` → animation → … → hole summary waits for the player (Space/click/"Jatka") → … → round summary (scorecard, total vs par, "Pelaa uudelleen", "Valikkoon"). "Pelaa uudelleen" = `backToLobby(player.id)` followed by `start(player.id)` on the same Authority (same courses). Esc opens the pause overlay (Jatka / Lopeta); nothing is actually paused because no timers run in single player apart from the animation pacing, which is harmless. State is in memory only; a refresh ends the round. Test play (`testPlay: true`) is identical except for the HUD label and the return route.

### 10.8 Situation catalogue (what happens when …) — binding for every WP

| Situation | Rule | Where |
|-----------|------|-------|
| Ball stops on a slope | Only when wedged (`FORCED_STOP_TICKS` slow ticks). It then rests there until its owner's next shot; no force acts between turns. | §8.2, §8.3 |
| Ball held against an attracting magnet | Same forced-stop rule → rests after 0.5 s. | §8.3, §8.6 |
| Ball stops on a one-way tile / teleport tile / mine tile | Legal. One-way: `insideOneWay` lets it leave in any direction. Teleport: it did not reach the trigger radius; the next shot may trigger the pad. Mine: it is outside `MINE_TRIGGER_RADIUS`; the mine stays armed. | §8.3, §8.5 |
| Ball starts a shot on tar | `entered` is false for the start tile, so it leaves normally. | §8.3 step 7c |
| Two or more balls on the same point (start tile, acid returns, same resting spot) | Legal; balls never interact; draw order current player on top. | §8.3, §12.2 |
| Two players' balls and the hole | Independent: each ball is captured on its own shot; a holed ball leaves the field; a ball resting on the cup's tile without being captured is a normal ball. | §8.3, §12.2 |
| Shot reaches the 30 s cap | `'timeout'`: scored like `'stopped'`, ball stays where it is, client logs a warning. | §8.3 |
| Shot result `water`/`mine` | Ball to the position where this shot started, +1. `acid`: to the course start, +1. | §8.3, §10.2 |
| Player reaches `maxStrokes` without holing | `strokes = maxStrokes`, `holeDone`, ball removed from the field. | §10.2 |
| Turn timer expires (connected) | +1 stroke, ball does not move, turn passes; two in a row ⇒ AFK (5 s deadlines) until any message. | D7, §10.6 |
| Turn comes to a disconnected player | 10 s wait, then skipped without a stroke; removed after 60 s offline. | §10.6 |
| Player on turn leaves | Turn advances immediately (or after their in-flight shot). | §10.5 |
| Host disconnects / leaves | Keeps role during grace; `hostChanged` on removal; summaries advance automatically, so nothing blocks. | §10.6 |
| Last active player leaves mid-round | `roundEnded` then `backToLobby(null)`; room swept when empty. | §10.5 |
| One active player remains mid-round | Plays the rest alone. | §10.5 |
| Player leaves during countdown | `leftRound`; game starts without them (or aborts if nobody remains). | §10.5 |
| Spectator joins mid-round | Gets `roomJoined` with the full snapshot, sees everything, cannot shoot; may `becomePlayer` once back in the lobby. | §11.6 |
| Player reconnects | `rejoin` → snapshot + last 50 chat lines; if on turn with the short disconnected deadline, a fresh turn is started. | §10.6, §11.5 |
| Host sets `maxPlayers` below current player count | Clamped up to the current count. | §10.3 |
| Course without a hole / without a start / invalid | Rejected by `validateCourse` everywhere before any authority sees it (`INVALID_COURSE` on the server, greyed/blocked in the client). | §7.5 |
| Custom course too large | `TOO_LARGE` (> `MAX_COURSE_BYTES`); the frame cap `MAX_MESSAGE_BYTES` fits 18 of them. | §6.3, §7.5 |
| Checksum mismatch after animation | Log `desync`, adopt the reducer state (server ball/world), `requestSnapshot()`. Gameplay is unaffected. | §9.6 |
| Room closes while playing (server restart, TTL) | `roomLeft{roomClosed}` → dialog "Yhteys palvelimeen katkesi" → `#/mp`. | §11.5 |
| Version mismatch | `BAD_VERSION` → "Päivitä sivu" + reload button. | D10 |

---

## 11. Multiplayer server (WP-F, `packages/server`)

### 11.1 Process

One Node process: `http.createServer` serving the client build (`PUBLIC_DIR`), `/healthz` → `200 {"ok":true}`, `/api/stats` → `{ "rooms": n, "players": n, "spectators": n, "uptimeSec": n, "build": "…" }`, SPA fallback to `index.html` for unknown paths without a file extension; `ws` `WebSocketServer({ noServer: true })` attached on the `upgrade` event for path `/ws` only. Hashed assets: `Cache-Control: public, max-age=31536000, immutable`; `index.html`: `no-cache`. Graceful shutdown on SIGTERM/SIGINT: stop accepting, send `roomLeft{reason:'roomClosed'}` to all, close sockets with code 1001, exit.

`config.ts` reads env with defaults: `PORT` 8080, `HOST` 0.0.0.0, `PUBLIC_DIR` (default `path.resolve(dirname(fileURLToPath(import.meta.url)), '../../client/dist')`, i.e. `packages/client/dist` both from the bundle `packages/server/dist/index.js` and — because `tsx` runs `packages/server/src/index.ts` — from the source; if the directory does not exist at startup static serving is disabled with one `info` log line, which is the normal dev situation; an explicit empty string also disables it), `PUBLIC_ORIGIN` (comma list of allowed `Origin` values for WebSocket upgrades; unset ⇒ allow any), `MAX_ROOMS`, `MAX_CONNECTIONS`, `ROOM_IDLE_TTL_MIN`, `ROOM_EMPTY_TTL_SEC`, `LOG_LEVEL` (`debug|info|warn|error`), `TRUST_PROXY` (`true` ⇒ client IP from `X-Forwarded-For`, logging only).

### 11.2 Connection layer

- `ws/wsTransport.ts` implements `Transport` over `ws`: rejects upgrades whose `Origin` is not allowed (403) or when `connectionCount() >= MAX_CONNECTIONS` (503); `maxPayload = MAX_MESSAGE_BYTES` (oversize ⇒ `ws` closes with 1009); binary frames ⇒ close 1003; heartbeat ping every `HEARTBEAT_INTERVAL_MS`, terminate after 2 missed pongs.
- `ws/connection.ts` (`ClientSession`): per-connection state `{ conn, helloDone, playerId | null, roomCode | null, role, bucket }`; token bucket `RATE_MSGS_PER_SEC`/`RATE_BURST` (overflow ⇒ `error RATE_LIMITED`, 3 strikes ⇒ close 1008); chat limited to `CHAT_MSGS_PER_10S`; parses with `parseClientMessage` (invalid ⇒ `error INVALID_MESSAGE`, 3 strikes ⇒ close); the first message must be `hello` with matching `PROTOCOL_VERSION` and `SIM_VERSION` (else `error BAD_VERSION` + close 4000); replies `welcome`.
- `ws/gateway.ts` routes messages: `createRoom`/`joinRoom`/`rejoin` → `RoomManager`; everything else → the session's `Room` (or `error NOT_IN_ROOM`). `ping` → `pong` directly.

### 11.3 Rooms

```ts
// shared/protocol/roomCode.ts (WP-C)
export const ROOM_CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 chars, no I O 0 1
export function normalizeRoomCode(input: string): string;              // trim, uppercase, remove spaces and hyphens
export function isRoomCode(s: string): boolean;                        // exactly MAX_ROOM_CODE_CHARS chars from the alphabet
// rooms/codes.ts (WP-F)
import { ROOM_CODE_ALPHABET } from '@puttipeli/shared/protocol/roomCode';
export function generateRoomCode(): string;                            // 5 chars via crypto.randomInt; RoomManager retries on collision
// rooms/roomManager.ts
export class RoomManager {
  constructor(clock: Clock, config: Config, log: Logger);
  create(session, name, colour, settings?): Room | ErrorCode;         // SERVER_FULL when rooms >= MAX_ROOMS
  join(session, code, name, colour, asSpectator): ErrorCode | null;   // normalizeRoomCode first; asSpectator/full/in-progress -> spectator; NAME_TAKEN (case-insensitive) in lobby
  rejoin(session, code, token): ErrorCode | null;                     // SESSION_EXPIRED when unknown
  sweep(): void;                                                      // every 30 s: remove rooms empty > ROOM_EMPTY_TTL_SEC or idle > ROOM_IDLE_TTL_MIN; emits roomLeft{roomClosed}
  stats(): { rooms: number; players: number; spectators: number };
}
// rooms/room.ts
export class Room {
  readonly code: string; readonly authority: Authority; readonly createdAt: number; lastActivity: number;
  readonly members: Map<string, { session: ClientSession | null; token: string; role: 'player' | 'spectator'; name: string }>;
  handle(session, msg: ClientMessage): void;                          // applies host/turn checks via Authority return codes -> error replies
  broadcast(msg: ServerMessage): void;                                // to every connected member
  snapshotFor(session): ServerMessage;                                // roomState with gameStateToJson(authority.state)
}
```

`Room` constructs `Authority` with `createLobbyState(normalizeSettings(settings), BUILTIN_COURSES)`, `deps.simulate = (course, world, ball, shot, others) => toShotSummary(simulateShot(decodeLayers(course), world, ball, shot, others))` (layers cached per course id), `deps.emit = (ev) => broadcast({ t: 'event', ev })`, `minPlayers: 2`, clock from `Clock`. `Room.handle` maps messages to Authority calls: `setProfile`/`setReady`/`setSettings`/`setCourses`/`startGame`/`backToLobby`/`shoot`/`summaryReady`/`becomePlayer`/`leaveRoom`; spectators sending player-only messages get `NOT_A_PLAYER`; every non-null `ErrorCode` is answered with `error{code}` to that connection only. Chat: `Room.handle('chat')` sanitizes (trim, strip control chars, collapse whitespace, ≤ 200 chars) and broadcasts `{t:'chat', from, text, atMs}`; system lines (`chat.playerJoined`, `chat.playerLeft`, `chat.spectatorJoined`, `chat.hostChanged`, `chat.gameStarted`, `chat.holeResult{name, strokes}`, `chat.timeout{name}`, `chat.afk{name}`) are `{ from: null, key, params }`.

### 11.4 Authority model and shot flow

Server-simulation, not lockstep; clients never send positions.

```
shooter ──shoot{holeIndex, turnSeq, shot}──▶ Room.handle ──▶ Authority.shoot (validate: turn, seq, in-flight, validateShot)
   ──▶ deps.simulate (sub-millisecond) ──▶ reducer shotTaken ──▶ broadcast event{shotTaken} (~300 bytes)
every client: applyEvent(shotTaken) ──▶ controller animates from prev state with createShotIterator ──▶ compare hashSimState with outcome.checksum
server: timer ticks/TICK_HZ*1000 + 250 ms ──▶ turnStarted(next) | holeEnded
```

A client still animating when a later event arrives fast-forwards to the final state. No ticks are streamed. Bandwidth per shot ≈ 300 B; per hole ≈ a few KB.

### 11.5 Sessions and reconnection

- `roomJoined` returns a 128-bit `sessionToken` (`crypto.randomBytes(16).toString('hex')`); the client stores `{code, token, playerId}` in `sessionStorage` (per tab) and the last three codes in `localStorage` (recent rooms, without tokens).
- Socket loss ⇒ `Authority.connection(id, false)`; `WsClient` reconnects with backoff 0.5 → 1 → 2 → 4 → 8 s (max 10 s, ±20 % jitter) and sends `hello` then `rejoin{code, token}`; the server swaps the connection, replies `roomJoined` (full `GameStateJson`, same `playerId`), broadcasts `playerConnection{connected:true}` and sends the last 50 chat lines as `chat` messages (server keeps a ring buffer of 50).
- Grace rules per §10.6. `rejoin` after removal ⇒ `error SESSION_EXPIRED`; the client then offers "Liity katsojana" / "Takaisin".
- Host migration: on host leave the `Authority` emits `hostChanged` (lowest `joinedSeq` connected player).
- The server is stateless across restarts (rooms are in-memory). On `roomLeft{roomClosed}` or a failed reconnect the client shows "Yhteys palvelimeen katkesi" with "Takaisin valikkoon".

### 11.6 Spectators, late joiners, custom courses (D20)

- `joinRoom` into a full lobby or a room not in `lobby` ⇒ `role: 'spectator'` (max `MAX_SPECTATORS`, else `ROOM_FULL`). Spectators get the snapshot and all events, may chat, cannot shoot/ready; `becomePlayer` in the lobby claims a free seat (`Authority.becomePlayer`).
- `setCourses` (host, lobby): `courseStore.resolve(refs)` → builtin ids via `findBuiltin` (unknown ⇒ `INVALID_COURSE`), custom courses via `parseCourseFile` (errors ⇒ `INVALID_COURSE` with `issues`), id recomputed with `withComputedId`, total ≤ 18 and each ≤ `MAX_COURSE_BYTES`; then `Authority.setCourses` emits `coursesChanged{courses}` with **full data** so every client, including late joiners (snapshot), holds byte-identical courses. Clients may "Tallenna rata" a received custom course into their own library.

### 11.7 Abuse limits

Frame size cap, token bucket, chat limit, course payload validation and size caps, room cap, connection cap, origin check in production, names sanitized (trim, control chars removed, 1..16 chars, `NAME_TAKEN` within a room). No per-IP join throttling in v1 (D20).

---

## 12. Client (WP-D presentation, WP-E shell/UI, WP-G play view, WP-H multiplayer)

### 12.1 Screens (hash router, all DOM except the two game canvases; Finnish strings in `i18n/fi*.ts`, English in `en*.ts`)

| route | owner | content |
|-------|-------|---------|
| `#/` Päävalikko | WP-E | Logo "Puttipeli"; buttons **Yksinpeli**, **Moninpeli** (sub-caption from `GET /api/stats`: "Pelaajia verkossa: N" / "Huoneita: N", or "Palvelin ei tavoitettavissa" when the fetch fails — multiplayer availability is visible at once), **Rataeditori**, **Ohjeet**, **Asetukset**; footer: build id, player name quick edit ("Nimimerkki: …"). On mount, if an active `GameHost` exists it is left and cleared (`host.leave(); setActiveHost(null)`), so navigating home always ends the session cleanly. |
| `#/play` Yksinpeli | WP-E | Course source tabs: **Perusradat** (all 9 in order, or pick one = "Yksittäinen rata"), **Omat radat** (multi-select + order from `courseLibrary`; entries whose course has validation errors are greyed with "virheitä" and cannot be selected), **Tiedostosta** (upload one or more `.json`, validated via `parseCourseFile`, issues shown); preview thumbnail via `drawCourseThumbnail` (§12.2); **Aloita** → `setPendingLocalGame({...})`, `navigate('#/game')`. Player name defaults to `DEFAULT_PLAYER_NAME` when settings hold none. |
| `#/game` Pelinäkymä | WP-G | Shared by single player, test play and multiplayer. Canvas stack + `hud` (Rata 3/9 · Par 3 · Lyönnit 2 · Yhteensä 11, player chips with colours, turn marker, timer ring in MP), **Tuloskortti** (Tab), chat panel (MP, collapsible, `ui/chat.ts` bound to `host.chat`), Esc overlay (Jatka / Poistu with in-page confirm). Hole title card, hole and round summaries (`game/summaries.ts`). Without an active host or pending game ⇒ redirect `#/`. |
| `#/mp` Moninpeli | WP-H | Name (required, 1–16 chars; prefilled from settings) + colour picker (remembered in settings), **Luo huone** (settings defaults), **Liity huoneeseen** (5-char code input, `normalizeRoomCode`, paste support), **Liity katsojana** checkbox (sends `asSpectator: true`), recent rooms list with "Palaa huoneeseen" when a session token exists for that code, connection status text. Creating or joining constructs a `RoomSession`, calls `setActiveHost(session)` and navigates to `#/room/CODE` on `roomJoined`. |
| `#/room/:code` Aula | WP-H | Big room code + **Kopioi linkki** (`${origin}${pathname}#/room/CODE`), player list (colour, name, isäntä crown, Valmis check, connection dot, AFK tag), spectator list, chat with system lines, host panel: course set editor (1–18 refs: add Perusradat / Omat radat / single, reorder, remove), settings (Pelaajia 2–4, Vuoron aikaraja Ei/30/45/60 s, Yhteenvedon kesto Odota kaikkia/3/6/10 s, **Pallojen törmäys** greyed "tulossa"), **Aloita peli** (disabled with reason text until `canStart`); non-hosts see read-only settings and a **Valmis** toggle; spectators see **Liity pelaajaksi** when a seat is free; **Poistu**. Deep link with no active session ⇒ inline name prompt (and a "Liity katsojana" checkbox), then join. When the room enters `countdown` the lobby navigates to `#/game` (the `RoomSession` is already the active host); after `backToLobby` the play view navigates back to `#/room/CODE`. In `roundSummary` the host sees **Takaisin aulaan** (`backToLobby`), everyone sees **Valmis** (`summaryReady`). |
| `#/editor` | WP-I | §13 |
| `#/help` Ohjeet | WP-E | Controls (hiiri, näppäimistö, kosketus), tile legend rendered **by `tileArt`** into small canvases so it always matches the art, rules (lyöntiraja 20, vesi/happo/miina +1, terva pysäyttää, teleportit, magneetit, murtuvat/siirrettävät/yksisuuntaiset seinät, pomppuseinät), multiplayer how-to (koodi, vuorot, katsojat). |
| `#/settings` Asetukset | WP-E | Nimimerkki, pallon väri, äänenvoimakkuus, kieli (Suomi/English), tähtäysapu (yksinpeli), kosketusnäytön Lyö-painike, tehosteiden vähennys, "Tyhjennä omat radat" (in-page confirm). |
| `#/dev` Kehittäjä | WP-K | Single-player tuning panel: a slider per `SIM_TUNING_KEYS` entry calling `setSimTuning` live, a course picker, an embedded local game (same `GameController` + `localHost` as `#/game`, `testPlay: true`), "Palauta oletukset" (`resetSimTuning`) and "Kopioi arvot" (copies a `constants.ts` snippet). Leaving the screen calls `resetSimTuning()`. Never reachable from the multiplayer flow; `RoomSession` resets tuning on construction. |

Navigation: every screen has **Takaisin**; browser back works via hash history; `router.ts` matches patterns from `getScreenRegistry()` (`:param` segments), parses `?query`, calls `unmount` on the previous screen, redirects unknown hashes to `#/`.

### 12.2 Rendering (WP-D)

Two stacked `<canvas>` elements in a fixed-aspect container (logical 735×375 play area plus a 15 px frame = 765×405 logical px), DOM for all text.

1. **Static layer** (a hidden `<canvas>`): surfaces, walls, objects. Redrawn fully on hole start and when `world` changes (`destroyed`, `blockMoved`, `mine` consumed, `break` crack level); `renderer.markStaticDirty()`; blitted once per frame with `drawImage`.
2. **Dynamic layer**: balls (other players' balls at 60 % alpha, current player's on top, player-colour ring), aim line + power ticks (25/50/75 %), cosmetic particles (`effects.ts`: splash rings, mine burst, break debris, teleport flash, confetti on hole-in), turn highlight pulse.
3. **DOM HUD** (`ui/hud.ts`, WP-E): all text.

**Which balls are drawn** (the controller decides, the renderer draws what it is given): every player with `!leftRound && !holeDone[id]`, plus the ball of the player whose shot is currently being animated (it may hole out during the animation and is hidden only when the animation ends). Several balls on one point are drawn on top of each other (current player last). Resting balls of other players are not obstacles and never move.

**Field frame.** Logical canvas 765×405; the field's top-left corner is at logical (15, 15), so world px = logical px − 15 on both axes. `camera.toWorld` performs this subtraction; all renderer drawing translates by (15, 15) once. The 15 px frame is drawn as the border wall.

Renderer API (WP-D, consumed by WP-G, WP-I, WP-E):

```ts
export interface BallSprite { id: string; ball: BallState; colour: PlayerColour; alpha: number; highlight: boolean }
export interface AimSprite { from: Vec2; pull: Vec2 /* clamped, px */; power: number /* 0..1 */ }
export interface EditorOverlay { grid: boolean; hoverTile: number | -1; preview?: { layer: 'surface' | 'walls' | 'object'; value: number | CourseObject }; magnetRadii: boolean; teleportLinks: boolean; highlightTiles: number[] }
export class Renderer {
  constructor(container: HTMLElement, opts?: { editorMode?: boolean });
  readonly camera: Camera;
  setCourse(layers: CourseLayers, world: WorldState): void;   // full static redraw on next frame
  setWorld(world: WorldState): void;                          // marks static dirty if it differs
  markStaticDirty(): void;
  setBalls(balls: readonly BallSprite[]): void;
  setAim(aim: AimSprite | null): void;
  setEditorOverlay(o: EditorOverlay | null): void;
  readonly effects: Effects;                                  // effects.spawn(event: SimEvent, ball: BallState)
  render(nowMs: number): void;                                // one frame; called by loop.ts
  destroy(): void;
}
/** Draws surfaces + walls + objects of a course into any canvas at the given scale (thumbnails in #/play, lobby, library). */
export function drawCourseThumbnail(canvas: HTMLCanvasElement, layers: CourseLayers, world: WorldState | null, scale: number): void;
export class Camera { toWorld(clientX: number, clientY: number): Vec2; readonly scale: number; readonly dpr: number; fit(): void; destroy(): void }
export function startLoop(tick: (nowMs: number) => void): () => void;   // loop.ts; returns stop()
export class ShotAnimator {
  constructor(renderer: Renderer, sfx: Sfx);
  play(it: ShotIterator, sprite: BallSprite, onDone: (it: ShotIterator) => void): void; // 120 Hz accumulator, interpolated draw, forwards SimEvents
  fastForward(): void;                                                               // runs the iterator to completion and calls onDone
  readonly running: boolean;
  update(nowMs: number): void;                                                       // called from the loop by the controller
}
export interface Sfx { play(event: SimEvent | 'shot' | 'applause' | 'tick'): void; setVolume(v: number): void; unlock(): void }
export function createSfx(): Sfx;                                                    // audio/sfx.ts
```

`tileArt.ts` is 100 % procedural: grass (green base, speckle from `xorshift32(tileIndex)` — cosmetic, identical everywhere), sand (beige, dots), ice (pale blue, diagonal highlights), tar (near-black, gloss), water (blue, static wave strokes), acid (yellow-green, bubbles), slopes (grass with three darker chevrons pointing downhill), walls (bevelled blocks: lighter top-left, darker bottom-right, 2 px), triangles bevelled along both legs, breakable (brick pattern + 0–2 crack lines by remaining hits), movable (block with four-arrow glyph), bumper (block with red rounded ring), one-way (block with hollow arrow, lighter on the passable face), teleport (concentric rings in one of 8 group colours + small digit for colour-blind players), magnet (red "+" attract / blue "−" repel face on the block, faint radius circle in the editor), mine (dark disc, 8 spikes, grey when disarmed), hole (dark disc r 7.5 with inner shadow and a small flag post), start (light tee ring). Ball: white disc, radial gradient, 1.5 px colour ring.

`camera.ts`: `scale = min(containerW/765, containerH/405)`; integer scale preferred when ≥ 1; backing store = CSS size × `devicePixelRatio`; `ctx.setTransform(scale*dpr, 0, 0, scale*dpr, 0, 0)` so all drawing uses logical px; `toWorld(clientX, clientY)` inverse mapping; `ResizeObserver` on the container; `imageSmoothingEnabled = false` for the static blit at integer scales.

`loop.ts`: `requestAnimationFrame`; `shotAnimator.ts` advances the `ShotIterator` with a 120 Hz accumulator (`alpha` interpolation between the last two tick positions for smooth 60/144 Hz display), forwards `SimEvent`s to `sfx` and `effects` at their tick, exposes `fastForward()` and `onDone(outcome)`.

### 12.3 Input and aiming (WP-D `game/input.ts`)

- Aiming is active only when `isMyTurn(state, localPlayerId)` and no animation is running. `pull = toWorld(pointer) − ballPos`; clamped to `MAX_PULL_PX`; `quantizeShot(pull)` is what both the preview and the shot use (what you see is what the authority gets). The aim line is visible whenever the pointer is over the canvas during the player's turn (before and while the button is held), drawn from the ball toward the cursor with length = clamped pull, colour from white to red with power; a power bar in the HUD mirrors `|pull|/120`; beyond the cap the line stops and the bar turns red.
- **Mouse:** `pointerdown` arms, `pointerup` on the canvas fires; dragging off-canvas or Esc cancels; right-click cancels; pulls shorter than `MIN_PULL_PX` are ignored (dead zone, nothing is sent).

```ts
// game/input.ts (WP-D)
export interface AimInput {
  setBall(pos: Vec2 | null): void;             // null disables aiming
  setEnabled(on: boolean): void;
  getAim(): AimSprite | null;                  // current preview (quantized then de-quantized, so it matches the shot exactly)
  onShoot(cb: (shot: ShotInput) => void): () => void;
  onCancel(cb: () => void): () => void;
  destroy(): void;
}
export function createAimInput(canvas: HTMLElement, camera: Camera, opts: { touchFireButton: boolean; fireButton?: HTMLElement }): AimInput;
export function keyboardAimToPull(angleRad: number, power01: number): { x: number; y: number }; // tested pure helper
```
- **Keyboard initial state:** when a turn starts, angle = direction from the ball to the nearest hole centre (0 rad = east if no hole can be resolved), power = 50 %.
- **Touch (`pointerType === 'touch'`):** drag anywhere to aim relative to the ball; release does not fire; a **Lyö** button in the HUD fires (setting `touchFireButton`, default on for touch).
- **Keyboard:** ←/→ rotate 2° (Shift 0.25°), ↑/↓ power 2 % (Shift 0.5 %), Space/Enter shoot, Esc cancel; the angle/power pair becomes a vector with `Math.cos/sin` on the client and is quantized identically. Tab toggles the scorecard, C focuses chat (MP), G grid overlay (editor only).
- During ball motion input is locked; the camera never scrolls.

### 12.4 Play view controller (WP-G `game/controller.ts`)

`GameController(host: GameHost, root: HTMLElement)` subscribes to the host; on `shotTaken` it builds a `ShotIterator` from `prev.balls[pid]`, `prev.world`, `otherBallCentres(prev, pid)` and the event's `shot` (`createShotIterator(decodeLayers(course), …)`, layers cached per course id), animates, then compares `outcomeOf(it, prev.world).checksum` with `outcome.checksum` (§9.6). If a later event arrives while animating it calls `animator.fastForward()` first. Ball sprites follow the drawing rule in §12.2. On `holeStarted` it marks the static layer dirty and shows the title card. It renders the HUD from `state`, the timer from `turn.deadlineMs − host.nowAuthorityMs()`, the summaries on `holeEnded`/`roundEnded`, and calls `host.summaryReady()` on "Jatka". Leaving navigates to `pending.returnTo` (single player) or `#/room/CODE` / `#/mp` (multiplayer).

`game/localHost.ts` implements `GameHost` with `Authority` (`minPlayers: 1`, browser timers, `simulate` via `decodeLayers` + `simulateShot`), one player from settings, `chat: null`.

### 12.5 Multiplayer client (WP-H)

`net/socket.ts` `WsClient`: URL `${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws` (Vite proxies `/ws` in dev), typed `send`, `on(type)`, reconnect backoff (§11.5), `ping` every 10 s → clock offset = median of the last 5 `(serverTimeMs − (t0 + rtt/2))`. `net/roomClient.ts` `RoomSession implements GameHost, ChatApi`: holds `GameState` (`gameStateFromJson` on `roomJoined`/`roomState`, `applyEvent` on `event`, `requestSnapshot` on `ReducerError` or checksum mismatch), `localPlayerId` (`''` for spectators; the member id is kept privately as `memberId` for chat/rejoin), role, chat ring buffer (cleared on every `roomJoined`), error listeners; `shoot()` sends `{t:'shoot', holeIndex, turnSeq, shot}`; `backToLobby()` sends `{t:'backToLobby'}`; `restart()` is a no-op; `leave()` sends `leaveRoom`, clears the session token and stops reconnecting; the constructor calls `resetSimTuning()`. Lobby actions that are not part of `GameHost` (`setReady`, `setProfile`, `setSettings`, `setCourses`, `startGame`, `becomePlayer`) are public methods of `RoomSession` used by the lobby screen (same WP). `net/session.ts`: `sessionStorage` tokens per code, `localStorage` recent rooms.

### 12.6 Audio (WP-D `audio/sfx.ts`) and settings (WP-E)

WebAudio-synthesized: click (shot), bounce (volume by impact speed), sand, splash, acid fizz, mine blast, teleport chirp, break crack, block slide, bumper boing, cup drop, applause on round end. Unlocked on first user gesture; volume from settings. `storage/settings.ts`: `{ name, colour, volume, language, aimGuide, touchFireButton, reduceEffects }` in `localStorage` key `puttipeli.settings.v1`, every access in try/catch with defaults (`name: ''`, `colour: 0`, `volume: 0.7`, `language: 'fi'`, `aimGuide: false`, `touchFireButton: true`, `reduceEffects: false`).

### 12.7 WP-E UI building blocks used by WP-G, WP-H and WP-I

```ts
// ui/components.ts
export function el<K extends keyof HTMLElementTagNameMap>(tag: K, attrs?: Record<string, string | boolean | ((e: Event) => void)>, ...children: (Node | string)[]): HTMLElementTagNameMap[K];
export function button(label: string, onClick: () => void, opts?: { primary?: boolean; disabled?: boolean; title?: string }): HTMLButtonElement;
export function toast(text: string, kind?: 'info' | 'error', ms?: number): void;
// ui/dialogs.ts
export function confirmDialog(text: string, opts?: { ok?: string; cancel?: string }): Promise<boolean>;
export function alertDialog(text: string, opts?: { ok?: string; reload?: boolean }): Promise<void>;
export function promptDialog(text: string, opts?: { initial?: string; maxLength?: number; validate?: (s: string) => string | null }): Promise<string | null>;
// ui/hud.ts
export interface Hud { root: HTMLElement; update(state: GameState, localPlayerId: string, nowAuthorityMs: number): void; setPower(power01: number | null): void; setLabel(text: string | null): void; fireButton: HTMLButtonElement /* hidden unless touch */; destroy(): void }
export function createHud(container: HTMLElement): Hud;
// ui/scorecard.ts
export function renderScorecard(container: HTMLElement, state: GameState, localPlayerId: string): void;   // idempotent re-render
// ui/chat.ts
export function mountChat(container: HTMLElement, api: ChatApi, opts?: { collapsible?: boolean }): { focus(): void; destroy(): void };
```

All text inside these comes from `t()`; the HUD shows the turn timer from `turn.deadlineMs − nowAuthorityMs` and nothing when `deadlineMs` is null.

---

## 13. Course editor (WP-I, `#/editor`)

### 13.1 Layout

Top toolbar: **Uusi**, **Avaa** (library modal), **Tallenna** (library), **Lataa JSON**, **Vie JSON**, **Jaa koodina** (clipboard), **Testaa**, **Kumoa**, **Tee uudelleen**, **Ruudukko**, **Takaisin valikkoon**. Left palette with tabs **Pinnat** (Nurmi, Hiekka, Jää, Terva, Vesi, Happo, Rinne ↑ → ↓ ←), **Seinät** (Seinä, Kulma ↖ ↗ ↘ ↙, Murtuva 1/2/3, Siirrettävä, Pomppu, Yksisuuntainen ↑ → ↓ ←, Poista seinä), **Kohteet** (Lähtö, Reikä, Teleportti + ryhmä 1–8 colour chips — displayed label = `group + 1`, data stays 0–7, Magneetti + napaisuus, Miina, Poista kohde); palette buttons are drawn with `tileArt`. Centre: the game `renderer` in editor mode (grid overlay, hover highlight, 60 % alpha preview of the selected tile, magnet radius circles, teleport pair lines). Right inspector: metadata (Nimi, Tekijä, Kuvaus, Par 1–20, Lyöntiraja 1–50), selected object properties (teleport group, magnet polarity/strength 50–1200/radius 30–240), live validation list (errors red, warnings yellow; clicking an issue highlights the tile). Bottom status: cursor tile, layer values under cursor, dirty indicator.

### 13.2 Tools (`editor/tools.ts`, every mutation through `course/edit.ts`)

Sivellin (paint, drag; Shift-click = `line` from the last tile), Suorakulmio (drag; Alt = outline), Täyttö (`floodFill` on the active layer), Viiva, Pyyhin (grass / none / remove object), Pipetti (right-click anywhere picks the tile or object into the palette), Tarkastele (select a tile for the inspector). Object placement follows the `placeObject` invariants (§7.7), with a toast when a wall paint removes an object. Keys: 1/2/3 tabs, B R F L E I tools, G grid, Ctrl+Z / Ctrl+Y, Ctrl+S save to library, T test play, Esc deselect.

### 13.3 History, validation, save/load

- `editor/history.ts`: up to 200 `Course` snapshots (~3 KB each), one entry per drag gesture.
- Validation runs on every change (debounced 50 ms) via `validateCourse`; errors block **Testaa**, **Vie**, **Jaa**, and adding to a course set; saving a draft to the library is always allowed (flagged "virheitä"). Messages come from `t('validation.' + code, params)` (core dictionary, WP-E).
- `storage/courseLibrary.ts` (WP-E) API used by the editor, the single-player setup and the lobby:

```ts
export interface LibraryEntry { key: string /* uuid, stable across edits */; course: Course; savedAt: number }
export function listCourses(): LibraryEntry[];           // localStorage 'puttipeli.courses.v1'
export function saveCourse(course: Course, key?: string): LibraryEntry; // new key when omitted; id recomputed with withComputedId
export function deleteCourse(key: string): void;
export function duplicateCourse(key: string): LibraryEntry | null;
export function saveDraft(course: Course | null): void;  // 'puttipeli.editorDraft.v1', written on every change
export function loadDraft(): Course | null;
export function onLibraryChange(listener: () => void): () => void;
```

- `editor/importExport.ts`: **Vie JSON** downloads `<slug>.puttipeli.json` (Blob URL + `<a download>`; this is a normal web page, not a sandboxed artifact), **Lataa JSON** via `<input type=file accept=.json>` and drag-and-drop onto the canvas, both through `parseCourseFile` (issues listed, never silently fixed); **Jaa koodina** copies the canonical JSON to the clipboard (`navigator.clipboard.writeText`, with a fallback textarea the user can copy from); **Tuo koodista** opens a textarea dialog into which the JSON is pasted (clipboard *reading* is not relied upon). Opening a file/code while the current course is dirty asks for confirmation.
- Library modal "Omat radat": Avaa / Monista / Poista (inline confirm) / Vie.

### 13.4 Test play (`editor/testPlay.ts`)

`setPendingLocalGame({ courses: [current], testPlay: true, returnTo: '#/editor' })` → `#/game`; HUD shows "Testaus — Esc palaa editoriin"; the editor state (including undo history and draft) stays in memory and is restored on return. Because test play uses the same `simulateShot`, what works in the editor works identically online.

### 13.5 How editor courses enter the game

Single player: "Omat radat" and "Tiedostosta" tabs (§12.1). Multiplayer: the host's lobby course picker lists the same library; selected custom courses are sent as `{ kind: 'custom', course }` refs in `setCourses` (§11.6); every participant can save a received course ("Tallenna rata").

---

## 14. Deployment (WP-J)

### 14.1 Local development

`npm install` once; `npm run dev` starts Vite on http://localhost:5173 (client, proxying `/ws` and `/api` to :8080) and `tsx watch` on :8080 (server with `PUBLIC_DIR=` empty, i.e. API + WebSocket only). Multiplayer is tested locally by opening two browser windows. `npm run build && npm start` runs the production layout on http://localhost:8080 (static client + `/ws` on the same origin — no CORS, the client derives `wss://${location.host}/ws`).

### 14.2 `Dockerfile` (multi-stage, D9)

```dockerfile
FROM node:24-alpine AS build
ARG BUILD_ID=docker
ENV BUILD_ID=$BUILD_ID
WORKDIR /app
COPY package.json package-lock.json ./
COPY packages/shared/package.json packages/shared/
COPY packages/client/package.json packages/client/
COPY packages/server/package.json packages/server/
RUN npm ci
COPY . .
RUN npm run build && npm prune --omit=dev

FROM node:24-alpine
ENV NODE_ENV=production PORT=8080 HOST=0.0.0.0 PUBLIC_DIR=/app/packages/client/dist
WORKDIR /app
COPY --from=build /app/package.json ./
COPY --from=build /app/node_modules ./node_modules
COPY --from=build /app/packages/shared/package.json ./packages/shared/
COPY --from=build /app/packages/client/package.json ./packages/client/
COPY --from=build /app/packages/client/dist ./packages/client/dist
COPY --from=build /app/packages/server/package.json ./packages/server/
COPY --from=build /app/packages/server/dist ./packages/server/dist
USER node
EXPOSE 8080
HEALTHCHECK --interval=30s --timeout=5s --retries=3 CMD wget -qO- http://127.0.0.1:8080/healthz || exit 1
CMD ["node", "packages/server/dist/index.js"]
```

`.dockerignore`: `node_modules`, `**/node_modules`, `**/dist`, `**/.tsout`, `.git`, `coverage`, `.env*`, `docs`, `*.md`. After `npm prune --omit=dev` the root `node_modules` holds only `ws` and the workspace symlinks (`@puttipeli/*` → `../../packages/*`, which exist in the runtime image because their `package.json` files are copied). The server bundle is self-contained apart from `ws`.

### 14.3 `fly.toml` — recommended host (D23)

```toml
app = "puttipeli"
primary_region = "arn"            # Stockholm, ~10 ms from Finland

[build]
  dockerfile = "Dockerfile"

[env]
  NODE_ENV = "production"
  PUBLIC_ORIGIN = "https://puttipeli.fly.dev"   # set to the real app URL after `fly launch`
  LOG_LEVEL = "info"

[http_service]
  internal_port = 8080
  force_https = true
  # MODE A (default, recommended): always on. Rooms live in memory, so exactly one always-on machine is required.
  auto_stop_machines = "off"
  auto_start_machines = true
  min_machines_running = 1
  # MODE B (near-zero cost): comment the three lines above and uncomment these. The machine suspends when idle and
  # resumes in ~1 s on the first request; process memory is preserved on suspend, but a long idle gap can still end rooms.
  # auto_stop_machines = "suspend"
  # auto_start_machines = true
  # min_machines_running = 0

  [[http_service.checks]]
    interval = "30s"
    timeout = "5s"
    grace_period = "10s"
    method = "GET"
    path = "/healthz"

[[vm]]
  size = "shared-cpu-1x"
  memory = "256mb"
```

Why Fly.io: long-lived WebSockets pass through its proxy without idle cut-offs; a single always-on `shared-cpu-1x`/256 MB machine costs roughly 2–3 USD/month and keeps in-memory rooms alive; there is a Nordic region; `fly scale count 1` guarantees no second instance (rooms are not shared between instances). Deploy steps for the **user** (the agent never deploys): `fly launch --no-deploy --copy-config`, adjust `PUBLIC_ORIGIN`, `fly deploy`, `fly scale count 1`.

### 14.4 `render.yaml` — free alternative

```yaml
services:
  - type: web
    name: puttipeli
    runtime: docker
    plan: free              # spins down after ~15 min idle (cold start 30–60 s, open rooms are lost); 'starter' removes the sleep
    region: frankfurt
    healthCheckPath: /healthz
    envVars:
      - key: NODE_ENV
        value: production
      - key: PORT
        value: "8080"
      - key: PUBLIC_ORIGIN
        value: https://puttipeli.onrender.com
```

Render's free tier is zero-cost and WebSockets work, but the sleep-on-idle makes "send a code to a friend" unreliable, so it is the documented fallback, not the recommendation.

### 14.5 Environment variables (`server/src/config.ts`, all optional)

`PORT` 8080 · `HOST` 0.0.0.0 · `PUBLIC_DIR` (client dist path; empty disables static) · `PUBLIC_ORIGIN` (comma list; unset = allow any origin) · `MAX_ROOMS` 200 · `MAX_CONNECTIONS` 1000 · `ROOM_IDLE_TTL_MIN` 90 · `ROOM_EMPTY_TTL_SEC` 120 · `LOG_LEVEL` info · `TRUST_PROXY` false · `BUILD_ID` (set by CI/Docker build arg into the bundle). No secrets exist; `.env` is git-ignored; `.env.example` lists these.

### 14.6 README outline (WP-J, Finnish + English short sections)

Mikä Puttipeli on · Vaatimukset (Node 24) · Kehitys (`npm install`, `npm run dev`, portit) · Testit ja tyyppitarkistus · Tuotantobuild (`npm run build && npm start`) · Docker (`docker build -t puttipeli . && docker run -p 8080:8080 puttipeli`) · Julkaisu Fly.io:hon (vaiheet, kustannus, moodit A/B) · Vaihtoehto Render · Ympäristömuuttujat · Ratatiedoston muoto (link to DESIGN §7) · Lisenssi/alkuperäisyys.

---

## 15. Work packages, file ownership, dependencies, acceptance criteria

Rules: a WP edits only its own files (§3 tags) and may add `*.test.ts` files beside its own sources. Cross-WP needs are satisfied by the signatures in this document; if a signature is missing or wrong, the agent reports it to the lead instead of editing someone else's file. Every WP ends with `npm run typecheck && npm test && npm run lint` green at the root and a commit. Phases of the same WP share the same owner and files.

### M0 — WP0 Scaffold and contracts (one agent, must land first)

Files: root `package.json`, `package-lock.json`, `tsconfig.base.json`, `eslint.config.js`, `vitest.config.ts` (`passWithNoTests: true`), `.gitignore` (+ `.tsout/`); `packages/shared/{package.json, tsconfig.json}`, `shared/src/index.ts`, `constants.ts`, `math/{vec,hash,rng}.ts` + `math/math.test.ts`, `course/{types,chars,grid}.ts` + `course/grid.test.ts`, `sim/{types,worldState,shot,tuning}.ts` + `sim/worldState.test.ts` + `sim/shot.test.ts`, `game/{types,events}.ts`, `protocol/{version,messages,codes,limits}.ts`; `packages/client/{package.json, tsconfig.json, vite.config.ts, index.html}`, `client/src/app/{screen,activeHost,env.d}.ts`, `client/src/game/gameHost.ts`, `client/src/i18n/t.ts`; `packages/server/{package.json, tsconfig.json, build.mjs}`, `server/src/clock.ts`, `server/src/ws/transport.ts`. WP0 also removes the scaffold's `packages/shared/tsconfig.tsbuildinfo` (a build artefact; add `*.tsbuildinfo` to `.gitignore`) and replaces the placeholder `packages/shared/src/index.ts` (`export {};`). The empty root file `asd` is of unknown origin: WP0 leaves it alone and reports it to the lead (CLAUDE.md forbids deleting files Claude did not create).
Acceptance: `npm install` clean; `npm run typecheck`, `npm test`, `npm run lint` green; contract files match §5–§6 verbatim; `git commit -m "M0: scaffold and contracts"`. (`npm run build` turns green when WP-E and WP-F land — `index.html` references `src/main.ts`, which WP-E owns. Until then `tsc -b packages/client` still passes because the client has no sources beyond the contracts.)

### M1 — parallel, disjoint

**WP-A Course model and content** — files: `shared/src/course/{parse,canonical,migrate,validate,reachability,edit,blank,builtin}.ts`, `course/builtin/*.json` (9), `course/*.test.ts`. Depends on WP0 only.
Acceptance: every rule in §7.5 has a positive and a negative test; `parse ↔ encode` round trip for all built-ins and a fixture using every character; `edit.ts` invariants tested (placing a magnet sets Full, hazard paint removes objects, flood fill bounds, line endpoints); all 9 built-ins: zero errors, `UNREACHABLE_HOLE` absent, ids `b_01…b_09`, names/pars/mechanics as in `docs/COURSES.md`, each ≤ 32 KB.

**WP-B Physics** — files: `shared/src/sim/{ball,segments,collision,surfaces,objects,step,simulate,checksum,testCourses}.ts`, `sim/*.test.ts` (collision, diagonal, friction, slopes, hole, hazards, teleport, magnet, breakable, movable, oneway, bumper, containment, determinism, golden), `sim/__fixtures__/golden-shots.json`. Depends on WP0 only; tests build `CourseLayers` by hand (`testCourses.ts` exports `buildLayers(surfaceRows: string[], wallRows: string[], objects: CourseObject[]): CourseLayers`, a WP-B-private decoder duplicating only what the tests need; it is **not** used by production code, which uses WP-A's `decodeLayers`). Phase 2 (after WP-A): add golden shots on the 9 built-ins.
Acceptance: §16 shared sim tests green; `collectSegments` allocation-free; `simulateShot` of a 30 s shot < 5 ms in Node; containment test passes.

**WP-C Game model and protocol validation** — files: `shared/src/game/{reducer,turns,scoring,selectors,initial,serialize,authority}.ts` + tests, `shared/src/protocol/{validate,roomCode}.ts` + tests. Depends on WP0 only (Authority gets `simulate` injected; tests use a fake returning canned `ShotSummary`s and fake timers).
Acceptance: reducer never mutates inputs (`Object.freeze` deep in tests); Authority scenario tests: 3-player 2-hole round with rotation, holed player skipped, max-strokes cap, timeout +1, AFK after two timeouts with 5 s deadline, disconnected skip without stroke and removal after grace, leave mid-turn, host migration, spectator → player, countdown, summary by timer and by ready, ranking ties; `parseClientMessage` fuzz (malformed JSON, wrong types, oversize strings, non-integer shots) rejects everything invalid and accepts a fixture of every valid message.

**WP-D Presentation** — files: `client/src/render/*`, `client/src/game/{camera,loop,shotAnimator,input}.ts`, `client/src/game/input.test.ts`, `client/src/audio/sfx.ts`, `client/dev/render.html`, `client/dev/render.ts`. Depends on WP0 only (`ShotIterator` is a WP0 type; the harness builds `CourseLayers` by hand).
Acceptance: harness at `/dev/render.html` draws every surface, wall shape and object, animates a scripted iterator stub, scales with the window and HiDPI; `input.test.ts` covers clamp, dead zone, quantization, keyboard angle→vector; `tileArt` smoke test draws every code without throwing against a minimal canvas stub.

**WP-E Shell and UI** — files: `client/src/main.ts`, `app/{router,store}.ts`, `i18n/{fi,en}.ts`, `storage/{settings,courseLibrary}.ts` + test, `ui/{components,hud,scorecard,chat,dialogs}.ts`, `ui/styles.css`, `screens/{mainMenu,singleSetup,help,settings}.screen.ts`, `public/favicon.svg`. Phase 1 (WP0 only): router, store, components, dialogs, settings, main menu, settings screen, help text, `courseLibrary` (stores `Course` objects, validation deferred), `fi.ts`/`en.ts` including every `validation.<code>` string from §7.5; phase 2 (after A, C, D): `hud.ts`/`scorecard.ts` (use WP-C selectors/scoring), single-setup thumbnails + file upload + library validation (WP-A `parseCourseFile`/`validateCourse`), help legend via `tileArt` (WP-D), listing of built-ins.
Acceptance: `npm run dev` shows the main menu with the five buttons and the `/api/stats` caption (fallback text when the server is down); routes `#/`, `#/play`, `#/help`, `#/settings` work; language switch re-renders; `courseLibrary` tests with a throwing `localStorage` stub; HUD/scorecard render from a fixture `GameState`.

**WP-F Server** — files: `server/src/{index,config,http,log}.ts`, `server/src/ws/{wsTransport,fakeTransport,connection,gateway}.ts`, `server/src/rooms/{codes,roomManager,room,session,courseStore}.ts`, `server/src/**/*.test.ts` (except `integration.test.ts`). Phase 1 (WP0 only): http, config, log, transports, connection (hello/version/rate limit), gateway skeleton, codes, roomManager lifecycle + tests. Phase 2 (after A, B, C): `room.ts` with `Authority`, courseStore, session/grace wiring + tests.
Acceptance: `npm run dev -w packages/server` serves `/healthz` and `/api/stats`; room tests via `FakeTransport` + fake `Clock` cover create/join/full/spectator, start gating, shoot authority errors (`NOT_YOUR_TURN`, `STALE_TURN`, `SHOT_IN_FLIGHT`, `INVALID_SHOT`), event broadcast order, pacing timer, custom course validation and re-broadcast, rejoin with valid/invalid token, lobby disconnect removal, grace removal, host migration, rate limiting, sweep.

### M2 — integration (after the M1 packages they depend on)

**WP-G Single player** — files: `client/src/game/{localHost,controller,summaries}.ts`, `client/src/game/game.screen.ts`. Depends on A, B, C, D, E.
Acceptance: a full 9-hole single-player round is playable from the menu; test play from a `pendingLocalGame` with `testPlay: true` returns to `returnTo`; checksum check logs no desync across a round; Esc pause; summaries; scorecard.

**WP-H Multiplayer client** — files: `client/src/net/{socket,roomClient,session}.ts`, `screens/{mp,lobby}.screen.ts`, `ui/mp.css`, `i18n/{fi,en}.mp.ts` (includes `error.<ErrorCode>` and `chat.*` system-line strings). Depends on A (built-in list and course validation in the lobby picker), C, D (thumbnails), E (and F for manual testing).
Acceptance: two browser windows on `npm run dev` complete a 2-hole round; join by link; reconnect after killing the socket (devtools offline) restores the game; spectator view; `BAD_VERSION` dialog; recent rooms list.

**WP-I Editor** — files: `client/src/editor/*`, `i18n/{fi,en}.editor.ts`. Depends on A, D, E (and G for test play at runtime).
Acceptance: all tools, undo/redo (200), live validation, library save/open/duplicate/delete, JSON export/import + drag-and-drop, clipboard share, test play round-trip, a course made in the editor is playable in single player and (with F/H) in a multiplayer room.

### M3 — ship and harden

**WP-J Deployment** — files: `README.md`, `Dockerfile`, `.dockerignore`, `.env.example`, `fly.toml`, `render.yaml`. Depends on E, F.
Acceptance: `npm run build && npm start` serves the game on :8080 with working multiplayer on one origin; `docker build` succeeds locally when Docker is available (otherwise the Dockerfile is reviewed line by line against §14.2); README commands verified.

**WP-K Hardening** — files: `server/src/integration.test.ts`, `shared/src/sim/solvability.test.ts`, `shared/src/sim/__fixtures__/solvability.json`, `client/src/screens/dev.screen.ts`, `client/src/i18n/fi.dev.ts`, `docs/QA.md`. Depends on everything.
Acceptance: integration test boots the real server on port 0, three `ws` clients play one hole with scripted shots and every client's `applyEvent` state equals the server snapshot with matching checksums; solvability fixtures hole out every built-in in ≤ par + 2; `createWorldFromCourse(c)` equals `createWorld`-path world for all built-ins; QA checklist executed once and results recorded.

**Lead — tuning pass**: play-test with `#/dev`, adjust `constants.ts`, bump `SIM_VERSION`, regenerate golden and solvability fixtures, update COURSES.md pars if needed.

### Dependency graph

```
WP0 ─┬─ WP-A ─┬─────────────┬─ WP-G ─┬─ WP-K
     ├─ WP-B ─┤             │        │
     ├─ WP-C ─┼─ WP-F(2) ───┼─ WP-H ─┤
     ├─ WP-D ─┼─ WP-E(2) ───┼─ WP-I ─┤
     ├─ WP-E(1)             │        │
     └─ WP-F(1)             └─ WP-J ─┘
```

---

## 16. Testing plan (Vitest, node environment, tests beside sources)

### 16.1 Shared — course (WP-A)

- `parse.test.ts`: `decodeLayers` ↔ `encodeLayers` round trip for all 9 built-ins and a fixture containing every character; `tileOf` clamps; object tables (holes order, teleport partners, magnet clamping).
- `canonical.test.ts`: key order fixed, `id` excluded, `courseId` stable across key reordering and whitespace, two different courses differ.
- `migrate.test.ts`: unknown format, too-new version, defaults filled, invalid structure reported as issues.
- `validate.test.ts`: one positive + one negative test per code in §7.5; warnings do not block.
- `reachability.test.ts`: blocked by walls → unreachable; through a breakable → reachable; via teleport → reachable; water moat → unreachable.
- `edit.test.ts`: every op in §7.7 including invariants and immutability (input deep-frozen).
- `builtin.test.ts`: all 9 valid, reachable, ids/names/pars match `docs/COURSES.md`, sizes ≤ 32 KB.

### 16.2 Shared — sim (WP-B, WP-K)

- `collision.test.ts`: head-on bounce from 4 sides returns `0.78×` speed and resolves to exactly `BALL_RADIUS` distance; convex corner reflects along the corner normal; 15 px corridor does not trap; grazing a 10-tile wall keeps the tangential velocity (no seam snag: speed drop only from friction); inner corner torture (ball fired into a 90° inner corner from 50 angles: no residual penetration > 0.05 px, no reflection back along the incoming path).
- `diagonal.test.ts`: each triangle turns a cardinal shot 90° (formula in §8.5 within 1e-9); sweep 50…900 px/s head-on into every hypotenuse: never penetrates; triangle next to full wall: continuous ramp (no extra bounce event at the join).
- `friction.test.ts`: stopping distance on grass/sand/ice = `v²/(2a)` within one tick's travel; ball rests below `STOP_SPEED`; ice slides far longer than sand.
- `slopes.test.ts`: uphill shot returns and rolls to the bottom wall; four directions symmetric; wedged ball on a slope rests after `FORCED_STOP_TICKS`; a ball resting on a slope is not moved by another ball's shot (sim only moves the shot ball).
- `hole.test.ts`: slow ball captured and snapped; 300 px/s ball deflected not captured; 500 px/s unaffected; multiple holes each capture with the right `holeIndex`.
- `hazards.test.ts`: water → shot origin, penalty 1, result `'water'`; acid → start; tar stops on entry, ball starting on tar can leave; mine consumed once, re-armed by `createWorld`.
- `teleport.test.ts`: velocity preserved, exit offset, cooldown prevents immediate return, cooldown clears after leaving the pad tile, 40-teleport cap ends loops.
- `magnet.test.ts`: attract bends toward, repel away, no force at rest beyond radius, dead zone, two magnets sum; a slow ball pulled against an attract block rests via the forced-stop rule well before `MAX_SHOT_TICKS`.
- `breakable.test.ts`: 1/2/3-hit variants; debounce; below-threshold impact does not count; destroyed tile removed from `walls` and from segments on re-query.
- `movable.test.ts`: moves one tile when free; refuses out of bounds, wall, object, water/acid, other ball; moved block collides at the new place in the same shot.
- `oneway.test.ts`: passes along the arrow, blocks against it, side faces solid, ball stopped inside can leave backwards (no trap), magnet-reversed ball exits.
- `bumper.test.ts`: exits faster than it entered, minimum exit speed, capped at `MAX_SPEED`.
- `containment.test.ts`: 10 000 seeded random shots (`xorshift32`, used by the test only) on a border-only course and on a course with every shape: the ball centre always stays inside `[R, FIELD_W − R] × [R, FIELD_H − R]`, never NaN, every shot terminates.
- `determinism.test.ts`: identical `checksum` and events for repeated runs; identical after `JSON` round trip of ball/world; 1 000 random quantized shots on a test course across two independent worlds; `createShotIterator` equals `simulateShot` tick by tick; `MAX_SHOT_TICKS` yields `'timeout'` with zero velocity.
- `golden.test.ts`: fixtures per §9.7 (5 shots per built-in + torture course), regenerated only with `GOLDEN_UPDATE=1`.
- `solvability.test.ts` (WP-K): scripted shot sequence per built-in holes out in ≤ par + 2.

### 16.3 Shared — game and protocol (WP-C)

`reducer.test.ts` (every event, immutability, `ReducerError` cases), `turns.test.ts`, `scoring.test.ts` (ties, left players), `serialize.test.ts` (round trip incl. typed arrays), `authority.test.ts` (scenarios in §15 WP-C plus every row of §10.8 that concerns the authority: host disconnect in each phase, round-summary auto return, single remaining player, countdown leave, reconnect on turn), `validate.test.ts` + `roomCode.test.ts` (normalization `k7pq2`→`K7PQ2`, ` k7-pq2 `→`K7PQ2`; `K7PQ0` and `K7PQI` are rejected by `isRoomCode`).

### 16.4 Server (WP-F, WP-K)

Unit tests through `FakeTransport` + fake `Clock` (no sockets): see §15 WP-F acceptance. `codes.test.ts`: alphabet, length, uniqueness over 10 000 draws. `integration.test.ts` (WP-K): real server on port 0, three `ws` clients, one full hole, state and checksum equality, `/healthz`, static fallback, origin rejection with `PUBLIC_ORIGIN` set.

### 16.5 Client (WP-D, WP-E, WP-I)

Pure-logic tests only: `input.test.ts` (clamp, dead zone, quantization, keyboard aim → identical `ShotInput` for mouse and keyboard at the same vector), `courseLibrary.test.ts` (save/replace/duplicate/delete with a throwing storage stub), `tools.test.ts` (tool state machine → expected `edit.ts` calls, drag coalescing in history). Rendering is checked manually with the harness and `docs/QA.md`.

---

## 17. Risks and explicit trade-offs

1. **Cross-engine float divergence.** Mitigated by the restricted operation set (lint-enforced), integer inputs, fixed substeps, per-shot checksum with snapshot recovery, golden fixtures. Gameplay never depends on client physics (server wins); a desync is a visible jump only. Optional later: run the determinism suite in Chromium/WebKit via Playwright.
2. **Collision robustness** (wedging between a triangle and a block, acute corners). Mitigated by ≤ 2.5 px moves per substep, deepest-first iterative resolution with re-query, behind-the-face push-through, containment and torture tests, 30 s cap. Accepted residual: rare jitter visible as a tiny hop.
3. **Turn pacing vs. network.** Server waits `ticks/120 s + 250 ms`; slow clients fast-forward. Deadlines are in server time via measured offset.
4. **In-memory rooms die on deploy/restart.** Accepted for v1; the client shows a clear dialog; keep deploys rare; Fly suspend mode documented with its caveat.
5. **Abuse.** Frame caps, token bucket, validation, room/connection caps, origin check; no accounts, no persistence ⇒ limited blast radius.
6. **Feel tuning is subjective.** All numbers in `constants.ts`, `#/dev` panel, deliberate golden regeneration; expect one tuning pass after the first playable build.
7. **Scope creep.** Ball–ball collision, kick, lip-out kick, AFK beyond the 5 s rule, OffscreenCanvas, optimistic start are explicitly out (D20); hooks exist (`settings.ballCollision`, `ctx.otherBalls`).
8. **Version skew after deploy.** `hello` carries both versions ⇒ `BAD_VERSION` ⇒ "Päivitä sivu" + reload button.
9. **Windows development.** Scripts are plain npm/Node; `concurrently -k`; no shell-specific syntax; LF line endings via `.gitattributes`? (not needed — editors handle CRLF; JSON/TS tolerate both).
10. **Originality.** Procedural art, original names and layouts, no imported assets; reviewers check every new asset-like addition against CLAUDE.md.
11. **Parallel-agent integration risk.** Contracts frozen in M0 and printed here verbatim; deep imports; self-registration; phase split for WP-E/WP-F so M1 agents never wait on each other; the lead resolves any contract gap by editing the contract file and notifying affected WPs.

---

## 18. Lead rulings after M0 (binding for every WP)

| # | Ruling |
|---|--------|
| R1 | `eslint.config.js` §9 block is amended: the sim determinism rules apply to **production** sim code only (`packages/shared/src/sim/**/*.ts` minus `*.test.ts`, so `containment.test.ts` may import `math/rng`); `**=` is banned alongside `**`; a Node-globals block covers `*.js/*.mjs/*.cjs`; `**/coverage/**` is ignored. |
| R2 | `quantizeShot` (§5.7) applies the dead zone **also after rounding**: it returns `(0,0)` when the quantized magnitude is below `MIN_PULL_PX * SHOT_QUANTUM`, normalises `-0` to `0`, and returns `(0,0)` for non-finite input. The dead zone and the cap follow `simTuning`. `validateShot` uses the fixed constants and rejects `-0` components. Invariant: every non-null `quantizeShot` result passes `validateShot` under default tuning. |
| R3 | `MAX_PULL_PX` and `MIN_PULL_PX` are **not** runtime-tunable in practice: WP-K's `#/dev` panel must exclude them from its sliders even if they appear in `SIM_TUNING_KEYS`; `localHost` validates shots with `validateShot` exactly like the server. |
| R4 | `protocol/messages.ts` keeps the printed import line (including the unused `Course`) with an `eslint-disable-next-line` comment; `course/grid.ts` omits the unused `BALL_RADIUS` import. Contract files are otherwise byte-identical to §5–§6. |
| R5 | `BallState.lastTile` (§5.4) = tile index under the ball centre at the end of the previous tick; `tileOf(p)` at creation and after every reset (§10.1 wins over the "-1 at creation" wording). |
| R6 | All three package `tsconfig.json` files set `tsBuildInfoFile` under `.tsout/`; the client uses `rootDir: "."` so that `dev/**/*.ts` can be included. |
| R7 | `vite.config.ts` adds the `devRender` rollup input only when `dev/render.html` exists (WP-D creates it). `build.mjs` sets `absWorkingDir`. |
| R8 | `wallFromChar` / `surfaceFromChar` (§5.3) must be called with exactly one character (`''` maps to code 0). WP-A's validator checks row lengths and characters explicitly before decoding; `createWorldFromCourse` throws on malformed rows. |
| R9 | `.gitignore` contains `!.env.example` so WP-J's template is tracked. |
| R10 | Tooling for agents: the Bash tool fails on command text longer than ~6 KB, so large files are written with the Write tool. While WPs run in parallel, typecheck/lint failures in files you do not own are not yours to fix: report them and proceed. Never run `npm install`; the lead owns dependencies. |
| R11 | Agents never run `git add`/`git commit`; the lead commits per milestone. |
| R12 | `MAGNET_MAX_STRENGTH` is lowered from 1200 to **500** (WP-B proved that above ~600 px/s² an attracting block at contact distance adds more than `STOP_SPEED` per tick, so the forced-stop rule never fires and the shot runs to the 30 s cap). `decodeLayers` clamps to the new maximum; the editor's magnet strength range (§13.1) is therefore 50–500. WP-B phase 2 turns the `it.todo` in `magnet.test.ts` into a real test at the new maximum. `SIM_VERSION` stays 1 unless a golden checksum changes. |
| R13 | **Built-in ids are reserved.** `parseCourseFile` recomputes the id (`c_…`) for every input whose id is not a built-in id *or* whose canonical JSON differs from the built-in course with that id; only `course/builtin.ts` may produce `b_NN` ids. Same rule in `withComputedId`. Rationale: layers are cached per course id on the client and the server, so a custom course claiming `b_01` would be simulated with the wrong geometry. WP-A phase 2 implements and tests this. |
| R14 | `validateCourse` rejects unknown object types with a new error code `BAD_OBJECT_TYPE` (params `{x, y}`) so `decodeLayers` never throws on a validated course. `fillRect` with a rectangle wholly outside the field is a no-op; `line()` is clipped to the field instead of being truncated after a step count. WP-A phase 2. |
| R15 | WP-E phase 2 adds `validation.BAD_OBJECT_TYPE`, `validation.BAD_STRUCTURE`, `validation.FORMAT_UNKNOWN`, `validation.VERSION_TOO_NEW` strings to `fi.ts`/`en.ts` (the migrate step reports these codes through the same `ValidationIssue` channel). |
| R16 | `HOST` keeps the default `0.0.0.0`; the Vite proxy targets `127.0.0.1:8080`; README and QA say `http://127.0.0.1:8080` (Windows tools may resolve `localhost` to `::1` first). |
| R17 | M2 agents consume the real M1 modules: read the actual exported APIs (`render/renderer.ts`, `game/input.ts`, `game/shotAnimator.ts`, `ui/hud.ts`, `game/authority.ts`, `course/*`, `sim/simulate.ts`, server `rooms/*`) before coding against them; they are supersets of the printed signatures, and the printed signatures remain the stable subset. |
| R18 | **New work package WP-L (browser end-to-end QA)** owns `playwright.config.ts`, `e2e/**` (specs, helpers, `e2e/tsconfig.json`) and `e2e/screenshots/**` (git-ignored). Playwright 1.63 + Chromium are installed by the lead; the root script `npm run e2e` runs `playwright test`. WP-L tests run against the production layout (`npm run build && npm start` on a free port) and the Vite dev server where useful; they drive the real UI (menu, settings, help, single player round, editor, two-context multiplayer) and save screenshots for the lead's visual review. WP-L reports visible UI defects with owners instead of fixing other WPs' files. |
| R19 | §3 bookkeeping: `client/src/editor/modal.ts [WP-I]`, `client/src/game/playTestSupport.test.ts [WP-G]`, `shared/src/sim/playability.test.ts [WP-B]`, `game.*` strings registered in `client/src/game/summaries.ts [WP-G]` are all accepted as-is. `INVALID_SHOT` being unreachable through the parser (out-of-range vectors fail as `INVALID_MESSAGE`) is accepted. |
| R20 | Bookkeeping and polish rulings after M3: `client/src/i18n/en.dev.ts [WP-K]` is accepted. The four `MAGNET_MIN/MAX_*` entries of `SIM_TUNING_KEYS` are validation limits, not live tunables: the `#/dev` panel excludes them like `MAX_PULL_PX`/`MIN_PULL_PX` (R3). `camera.ts` prefers the integer scale only when it is at least 80 % of the fractional fit (`floor(s) >= 0.8 * s`); otherwise it uses the fractional scale with image smoothing enabled, so the field fills a 1280×800 window instead of staying at 1×. `Room.rejoin()` takes the snapshot before `connection(true)` (or does not queue the rejoiner's own copies) so a rejoined client's `seq` equals the server's; `integration.test.ts` asserts exact equality. `game.testPlay` label becomes neutral ("Testaus · Esc: takaisin"). `field()` associates labels with id-less controls. The help screen's trailing "Moninpeli" button uses the normal button style. |
