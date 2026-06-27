import { NS } from '@ns';

/** Dumb hack worker. args: [target, additionalMsec]. One ns function => 1.7 GB/thread. */
export async function main(ns: NS) {
    const target = ns.args[0] as string;
    const additionalMsec = (ns.args[1] as number) ?? 0;
    await ns.hack(target, { additionalMsec });
}