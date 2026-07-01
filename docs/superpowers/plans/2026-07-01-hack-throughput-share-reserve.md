# Hack-Throughput Targeting + Gated Share Reserve Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rank hack targets by money-per-second throughput (so slow servers stop being chosen), and guarantee 20% of the RAM pool to `ns.share()` once the farm exceeds 1 TB of free RAM.

**Architecture:** Two pure, unit-tested modules change their scoring logic (`target-select.ts`, `ram-pool.ts`); the NS shell `Scheduler.ts` feeds them the live/Formulas data and applies the share-reserve tick flow. The Formulas API is used only when `Formulas.exe` is owned, with a live-NS fallback for the early game.

**Tech Stack:** TypeScript, Bitburner (modded) NS API, viteburner, Node 26 `node --test`.

## Global Constraints

- `src/utils/target-select.ts` and `src/utils/ram-pool.ts` MUST NOT import `@ns` or reference `ns.*` (pure modules).
- Tests live in top-level `test/` and import source with an explicit `.ts` extension; run with `node --test "test/**/*.test.ts"`.
- Throughput score is exactly `maxMoney * hackChance / weakenTime`. Higher wins.
- Hard gates in `chooseHackTarget` are unchanged in meaning: skip if `requiredHackingLevel > hackingLevel`; skip if `!hasRoot && requiredPorts > portOpeners`; skip if `maxMoney <= 0`. New guard: skip if `weakenTime <= 0`.
- Share reserve: `SHARE_RAM_THRESHOLD_GB = 1024`, `SHARE_RESERVE_FRACTION = 0.20`, threshold is **strictly greater** (`total > 1024`). Still gated by the existing `SHARE_ENABLED`.
- **Fallback is mandatory:** in `pickTarget`, use `ns.formulas.hacking.*` ONLY when `ns.fileExists('Formulas.exe', 'home')`; otherwise use live `ns.getWeakenTime` / `ns.hackAnalyzeChance`. The bot must work with no Formulas.exe (early game).
- Formulas signatures verified against `NetscriptDefinitions.d.ts`: `formulas.hacking.weakenTime(server: Server, player: Person)` and `formulas.hacking.hackChance(server: Server, player: Person)`; `getServer(host): Server`; `getPlayer(): Player`. `Server.hackDifficulty` / `minDifficulty` / `moneyMax` are optional (`number | undefined`).
- Commit after every task. Work on branch `feat/hack-throughput-share-reserve` (already checked out); do NOT create a new branch.

---

### Task 1: Throughput target scoring (pure)

**Files:**
- Modify: `src/utils/target-select.ts`
- Modify: `test/target-select.test.ts`

**Interfaces:**
- Consumes: nothing new (pure).
- Produces: `ServerStat` with fields `{ name: string; maxMoney: number; weakenTime: number; hackChance: number; requiredHackingLevel: number; requiredPorts: number; hasRoot: boolean }` (note: `minSecurity` is REMOVED, `weakenTime` + `hackChance` ADDED). `chooseHackTarget(servers: ServerStat[], hackingLevel: number, portOpeners: number, fallback?: string): string` scores by `maxMoney * hackChance / weakenTime`.

- [ ] **Step 1: Rewrite the test file to the new `ServerStat` shape and behavior**

Replace the ENTIRE contents of `test/target-select.test.ts` with:

```ts
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/target-select.test.ts"`
Expected: FAIL — the current `ServerStat` has `minSecurity` (not `weakenTime`/`hackChance`), and the current score is `maxMoney / minSecurity`, so the throughput and guard tests fail (and TS type errors on the new `s()` fields).

- [ ] **Step 3: Rewrite `target-select.ts` to the throughput score**

Replace the ENTIRE contents of `src/utils/target-select.ts` with:

```ts
// Pure target-selection logic for the basic hack/grow/weaken controller.
// No NS dependency, so it can be unit-tested in isolation (see target-select.test.ts).

export interface ServerStat {
    name: string;
    maxMoney: number;
    /** Weaken time in ms — the dominant op time; stands in for cycle length. */
    weakenTime: number;
    /** Probability a single hack succeeds (0–1). */
    hackChance: number;
    requiredHackingLevel: number;
    /** Number of open ports nuke() needs before it will grant root. */
    requiredPorts: number;
    /** Whether we already have root on this server. */
    hasRoot: boolean;
}

/**
 * Pick the best server to farm, given our current hacking level and how many
 * port-opener programs we own.
 *
 * Two hard rules first, because a server that fails either is useless no matter
 * how rich it is:
 *   1. Its required hacking level must not exceed ours.
 *   2. We must be able to root it *now* — either we already have root, or we own
 *      at least as many port openers as it requires. Without this the bot would
 *      keep picking a rich server it cannot nuke, the controller's root gate
 *      would skip every cycle, and nothing would ever get hacked.
 *
 * Among the servers that pass, prefer the best THROUGHPUT — money per second:
 * maxMoney * hackChance / weakenTime. This demotes rich-but-slow servers whose
 * long cycle time makes them unprofitable in practice.
 */
export const chooseHackTarget = (
    servers: ServerStat[],
    hackingLevel: number,
    portOpeners: number,
    fallback = 'n00dles',
): string => {
    let best = fallback;
    let bestScore = -Infinity;

    for (const server of servers) {
        if (server.requiredHackingLevel > hackingLevel) continue;        // out of reach
        if (!server.hasRoot && server.requiredPorts > portOpeners) continue; // can't root yet
        if (server.maxMoney <= 0) continue;                              // nothing to take
        if (server.weakenTime <= 0) continue;                           // guard divide-by-zero

        const score = (server.maxMoney * server.hackChance) / server.weakenTime;
        if (score > bestScore) {
            bestScore = score;
            best = server.name;
        }
    }

    return best;
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/target-select.test.ts" 2>&1 | grep -E "tests |pass |fail "`
Expected: all pass, 0 fail.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "target-select|Scheduler" || echo "clean"`
Expected: `Scheduler.ts` will report errors here (it still builds the OLD `ServerStat` with `minSecurity`) — that is expected and fixed in Task 2. `target-select.ts` itself must NOT appear. If only `Scheduler.ts` errors appear (about `minSecurity` / missing `weakenTime`/`hackChance`), that is correct; proceed.

- [ ] **Step 6: Commit**

```bash
git add src/utils/target-select.ts test/target-select.test.ts
git commit -m "feat: throughput-based target scoring (money per second)"
```

---

### Task 2: Wire throughput fields into pickTarget with Formulas + fallback

**Files:**
- Modify: `src/Scheduler.ts:128-138` (the `pickTarget` function)

**Interfaces:**
- Consumes: `ServerStat` and `chooseHackTarget` from Task 1 (already imported at the top of `Scheduler.ts`).
- Produces: a `pickTarget(ns: NS, rooted: string[]): string` that fills `weakenTime` + `hackChance` from Formulas when owned, else from live NS calls.

> **Note on testability:** `pickTarget` is an NS shell (it calls `ns.*`), so it is not unit-tested. Its pure dependency (`chooseHackTarget`) is fully tested in Task 1. The gate for this task is a clean type-check plus the in-game verification at the end of the plan. This is the fallback-critical task — the Formulas branch and the live fallback must both be present and correct.

- [ ] **Step 1: Replace `pickTarget`**

Replace the existing `pickTarget` function (currently `Scheduler.ts:128-138`) with:

```ts
function pickTarget(ns: NS, rooted: string[]): string {
    // Steady-state (min-security) throughput needs an accurate weaken time and
    // hack chance. With Formulas.exe we evaluate them AT min security directly.
    // Without it (early game) we fall back to live readings, which reflect the
    // server's CURRENT security and converge to the same values once prepped.
    const hasFormulas = ns.fileExists('Formulas.exe', 'home');
    const player = hasFormulas ? ns.getPlayer() : null;

    const stats: ServerStat[] = rooted.map((name) => {
        let weakenTime: number;
        let hackChance: number;
        if (hasFormulas && player) {
            const srv = ns.getServer(name);
            srv.hackDifficulty = srv.minDifficulty; // evaluate as if fully prepped
            weakenTime = ns.formulas.hacking.weakenTime(srv, player);
            hackChance = ns.formulas.hacking.hackChance(srv, player);
        } else {
            weakenTime = ns.getWeakenTime(name);
            hackChance = ns.hackAnalyzeChance(name);
        }
        return {
            name,
            maxMoney: ns.getServerMaxMoney(name),
            weakenTime,
            hackChance,
            requiredHackingLevel: ns.getServerRequiredHackingLevel(name),
            requiredPorts: ns.getServerNumPortsRequired(name),
            hasRoot: ns.hasRootAccess(name),
        };
    });
    return chooseHackTarget(stats, ns.getHackingLevel(), ownedOpeners(ns));
}
```

- [ ] **Step 2: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "Scheduler|target-select" || echo "clean"`
Expected: `clean`. (If `getPlayer()` returns `Player` and the formulas param is `Person`, this compiles because `Player extends Person`. If tsc reports the `srv.hackDifficulty = srv.minDifficulty` assignment as an error, both are `number | undefined` so it should not — do not add a cast unless tsc demands it.)

- [ ] **Step 3: Run the whole test suite (nothing should regress)**

Run: `node --test "test/**/*.test.ts" 2>&1 | grep -E "tests |pass |fail "`
Expected: all pass, 0 fail (Task 1 tests now green; no other suite touched).

- [ ] **Step 4: Commit**

```bash
git add src/Scheduler.ts
git commit -m "feat: feed throughput fields to pickTarget (Formulas with live fallback)"
```

---

### Task 3: Share-reserve helpers (pure)

**Files:**
- Modify: `src/utils/ram-pool.ts`
- Modify: `test/ram-pool.test.ts`

**Interfaces:**
- Consumes: `ServerRam` (`{ server: string; freeRam: number }`), `Placement` (`{ server: string; threads: number }`), `serverCapacity` — all already in `ram-pool.ts`.
- Produces:
  - `shareReserveGb(totalRam: number, thresholdGb: number, fraction: number): number` → `totalRam > thresholdGb ? totalRam * fraction : 0`.
  - `planShare(pool: ServerRam[], shareCost: number, budgetGb: number): Placement[]` → distributes up to `budgetGb` RAM into share threads across the pool in the given order, `floor` per host, stopping when the budget is spent. `budgetGb = Infinity` fills the whole pool.

- [ ] **Step 1: Write the failing tests**

Add to `test/ram-pool.test.ts`. First extend the import to include the two new functions:

```ts
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
```

Then append these tests:

```ts
test('shareReserveGb: zero at or below the threshold, a fraction of total above it', () => {
    // fraction 0.5 is exact in binary, so the assertions have no float wobble.
    assert.equal(shareReserveGb(1000, 1024, 0.5), 0);    // below -> 0
    assert.equal(shareReserveGb(1024, 1024, 0.5), 0);    // exactly at -> strict > -> 0
    assert.equal(shareReserveGb(2000, 1024, 0.5), 1000); // above -> 50% of total
});

test('planShare: distributes up to the budget, largest server first', () => {
    // shareCost 4, budget 40 -> 10 threads; server a (cap 25) absorbs all 10.
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
```

- [ ] **Step 2: Run the tests to verify they fail**

Run: `node --test "test/ram-pool.test.ts"`
Expected: FAIL — `shareReserveGb` and `planShare` are not exported.

- [ ] **Step 3: Implement the two helpers**

Append to `src/utils/ram-pool.ts` (after `planOps`):

```ts
/**
 * How much RAM to guarantee to share this tick: a fraction of the pool once the
 * pool's total free RAM exceeds the threshold, otherwise nothing. Threshold is
 * strict (> not >=), so a farm exactly at the threshold reserves nothing.
 */
export const shareReserveGb = (
    totalRam: number,
    thresholdGb: number,
    fraction: number,
): number => (totalRam > thresholdGb ? totalRam * fraction : 0);

/**
 * Distribute up to `budgetGb` of RAM into whole share threads across the pool,
 * filling servers in the given order (floor per host). Stops once the budget is
 * spent. Pass `budgetGb = Infinity` to fill every server. Returns the placement
 * list ([] if nothing fits within the budget).
 */
export const planShare = (
    pool: ServerRam[],
    shareCost: number,
    budgetGb: number,
): Placement[] => {
    if (shareCost <= 0) return [];
    const placements: Placement[] = [];
    let remaining = budgetGb;
    for (const s of pool) {
        if (remaining < shareCost) break;
        const affordable = serverCapacity(s.freeRam, shareCost);
        const byBudget = Math.floor(remaining / shareCost);
        const n = Math.min(affordable, byBudget);
        if (n > 0) {
            placements.push({ server: s.server, threads: n });
            remaining -= n * shareCost;
        }
    }
    return placements;
};
```

- [ ] **Step 4: Run the tests to verify they pass**

Run: `node --test "test/**/*.test.ts" 2>&1 | grep -E "tests |pass |fail "`
Expected: all pass, 0 fail.

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "ram-pool" || echo "ram-pool clean"`
Expected: `ram-pool clean`.

- [ ] **Step 6: Commit**

```bash
git add src/utils/ram-pool.ts test/ram-pool.test.ts
git commit -m "feat: share-reserve helpers (shareReserveGb, planShare)"
```

---

### Task 4: Wire the share reserve into the Scheduler tick

**Files:**
- Modify: `src/Scheduler.ts` (imports, `SHARE_*` constants, `main()` tick tail, replace `fillShare` with `execShare`)

**Interfaces:**
- Consumes: `shareReserveGb`, `planShare` from Task 3; existing `ServerRam`, `SHARE`, `SHARE_ENABLED`, `buildPool`, `pickTarget`, `scheduleTarget`.
- Produces: reserve-aware share allocation in `main()`.

> **Note on testability:** this is an NS shell change; the pure logic it calls (`shareReserveGb`, `planShare`) is tested in Task 3. Gate: clean type-check, full suite still green, and in-game verification.

- [ ] **Step 1: Extend the ram-pool import**

Replace this line (currently `Scheduler.ts:15`):

```ts
import { ServerRam, OpRequest, placeThreads, planOps, totalCapacity } from './utils/ram-pool';
```

with:

```ts
import { ServerRam, OpRequest, placeThreads, planOps, totalCapacity, shareReserveGb, planShare } from './utils/ram-pool';
```

- [ ] **Step 2: Add the two share constants**

Immediately after the `SHARE_ENABLED = true;` line in the tunables block (currently `Scheduler.ts:22`), add:

```ts
const SHARE_RAM_THRESHOLD_GB = 1024; // reserve for share only once total free RAM exceeds 1 TB
const SHARE_RESERVE_FRACTION = 0.20; // fraction of the pool guaranteed to share above the threshold
```

- [ ] **Step 3: Replace the `main()` tick tail (reserve → schedule → mop-up)**

Replace this block in `main()` (currently `Scheduler.ts:53-60`):

```ts
        const pool = buildPool(ns, rooted);
        const target = pickTarget(ns, rooted);

        scheduleTarget(ns, pool, target);

        if (SHARE_ENABLED) fillShare(ns, pool);

        await ns.sleep(TICK_MS);
```

with:

```ts
        const pool = buildPool(ns, rooted);
        const target = pickTarget(ns, rooted);

        // On a large farm (>1 TB free RAM) guarantee a slice to share BEFORE
        // scheduling, taken from the SMALLEST servers first (reversed pool) so the
        // big contiguous blocks stay free for batch packing. The reversed array
        // shares element objects with `pool`, so the debit inside execShare shrinks
        // the same pool the scheduler then sees (~80%).
        const shareCost = ns.getScriptRam(SHARE);
        const totalFree = pool.reduce((sum, s) => sum + s.freeRam, 0);
        const reserve = shareReserveGb(totalFree, SHARE_RAM_THRESHOLD_GB, SHARE_RESERVE_FRACTION);
        if (SHARE_ENABLED && reserve > 0) {
            execShare(ns, [...pool].reverse(), shareCost, reserve);
        }

        scheduleTarget(ns, pool, target);

        // Mop up whatever batching left over (today's behavior, and the only share
        // below the threshold).
        if (SHARE_ENABLED) execShare(ns, pool, shareCost, Infinity);

        await ns.sleep(TICK_MS);
```

- [ ] **Step 4: Replace `fillShare` with `execShare`**

Replace the entire `fillShare` function (currently `Scheduler.ts:282-293`):

```ts
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

with:

```ts
/** Launch share up to a RAM budget across `order`, debiting each server's freeRam
 *  (so a later schedule/mop-up sees the reduced pool). budgetGb = Infinity fills all. */
function execShare(ns: NS, order: ServerRam[], shareCost: number, budgetGb: number) {
    for (const p of planShare(order, shareCost, budgetGb)) {
        ns.exec(SHARE, p.server, p.threads);
        const entry = order.find((s) => s.server === p.server);
        if (entry) entry.freeRam -= p.threads * shareCost;
    }
}
```

- [ ] **Step 5: Type-check**

Run: `npx tsc --noEmit -p tsconfig.json 2>&1 | grep -E "Scheduler" || echo "Scheduler clean"`
Expected: `Scheduler clean`. (If tsc flags `totalCapacity` as unused, confirm it is still used by `placeOpBestEffort` — it is, so no change needed. Do not remove the import.)

- [ ] **Step 6: Run the whole test suite**

Run: `node --test "test/**/*.test.ts" 2>&1 | grep -E "tests |pass |fail "`
Expected: all pass, 0 fail.

- [ ] **Step 7: Commit**

```bash
git add src/Scheduler.ts
git commit -m "feat: reserve 20% of a >1TB pool for share (smallest-servers-first)"
```

---

### In-game verification (manual — for the human)

1. `run Scheduler.js` (or `run start.js`); `tail Scheduler.js`.
2. **Early game / no Formulas.exe:** confirm the Scheduler still starts and picks a sensible target (fallback path via `getWeakenTime`/`hackAnalyzeChance`). If `Scheduler.js` fails to start for lack of RAM, note that the new NS references (`getServer` ~2 GB, `getPlayer` ~0.5 GB, `hackAnalyzeChance` ~1 GB) raised its static footprint — raise home RAM or bump `HOME_RESERVE_GB`.
3. **Throughput:** confirm the bot prefers fast, profitable servers over rich-but-slow ones (watch which target `tail` reports; it should no longer sit on a high-security giant with minute-long cycles).
4. **With Formulas.exe:** confirm targeting still behaves (min-security evaluation) and improves once owned.
5. **Share reserve:** once total free RAM exceeds 1 TB, confirm ~20% of RAM runs `share.js` even while hacking wants more; below 1 TB, confirm share only mops up leftovers. Watch `ps` across hosts.

---

## Notes for the executor

- `chooseHackTarget` and the `ram-pool` helpers are pure — never import `@ns` there.
- The throughput score drops `minSecurity` from `ServerStat` entirely; make sure no other code references `stat.minSecurity` (only `pickTarget` builds `ServerStat`, and Task 2 rewrites it).
- The reversed-pool trick in Task 4 relies on `[...pool].reverse()` sharing element object references with `pool` (shallow copy), so `execShare`'s debit propagates to the scheduler's view. Do not deep-copy there.
- `Scheduler.ts` is the only NS shell touched; `target-select.ts` and `ram-pool.ts` stay pure and carry the unit tests.
