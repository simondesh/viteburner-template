# Cutting-Point Eval Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Teach the Go engine to value connection and cutting — penalize our own cutting points (unprotected links/holes) and reward the enemy's — in the position value, plus a move-ordering bonus for wedge/cut moves.

**Architecture:** All changes are in the pure `src/utils/go-engine.ts`. A new `cuttingPointCounts(grid)` feeds an `EVAL.CUT` term in `evaluateBoard`; a `SHAPE.CUT` branch is added to `shapeScore`. No driver change.

**Tech Stack:** TypeScript, Bitburner (modded) NS API, viteburner, Node 26 `node --test`.

## Global Constraints

- `src/utils/go-engine.ts` MUST NOT import `@ns` or reference `ns.*` (pure module).
- Tests live in top-level `test/` and import source with an explicit `.ts` extension; run with `node --test "test/**/*.test.ts"`.
- A "cutting point for colour C" = an empty point orthogonally adjacent to **≥2 distinct C groups** (same-group stones count once).
- Exact values: `EVAL.CUT = 6`; `SHAPE.CUT = 60`. `SHAPE.CUT` must stay below the capture tier (1000).
- The eval term must be antisymmetric under colour-swap (so symmetric positions still evaluate to 0).
- Commit after every task. Work on branch `feat/go-cutting-points` (already checked out); do NOT create a new branch.

---

### Task 1: Cutting-point eval term

**Files:**
- Modify: `src/utils/go-engine.ts`
- Modify: `test/go-engine.test.ts`

**Interfaces:**
- Consumes: `groupAt`, `DIRS`, `Grid`, `parseBoard`, `evaluateBoard`, `EVAL`.
- Produces: `EVAL.CUT = 6`; `cuttingPointCounts(grid: Grid): { x: number; o: number }`; `evaluateBoard` adds `-EVAL.CUT*cp.x + EVAL.CUT*cp.o`.

- [ ] **Step 1: Write the failing tests**

Add to `test/go-engine.test.ts` (add `cuttingPointCounts` to the import from `'../src/utils/go-engine.ts'`):

```ts
test('cuttingPointCounts: an empty point adjacent to two separate same-colour groups is a cut', () => {
    // X at (0,0) and (0,2) are two distinct groups; (0,1) is adjacent to both.
    assert.deepEqual(cuttingPointCounts(parseBoard(['X.X', '...', '...'])), { x: 1, o: 0 });
});

test('cuttingPointCounts: a single connected group has no cutting point', () => {
    assert.deepEqual(cuttingPointCounts(parseBoard(['XXX', '...', '...'])), { x: 0, o: 0 });
});

test('cuttingPointCounts: counts each colour independently', () => {
    assert.deepEqual(cuttingPointCounts(parseBoard(['X.X', '...', 'O.O'])), { x: 1, o: 1 });
});

test('evaluateBoard applies exactly the cutting-point penalty (term isolated)', () => {
    // Two boards with identical stones, territory, and liberty penalties, differing
    // ONLY in cutting points: 'X. / .X' (two diagonal X groups) has 2 cutting points
    // — both empties touch both groups; 'XX / ..' (one connected group) has 0. So the
    // value difference is exactly 2*EVAL.CUT, isolating the term from everything else.
    const cut2 = evaluateBoard(parseBoard(['X.', '.X'])); // cuttingPointCounts -> { x: 2, o: 0 }
    const cut0 = evaluateBoard(parseBoard(['XX', '..'])); // cuttingPointCounts -> { x: 0, o: 0 }
    assert.equal(cut0 - cut2, 2 * EVAL.CUT);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/go-engine.test.ts"`
Expected: FAIL — `cuttingPointCounts` is not exported.

- [ ] **Step 3: Implement `cuttingPointCounts` and wire it into `evaluateBoard`**

**(a)** Add `CUT` to the `EVAL` constant. Replace:

```ts
export const EVAL = {
    STONE: 10,      // per stone on the board (area scoring)
    TERRITORY: 10,  // per controlled empty point — equal to a stone (true area scoring)
    ATARI: 12,      // per stone in a group with 1 liberty (treat as nearly lost)
    WEAK: 2,        // per stone in a group with 2 liberties (under pressure)
} as const;
```

with:

```ts
export const EVAL = {
    STONE: 10,      // per stone on the board (area scoring)
    TERRITORY: 10,  // per controlled empty point — equal to a stone (true area scoring)
    ATARI: 12,      // per stone in a group with 1 liberty (treat as nearly lost)
    WEAK: 2,        // per stone in a group with 2 liberties (under pressure)
    CUT: 6,         // per cutting point (empty point adjoining 2+ of one colour's groups)
} as const;
```

**(b)** Add `cuttingPointCounts` just above `evaluateBoard`:

```ts
/**
 * Count "cutting points" per colour: an empty point orthogonally adjacent to two
 * or more DISTINCT groups of the same colour — a spot where that colour is not
 * solidly connected (a hole the opponent can cut, or a link still to be made).
 * Builds a group-id map once, then scans empty points; computes both colours in
 * one pass.
 */
export const cuttingPointCounts = (grid: Grid): { x: number; o: number } => {
    const size = grid.length;
    const groupId: number[][] = grid.map((col) => col.map(() => -1));
    let nextId = 0;
    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (grid[x][y] === '.' || groupId[x][y] !== -1) continue;
            for (const [cx, cy] of groupAt(grid, x, y).cells) groupId[cx][cy] = nextId;
            nextId++;
        }
    }

    let x = 0;
    let o = 0;
    for (let px = 0; px < size; px++) {
        for (let py = 0; py < size; py++) {
            if (grid[px][py] !== '.') continue;
            const xs = new Set<number>();
            const os = new Set<number>();
            for (const [dx, dy] of DIRS) {
                const nx = px + dx;
                const ny = py + dy;
                if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
                const cell = grid[nx][ny];
                if (cell === 'X') xs.add(groupId[nx][ny]);
                else if (cell === 'O') os.add(groupId[nx][ny]);
            }
            if (xs.size >= 2) x++;
            if (os.size >= 2) o++;
        }
    }
    return { x, o };
};
```

**(c)** Fold it into `evaluateBoard`, just before the final `return value;`. Replace:

```ts
    return value;
};
```

with:

```ts
    // Connection/cut: penalise our own cutting points, reward the enemy's.
    const cuts = cuttingPointCounts(grid);
    value += -EVAL.CUT * cuts.x + EVAL.CUT * cuts.o;

    return value;
};
```

(Note: `evaluateBoard` has a single `return value;` at its end — that is the one to replace.)

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/**/*.test.ts" 2>&1 | grep -E "tests |pass |fail "`
Expected: all pass, 0 fail (including the existing "symmetric position evaluates to zero" tests — the cut term is antisymmetric, so they still hold).

- [ ] **Step 5: Commit**

```bash
git add src/utils/go-engine.ts test/go-engine.test.ts
git commit -m "feat: cutting-point eval term (value connection / cutting / holes)"
```

---

### Task 2: Cut bonus in move ordering

**Files:**
- Modify: `src/utils/go-engine.ts`
- Modify: `test/go-engine.test.ts`

**Interfaces:**
- Consumes: `shapeScore`, `groupAt`, `DIRS`, `SHAPE`.
- Produces: `SHAPE.CUT = 60`; `shapeScore` adds `+SHAPE.CUT` when the move is adjacent to ≥2 distinct enemy groups.

- [ ] **Step 1: Write the failing tests**

Add to `test/go-engine.test.ts`:

```ts
test('shapeScore: a wedge between two enemy groups (cut) is rewarded', () => {
    // (0,1) is adjacent to the two distinct O groups at (0,0) and (0,2).
    assert.equal(shapeScore(parseBoard(['O.O', '...', '...']), 0, 1, 'X'), SHAPE.CUT);
});

test('shapeScore: touching a single enemy group is not a cut', () => {
    // (0,1) adjoins only one enemy group; no cut bonus (and no other shape here).
    assert.equal(shapeScore(parseBoard(['O..', '...', '...']), 0, 1, 'X'), 0);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/go-engine.test.ts"`
Expected: FAIL — `SHAPE.CUT` is undefined (the wedge currently scores 0).

- [ ] **Step 3: Implement the cut bonus**

**(a)** Add `CUT` to the `SHAPE` constant. Replace:

```ts
export const SHAPE = {
    EMPTY_TRIANGLE: 50, // penalty: a bad-shaped (inefficient) connection
    CONNECT: 40,        // bonus: joins two of our groups
    HANE: 80,           // bonus: turns the corner around an enemy stone in contact
} as const;
```

with:

```ts
export const SHAPE = {
    EMPTY_TRIANGLE: 50, // penalty: a bad-shaped (inefficient) connection
    CONNECT: 40,        // bonus: joins two of our groups
    HANE: 80,           // bonus: turns the corner around an enemy stone in contact
    CUT: 60,            // bonus: wedges between two enemy groups (keeps them split)
} as const;
```

**(b)** In `shapeScore`, add the cut branch immediately after the connection block (after `if (ownGroups >= 2) score += SHAPE.CONNECT;`). Replace:

```ts
    if (ownGroups >= 2) score += SHAPE.CONNECT;

    // Hane: diagonal to an enemy stone while we touch one of the two shared cells
```

with:

```ts
    if (ownGroups >= 2) score += SHAPE.CONNECT;

    // Cut: the move wedges between >= 2 distinct enemy groups, keeping them split.
    const enemySeen = new Set<string>();
    let enemyGroups = 0;
    for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (at(nx, ny) !== enemy || enemySeen.has(`${nx},${ny}`)) continue;
        enemyGroups++;
        for (const [cx, cy] of groupAt(grid, nx, ny).cells) enemySeen.add(`${cx},${cy}`);
    }
    if (enemyGroups >= 2) score += SHAPE.CUT;

    // Hane: diagonal to an enemy stone while we touch one of the two shared cells
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/**/*.test.ts" 2>&1 | grep -E "tests |pass |fail "`
Expected: all pass, 0 fail (existing capture-ordering tests still hold — `SHAPE.CUT` 60 is far below the 1000 capture tier).

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "go-engine" || echo "engine clean"`
Expected: `engine clean`.

- [ ] **Step 6: Commit**

```bash
git add src/utils/go-engine.ts test/go-engine.test.ts
git commit -m "feat: SHAPE.CUT ordering bonus for wedge/cut moves"
```

- [ ] **Step 7: In-game verification (manual — for the human)**

1. `run go.js`; `tail go.js`.
2. Confirm the bot keeps its own groups connected (avoids leaving cutting points) and plays wedge/cut moves to split enemy groups.
3. Watch move latency (the eval now also runs `cuttingPointCounts` at every leaf). If it feels slow on the deep factions, lower `EVAL.CUT`/`SHAPE.CUT` or revisit — the term is isolated and easy to dial down.

---

## Notes for the executor

- `cuttingPointCounts` returns `{ x, o }` keyed by the board's `'X'`/`'O'` characters (X = us/black).
- The eval term is antisymmetric (`-CUT*x + CUT*o`), so the existing symmetric-position tests remain green.
- `go.ts` and `go-ladder.ts` are not touched.
