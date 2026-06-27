import { NS } from '@ns';

/** @param {NS} ns */
export async function main(ns: NS) {
    let numberCloudServers = 0;
    let numberUpgradedCloudServers = 0;
    let ramForUpgrade = 2 ** 5;

    while (true) {
        // One central scheduler owns rooting, worker deploy, batching and share.
        if (!ns.isRunning('Scheduler.js', 'home')) {
            ns.exec('Scheduler.js', 'home');
        }

        // Checks if Darknet server and runs it.
        const nearbyDarknet = ns.dnet.probe();
        if (nearbyDarknet.length > 0 && !ns.isRunning('utils/darknetvirus.js', nearbyDarknet[0])) {
            ns.scp('utils/darknetvirus.js', nearbyDarknet[0]);
            ns.scp('utils/phishing.js', nearbyDarknet[0]);
            ns.exec('utils/darknetvirus.js', nearbyDarknet[0], { preventDuplicates: true });
        }

        // Checks if Go running and runs it.
        if (!ns.isRunning('utils/go.js')) {
            ns.exec('utils/go.js', ns.getHostname(), { preventDuplicates: true });
        }

        // Buy / upgrade cloud servers (now always reached — no crashing deploy loop above).
        const listCloudServers = ns.cloud.getServerNames();
        numberCloudServers = listCloudServers.length;
        if (numberCloudServers < ns.cloud.getServerLimit()) {
            while (
                ns.getServerMoneyAvailable('home') > ns.cloud.getServerCost(8) &&
                numberCloudServers < ns.cloud.getServerLimit()
            ) {
                ns.cloud.purchaseServer('cloud-server-' + numberCloudServers, 8);
                numberCloudServers++;
                await ns.sleep(400);
            }
        } else if (
            numberCloudServers === ns.cloud.getServerLimit() &&
            numberUpgradedCloudServers < ns.cloud.getServerLimit()
        ) {
            while (
                numberUpgradedCloudServers < ns.cloud.getServerLimit() &&
                ns.getServerMoneyAvailable('home') >
                    ns.cloud.getServerUpgradeCost(listCloudServers[numberUpgradedCloudServers], ramForUpgrade)
            ) {
                ns.cloud.upgradeServer(listCloudServers[numberUpgradedCloudServers], ramForUpgrade);
                numberUpgradedCloudServers++;
                await ns.sleep(400);
            }
        } else if (numberUpgradedCloudServers === ns.cloud.getServerLimit()) {
            if (ramForUpgrade * 2 ** 3 < ns.cloud.getRamLimit()) {
                ramForUpgrade = ramForUpgrade * 2 ** 3;
                numberUpgradedCloudServers = 0;
            }
        }

        await ns.sleep(1000);
    }
}
