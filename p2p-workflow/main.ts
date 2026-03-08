import {
  HTTPCapability, HTTPClient, handler, type Runtime, type HTTPPayload, type HTTPSendRequester,
  Runner, decodeJson, cre, getNetwork, hexToBase64, bytesToHex, TxStatus, ok, text, consensusIdenticalAggregation,
} from "@chainlink/cre-sdk";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { z } from "zod";

const configSchema = z.object({
  evms: z.array(z.object({ receiverAddress: z.string(), chainSelectorName: z.string(), gasLimit: z.string(), isTestnet: z.boolean().optional() })),
  rpId: z.string(), worldIdVerifyUrl: z.string(),
});
type Config = z.infer<typeof configSchema>;

function fetchWorldIdVerify(sendRequester: HTTPSendRequester, url: string, bodyBase64: string): boolean {
  const response = sendRequester.sendRequest({ url, method: "POST", multiHeaders: { "Content-Type": { values: ["application/json"] } }, body: bodyBase64 }).result();
  if (!ok(response)) throw new Error(`World ID Failed: ${text(response)}`);
  return true;
}

const onAncileRoute = async (runtime: Runtime<Config>, payload: HTTPPayload): Promise<string> => {
  runtime.log("⚙️  Ancile Double-Permit Router Initializing...");

  const rawPayload = decodeJson(payload.input) as any;
  let actionType = Number(rawPayload.action);
  let data = rawPayload.data;

  if (actionType === 1 || actionType === 2) {
    if (!data.worldIdProof) throw new Error("❌ Access Denied: Receiver requires World ID verification.");
    const bodyBase64 = typeof Buffer !== "undefined" ? Buffer.from(JSON.stringify(data.worldIdProof), "utf8").toString("base64") : btoa(unescape(encodeURIComponent(JSON.stringify(data.worldIdProof))));
    const httpClient = new HTTPClient();
    httpClient.sendRequest(runtime, fetchWorldIdVerify, consensusIdenticalAggregation<boolean>())(runtime.config.worldIdVerifyUrl, bodyBase64).result();
    runtime.log("✅ Sender verified as unique human!");
  }

  let nestedPayloadBytes: `0x${string}`;

  // ==========================================
  // ROUTE 1: REGISTRATION
  // ==========================================
  if (actionType === 1) {
    runtime.log(`👤 Compiling REGISTRATION for: ${data.registrant}`);
    const ruleEnum = data.rules.requiresWorldID ? 1 : 0;
    nestedPayloadBytes = encodeAbiParameters(
      parseAbiParameters("address, uint256, bytes, bytes, uint8"),
      [data.registrant, BigInt(data.schemeId), data.signature, data.stealthMetaAddressRaw, ruleEnum]
    );
  } 

  // ==========================================
  // ROUTE 2: P2P DISPATCH (Alice -> Stealth)
  // ==========================================
  else if (actionType === 2) {
    runtime.log(`💸 Compiling P2P DISPATCH to Stealth Address: ${data.stealthAddress}`);
    const amount = BigInt(data.amount);

    const p2pAbi = [{
      type: "tuple",
      components: [
        { name: "token", type: "address" }, { name: "amount", type: "uint256" },
        { name: "sender", type: "address" }, { name: "recipientRegistrant", type: "address" },
        { name: "stealthAddress", type: "address" }, { name: "pubKey", type: "bytes" },
        { name: "permit", type: "tuple", components: [{ name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] },
        { name: "intent", type: "tuple", components: [{ name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] }
      ]
    }] as const;

    // @ts-ignore
    nestedPayloadBytes = encodeAbiParameters(p2pAbi, [{
      token: data.token, amount: amount, sender: data.sender, recipientRegistrant: data.recipientRegistrant, stealthAddress: data.stealthAddress, pubKey: data.ephemeralPubKey as `0x${string}`,
      permit: { deadline: BigInt(data.permit.deadline), v: Number(data.permit.v), r: data.permit.r as `0x${string}`, s: data.permit.s as `0x${string}` },
      intent: { v: Number(data.intent.v), r: data.intent.r as `0x${string}`, s: data.intent.s as `0x${string}` }
    }]);
  }

  // ==========================================
  // ROUTE 3: GASLESS SWEEP (Stealth -> Destination)
  // ==========================================
  else if (actionType === 3) {
    runtime.log(`🧹 Compiling SWEEP for Stealth Address: ${data.stealthAddress}`);
    const amount = BigInt(data.amount);

    // 🌟 FIXED: Using explicit ABI object instead of string parser
    const sweepAbi = [{
      type: "tuple",
      components: [
        { name: "token", type: "address" }, { name: "amount", type: "uint256" },
        { name: "stealthAddress", type: "address" }, { name: "destination", type: "address" },
        { name: "permit", type: "tuple", components: [{ name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] },
        { name: "intent", type: "tuple", components: [{ name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] }
      ]
    }] as const;

    // @ts-ignore
    nestedPayloadBytes = encodeAbiParameters(sweepAbi, [{
      token: data.token, amount: amount, stealthAddress: data.stealthAddress, destination: data.destination,
      permit: { deadline: BigInt(data.permit.deadline), v: Number(data.permit.v), r: data.permit.r as `0x${string}`, s: data.permit.s as `0x${string}` },
      intent: { v: Number(data.intent.v), r: data.intent.r as `0x${string}`, s: data.intent.s as `0x${string}` }
    }]);
  } else {
    throw new Error("❌ Invalid Action Enum");
  }

  const finalCallData = encodeAbiParameters(parseAbiParameters("uint8, bytes"), [actionType, nestedPayloadBytes]);
  const evmConfig = runtime.config.evms[0];
  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: evmConfig.chainSelectorName, isTestnet: evmConfig.isTestnet !== false });
  if (!network) throw new Error(`Network not found`);

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const reportResponse = runtime.report({ encodedPayload: hexToBase64(finalCallData), encoderName: 'evm', signingAlgo: 'ecdsa', hashingAlgo: 'keccak256' }).result();

  runtime.log(`🚀 Dispatching to Router: ${evmConfig.receiverAddress}`);
  
  const resp = evmClient.writeReport(runtime, { receiver: evmConfig.receiverAddress, report: reportResponse, gasConfig: { gasLimit: evmConfig.gasLimit } }).result();

  if (resp.txStatus !== TxStatus.SUCCESS) throw new Error(`❌ On-chain execution failed: ${resp.errorMessage || resp.txStatus}`);

  runtime.log(`✅ Execution Complete! Tx Hash: ${bytesToHex(resp.txHash || new Uint8Array(0))}`);
  return `Execution complete. Tx Hash: ${bytesToHex(resp.txHash || new Uint8Array(0))}`;
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run((config) => [handler(new HTTPCapability().trigger({}), onAncileRoute)]);
}