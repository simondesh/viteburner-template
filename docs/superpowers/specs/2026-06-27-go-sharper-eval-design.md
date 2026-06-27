# Go Bot — Sharper Eval, Shapes, Tactics, Deeper Search — Design

**Date:** 2026-06-27
**Status:** Approved (design); pending implementation plan

## Problem

In-game the bot still loses to the harder factions. Investigation of `go-engine.ts`
surfaced concrete weaknesses:

1. **The eval isn't true area scoring.** `EVAL.STONE = 10` but `EVAL.TERRITORY = 12`. Under
   area scoring a stone and a territory point are each worth 1; weighting empty influence 20%
   higher makes the bot over-value loose influence and under-value solid stones/captures. (The
   asymmetry was an anti-self-fill hack; self-fill is already prevented by the `rankMoves`
   exclusion.)
2. **Influence territory is noisy.** `evaluateBoard` credits a point to whoever is even one
   step closer (`dx < dox`), so marginal proximity flips swaths of points and rewards thin
   spreading.
3. **Move ordering is purely tactical.** `expandMove`'s `ord` is captures + liberties +
   atari/threat only — no shape sense — so on the narrow deep-faction beams (nodeBranch 3–4),
   good positional/shape moves get pruned before they're searched.
4. **Thin offense/defense.** The bot rewards captures and atari-rescue, but doesn't actively
   put enemy groups in atari or shore up its own weak (2-liberty) groups.
5. **Too shallow against the hardest factions**, and per-node cost (`POOL_MIN = 16` expands 16
   candidates even for a beam of 3) makes deeper search expensive.

## Goals

Strengthen the bot in one coherent pass: accurate eval, less noise, shape and
offense/defense knowledge in the move ordering, and deeper-but-affordable search.
Everything stays pure and unit-tested in `go-engine.ts` / `go-ladder.ts`.

## Decisions (locked) — six changes

### R1 — Correct area scoring
- `EVAL.TERRITORY: 12 → 10` (== `STONE`). Self-fill remains prevented by the existing
  `rankMoves` deep-self-fill exclusion + tactical penalties, not by an eval asymmetry.
- Consequence: filling one's own settled territory becomes point-neutral (not a −2 loss); the
  characterization test that asserted a strict loss is relaxed to "not a gain" (`<=`).

### R2 — Influence margin
- New tunable `INFLUENCE_MARGIN = 2`. In `evaluateBoard`, credit an empty point to X only when
  `distX + INFLUENCE_MARGIN <= distO`, to O only when `distO + INFLUENCE_MARGIN <= distX`;
  otherwise neutral. (`Infinity` handled naturally: an enclosed region one colour can reach and
  the other cannot still counts for the reachable colour.) Territory now means clearly-held
  points, not marginal proximity.

### R3 — Shape-aware ordering
- New pure `shapeScore(grid, x, y, color): number`, computed from the original board around the
  move (no `playStone`), added to BOTH `rankMoves` score and `expandMove` `ord`:
  - **Empty triangle (penalty, −EMPTY_TRIANGLE):** the move forms an empty triangle — two of
    the move's orthogonal neighbours are own stones that are mutually perpendicular and the
    shared diagonal corner between them is empty. Detected per the four diagonal corners.
  - **Connection (bonus, +CONNECT):** the move is orthogonally adjacent to ≥2 *distinct* own
    groups (it joins them into one stronger group).
  - **Hane at the head of two (bonus, +HANE):** the move is diagonally adjacent to an enemy
    stone that belongs to an orthogonal two-stone enemy line, while the move also touches our
    own stone — i.e. we turn the corner around the enemy's head. (Exact predicate pinned in the
    plan with tests.)

### R4 — Offense/defense ordering
- In `expandMove` (which already has the post-move board), add:
  - **Offense (+ATARI_THREAT):** any adjacent enemy group left at exactly 1 liberty after our
    move (and not captured) — we threaten to capture next.
  - **Defense (+DEFEND_WEAK):** the move lifts one of our groups that had 2 liberties before
    out of danger (the resulting own group has >2 liberties), in addition to the existing
    1-liberty atari-rescue.

### Depth bump
- `depthForFaction`: Daedalus & Illuminati **6 → 8**; `????????????` **8 → 10**. Easy factions
  stay at `SEARCH_DEPTH` (4). All even.

### Efficiency — POOL_MIN
- `POOL_MIN: 16 → 8`. Deep narrow beams expand ~half as many candidates per node, which pays
  for the deeper search. (Easy factions with nodeBranch ≥ 16 are unaffected: `max(beam, 8)`.)

### Weights (initial, tunable; pinned in the plan)
Shape/tactical bonuses slot *below* the capture tier (1000) so they never override a capture,
but *above* the quiet-move baseline so they shape the beam: roughly `HANE`/`ATARI_THREAT` in
the few-hundreds, `CONNECT`/`DEFEND_WEAK` ~100–200, `EMPTY_TRIANGLE` penalty ~30–50. Exact
values set in the plan and adjustable after in-game testing.

## Architecture & components

All pure; the engine is already wired into `go.ts`/`go-engine.ts`.

| File | Change |
|---|---|
| `src/utils/go-engine.ts` | `EVAL.TERRITORY → 10` (R1); `INFLUENCE_MARGIN` + margin test in `evaluateBoard` (R2); new `shapeScore` folded into `rankMoves` + `expandMove` (R3); offense/defense terms in `expandMove` (R4); `POOL_MIN → 8`; new shape/tactical weight constants. |
| `src/utils/go-ladder.ts` | `depthForFaction`: Daedalus/Illuminati 8, `????????????` 10 (depth bump). |
| `src/utils/go.ts` | unchanged (already passes per-faction depth/branch from `planGame`). |

## Testing

- `go-engine.ts` — pure `node --test` (extend existing):
  - R1: `evaluateBoard` treats a stone and a controlled territory point as equal value; filling
    settled own territory is not a gain (`<=`).
  - R2: a point only marginally closer (lead < margin) is neutral; a clearly-closer point and a
    one-colour-enclosed region are credited.
  - R3: `shapeScore` penalizes a move forming an empty triangle, rewards a connecting move and a
    hane-at-head; a plain move scores ~0. Ordering still ranks captures first (shape never
    outranks a capture).
  - R4: `expandMove` `ord` rises for a move that puts an enemy group in atari and for one that
    lifts a 2-liberty own group to safety; self-atari penalty still dominates.
  - Existing regression tests (depth-changes-move, beam-width-changes-move, exclusions, capture
    ordering) stay green.
- `go-ladder.ts` — `depthForFaction` returns 8 for Daedalus/Illuminati, 10 for `????????????`,
  4 for easy; all even; deep factions still pinned to 7×7 narrow beams (existing invariant).
- `go.ts` — unchanged; verified in-game (watch ???? depth-10 latency; drop to 8 if too slow).

## Out of scope (the next iteration)

- **Life-and-death / eye evaluation** — the biggest remaining lever: the eval still counts dead
  groups as alive and lets them project influence. This is the natural follow-up.
- Quiescence search; transposition tables; lowering `POOL_MIN` further or a per-move time
  budget if depth-10 is too slow.
- Additional shapes (jumps, attachments, ponnuki templates).
