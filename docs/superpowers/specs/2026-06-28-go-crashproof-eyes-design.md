# Go Bot — Crash-Proof Deep Search + Eye/Life Eval — Design

**Date:** 2026-06-28
**Status:** Approved (direction) — user delegated autonomous build of both parts.

## Problem

The bot still loses to the hardest faction. The user is willing to spend unlimited time per
move, but **raising the search depth crashes the game**. Root cause: the search is one long
**synchronous** computation. At high depth it runs for many seconds without ever yielding, so
(a) Bitburner's no-yield / unresponsive-script guard kills it and/or (b) the browser tab
freezes. (Memory is not the driver: live boards along the DFS path grow only linearly with
depth; the explosive growth with depth is *time*, i.e. node count.)

Separately, the eval has **no life/death understanding** — it values a dead group as alive —
which is the likely strength ceiling against a strong opponent.

## Goals

1. Make arbitrarily deep search **crash-proof**: it must yield to the game so it can run across
   many ticks without freezing or being killed (time is unlimited).
2. Then **raise depth** on the hard factions, now that depth is safe.
3. Add a first **eye/life** eval term so the bot values making eyes (toward life) and denying
   the opponent's (toward kills).

## Decisions (locked)

### Part A — Cooperative yielding (crash-proof)
- `search` and `selectMove` become **async**. A node counter ticks once per search node; every
  `YIELD_NODES` nodes the search `await`s an injected callback that yields to the event loop.
- `selectMove(grid, valid, depth, rootBranch, nodeBranch, rng?, onTick?)` — new optional
  `onTick: () => Promise<void>` (default `async () => {}`). The engine stays **NS-free**: it
  only awaits the injected callback.
- `YIELD_NODES = 2000` (exported, tunable).
- `go.ts` passes `onTick = () => ns.sleep(0)` and `await`s the now-async `chooseMove`/`selectMove`.
- Behavior-preserving: yielding changes *nothing* about which move is chosen — every existing
  selectMove test must still pass (as `await`ed async tests).

### Part B — Raised depth
- `depthForFaction`: Daedalus **10**, Illuminati **12** (the top faction we play), `????????????`
  12 (dead/commented out but kept consistent). Easy factions stay 4. All even.
- These are now crash-safe (Part A) but slow — explicitly tunable; the in-game step says to
  lower them if a move takes impractically long.

### Part C — Eye/life eval
- New exported `realEyeCounts(grid): { x: number; o: number }` using the standard
  false-eye-resistant real-eye test for an empty point P of colour C:
  1. Every on-board orthogonal neighbour of P is a C stone (else not an eye).
  2. Diagonal control: let `off` = P's diagonal positions off-board, `same` = diagonals that are
     C. Real eye iff (`off === 0` and `same >= 3`) **or** (`off > 0` and `same === 4 - off`).
- `EVAL.EYE = 6`. `evaluateBoard` adds `value += EVAL.EYE * eyes.x - EVAL.EYE * eyes.o` — reward
  our eyes (life + extra value beyond the territory the point already scores), penalise the
  enemy's. Antisymmetric, so symmetric positions still evaluate to 0.
- This is a *partial* life model (rewards the path to life/kills), not a full alive/dead solver;
  full life-and-death (Benson) remains a future refinement.

### Deferred (not in this iteration)
- **make/unmake** (mutate one board + undo instead of clone-per-node): a memory/perf
  optimization. Not the crash cause, so deferred; revisit only if memory ever becomes the
  limit.
- Full life-and-death solver.

## Architecture & components

All pure-engine + the thin driver.

| File | Change |
|---|---|
| `src/utils/go-engine.ts` | `search`/`selectMove` async + `onTick` + `YIELD_NODES` (Part A); `EVAL.EYE = 6` + `realEyeCounts` + fold into `evaluateBoard` (Part C). |
| `src/utils/go-ladder.ts` | `depthForFaction` raised (Part B). |
| `src/utils/go.ts` | `await` the async `selectMove`; pass `onTick = () => ns.sleep(0)`. |
| `test/go-engine.test.ts`, `test/go-ladder.test.ts` | async-ify selectMove tests; add `realEyeCounts` + eye-eval + depth tests. |

## Testing

- **Yielding (Part A):** existing `selectMove` tests still pass when `await`ed (behaviour
  unchanged); a test that `selectMove` invokes the `onTick` callback at least once on a search
  that exceeds `YIELD_NODES` nodes (use a counter callback).
- **Depth (Part B):** `depthForFaction` returns Daedalus 10, Illuminati 12, easy 4; all even;
  the deep-faction narrow-beam invariant still holds.
- **Eyes (Part C):** `realEyeCounts` — a one-eye group (`['XXX','X.X','XXX']`) ⇒ `{x:1,o:0}`; a
  false eye (orthogonals C but diagonals uncontrolled) ⇒ not counted; a corner eye counts; and
  the eval adds exactly `EVAL.EYE` per eye (isolated like the cut term) and stays antisymmetric
  (symmetric positions still 0).
- Existing engine/ladder tests stay green.

## Performance / safety

With yielding, depth is bounded only by patience, not safety — a deep move simply spans more
ticks. Eye detection is one extra O(cells) scan at each leaf (cheap, like the cut term). The
combination of depth 12 + the heavier eval will make hard-faction moves slow (possibly many
seconds each) but **not crash**; depth and `YIELD_NODES`/`EVAL.EYE` are tunable. The in-game
step verifies the game stays responsive during a deep move.
