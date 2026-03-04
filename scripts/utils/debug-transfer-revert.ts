/**
 * Diagnose why the transfer reverts (permit, Bob not registered, token, etc.).
 * Run: npx tsx scripts/utils/debug-transfer-revert.ts [path/to/alice-latest-payload.json]
 *
 * Current AncileRouter: no on-chain World ID; CRE verifies proof offchain. Reverts are usually:
 * - RecipientNotRegistered(Bob) → run REGISTER (action 1) with bob-latest-payload.json first.
 * - permit() / transferFrom() → check deadline, nonce, balance, spender = router.
 *
 * Call flow (permit spender must be the router):
 * - Tx: DON (0x2CaC...) → KeystoneForwarder (0x8230...). Forwarder then CALLs receiver.onReport().
 * - So when AncileRouter runs: msg.sender = forwarder (0x8230...), address(this) = router (0x062c...).
 * - permit(alice, address(this), ...) uses spender = router ✓. If forwarder used delegatecall,
 *   address(this) would be the forwarder and permit would fail; Chainlink docs say forwarder "calls" receiver (normal call).
 */

import { createPublicClient, http } from "viem";
import * as fs from "fs";
import * as path from "path";
import { baseSepolia } from "viem/chains";

const configPath = path.resolve(__dirname, "../../config.json");
const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));

const ROUTER_ABI = [
  { inputs: [{ name: "registrant", type: "address" }], name: "creSchemeIds", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

const TOKEN_ABI = [
  { inputs: [{ name: "owner", type: "address" }], name: "nonces", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
  { inputs: [{ name: "account", type: "address" }], name: "balanceOf", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" },
] as const;

const PERMIT_ABI = [
  {
    inputs: [
      { name: "owner", type: "address" },
      { name: "spender", type: "address" },
      { name: "value", type: "uint256" },
      { name: "deadline", type: "uint256" },
      { name: "v", type: "uint8" },
      { name: "r", type: "bytes32" },
      { name: "s", type: "bytes32" },
    ],
    name: "permit",
    outputs: [],
    stateMutability: "nonpayable",
    type: "function",
  },
] as const;

async function main() {
  const payloadPath = process.argv[2] || path.resolve(__dirname, "../alice/alice-latest-payload.json");
  const payloadJson = JSON.parse(fs.readFileSync(payloadPath, "utf-8"));
  const data = payloadJson.action === 2 ? payloadJson.data : payloadJson;

  const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL || config.BASE_SEPOLIA_RPC_URL;
  const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });

  const router = config.ROUTER_ADDRESS as `0x${string}`;
  const bob = data.recipientRegistrant as `0x${string}`;
  const alice = data.sender as `0x${string}`;
  const token = data.token as `0x${string}`;
  const amount = BigInt(data.amount);

  const FORWARDER_BASE_SEPOLIA = "0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5";

  console.log("Router (receiver, permit spender):", router);
  console.log("Forwarder (must be msg.sender at router):", FORWARDER_BASE_SEPOLIA);
  console.log("Token:", token);
  console.log("Alice:", alice);
  console.log("Bob (recipientRegistrant):", bob);
  console.log("");
  console.log("  CRE flow: DON (0x2CaC...) → Forwarder (0x8230...) → Forwarder CALLs Router.onReport().");
  console.log("  So permit(spender = address(this)) = router. If tx fails, check internal calls: Forwarder → Router?\n");

  console.log("--- 1. Bob registration (most common revert: RecipientNotRegistered) ---\n");
  const bobSchemeId = await publicClient.readContract({ address: router, abi: ROUTER_ABI, functionName: "creSchemeIds", args: [bob] });
  console.log("  creSchemeIds(Bob):", bobSchemeId.toString(), bobSchemeId === 0n ? "⚠️ Bob NOT registered on this router" : "✓");
  if (bobSchemeId === 0n) {
    console.log("  → Fix: Run REGISTER first with the SAME router as receiverAddress:");
    console.log("    cre workflow simulate ./p2p-workflow --target staging-settings --non-interactive --trigger-index 0 \\");
    console.log("      --http-payload \"$(cat scripts/bob/bob-latest-payload.json)\" --broadcast\n");
  }

  const hasPermit = data.permitDeadline != null && data.permitV != null && data.permitR != null && data.permitS != null;

  if (hasPermit) {
    console.log("--- 2. Permit (payload has permit fields) ---\n");
    const permitDeadline = BigInt(data.permitDeadline);
    const now = BigInt(Math.floor(Date.now() / 1000));
    console.log("  Deadline:", permitDeadline.toString(), permitDeadline < now ? "⚠️ EXPIRED" : "✓");
    console.log("  Spender in permit must be router:", router);
    const aliceNonce = await publicClient.readContract({ address: token, abi: TOKEN_ABI, functionName: "nonces", args: [alice] });
    console.log("  Token nonce (Alice):", aliceNonce.toString(), "\n");
  } else {
    console.log("--- 2. Permit ---\n");
    console.log("  Payload uses approve flow (no permit). Ensure Alice has run approve(router, amount) before CRE.\n");
  }

  console.log("--- 3. Balance ---\n");
  const balance = await publicClient.readContract({ address: token, abi: TOKEN_ABI, functionName: "balanceOf", args: [alice] });
  console.log("  Alice balance:", balance.toString(), balance < amount ? "⚠️ Insufficient" : "✓");
  console.log("  Required amount:", amount.toString(), "\n");

  if (hasPermit) {
    console.log("--- 4. Simulate permit (as router would call it) ---\n");
    const permitDeadline = BigInt(data.permitDeadline);
    const v = Number(data.permitV);
    const r = (data.permitR as string).padStart(66, "0").slice(0, 66) as `0x${string}`;
    const s = (data.permitS as string).padStart(66, "0").slice(0, 66) as `0x${string}`;
    try {
      await publicClient.simulateContract({
        address: token,
        abi: PERMIT_ABI,
        functionName: "permit",
        args: [alice, router, amount, permitDeadline, v, r, s],
        account: router,
      });
      console.log("  ✓ permit(owner, spender, value, deadline, v, r, s) would succeed.\n");
    } catch (e: unknown) {
      const err = e as { shortMessage?: string; message?: string; details?: string };
      console.log("  ✗ permit() REVERTS → likely cause of transfer revert.");
      console.log("  ", err.shortMessage ?? err.message ?? err.details ?? String(e));
      console.log("  → Check: token domain (name/version/chainId), spender = router, amount/deadline/nonce match what Alice signed.\n");
    }
  } else {
    console.log("--- 4. Allowance (approve flow) ---\n");
    const allowanceAbi = [{ inputs: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }], name: "allowance", outputs: [{ type: "uint256" }], stateMutability: "view", type: "function" }] as const;
    const allowance = await publicClient.readContract({ address: token, abi: allowanceAbi, functionName: "allowance", args: [alice, router] });
    console.log("  allowance(Alice, router):", allowance.toString(), allowance >= amount ? "✓" : "⚠️ Insufficient (run alice-transfer.ts to approve)");
    if (allowance < amount) {
      console.log("  → Run: npx tsx scripts/alice/alice-transfer.ts\n");
    }
    console.log("  If all above are ✓ but tx still reverts, the proxy may be on the OLD implementation (permit/10-field payload).");
    console.log("  → Upgrade: cd contracts && npx hardhat run scripts/upgrade-ancile-router.ts --network baseSepolia\n");
  }
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
