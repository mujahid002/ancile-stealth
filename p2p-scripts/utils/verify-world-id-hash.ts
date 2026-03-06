/**
 * Computes the same externalNullifierHash and signalHash as AncileRouter.sol
 * so you can confirm your proof was generated with matching app_id, action, and signal.
 *
 * Run: npx tsx scripts/utils/verify-world-id-hash.ts
 * Uses config.p2p.json from repo root (APP_ID, ACTION_ID, ALICE_PUBLIC_ADDRESS) or env.
 */

import { keccak256, stringToHex, type Hex } from "viem";
import * as path from "path";
import * as fs from "fs";

function loadConfig(): { APP_ID: string; ACTION_ID: string; ALICE_PUBLIC_ADDRESS: string } {
  const configPath = path.resolve(__dirname, "../../config.p2p.json");
  if (fs.existsSync(configPath)) {
    const c = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    return {
      APP_ID: process.env.APP_ID ?? c.APP_ID ?? "",
      ACTION_ID: process.env.ACTION_ID ?? c.ACTION_ID ?? "",
      ALICE_PUBLIC_ADDRESS: process.env.ALICE_PUBLIC_ADDRESS ?? c.ALICE_PUBLIC_ADDRESS ?? "",
    };
  }
  return {
    APP_ID: process.env.APP_ID ?? "",
    ACTION_ID: process.env.ACTION_ID ?? "",
    ALICE_PUBLIC_ADDRESS: process.env.ALICE_PUBLIC_ADDRESS ?? "",
  };
}

// Mirrors AncileRouter: World ID "double hashToField" — appIdField = hash(appId)>>8, then hash(appIdField, actionId)>>8
function computeExternalNullifierHash(appId: string, actionId: string): bigint {
  const hashAppId = keccak256(stringToHex(appId) as Hex);
  const appIdField = BigInt(hashAppId) >> 8n;
  const actionHex = stringToHex(actionId);
  const packed = ("0x" + appIdField.toString(16).padStart(64, "0") + actionHex.slice(2)) as Hex;
  const hash = keccak256(packed);
  return BigInt(hash) >> 8n;
}

// Mirrors AncileRouter: signalHash = uint256(keccak256(abi.encodePacked(sender))) >> 8
// sender is address (20 bytes). abi.encodePacked(address) = 20 bytes.
function computeSignalHash(senderAddress: string): bigint {
  const hex = senderAddress.startsWith("0x") ? senderAddress : "0x" + senderAddress;
  const hash = keccak256(hex as Hex);
  return (BigInt(hash) >> 8n);
}

function main() {
  const { APP_ID, ACTION_ID, ALICE_PUBLIC_ADDRESS } = loadConfig();
  if (!APP_ID || !ACTION_ID) {
    console.error("Set APP_ID and ACTION_ID in config.p2p.json or env.");
    process.exit(1);
  }

  const externalNullifierHash = computeExternalNullifierHash(APP_ID, ACTION_ID);
  console.log("Contract formula: keccak256(abi.encodePacked(keccak256(abi.encodePacked(appId)), actionId)) >> 8");
  console.log("APP_ID:", APP_ID);
  console.log("ACTION_ID:", ACTION_ID);
  console.log("externalNullifierHash (decimal):", externalNullifierHash.toString());
  console.log("externalNullifierHash (hex):     0x" + externalNullifierHash.toString(16));

  if (ALICE_PUBLIC_ADDRESS) {
    const signalHash = computeSignalHash(ALICE_PUBLIC_ADDRESS);
    console.log("\nContract formula: keccak256(abi.encodePacked(sender)) >> 8");
    console.log("Sender (Alice):", ALICE_PUBLIC_ADDRESS);
    console.log("signalHash (decimal):", signalHash.toString());
    console.log("signalHash (hex):     0x" + signalHash.toString(16));
    console.log("\nWhen generating the proof, use Signal = Alice's address (above) so the proof's signal_hash matches.");
  } else {
    console.log("\nSet ALICE_PUBLIC_ADDRESS in config.p2p.json to see signalHash for the transfer sender.");
  }

  console.log("\nEnsure the proof was generated with the same app_id and action so externalNullifierHash matches.");
}

main();
