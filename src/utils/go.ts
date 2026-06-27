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
        const stats = ns.go.getStats();
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
    const s = ns.go.getStats()[faction];
    if (!s) return;
    ns.print(
        `${faction} ${board}x${board} | W:${s.wins} L:${s.losses} ` +
        `streak:${s.winStreak} (best ${s.highestWinStreak}/${STREAK_TARGET}) bonus:${s.bonusPercent}%`,
    );
};
