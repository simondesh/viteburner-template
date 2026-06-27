import {NS} from '@ns';
/** @param {NS} ns */
export async function main(ns:NS){
    // Initialisation
    const hostname = ns.getHostname();

    let numberCloudServers = 0;
    let numberUpgradedCloudServers = 0;
    let ramForUpgrade = 2**5;

    // MainLoop
    while(true){
        let server_list = await getallserverBFS(ns);

        // Run basic controller on all servers
        for(const servername of server_list){
            if(!ns.isRunning("BasicController.js",servername)){
                ns.brutessh(servername)
                ns.ftpcrack(servername)
                ns.relaysmtp(servername)
                ns.httpworm(servername)
                ns.sqlinject(servername)
                ns.nuke(servername)
                ns.scp('BasicController.js',servername,hostname);
                ns.scp('utils/grow.js',servername,hostname);
                ns.scp('utils/hack.js',servername,hostname);
                ns.scp('utils/weaken.js',servername,hostname);
                ns.exec('BasicController.js',servername);
            };
        };


        // Checks if Darknet server and Runs it
        const nearbyServersDarknetServers = ns.dnet.probe()
        if(nearbyServersDarknetServers.length > 0 && ! ns.isRunning('utils/darknetvirus.js',nearbyServersDarknetServers[0])){
            ns.scp('utils/darknetvirus.js', nearbyServersDarknetServers[0]);
            ns.scp('utils/phishing.js', nearbyServersDarknetServers[0]);
            ns.exec('utils/darknetvirus.js', nearbyServersDarknetServers[0], {
            preventDuplicates: true, // This prevents running multiple copies of this script
            });
        }

        // Checks if Go running and run it
        if(! ns.isRunning("utils/go.js")){
            ns.exec("utils/go.js", hostname, {
            preventDuplicates: true,});
        }

        // buy cloud servers
        const listCloudServers = ns.cloud.getServerNames()
        numberCloudServers = listCloudServers.length;
        if (numberCloudServers < ns.cloud.getServerLimit()){

            while((ns.getServerMoneyAvailable("home") > ns.cloud.getServerCost(8)) && (numberCloudServers < ns.cloud.getServerLimit()) ){
                const hostname = ns.cloud.purchaseServer("cloud-server-" + numberCloudServers, 8);
                numberCloudServers++;
                await ns.sleep(400);
            }
        }else if((numberCloudServers === ns.cloud.getServerLimit()) 
            && (numberUpgradedCloudServers < ns.cloud.getServerLimit())){
        // upgrade cloud server
            while(
                ((numberUpgradedCloudServers < ns.cloud.getServerLimit())) &&
                (ns.getServerMoneyAvailable("home") > ns.cloud.getServerUpgradeCost(listCloudServers[numberUpgradedCloudServers],ramForUpgrade))
                
            ){
                ns.cloud.upgradeServer(listCloudServers[numberUpgradedCloudServers],ramForUpgrade);
                numberUpgradedCloudServers++;
                await ns.sleep(400);
            }

        }else if(numberUpgradedCloudServers === ns.cloud.getServerLimit()){
            if (ramForUpgrade*(2**3) < ns.cloud.getRamLimit()){
                ramForUpgrade = ramForUpgrade*(2**3);
                numberUpgradedCloudServers = 0;
            }
        }
        


        await ns.sleep(1000);
    }
}

async function getallserverBFS(ns:NS) : Promise<string[]> {

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
    return visited_list;
}
