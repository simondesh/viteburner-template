# Go Bot — Cutting-Point Eval (connection / holes / cutting) — Design

**Date:** 2026-06-28
**Status:** Approved (design); pending implementation plan

## Problem

The bot's position value (`evaluateBoard`) is shallow on group *relationships*. It scores
stones (area), influence-territory, and per-group liberty penalties (atari/weak), but has **no
concept of connection or cutting**. Consequently:
- It doesn't value keeping its own groups linked, nor avoid leaving cuttable weaknesses
  ("defense holes").
- It doesn't value cutting the opponent's groups apart or denying their connection.

The existing `CONNECT` shape bonus is move-*ordering* only (it nudges which moves are tried),
not part of the position value — so the search never truly weighs connection/cutting.

## Goal

Put connection/cut understanding into the **position value** via one principled, symmetric
term — "cutting points" — plus a move-ordering mirror so the search surfaces cutting moves.
Keep it lean (the eval runs at every leaf of the depth-8 search). Life/eye evaluation remains
the deferred follow-up.

## Decisions (locked)

A **cutting point for colour C** is an empty point orthogonally adjacent to **≥2 distinct
groups of colour C**. Such a point marks where C is not solidly connected — a hole the
opponent can cut, or a link C must still protect. (Two adjacent stones of the same group count
once, so genuinely-connected stones never create a false cutting point.)

### Eval term (the value)
- New exported pure function `cuttingPointCounts(grid: Grid): { x: number; o: number }` —
  builds a group-id map in one pass, then scans empty points and counts cutting points per
  colour.
- New weight `EVAL.CUT = 6`.
- `evaluateBoard` adds: `value += -EVAL.CUT * cp.x + EVAL.CUT * cp.o` — penalise our own
  cutting points (stay connected, don't leave holes) and reward the enemy's (we can cut them).
- The term is antisymmetric under colour-swap (`cp.x`↔`cp.o` ⇒ term negates), so symmetric
  positions still evaluate to 0.

### Ordering mirror
- New `SHAPE.CUT = 60`. In `shapeScore`, a move orthogonally adjacent to **≥2 distinct enemy
  groups** (a wedge/cut) gets `+SHAPE.CUT`, so the search tries cutting moves. (The existing
  `SHAPE.CONNECT` already rewards joining ≥2 of our own groups.) Stays below the capture
  tier (1000).

### Values (tunable)
`EVAL.CUT = 6` (a cutting point ≈ a bit over half a stone of weakness, so it influences but
doesn't dominate area/territory); `SHAPE.CUT = 60` (between `CONNECT` 40 and `HANE` 80).

## Architecture & components

All in the pure engine; no driver change.

| File | Change |
|---|---|
| `src/utils/go-engine.ts` | Add `EVAL.CUT = 6` and `SHAPE.CUT = 60`; add exported `cuttingPointCounts`; fold its result into `evaluateBoard`; add the `CUT` (≥2 enemy groups) branch to `shapeScore`. |
| `src/utils/go.ts`, `src/utils/go-ladder.ts` | unchanged. |

## How it answers the requirements
- **Linking our groups:** connecting removes our cutting points (eval reward) + `CONNECT` ordering.
- **Defense holes:** our cutting points are penalised in the value, so the bot avoids/protects them.
- **Cutting the opponent:** the enemy's cutting points are rewarded in the value, and `CUT` ordering surfaces the wedge.
- **Defend if worth it:** still handled crudely by the liberty/atari eval + minimax; full "worth it" (dead vs alive) is the deferred life/eye lever.

## Testing

- `cuttingPointCounts` — pure `node --test`:
  - two separate same-colour groups sharing an empty neighbour ⇒ that colour's count is 1
    (e.g. `['X.X','...','...']` ⇒ `{ x: 1, o: 0 }`).
  - a single connected group ⇒ 0 (e.g. `['XXX','...','...']` ⇒ `{ x: 0, o: 0 }`).
  - both colours cut ⇒ both counted (e.g. `['X.X','...','O.O']` ⇒ `{ x: 1, o: 1 }`).
- `evaluateBoard` — a position where only X has a cutting point scores lower than the same
  position with that point connected; symmetric positions still evaluate to 0 (antisymmetry
  preserved).
- `shapeScore` — a move adjacent to ≥2 distinct enemy groups returns `SHAPE.CUT`
  (e.g. `shapeScore(['O.O','...','...'], 0, 1, 'X') === SHAPE.CUT`); the new bonus stays below
  a capture's score.
- Existing engine/ladder tests stay green.

## Performance

`cuttingPointCounts` is ~one O(cells) pass (group-id build + empty-point scan), comparable to a
single `floodDistances`, computing both colours together — a modest add to the per-leaf eval.
Given recent depth-8 latency sensitivity, watch move time in-game; `EVAL.CUT`/`SHAPE.CUT` are
tunable and the term is easy to dial down or remove.

## Out of scope (next)

- **Life-and-death / eye evaluation** — count eyes per group, devalue groups that cannot make
  two eyes (the true "is this group worth defending" lever). The biggest remaining jump.
- Protected-cut refinement (only counting cutting points the enemy can actually exploit
  without self-atari).
