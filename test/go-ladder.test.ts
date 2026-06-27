import test from 'node:test';
import assert from 'node:assert/strict';
import {
    FACTION_LADDER,
    SEARCH_DEPTH,
    GAMES_PER_FACTION,
    branchForBoard,
    chooseFaction,
    depthForFaction,
    nextBoard,
    resolveBoard,
    planGame,
    type FactionStat,
} from '../src/utils/go-ladder.ts';

const stat = (wins: number, losses: number): FactionStat => ({ wins, losses });

test('SEARCH_DEPTH (base depth) is even and 4', () => {
    assert.equal(SEARCH_DEPTH % 2, 0);
    assert.equal(SEARCH_DEPTH, 4);
});

test('GAMES_PER_FACTION is 100', () => {
    assert.equal(GAMES_PER_FACTION, 100);
});

test('chooseFaction starts at the easiest faction when there are no stats', () => {
    assert.equal(chooseFaction({}, GAMES_PER_FACTION), 'Netburners');
});

test('chooseFaction advances once a faction has been played the target number of games', () => {
    const stats = { Netburners: stat(40, 60), 'Slum Snakes': stat(10, 5) }; // Netburners = 100 games
    assert.equal(chooseFaction(stats, 100), 'Slum Snakes');
});

test('chooseFaction does not advance before the games target is reached', () => {
    const stats = { Netburners: stat(40, 59) }; // 99 games
    assert.equal(chooseFaction(stats, 100), 'Netburners');
});

test('chooseFaction returns the hardest faction once all are played out', () => {
    const stats = Object.fromEntries(FACTION_LADDER.map((f) => [f, stat(50, 50)]));
    assert.equal(chooseFaction(stats, 100), '????????????');
});

test('depthForFaction deepens for harder factions and is always even', () => {
    assert.equal(depthForFaction('Netburners'), 4);
    assert.equal(depthForFaction('Tetrads'), 4);
    assert.equal(depthForFaction('Daedalus'), 6);
    assert.equal(depthForFaction('Illuminati'), 6);
    assert.equal(depthForFaction('????????????'), 8);
    for (const f of FACTION_LADDER) assert.equal(depthForFaction(f) % 2, 0);
});

test('nextBoard steps up and caps at 13', () => {
    assert.equal(nextBoard(5), 7);
    assert.equal(nextBoard(7), 9);
    assert.equal(nextBoard(9), 13);
    assert.equal(nextBoard(13), 13);
});

test('resolveBoard starts a fresh faction at 5x5', () => {
    assert.deepEqual(resolveBoard(undefined, 30), { board: 5, games: 0 });
});

test('resolveBoard keeps the current board while under the patience budget', () => {
    assert.deepEqual(resolveBoard({ board: 5, games: 29 }, 30), { board: 5, games: 29 });
});

test('resolveBoard escalates and resets games once the budget is hit', () => {
    assert.deepEqual(resolveBoard({ board: 5, games: 30 }, 30), { board: 7, games: 0 });
});

test('resolveBoard never escalates past 13x13', () => {
    assert.deepEqual(resolveBoard({ board: 13, games: 999 }, 30), { board: 13, games: 999 });
});

test('branchForBoard is wide on small boards and narrow on big ones', () => {
    assert.deepEqual(branchForBoard(5), { rootBranch: 25, nodeBranch: 25 });
    assert.deepEqual(branchForBoard(7), { rootBranch: 25, nodeBranch: 16 });
    assert.deepEqual(branchForBoard(9), { rootBranch: 16, nodeBranch: 10 });
    assert.deepEqual(branchForBoard(13), { rootBranch: 12, nodeBranch: 6 });
});

test('planGame: an easy faction uses adaptive board + wide beam + depth 4', () => {
    assert.deepEqual(
        planGame('Netburners', undefined, 30),
        { board: 5, rootBranch: 25, nodeBranch: 25, depth: 4, games: 0 },
    );
});

test('planGame: an easy faction escalates its board per resolveBoard', () => {
    assert.deepEqual(
        planGame('Netburners', { board: 5, games: 30 }, 30),
        { board: 7, rootBranch: 25, nodeBranch: 16, depth: 4, games: 0 },
    );
});

test('planGame: deep factions use a fixed small board, narrow beam, and deep search', () => {
    assert.deepEqual(
        planGame('Daedalus', undefined, 30),
        { board: 7, rootBranch: 8, nodeBranch: 4, depth: 6, games: 0 },
    );
    // Illuminati ignores any stored board/escalation; games is passed through.
    assert.deepEqual(
        planGame('Illuminati', { board: 5, games: 999 }, 30),
        { board: 7, rootBranch: 8, nodeBranch: 4, depth: 6, games: 999 },
    );
    assert.deepEqual(
        planGame('????????????', undefined, 30),
        { board: 5, rootBranch: 6, nodeBranch: 3, depth: 8, games: 0 },
    );
});

test('invariant: every deep-depth faction is pinned to a small board + narrow beam, never escalates', () => {
    // Guards the core property: a faction that searches deeper than the base depth
    // must use a fixed small board with a narrow beam, even when a stored entry
    // would escalate an easy faction to 13x13. Catches a future edit that adds a
    // deep depth but forgets to pin the board/beam (which would route it down the
    // wide adaptive escalation path).
    for (const faction of FACTION_LADDER) {
        if (depthForFaction(faction) > SEARCH_DEPTH) {
            const plan = planGame(faction, { board: 13, games: 9999 }, 30);
            assert.ok(plan.board <= 7, `${faction} (depth ${plan.depth}) must stay on a small board, got ${plan.board}`);
            assert.ok(plan.nodeBranch <= 4, `${faction} must use a narrow beam, got nodeBranch ${plan.nodeBranch}`);
        }
    }
});
