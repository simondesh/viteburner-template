# Hack-Throughput Targeting + Gated Share Reserve — Design

**Date:** 2026-07-01
**Status:** Approved (design) — user signed off on both parts.

## Problem

Two independent tuning gaps in the hacking controller (`Scheduler.ts` + its pure helpers):

1. **Target selection ignores time.** `chooseHackTarget` scores servers by
   `maxMoney / minSecurity`. A rich, high-security server can win that score yet take
   minutes per weaken/hack cycle, so its money-per-second is poor — "sometimes they take
   so long to hack that they are not really profitable."
2. **Share allocation is undifferentiated.** `fillShare` already dumps *all* leftover pool
   RAM into `share.js` every tick, but there is no deliberate reservation: on a large farm
   the user wants a guaranteed slice of RAM going to `ns.share()` (faction-rep boost) rather
   than only whatever hacking happens to leave over.

## Goals

1. Rank hack targets by **throughput** (money per second), so slow servers sink regardless
   of raw wealth.
2. On a large farm (**overall free RAM > 1 TB**), **guarantee 20%** of the pool to share;
   below that, keep today's leftover-mop behavior.

## Decisions (locked)

### Part A — Throughput target scoring

- **Pure core** stays in `src/utils/target-select.ts` (NS-free, unit-tested).
- `ServerStat` **gains** `weakenTime: number` (ms) and `hackChance: number` (0–1), and
  **drops** `minSecurity` (the new score does not use it).
- **Score = `maxMoney * hackChance / weakenTime`** (money per second). Higher wins.
- Hard gates unchanged — a server failing any of these is skipped no matter how it scores:
  1. `requiredHackingLevel <= hackingLevel`
  2. `hasRoot || requiredPorts <= portOpeners`
  3. `maxMoney > 0`
  - **New guard:** `weakenTime > 0` (divide-by-zero safety).
- Fallback remains `'n00dles'`.
- **NS shell** `pickTarget` in `Scheduler.ts` fills the two new fields:
  - **If `Formulas.exe` exists on `home`:** `const srv = ns.getServer(name); srv.hackDifficulty
    = srv.minDifficulty;` then `ns.formulas.hacking.weakenTime(srv, player)` and
    `ns.formulas.hacking.hackChance(srv, player)` (with `player = ns.getPlayer()`). This
    yields the **steady-state** (min-security) numbers, so scoring is not fooled by an
    unprepped server's inflated timers. Signatures verified against
    `NetscriptDefinitions.d.ts` (`HackingFormulas.weakenTime/hackChance(server: Server,
    player: Person)`).
  - **Else:** live `ns.getWeakenTime(name)` and `ns.hackAnalyzeChance(name)`
    (current-security approximations; they converge to the min-security values once the
    server is prepped).

### Part B — Gated share reserve

- **Pure helpers** added to `src/utils/ram-pool.ts` (NS-free, unit-tested):
  - `shareReserveGb(totalRam, thresholdGb, fraction): number` →
    `totalRam > thresholdGb ? totalRam * fraction : 0`. Boundary is **strictly greater**
    ("more than 1 TB").
  - `planShare(pool, shareCost, budgetGb): { server: string; threads: number }[]` →
    distributes up to `budgetGb` of RAM into share threads across the pool, `floor` per host,
    stopping once the budget is spent. `budgetGb = Infinity` fills the whole pool.
- **Tick-flow change** in `Scheduler.main()` (replaces the single
  `if (SHARE_ENABLED) fillShare(ns, pool)` at the end):
  1. After `buildPool`, compute `total = Σ pool.freeRam` (overall free RAM this tick).
  2. `reserve = shareReserveGb(total, SHARE_RAM_THRESHOLD_GB, SHARE_RESERVE_FRACTION)` — `0`
     unless `total > 1 TB`.
  3. If `SHARE_ENABLED && reserve > 0`: exec share for `reserve` GB, **taking RAM from the
     smallest servers first** (iterate the pool in reverse of the largest-first sort) so big
     contiguous blocks stay free for batch packing; debit the pool. Scheduling now sees ~80%.
  4. `scheduleTarget(ns, pool, target)` on the remaining pool.
  5. If `SHARE_ENABLED`: mop-up share on all remaining leftover (today's behavior).
  - Net effect: share gets **≥ 20%** of the pool above 1 TB, and **= leftovers** below it.
- Constants in `Scheduler.ts`: `SHARE_RAM_THRESHOLD_GB = 1024`,
  `SHARE_RESERVE_FRACTION = 0.20`. The existing `SHARE_ENABLED` flag still gates all share.

**Rationale for "overall free RAM this tick":** the reserve is carved from the RAM actually
being allocated, so it can never exceed what exists, and on a large steady farm the free pool
is large too. (Capacity-based was considered and rejected as harder to keep self-consistent.)

### Deferred / out of scope

- Multi-target hacking, `$/sec/GB` RAM-efficiency scoring, and faction-work detection for
  share (Singularity) — all considered during brainstorming and explicitly not in this
  iteration.

## Architecture & components

| File | Change |
|---|---|
| `src/utils/target-select.ts` | `ServerStat` fields (`+weakenTime,+hackChance,−minSecurity`); score = `maxMoney*hackChance/weakenTime`; `weakenTime>0` guard. Pure. |
| `src/utils/ram-pool.ts` | `shareReserveGb`, `planShare`. Pure. |
| `src/Scheduler.ts` | `pickTarget` fills `weakenTime`/`hackChance` (Formulas-if-owned, else live); share-reserve tick flow + two constants. NS shell. |
| `test/target-select.test.ts` | Rewrite for new `ServerStat`; throughput + guard tests; keep gate tests. |
| `test/ram-pool.test.ts` | `shareReserveGb` boundary + `planShare` distribution tests. |

## Testing

- **Target (Part A):** fast-modest server beats slow-rich; `hackChance` weights the score
  (lower chance loses at equal money/time); `weakenTime <= 0` is skipped (guard); existing
  level / ports / root / `maxMoney>0` gate tests preserved; fallback still `n00dles`.
- **Share (Part B):** `shareReserveGb` — `≤ 1024 → 0`, `= 1024 → 0` (strict), `> 1024 →
  0.20 * total`; `planShare` — respects a finite budget, floors threads per host, `Infinity`
  budget fills the pool, returns empty when budget `< shareCost`.
- Existing engine/ladder/hgw-math tests stay green; `tsc --noEmit` clean for changed files.

## Performance / safety

`ns.getServer` per candidate each tick is a static-RAM cost (counted once in the script
footprint, well under the 32 GB home reserve), not a per-call charge; iterating ~50–100
servers per tick is negligible. Formulas calls are free once `Formulas.exe` is owned. The
share-reserve change is pure arithmetic plus the existing exec/debit loop. No new failure
modes; all NS calls remain inside the guarded scheduler loop.
