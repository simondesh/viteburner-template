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
