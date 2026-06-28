# Crash-Proof Deep Search + Eye/Life Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Let the Go search run arbitrarily deep without crashing the game (cooperative yielding), raise the hard-faction depth, and add a real-eye eval term so the bot values life.

**Architecture:** `search`/`selectMove` in the pure `go-engine.ts` become async and yield to an injected callback every `YIELD_NODES` nodes; `go.ts` awaits them and passes `() => ns.sleep(0)`. `depthForFaction` (go-ladder) is raised. A `realEyeCounts` term is added to `evaluateBoard`.

**Tech Stack:** TypeScript, Bitburner (modded) NS API, viteburner, Node 26 `node --test`.

## Global Constraints

- `go-engine.ts` and `go-ladder.ts` MUST NOT import `@ns` or reference `ns.*` (pure modules). The yield callback is injected by the driver; the engine only `await`s it.
- Tests live in top-level `test/` and import source with an explicit `.ts` extension; run with `node --test "test/**/*.test.ts"`.
- Exact values: `YIELD_NODES = 2000`; depth Daedalus 10, Illuminati 12, `????????????` 12, easy 4 (all even); `EVAL.EYE = 6`.
- Behaviour-preserving for move choice: yielding must not change which move `selectMove` returns; the eye term must be antisymmetric (symmetric positions still evaluate to 0).
- Commit after every task. Work on branch `feat/go-crashproof-eyes` (already checked out); do NOT create a new branch.

---

### Task 1: Cooperative yielding (crash-proof deep search)

**Files:**
- Modify: `src/utils/go-engine.ts`
- Modify: `src/utils/go.ts`
- Modify: `test/go-engine.test.ts`

**Interfaces:**
- Produces: `YIELD_NODES = 2000`; `search(grid, toMove, depth, alpha, beta, nodeBranch, tick): Promise<number>` (async, `tick: () => Promise<void>`); `selectMove(grid, validMoves, depth, rootBranch, nodeBranch, rng?, onTick?): Promise<[number,number]|null>` (async; `onTick: () => Promise<void>` default no-op).
- Consumes (go.ts): the async `selectMove`.

- [ ] **Step 1: Write/adjust the tests (RED)**

In `test/go-engine.test.ts`:

(a) Add `YIELD_NODES` to the import from `'../src/utils/go-engine.ts'`.

(b) Convert EVERY test that calls `selectMove` to an async test that awaits it. The transform is mechanical: `test('...', () => {` → `test('...', async () => {`, and each `selectMove(...)` → `await selectMove(...)`. The affected tests are: "selectMove plays a gaining move...", "selectMove passes when every empty point is settled", "selectMove decision does not depend on the score...", "selectMove never returns a move the game marks invalid", "a deeper search changes the chosen move...", "a wider beam changes the chosen move...". (Their arguments are unchanged.)

(c) Add a new test proving the yield callback fires on a large search:

```ts
test('selectMove yields to onTick during a large search', async () => {
    const empty = parseBoard(['.......', '.......', '.......', '.......', '.......', '.......', '.......']);
    let ticks = 0;
    await selectMove(empty, allValid(empty), 4, 12, 12, () => 0, async () => {
        ticks++;
    });
    assert.ok(ticks > 0, 'onTick should fire at least once on a depth-4 7x7 search');
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/go-engine.test.ts"`
Expected: FAIL — `YIELD_NODES` not exported / the new yield test (and the awaited calls return a Promise, not a move).

- [ ] **Step 3: Make `search` and `selectMove` async with yielding**

In `src/utils/go-engine.ts`:

**(a)** Add the constant next to `POOL_MIN`:

```ts
export const YIELD_NODES = 2000; // search nodes between cooperative yields to the game
```

**(b)** Replace the entire `search` function with this async version:

```ts
export const search = async (
    grid: Grid,
    toMove: string,
    depth: number,
    alpha: number,
    beta: number,
    nodeBranch: number,
    tick: () => Promise<void>,
): Promise<number> => {
    await tick();
    if (depth === 0) return evaluateBoard(grid);

    const moves = beam(grid, toMove, nodeBranch);
    if (moves.length === 0) return evaluateBoard(grid); // no play available — stand pat

    if (toMove === 'X') {
        let best = -Infinity;
        for (const m of moves) {
            best = Math.max(best, await search(m.grid, 'O', depth - 1, alpha, beta, nodeBranch, tick));
            alpha = Math.max(alpha, best);
            if (alpha >= beta) break;
        }
        return best;
    }

    let best = Infinity;
    for (const m of moves) {
        best = Math.min(best, await search(m.grid, 'X', depth - 1, alpha, beta, nodeBranch, tick));
        beta = Math.min(beta, best);
        if (alpha >= beta) break;
    }
    return best;
};
```

**(c)** Replace the entire `selectMove` function with this async version (creates the `tick` that counts nodes and yields every `YIELD_NODES`):

```ts
export const selectMove = async (
    grid: Grid,
    validMoves: boolean[][],
    depth: number,
    rootBranch: number,
    nodeBranch: number,
    rng: () => number = Math.random,
    onTick: () => Promise<void> = async () => {},
): Promise<[number, number] | null> => {
    let nodes = 0;
    const tick = async () => {
        if (++nodes % YIELD_NODES === 0) await onTick();
    };

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

    const passValue = await search(grid, 'O', depth - 1, -Infinity, Infinity, nodeBranch, tick);

    let best: [number, number] | null = null;
    let bestValue = passValue;
    let bestJittered = -Infinity;
    for (const m of top) {
        const window = best === null ? passValue : bestValue - TIE_EPSILON;
        const value = await search(m.grid, 'O', depth - 1, window, Infinity, nodeBranch, tick);
        if (value <= passValue) continue;
        if (best !== null && value < bestValue) continue;
        const jittered = value + rng() * 0.01;
        if (jittered > bestJittered) {
            best = [m.x, m.y];
            bestValue = Math.max(bestValue, value);
            bestJittered = jittered;
        }
    }

    return best;
};
```

**(d)** In `src/utils/go.ts`, make `chooseMove` async, await `selectMove`, and pass the yield callback. Replace the `chooseMove` function:

```ts
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
```

with:

```ts
const chooseMove = async (
    ns: NS,
    depth: number,
    rootBranch: number,
    nodeBranch: number,
): Promise<[number, number] | null> => {
    const board = ns.go.getBoardState();
    const valid = ns.go.analysis.getValidMoves();
    const size = board[0].length;

    const grid: Grid = [];
    for (let x = 0; x < size; x++) {
        const col: string[] = [];
        for (let y = 0; y < size; y++) col.push(board[x][y]);
        grid.push(col);
    }

    // Yield to the game every YIELD_NODES nodes so a deep search never freezes
    // the tab or trips Bitburner's no-yield guard.
    return selectMove(grid, valid, depth, rootBranch, nodeBranch, Math.random, () => ns.sleep(0));
};
```

**(e)** In `src/utils/go.ts`, await the now-async `chooseMove` in the game loop. Replace:

```ts
            const move = chooseMove(ns, depth, rootBranch, nodeBranch);
```

with:

```ts
            const move = await chooseMove(ns, depth, rootBranch, nodeBranch);
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/**/*.test.ts" 2>&1 | grep -E "tests |pass |fail "`
Expected: all pass, 0 fail (the awaited selectMove tests behave identically; the new yield test sees ticks > 0).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "go-engine|go\.ts" || echo "clean"`
Expected: `clean`. (`ns.sleep` returns a `Promise<true>`; `() => ns.sleep(0)` is assignable to `() => Promise<void>` because a `void`-returning callback type accepts any return value.)

- [ ] **Step 6: Commit**

```bash
git add src/utils/go-engine.ts src/utils/go.ts test/go-engine.test.ts
git commit -m "feat: cooperative yielding so deep Go search never freezes the game"
```

---

### Task 2: Raise hard-faction depth

**Files:**
- Modify: `src/utils/go-ladder.ts`
- Modify: `test/go-ladder.test.ts`

**Interfaces:**
- Consumes/Produces: `depthForFaction` returns Daedalus 10, Illuminati 12, `????????????` 12, others 4.

- [ ] **Step 1: Update the depth test (RED)**

In `test/go-ladder.test.ts`, replace the `depthForFaction` assertions:

```ts
    assert.equal(depthForFaction('Daedalus'), 8);
    assert.equal(depthForFaction('Illuminati'), 8);
    assert.equal(depthForFaction('????????????'), 8);
    for (const f of FACTION_LADDER) assert.equal(depthForFaction(f) % 2, 0);
```

with:

```ts
    assert.equal(depthForFaction('Daedalus'), 10);
    assert.equal(depthForFaction('Illuminati'), 12);
    assert.equal(depthForFaction('????????????'), 12);
    for (const f of FACTION_LADDER) assert.equal(depthForFaction(f) % 2, 0);
```

Also update the `planGame` deep-faction test to the new depths:

```ts
    assert.deepEqual(
        planGame('Daedalus'),
        { board: 7, rootBranch: 8, nodeBranch: 4, depth: 8 },
    );
    // Illuminati is the top faction now: depth 8 on the narrowest beam (depth 10
    // was too slow on 7x7).
    assert.deepEqual(
        planGame('Illuminati'),
        { board: 7, rootBranch: 6, nodeBranch: 3, depth: 8 },
    );
    assert.deepEqual(
        planGame('????????????'),
        { board: 7, rootBranch: 6, nodeBranch: 3, depth: 8 },
    );
```

with:

```ts
    assert.deepEqual(
        planGame('Daedalus'),
        { board: 7, rootBranch: 8, nodeBranch: 4, depth: 10 },
    );
    // Illuminati is the top faction: deepest search (now crash-safe via yielding).
    assert.deepEqual(
        planGame('Illuminati'),
        { board: 7, rootBranch: 6, nodeBranch: 3, depth: 12 },
    );
    assert.deepEqual(
        planGame('????????????'),
        { board: 7, rootBranch: 6, nodeBranch: 3, depth: 12 },
    );
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test "test/go-ladder.test.ts"`
Expected: FAIL — Daedalus is 8, not 10.

- [ ] **Step 3: Raise the depths**

In `src/utils/go-ladder.ts`, replace `depthForFaction`:

```ts
export const depthForFaction = (faction: GoFaction): number => {
    if (faction === '????????????' || faction === 'Illuminati' || faction === 'Daedalus') return 8;
    return SEARCH_DEPTH;
};
```

with:

```ts
export const depthForFaction = (faction: GoFaction): number => {
    if (faction === '????????????' || faction === 'Illuminati') return 12;
    if (faction === 'Daedalus') return 10;
    return SEARCH_DEPTH;
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/**/*.test.ts" 2>&1 | grep -E "tests |pass |fail "`
Expected: all pass, 0 fail (the deep-faction narrow-beam invariant still holds: depths only rose).

- [ ] **Step 5: Commit**

```bash
git add src/utils/go-ladder.ts test/go-ladder.test.ts
git commit -m "feat: raise hard-faction depth (Daedalus 10, Illuminati 12) now that deep search is crash-safe"
```

---

### Task 3: Real-eye eval term (toward life)

**Files:**
- Modify: `src/utils/go-engine.ts`
- Modify: `test/go-engine.test.ts`

**Interfaces:**
- Consumes: `DIRS`, `Grid`, `EVAL`, `evaluateBoard`, `parseBoard`.
- Produces: `EVAL.EYE = 6`; `realEyeCounts(grid: Grid): { x: number; o: number }`; `evaluateBoard` adds `EVAL.EYE * eyes.x - EVAL.EYE * eyes.o`.

- [ ] **Step 1: Write the failing tests**

Add to `test/go-engine.test.ts` (add `realEyeCounts` to the import):

```ts
test('realEyeCounts: a fully-surrounded point with controlled diagonals is a real eye', () => {
    assert.deepEqual(realEyeCounts(parseBoard(['XXX', 'X.X', 'XXX'])), { x: 1, o: 0 });
});

test('realEyeCounts: orthogonally surrounded but diagonally uncontrolled is a false eye', () => {
    // (1,1) has all-X orthogonals but 0 X diagonals (interior needs >=3) -> not real.
    assert.deepEqual(realEyeCounts(parseBoard(['.X.', 'X.X', '.X.'])), { x: 0, o: 0 });
});

test('realEyeCounts: a corner eye needs only its on-board diagonal controlled', () => {
    // (0,0): on-board orthogonals (0,1),(1,0) are X; the one on-board diagonal (1,1) is X.
    assert.deepEqual(realEyeCounts(parseBoard(['.X', 'XX'])), { x: 1, o: 0 });
});

test('evaluateBoard stays antisymmetric with eyes present (eye term correctly signed)', () => {
    const b = parseBoard(['XXX', 'X.X', 'XX.']); // (1,1) is a real X eye (3 controlled diagonals)
    const swapped = b.map((row) => row.map((c) => (c === 'X' ? 'O' : c === 'O' ? 'X' : c)));
    assert.equal(evaluateBoard(b), -evaluateBoard(swapped));
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/go-engine.test.ts"`
Expected: FAIL — `realEyeCounts` not exported.

- [ ] **Step 3: Implement `realEyeCounts` and wire it into `evaluateBoard`**

In `src/utils/go-engine.ts`:

**(a)** Add `EYE` to the `EVAL` constant (after `CUT`):

```ts
    CUT: 6,         // per cutting point (empty point adjoining 2+ of one colour's groups)
} as const;
```

becomes:

```ts
    CUT: 6,         // per cutting point (empty point adjoining 2+ of one colour's groups)
    EYE: 6,         // per real eye (life value beyond the territory the point already scores)
} as const;
```

**(b)** Add `realEyeCounts` just above `evaluateBoard`:

```ts
/**
 * Count "real eyes" per colour. An empty point P is a real eye for colour C when:
 *   1. every on-board orthogonal neighbour of P is a C stone, and
 *   2. its diagonals are controlled — interior points need >= 3 of the 4 diagonals
 *      to be C; edge/corner points need ALL their on-board diagonals to be C.
 * This is the standard false-eye-resistant test. Eyes are the basis of life, so the
 * eval rewards ours and penalises the opponent's.
 */
export const realEyeCounts = (grid: Grid): { x: number; o: number } => {
    const size = grid.length;
    const diagonals: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    let x = 0;
    let o = 0;

    for (let px = 0; px < size; px++) {
        for (let py = 0; py < size; py++) {
            if (grid[px][py] !== '.') continue;

            let color: string | null = null;
            let surrounded = true;
            for (const [dx, dy] of DIRS) {
                const nx = px + dx;
                const ny = py + dy;
                if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue; // edge: not disqualifying
                const cell = grid[nx][ny];
                if (cell === '.') { surrounded = false; break; }
                if (color === null) color = cell;
                else if (cell !== color) { surrounded = false; break; }
            }
            if (!surrounded || color === null) continue;

            let off = 0;
            let same = 0;
            for (const [dx, dy] of diagonals) {
                const nx = px + dx;
                const ny = py + dy;
                if (nx < 0 || ny < 0 || nx >= size || ny >= size) { off++; continue; }
                if (grid[nx][ny] === color) same++;
            }
            const real = off === 0 ? same >= 3 : same === 4 - off;
            if (!real) continue;

            if (color === 'X') x++;
            else if (color === 'O') o++;
        }
    }
    return { x, o };
};
```

**(c)** Fold it into `evaluateBoard`. The function currently ends with the cutting-point block then `return value;`:

```ts
    // Connection/cut: penalise our own cutting points, reward the enemy's.
    const cuts = cuttingPointCounts(grid);
    value += -EVAL.CUT * cuts.x + EVAL.CUT * cuts.o;

    return value;
};
```

Replace it with:

```ts
    // Connection/cut: penalise our own cutting points, reward the enemy's.
    const cuts = cuttingPointCounts(grid);
    value += -EVAL.CUT * cuts.x + EVAL.CUT * cuts.o;

    // Eyes: reward our real eyes (life), penalise the enemy's.
    const eyes = realEyeCounts(grid);
    value += EVAL.EYE * eyes.x - EVAL.EYE * eyes.o;

    return value;
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/**/*.test.ts" 2>&1 | grep -E "tests |pass |fail "`
Expected: all pass, 0 fail (existing symmetric-position tests still 0 — the eye term is antisymmetric).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "go-engine|go-ladder|go\.ts" || echo "go files clean"`
Expected: `go files clean`.

- [ ] **Step 6: Commit**

```bash
git add src/utils/go-engine.ts test/go-engine.test.ts
git commit -m "feat: real-eye eval term (value life — reward our eyes, deny the enemy's)"
```

- [ ] **Step 7: In-game verification (manual — for the human)**

1. `run go.js`; `tail go.js`.
2. Play through a hard faction (Daedalus/Illuminati) and confirm the game **stays responsive** during the now-deeper moves — it should NOT freeze or get the script killed, even though each move may take a while.
3. Confirm the bot tries to make eyes for its groups and reduce the opponent's eye space.
4. If a move takes impractically long, lower `depthForFaction` (Daedalus/Illuminati) in `go-ladder.ts` — the search is crash-safe regardless, this is purely speed.

---

## Notes for the executor

- The eval-fold for eyes is verified by the `realEyeCounts` unit tests plus the antisymmetry test; a magnitude-isolation test (like the cut term's) is not practical because an eye is entangled with the surrounding group's stones/liberties/territory. Confirm by inspection that the fold line is present in `evaluateBoard`.
- The engine stays `@ns`-free: the yield callback is injected by `go.ts` (`() => ns.sleep(0)`); the engine only `await`s it.
- `make/unmake` (clone-free search) and a full life-and-death solver are explicitly deferred per the spec.
