import test from 'node:test';
import assert from 'node:assert/strict';
import {
    FACTION_LADDER,
    SEARCH_DEPTH,
    branchForBoard,
    chooseFaction,
    nextBoard,
    resolveBoard,
    type FactionStat,
} from '../src/utils/go-ladder.ts';

const stat = (highestWinStreak: number): FactionStat => ({ highestWinStreak });

test('SEARCH_DEPTH is even so the search horizon ends on the opponent reply', () => {
    assert.equal(SEARCH_DEPTH % 2, 0);
    assert.equal(SEARCH_DEPTH, 4);
});

test('chooseFaction starts at the easiest faction when there are no stats', () => {
    assert.equal(chooseFaction({}, 10), 'Netburners');
});

test('chooseFaction skips factions that already reached the streak target', () => {
    const stats = { Netburners: stat(10), 'Slum Snakes': stat(3) };
    assert.equal(chooseFaction(stats, 10), 'Slum Snakes');
});

test('chooseFaction returns the hardest faction once all are cleared', () => {
    const stats = Object.fromEntries(FACTION_LADDER.map((f) => [f, stat(10)]));
    assert.equal(chooseFaction(stats, 10), '????????????');
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
