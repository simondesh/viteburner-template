import { NS } from '@ns';

/** @param {NS} ns */
export async function main(ns:NS) {
    const details = ns.dnet.getServerDetails()
    
    while (true) {
    // Get a list of all darknet hostnames directly connected to the current server
    const nearbyServers = ns.dnet.probe();

    // Attempt to authenticate with each of the nearby servers, and spread this script to them
    for (const hostname of nearbyServers) {
        const authenticationSuccessful = await serverSolver(ns, hostname);
        if (!authenticationSuccessful) {
        continue; // If we failed to auth, just move on to the next server
        }

        // If we have successfully authenticated, we can now copy and run this script on the target server
        ns.scp(ns.getScriptName(), hostname);
        ns.scp("utils/phishing.js", hostname);
        ns.exec(ns.getScriptName(), hostname, {
        preventDuplicates: true, // This prevents running multiple copies of this script
        });
        await ns.sleep(500);
    }

    // free up blocked ram on this server 
    while(ns.dnet.getBlockedRam() > 0){
        await ns.dnet.memoryReallocation();
        await ns.sleep(500);
    }

    // TODO: look for .cache files on this server and open them 
    const files = ns.ls(ns.getHostname(),'.cache')
    for(const file of files){
        ns.dnet.openCache(file);
    }

    // TODO: take advantage of the extra ram on darknet servers to run ns.dnet.phishingAttack calls for money
    const availableRam = ns.getServerMaxRam() - ns.getServerUsedRam();
    const scriptRam = ns.getScriptRam("utils/phishing.js");
    if( availableRam > scriptRam){
      ns.run("utils/phishing.js",Math.floor(availableRam / scriptRam));
    }

    await ns.sleep(5000);
    }
}

/** Attempts to authenticate with the specified server using the Darknet API.
 * @param {NS} ns
 * @param {string} hostname - the name of the server to attempt to authorize on
 */
export const serverSolver = async (ns:NS, hostname:string) => {
  // Get key info about the server, so we know what kind it is and how to authenticate with it
  const details = ns.dnet.getServerDetails(hostname);
  if (!details.isConnectedToCurrentServer || !details.isOnline) {
    // If the server isn't connected or is offline, we can't authenticate
    return false;
  }
  // If you are already authenticated to that server with this script, you don't need to do it again
  if (details.hasSession) {
    return true;
  }

  switch (details.modelId) {
    case "ZeroLogon":
      return authenticateWithNoPassword(ns, hostname);
    case "FreshInstall_1.0":
      return authenticateWithDefaultPassword(ns,hostname,details.passwordFormat,details.passwordLength);
    case "PHP 5.4":
      return authenticateWithNumericShuffledPassword(ns, hostname,details.data);
    case "DeskMemo_3.1":
      return authenticateWithNumericExtractedMemo(ns,hostname,details.passwordHint);
    case "CloudBlare(tm)":
      return authenticateWithNumericExtractedMemo(ns,hostname,details.data);
    // TODO: handle other models of darknet servers here

    // TODO: get recent server logs with `await ns.dnet.heartbleed(hostname)` for more detailed logging on failed auth attempts

    default:
      //ns.tprint(`Unrecognized modelId: ${details.modelId}`);
      return false;
  }
};

/** Authenticates on 'ZeroLogon' type servers, which always have an empty password.
 *  @param {NS} ns
 *  @param {string} hostname - the name of the server to attempt to authorize on
 */
const authenticateWithNoPassword = async (ns:NS, hostname:string) => {
  const result = await ns.dnet.authenticate(hostname, "");
  // TODO: store discovered passwords somewhere safe, in case we need them later
  return result.success;
};
const authenticateWithDefaultPassword = async ( ns:NS, hostname:string, format: "numeric" | "alphabetic" | "alphanumeric" | "ASCII" | "unicode", length:number) => {
  let password = "admin";
  switch(format){
    case "numeric":
      password = "0".repeat(length);
      break;
    case "alphabetic":
      if(length===5){
        password = "admin";
      } else if(length===8){
        password = "password";
      }else{
        password = "dontknow";
      }
      break;
    default:
      password = "admin";

  }
  const result = await ns.dnet.authenticate(hostname, password);
  // TODO: store discovered passwords somewhere safe, in case we need them later
  return result.success;
};
const authenticateWithNumericShuffledPassword = async (ns:NS, hostname:string, data:string) => {
  let tried_ps: string[] = [];
  let result = { success: false };
  while (!result.success) {
    let password = data.split('').sort(function(){return 0.5-Math.random()}).join('');
    while(tried_ps.includes(password)){
      let password = data.split('').sort(function(){return 0.5-Math.random()}).join('');
      await ns.sleep(300);
    }
    result = await ns.dnet.authenticate(hostname, password);
    await ns.sleep(300);
  } 
  
  // TODO: store discovered passwords somewhere safe, in case we need them later
  return result.success;
};
const authenticateWithNumericExtractedMemo = async (ns:NS, hostname:string,toExtractFrom:string) => {
  const match = toExtractFrom.match(/\d/g);
  if (!match) {
    return false;
  }
  const password = match.join("");
  const result = await ns.dnet.authenticate(hostname, password);
  // TODO: store discovered passwords somewhere safe, in case we need them later
  return result.success;
};

/** This lets you tab-complete putting "--tail" on the run command so you can see the script logs as it runs, if you want
 *  If you add support to the script to take other arguments, you can add them here as well for convenience
 *  @param {AutocompleteData} data */
export function autocomplete(data) {
  return ["--tail"];
}