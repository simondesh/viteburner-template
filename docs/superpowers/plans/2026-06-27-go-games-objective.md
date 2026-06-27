# Go Games-Objective + Per-Faction Depth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Advance factions after a fixed number of games (not a win streak) and search deeper for harder factions, pinning the deep factions to small boards with narrow beams so the deeper search stays affordable.

**Architecture:** All changes live in the pure policy module `go-ladder.ts` and the thin driver `go.ts`. `go-ladder` gains a games-based `chooseFaction`, a `depthForFaction`, and a `planGame` that returns the full per-game config (board/beam/depth). `go.ts` calls `planGame` and passes the per-faction depth to `selectMove`. The search engine `go-engine.ts` is unchanged (already parameterized by depth/branch).

**Tech Stack:** TypeScript, Bitburner (modded) NS API, viteburner, Node 26 `node --test`.

## Global Constraints

- `go-ladder.ts` MUST NOT import `@ns` or reference `ns.*` (pure module).
- Tests live in top-level `test/` and import source with an explicit `.ts` extension; run with `node --test "test/**/*.test.ts"`.
- `GAMES_PER_FACTION = 100` (advance once `wins + losses >= GAMES_PER_FACTION`).
- Depth by faction (all even): Netburners/Slum Snakes/The Black Hand/Tetrads → 4; Daedalus/Illuminati → 6; `????????????` → 8.
- Deep factions use a fixed small board + narrow beam: Daedalus & Illuminati → board 7, `rootBranch 8 / nodeBranch 4`; `????????????` → board 5, `rootBranch 6 / nodeBranch 3`. Easy factions keep smallest-first escalation + the wide `branchForBoard` beams.
- IPvGO stats come from `ns.go.analysis.getStats()` (NOT `ns.go.getStats()`).
- `go-engine.ts` is NOT modified.
- Commit after every task. Work on branch `feat/go-games-objective` (already checked out); do NOT create a new branch.

---

### Task 1: go-ladder policy — games objective + per-faction depth + planGame

**Files:**
- Modify: `src/utils/go-ladder.ts`
- Modify: `test/go-ladder.test.ts` (replace whole file)

**Interfaces:**
- Consumes: existing `resolveBoard`, `branchForBoard`, `BOARD_SIZES`, `SEARCH_DEPTH`, `FACTION_LADDER`, types `GoFaction`/`BoardSize`/`BoardProgress` (all already in the file).
- Produces (consumed by Task 2):
  - `interface FactionStat { wins: number; losses: number }`
  - `GAMES_PER_FACTION = 100` (replaces `STREAK_TARGET`)
  - `chooseFaction(stats: Partial<Record<string, FactionStat>>, gamesTarget: number): GoFaction`
  - `depthForFaction(faction: GoFaction): number`
  - `interface GamePlan { board: BoardSize; rootBranch: number; nodeBranch: number; depth: number; games: number }`
  - `planGame(faction: GoFaction, entry: BoardProgress | undefined, escalateAfter: number): GamePlan`

- [ ] **Step 1: Replace the test file (RED)**

Replace the entire contents of `test/go-ladder.test.ts` with:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    FACTION_LADDER,
    SEARCH_DEPTH,
    GAMES_PER_FACTION,
    branchForBoard,
    chooseFaction,
    depthForFaction,
    nextBoard,
    resolveBoard,
    planGame,
    type FactionStat,
} from '../src/utils/go-ladder.ts';

const stat = (wins: number, losses: number): FactionStat => ({ wins, losses });

test('SEARCH_DEPTH (base depth) is even and 4', () => {
    assert.equal(SEARCH_DEPTH % 2, 0);
    assert.equal(SEARCH_DEPTH, 4);
});

test('GAMES_PER_FACTION is 100', () => {
    assert.equal(GAMES_PER_FACTION, 100);
});

test('chooseFaction starts at the easiest faction when there are no stats', () => {
    assert.equal(chooseFaction({}, GAMES_PER_FACTION), 'Netburners');
});

test('chooseFaction advances once a faction has been played the target number of games', () => {
    const stats = { Netburners: stat(40, 60), 'Slum Snakes': stat(10, 5) }; // Netburners = 100 games
    assert.equal(chooseFaction(stats, 100), 'Slum Snakes');
});

test('chooseFaction does not advance before the games target is reached', () => {
    const stats = { Netburners: stat(40, 59) }; // 99 games
    assert.equal(chooseFaction(stats, 100), 'Netburners');
});

test('chooseFaction returns the hardest faction once all are played out', () => {
    const stats = Object.fromEntries(FACTION_LADDER.map((f) => [f, stat(50, 50)]));
    assert.equal(chooseFaction(stats, 100), '????????????');
});

test('depthForFaction deepens for harder factions and is always even', () => {
    assert.equal(depthForFaction('Netburners'), 4);
    assert.equal(depthForFaction('Tetrads'), 4);
    assert.equal(depthForFaction('Daedalus'), 6);
    assert.equal(depthForFaction('Illuminati'), 6);
    assert.equal(depthForFaction('????????????'), 8);
    for (const f of FACTION_LADDER) assert.equal(depthForFaction(f) % 2, 0);
});

test('nextBoard steps up and caps at 13', () => {
    assert.equal(nextBoard(5), 7);
    assert.equal(nextBoard(7), 9);
    assert.equal(nextBoard(9), 13);
    assert.equal(nextBoard(13), 13);
});

test('resolveBoard starts a fresh faction at 5x5', () => {
    assert.deepEqual(resolveBoard(undefined, 30), { board: 5, games: 0 });
});

test('resolveBoard keeps the current board while under the patience budget', () => {
    assert.deepEqual(resolveBoard({ board: 5, games: 29 }, 30), { board: 5, games: 29 });
});

test('resolveBoard escalates and resets games once the budget is hit', () => {
    assert.deepEqual(resolveBoard({ board: 5, games: 30 }, 30), { board: 7, games: 0 });
});

test('resolveBoard never escalates past 13x13', () => {
    assert.deepEqual(resolveBoard({ board: 13, games: 999 }, 30), { board: 13, games: 999 });
});

test('branchForBoard is wide on small boards and narrow on big ones', () => {
    assert.deepEqual(branchForBoard(5), { rootBranch: 25, nodeBranch: 25 });
    assert.deepEqual(branchForBoard(7), { rootBranch: 25, nodeBranch: 16 });
    assert.deepEqual(branchForBoard(9), { rootBranch: 16, nodeBranch: 10 });
    assert.deepEqual(branchForBoard(13), { rootBranch: 12, nodeBranch: 6 });
});

test('planGame: an easy faction uses adaptive board + wide beam + depth 4', () => {
    assert.deepEqual(
        planGame('Netburners', undefined, 30),
        { board: 5, rootBranch: 25, nodeBranch: 25, depth: 4, games: 0 },
    );
});

test('planGame: an easy faction escalates its board per resolveBoard', () => {
    assert.deepEqual(
        planGame('Netburners', { board: 5, games: 30 }, 30),
        { board: 7, rootBranch: 25, nodeBranch: 16, depth: 4, games: 0 },
    );
});

test('planGame: deep factions use a fixed small board, narrow beam, and deep search', () => {
    assert.deepEqual(
        planGame('Daedalus', undefined, 30),
        { board: 7, rootBranch: 8, nodeBranch: 4, depth: 6, games: 0 },
    );
    // Illuminati ignores any stored board/escalation; games is passed through.
    assert.deepEqual(
        planGame('Illuminati', { board: 5, games: 999 }, 30),
        { board: 7, rootBranch: 8, nodeBranch: 4, depth: 6, games: 999 },
    );
    assert.deepEqual(
        planGame('????????????', undefined, 30),
        { board: 5, rootBranch: 6, nodeBranch: 3, depth: 8, games: 0 },
    );
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/go-ladder.test.ts"`
Expected: FAIL — `GAMES_PER_FACTION`/`depthForFaction`/`planGame` are not exported, and the new `chooseFaction`/`FactionStat` shape doesn't match the old streak-based code.

- [ ] **Step 3: Apply the go-ladder.ts edits**

In `src/utils/go-ladder.ts`:

**(a)** Replace the `FactionStat` interface:

```ts
/** The single stat we use to decide whether a faction is "cleared". */
export interface FactionStat {
    highestWinStreak: number;
}
```

with:

```ts
/** Stats used for progression: a faction is "played out" after wins + losses games. */
export interface FactionStat {
    wins: number;
    losses: number;
}
```

**(b)** Replace the `STREAK_TARGET` constant line:

```ts
export const SEARCH_DEPTH = 4;        // even -> horizon ends on the opponent's reply
export const STREAK_TARGET = 10;      // win streak that "clears" a faction
export const ESCALATE_AFTER_GAMES = 30; // games on a board before stepping up a size
```

with:

```ts
export const SEARCH_DEPTH = 4;          // base (even) depth; harder factions go deeper
export const GAMES_PER_FACTION = 100;   // games (wins+losses) before advancing a faction
export const ESCALATE_AFTER_GAMES = 30; // games on a board before stepping up a size
```

**(c)** Replace the whole `chooseFaction` function:

```ts
/** First faction not yet cleared (highestWinStreak < target); if all are cleared, the last. */
export const chooseFaction = (
    stats: Partial<Record<string, FactionStat>>,
    streakTarget: number,
): GoFaction => {
    for (const faction of FACTION_LADDER) {
        const streak = stats[faction]?.highestWinStreak ?? 0;
        if (streak < streakTarget) return faction;
    }
    return FACTION_LADDER[FACTION_LADDER.length - 1];
};
```

with:

```ts
/** First faction not yet played to the games target; if all are, the last (hardest). */
export const chooseFaction = (
    stats: Partial<Record<string, FactionStat>>,
    gamesTarget: number,
): GoFaction => {
    for (const faction of FACTION_LADDER) {
        const s = stats[faction];
        const games = s ? s.wins + s.losses : 0;
        if (games < gamesTarget) return faction;
    }
    return FACTION_LADDER[FACTION_LADDER.length - 1];
};
```

**(d)** Append at the END of the file (after `resolveBoard`):

```ts
/** Search depth by faction difficulty (always even). Harder factions search deeper. */
export const depthForFaction = (faction: GoFaction): number => {
    if (faction === '????????????') return 8;
    if (faction === 'Daedalus' || faction === 'Illuminati') return 6;
    return SEARCH_DEPTH;
};

interface DeepProfile {
    board: BoardSize;
    rootBranch: number;
    nodeBranch: number;
}

// Deep-search factions are pinned to a small board with a narrow beam so the
// deeper search stays affordable (cost grows as beam^depth).
const DEEP_PROFILES: Partial<Record<GoFaction, DeepProfile>> = {
    Daedalus: { board: 7, rootBranch: 8, nodeBranch: 4 },
    Illuminati: { board: 7, rootBranch: 8, nodeBranch: 4 },
    '????????????': { board: 5, rootBranch: 6, nodeBranch: 3 },
};

export interface GamePlan {
    board: BoardSize;
    rootBranch: number;
    nodeBranch: number;
    depth: number;
    games: number;
}

/**
 * Resolve the full per-game plan for a faction. Deep factions use a fixed small
 * board + narrow beam (board escalation does not apply); easy factions use the
 * smallest-first escalation and wide beams. `games` is the board-progress counter
 * to persist (passed through unchanged for deep factions).
 */
export const planGame = (
    faction: GoFaction,
    entry: BoardProgress | undefined,
    escalateAfter: number,
): GamePlan => {
    const depth = depthForFaction(faction);
    const deep = DEEP_PROFILES[faction];
    if (deep) {
        return {
            board: deep.board,
            rootBranch: deep.rootBranch,
            nodeBranch: deep.nodeBranch,
            depth,
            games: entry?.games ?? 0,
        };
    }
    const { board, games } = resolveBoard(entry, escalateAfter);
    const { rootBranch, nodeBranch } = branchForBoard(board);
    return { board, rootBranch, nodeBranch, depth, games };
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/**/*.test.ts" 2>&1 | grep -E "tests |pass |fail "`
Expected: all pass, 0 fail (go-ladder + go-engine + the others).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "go-ladder" || echo "go-ladder clean"`
Expected: `go-ladder clean`.

- [ ] **Step 6: Commit**

```bash
git add src/utils/go-ladder.ts test/go-ladder.test.ts
git commit -m "feat: Go games-based faction objective + per-faction depth (planGame)"
```

---

### Task 2: go.ts wiring — use planGame + per-faction depth

**Files:**
- Modify: `src/utils/go.ts` (replace whole file)

**Interfaces:**
- Consumes (Task 1): `chooseFaction`, `planGame`, `GAMES_PER_FACTION`, `ESCALATE_AFTER_GAMES`, types `GoFaction`, `BoardProgress`. And `selectMove` (unchanged engine signature).
- Produces: `go.js` (run on home). No exports consumed elsewhere.

NS shell — verified in-game. Automated gate: clean type-check + full pure suite green.

- [ ] **Step 1: Replace `src/utils/go.ts`**

```ts
import { NS } from '@ns';
import { Grid, selectMove } from './go-engine';
import {
    GoFaction,
    BoardProgress,
    GAMES_PER_FACTION,
    ESCALATE_AFTER_GAMES,
    chooseFaction,
    planGame,
} from './go-ladder';

const STOP_FILE = 'go-stop.txt';
const PROGRESS_FILE = 'go-progress.txt';

type ProgressMap = Partial<Record<GoFaction, BoardProgress>>;

/** @param {NS} ns */
export async function main(ns: NS) {
    ns.disableLog('ALL');

    while (!ns.fileExists(STOP_FILE, 'home')) {
        const progress = readProgress(ns);
        const stats = ns.go.analysis.getStats();
        const faction = chooseFaction(stats, GAMES_PER_FACTION);
        const { board, rootBranch, nodeBranch, depth, games } = planGame(
            faction,
            progress[faction],
            ESCALATE_AFTER_GAMES,
        );

        const started = ns.go.resetBoardState(faction, board);
        if (!started) {
            ns.print(`WARN could not start ${faction} on ${board}x${board}`);
            await ns.sleep(1000);
            continue;
        }

        let result;
        do {
            const move = chooseMove(ns, depth, rootBranch, nodeBranch);
            if (move) result = await ns.go.makeMove(move[0], move[1]);
            else result = await ns.go.passTurn();
            await ns.go.opponentNextTurn();
        } while (result?.type !== 'gameOver');

        progress[faction] = { board, games: games + 1 };
        writeProgress(ns, progress);
        logGameResult(ns, faction, board, depth);
    }

    ns.tprint(`Go grinder stopped (found /${STOP_FILE}).`);
}

/**
 * Pick our move by mirroring the live board into a mutable grid and handing it to
 * the engine's bounded alpha-beta search at the faction's depth/branch widths.
 */
const chooseMove = (
    ns: NS,
    depth: number,
    rootBranch: number,
    nodeBranch: number,
): [number, number] | null => {
    const board = ns.go.getBoardState();
    const valid = ns.go.analysis.getValidMoves();
    const size = board[0].length;

    const grid: Grid = [];
    for (let x = 0; x < size; x++) {
        const col: string[] = [];
        for (let y = 0; y < size; y++) col.push(board[x][y]);
        grid.push(col);
    }

    return selectMove(grid, valid, depth, rootBranch, nodeBranch);
};

const readProgress = (ns: NS): ProgressMap => {
    const raw = ns.read(PROGRESS_FILE);
    if (!raw) return {};
    try {
        return JSON.parse(raw) as ProgressMap;
    } catch {
        return {};
    }
};

const writeProgress = (ns: NS, progress: ProgressMap) => {
    ns.write(PROGRESS_FILE, JSON.stringify(progress), 'w');
};

/** Log the finished game using the faction's persistent stats from analysis.getStats(). */
const logGameResult = (ns: NS, faction: GoFaction, board: number, depth: number) => {
    const s = ns.go.analysis.getStats()[faction];
    if (!s) return;
    const games = s.wins + s.losses;
    ns.print(
        `${faction} ${board}x${board} d${depth} | W:${s.wins} L:${s.losses} ` +
        `games:${games}/${GAMES_PER_FACTION} streak:${s.winStreak} bonus:${s.bonusPercent}%`,
    );
};
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "utils/go.ts|go-ladder" || echo "driver clean"`
Expected: `driver clean`. (Pre-existing unrelated errors elsewhere, e.g. `src/utils/codingcontracts.ts`, are not in scope.)

- [ ] **Step 3: Verify the full pure suite still passes**

Run: `node --test "test/**/*.test.ts" 2>&1 | grep -E "tests |pass |fail "`
Expected: all pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add src/utils/go.ts
git commit -m "feat: Go driver uses planGame (games objective + per-faction depth)"
```

- [ ] **Step 5: In-game verification (manual — for the human)**

Build auto-deploys via viteburner. In the game:
1. `rm go-progress.txt` (optional), then `run go.js` on home.
2. `tail go.js` — confirm the log shows the faction, board, depth (`d4`/`d6`/`d8`), and `games:N/100`.
3. Confirm a faction advances after ~100 games (wins + losses), regardless of streak.
4. Confirm deep factions play their fixed boards: Daedalus/Illuminati on 7×7 at depth 6; `????????????` on 5×5 at depth 8 — and watch move latency there (should be ~0.5–2 s/move; if a board feels too slow, narrow that faction's beam or drop its depth by 2 in `go-ladder.ts`).
5. `echo stop > go-stop.txt` cleanly stops the grinder.

---

## Notes for the executor

- `go-engine.ts` is intentionally NOT touched; its existing tests must stay green.
- `go.ts` imports only what it uses; `SEARCH_DEPTH`/`resolveBoard`/`branchForBoard` are now used *inside* `planGame`, not directly by `go.ts`.
- `ns.go.analysis.getStats()` returns `{ wins, losses, ... }` per faction, structurally compatible with `chooseFaction`'s `FactionStat` parameter (no cast needed, as with the prior version).
