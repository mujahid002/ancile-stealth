import { ethers } from "ethers";
import config from "../../config.otc.json";
import AncileRouterJson from "../artifacts/contracts/AncileRouter.sol/AncileRouter.json";

async function fetchDetails(address: `0x${string}`  ) {
    const rpcUrl = config.BASE_SEPOLIA_RPC_URL;
    const provider = new ethers.JsonRpcProvider(rpcUrl);
    const routerContract = new ethers.Contract(config.ROUTER_ADDRESS as `0x${string}`, AncileRouterJson.abi, provider);
    const stealthRule = await routerContract.stealthRules(address);
    console.log("Stealth Rule for ", address, ":", stealthRule);
    const creSchemeId = await routerContract.creSchemeIds(address);
    console.log("CRE Scheme ID for ", address, ":", creSchemeId);
}

async function main() {
    await fetchDetails(config.BOB_PUBLIC_ADDRESS as `0x${string}`);
    await fetchDetails(config.ALICE_PUBLIC_ADDRESS as `0x${string}`);

}

main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
});