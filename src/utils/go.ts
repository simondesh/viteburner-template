import { NS } from '@ns';
import { Grid, selectMove } from './go-engine';

const OPPONENT = "Daedalus";
const BOARD_SIZE = 7;

// Search shape. DEPTH counts plies (our move, their reply, our reply, ...).
// Branching is capped per node so the tree stays affordable on a full board.
const SEARCH_DEPTH = 3;
const ROOT_BRANCH = 12; // candidate moves considered at the root

/** @param {NS} ns */
export async function main(ns: NS) {
    // Kill switch: create /go-stop.txt on home to stop the grinder cleanly.
    const STOP_FILE = "go-stop.txt";

    while (!ns.fileExists(STOP_FILE, "home")) {

        ns.go.resetBoardState(OPPONENT, BOARD_SIZE);

        let result;
        do {
            const move = chooseMove(ns);

            if (move) {
                result = await ns.go.makeMove(move[0], move[1]);
            } else {
                result = await ns.go.passTurn();
            }

            await ns.go.opponentNextTurn();
        } while (result?.type !== "gameOver");

        logGameResult(ns);
    }

    ns.tprint(`Go grinder stopped (found /${STOP_FILE}).`);
}

// ---------------------------------------------------------------------------
// Move selection: alpha-beta search over a self-simulated board.
// ---------------------------------------------------------------------------

/**
 * Pick our move by searching SEARCH_DEPTH plies ahead.
 *
 * The real game gives no board-simulation API, so we mirror the current board
 * into a mutable grid and hand the position to the engine, which applies Go
 * rules itself (place, capture, suicide) over a bounded alpha-beta search.
 * Legality of the *actual* move we play is still confirmed against the game's
 * getValidMoves (which also handles ko); deeper plies use our own suicide rule.
 *
 * @param {NS} ns
 * @returns {[number, number] | null} the move, or null to pass
 */
const chooseMove = (ns: NS): [number, number] | null => {
    const board = ns.go.getBoardState();
    const validMoves = ns.go.analysis.getValidMoves();
    const size = board[0].length;

    const grid: Grid = [];
    for (let x = 0; x < size; x++) {
        const col: string[] = [];
        for (let y = 0; y < size; y++) col.push(board[x][y]);
        grid.push(col);
    }

    return selectMove(grid, validMoves, SEARCH_DEPTH, ROOT_BRANCH);
};

// ---------------------------------------------------------------------------
// Bookkeeping.
// ---------------------------------------------------------------------------

// Session win/loss/draw tally, accumulated across games by logGameResult.
let wins = 0;
let losses = 0;
let draws = 0;

/** Log the finished game's result and the running session win rate. */
const logGameResult = (ns: NS) => {
    const { blackScore, whiteScore } = ns.go.getGameState();

    let outcome: string;
    if (blackScore > whiteScore) { wins++; outcome = "WIN "; }
    else if (blackScore < whiteScore) { losses++; outcome = "LOSS"; }
    else { draws++; outcome = "DRAW"; }

    const games = wins + losses + draws;
    const rate = ((wins / games) * 100).toFixed(0);
    ns.print(`${outcome} ${blackScore}-${whiteScore} vs ${OPPONENT}  |  W:${wins} L:${losses} D:${draws} (${rate}% over ${games})`);
};
