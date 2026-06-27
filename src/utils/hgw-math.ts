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
