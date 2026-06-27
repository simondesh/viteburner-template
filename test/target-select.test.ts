import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseHackTarget, type ServerStat } from '../src/utils/target-select.ts';

const s = (
    name: string,
    maxMoney: number,
    minSecurity: number,
    requiredHackingLevel: number,
    requiredPorts = 0,
    hasRoot = true,
): ServerStat =>
    ({ name, maxMoney, minSecurity, requiredHackingLevel, requiredPorts, hasRoot });

// How many port-opener programs we own. Five = all of them, so root-ability
// is never the limiting factor in tests that only care about level/ratio.
const ALL_PORTS = 5;

test('never targets a server above our hacking level, however rich', () => {
    const servers = [
        s('megacorp', 1_000_000_000, 1, 500), // huge money but out of reach
        s('foodnstuff', 1_000_000, 1, 10),     // modest but hackable
    ];
    assert.equal(chooseHackTarget(servers, 50, ALL_PORTS), 'foodnstuff');
});

test('among reachable servers, picks the best money-to-security ratio', () => {
    const servers = [
        s('low', 1_000_000, 10, 5),   // ratio 100k
        s('high', 5_000_000, 10, 20), // ratio 500k
    ];
    assert.equal(chooseHackTarget(servers, 100, ALL_PORTS), 'high');
});

test('falls back when nothing is within our hacking level', () => {
    const servers = [s('a', 1e9, 1, 300), s('b', 1e9, 1, 400)];
    assert.equal(chooseHackTarget(servers, 50, ALL_PORTS), 'n00dles');
});

test('ignores servers with no money to take', () => {
    const servers = [s('empty', 0, 1, 1), s('cash', 500_000, 1, 5)];
    assert.equal(chooseHackTarget(servers, 50, ALL_PORTS), 'cash');
});

test('a server exactly at our hacking level is still allowed', () => {
    assert.equal(chooseHackTarget([s('edge', 2_000_000, 1, 50)], 50, ALL_PORTS), 'edge');
});

test('never targets a server needing more port openers than we own', () => {
    const servers = [
        // In level and rich, but needs 3 ports and we have none rooted on it.
        s('rich-but-locked', 1_000_000_000, 1, 10, 3, false),
        // Modest, but needs no ports — we can root it now.
        s('open', 1_000_000, 1, 10, 0, false),
    ];
    assert.equal(chooseHackTarget(servers, 50, /* portOpeners */ 0), 'open');
});

test('targets a server we already have root on, even if we lack its port openers', () => {
    const servers = [
        s('owned', 1_000_000_000, 1, 10, 5, /* hasRoot */ true),
    ];
    assert.equal(chooseHackTarget(servers, 50, /* portOpeners */ 0), 'owned');
});

test('a server needing exactly as many ports as we own is allowed', () => {
    const servers = [
        s('exact', 2_000_000, 1, 10, 2, /* hasRoot */ false),
    ];
    assert.equal(chooseHackTarget(servers, 50, /* portOpeners */ 2), 'exact');
});
