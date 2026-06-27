# Go Bot Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the IPvGO bot climb factions easiest-first to a 10-win streak (smallest board first, escalating when stuck), evaluate after the opponent's reply (even depth 4), and search broadly on small boards without forward-pruning tactics — affordably, via root-alpha + lazy move ordering.

**Architecture:** A new pure `go-ladder.ts` holds the faction/board/branch/depth policy. `go-engine.ts` gains a `nodeBranch` parameter, root-alpha threading in `selectMove`, and a lazy two-phase move ordering (cheap rank → expand only the beam). `go.ts` (thin NS shell) reads `ns.go.analysis.getStats()` + a small `go-progress.txt`, picks faction/board/branch each game, and plays at depth 4.

**Tech Stack:** TypeScript, Bitburner (modded) NS API, viteburner, Node 26 `node --test`.

## Global Constraints

- Pure modules (`go-ladder.ts`, `go-engine.ts`) MUST NOT import `@ns` or reference `ns.*`.
- Tests live in top-level `test/` and import source with an explicit `.ts` extension; run with `node --test "test/**/*.test.ts"`.
- `SEARCH_DEPTH = 4` (even — the search horizon must end on the opponent's reply).
- `STREAK_TARGET = 10`; `ESCALATE_AFTER_GAMES = 30`.
- Faction ladder order: `Netburners`, `Slum Snakes`, `The Black Hand`, `Tetrads`, `Daedalus`, `Illuminati`, `????????????`.
- Board sizes: `5 | 7 | 9 | 13`. Branch widths by board: 5 → {root 25, node 25}; 7 → {25, 16}; 9 → {16, 10}; 13 → {12, 6}.
- Faction choice derives from `ns.go.analysis.getStats()` (persists across restarts); per-faction board progress persists in `go-progress.txt` on home.
- Commit after every task. Work on branch `feat/go-bot-improvements` (already checked out); do NOT create a new branch.

---

### Task 1: Pure faction/board policy (`go-ladder.ts`)

**Files:**
- Create: `src/utils/go-ladder.ts`
- Test: `test/go-ladder.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `type GoFaction` (the 7 ladder factions), `type BoardSize = 5 | 7 | 9 | 13`
  - `interface FactionStat { highestWinStreak: number }`
  - `interface BoardProgress { board: BoardSize; games: number }`
  - `interface BranchWidths { rootBranch: number; nodeBranch: number }`
  - `FACTION_LADDER: GoFaction[]`, `BOARD_SIZES: BoardSize[]`, `SEARCH_DEPTH = 4`, `STREAK_TARGET = 10`, `ESCALATE_AFTER_GAMES = 30`
  - `branchForBoard(size: BoardSize): BranchWidths`
  - `chooseFaction(stats: Partial<Record<string, FactionStat>>, streakTarget: number): GoFaction`
  - `nextBoard(size: BoardSize): BoardSize`
  - `resolveBoard(entry: BoardProgress | undefined, escalateAfter: number): BoardProgress`

- [ ] **Step 1: Write the failing test**

Create `test/go-ladder.test.ts`:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    FACTION_LADDER,
    SEARCH_DEPTH,
    branchForBoard,
    chooseFaction,
    nextBoard,
    resolveBoard,
    type FactionStat,
} from '../src/utils/go-ladder.ts';

const stat = (highestWinStreak: number): FactionStat => ({ highestWinStreak });

test('SEARCH_DEPTH is even so the search horizon ends on the opponent reply', () => {
    assert.equal(SEARCH_DEPTH % 2, 0);
    assert.equal(SEARCH_DEPTH, 4);
});

test('chooseFaction starts at the easiest faction when there are no stats', () => {
    assert.equal(chooseFaction({}, 10), 'Netburners');
});

test('chooseFaction skips factions that already reached the streak target', () => {
    const stats = { Netburners: stat(10), 'Slum Snakes': stat(3) };
    assert.equal(chooseFaction(stats, 10), 'Slum Snakes');
});

test('chooseFaction returns the hardest faction once all are cleared', () => {
    const stats = Object.fromEntries(FACTION_LADDER.map((f) => [f, stat(10)]));
    assert.equal(chooseFaction(stats, 10), '????????????');
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "test/go-ladder.test.ts"`
Expected: FAIL — `Cannot find module '../src/utils/go-ladder.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/go-ladder.ts`:

```ts
// Pure faction-ladder + board/search policy for the Go grinder. No NS dependency,
// so it can be unit-tested in isolation (see go-ladder.test.ts).

export type GoFaction =
    | 'Netburners'
    | 'Slum Snakes'
    | 'The Black Hand'
    | 'Tetrads'
    | 'Daedalus'
    | 'Illuminati'
    | '????????????';

export type BoardSize = 5 | 7 | 9 | 13;

/** The single stat we use to decide whether a faction is "cleared". */
export interface FactionStat {
    highestWinStreak: number;
}

/** Per-faction board progress, persisted by the driver. */
export interface BoardProgress {
    board: BoardSize;
    games: number;
}

export interface BranchWidths {
    rootBranch: number;
    nodeBranch: number;
}

// Easiest -> hardest.
export const FACTION_LADDER: GoFaction[] = [
    'Netburners',
    'Slum Snakes',
    'The Black Hand',
    'Tetrads',
    'Daedalus',
    'Illuminati',
    '????????????',
];

export const BOARD_SIZES: BoardSize[] = [5, 7, 9, 13];

export const SEARCH_DEPTH = 4;        // even -> horizon ends on the opponent's reply
export const STREAK_TARGET = 10;      // win streak that "clears" a faction
export const ESCALATE_AFTER_GAMES = 30; // games on a board before stepping up a size

// Wide on small boards (search broadly, never prune a tactic); narrow only where
// breadth is genuinely unaffordable.
export const branchForBoard = (size: BoardSize): BranchWidths => {
    switch (size) {
        case 5:
            return { rootBranch: 25, nodeBranch: 25 };
        case 7:
            return { rootBranch: 25, nodeBranch: 16 };
        case 9:
            return { rootBranch: 16, nodeBranch: 10 };
        case 13:
            return { rootBranch: 12, nodeBranch: 6 };
    }
};

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

/** The next board size up, capped at the largest. */
export const nextBoard = (size: BoardSize): BoardSize => {
    const i = BOARD_SIZES.indexOf(size);
    if (i < 0) return BOARD_SIZES[0];
    return BOARD_SIZES[Math.min(i + 1, BOARD_SIZES.length - 1)];
};

/**
 * Resolve the board to play given stored progress, applying a pending escalation:
 * once `games` reaches the patience budget on a non-max board, step up and reset
 * the counter. A missing entry starts the faction at the smallest board.
 */
export const resolveBoard = (
    entry: BoardProgress | undefined,
    escalateAfter: number,
): BoardProgress => {
    let board: BoardSize = entry?.board ?? BOARD_SIZES[0];
    let games = entry?.games ?? 0;
    const maxBoard = BOARD_SIZES[BOARD_SIZES.length - 1];
    if (escalateAfter > 0 && games >= escalateAfter && board !== maxBoard) {
        board = nextBoard(board);
        games = 0;
    }
    return { board, games };
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test "test/go-ladder.test.ts"`
Expected: PASS — all 10 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/utils/go-ladder.ts test/go-ladder.test.ts
git commit -m "feat: pure Go faction/board ladder policy"
```

---

### Task 2: Engine upgrade — nodeBranch param, lazy ordering, root-alpha (`go-engine.ts`)

**Files:**
- Modify: `src/utils/go-engine.ts`
- Modify: `test/go-engine.test.ts`

**Interfaces:**
- Consumes: nothing new (internal engine refactor).
- Produces (changed/new signatures consumed by Task 3):
  - `rankMoves(grid: Grid, color: string): { x: number; y: number; score: number }[]`
  - `expandMove(grid: Grid, x: number, y: number, color: string): { grid: Grid; ord: number } | null`
  - `search(grid: Grid, toMove: string, depth: number, alpha: number, beta: number, nodeBranch: number): number`
  - `selectMove(grid: Grid, validMoves: boolean[][], depth: number, rootBranch: number, nodeBranch: number, rng?: () => number): [number, number] | null`
  - `POOL_MIN = 16`, `TIE_EPSILON = 0.5`
  - **Removed:** `orderedMoves`, `NODE_BRANCH`.

This task changes existing tests' interface, so write the new test file first (RED), then refactor the engine to satisfy it (GREEN). The territory/self-fill exclusions and the existing characterized behaviors must be preserved.

- [ ] **Step 1: Rewrite the test file (RED)**

Replace the entire contents of `test/go-engine.test.ts` with:

```ts
import test from 'node:test';
import assert from 'node:assert/strict';
import {
    parseBoard,
    groupAt,
    playStone,
    secureTerritoryMask,
    rankMoves,
    expandMove,
    evaluateBoard,
    selectMove,
    type Grid,
} from '../src/utils/go-engine.ts';

const allValid = (grid: Grid): boolean[][] => grid.map((row) => row.map(() => true));

// An X wall fully enclosing a 5x5 interior, with one lone O reduction stone in
// the middle. The interior empties are morally X's territory/eye space.
const ENCLOSED = [
    'XXXXXXX',
    'X.....X',
    'X.....X',
    'X..O..X',
    'X.....X',
    'X.....X',
    'XXXXXXX',
];

// ---------------------------------------------------------------------------
// Rules engine — preserved behavior.
// ---------------------------------------------------------------------------

test('groupAt counts a connected group and its liberties', () => {
    const grid = parseBoard(['XX.', '...', '...']);
    const g = groupAt(grid, 0, 0);
    assert.equal(g.cells.length, 2);
    assert.equal(g.liberties, 3);
});

test('playStone captures an enemy group reduced to zero liberties', () => {
    const grid = parseBoard(['.X.', 'XO.', '.X.']);
    const played = playStone(grid, 1, 2, 'X');
    assert.ok(played);
    assert.equal(played!.captured, 1);
    assert.equal(played!.grid[1][1], '.');
});

test('playStone rejects suicide', () => {
    const grid = parseBoard(['.O.', 'O.O', '.O.']);
    assert.equal(playStone(grid, 1, 1, 'X'), null);
});

test('secureTerritoryMask marks a fully enclosed single-colour region', () => {
    const grid = parseBoard(['XXXXX', 'X...X', 'X...X', 'X...X', 'XXXXX']);
    const mask = secureTerritoryMask(grid, 'X');
    assert.equal(mask[2][2], true);
    assert.equal(mask[1][1], true);
    assert.equal(mask[0][0], false);
});

test('evaluateBoard credits sealed territory to its owner', () => {
    const grid = parseBoard(['XXXXX', 'X...X', 'X...X', 'X...X', 'XXXXX']);
    assert.ok(evaluateBoard(grid) > 0);
});

test('filling our own enclosed territory is not net-positive', () => {
    const before = parseBoard(ENCLOSED);
    const played = playStone(before, 1, 1, 'X'); // deep interior, far from the O
    assert.ok(played);
    assert.ok(
        evaluateBoard(played!.grid) < evaluateBoard(before),
        'filling own territory should shed value',
    );
});

// ---------------------------------------------------------------------------
// Move ordering — rankMoves (cheap candidate ranking) + expandMove (exact score).
// ---------------------------------------------------------------------------

test('rankMoves surfaces a capture as the top candidate', () => {
    const grid = parseBoard(['.X.', 'XO.', '.X.']);
    const moves = rankMoves(grid, 'X');
    assert.ok(moves.length > 0);
    assert.equal(moves[0].x, 1);
    assert.equal(moves[0].y, 2); // capturing the O ranks first
});

test('rankMoves does not offer a deep self-fill of our own territory', () => {
    const grid = parseBoard(ENCLOSED);
    const moves = rankMoves(grid, 'X');
    assert.equal(moves.some((m) => m.x === 1 && m.y === 1), false);
});

test('rankMoves still offers moves that contact the invader', () => {
    const grid = parseBoard(ENCLOSED);
    const moves = rankMoves(grid, 'X');
    assert.ok(moves.some((m) => m.x === 3 && m.y === 2));
});

test('the opening is not over-pruned (every empty point is a candidate)', () => {
    const empty = parseBoard(['.......', '.......', '.......', '.......', '.......', '.......', '.......']);
    assert.equal(rankMoves(empty, 'X').length, 49);
});

test('a frontier point closer to the enemy is not excluded as our self-fill', () => {
    const grid = parseBoard(['X.....O', 'X.....O', 'X.....O', 'X.....O', 'X.....O', 'X.....O', 'X.....O']);
    const moves = rankMoves(grid, 'X');
    assert.ok(moves.some((m) => m.x === 3 && m.y === 5), 'reduction next to enemy must be allowed');
    assert.ok(moves.some((m) => m.x === 3 && m.y === 3), 'the neutral midline must be playable');
    assert.equal(moves.some((m) => m.x === 3 && m.y === 1), false, 'deep point in our own influence is kept blank');
});

test('expandMove scores a capture far above a quiet move', () => {
    const grid = parseBoard(['.X.', 'XO.', '.X.']);
    const cap = expandMove(grid, 1, 2, 'X');
    assert.ok(cap);
    assert.ok(cap!.ord >= 1000, `capture should score >= 1000, got ${cap!.ord}`);
});

test('expandMove rejects a suicide as null', () => {
    const grid = parseBoard(['.O.', 'O.O', '.O.']);
    assert.equal(expandMove(grid, 1, 1, 'X'), null);
});

test('expandMove heavily penalizes self-atari', () => {
    const grid = parseBoard(['OO.', 'O..', '...']);
    const e = expandMove(grid, 0, 2, 'X'); // 1-liberty stone, captures nothing
    assert.ok(e);
    assert.ok(e!.ord < 0, `self-atari should score negative, got ${e!.ord}`);
});

// ---------------------------------------------------------------------------
// selectMove — plays gains, passes when settled, ignores self-fill, score-blind.
// ---------------------------------------------------------------------------

test('selectMove plays a gaining move rather than passing, and never a self-fill', () => {
    const grid = parseBoard(ENCLOSED);
    const move = selectMove(grid, allValid(grid), 4, 12, 12, () => 0);
    assert.notEqual(move, null);
    assert.ok(!(move![0] === 1 && move![1] === 1), 'must not return the excluded deep self-fill');
});

test('selectMove passes when every empty point is settled', () => {
    // X alive (two eyes) on top; O alive (two eyes) on the bottom; no dame. Our
    // eyes are secure territory and the opponent's eyes are suicide for us, so
    // there is no legal, non-self-harming move -> selectMove must pass.
    const grid = parseBoard(['XXXXX', 'X.X.X', 'XXXXX', 'OOOOO', 'O.O.O']);
    assert.equal(selectMove(grid, allValid(grid), 4, 12, 12, () => 0), null);
});

test('selectMove decision does not depend on the score (no isAhead gate)', () => {
    const fighting = parseBoard(ENCLOSED);
    const settled = parseBoard(['XXXXX', 'X.X.X', 'XXXXX', 'OOOOO', 'O.O.O']);
    assert.notEqual(selectMove(fighting, allValid(fighting), 4, 12, 12, () => 0), null);
    assert.equal(selectMove(settled, allValid(settled), 4, 12, 12, () => 0), null);
});

test('selectMove never returns a move the game marks invalid', () => {
    // The capturing move (1,2) is the strongest, but if the game forbids it (ko),
    // selectMove must not return it.
    const grid = parseBoard(['.X.', 'XO.', '.X.']);
    const valid = allValid(grid);
    valid[1][2] = false;
    const move = selectMove(grid, valid, 4, 12, 12, () => 0);
    assert.ok(move === null || !(move[0] === 1 && move[1] === 2));
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test "test/go-engine.test.ts"`
Expected: FAIL — `rankMoves`/`expandMove` are not exported (and `orderedMoves` import is gone).

- [ ] **Step 3: Refactor the engine (GREEN)**

In `src/utils/go-engine.ts` make these changes:

**(a)** Replace the `NODE_BRANCH` constant declaration

```ts
export const NODE_BRANCH = 6; // candidate moves considered at each interior node
```

with:

```ts
export const POOL_MIN = 16;     // candidates expanded per node before taking the beam
export const TIE_EPSILON = 0.5; // jitter-preserving slack on the root alpha window
```

**(b)** Replace the entire `orderedMoves` function with these two functions (`rankMoves` then `expandMove`):

```ts
/**
 * Cheap best-first ranking of candidate moves for `color` — no board is played,
 * so it is fast enough to call at every search node. Applies the same two
 * exclusions the search relies on: never our own secure territory/eyes, and never
 * a "deep self-fill" well inside our influence that neither touches the enemy nor
 * rescues a group. Captures and atari/rescue tactics score highest so they always
 * survive the per-node beam, even though no stone is actually played here.
 */
export const rankMoves = (grid: Grid, color: string): { x: number; y: number; score: number }[] => {
    const size = grid.length;
    const enemy = color === 'X' ? 'O' : 'X';
    const ownTerritory = secureTerritoryMask(grid, color);
    const distOwn = floodDistances(grid, color);
    const distEnemy = floodDistances(grid, enemy);
    const out: { x: number; y: number; score: number }[] = [];

    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (grid[x][y] !== '.') continue;
            if (ownTerritory[x][y]) continue;

            let touchesEnemy = false;
            let rescued = 0;    // our stones in atari this move would adjoin
            let captures = 0;   // enemy stones captured (their last liberty is here)
            let threatened = 0; // enemy stones pushed toward capture (2 liberties)
            let adjEmpty = 0;   // liberty proxy
            for (const [dx, dy] of DIRS) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
                const cell = grid[nx][ny];
                if (cell === '.') {
                    adjEmpty++;
                } else if (cell === color) {
                    const g = groupAt(grid, nx, ny);
                    if (g.liberties === 1) rescued += g.cells.length;
                } else if (cell === enemy) {
                    touchesEnemy = true;
                    const g = groupAt(grid, nx, ny);
                    if (g.liberties === 1) captures += g.cells.length;
                    else if (g.liberties === 2) threatened += g.cells.length;
                }
            }

            const margin = distEnemy[x][y] - distOwn[x][y];
            if (!touchesEnemy && rescued === 0 && distOwn[x][y] < Infinity && margin >= 2) continue;

            let score = adjEmpty;
            if (captures > 0) score += 1000 + captures * 100;
            if (threatened > 0) score += 300 + threatened * 30;
            if (rescued > 0) score += 200 + rescued * 50;
            if (touchesEnemy) score += 50;

            out.push({ x, y, score });
        }
    }

    out.sort((a, b) => b.score - a.score);
    return out;
};

/**
 * Play `color` at (x, y) and return the resulting board plus an exact tactical
 * ordering score (captures, resulting liberties, rescue/threat bonuses, heavy
 * self-atari penalty), or null for an illegal (suicide) move. This is the precise
 * score the search sorts its beam by; rankMoves only decides which moves are worth
 * expanding.
 */
export const expandMove = (
    grid: Grid,
    x: number,
    y: number,
    color: string,
): { grid: Grid; ord: number } | null => {
    const size = grid.length;
    const enemy = color === 'X' ? 'O' : 'X';

    let rescued = 0;
    let threatened = 0;
    for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const cell = grid[nx][ny];
        if (cell === color) {
            const g = groupAt(grid, nx, ny);
            if (g.liberties === 1) rescued += g.cells.length;
        } else if (cell === enemy) {
            const g = groupAt(grid, nx, ny);
            if (g.liberties === 2) threatened += g.cells.length;
        }
    }

    const played = playStone(grid, x, y, color);
    if (played === null) return null;

    const own = groupAt(played.grid, x, y);
    let ord = played.captured * 1000 + own.liberties * 5;
    if (rescued > 0 && own.liberties > 1) ord += 500 + rescued * 50;
    if (threatened > 0) ord += 300 + threatened * 30;
    if (played.captured === 0 && own.liberties === 1) ord -= 10000;

    return { grid: played.grid, ord };
};

/** Expand the best `nodeBranch` moves for `color`, best-first by exact score. */
const beam = (grid: Grid, color: string, nodeBranch: number): { grid: Grid; ord: number }[] => {
    const ranked = rankMoves(grid, color);
    const poolSize = Math.max(nodeBranch, POOL_MIN);
    const expanded: { grid: Grid; ord: number }[] = [];
    for (const c of ranked.slice(0, poolSize)) {
        const e = expandMove(grid, c.x, c.y, color);
        if (e !== null) expanded.push(e);
    }
    expanded.sort((a, b) => b.ord - a.ord);
    return expanded.slice(0, nodeBranch);
};
```

**(c)** Replace the entire `search` function with:

```ts
/**
 * Alpha-beta minimax. Returns the value (black-positive) of best play from this
 * position with `toMove` to play, expanding at most `nodeBranch` moves per node.
 * Black ('X', us) maximises.
 */
export const search = (
    grid: Grid,
    toMove: string,
    depth: number,
    alpha: number,
    beta: number,
    nodeBranch: number,
): number => {
    if (depth === 0) return evaluateBoard(grid);

    const moves = beam(grid, toMove, nodeBranch);
    if (moves.length === 0) return evaluateBoard(grid); // no play available — stand pat

    if (toMove === 'X') {
        let best = -Infinity;
        for (const m of moves) {
            best = Math.max(best, search(m.grid, 'O', depth - 1, alpha, beta, nodeBranch));
            alpha = Math.max(alpha, best);
            if (alpha >= beta) break;
        }
        return best;
    }

    let best = Infinity;
    for (const m of moves) {
        best = Math.min(best, search(m.grid, 'X', depth - 1, alpha, beta, nodeBranch));
        beta = Math.min(beta, best);
        if (alpha >= beta) break;
    }
    return best;
};
```

**(d)** Replace the entire `selectMove` function with:

```ts
/**
 * Choose our ('X') move: rank candidates cheaply, expand the best `rootBranch`
 * into real boards, then search each with a window seeded from the running best
 * (root alpha) so clearly-worse moves prune their subtree. A move must beat simply
 * passing to be played; otherwise we pass (null). The window uses `bestValue −
 * TIE_EPSILON` so genuinely tied moves still return exact values and the jitter
 * tie-break (deterministic via `rng` in tests) still applies.
 */
export const selectMove = (
    grid: Grid,
    validMoves: boolean[][],
    depth: number,
    rootBranch: number,
    nodeBranch: number,
    rng: () => number = Math.random,
): [number, number] | null => {
    const ranked = rankMoves(grid, 'X').filter((m) => validMoves[m.x]?.[m.y] === true);
    if (ranked.length === 0) return null;

    const poolSize = Math.max(rootBranch, POOL_MIN);
    const roots: { x: number; y: number; grid: Grid; ord: number }[] = [];
    for (const c of ranked.slice(0, poolSize)) {
        const e = expandMove(grid, c.x, c.y, 'X');
        if (e !== null) roots.push({ x: c.x, y: c.y, grid: e.grid, ord: e.ord });
    }
    roots.sort((a, b) => b.ord - a.ord);
    const top = roots.slice(0, rootBranch);
    if (top.length === 0) return null;

    // Baseline value of passing (standing pat). A move must beat this to be played.
    const passValue = search(grid, 'O', depth - 1, -Infinity, Infinity, nodeBranch);

    let best: [number, number] | null = null;
    let bestValue = passValue;
    let bestJittered = -Infinity;
    for (const m of top) {
        const window = best === null ? passValue : bestValue - TIE_EPSILON;
        const value = search(m.grid, 'O', depth - 1, window, Infinity, nodeBranch);
        if (value <= passValue) continue;                 // must beat passing
        if (best !== null && value < bestValue) continue; // worse than the running best
        const jittered = value + rng() * 0.01;
        if (jittered > bestJittered) {
            best = [m.x, m.y];
            bestValue = Math.max(bestValue, value);
            bestJittered = jittered;
        }
    }

    return best; // null => pass
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/**/*.test.ts" 2>&1 | grep -E "tests |pass |fail "`
Expected: all pass, 0 fail (go-ladder + go-engine).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "go-engine" || echo "engine clean"`
Expected: `engine clean`.

- [ ] **Step 6: Commit**

```bash
git add src/utils/go-engine.ts test/go-engine.test.ts
git commit -m "feat: Go engine nodeBranch param, lazy ordering, root-alpha"
```

---

### Task 3: Driver wiring — faction ladder + adaptive board + depth 4 (`go.ts`)

**Files:**
- Modify: `src/utils/go.ts` (replace whole file)

**Interfaces:**
- Consumes: `selectMove` (Task 2, new signature with `nodeBranch`); `go-ladder` (Task 1): `chooseFaction`, `resolveBoard`, `branchForBoard`, `SEARCH_DEPTH`, `STREAK_TARGET`, `ESCALATE_AFTER_GAMES`, `GoFaction`, `BoardProgress`.
- Produces: `go.js` (run on home). No exports consumed elsewhere.

NS shell — verified in-game. The automated gate is a clean type-check + the full pure suite still green.

- [ ] **Step 1: Replace `src/utils/go.ts`**

```ts
import { NS } from '@ns';
import { Grid, selectMove } from './go-engine';
import {
    GoFaction,
    BoardProgress,
    SEARCH_DEPTH,
    STREAK_TARGET,
    ESCALATE_AFTER_GAMES,
    chooseFaction,
    resolveBoard,
    branchForBoard,
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
        const faction = chooseFaction(stats, STREAK_TARGET);
        const { board, games } = resolveBoard(progress[faction], ESCALATE_AFTER_GAMES);
        const { rootBranch, nodeBranch } = branchForBoard(board);

        const started = ns.go.resetBoardState(faction, board);
        if (!started) {
            ns.print(`WARN could not start ${faction} on ${board}x${board}`);
            await ns.sleep(1000);
            continue;
        }

        let result;
        do {
            const move = chooseMove(ns, rootBranch, nodeBranch);
            if (move) result = await ns.go.makeMove(move[0], move[1]);
            else result = await ns.go.passTurn();
            await ns.go.opponentNextTurn();
        } while (result?.type !== 'gameOver');

        progress[faction] = { board, games: games + 1 };
        writeProgress(ns, progress);
        logGameResult(ns, faction, board);
    }

    ns.tprint(`Go grinder stopped (found /${STOP_FILE}).`);
}

/**
 * Pick our move by mirroring the live board into a mutable grid and handing it to
 * the engine's bounded alpha-beta search at the configured depth/branch widths.
 */
const chooseMove = (ns: NS, rootBranch: number, nodeBranch: number): [number, number] | null => {
    const board = ns.go.getBoardState();
    const valid = ns.go.analysis.getValidMoves();
    const size = board[0].length;

    const grid: Grid = [];
    for (let x = 0; x < size; x++) {
        const col: string[] = [];
        for (let y = 0; y < size; y++) col.push(board[x][y]);
        grid.push(col);
    }

    return selectMove(grid, valid, SEARCH_DEPTH, rootBranch, nodeBranch);
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

/** Log the finished game using the faction's persistent stats from getStats(). */
const logGameResult = (ns: NS, faction: GoFaction, board: number) => {
    const s = ns.go.analysis.getStats()[faction];
    if (!s) return;
    ns.print(
        `${faction} ${board}x${board} | W:${s.wins} L:${s.losses} ` +
        `streak:${s.winStreak} (best ${s.highestWinStreak}/${STREAK_TARGET}) bonus:${s.bonusPercent}%`,
    );
};
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "utils/go.ts|go-ladder" || echo "driver clean"`
Expected: `driver clean`. If tsc reports that `ns.go.analysis.getStats()` is not assignable to `chooseFaction`'s parameter, add a minimal cast at the call site (`chooseFaction(stats as Partial<Record<string, { highestWinStreak: number }>>, STREAK_TARGET)`) and note it in the report; do not change `go-ladder.ts`.

- [ ] **Step 3: Verify the full pure suite still passes**

Run: `node --test "test/**/*.test.ts" 2>&1 | grep -E "tests |pass |fail "`
Expected: all pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add src/utils/go.ts
git commit -m "feat: Go driver climbs factions easiest-first with adaptive boards"
```

- [ ] **Step 5: In-game verification (manual — for the human)**

Build auto-deploys via viteburner. In the game:
1. `rm go-progress.txt` (optional, to start fresh), then `run go.js` on home.
2. `tail go.js` — confirm games start against `Netburners` on `5x5` and the log shows the faction, board, win/loss, and streak each game.
3. Confirm `go-progress.txt` appears on home (`{"Netburners":{"board":5,"games":N}}`) and `games` increments.
4. Over time, confirm: a faction advances once its `highestWinStreak` reaches 10 (per `getStats`); a faction that can't reach the streak escalates board size after ~30 games (5→7→9→13). Both even depth (4) and the wider small-board beams should make play visibly stronger (fewer self-trapping moves).
5. `echo "stop" > go-stop.txt` cleanly stops the grinder.

---

## Notes for the executor

- Only `test/go-engine.test.ts` imported `orderedMoves`; `go.ts` imports only `{ Grid, selectMove }`, so removing `orderedMoves`/`NODE_BRANCH` is safe.
- Pre-existing unrelated tsc errors (e.g. `src/utils/codingcontracts.ts`) are not in scope — only confirm none reference the files this plan changes.
- The "sacrifice-then-capture at depth 4 / wide beam" scenario from the spec is validated in-game (Task 3 step 5) rather than as a brittle hand-authored unit fixture; the engine's correctness is covered by the rankMoves/expandMove/selectMove unit tests above.
