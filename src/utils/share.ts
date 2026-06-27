import { NS } from '@ns';

/** Dumb share worker: boosts faction reputation gains until killed. */
export async function main(ns: NS) {
    while (true) {
        await ns.share();
    }
}
