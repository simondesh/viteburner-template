// Pure IPvGO rules + position-evaluation engine.
//
// Deliberately free of any NS / game dependency so it can be unit-tested in
// isolation (see go-engine.test.ts). The live script in go.ts wires these
// helpers to the real game board.

export type Grid = string[][];

export const DIRS: ReadonlyArray<readonly [number, number]> = [[1, 0], [-1, 0], [0, 1], [0, -1]];

// Search shape used by the bounded minimax below.
export const NODE_BRANCH = 6; // candidate moves considered at each interior node

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
 * Generate the legal moves for `color`, each with the resulting board, ordered
 * best-first. Ordering decides which moves the bounded search considers, so it
 * surfaces the tactically critical ones (captures, rescuing our groups from atari,
 * threatening the opponent) and buries self-atari.
 *
 * Two classes of move are excluded outright because they only ever shed our own
 * points / eye space, so when they are the only moves left the candidate list is
 * empty and we pass instead of self-destructing:
 *   1. filling our own secure (fully enclosed) territory, and
 *   2. "deep self-fills": empty points well inside our own sphere of influence
 *      that neither touch the enemy nor rescue one of our groups. These are the
 *      blank points the bot is meant to keep — playing them collapses eye space
 *      and shortens our own liberties for no compensating gain, even when a lone
 *      invader leaves the surrounding region technically "contested".
 */
export const orderedMoves = (grid: Grid, color: string) => {
    const size = grid.length;
    const enemy = color === 'X' ? 'O' : 'X';
    const ownTerritory = secureTerritoryMask(grid, color);
    const distOwn = floodDistances(grid, color);
    const distEnemy = floodDistances(grid, enemy);
    const candidates: { x: number; y: number; grid: Grid; ord: number }[] = [];

    for (let x = 0; x < size; x++) {
        for (let y = 0; y < size; y++) {
            if (grid[x][y] !== '.') continue;
            if (ownTerritory[x][y]) continue; // never fill our own secure territory / eyes

            // Inspect the original board around this point for tactical context.
            let touchesEnemy = false;  // adjoins an enemy stone (capture / atari / reduction)
            let rescued = 0;           // our own stones currently in atari that this move adjoins
            let threatened = 0;        // enemy stones we'd push to a single liberty
            for (const [dx, dy] of DIRS) {
                const nx = x + dx;
                const ny = y + dy;
                if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
                const cell = grid[nx][ny];
                if (cell === color) {
                    const g = groupAt(grid, nx, ny);
                    if (g.liberties === 1) rescued += g.cells.length;
                } else if (cell === enemy) {
                    touchesEnemy = true;
                    const g = groupAt(grid, nx, ny);
                    if (g.liberties === 2) threatened += g.cells.length;
                }
            }

            // Keep blank points inside our own territory: clearly our influence,
            // no enemy contact, not rescuing a group of ours.
            const margin = distEnemy[x][y] - distOwn[x][y];
            if (!touchesEnemy && rescued === 0 && distOwn[x][y] < Infinity && margin >= 2) continue;

            const played = playStone(grid, x, y, color);
            if (played === null) continue; // illegal (suicide)

            const own = groupAt(played.grid, x, y); // liberties already reflect captures
            let ord = played.captured * 1000 + own.liberties * 5;

            if (rescued > 0 && own.liberties > 1) ord += 500 + rescued * 50; // genuine escape
            if (threatened > 0) ord += 300 + threatened * 30;                // atari threat
            if (played.captured === 0 && own.liberties === 1) ord -= 10000;  // self-atari (last resort)

            candidates.push({ x, y, grid: played.grid, ord });
        }
    }

    candidates.sort((a, b) => b.ord - a.ord);
    return candidates;
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
 * Alpha-beta minimax. Returns the evaluated value (black-positive) of best play
 * from this position with `toMove` to play. Black ('X', us) maximises.
 */
export const search = (grid: Grid, toMove: string, depth: number, alpha: number, beta: number): number => {
    if (depth === 0) return evaluateBoard(grid);

    const moves = orderedMoves(grid, toMove).slice(0, NODE_BRANCH);
    if (moves.length === 0) return evaluateBoard(grid); // no play available — stand pat

    if (toMove === 'X') {
        let best = -Infinity;
        for (const m of moves) {
            best = Math.max(best, search(m.grid, 'O', depth - 1, alpha, beta));
            alpha = Math.max(alpha, best);
            if (alpha >= beta) break; // opponent won't allow this line
        }
        return best;
    }

    let best = Infinity;
    for (const m of moves) {
        best = Math.min(best, search(m.grid, 'X', depth - 1, alpha, beta));
        beta = Math.min(beta, best);
        if (alpha >= beta) break; // we won't allow this line
    }
    return best;
};

/**
 * Choose our ('X') move for a position: order our legal moves, search each, and
 * return the best — or null to pass.
 *
 * Pass policy: we decline to play when no candidate improves on simply passing
 * (`bestValue <= passValue`). This is intentionally NOT gated on being ahead.
 * The earlier design only banked the position when already winning, which both
 * (a) forced self-harming moves whenever we were behind, and (b) never actually
 * fired once the evaluation stopped over-valuing self-fills. Under area scoring
 * every genuine point (a capture, a dame, a reduction) still makes bestValue
 * exceed passValue, so the bot keeps playing while profitable moves remain and
 * only passes when the board is settled — regardless of the score.
 *
 * `validMoves` is the game's own legality grid (which also encodes ko); `rng`
 * is injectable so tie-break jitter is deterministic in tests.
 */
export const selectMove = (
    grid: Grid,
    validMoves: boolean[][],
    depth: number,
    rootBranch: number,
    rng: () => number = Math.random,
): [number, number] | null => {
    const roots = orderedMoves(grid, 'X')
        .filter((m) => validMoves[m.x]?.[m.y] === true)
        .slice(0, rootBranch);

    if (roots.length === 0) return null;

    let best: [number, number] | null = null;
    let bestValue = -Infinity;
    let bestJittered = -Infinity;
    for (const m of roots) {
        const value = search(m.grid, 'O', depth - 1, -Infinity, Infinity);
        // Jitter only breaks ties; it never overrides a real difference.
        const jittered = value + rng() * 0.01;
        if (jittered > bestJittered) {
            bestJittered = jittered;
            bestValue = value;
            best = [m.x, m.y];
        }
    }

    const passValue = search(grid, 'O', depth - 1, -Infinity, Infinity);
    if (bestValue <= passValue) return null;

    return best;
};

// ---------------------------------------------------------------------------
// Test helpers.
// ---------------------------------------------------------------------------

/** Build a Grid from an array of equal-length row strings (chars: 'X', 'O', '.'). */
export const parseBoard = (rows: string[]): Grid => rows.map((row) => row.split(''));
