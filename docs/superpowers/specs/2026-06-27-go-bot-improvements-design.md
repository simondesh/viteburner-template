# Go Bot Improvements — Design

**Date:** 2026-06-27
**Status:** Approved (design); pending implementation plan

## Problem

The IPvGO bot (`src/utils/go.ts` + `src/utils/go-engine.ts`) has three weaknesses:

1. **Search horizon ends on our own move.** `SEARCH_DEPTH = 3` (odd). From the current
   position the search explores our move → opponent → our move, then evaluates — *before*
   the opponent answers our last move. A move that looks good the instant we play it but is
   refuted on the opponent's next move is invisible. This is the "we trap ourselves because
   we didn't predict them" symptom. (The search *is* a real alpha-beta minimax that models
   opponent replies; the bug is the ply parity, not a lack of opponent modelling.)

2. **Flat forward-pruning beam (`NODE_BRANCH = 6`) discards setup/sacrifice moves.** At every
   interior node only the top-6 immediately-ranked moves are searched; the rest are cut
   sight-unseen (unlike alpha-beta, which only discards moves it has *proven* worse). A
   move that looks bad now but captures a group two moves later is ranked low and never
   explored. On small boards — where we can easily afford to search wide — this can throw
   away won games.

3. **No faction progression or board scaling.** The driver hardcodes one opponent
   (`Daedalus`) and one board size (`7`). There is no easiest-first laddering and no use of
   bigger boards for harder factions.

## Goals

1. Always evaluate *after* the opponent's reply (fix the horizon parity).
2. Never forward-prune a tactic on boards small enough to search broadly; keep a beam only
   where breadth is genuinely unaffordable.
3. Make a single, strong search depth (4) affordable on every board size via sound search
   efficiency.
4. Climb the faction ladder easiest-first by win streak, on graduated board sizes.
5. Keep the engine pure and unit-tested; keep the driver a thin NS shell.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Search depth | **Flat `SEARCH_DEPTH = 4`** (even ⇒ horizon ends on the opponent's reply, on every board). |
| Branch width | **Board-scaled**, wide on small boards, narrow only on big ones (table below). |
| Search efficiency | **Root-alpha threading** in `selectMove` + **lazy move ordering** in the engine, so depth-4 wide search stays affordable. |
| Faction advance | **Win-streak based:** advance once `highestWinStreak >= STREAK_TARGET` (default **5**). |
| Faction order | Netburners → Slum Snakes → The Black Hand → Tetrads → Daedalus → Illuminati → "????????????". |
| Board mapping | **Graduated:** Netburners/Slum Snakes → 5; Black Hand/Tetrads → 7; Daedalus → 9; Illuminati/???? → 13. |
| Progression state | **Derived from `ns.go.getStats()`** each game (it persists across games and script restarts); no own bookkeeping. |

### Board-scaled branch widths

| Board | `nodeBranch` (interior) | `rootBranch` | Rationale |
|---|---|---|---|
| 5×5  | 25 (≈ all) | 25 | Tiny — search everything; never prune a tactic. |
| 7×7  | 16 | 25 | Broad enough to include setups; alpha-beta keeps it cheap. |
| 9×9  | 10 | 16 | Middle ground. |
| 13×13 | 6 | 12 | Beam genuinely needed for tractability. |

(All widths and `STREAK_TARGET` are tunable constants.)

## Architecture & components

Pure-core / thin-shell split, consistent with the rest of the codebase.

| File | Role | Tested |
|---|---|---|
| `src/utils/go-ladder.ts` | **NEW, pure.** `FACTION_LADDER`, `BOARD_FOR_FACTION`, `BRANCH_FOR_BOARD`, `SEARCH_DEPTH`, `STREAK_TARGET`; `chooseFaction(stats, streakTarget)`, `boardForFaction(faction)`, `branchForBoard(size)`. No NS. | ✅ `node --test` |
| `src/utils/go-engine.ts` | **Modified.** `search`/`selectMove` take a `nodeBranch` parameter; `selectMove` threads root alpha; move ordering becomes lazy (cheap rank + on-demand child-board generation). | ✅ extend existing tests |
| `src/utils/go.ts` | **Modified, thin shell.** Per game: `getStats()` → ladder picks faction/board/branch → `resetBoardState` → play with `selectMove(grid, valid, SEARCH_DEPTH, rootBranch, nodeBranch)` → log the faction's live stats. | in-game |

## Data flow

### Per-game loop (`go.ts`)

1. `stats = ns.go.getStats()`.
2. `faction = chooseFaction(stats, STREAK_TARGET)` — first faction in the ladder whose
   `highestWinStreak < STREAK_TARGET`; if all are cleared, the last (hardest) faction, which
   we then keep farming for ongoing streak rep.
3. `size = boardForFaction(faction)`; `{ rootBranch, nodeBranch } = branchForBoard(size)`.
4. `ns.go.resetBoardState(faction, size)`.
5. Play to game over: `chooseMove` builds the grid from `getBoardState()` +
   `analysis.getValidMoves()`, calls `selectMove(grid, valid, SEARCH_DEPTH, rootBranch, nodeBranch)`,
   then `makeMove`/`passTurn` and `opponentNextTurn`.
6. Log the current faction's live stats from `getStats()` (`wins`/`losses`/`winStreak`/
   `highestWinStreak`/`bonusPercent`).

Because the faction is re-derived from `getStats()` every game, progression is automatic and
survives script restarts; a broken streak simply means we keep playing the same faction until
the target is reached.

### Search flow (`selectMove`, with root alpha)

1. `passValue = search(grid, 'O', depth-1, -∞, +∞, nodeBranch)` — the stand-pat baseline.
2. `bestValue = passValue`. For each root move (ordered, filtered by `validMoves`, sliced to
   `rootBranch`): search it with window `(runningBest − ε, +∞)` so moves that cannot beat the
   running best fail-low and prune their subtree, while genuinely tied moves still return
   exact values for the jitter tie-break (`ε ≈ 0.5`, below the eval's minimum gap of 2).
3. If no root move exceeds `passValue`, **pass** (return null); otherwise return the best move.

This is sound — it never changes which move is best — and folds the existing pass policy into
the same windowed search.

### Lazy move ordering (the per-node cost cut)

Today `orderedMoves` calls `playStone` for *every* empty point (≈169 grid-clones per node on
13×13) just to rank them — the dominant cost. New design:

- **Cheap pre-rank:** rank all legal, non-excluded empty points using only the *original*
  board (enemy adjacency, our groups in atari that the point rescues, enemy groups it pushes
  toward capture, adjacent-empty count as a liberty proxy). No `playStone`. The territory and
  deep-self-fill exclusions are unchanged, so the candidate *set* is identical to today.
- **On-demand expansion:** generate the actual child board (via `playStone`, dropping
  suicides) only for a pool of the top `max(branch, 16)` pre-ranked candidates, re-sort that
  pool by the exact tactical score (captures, resulting liberties, self-atari) to preserve
  alpha-beta-friendly best-first ordering within the beam, then search the top `branch`.
- **Capture safety:** because the cheap pre-rank cannot *see* a capture before playing, moves
  adjacent to low-liberty enemy groups (capture/atari candidates) are always seeded into the
  pool, and the pool is wider than `branch`, so real tactics are not pruned before exact
  scoring.

## Error handling & robustness

- `resetBoardState` returning `undefined` (faction unavailable) is logged and the game is
  skipped that iteration rather than crashing the loop.
- The kill-switch file (`go-stop.txt`) behaviour is preserved.
- Root-alpha and lazy ordering are behaviour-preserving for *move selection* (the best move is
  unchanged); only speed and jitter-tie variety are affected, and the latter is protected by ε.

## Testing

- `go-ladder.ts` — pure `node --test`: `chooseFaction` returns Netburners on empty stats;
  skips factions with `highestWinStreak >= target`; returns the last faction when all cleared;
  `boardForFaction` mapping; `branchForBoard` returns the table values; `SEARCH_DEPTH` is even (4).
- `go-engine.ts` — extend the existing 14 tests: `selectMove` still plays/passes correctly and
  is score-independent with root alpha; ordering still surfaces captures/atari/rescue first and
  buries self-atari after the lazy-ordering refactor; the candidate set/exclusions
  (opening = 49 on 7×7, deep self-fill excluded, frontier not excluded) are unchanged; a
  small "sacrifice-then-capture" fixture is found at depth 4 with a wide beam.
- `go.ts` — thin NS shell, verified in-game.

## Out of scope (future)

- Deeper-than-4 search on the tiniest boards (5×5 could afford depth 6 for longer combos).
- Quiescence search (extending only while captures/ataris are pending) for tactics beyond the
  fixed horizon.
- Transposition table / iterative deepening.
- Adaptive within-search beam widening near the root.
- Using the `ns.go.cheat` API.
