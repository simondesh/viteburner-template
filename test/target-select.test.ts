import test from 'node:test';
import assert from 'node:assert/strict';
import { chooseHackTarget, type ServerStat } from '../src/utils/target-select.ts';

const s = (name: string, maxMoney: number, minSecurity: number, requiredHackingLevel: number): ServerStat =>
    ({ name, maxMoney, minSecurity, requiredHackingLevel });

test('never targets a server above our hacking level, however rich', () => {
    const servers = [
        s('megacorp', 1_000_000_000, 1, 500), // huge money but out of reach
        s('foodnstuff', 1_000_000, 1, 10),     // modest but hackable
    ];
    assert.equal(chooseHackTarget(servers, 50), 'foodnstuff');
});

test('among reachable servers, picks the best money-to-security ratio', () => {
    const servers = [
        s('low', 1_000_000, 10, 5),   // ratio 100k
        s('high', 5_000_000, 10, 20), // ratio 500k
    ];
    assert.equal(chooseHackTarget(servers, 100), 'high');
});

test('falls back when nothing is within our hacking level', () => {
    const servers = [s('a', 1e9, 1, 300), s('b', 1e9, 1, 400)];
    assert.equal(chooseHackTarget(servers, 50), 'n00dles');
});

test('ignores servers with no money to take', () => {
    const servers = [s('empty', 0, 1, 1), s('cash', 500_000, 1, 5)];
    assert.equal(chooseHackTarget(servers, 50), 'cash');
});

test('a server exactly at our hacking level is still allowed', () => {
    assert.equal(chooseHackTarget([s('edge', 2_000_000, 1, 50)], 50), 'edge');
});
