import test from 'node:test';
import assert from 'node:assert/strict';
import {
    serverCapacity,
    totalCapacity,
    placeThreads,
    planOps,
    shareReserveGb,
    planShare,
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

test('shareReserveGb: zero at or below the threshold, a fraction of total above it', () => {
    // fraction 0.5 is exact in binary, so the assertions have no float wobble.
    assert.equal(shareReserveGb(1000, 1024, 0.5), 0);    // below -> 0
    assert.equal(shareReserveGb(1024, 1024, 0.5), 0);    // exactly at -> strict > -> 0
    assert.equal(shareReserveGb(2000, 1024, 0.5), 1000); // above -> 50% of total
});

test('planShare: fills servers in the given order up to the budget', () => {
    // shareCost 4, budget 40 -> 10 threads; the first server in order (cap 25)
    // absorbs all 10 and the budget is spent before the second is touched.
    assert.deepEqual(planShare(pool(['a', 100], ['b', 100]), 4, 40), [
        { server: 'a', threads: 10 },
    ]);
});

test('planShare: spans servers and floors per host until the budget is spent', () => {
    // shareCost 4, budget 48 -> 12 threads. a cap 5 (20/4) takes 5 (20 RAM),
    // remaining 28 -> b takes 7 (28/4). Total 12.
    assert.deepEqual(planShare(pool(['a', 20], ['b', 100]), 4, 48), [
        { server: 'a', threads: 5 },
        { server: 'b', threads: 7 },
    ]);
});

test('planShare: Infinity budget fills the whole pool', () => {
    // a: floor(100/4)=25, b: floor(50/4)=12
    assert.deepEqual(planShare(pool(['a', 100], ['b', 50]), 4, Infinity), [
        { server: 'a', threads: 25 },
        { server: 'b', threads: 12 },
    ]);
});

test('planShare: empty when the budget is smaller than one thread', () => {
    assert.deepEqual(planShare(pool(['a', 100]), 4, 3), []);
});
