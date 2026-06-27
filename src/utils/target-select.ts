// Pure target-selection logic for the basic hack/grow/weaken controller.
// No NS dependency, so it can be unit-tested in isolation (see target-select.test.ts).

export interface ServerStat {
    name: string;
    maxMoney: number;
    minSecurity: number;
    requiredHackingLevel: number;
}

/**
 * Pick the best server to farm, given our current hacking level.
 *
 * Hard rule first: a server whose required hacking level exceeds ours is
 * unhackable, so it is never a candidate no matter how much money it holds.
 * (The previous scoring only *penalised* the level gap, so a rich high-level
 * server could still win — which is why the bot kept targeting servers it
 * could not actually hack.)
 *
 * Among the reachable, worth-hacking servers, prefer the best money-to-security
 * ratio: the most money for the least weakening/growing effort.
 */
export const chooseHackTarget = (
    servers: ServerStat[],
    hackingLevel: number,
    fallback = 'n00dles',
): string => {
    let best = fallback;
    let bestScore = -Infinity;

    for (const server of servers) {
        if (server.requiredHackingLevel > hackingLevel) continue; // out of reach
        if (server.maxMoney <= 0) continue;                       // nothing to take
        if (server.minSecurity <= 0) continue;                    // guard divide-by-zero

        const score = server.maxMoney / server.minSecurity;
        if (score > bestScore) {
            bestScore = score;
            best = server.name;
        }
    }

    return best;
};
