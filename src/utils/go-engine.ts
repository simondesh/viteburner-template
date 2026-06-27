// Pure IPvGO rules + position-evaluation engine.
//
// Deliberately free of any NS / game dependency so it can be unit-tested in
// isolation (see go-engine.test.ts). The live script in go.ts wires these
// helpers to the real game board.

export type Grid = string[][];

export const DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

export const POOL_MIN = 16;     // candidates expanded per node before taking the beam
export const TIE_EPSILON = 0.5; // jitter-preserving slack on the root alpha window

// Static position-evaluation weights, from black's (our) perspective.
export const EVAL = {
    STONE: 10,      // per stone on the board (area scoring)
    TERRITORY: 12,  // per empty point controlled by a single colour
    ATARI: 12,      // per stone in a group with 1 liberty (treat as nearly lost)
    WEAK: 2,        // per stone in a group with 2 liberties (under pressure)
} as const;

// ---------------------------------------------------------------------------
// Go rules engine (pure functions over a grid).
// ---------------------------------------------------------------------------

export const cloneGrid = (grid: Grid): Grid => grid.map((col) => col.slice());

/** The connected group of same-coloured stones at (x, y), with its liberty count. */
export const groupAt = (grid: Grid, x: number, y: number): { cells: [number, number][]; liberties: number } => {
    const size = grid.length;
    const color = grid[x][y];
    const cells: [number, number][] = [];
    const liberties = new Set<string>();
    const seen = new Set<string>([`${x},${y}`]);
    const stack: [number, number][] = [[x, y]];

    while (stack.length) {
        const [cx, cy] = stack.pop() as [number, number];
        cells.push([cx, cy]);
        for (const [dx, dy] of DIRS) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            const cell = grid[nx][ny];
            if (cell === '.') {
                liberties.add(`${nx},${ny}`);
            } else if (cell === color) {
                const key = `${nx},${ny}`;
                if (!seen.has(key)) {
                    seen.add(key);
                    stack.push([nx, ny]);
                }
            }
        }
    }
    return { cells, liberties: liberties.size };
};

/**
 * Play `color` at (x, y) on a copy of the grid: remove any enemy groups left
 * with no liberties, then reject the move if our own group has no liberties
 * (suicide). Returns the new grid and the number of stones captured, or null
 * if the move is illegal.
 */
export const playStone = (grid: Grid, x: number, y: number, color: string): { grid: Grid; captured: number } | null => {
    if (grid[x][y] !== '.') return null;
    const size = grid.length;
    const next = cloneGrid(grid);
    next[x][y] = color;
    const enemy = color === 'X' ? 'O' : 'X';

    let captured = 0;
    for (const [dx, dy] of DIRS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        if (next[nx][ny] === enemy) {
            const group = groupAt(next, nx, ny);
            if (group.liberties === 0) {
                for (const [cx, cy] of group.cells) {
                    next[cx][cy] = '.';
                    captured++;
                }
            }
        }
    }

    if (groupAt(next, x, y).liberties === 0) return null; // suicide
    return { grid: next, captured };
};

/**
 * Distance, for every empty point, to the nearest `color` stone measured by
 * flooding through empty space only (stones of either colour block the flood).
 * `color` stones are distance 0; empty points the colour cannot reach stay
 * Infinity. This "influence" primitive lets us attribute an empty point to
 * whichever colour can reach it first, instead of the brittle all-or-nothing
 * "region bordered by exactly one colour" test.
 */
export const floodDistances = (grid: Grid, color: string): number[][] => {
    const size = grid.length;
    const dist: number[][] = grid.map((col) => col.map(() => Infinity as number));
    const queue: [number, number][] = [];

    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (grid[x][y] === color) { dist[x][y] = 0; queue.push([x, y]); }
        }
    }

    let head = 0;
    while (head < queue.length) {
        const [cx, cy] = queue[head++];
        for (const [dx, dy] of DIRS) {
            const nx = cx + dx;
            const ny = cy + dy;
            if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
            if (grid[nx][ny] === '.' && dist[nx][ny] === Infinity) {
                dist[nx][ny] = dist[cx][cy] + 1;
                queue.push([nx, ny]);
            }
        }
    }
    return dist;
};

/**
 * Mark every empty point that lies in a region bordered *only* by `color`'s
 * stones — i.e. that colour's secure territory (which includes its eyes). Such
 * points already count as that side's score under area scoring, so filling them
 * only sheds points and eye space. Regions touching the opponent are contested
 * and are NOT marked, so the bot can still respond to invasions.
 */
export const secureTerritoryMask = (grid: Grid, color: string): boolean[][] => {
    const size = grid.length;
    const mask: boolean[][] = grid.map((col) => col.map(() => false));
    const seen: boolean[][] = grid.map((col) => col.map(() => false));

    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (grid[x][y] !== '.' || seen[x][y]) continue;

            const region: [number, number][] = [];
            const borders = new Set<string>();
            const stack: [number, number][] = [[x, y]];
            seen[x][y] = true;
            while (stack.length) {
                const [cx, cy] = stack.pop() as [number, number];
                region.push([cx, cy]);
                for (const [dx, dy] of DIRS) {
                    const nx = cx + dx;
                    const ny = cy + dy;
                    if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
                    const cell = grid[nx][ny];
                    if (cell === '.') {
                        if (!seen[nx][ny]) { seen[nx][ny] = true; stack.push([nx, ny]); }
                    } else if (cell === 'X' || cell === 'O') {
                        borders.add(cell);
                    }
                }
            }

            const ours = borders.size === 1 && borders.has(color);
            if (ours) for (const [cx, cy] of region) mask[cx][cy] = true;
        }
    }
    return mask;
};

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

/**
 * Static evaluation of a position, black-positive. Area scoring with safety:
 *   + stones on the board
 *   + empty points controlled by a single colour (territory, by influence)
 *   - groups in atari / under pressure (likely losses on the horizon)
 *
 * Territory is attributed per point to whichever colour can reach it first
 * through empty space (floodDistances), rather than the all-or-nothing "region
 * bordered by exactly one colour" test. That earlier test scored any region
 * touching both colours at zero, which made dropping a stone into our own
 * (merely contested) territory look like a free +STONE — the root cause of the
 * bot filling its own blank points. With per-point influence, converting a
 * point we already control into a stone correctly reads as a small loss
 * (shed TERRITORY, gain the smaller STONE).
 */
export const evaluateBoard = (grid: Grid): number => {
    const size = grid.length;
    let value = 0;

    // Stones and group safety.
    const visited: boolean[][] = grid.map((col) => col.map(() => false));
    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            const cell = grid[x][y];
            if ((cell === 'X' || cell === 'O') && !visited[x][y]) {
                const group = groupAt(grid, x, y);
                for (const [cx, cy] of group.cells) visited[cx][cy] = true;

                let groupValue = group.cells.length * EVAL.STONE;
                if (group.liberties === 1) groupValue -= group.cells.length * EVAL.ATARI;
                else if (group.liberties === 2) groupValue -= group.cells.length * EVAL.WEAK;

                value += (cell === 'X' ? 1 : -1) * groupValue;
            }
        }
    }

    // Territory by influence: each empty point goes to the colour that can reach
    // it first through empty space; equidistant / unreachable-by-both = neutral.
    const distX = floodDistances(grid, 'X');
    const distO = floodDistances(grid, 'O');
    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (grid[x][y] !== '.') continue;
            const dx = distX[x][y];
            const dox = distO[x][y];
            if (dx < dox) value += EVAL.TERRITORY;
            else if (dox < dx) value -= EVAL.TERRITORY;
        }
    }

    return value;
};

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

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

/** Build a Grid from an array of equal-length row strings (chars: 'X', 'O', '.'). */
export const parseBoard = (rows: string[]): Grid => rows.map((row) => row.split(''));
