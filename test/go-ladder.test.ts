import test from 'node:test';
import assert from 'node:assert/strict';
import {
    FACTION_LADDER,
    SEARCH_DEPTH,
    GAMES_PER_FACTION,
    FIXED_BOARD,
    branchForBoard,
    chooseFaction,
    depthForFaction,
    planGame,
    type FactionStat,
} from '../src/utils/go-ladder.ts';

const stat = (wins: number, losses: number): FactionStat => ({ wins, losses });

test('SEARCH_DEPTH (base depth) is even and 4', () => {
    assert.equal(SEARCH_DEPTH % 2, 0);
    assert.equal(SEARCH_DEPTH, 4);
});

test('GAMES_PER_FACTION is 50', () => {
    assert.equal(GAMES_PER_FACTION, 50);
});

test('FIXED_BOARD is 7 (every faction plays on a 7x7 board)', () => {
    assert.equal(FIXED_BOARD, 7);
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

test('chooseFaction cycles back to the first faction once every faction finishes a band', () => {
    // Every faction has played exactly one full band of 100 games -> the next band
    // opens and play loops back to the easiest faction (not stuck on the last one).
    const stats = Object.fromEntries(FACTION_LADDER.map((f) => [f, stat(50, 50)]));
    assert.equal(chooseFaction(stats, 100), FACTION_LADDER[0]);
});

test('chooseFaction skips factions that finished the current band and picks the next unfinished one', () => {
    // Band target is 100 (some factions are still at 0). Netburners has run ahead
    // (120) and Slum Snakes finished the band (100); both are skipped for The Black
    // Hand (40), which has not finished the current 100-game band.
    const stats = {
        Netburners: stat(70, 50), // 120
        'Slum Snakes': stat(50, 50), // 100
        'The Black Hand': stat(30, 10), // 40
    };
    assert.equal(chooseFaction(stats, 100), 'The Black Hand');
});

test('depthForFaction deepens for harder factions and is always even', () => {
    assert.equal(depthForFaction('Netburners'), 4);
    assert.equal(depthForFaction('Tetrads'), 4);
    assert.equal(depthForFaction('Daedalus'), 8);
    assert.equal(depthForFaction('Illuminati'), 8);
    assert.equal(depthForFaction('????????????'), 8);
    for (const f of FACTION_LADDER) assert.equal(depthForFaction(f) % 2, 0);
});

test('branchForBoard is wide on small boards and narrow on big ones', () => {
    assert.deepEqual(branchForBoard(5), { rootBranch: 25, nodeBranch: 25 });
    assert.deepEqual(branchForBoard(7), { rootBranch: 25, nodeBranch: 16 });
    assert.deepEqual(branchForBoard(9), { rootBranch: 16, nodeBranch: 10 });
    assert.deepEqual(branchForBoard(13), { rootBranch: 12, nodeBranch: 6 });
});

test('planGame: every faction plays on 7x7', () => {
    for (const f of FACTION_LADDER) {
        assert.equal(planGame(f).board, 7, `${f} must play on 7x7`);
    }
});

test('planGame: an easy faction uses 7x7 with the wide beam and depth 4', () => {
    assert.deepEqual(
        planGame('Netburners'),
        { board: 7, rootBranch: 25, nodeBranch: 16, depth: 4 },
    );
});

test('planGame: deep factions use 7x7 with a narrow beam and deeper search', () => {
    assert.deepEqual(
        planGame('Daedalus'),
        { board: 7, rootBranch: 8, nodeBranch: 4, depth: 8 },
    );
    // Illuminati is the top faction now: depth 8 on the narrowest beam (depth 10
    // was too slow on 7x7).
    assert.deepEqual(
        planGame('Illuminati'),
        { board: 7, rootBranch: 6, nodeBranch: 3, depth: 8 },
    );
    assert.deepEqual(
        planGame('????????????'),
        { board: 7, rootBranch: 6, nodeBranch: 3, depth: 8 },
    );
});

test('invariant: every deep-depth faction uses a narrow beam (deep search stays affordable)', () => {
    // Any faction searching deeper than the base depth must use a narrow beam so
    // beam^depth stays affordable. Catches a future edit that adds a deep depth
    // but forgets to narrow the beam (which would route it down the wide default).
    for (const faction of FACTION_LADDER) {
        if (depthForFaction(faction) > SEARCH_DEPTH) {
            const plan = planGame(faction);
            assert.ok(plan.nodeBranch <= 4, `${faction} (depth ${plan.depth}) must use a narrow beam, got nodeBranch ${plan.nodeBranch}`);
        }
    }
});
