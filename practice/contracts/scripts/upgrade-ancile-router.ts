/**
 * Upgrade AncileRouter (UUPS) to a new implementation.
 * Caller must be the current upgradeAdmin on the proxy.
 *
 * Usage:
 *   PROXY_ADDRESS=0x... npx hardhat run scripts/upgrade-ancile-router.ts --network baseSepolia
 *
 * Optional: NEW_IMPL_ADDRESS=0x... to skip deploying and use an existing implementation.
 */

import { network } from "hardhat";
const { ethers } = await network.connect();

import config from "../../config.json";

async function main() {
    const [deployer] = await ethers.getSigners();
    console.log("Upgrade admin (signer):", deployer.address);
    console.log("Proxy (router):", config.ROUTER_ADDRESS);

    let newImpl: string;

    const AncileRouter = await ethers.getContractFactory("AncileRouter");
    const impl = await AncileRouter.deploy();
    await impl.waitForDeployment();
    newImpl = await impl.getAddress();
    console.log("Deployed new implementation:", newImpl);

    const router = await ethers.getContractAt("AncileRouter", config.ROUTER_ADDRESS);
    const tx = await router.upgradeToAndCall(newImpl, "0x");
    await tx.wait();
    console.log("Upgrade tx:", tx.hash);
    console.log("Done. Proxy now points to:", newImpl);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
