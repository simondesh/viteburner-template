# Go Bot — Games Objective + Per-Faction Depth — Design

**Date:** 2026-06-27
**Status:** Approved (design); pending implementation plan

## Problem

After the first round of Go improvements (faction ladder, even depth 4, adaptive boards),
the bot still does not beat the hardest faction (`????????????`). Two issues:

1. **The win-streak objective is unreachable against the strongest AI**, so the streak-based
   faction advance never "clears" the hard factions — and a streak goal is the wrong proxy
   for "spend some time on each faction."
2. **Flat depth 4 is too shallow** to out-read the strong factions.

## Goals

1. Replace the win-streak advance objective with a simple **games-played** objective.
2. **Deepen the search for harder factions** so the bot can actually out-read them.
3. Keep deep search **affordable** — deep search only pays off on small boards with narrow
   beams, so pin the deep factions there.
4. No engine changes: the search engine is already parameterized by depth/branch.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Faction advance | **Games played:** advance once `wins + losses >= GAMES_PER_FACTION` (**100**), from `ns.go.analysis.getStats()`. All played → stay on `????????????`. |
| Depth by faction | **Even, stepped:** Netburners/Slum Snakes/The Black Hand/Tetrads → **4**; Daedalus/Illuminati → **6**; `????????????` → **8**. |
| Easy factions (depth 4) | Board + beam **unchanged**: smallest-first escalation (`resolveBoard`) + wide `branchForBoard` beams. |
| Deep factions (depth 6/8) | **Fixed small board + narrow beam:** Daedalus & Illuminati → **7×7**, `rootBranch 8 / nodeBranch 4`; `????????????` → **5×5**, `rootBranch 6 / nodeBranch 3`. No board escalation for these. |
| Engine | **Unchanged** (`go-engine.ts` already takes depth/rootBranch/nodeBranch). |

Narrow beams could prune a tactic, but the engine's `POOL_MIN = 16` expands 16 cheap-ranked
candidates and keeps the best N by *exact* score, so the top tactical moves survive; depth
carries the rest. Estimated cost of the deep configs is ~0.5–2 s/move (feasible for a
background grinder).

## Architecture & components

All changes are pure policy + thin-shell wiring; the engine is untouched.

| File | Role | Tested |
|---|---|---|
| `src/utils/go-ladder.ts` | **Modified, pure.** `FactionStat` becomes `{ wins, losses }`; `GAMES_PER_FACTION` replaces `STREAK_TARGET`; `chooseFaction` advances by games; new `depthForFaction(faction)` and a new pure `planGame(faction, progressEntry, escalateAfter)`. Keeps `resolveBoard`, `branchForBoard`, `nextBoard`, `SEARCH_DEPTH` (base depth = 4), `ESCALATE_AFTER_GAMES`. | ✅ `node --test` |
| `src/utils/go.ts` | **Modified, thin shell.** Per game: `chooseFaction(getStats, GAMES_PER_FACTION)` → `planGame(...)` → `resetBoardState` → `selectMove(grid, valid, depth, rootBranch, nodeBranch)` → persist progress → log. | in-game |
| `src/utils/go-engine.ts` | **Unchanged.** | (existing tests) |

### Key new pure function

`planGame(faction, entry, escalateAfter) → { board, rootBranch, nodeBranch, depth, games }`:
- `depth = depthForFaction(faction)`.
- **Deep faction** (Daedalus / Illuminati / `????????????`): return its fixed
  `{ board, rootBranch, nodeBranch }` profile, `games = entry?.games ?? 0` (board fixed, so
  the board-progress counter is unused for these).
- **Easy faction:** `{ board, games } = resolveBoard(entry, escalateAfter)`;
  `{ rootBranch, nodeBranch } = branchForBoard(board)`.

`depthForFaction(faction)`: `????????????` → 8; Daedalus/Illuminati → 6; otherwise `SEARCH_DEPTH` (4). All even.

`chooseFaction(stats, gamesTarget)`: first faction in the ladder whose `(wins + losses) < gamesTarget` (treating a missing entry as 0 games); if all reached the target, the last faction.

## Data flow (per-game loop, `go.ts`)

1. Read/parse `go-progress.txt` → `{ board, games }` map (`{}` if missing/unparseable).
2. `stats = ns.go.analysis.getStats()`; `faction = chooseFaction(stats, GAMES_PER_FACTION)`.
3. `{ board, rootBranch, nodeBranch, depth, games } = planGame(faction, progress[faction], ESCALATE_AFTER_GAMES)`.
4. `ns.go.resetBoardState(faction, board)` (guard a falsy return: warn + sleep + continue).
5. Play to game over: `selectMove(grid, valid, depth, rootBranch, nodeBranch)` + `makeMove`/`passTurn` + `opponentNextTurn`.
6. `progress[faction] = { board, games: games + 1 }`; write `go-progress.txt`.
7. Log faction, board, depth, and the faction's live stats (`wins`/`losses`/`winStreak`/`bonusPercent`).

## Testing

- `go-ladder.ts` — pure `node --test` (update existing + add):
  - `chooseFaction`: empty stats → Netburners; advances once `wins+losses >= GAMES_PER_FACTION`; last faction when all played.
  - `depthForFaction`: returns 4 for easy factions, 6 for Daedalus/Illuminati, 8 for `????????????`; all even.
  - `planGame`: deep factions return their fixed board + narrow beam + correct depth (ignoring escalation); easy factions return `resolveBoard`/`branchForBoard` values + depth 4; the escalation path still works for easy factions.
- `go-engine.ts` — unchanged; its tests must stay green.
- `go.ts` — thin NS shell, verified in-game.

## Out of scope (future)

- Tuning `POOL_MIN` lower for deep narrow searches (smaller per-node expansion cost).
- A per-move time budget / iterative deepening if deep configs prove too slow in-game.
- Quiescence search; transposition tables.
- Revisiting whether bigger boards help or hurt against specific factions (validate in-game).
