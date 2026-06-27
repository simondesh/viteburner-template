# Sharper Go Eval/Shapes/Tactics/Depth Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make the Go bot stronger in one pass — correct area-scoring eval, less-noisy influence, shape-aware and offense/defense-aware move ordering, and deeper-but-affordable search.

**Architecture:** All changes are in the pure `go-engine.ts` (eval, ordering, constants) and `go-ladder.ts` (per-faction depth). The engine is already wired into `go.ts`; no driver changes.

**Tech Stack:** TypeScript, Bitburner (modded) NS API, viteburner, Node 26 `node --test`.

## Global Constraints

- `go-engine.ts` and `go-ladder.ts` MUST NOT import `@ns` or reference `ns.*` (pure modules).
- Tests live in top-level `test/` and import source with an explicit `.ts` extension; run with `node --test "test/**/*.test.ts"`.
- Exact values: `EVAL.TERRITORY = 10` (== `EVAL.STONE`); `INFLUENCE_MARGIN = 2`; `POOL_MIN = 8`; `SHAPE = { EMPTY_TRIANGLE: 50, CONNECT: 40, HANE: 80 }`; `TACTIC = { ATARI_THREAT: 400, DEFEND_WEAK: 150 }`; depth Daedalus/Illuminati = 8, `????????????` = 10, easy = 4.
- Shape/tactical bonuses must stay BELOW the capture tier (1000) so a capture always outranks them.
- `go.ts` is NOT modified.
- Commit after every task. Work on branch `feat/go-sharper-eval` (already checked out); do NOT create a new branch.

---

### Task 1: Eval — true area scoring + influence margin (R1, R2)

**Files:**
- Modify: `src/utils/go-engine.ts`
- Modify: `test/go-engine.test.ts`

**Interfaces:**
- Consumes: existing `evaluateBoard`, `EVAL`, `floodDistances`, `parseBoard`, `playStone`.
- Produces: `EVAL.TERRITORY === 10`; new export `INFLUENCE_MARGIN = 2`; `evaluateBoard` credits territory only on a clear lead.

- [ ] **Step 1: Write the failing tests**

Add to `test/go-engine.test.ts` (and add `EVAL` and `INFLUENCE_MARGIN` to the existing import from `'../src/utils/go-engine.ts'`):

```ts
test('stone and territory are weighted equally (true area scoring)', () => {
    assert.equal(EVAL.STONE, EVAL.TERRITORY);
    assert.equal(INFLUENCE_MARGIN, 2);
});

test('a symmetric position evaluates to zero', () => {
    assert.equal(evaluateBoard(parseBoard(['X...O'])), 0);
    assert.equal(evaluateBoard(parseBoard(['XX...OO'])), 0);
});

test('a one-colour-enclosed region still counts as territory under the margin', () => {
    assert.ok(evaluateBoard(parseBoard(['XXX', 'X.X', 'XXX'])) > 0);
});

test('filling our own settled territory is not a gain', () => {
    const before = parseBoard(ENCLOSED);
    const played = playStone(before, 1, 1, 'X');
    assert.ok(played);
    assert.ok(
        evaluateBoard(played!.grid) <= evaluateBoard(before),
        'filling own territory must not increase value',
    );
});
```

(Delete the old `test('filling our own enclosed territory is not net-positive', ...)` — it asserted a strict loss from the −2 hack and is replaced by the `<=` test above.)

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/go-engine.test.ts"`
Expected: FAIL — `INFLUENCE_MARGIN` not exported, and `EVAL.STONE !== EVAL.TERRITORY` (12 ≠ 10).

- [ ] **Step 3: Apply the go-engine.ts edits**

**(a)** Set `EVAL.TERRITORY` to 10 and add `INFLUENCE_MARGIN`. Replace:

```ts
export const EVAL = {
    STONE: 10,      // per stone on the board (area scoring)
    TERRITORY: 12,  // per empty point controlled by a single colour
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
} as const;

// A point only counts as territory when one colour reaches it at least this many
// steps sooner than the other — so "territory" means clear control, not noise.
export const INFLUENCE_MARGIN = 2;
```

**(b)** In `evaluateBoard`, replace the territory-credit lines:

```ts
            if (dx < dox) value += EVAL.TERRITORY;
            else if (dox < dx) value -= EVAL.TERRITORY;
```

with:

```ts
            if (dx + INFLUENCE_MARGIN <= dox) value += EVAL.TERRITORY;
            else if (dox + INFLUENCE_MARGIN <= dx) value -= EVAL.TERRITORY;
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/**/*.test.ts" 2>&1 | grep -E "tests |pass |fail "`
Expected: all pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/utils/go-engine.ts test/go-engine.test.ts
git commit -m "feat: true area-scoring eval (STONE==TERRITORY) + influence margin"
```

---

### Task 2: Shape-aware ordering (R3)

**Files:**
- Modify: `src/utils/go-engine.ts`
- Modify: `test/go-engine.test.ts`

**Interfaces:**
- Consumes: `groupAt`, `DIRS`, `Grid`, `parseBoard`.
- Produces: `SHAPE = { EMPTY_TRIANGLE: 50, CONNECT: 40, HANE: 80 }`; `shapeScore(grid, x, y, color): number`; `shapeScore` added into `rankMoves` score and `expandMove` ord.

- [ ] **Step 1: Write the failing tests**

Add to `test/go-engine.test.ts` (add `SHAPE` and `shapeScore` to the import):

```ts
test('shapeScore: a straight connection of two groups is rewarded', () => {
    // Playing the middle of X.X joins two distinct one-stone groups in a straight line.
    assert.equal(shapeScore(parseBoard(['X.X']), 0, 1, 'X'), SHAPE.CONNECT);
});

test('shapeScore: an empty triangle is penalised (bad-shaped connection)', () => {
    // Playing (1,1) joins the two diagonal stones but forms an empty triangle
    // (corner (0,0) empty): CONNECT - EMPTY_TRIANGLE, net negative.
    assert.equal(shapeScore(parseBoard(['.X', 'X.']), 1, 1, 'X'), SHAPE.CONNECT - SHAPE.EMPTY_TRIANGLE);
});

test('shapeScore: a hane turning around an enemy stone in contact is rewarded', () => {
    // (1,1) is diagonal to the enemy at (0,0) and shares the own stone at (1,0).
    assert.equal(shapeScore(parseBoard(['O.', 'X.']), 1, 1, 'X'), SHAPE.HANE);
});

test('shapeScore: a plain move with no neighbours scores zero', () => {
    assert.equal(shapeScore(parseBoard(['..', '..']), 0, 0, 'X'), 0);
});

test('shapeScore is folded into expandMove ord', () => {
    // (0,1) connects the two X groups in a straight line (+CONNECT). The own group
    // then has 3 liberties, so the tactical base is only 3*5=15 — the ord clearing
    // SHAPE.CONNECT proves the shape bonus was added.
    const e = expandMove(parseBoard(['X.X', '...']), 0, 1, 'X');
    assert.ok(e);
    assert.ok(e!.ord >= SHAPE.CONNECT, `connection shape bonus should be in ord, got ${e!.ord}`);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/go-engine.test.ts"`
Expected: FAIL — `shapeScore`/`SHAPE` not exported.

- [ ] **Step 3: Implement `shapeScore` and fold it in**

**(a)** Add the `SHAPE` constant next to `POOL_MIN`/`TIE_EPSILON`:

```ts
export const SHAPE = {
    EMPTY_TRIANGLE: 50, // penalty: a bad-shaped (inefficient) connection
    CONNECT: 40,        // bonus: joins two of our groups
    HANE: 80,           // bonus: turns the corner around an enemy stone in contact
} as const;
```

**(b)** Add `shapeScore` (place it just above `rankMoves`):

```ts
/**
 * Local shape quality of playing `color` at (x, y), from the original board (no
 * stone is played). Rewards good shape (connecting two groups; a hane that turns
 * around an enemy stone we already touch) and penalises the empty triangle (a
 * bad-shaped connection: two perpendicular own neighbours with an empty diagonal
 * corner). Used to bias both the candidate ranking and the beam ordering.
 */
export const shapeScore = (grid: Grid, x: number, y: number, color: string): number => {
    const size = grid.length;
    const enemy = color === 'X' ? 'O' : 'X';
    const at = (a: number, b: number): string | null =>
        a < 0 || b < 0 || a >= size || b >= size ? null : grid[a][b];
    const diagonals: [number, number][] = [[1, 1], [1, -1], [-1, 1], [-1, -1]];
    let score = 0;

    // Empty triangle: move + two perpendicular own neighbours, empty diagonal corner.
    for (const [dx, dy] of diagonals) {
        if (at(x + dx, y) === color && at(x, y + dy) === color && at(x + dx, y + dy) === '.') {
            score -= SHAPE.EMPTY_TRIANGLE;
        }
    }

    // Connection: the move joins >= 2 distinct own groups.
    const seen = new Set<string>();
    let ownGroups = 0;
    for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (at(nx, ny) !== color || seen.has(`${nx},${ny}`)) continue;
        ownGroups++;
        for (const [cx, cy] of groupAt(grid, nx, ny).cells) seen.add(`${cx},${cy}`);
    }
    if (ownGroups >= 2) score += SHAPE.CONNECT;

    // Hane: diagonal to an enemy stone while we touch one of the two shared cells
    // (turning the corner around an enemy in contact).
    for (const [dx, dy] of diagonals) {
        if (at(x + dx, y + dy) !== enemy) continue;
        if (at(x + dx, y) === color || at(x, y + dy) === color) {
            score += SHAPE.HANE;
            break;
        }
    }

    return score;
};
```

**(c)** Fold into `rankMoves`: add the shape term to the score. Replace:

```ts
            let score = adjEmpty;
            if (captures > 0) score += 1000 + captures * 100;
            if (threatened > 0) score += 300 + threatened * 30;
            if (rescued > 0) score += 200 + rescued * 50;
            if (touchesEnemy) score += 50;

            out.push({ x, y, score });
```

with:

```ts
            let score = adjEmpty;
            if (captures > 0) score += 1000 + captures * 100;
            if (threatened > 0) score += 300 + threatened * 30;
            if (rescued > 0) score += 200 + rescued * 50;
            if (touchesEnemy) score += 50;
            score += shapeScore(grid, x, y, color);

            out.push({ x, y, score });
```

**(d)** Fold into `expandMove`: add the shape term to `ord` just before the return. Replace:

```ts
    if (played.captured === 0 && own.liberties === 1) ord -= 10000;

    return { grid: played.grid, ord };
```

with:

```ts
    if (played.captured === 0 && own.liberties === 1) ord -= 10000;
    ord += shapeScore(grid, x, y, color);

    return { grid: played.grid, ord };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/**/*.test.ts" 2>&1 | grep -E "tests |pass |fail "`
Expected: all pass, 0 fail (including the existing capture-ordering test — a capture still outranks any shape bonus).

- [ ] **Step 5: Commit**

```bash
git add src/utils/go-engine.ts test/go-engine.test.ts
git commit -m "feat: shape-aware move ordering (empty triangle, connection, hane)"
```

---

### Task 3: Offense/defense ordering (R4)

**Files:**
- Modify: `src/utils/go-engine.ts`
- Modify: `test/go-engine.test.ts`

**Interfaces:**
- Consumes: `expandMove` (Task 2 version), `groupAt`, `DIRS`, `playStone`.
- Produces: `TACTIC = { ATARI_THREAT: 400, DEFEND_WEAK: 150 }`; `expandMove` `ord` rewards putting an enemy group in atari and lifting a weak own group to safety.

- [ ] **Step 1: Write the failing tests**

Add to `test/go-engine.test.ts` (add `TACTIC` to the import):

```ts
test('expandMove rewards putting an enemy group in atari (offense)', () => {
    // O at (1,1) has 2 liberties; playing X (1,2) leaves it with 1 (atari, not captured).
    const e = expandMove(parseBoard(['.X.', 'XO.', '...']), 1, 2, 'X');
    assert.ok(e);
    assert.ok(e!.ord >= TACTIC.ATARI_THREAT, `atari threat should be scored, got ${e!.ord}`);
});

test('expandMove rewards lifting a weak (2-liberty) own group to safety (defense)', () => {
    // X (0,0) has 2 liberties; playing X (0,1) raises the group to 3 liberties.
    const e = expandMove(parseBoard(['X..', '...', '...']), 0, 1, 'X');
    assert.ok(e);
    assert.ok(e!.ord >= TACTIC.DEFEND_WEAK, `defense should be scored, got ${e!.ord}`);
});
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/go-engine.test.ts"`
Expected: FAIL — `TACTIC` not exported / ord below the thresholds.

- [ ] **Step 3: Implement R4 in `expandMove`**

**(a)** Add the `TACTIC` constant next to `SHAPE`:

```ts
export const TACTIC = {
    ATARI_THREAT: 400, // a move that puts an adjacent enemy group in atari
    DEFEND_WEAK: 150,  // a move that lifts a 2-liberty own group out of danger
} as const;
```

**(b)** In `expandMove`, track weak (2-liberty) own neighbours in the pre-move scan. Replace:

```ts
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
```

with:

```ts
    let rescued = 0;
    let threatened = 0;
    let weakOwn = 0; // our adjacent groups at 2 liberties (in danger) before the move
    for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const cell = grid[nx][ny];
        if (cell === color) {
            const g = groupAt(grid, nx, ny);
            if (g.liberties === 1) rescued += g.cells.length;
            else if (g.liberties === 2) weakOwn += g.cells.length;
        } else if (cell === enemy) {
            const g = groupAt(grid, nx, ny);
            if (g.liberties === 2) threatened += g.cells.length;
        }
    }
```

**(c)** After `const own = groupAt(played.grid, x, y);` and the existing ord lines, add the offense/defense terms. Replace:

```ts
    if (played.captured === 0 && own.liberties === 1) ord -= 10000;
    ord += shapeScore(grid, x, y, color);

    return { grid: played.grid, ord };
```

with:

```ts
    if (played.captured === 0 && own.liberties === 1) ord -= 10000;
    ord += shapeScore(grid, x, y, color);

    // Defense: this move lifted a weak (2-liberty) own group to safety.
    if (weakOwn > 0 && own.liberties > 2) ord += TACTIC.DEFEND_WEAK;

    // Offense: any adjacent enemy group left in atari (1 liberty, not captured).
    const atariSeen = new Set<string>();
    for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        if (played.grid[nx][ny] !== enemy || atariSeen.has(`${nx},${ny}`)) continue;
        const g = groupAt(played.grid, nx, ny);
        for (const [cx, cy] of g.cells) atariSeen.add(`${cx},${cy}`);
        if (g.liberties === 1) ord += TACTIC.ATARI_THREAT;
    }

    return { grid: played.grid, ord };
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/**/*.test.ts" 2>&1 | grep -E "tests |pass |fail "`
Expected: all pass, 0 fail.

- [ ] **Step 5: Commit**

```bash
git add src/utils/go-engine.ts test/go-engine.test.ts
git commit -m "feat: offense/defense move ordering (atari threat, defend weak group)"
```

---

### Task 4: Deeper, affordable search — depth bump + POOL_MIN

**Files:**
- Modify: `src/utils/go-ladder.ts`
- Modify: `src/utils/go-engine.ts`
- Modify: `test/go-ladder.test.ts`

**Interfaces:**
- Consumes: `depthForFaction`, `planGame` (go-ladder); `POOL_MIN` (go-engine).
- Produces: deeper hard-faction depths; smaller per-node expansion pool.

- [ ] **Step 1: Write the failing test**

Replace the `depthForFaction` test in `test/go-ladder.test.ts`:

```ts
test('depthForFaction deepens for harder factions and is always even', () => {
    assert.equal(depthForFaction('Netburners'), 4);
    assert.equal(depthForFaction('Tetrads'), 4);
    assert.equal(depthForFaction('Daedalus'), 6);
    assert.equal(depthForFaction('Illuminati'), 6);
    assert.equal(depthForFaction('????????????'), 8);
    for (const f of FACTION_LADDER) assert.equal(depthForFaction(f) % 2, 0);
});
```

with:

```ts
test('depthForFaction deepens for harder factions and is always even', () => {
    assert.equal(depthForFaction('Netburners'), 4);
    assert.equal(depthForFaction('Tetrads'), 4);
    assert.equal(depthForFaction('Daedalus'), 8);
    assert.equal(depthForFaction('Illuminati'), 8);
    assert.equal(depthForFaction('????????????'), 10);
    for (const f of FACTION_LADDER) assert.equal(depthForFaction(f) % 2, 0);
});
```

- [ ] **Step 2: Run the test to verify it fails**

Run: `node --test "test/go-ladder.test.ts"`
Expected: FAIL — Daedalus is 6, not 8.

- [ ] **Step 3: Apply the edits**

**(a)** In `src/utils/go-ladder.ts`, replace `depthForFaction`:

```ts
export const depthForFaction = (faction: GoFaction): number => {
    if (faction === '????????????') return 8;
    if (faction === 'Daedalus' || faction === 'Illuminati') return 6;
    return SEARCH_DEPTH;
};
```

with:

```ts
export const depthForFaction = (faction: GoFaction): number => {
    if (faction === '????????????') return 10;
    if (faction === 'Daedalus' || faction === 'Illuminati') return 8;
    return SEARCH_DEPTH;
};
```

**(b)** In `src/utils/go-engine.ts`, lower `POOL_MIN`:

```ts
export const POOL_MIN = 16;     // candidates expanded per node before taking the beam
```

to:

```ts
export const POOL_MIN = 8;      // candidates expanded per node before taking the beam
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/**/*.test.ts" 2>&1 | grep -E "tests |pass |fail "`
Expected: all pass, 0 fail. (The deep-faction invariant test still holds — depths only increased, beams unchanged.)

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "go-engine|go-ladder|go\.ts" || echo "go files clean"`
Expected: `go files clean`.

- [ ] **Step 6: Commit**

```bash
git add src/utils/go-ladder.ts src/utils/go-engine.ts test/go-ladder.test.ts
git commit -m "feat: deeper hard-faction search (D/I 8, ???? 10) + POOL_MIN 8"
```

- [ ] **Step 7: In-game verification (manual — for the human)**

1. `run go.js` on home; `tail go.js`.
2. Confirm the bot plays visibly better shapes (fewer empty triangles), presses ataris, and defends weak groups.
3. Watch move latency on Daedalus/Illuminati (depth 8, 7×7) and especially `????????????` (depth 10, 7×7). If a config is too slow, drop that faction's depth by 2 in `go-ladder.ts` (the beam is already narrow, so depth is the lever).

---

## Notes for the executor

- `go-engine.ts` is the only engine file; `go.ts` already passes per-faction depth/branch and needs no change.
- The hane predicate is the simplified "turn around an enemy stone in contact" (diagonal-to-enemy + shared own stone), not the literal "head of two" — robust and testable; the offensive intent is preserved.
- Shape/tactical bonuses are tunable constants (`SHAPE`, `TACTIC`); adjust after in-game testing.
- The empty-triangle penalty (50) deliberately exceeds the connection bonus (40) so a bad-shaped (L) connection nets negative while a straight connection stays positive.
