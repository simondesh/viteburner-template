import { NS } from '@ns';

export async function main(ns: NS) {
    const target = ns.args[0] as string;
    // // obtain root access
    // ns.brutessh(target)
    // ns.ftpcrack(target)
    // ns.relaysmtp(target)
    // ns.httpworm(target)
    // ns.sqlinject(target)
    // ns.nuke(target)

    await ns.grow(target);
}