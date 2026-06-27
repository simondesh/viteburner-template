# HGW Batch Scheduler — Design

**Date:** 2026-06-27
**Status:** Approved (design); pending implementation plan

## Problem

Today `start.ts` copies `BasicController` + the three worker scripts to **every** rooted
server, and each server runs an independent controller that dumps all its RAM into a single
naive op (weaken → grow → hack by threshold) against its own chosen target. Consequences:

- **No batch timing.** Ops finish at uncoordinated times; the target bounces between
  hacked-down and grown-back instead of being harvested efficiently.
- **No global view.** Multiple servers pile onto the same target or waste RAM.
- **No share.** Idle compute is never used for `ns.share()` to boost faction reputation.
- **Fragile deploy.** `start.ts`'s deploy loop calls the port openers and `ns.nuke`
  unconditionally with no `try/catch`. The first un-rootable server throws and kills the
  whole loop, so servers later in the scan never receive scripts. (Same unguarded-opener
  bug class already fixed in `BasicController.ts`.)

## Goals

1. Schedule hack/grow/weaken intelligently using each op's **duration** and **effect** to
   maximize revenue.
2. Use **leftover** compute for `ns.share()` to increase faction gains.
3. Treat all rooted servers as one RAM pool, coordinated by a single brain.
4. Keep the tricky math **pure and unit-tested**; keep NS code thin and hard to break.

## Decisions (locked)

| Decision | Choice |
|---|---|
| Architecture | **Central scheduler on `home`.** All rooted + cloud + hacked servers form one RAM pool. Workers become dumb. `start.ts` stops launching a controller per server. |
| Batch style | **Prep then HWGW batches.** Prep target to min-security / max-money, then fire overlapping Hack-Weaken-Grow-Weaken batches that land in order and fill the pool. |
| Timing | **`additionalMsec`**, not `ns.sleep`. The game pads each op's own completion timer, so landings are precise and not subject to `ns.sleep` tick drift. |
| Share policy | **Leftover RAM only.** Hacking claims RAM first; share fills the remainder and is killed first to reclaim RAM. |
| Target scope | **Single best target.** Easy to extend to multi-target later. |
| RAM costs | **Read at runtime** via `ns.getScriptRam`; never hardcoded. |

## Architecture & components

Pure-core + thin-NS-shell pattern (mirrors existing `go-engine` / `target-select`).

| File | Role | Tested |
|---|---|---|
| `src/utils/hgw-math.ts` | **Pure.** Thread counts (grow to restore money ratio, weaken to cancel a security bump, hack threads for a money %), per-op `additionalMsec` offsets, "how many batches fit". All NS analyze values are inputs. | ✅ `node --test` |
| `src/utils/ram-pool.ts` | **Pure.** Given `{server, freeRam}[]` + per-thread cost + thread count, return a placement list (may split across servers) or "doesn't fit". | ✅ `node --test` |
| `src/Scheduler.ts` | **Thin NS shell on `home`.** Builds pool from NS, calls pure planners, `exec`s workers, sleeps, repeats. Guards rooting + scp/deploy. | in-game |
| `src/utils/hack.ts` / `grow.ts` / `weaken.ts` | Dumb workers, one op each. `args = [target, additionalMsec]` → `await ns.<op>(target, { additionalMsec })`. ~1.7–1.75 GB/thread. | n/a |
| `src/utils/share.ts` | Dumb worker, loops `ns.share()`. | n/a |
| `src/start.ts` | Reduced to: guarded root + scp workers everywhere, buy/upgrade cloud, launch `Scheduler.js` + `go.js`. | thin |

**Why 3 workers, not 1:** Bitburner charges a script `1.6 GB base + sum of referenced NS
functions`. A combined hack+grow+weaken script costs 2.0 GB/thread vs 1.7 GB for a
single-op hack worker. Across thousands of threads that tax is real lost capacity. Three
minimal single-op workers is RAM-optimal.

## Data flow (one scheduler tick)

The scheduler re-derives everything each tick, so it self-heals on level-ups, new servers,
and desyncs.

1. **Build pool.** Scan → keep rooted servers → `freeRam = maxRam − usedRam`. Reserve a
   configurable amount on `home` (scheduler, `go.js`, `start.js`). Sum = hackable pool.
2. **Pick target.** Best single target by a batch-aware score (≈ money/sec at min-sec),
   reusing the in-level + rootable filters from `target-select`.
3. **Prep vs harvest:**
   - **Not prepped** (sec > min or money < max) → schedule grow + weaken waves toward
     min-sec / max-money. No hacking yet.
   - **Prepped** → harvest with HWGW batches.
4. **One HWGW batch** = Hack (steal a configurable % of money) · Weaken₁ (cancel hack's
   security bump) · Grow (refill to max) · Weaken₂ (cancel grow's security bump). Each op
   carries an `additionalMsec` so the four **land** in order H→W₁→G→W₂, separated by a
   small tunable gap (~100 ms) for jitter tolerance. The scheduler `exec`s all four
   back-to-back; the longest op (weaken) sets the baseline and shorter ops get larger
   `additionalMsec`.
5. **Fill RAM.** `batchRam` = sum of the 4 ops' thread costs. Concurrent batches =
   `min(poolForHacking / batchRam, weakenTime / batchGap)`. `ram-pool` places each op's
   threads across servers with room (ops may split; all target the same server, same
   landing time).
6. **Leftover → share.** Remaining pool RAM is filled with `share.js`
   (`leftover / shareThreadCost`). Re-tuned only when leftover changes materially; share
   workers are killed first to reclaim RAM for hacking.
7. **Sleep** one batch-gap interval, repeat.

## Error handling & robustness

- **Guarded rooting/deploy.** `fileExists` before each opener, `try/catch` around
  opener+`nuke`, `nuke` only when open ports ≥ required. One un-rootable server can never
  crash the loop.
- **Verify placement.** Check `ns.exec` PID (0 = failure); log misfires instead of
  assuming success. The allocator only proposes placements that fit, so this is a safety
  net.
- **Self-healing.** Full re-derivation each tick; a desynced batch simply shows up as
  "not prepped" next tick and is re-prepped.
- **Priorities.** Hacking claims RAM first; share fills remainder and is killed first.
  `home` keeps a configurable reserve.

## Configuration knobs (constants, surfaced at top of `Scheduler.ts`)

- `HOME_RESERVE_GB` — RAM kept free on home.
- `HACK_GREED` — fraction of target money stolen per batch (e.g. 0.5).
- `BATCH_GAP_MS` — inter-op landing gap (~100 ms).
- `SHARE_ENABLED` — master toggle for share.

## Testing

- `hgw-math.ts` — pure `node --test`: grow-threads restore a money ratio; weaken-threads
  cancel a given security bump; `additionalMsec` offsets land H→W₁→G→W₂ in order;
  "batches that fit" respects pool RAM and the weaken-time/gap cap. NS analyze values are
  inputs → deterministic.
- `ram-pool.ts` — pure `node --test`: packs N threads across servers, splits across
  servers, returns "doesn't fit" correctly, respects per-server capacity.
- `Scheduler.ts` / workers / `start.ts` — thin NS shells, verified in-game.

## Out of scope (future)

- Multi-target batching (spread batches across top-N targets when one target can't absorb
  the pool).
- Stock-market integration (`stock: true` HGW option).
- Faction-aware share gating (only share while working for a faction; needs Singularity).
- Absolute-timestamp self-correcting `additionalMsec` (worker recomputes from actual start).
