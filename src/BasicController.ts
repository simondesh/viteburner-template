import { NS } from '@ns';
import { ServerStat, chooseHackTarget } from './utils/target-select';

export async function main(ns: NS) {
    
    // Infinite loop that continously hacks/grows/weakens the target server
    while(true) {

        const target = await gettarget(ns);
        // Defines how much money a server should have before we hack it
        // In this case, it is set to the maximum amount of money.
        const moneyThresh = ns.getServerMaxMoney(target);

        // Defines the minimum security level the target server can
        // have. If the target's security level is higher than this,
        // we'll weaken it before doing anything else
        const securityThresh = ns.getServerMinSecurityLevel(target);

        // Obtain root access; if we can't get it yet, don't waste a cycle on it.
        if (!obtainrootaccess(ns, target)) {
            await ns.sleep(1000);
            continue;
        }

        const ramAvailable = ns.getServerMaxRam() - ns.getServerUsedRam();

        if (ns.getServerSecurityLevel(target) > securityThresh) {
            let memScript = ns.getScriptRam("utils/weaken.js")
            if(Math.floor(ramAvailable/memScript) > 0){
                ns.run("utils/weaken.js",Math.floor(ramAvailable/memScript),target)
            }
        } else if (ns.getServerMoneyAvailable(target) < moneyThresh) {
            let memScript = ns.getScriptRam("utils/grow.js")
            if(Math.floor(ramAvailable/memScript) > 0){
                ns.run("utils/grow.js",Math.floor(ramAvailable/memScript),target)
            }
            
        } else {
            let memScript = ns.getScriptRam("utils/hack.js")
            if(Math.floor(ramAvailable/memScript) > 0){
                ns.run("utils/hack.js",Math.floor(ramAvailable/memScript),target)
            }
            
        }
        await ns.sleep(1000);
    }
}
// The port-opener programs, in the same order obtainrootaccess runs them.
const PORT_OPENERS = ['BruteSSH.exe', 'FTPCrack.exe', 'relaySMTP.exe', 'HTTPWorm.exe', 'SQLInject.exe'];

async function gettarget(ns: NS): Promise<string> {
    const serverNames = await gethackableserverBFS(ns);

    const stats: ServerStat[] = serverNames.map((name) => ({
        name,
        maxMoney: ns.getServerMaxMoney(name),
        // Live (current-security) readings — this basic controller does not use
        // the Formulas API; they still rank targets by throughput and work with
        // or without Formulas.exe.
        weakenTime: ns.getWeakenTime(name),
        hackChance: ns.hackAnalyzeChance(name),
        requiredHackingLevel: ns.getServerRequiredHackingLevel(name),
        requiredPorts: ns.getServerNumPortsRequired(name),
        hasRoot: ns.hasRootAccess(name),
    }));

    // How many port openers we own decides which servers we can actually nuke.
    const portOpeners = PORT_OPENERS.filter((p) => ns.fileExists(p, 'home')).length;

    return chooseHackTarget(stats, ns.getHackingLevel(), portOpeners);
}



async function gethackableserverBFS(ns:NS) : Promise<string[]> {

    let visited_list: string[] = [];
    let queue : string[] = ['home'];

    // processes the queue until empty
    while(queue.length > 0){
        let target = queue.shift();
        let neighbor = ns.scan(target);

        if(target != undefined){
            visited_list.push(target);
        } else{
            continue;
        }

        neighbor.forEach(element => {
            if(!(visited_list.includes(element)) && !(queue.includes(element))){
                queue.push(element);
            }
        });
        
        await ns.sleep(30);
    }
    // Drop home and our own purchased (cloud) servers — we farm other servers.
    const cloudServers = ns.cloud.getServerNames();
    return visited_list.filter((item) => item !== 'home' && !cloudServers.includes(item));
}

function obtainrootaccess(ns: NS, target: string): boolean {
    if (ns.hasRootAccess(target)) return true;

    // Only run the port openers we actually own — calling one we lack throws.
    let openPorts = 0;
    if (ns.fileExists('BruteSSH.exe', 'home')) { ns.brutessh(target); openPorts++; }
    if (ns.fileExists('FTPCrack.exe', 'home')) { ns.ftpcrack(target); openPorts++; }
    if (ns.fileExists('relaySMTP.exe', 'home')) { ns.relaysmtp(target); openPorts++; }
    if (ns.fileExists('HTTPWorm.exe', 'home')) { ns.httpworm(target); openPorts++; }
    if (ns.fileExists('SQLInject.exe', 'home')) { ns.sqlinject(target); openPorts++; }

    if (openPorts >= ns.getServerNumPortsRequired(target)) ns.nuke(target);
    return ns.hasRootAccess(target);
}