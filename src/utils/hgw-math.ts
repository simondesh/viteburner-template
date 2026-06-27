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
