# HGW Batch Scheduler Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Replace the per-server naive controllers with a single central scheduler on `home` that batches Hack/Grow/Weaken against the best target using op timing and effects, and spends leftover RAM on `ns.share()`.

**Architecture:** A thin NS shell (`Scheduler.ts`) on `home` pools the RAM of every rooted server, picks one target, preps it to min-security/max-money, then fires overlapping HWGW batches timed with `additionalMsec` so they land in order. All thread/timing/RAM math lives in pure, unit-tested modules (`hgw-math.ts`, `ram-pool.ts`). Workers are dumb single-op scripts. `start.ts` is reduced to bootstrapping (launch scheduler, buy/upgrade cloud, run go/darknet).

**Tech Stack:** TypeScript, Bitburner (modded) NS API, viteburner build, Node 26 built-in test runner (`node --test`).

## Global Constraints

- Pure modules (`hgw-math.ts`, `ram-pool.ts`) MUST NOT import `@ns` or reference any `ns.*` — they are unit-tested under Node with no game.
- Tests live in the top-level `test/` directory (NOT under `src/`, so viteburner does not deploy them) and import source with an explicit `.ts` extension, e.g. `from '../src/utils/hgw-math.ts'`.
- Run tests with: `node --test "test/**/*.test.ts"`.
- Worker scripts are referenced by their built `.js` path at runtime: `utils/hack.js`, `utils/grow.js`, `utils/weaken.js`, `utils/share.js`. The scheduler is `Scheduler.js` (built from `src/Scheduler.ts`).
- All RAM costs MUST be read at runtime via `ns.getScriptRam(...)` — never hardcoded.
- Rooting MUST be guarded: `ns.fileExists` before each opener, `try/catch` around openers + `nuke`, and only `nuke` when open ports ≥ required. The port-opener program filenames are: `BruteSSH.exe`, `FTPCrack.exe`, `relaySMTP.exe`, `HTTPWorm.exe`, `SQLInject.exe`.
- This is a modded game: `ns.cloud.getServerNames()` returns purchased servers (no `getPurchasedServers`).
- Commit after every task. Repo default branch is `main`; if asked to commit and on `main`, the executor should branch first per repo policy.

---

### Task 1: Pure thread/effect math (`hgw-math.ts`)

**Files:**
- Create: `src/utils/hgw-math.ts`
- Test: `test/hgw-math.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ThreadCounts { hack: number; weaken1: number; grow: number; weaken2: number; }`
  - `interface ThreadCosts { hack: number; grow: number; weaken: number; }`
  - `hackThreadsForGreed(greed: number, hackPercentPerThread: number): number`
  - `growMultiplier(currentMoney: number, maxMoney: number): number`
  - `weakenThreadsForSecurity(securityToRemove: number, weakenPerThread: number): number`
  - `securityIncrease(threads: number, perThread: number): number`
  - `batchRam(threads: ThreadCounts, costs: ThreadCosts): number`

- [ ] **Step 1: Write the failing test**

Create `test/hgw-math.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "test/hgw-math.test.ts"`
Expected: FAIL — `Cannot find module '../src/utils/hgw-math.ts'` (file not created yet).

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/hgw-math.ts`:

```ts
// Pure HGW batch math. No NS dependency: every game-derived value (hack %,
// security-per-thread, durations) is passed in, so this is unit-testable.

export interface ThreadCounts {
    hack: number;
    weaken1: number;
    grow: number;
    weaken2: number;
}

export interface ThreadCosts {
    hack: number;
    grow: number;
    weaken: number;
}

/** Threads needed to steal `greed` (0..1) of the money, given per-thread hack %. */
export const hackThreadsForGreed = (greed: number, hackPercentPerThread: number): number => {
    if (greed <= 0 || hackPercentPerThread <= 0) return 0;
    return Math.ceil(greed / hackPercentPerThread);
};

/** Multiplier to grow `currentMoney` back to `maxMoney`, clamped to >= 1. */
export const growMultiplier = (currentMoney: number, maxMoney: number): number =>
    Math.max(1, maxMoney / Math.max(currentMoney, 1));

/** Weaken threads to remove `securityToRemove`, given per-thread weaken power. */
export const weakenThreadsForSecurity = (securityToRemove: number, weakenPerThread: number): number => {
    if (securityToRemove <= 0 || weakenPerThread <= 0) return 0;
    return Math.ceil(securityToRemove / weakenPerThread);
};

/** Total security added by `threads` ops, each adding `perThread`. Never negative. */
export const securityIncrease = (threads: number, perThread: number): number =>
    Math.max(0, threads * perThread);

/** RAM (GB) for one HWGW batch. The weaken cost applies to both weaken legs. */
export const batchRam = (threads: ThreadCounts, costs: ThreadCosts): number =>
    threads.hack * costs.hack +
    threads.weaken1 * costs.weaken +
    threads.grow * costs.grow +
    threads.weaken2 * costs.weaken;
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test "test/hgw-math.test.ts"`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/utils/hgw-math.ts test/hgw-math.test.ts
git commit -m "feat: pure HGW thread/effect math"
```

---

### Task 2: Pure batch timing + capacity math (`hgw-math.ts`)

**Files:**
- Modify: `src/utils/hgw-math.ts` (append)
- Test: `test/hgw-math.test.ts` (append)

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface OpDurations { hackTime: number; growTime: number; weakenTime: number; }`
  - `interface AdditionalMsec { hack: number; weaken1: number; grow: number; weaken2: number; }`
  - `additionalMsecOffsets(durations: OpDurations, gapMs: number): AdditionalMsec`
  - `batchesThatFit(poolRamForHacking: number, perBatchRam: number, cycleTimeMs: number, batchSpacingMs: number): number`

- [ ] **Step 1: Write the failing test**

Append to `test/hgw-math.test.ts`:

```ts
import {
    additionalMsecOffsets,
    batchesThatFit,
    type OpDurations,
} from '../src/utils/hgw-math.ts';

test('additionalMsecOffsets: ops land in order H, W1, G, W2 separated by the gap', () => {
    const durations: OpDurations = { hackTime: 1000, growTime: 3200, weakenTime: 4000 };
    const gap = 100;
    const off = additionalMsecOffsets(durations, gap);

    // Land time = natural duration + additionalMsec.
    const landHack = durations.hackTime + off.hack;
    const landWeaken1 = durations.weakenTime + off.weaken1;
    const landGrow = durations.growTime + off.grow;
    const landWeaken2 = durations.weakenTime + off.weaken2;

    assert.equal(landWeaken1 - landHack, gap);
    assert.equal(landGrow - landWeaken1, gap);
    assert.equal(landWeaken2 - landGrow, gap);
});

test('additionalMsecOffsets: every offset is non-negative', () => {
    const off = additionalMsecOffsets({ hackTime: 1000, growTime: 3200, weakenTime: 4000 }, 100);
    assert.ok(off.hack >= 0);
    assert.ok(off.weaken1 >= 0);
    assert.ok(off.grow >= 0);
    assert.ok(off.weaken2 >= 0);
});

test('batchesThatFit: limited by whichever of RAM or time is smaller', () => {
    // byRam = floor(1000/100)=10 ; byTime = floor(4000/400)=10
    assert.equal(batchesThatFit(1000, 100, 4000, 400), 10);
    // RAM-limited: floor(450/100)=4
    assert.equal(batchesThatFit(450, 100, 4000, 400), 4);
    // time-limited: floor(4000/1000)=4
    assert.equal(batchesThatFit(1000, 100, 4000, 1000), 4);
});

test('batchesThatFit: zero on non-positive batch RAM or spacing', () => {
    assert.equal(batchesThatFit(1000, 0, 4000, 400), 0);
    assert.equal(batchesThatFit(1000, 100, 4000, 0), 0);
    assert.equal(batchesThatFit(50, 100, 4000, 400), 0); // cannot fit one batch
});
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "test/hgw-math.test.ts"`
Expected: FAIL — `additionalMsecOffsets is not a function` / export missing.

- [ ] **Step 3: Write minimal implementation**

Append to `src/utils/hgw-math.ts`:

```ts
export interface OpDurations {
    hackTime: number;
    growTime: number;
    weakenTime: number;
}

export interface AdditionalMsec {
    hack: number;
    weaken1: number;
    grow: number;
    weaken2: number;
}

/**
 * Per-op `additionalMsec` padding so all four ops can be launched together yet
 * COMPLETE in the order H -> W1 -> G -> W2, each `gapMs` apart. The longest op
 * sets the baseline landing time; shorter ops wait longer.
 */
export const additionalMsecOffsets = (durations: OpDurations, gapMs: number): AdditionalMsec => {
    const baseLand = Math.max(durations.hackTime, durations.growTime, durations.weakenTime);
    return {
        hack: baseLand - durations.hackTime,
        weaken1: baseLand + gapMs - durations.weakenTime,
        grow: baseLand + 2 * gapMs - durations.growTime,
        weaken2: baseLand + 3 * gapMs - durations.weakenTime,
    };
};

/**
 * How many concurrent batches to run: the smaller of what RAM allows and what
 * the cycle time allows (one batch can start every `batchSpacingMs`).
 */
export const batchesThatFit = (
    poolRamForHacking: number,
    perBatchRam: number,
    cycleTimeMs: number,
    batchSpacingMs: number,
): number => {
    if (perBatchRam <= 0 || batchSpacingMs <= 0) return 0;
    const byRam = Math.floor(poolRamForHacking / perBatchRam);
    const byTime = Math.floor(cycleTimeMs / batchSpacingMs);
    return Math.max(0, Math.min(byRam, byTime));
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test "test/hgw-math.test.ts"`
Expected: PASS — all Task 1 + Task 2 tests green.

- [ ] **Step 5: Commit**

```bash
git add src/utils/hgw-math.ts test/hgw-math.test.ts
git commit -m "feat: pure HGW batch timing + capacity math"
```

---

### Task 3: Pure RAM allocation (`ram-pool.ts`)

**Files:**
- Create: `src/utils/ram-pool.ts`
- Test: `test/ram-pool.test.ts`

**Interfaces:**
- Consumes: nothing.
- Produces:
  - `interface ServerRam { server: string; freeRam: number; }`
  - `interface Placement { server: string; threads: number; }`
  - `interface OpRequest { key: string; perThreadCost: number; threads: number; }`
  - `interface OpPlacement { key: string; placements: Placement[]; }`
  - `serverCapacity(freeRam: number, perThreadCost: number): number`
  - `totalCapacity(pool: ServerRam[], perThreadCost: number): number`
  - `placeThreads(pool: ServerRam[], perThreadCost: number, threads: number): Placement[] | null`
  - `planOps(pool: ServerRam[], ops: OpRequest[]): OpPlacement[] | null`

- [ ] **Step 1: Write the failing test**

Create `test/ram-pool.test.ts`:

```ts
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `node --test "test/ram-pool.test.ts"`
Expected: FAIL — `Cannot find module '../src/utils/ram-pool.ts'`.

- [ ] **Step 3: Write minimal implementation**

Create `src/utils/ram-pool.ts`:

```ts
// Pure RAM allocation across the server pool. No NS dependency.

export interface ServerRam {
    server: string;
    freeRam: number;
}

export interface Placement {
    server: string;
    threads: number;
}

export interface OpRequest {
    key: string;
    perThreadCost: number;
    threads: number;
}

export interface OpPlacement {
    key: string;
    placements: Placement[];
}

/** Whole threads of `perThreadCost` GB that fit in `freeRam`. */
export const serverCapacity = (freeRam: number, perThreadCost: number): number => {
    if (perThreadCost <= 0) return 0;
    return Math.floor(freeRam / perThreadCost);
};

/** Sum of per-server capacity across the pool. */
export const totalCapacity = (pool: ServerRam[], perThreadCost: number): number =>
    pool.reduce((sum, s) => sum + serverCapacity(s.freeRam, perThreadCost), 0);

/**
 * Place `threads` of `perThreadCost` across the pool, filling servers in the
 * given order. Threads of one op may split across servers (they act per-thread
 * and land together). Returns the placement list, [] if no threads needed, or
 * null if the pool cannot fit them all.
 */
export const placeThreads = (
    pool: ServerRam[],
    perThreadCost: number,
    threads: number,
): Placement[] | null => {
    if (threads <= 0) return [];
    if (perThreadCost <= 0) return null;

    const placements: Placement[] = [];
    let remaining = threads;
    for (const s of pool) {
        if (remaining <= 0) break;
        const cap = serverCapacity(s.freeRam, perThreadCost);
        if (cap <= 0) continue;
        const place = Math.min(cap, remaining);
        placements.push({ server: s.server, threads: place });
        remaining -= place;
    }
    return remaining > 0 ? null : placements;
};

/**
 * Plan placements for a sequence of ops against a shared pool, all-or-nothing.
 * Each op consumes RAM from a working copy so later ops see what earlier ops
 * took. If any op cannot fit, returns null and nothing should be launched.
 */
export const planOps = (pool: ServerRam[], ops: OpRequest[]): OpPlacement[] | null => {
    const work: ServerRam[] = pool.map((s) => ({ ...s }));
    const result: OpPlacement[] = [];

    for (const op of ops) {
        const placements = placeThreads(work, op.perThreadCost, op.threads);
        if (placements === null) return null;
        for (const p of placements) {
            const entry = work.find((s) => s.server === p.server);
            if (entry) entry.freeRam -= p.threads * op.perThreadCost;
        }
        result.push({ key: op.key, placements });
    }
    return result;
};
```

- [ ] **Step 4: Run test to verify it passes**

Run: `node --test "test/ram-pool.test.ts"`
Expected: PASS — all tests green.

- [ ] **Step 5: Commit**

```bash
git add src/utils/ram-pool.ts test/ram-pool.test.ts
git commit -m "feat: pure RAM pool allocation + batch planning"
```

---

### Task 4: Dumb workers (`hack`/`grow`/`weaken` + new `share`)

**Files:**
- Modify: `src/utils/hack.ts` (whole file)
- Modify: `src/utils/grow.ts` (whole file)
- Modify: `src/utils/weaken.ts` (whole file)
- Create: `src/utils/share.ts`

**Interfaces:**
- Consumes: nothing (pure NS shells).
- Produces: scripts launched as `ns.exec('utils/<op>.js', host, threads, target, additionalMsec)`. Workers read `args[0]=target`, `args[1]=additionalMsec`. `share.js` takes no meaningful args.

There is no unit test for workers (NS shells). The gate is: type-check passes and they reference exactly one money-affecting NS function so per-thread RAM stays minimal.

- [ ] **Step 1: Rewrite `src/utils/hack.ts`**

```ts
import { NS } from '@ns';

/** Dumb hack worker. args: [target, additionalMsec]. One ns function => 1.7 GB/thread. */
export async function main(ns: NS) {
    const target = ns.args[0] as string;
    const additionalMsec = (ns.args[1] as number) ?? 0;
    await ns.hack(target, { additionalMsec });
}
```

- [ ] **Step 2: Rewrite `src/utils/grow.ts`**

```ts
import { NS } from '@ns';

/** Dumb grow worker. args: [target, additionalMsec]. */
export async function main(ns: NS) {
    const target = ns.args[0] as string;
    const additionalMsec = (ns.args[1] as number) ?? 0;
    await ns.grow(target, { additionalMsec });
}
```

- [ ] **Step 3: Rewrite `src/utils/weaken.ts`**

```ts
import { NS } from '@ns';

/** Dumb weaken worker. args: [target, additionalMsec]. */
export async function main(ns: NS) {
    const target = ns.args[0] as string;
    const additionalMsec = (ns.args[1] as number) ?? 0;
    await ns.weaken(target, { additionalMsec });
}
```

- [ ] **Step 4: Create `src/utils/share.ts`**

```ts
import { NS } from '@ns';

/** Dumb share worker: boosts faction reputation gains until killed. */
export async function main(ns: NS) {
    while (true) {
        await ns.share();
    }
}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "utils/(hack|grow|weaken|share)" || echo "workers clean"`
Expected: `workers clean`.

- [ ] **Step 6: Commit**

```bash
git add src/utils/hack.ts src/utils/grow.ts src/utils/weaken.ts src/utils/share.ts
git commit -m "feat: dumb HGW + share workers with additionalMsec timing"
```

---

### Task 5: Central scheduler (`Scheduler.ts`)

**Files:**
- Create: `src/Scheduler.ts`

**Interfaces:**
- Consumes:
  - From `hgw-math.ts`: `ThreadCounts`, `ThreadCosts`, `OpDurations`, `hackThreadsForGreed`, `growMultiplier`, `weakenThreadsForSecurity`, `securityIncrease`, `batchRam`, `additionalMsecOffsets`, `batchesThatFit`.
  - From `ram-pool.ts`: `ServerRam`, `OpRequest`, `OpPlacement`, `planOps`, `totalCapacity`, `placeThreads`.
  - From `target-select.ts`: `ServerStat`, `chooseHackTarget`.
- Produces: `Scheduler.js` (run on `home`). No exports consumed elsewhere.

This is a thin NS shell; verified in-game. The automated gate is a clean type-check.

- [ ] **Step 1: Create `src/Scheduler.ts`**

```ts
import { NS } from '@ns';
import { ServerStat, chooseHackTarget } from './utils/target-select';
import {
    ThreadCounts,
    ThreadCosts,
    OpDurations,
    hackThreadsForGreed,
    growMultiplier,
    weakenThreadsForSecurity,
    securityIncrease,
    batchRam,
    additionalMsecOffsets,
    batchesThatFit,
} from './utils/hgw-math';
import { ServerRam, OpRequest, planOps, totalCapacity } from './utils/ram-pool';

// ---- Tunables -------------------------------------------------------------
const HOME_RESERVE_GB = 32;   // RAM kept free on home for scheduler/go/start
const HACK_GREED = 0.5;       // fraction of target money stolen per batch
const BATCH_GAP_MS = 100;     // landing gap between the 4 ops of a batch
const BATCH_SPACING_MS = 400; // min spacing between consecutive batches
const SHARE_ENABLED = true;
const TICK_MS = 1000;
const PREP_GAP_MS = 200;      // landing gap between the 3 prep ops
// ---------------------------------------------------------------------------

const HACK = 'utils/hack.js';
const GROW = 'utils/grow.js';
const WEAKEN = 'utils/weaken.js';
const SHARE = 'utils/share.js';
const WORKERS = [HACK, GROW, WEAKEN, SHARE];

const PORT_OPENERS = ['BruteSSH.exe', 'FTPCrack.exe', 'relaySMTP.exe', 'HTTPWorm.exe', 'SQLInject.exe'];

export async function main(ns: NS) {
    ns.disableLog('ALL');

    while (true) {
        const all = scanAll(ns);

        // Root + deploy workers everywhere we can (guarded; never throws the loop).
        for (const host of all) {
            if (ensureRoot(ns, host)) deployWorkers(ns, host);
        }

        const rooted = all.filter((h) => ns.hasRootAccess(h));

        // Reclaim share RAM first so hacking always gets first claim this tick.
        // (Share loops forever; freeing it here lets batches expand, then we
        // refill whatever batching leaves over via fillShare below.)
        killAllShare(ns, rooted);

        const pool = buildPool(ns, rooted);
        const target = pickTarget(ns, rooted);

        if (target) {
            scheduleTarget(ns, pool, target);
        }

        if (SHARE_ENABLED) fillShare(ns, pool);

        await ns.sleep(TICK_MS);
    }
}

function killAllShare(ns: NS, rooted: string[]) {
    // Synchronously frees the RAM share was using on every rooted host.
    for (const host of rooted) {
        ns.scriptKill(SHARE, host);
    }
}

// ---- Server discovery / rooting ------------------------------------------

function scanAll(ns: NS): string[] {
    const visited: string[] = [];
    const queue: string[] = ['home'];
    while (queue.length > 0) {
        const host = queue.shift();
        if (host === undefined) continue;
        visited.push(host);
        for (const n of ns.scan(host)) {
            if (!visited.includes(n) && !queue.includes(n)) queue.push(n);
        }
    }
    return visited;
}

function ownedOpeners(ns: NS): number {
    return PORT_OPENERS.filter((p) => ns.fileExists(p, 'home')).length;
}

function ensureRoot(ns: NS, host: string): boolean {
    if (ns.hasRootAccess(host)) return true;
    let open = 0;
    try {
        if (ns.fileExists('BruteSSH.exe', 'home')) { ns.brutessh(host); open++; }
        if (ns.fileExists('FTPCrack.exe', 'home')) { ns.ftpcrack(host); open++; }
        if (ns.fileExists('relaySMTP.exe', 'home')) { ns.relaysmtp(host); open++; }
        if (ns.fileExists('HTTPWorm.exe', 'home')) { ns.httpworm(host); open++; }
        if (ns.fileExists('SQLInject.exe', 'home')) { ns.sqlinject(host); open++; }
        if (open >= ns.getServerNumPortsRequired(host)) ns.nuke(host);
    } catch (e) {
        // A missing program or insufficient ports must never kill the loop.
    }
    return ns.hasRootAccess(host);
}

function deployWorkers(ns: NS, host: string) {
    if (host === 'home') return; // workers already present on home
    for (const w of WORKERS) {
        if (!ns.fileExists(w, host)) ns.scp(w, host, 'home');
    }
}

// ---- RAM pool / target ----------------------------------------------------

function buildPool(ns: NS, rooted: string[]): ServerRam[] {
    const pool: ServerRam[] = [];
    for (const host of rooted) {
        let free = ns.getServerMaxRam(host) - ns.getServerUsedRam(host);
        if (host === 'home') free -= HOME_RESERVE_GB;
        if (free > 0) pool.push({ server: host, freeRam: free });
    }
    // Largest free first reduces fragmentation when placing ops.
    pool.sort((a, b) => b.freeRam - a.freeRam);
    return pool;
}

function pickTarget(ns: NS, rooted: string[]): string {
    const stats: ServerStat[] = rooted.map((name) => ({
        name,
        maxMoney: ns.getServerMaxMoney(name),
        minSecurity: ns.getServerMinSecurityLevel(name),
        requiredHackingLevel: ns.getServerRequiredHackingLevel(name),
        requiredPorts: ns.getServerNumPortsRequired(name),
        hasRoot: ns.hasRootAccess(name),
    }));
    return chooseHackTarget(stats, ns.getHackingLevel(), ownedOpeners(ns));
}

// ---- Scheduling -----------------------------------------------------------

function costs(ns: NS): ThreadCosts {
    return {
        hack: ns.getScriptRam(HACK),
        grow: ns.getScriptRam(GROW),
        weaken: ns.getScriptRam(WEAKEN),
    };
}

function durations(ns: NS, target: string): OpDurations {
    return {
        hackTime: ns.getHackTime(target),
        growTime: ns.getGrowTime(target),
        weakenTime: ns.getWeakenTime(target),
    };
}

function scheduleTarget(ns: NS, pool: ServerRam[], target: string) {
    const minSec = ns.getServerMinSecurityLevel(target);
    const curSec = ns.getServerSecurityLevel(target);
    const maxMoney = ns.getServerMaxMoney(target);
    const curMoney = ns.getServerMoneyAvailable(target);
    if (maxMoney <= 0) return; // nothing worth hacking (e.g. home/cloud)

    const prepped = curSec <= minSec + 0.01 && curMoney >= maxMoney - 1;
    if (prepped) {
        harvest(ns, pool, target);
    } else {
        prep(ns, pool, target, curSec, minSec, curMoney, maxMoney);
    }
}

function prep(
    ns: NS, pool: ServerRam[], target: string,
    curSec: number, minSec: number, curMoney: number, maxMoney: number,
) {
    const c = costs(ns);
    const d = durations(ns, target);
    const weakenPer = ns.weakenAnalyze(1);

    const wToMin = weakenThreadsForSecurity(curSec - minSec, weakenPer);
    const mult = growMultiplier(curMoney, maxMoney);
    const gThreads = mult > 1 ? Math.ceil(ns.growthAnalyze(target, mult)) : 0;
    const growSec = securityIncrease(gThreads, ns.growthAnalyzeSecurity(1));
    const wCover = weakenThreadsForSecurity(growSec, weakenPer);

    // Land order: weaken-to-min, then grow, then weaken-to-cover-grow.
    const off = additionalMsecOffsets(d, PREP_GAP_MS);
    const ops: OpRequest[] = [
        { key: 'weaken1', perThreadCost: c.weaken, threads: wToMin },
        { key: 'grow', perThreadCost: c.grow, threads: gThreads },
        { key: 'weaken2', perThreadCost: c.weaken, threads: wCover },
    ];
    const plan = planOps(pool, ops);
    if (!plan) return; // not enough RAM this tick; share fills the rest
    launchPlan(ns, pool, plan, target, off, 0, { weaken1: WEAKEN, grow: GROW, weaken2: WEAKEN });
}

function harvest(ns: NS, pool: ServerRam[], target: string) {
    const c = costs(ns);
    const d = durations(ns, target);
    const weakenPer = ns.weakenAnalyze(1);

    const hackPct = ns.hackAnalyze(target); // fraction per thread
    const hThreads = hackThreadsForGreed(HACK_GREED, hackPct);
    if (hThreads <= 0) return;
    const hackSec = securityIncrease(hThreads, ns.hackAnalyzeSecurity(1));
    const w1 = weakenThreadsForSecurity(hackSec, weakenPer);

    const refillMult = growMultiplier(ns.getServerMaxMoney(target) * (1 - HACK_GREED), ns.getServerMaxMoney(target));
    const gThreads = Math.ceil(ns.growthAnalyze(target, refillMult));
    const growSec = securityIncrease(gThreads, ns.growthAnalyzeSecurity(1));
    const w2 = weakenThreadsForSecurity(growSec, weakenPer);

    const threads: ThreadCounts = { hack: hThreads, weaken1: w1, grow: gThreads, weaken2: w2 };
    const perBatch = batchRam(threads, c);
    const poolFree = pool.reduce((sum, s) => sum + s.freeRam, 0);
    const n = batchesThatFit(poolFree, perBatch, d.weakenTime, BATCH_SPACING_MS);

    const off = additionalMsecOffsets(d, BATCH_GAP_MS);
    for (let b = 0; b < n; b++) {
        const ops: OpRequest[] = [
            { key: 'hack', perThreadCost: c.hack, threads: threads.hack },
            { key: 'weaken1', perThreadCost: c.weaken, threads: threads.weaken1 },
            { key: 'grow', perThreadCost: c.grow, threads: threads.grow },
            { key: 'weaken2', perThreadCost: c.weaken, threads: threads.weaken2 },
        ];
        const plan = planOps(pool, ops);
        if (!plan) break; // pool exhausted this tick
        launchPlan(ns, pool, plan, target, off, b * BATCH_SPACING_MS, {
            hack: HACK, weaken1: WEAKEN, grow: GROW, weaken2: WEAKEN,
        });
    }
}

/** Exec each op's placements, apply the additionalMsec offset, and debit the pool. */
function launchPlan(
    ns: NS,
    pool: ServerRam[],
    plan: { key: string; placements: { server: string; threads: number }[] }[],
    target: string,
    off: { hack: number; weaken1: number; grow: number; weaken2: number },
    spacing: number,
    scripts: Record<string, string>,
) {
    const offsetFor: Record<string, number> = {
        hack: off.hack, weaken1: off.weaken1, grow: off.grow, weaken2: off.weaken2,
    };
    for (const op of plan) {
        const script = scripts[op.key];
        const addl = Math.round(offsetFor[op.key] + spacing);
        const cost = ns.getScriptRam(script);
        for (const p of op.placements) {
            const pid = ns.exec(script, p.server, p.threads, target, addl);
            if (pid === 0) ns.print(`WARN exec failed: ${script} x${p.threads} on ${p.server}`);
            const entry = pool.find((s) => s.server === p.server);
            if (entry) entry.freeRam -= p.threads * cost;
        }
    }
}

// ---- Share ----------------------------------------------------------------

function fillShare(ns: NS, pool: ServerRam[]) {
    const shareCost = ns.getScriptRam(SHARE);
    const threads = totalCapacity(pool, shareCost);
    if (threads <= 0) return;
    for (const s of pool) {
        const n = Math.floor(s.freeRam / shareCost);
        if (n > 0) {
            ns.exec(SHARE, s.server, n);
            s.freeRam -= n * shareCost;
        }
    }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "Scheduler" || echo "scheduler clean"`
Expected: `scheduler clean`.

- [ ] **Step 3: Verify pure suite still green**

Run: `node --test "test/**/*.test.ts" 2>&1 | grep -E "tests |pass |fail "`
Expected: all pass, 0 fail.

- [ ] **Step 4: Commit**

```bash
git add src/Scheduler.ts
git commit -m "feat: central HGW batch scheduler on home"
```

- [ ] **Step 5: In-game verification (manual)**

Build is auto-deployed by viteburner. In the game:
1. `run Scheduler.js` on home.
2. `tail Scheduler.js` — confirm no thrown errors; occasional `WARN exec failed` is tolerable but should be rare.
3. Watch the chosen target's money climb toward max and security settle at min (prep working), then money oscillate near max as batches harvest.
4. `ps` on a couple of hacked servers — confirm `utils/hack.js`/`grow.js`/`weaken.js` and/or `utils/share.js` are running there (remote RAM is being used).
5. Confirm faction reputation gain rate rises when share is running (leftover RAM in use).

Note: every tick first kills all share workers (reclaiming their RAM), then allocates hacking, then refills the leftover with share — so hacking always gets first claim and share can never starve it. The tradeoff is per-tick exec churn: share threads restart each `TICK_MS`. This is functionally fine (the share bonus depends on threads running *now*, and they are up ~continuously), but if churn is noisy, raise `TICK_MS`. A future optimization (spec "Out of scope") is to kill share only on-demand when a batch cannot be placed, avoiding the churn entirely.

---

### Task 6: Reduce `start.ts` to a bootstrapper

**Files:**
- Modify: `src/start.ts` (replace the per-server BasicController deploy loop with a single scheduler launch; keep cloud buy/upgrade, go, darknet).

**Interfaces:**
- Consumes: launches `Scheduler.js` (Task 5).
- Produces: nothing.

- [ ] **Step 1: Rewrite `src/start.ts`**

```ts
import { NS } from '@ns';

/** @param {NS} ns */
export async function main(ns: NS) {
    let numberCloudServers = 0;
    let numberUpgradedCloudServers = 0;
    let ramForUpgrade = 2 ** 5;

    while (true) {
        // One central scheduler owns rooting, worker deploy, batching and share.
        if (!ns.isRunning('Scheduler.js', 'home')) {
            ns.exec('Scheduler.js', 'home');
        }

        // Checks if Darknet server and runs it.
        const nearbyDarknet = ns.dnet.probe();
        if (nearbyDarknet.length > 0 && !ns.isRunning('utils/darknetvirus.js', nearbyDarknet[0])) {
            ns.scp('utils/darknetvirus.js', nearbyDarknet[0]);
            ns.scp('utils/phishing.js', nearbyDarknet[0]);
            ns.exec('utils/darknetvirus.js', nearbyDarknet[0], { preventDuplicates: true });
        }

        // Checks if Go running and runs it.
        if (!ns.isRunning('utils/go.js')) {
            ns.exec('utils/go.js', ns.getHostname(), { preventDuplicates: true });
        }

        // Buy / upgrade cloud servers (now always reached — no crashing deploy loop above).
        const listCloudServers = ns.cloud.getServerNames();
        numberCloudServers = listCloudServers.length;
        if (numberCloudServers < ns.cloud.getServerLimit()) {
            while (
                ns.getServerMoneyAvailable('home') > ns.cloud.getServerCost(8) &&
                numberCloudServers < ns.cloud.getServerLimit()
            ) {
                ns.cloud.purchaseServer('cloud-server-' + numberCloudServers, 8);
                numberCloudServers++;
                await ns.sleep(400);
            }
        } else if (
            numberCloudServers === ns.cloud.getServerLimit() &&
            numberUpgradedCloudServers < ns.cloud.getServerLimit()
        ) {
            while (
                numberUpgradedCloudServers < ns.cloud.getServerLimit() &&
                ns.getServerMoneyAvailable('home') >
                    ns.cloud.getServerUpgradeCost(listCloudServers[numberUpgradedCloudServers], ramForUpgrade)
            ) {
                ns.cloud.upgradeServer(listCloudServers[numberUpgradedCloudServers], ramForUpgrade);
                numberUpgradedCloudServers++;
                await ns.sleep(400);
            }
        } else if (numberUpgradedCloudServers === ns.cloud.getServerLimit()) {
            if (ramForUpgrade * 2 ** 3 < ns.cloud.getRamLimit()) {
                ramForUpgrade = ramForUpgrade * 2 ** 3;
                numberUpgradedCloudServers = 0;
            }
        }

        await ns.sleep(1000);
    }
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "start.ts" || echo "start clean"`
Expected: `start clean`.

- [ ] **Step 3: In-game verification (manual)**

1. `run start.js` on home.
2. Confirm `Scheduler.js` is running (`ps home`), `utils/go.js` running.
3. Confirm cloud servers begin to be purchased/upgraded as money allows (the block that previously never ran).
4. Confirm no early crash in `tail start.js`.

- [ ] **Step 4: Commit**

```bash
git add src/start.ts
git commit -m "refactor: reduce start.ts to bootstrapper; launch central scheduler"
```

---

## Notes for the executor

- `BasicController.ts` and `target-select.ts` stay as-is; `Scheduler.ts` reuses `chooseHackTarget`. `BasicController.ts` is no longer launched by `start.ts` but is left in the tree (removing it is out of scope).
- If `node --test` reports a flaky unrelated failure, confirm it's pre-existing (e.g. `src/utils/codingcontracts.ts` type errors are pre-existing and unrelated).
