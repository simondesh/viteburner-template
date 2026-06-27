import { NS } from '@ns';

/** Dumb grow worker. args: [target, additionalMsec]. */
export async function main(ns: NS) {
    const target = ns.args[0] as string;
    const additionalMsec = (ns.args[1] as number) ?? 0;
    await ns.grow(target, { additionalMsec });
}
