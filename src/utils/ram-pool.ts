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
