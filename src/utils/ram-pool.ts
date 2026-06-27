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
