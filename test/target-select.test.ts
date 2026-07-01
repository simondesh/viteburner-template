import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseHackTarget, type ServerStat } from '../src/utils/target-select.ts';

// weakenTime (ms) and hackChance (0–1) drive the throughput score; the rest are
// the hard gates. Defaults keep gate-focused tests readable.
const s = (
    name: string,
    maxMoney: number,
    weakenTime: number,
    hackChance: number,
    requiredHackingLevel: number,
    requiredPorts = 0,
    hasRoot = true,
): ServerStat =>
    ({ name, maxMoney, weakenTime, hackChance, requiredHackingLevel, requiredPorts, hasRoot });

// How many port-opener programs we own. Five = all of them, so root-ability
// is never the limiting factor in tests that only care about level/score.
const ALL_PORTS = 5;

test('never targets a server above our hacking level, however rich', () => {
    const servers = [
        s('megacorp', 1_000_000_000, 1000, 1, 500), // huge money but out of reach
        s('foodnstuff', 1_000_000, 1000, 1, 10),    // modest but hackable
    ];
    assert.equal(chooseHackTarget(servers, 50, ALL_PORTS), 'foodnstuff');
});

test('prefers throughput: a fast modest server beats a rich but slow one', () => {
    const servers = [
        // rich but slow: 8e9 * 0.35 / 600000 ≈ 4667/ms
        s('slow-rich', 8_000_000_000, 600_000, 0.35, 100),
        // modest but fast: 2.4e9 * 0.78 / 90000 ≈ 20800/ms
        s('fast-modest', 2_400_000_000, 90_000, 0.78, 100),
    ];
    assert.equal(chooseHackTarget(servers, 200, ALL_PORTS), 'fast-modest');
});

test('hack chance weights the score: at equal money and time, higher chance wins', () => {
    const servers = [
        s('flaky', 1_000_000, 1000, 0.3, 10),
        s('reliable', 1_000_000, 1000, 0.9, 10),
    ];
    assert.equal(chooseHackTarget(servers, 50, ALL_PORTS), 'reliable');
});

test('skips servers with non-positive weaken time (divide-by-zero guard)', () => {
    const servers = [
        s('broken', 1_000_000_000, 0, 1, 10), // would divide by zero -> skipped
        s('ok', 1_000_000, 1000, 1, 10),
    ];
    assert.equal(chooseHackTarget(servers, 50, ALL_PORTS), 'ok');
});

test('falls back when nothing is within our hacking level', () => {
    const servers = [s('a', 1e9, 1000, 1, 300), s('b', 1e9, 1000, 1, 400)];
    assert.equal(chooseHackTarget(servers, 50, ALL_PORTS), 'n00dles');
});

test('ignores servers with no money to take', () => {
    const servers = [s('empty', 0, 1000, 1, 1), s('cash', 500_000, 1000, 1, 5)];
    assert.equal(chooseHackTarget(servers, 50, ALL_PORTS), 'cash');
});

test('a server exactly at our hacking level is still allowed', () => {
    assert.equal(chooseHackTarget([s('edge', 2_000_000, 1000, 1, 50)], 50, ALL_PORTS), 'edge');
});

test('never targets a server needing more port openers than we own', () => {
    const servers = [
        // In level and rich, but needs 3 ports and we have none rooted on it.
        s('rich-but-locked', 1_000_000_000, 1000, 1, 10, 3, false),
        // Modest, but needs no ports — we can root it now.
        s('open', 1_000_000, 1000, 1, 10, 0, false),
    ];
    assert.equal(chooseHackTarget(servers, 50, /* portOpeners */ 0), 'open');
});

test('targets a server we already have root on, even if we lack its port openers', () => {
    const servers = [
        s('owned', 1_000_000_000, 1000, 1, 10, 5, /* hasRoot */ true),
    ];
    assert.equal(chooseHackTarget(servers, 50, /* portOpeners */ 0), 'owned');
});

test('a server needing exactly as many ports as we own is allowed', () => {
    const servers = [
        s('exact', 2_000_000, 1000, 1, 10, 2, /* hasRoot */ false),
    ];
    assert.equal(chooseHackTarget(servers, 50, /* portOpeners */ 2), 'exact');
});
