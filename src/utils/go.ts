import { NS } from '@ns';
import { Grid, selectMove } from './go-engine';
import {
    GoFaction,
    GAMES_PER_FACTION,
    chooseFaction,
    planGame,
} from './go-ladder';

const STOP_FILE = 'go-stop.txt';

/** @param {NS} ns */
export async function main(ns: NS) {
    ns.disableLog('ALL');

    while (!ns.fileExists(STOP_FILE, 'home')) {
        const stats = ns.go.analysis.getStats();
        const faction = chooseFaction(stats, GAMES_PER_FACTION);
        const { board, rootBranch, nodeBranch, depth } = planGame(faction);

        const started = ns.go.resetBoardState(faction, board);
        if (!started) {
            ns.print(`WARN could not start ${faction} on ${board}x${board}`);
            await ns.sleep(1000);
            continue;
        }

        let result;
        do {
            const move = await chooseMove(ns, depth, rootBranch, nodeBranch);
            if (move) result = await ns.go.makeMove(move[0], move[1]);
            else result = await ns.go.passTurn();
            await ns.go.opponentNextTurn();
        } while (result?.type !== 'gameOver');

        logGameResult(ns, faction, board, depth);
    }

    ns.tprint(`Go grinder stopped (found /${STOP_FILE}).`);
}

/**
 * Pick our move by mirroring the live board into a mutable grid and handing it to
 * the engine's bounded alpha-beta search at the faction's depth/branch widths.
 */
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
    return selectMove(grid, valid, depth, rootBranch, nodeBranch, Math.random, async () => {
        await ns.sleep(0);
    });
};

/** Log the finished game using the faction's persistent stats from analysis.getStats(). */
const logGameResult = (ns: NS, faction: GoFaction, board: number, depth: number) => {
    const s = ns.go.analysis.getStats()[faction];
    if (!s) return;
    const games = s.wins + s.losses;
    ns.print(
        `${faction} ${board}x${board} d${depth} | W:${s.wins} L:${s.losses} ` +
        `games:${games}/${GAMES_PER_FACTION} streak:${s.winStreak} bonus:${s.bonusPercent}%`,
    );
};
