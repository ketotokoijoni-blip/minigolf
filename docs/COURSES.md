# Puttipeli — Built-in course set "Perusradat" (9 holes)

All layouts, names and descriptions are original. Files live in `packages/shared/src/course/builtin/NN-slug.json` (owner: WP-A), ids `b_01`…`b_09`, author `"Puttipeli"`. The set introduces exactly one new mechanic per hole so that the nine holes double as the tutorial; the final hole combines everything. Total par **27**. Pars may be adjusted in the lead's tuning pass; the solvability fixture (`sim/__fixtures__/solvability.json`, WP-K) must hole each course in ≤ par + 2 strokes.

Coordinates below are tile coordinates (x 0–48 left→right, y 0–24 top→bottom); the outer ring (x = 0, x = 48, y = 0, y = 24) is a full wall on every course. Difficulty is 1 (easiest) to 5.

| # | id | Name | Par | New mechanic | Difficulty |
|---|----|------|-----|--------------|------------|
| 1 | b_01 | Ensiputti | 2 | aiming, power, sand | 1 |
| 2 | b_02 | Kulmakivi | 2 | diagonal (bank) walls | 2 |
| 3 | b_03 | Jäätie | 3 | ice, slopes | 2 |
| 4 | b_04 | Lampi | 3 | water | 3 |
| 5 | b_05 | Portaali | 3 | teleporters | 3 |
| 6 | b_06 | Magneettilaakso | 3 | magnets, acid | 4 |
| 7 | b_07 | Murtuva muuri | 4 | breakable and movable blocks | 4 |
| 8 | b_08 | Pomppulinna | 3 | bumpers, one-way gates, mines, tar | 4 |
| 9 | b_09 | Finaali | 4 | everything, two holes | 5 |

---

## 1. Ensiputti (b_01) — Par 2 — "Ensimmäinen putti"

**Theme:** a wide, friendly fairway. Teaches that cursor distance is power and that a full-power shot crosses the whole field and rebounds.
**Tiles:** grass, full walls, sand.
**Layout:** start at (3,12), hole at (44,12). A sand strip 4 tiles wide spans the fairway at x 20–23 from y 6 to y 18, leaving grass lanes above (y 1–5) and below (y 19–23). Two short wall stubs (y 4–6 at x 30 and y 18–20 at x 30) nudge the lanes back toward the centre.
**Intended line:** a ~70 % shot through the sand (it survives because the lanes are optional) or a safe lane shot plus a putt. Par 2.
**Hazards:** sand only.

## 2. Kulmakivi (b_02) — Par 2 — "Pankkilyönti"

**Theme:** an L-shaped dogleg; the first bank shot.
**Tiles:** grass, full walls, triangles `7 9 3 1`, sand.
**Layout:** start at (4,20) in a bottom-left corridor (y 17–23, x 1–20). The corridor turns up at x 17–23 into a vertical shaft (x 17–23, y 1–23). The corner at (23,23) is a `1` (TriSW) and (23,17) is a `3`-style inside bevel so a ball fired east along the corridor banks 90° upward. The hole sits at (20,3) in a small alcove with a sand pocket at (17–18, 1–2) catching over-hit shots.
**Intended line:** one firm shot along the bottom corridor into the diagonal, which turns it north; it dies near the hole; putt. Par 2.

## 3. Jäätie (b_03) — Par 3 — "Jäinen käytävä"

**Theme:** control on a slippery surface with side-pushing slopes.
**Tiles:** grass, walls, ice, slopes `8 6 2 4`.
**Layout:** start at (3,12). A central ice corridor (x 8–40, y 9–15) with slope strips: `2` (pushing south) at x 14–18 and `8` (pushing north) at x 26–30 across the corridor height. Walls at y 8 and y 16 bound the corridor; the ends are open. The hole is at (44,12) in a grass pocket (x 42–47, y 10–14); overshooting bounces off the back wall onto ice and slides back.
**Intended line:** moderate power so the slopes cancel; too hard and the ball returns past the hole. Par 3.

## 4. Lampi (b_04) — Par 3 — "Lampi keskellä"

**Theme:** a pond; the first penalty hazard (back to the shot origin, +1).
**Tiles:** grass, walls, water, sand.
**Layout:** start at (3,12), hole at (45,12). A roughly oval pond (x 16–32, y 5–19) fills the middle; a 2-tile grass isthmus crosses it at y 11–12 (narrow, needs a precise shot). Around the pond, grass routes along y 1–3 and y 21–23 with sand corners at (14–15, 1–3) and (33–34, 21–23).
**Intended line:** either the risky isthmus (one full shot, then a putt) or the safe two-shot route around the top. Par 3.

## 5. Portaali (b_05) — Par 3 — "Kaksi porttia"

**Theme:** teleporters and a choice of risk.
**Tiles:** grass, walls, teleporters (groups 0 and 1), sand, ice.
**Layout:** a wall at x 24 (y 1–23) splits the field into a start chamber (left) and a hole chamber (right); there is no gap. Start at (4,12). Pad A (group 0) at (18,5) exits at (40,18) in the hole chamber facing a sand bed at (41–46, 19–22); pad B (group 1) at (18,19) exits at (30,6) onto an ice lane (x 30–45, y 5–7) pointing straight at the hole at (45,6).
**Intended line:** pad B with a soft shot (velocity is preserved through the portal, so arrive slowly) and let the ice carry the ball toward the cup; pad A is safer but needs two more shots. Par 3.

## 6. Magneettilaakso (b_06) — Par 3 — "Veto ja työntö"

**Theme:** magnets bend paths; acid returns the ball to the start (+1).
**Tiles:** grass, walls, magnets (attract and repel), acid.
**Layout:** start at (3,12), hole at (45,12). An attract magnet block at (22,6) (strength 350, radius 90) sits above the direct line and pulls passing balls toward an acid moat at (20–26, 8–9). Below, a repel magnet at (34,18) (strength 350, radius 75) guards the approach to the hole and pushes balls up into the fairway if approached from below. Walls form a gentle S so that the "obvious" line crosses both fields.
**Intended line:** hug the bottom wall past the attractor (out of its radius), then let the repeller nudge the second shot toward the hole; putt. Par 3.

## 7. Murtuva muuri (b_07) — Par 4 — "Murra tai kierrä"

**Theme:** destructible and pushable blocks; the shared world in multiplayer (what one player breaks stays broken).
**Tiles:** grass, walls, breakable `x y z`, movable `M`, sand.
**Layout:** start at (3,12), hole at (45,12). A vertical breakable wall at x 20 from y 3 to y 21 made of `z` blocks (3 hits) except one `x` block (1 hit) at (20,12) directly on the start line. Behind it, a movable block `M` at (30,12) blocks a 1-tile gap in a second wall (x 30, y 3–21, full); pushing it east opens the gap (target (31,12) is free grass). Sand at (24–28, 10–14) slows the approach so the push is gentle but above the 60 px/s threshold.
**Intended line:** hard shot through the `x` block (bounces back, block destroyed), second shot through the gap into the sand, third shot pushes `M` and follows, putt. Par 4.

## 8. Pomppulinna (b_08) — Par 3 — "Pomppiva linna"

**Theme:** bouncy walls, gates you cannot return through, mines, tar as a safe stop.
**Tiles:** grass, walls, bumpers `O`, one-way `^ > v <`, mines, tar.
**Layout:** start at (3,12). A central "castle" (x 16–32, y 6–18) has bumper walls (`O`) on its inner faces; entry through a one-way gate `>` at (16,12) (passable eastward only). Inside, mines at (22,9) and (22,15) guard the diagonal lines; a tar pit at (28–29, 11–13) stops a ball dead right before the exit gate `>` at (32,12). The hole is at (44,12) in a quiet grass pocket.
**Intended line:** enter through the gate with medium power, aim between the mines so the ball stops in the tar; from the tar a soft shot through the exit gate to the hole. Bumpers punish over-hitting by ping-ponging the ball (speed capped at 900 px/s). Par 3.

## 9. Finaali (b_09) — Par 4 — "Kaikki kerralla"

**Theme:** every mechanic and a strategic choice between two holes.
**Tiles:** grass, walls, triangles, ice, slopes, water, teleporters, magnets, mines, breakable, movable, one-way, bumper, tar, sand, acid, **two holes**.
**Layout:** start at (3,20) bottom-left. Hole A (near, risky) at (14,4): reached by crossing a slope `8` lane (x 4–12, y 6–18) that accelerates the ball toward a repel magnet at (14,2) and two mines at (11,5) and (17,5) flanking the cup; a breakable `y` wall segment at (8–12, 10) must be opened first or bypassed via a one-way `^` gate at (6,10). Hole B (far, safe) at (45,4): a teleporter at (20,20) (group 0) exits at (30,10) onto an ice ramp (x 30–44, y 9–11) bounded by bumpers; a water pool (x 24–28, y 1–8) and an acid pocket (x 40–42, y 1–3) catch shots that leave the ramp; a diagonal `9` at (47,1) banks the final approach down into the cup; a movable `M` at (36,10) can be pushed off the ramp to widen it; a tar pit at (44–45, 12–13) is the safe landing before the putt.
**Intended line:** B route in four: teleport, ramp to the tar, putt via the bank; aggressive players try A in three with real penalty risk. Par 4.

---

## Authoring notes for WP-A

- Keep every row exactly 49 characters; 25 rows per layer; outer ring `#`.
- Objects only on tiles with the correct wall (magnet on `#`, everything else on `.`) and never on water/acid (start/hole/teleport also not on tar).
- Run `npm test -w packages/shared` — `builtin.test.ts` checks validity, reachability (warning must be absent), ids, names and pars against the table above, and that each course's declared mechanic tiles are present (e.g. `b_05` has exactly 4 teleport pads, `b_09` has 2 holes).
- Descriptions (`description` field) are one Finnish sentence each, e.g. `b_01`: "Suora väylä, yksi hiekkaeste – opettele voima."
