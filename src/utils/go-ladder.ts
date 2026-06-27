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

/** Stats used for progression: a faction is "played out" after wins + losses games. */
export interface FactionStat {
    wins: number;
    losses: number;
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

export const SEARCH_DEPTH = 4;          // base (even) depth; harder factions go deeper
export const GAMES_PER_FACTION = 100;   // games (wins+losses) before advancing a faction
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
