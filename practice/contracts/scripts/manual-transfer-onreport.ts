import { network } from "hardhat";
import config from "../../../config.json";

const { ethers } = await network.connect();

async function main() {
  const [signer] = await ethers.getSigners();

  const routerAddress = config.ROUTER_ADDRESS;
  const forwarderAddress = config.FORWARDER_BASE_SEPOLIA;
  const tokenAddress = config.TOKEN_ADDRESS;

  const alicePayload = (await import("../../../scripts/alice/alice-latest-payload.json", { assert: { type: "json" } }))
    .default as any;
  const data = alicePayload.data;

  console.log("Signer:", signer.address);
  console.log("Router:", routerAddress);
  console.log("Forwarder:", forwarderAddress);
  console.log("Token:", tokenAddress);

  const Router = await ethers.getContractAt("AncileRouter", routerAddress, signer);
  const Token = await ethers.getContractAt("MockToken", tokenAddress, signer);

  const abi = ethers.AbiCoder.defaultAbiCoder();

  const nestedPayload = abi.encode(
    ["address", "uint256", "address", "address", "address", "bytes"],
    [data.token, BigInt(data.amount), data.sender, data.recipientRegistrant, data.stealthAddress, data.ephemeralPubKey]
  );

  const report = abi.encode(["uint8", "bytes"], [2, nestedPayload]);

  const beforeSender = await Token.balanceOf(data.sender);
  const beforeStealth = await Token.balanceOf(data.stealthAddress);
  console.log("Balance sender before:", beforeSender.toString());
  console.log("Balance stealth before:", beforeStealth.toString());

  console.log("\nTemporarily setting router forwarder to signer...");
  const tx1 = await Router.setForwarder(signer.address);
  await tx1.wait();

  console.log("Calling onReport directly (as signer)...");
  const tx2 = await Router.onReport("0x", report);
  const receipt2 = await tx2.wait();
  console.log("onReport tx:", receipt2?.hash);

  console.log("Restoring router forwarder back to mock forwarder...");
  const tx3 = await Router.setForwarder(forwarderAddress);
  await tx3.wait();

  const afterSender = await Token.balanceOf(data.sender);
  const afterStealth = await Token.balanceOf(data.stealthAddress);
  console.log("\nBalance sender after:", afterSender.toString());
  console.log("Balance stealth after:", afterStealth.toString());
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});

