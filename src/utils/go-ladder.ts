// Pure faction-ladder + search policy for the Go grinder. No NS dependency,
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
    //'????????????',
];

export const SEARCH_DEPTH = 4;        // base (even) depth; harder factions go deeper
export const GAMES_PER_FACTION = 50; // games (wins+losses) before advancing a faction
export const FIXED_BOARD: BoardSize = 7; // every faction plays on a 7x7 board

// Beam widths by board size. Wide on small boards (search broadly, never prune a
// tactic); narrow only where breadth is genuinely unaffordable.
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

/** Search depth by faction difficulty (always even). Harder factions search deeper. */
export const depthForFaction = (faction: GoFaction): number => {
    if (faction === '????????????' || faction === 'Illuminati') return 10;
    if (faction === 'Daedalus') return 8;
    return SEARCH_DEPTH;
};

// Deep-search factions use a narrow beam so the deeper search stays affordable
// (cost grows as beam^depth). Illuminati is the top faction we actually play, so
// it gets the deepest search on the narrowest beam. Easy factions fall back to
// the wide 7x7 beam.
const DEEP_BEAMS: Partial<Record<GoFaction, BranchWidths>> = {
    Daedalus: { rootBranch: 8, nodeBranch: 4 },
    Illuminati: { rootBranch: 6, nodeBranch: 3 },
    '????????????': { rootBranch: 6, nodeBranch: 3 },
};

export interface GamePlan {
    board: BoardSize;
    rootBranch: number;
    nodeBranch: number;
    depth: number;
}

/**
 * Resolve the per-game plan for a faction: always the fixed 7x7 board, the
 * faction's search depth, and a beam that is narrow for deep factions and wide
 * for the easy ones.
 */
export const planGame = (faction: GoFaction): GamePlan => {
    const depth = depthForFaction(faction);
    const { rootBranch, nodeBranch } = DEEP_BEAMS[faction] ?? branchForBoard(FIXED_BOARD);
    return { board: FIXED_BOARD, rootBranch, nodeBranch, depth };
};
