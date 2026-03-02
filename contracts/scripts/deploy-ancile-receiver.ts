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

// Base Sepolia: KeystoneForwarder (from CRE tx "To" address)
const FORWARDER_BASE_SEPOLIA = "0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5";
// Official ERC-6538 Stealth Registry on Base Sepolia
const REGISTRY_ERC6538 = "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538";

async function main() {
  const [deployer] = await ethers.getSigners();
  console.log("Deploying AncileStealthReceiver from:", deployer.address);

  const AncileStealthReceiver = await ethers.getContractFactory("AncileStealthReceiver");
  const receiver = await AncileStealthReceiver.deploy(FORWARDER_BASE_SEPOLIA, REGISTRY_ERC6538);
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
