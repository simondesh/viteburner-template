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
import { ServerRam, OpRequest, placeThreads, planOps, totalCapacity } from './utils/ram-pool';

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

        scheduleTarget(ns, pool, target);

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
    const off = additionalMsecOffsets(d, PREP_GAP_MS);

    // Priority 1: weaken toward min security.
    const wToMin = weakenThreadsForSecurity(curSec - minSec, weakenPer);
    placeOpBestEffort(ns, pool, WEAKEN, c.weaken, wToMin, target, off.weaken1);

    // Priority 2: grow toward max money with whatever RAM remains.
    const mult = growMultiplier(curMoney, maxMoney);
    const gDesired = mult > 1 ? Math.ceil(ns.growthAnalyze(target, mult)) : 0;
    const gPlaced = placeOpBestEffort(ns, pool, GROW, c.grow, gDesired, target, off.grow);

    // Priority 3: cover-weaken sized to the grow threads ACTUALLY placed this tick.
    const growSec = securityIncrease(gPlaced, ns.growthAnalyzeSecurity(1));
    const wCover = weakenThreadsForSecurity(growSec, weakenPer);
    placeOpBestEffort(ns, pool, WEAKEN, c.weaken, wCover, target, off.weaken2);
}

/** Place up to `desiredThreads` of one op across the pool (as many as fit),
 *  exec them with the timing offset, debit the pool, and return how many ran. */
function placeOpBestEffort(
    ns: NS, pool: ServerRam[], script: string, costPerThread: number,
    desiredThreads: number, target: string, addlMsec: number,
): number {
    if (desiredThreads <= 0) return 0;
    const n = Math.min(desiredThreads, totalCapacity(pool, costPerThread));
    if (n <= 0) return 0;
    const placements = placeThreads(pool, costPerThread, n);
    if (!placements) return 0;
    for (const p of placements) {
        const pid = ns.exec(script, p.server, p.threads, target, Math.round(addlMsec));
        if (pid === 0) ns.print(`WARN exec failed: ${script} x${p.threads} on ${p.server}`);
        const entry = pool.find((s) => s.server === p.server);
        if (entry) entry.freeRam -= p.threads * costPerThread;
    }
    return n;
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
