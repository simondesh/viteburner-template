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
