import test from 'node:test';
import assert from 'node:assert/strict';
import {
    hackThreadsForGreed,
    growMultiplier,
    weakenThreadsForSecurity,
    securityIncrease,
    batchRam,
    type ThreadCounts,
    type ThreadCosts,
} from '../src/utils/hgw-math.ts';

test('hackThreadsForGreed: threads to steal the requested fraction, rounded up', () => {
    assert.equal(hackThreadsForGreed(0.5, 0.01), 50);
    assert.equal(hackThreadsForGreed(0.5, 0.013), 39); // ceil(38.46)
});

test('hackThreadsForGreed: zero when hacking is impossible or greed is zero', () => {
    assert.equal(hackThreadsForGreed(0.5, 0), 0);
    assert.equal(hackThreadsForGreed(0, 0.01), 0);
});

test('growMultiplier: ratio needed to refill money, clamped to >= 1', () => {
    assert.equal(growMultiplier(500, 1000), 2);
    assert.equal(growMultiplier(1000, 1000), 1); // already full
    assert.equal(growMultiplier(2000, 1000), 1); // never shrink
});

test('growMultiplier: treats empty money as $1 to avoid divide-by-zero', () => {
    assert.equal(growMultiplier(0, 1000), 1000);
});

test('weakenThreadsForSecurity: threads to remove the given security, rounded up', () => {
    assert.equal(weakenThreadsForSecurity(1.0, 0.05), 20);
    assert.equal(weakenThreadsForSecurity(0.06, 0.05), 2); // ceil(1.2)
});

test('weakenThreadsForSecurity: zero when nothing to remove or no effect per thread', () => {
    assert.equal(weakenThreadsForSecurity(0, 0.05), 0);
    assert.equal(weakenThreadsForSecurity(-1, 0.05), 0);
    assert.equal(weakenThreadsForSecurity(1, 0), 0);
});

test('securityIncrease: linear in threads, never negative', () => {
    assert.ok(Math.abs(securityIncrease(10, 0.002) - 0.02) < 1e-9);
    assert.equal(securityIncrease(0, 0.002), 0);
    assert.equal(securityIncrease(-5, 0.002), 0);
});

test('batchRam: sums per-op thread costs (weaken cost used for both weakens)', () => {
    const threads: ThreadCounts = { hack: 10, weaken1: 5, grow: 20, weaken2: 5 };
    const costs: ThreadCosts = { hack: 1.7, grow: 1.75, weaken: 1.75 };
    // 10*1.7 + 5*1.75 + 20*1.75 + 5*1.75 = 17 + 8.75 + 35 + 8.75 = 69.5
    assert.equal(batchRam(threads, costs), 69.5);
});
