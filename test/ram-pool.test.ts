import test from 'node:test';
import assert from 'node:assert/strict';
import {
    serverCapacity,
    totalCapacity,
    placeThreads,
    planOps,
    type ServerRam,
    type OpRequest,
} from '../src/utils/ram-pool.ts';

const pool = (...pairs: [string, number][]): ServerRam[] =>
    pairs.map(([server, freeRam]) => ({ server, freeRam }));

test('serverCapacity: whole threads that fit, zero on non-positive cost', () => {
    assert.equal(serverCapacity(10, 2), 5);
    assert.equal(serverCapacity(9, 2), 4);
    assert.equal(serverCapacity(10, 0), 0);
});

test('totalCapacity: sums per-server capacity', () => {
    assert.equal(totalCapacity(pool(['a', 10], ['b', 6]), 2), 8); // 5 + 3
});

test('placeThreads: fills servers in order until the thread count is met', () => {
    assert.deepEqual(
        placeThreads(pool(['a', 10], ['b', 10]), 2, 7),
        [{ server: 'a', threads: 5 }, { server: 'b', threads: 2 }],
    );
});

test('placeThreads: returns null when total capacity is insufficient', () => {
    assert.equal(placeThreads(pool(['a', 4]), 2, 3), null);
});

test('placeThreads: zero threads needs no placement', () => {
    assert.deepEqual(placeThreads(pool(['a', 4]), 2, 0), []);
});

test('planOps: places every op or returns null (all-or-nothing)', () => {
    const ops: OpRequest[] = [
        { key: 'hack', perThreadCost: 2, threads: 2 },
        { key: 'grow', perThreadCost: 2, threads: 1 },
    ];
    // a has capacity 3 (6/2): hack takes 2 -> 2 left -> grow takes 1. OK.
    assert.deepEqual(planOps(pool(['a', 6]), ops), [
        { key: 'hack', placements: [{ server: 'a', threads: 2 }] },
        { key: 'grow', placements: [{ server: 'a', threads: 1 }] },
    ]);
});

test('planOps: returns null if a later op no longer fits after earlier ops consume RAM', () => {
    const ops: OpRequest[] = [
        { key: 'hack', perThreadCost: 2, threads: 2 }, // consumes all of a (cap 2)
        { key: 'grow', perThreadCost: 2, threads: 1 }, // nothing left
    ];
    assert.equal(planOps(pool(['a', 4]), ops), null);
});

test('planOps: zero-thread ops produce empty placements without consuming RAM', () => {
    const ops: OpRequest[] = [
        { key: 'hack', perThreadCost: 2, threads: 0 },
        { key: 'grow', perThreadCost: 2, threads: 2 },
    ];
    assert.deepEqual(planOps(pool(['a', 4]), ops), [
        { key: 'hack', placements: [] },
        { key: 'grow', placements: [{ server: 'a', threads: 2 }] },
    ]);
});
