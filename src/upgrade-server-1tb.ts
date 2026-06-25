/** @param {NS} ns */
import { NS } from '@ns';
export async function main(ns : NS) {
    // How much RAM each cloud server will have. In this case, it'll be 8GB.
    const ram = 2**15;

    // Iterator we'll use for our loop
    let i = 0;
    // Continuously try to purchase cloud servers until we've reached the maximum
    // amount of servers

    while (i < ns.cloud.getServerLimit()) {
        // Check if we have enough money to purchase access to a server
        const hostname = "cloud-server-" + i
        
        if (ns.getServerMoneyAvailable("home") > ns.cloud.getServerUpgradeCost(hostname,ram)){
            if (ns.cloud.upgradeServer("cloud-server-" + i, ram)) {
              ns.print("upgraded server ", hostname ," for ",ns.cloud.getServerUpgradeCost(hostname,ram))
            }else{
              ns.print("failed to upgrade ",hostname)
            }
            if(ns.isRunning("early-hack-template.js", hostname)){
              ns.scriptKill("early-hack-template.js", hostname)
            }
            if(ns.fileExists("early-hack-template.js", hostname)){
              ns.rm("early-hack-template.js", hostname)
            }
            ns.scp("early-hack-template.js", hostname);
            if (ram > 2**12){
              const num_script = Math.floor( ram / ns.getScriptRam("early-hack-template.js", hostname));
              const batch_size = 1000;

              const num_batch = Math.floor(num_script/batch_size)
              const last_batch_size = num_script % 10;
              for (let j=0;j < num_batch ;j++){
                ns.exec("early-hack-template.js", hostname, batch_size)
              }
              if(last_batch_size > 0){ ns.exec("early-hack-template.js", hostname, last_batch_size)};
            } else if (ram > 256){
              const num_script = Math.floor( ram / ns.getScriptRam("early-hack-template.js", hostname));
              const batch_size = 10;

              const num_batch = Math.floor(num_script/batch_size)
              const last_batch_size = num_script % 10;
              for (let j=0;j < num_batch ;j++){
                ns.exec("early-hack-template.js", hostname, batch_size)
              }
              if(last_batch_size > 0){ ns.exec("early-hack-template.js", hostname, last_batch_size)};
            } else{
              ns.exec("early-hack-template.js", hostname, Math.floor( ram / ns.getScriptRam("early-hack-template.js", hostname)));
            }
            ++i;
        }
        // Make the script wait for a second before looping again.
        // Removing this line will cause an infinite loop and crash the game.
        await ns.sleep(1000);
    }
}