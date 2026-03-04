/**
 * Deploy AncileStealthReceiver for CRE workflow.
 * The receiver accepts reports from the Chainlink KeystoneForwarder and forwards
 * the payload (registerKeysOnBehalf calldata) to the ERC-6538 registry.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-ancile-receiver.ts --network baseSepolia
 *
 * Set in .env or hardhat config:
 *   BASE_SEPOLIA_RPC_URL
 *   BASE_SEPOLIA_PRIVATE_KEY
 */
import { network } from "hardhat";

const { ethers } = await network.connect();

import config from "../../../config.json";
// Base Sepolia: KeystoneForwarder (from CRE tx "To" address)
const FORWARDER_BASE_SEPOLIA = config.FORWARDER_BASE_SEPOLIA;
// Official ERC-6538 Stealth Registry on Base Sepolia
const REGISTRY_ADDRESS = config.REGISTRY_ADDRESS;

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying AncileStealthReceiver from:", deployer.address);

  const AncileStealthReceiver = await ethers.getContractFactory("AncileStealthReceiver");
  const receiver = await AncileStealthReceiver.deploy(FORWARDER_BASE_SEPOLIA, REGISTRY_ADDRESS);
  await receiver.waitForDeployment();
  const addr = await receiver.getAddress();
  console.log("AncileStealthReceiver deployed to:", addr);
  console.log("\nUpdate p2p-workflow config (e.g. config.staging.json) with:");
  console.log('  "receiverAddress": "' + addr + '"');
  console.log("(Use receiverAddress as the CRE writeReport receiver, not the registry address.)");
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
