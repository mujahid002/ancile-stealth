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
  const response = sendRequester.sendRequest({
      url, method: "POST", multiHeaders: { "Content-Type": { values: ["application/json"] } }, body: bodyBase64,
  }).result();
  if (!ok(response)) throw new Error(`World ID Failed: ${text(response)}`);
  return true;
}

const onAncileRoute = async (runtime: Runtime<Config>, payload: HTTPPayload): Promise<string> => {
  runtime.log("=====================================================");
  runtime.log("⚙️  Ancile Compliance Vault Initializing...");

  const rawPayload = decodeJson(payload.input) as any;
  let actionType = Number(rawPayload.action);
  let data = rawPayload.data;

  // 🌟 OFF-CHAIN COMPLIANCE ENGINE (Verify Alice's World ID)
  if (actionType === 2) {
      if (!data.worldIdProof) throw new Error("❌ Access Denied: Receiver requires World ID verification.");
      
      runtime.log(`🛡️  Authenticating Sender via World ID Portal...`);
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
  // ROUTE 2: P2P DISPATCH (Alice -> Bob)
  // ==========================================
  else if (actionType === 2) {
    runtime.log(`💸 Compiling P2P DISPATCH to Stealth Address: ${data.stealthAddress}`);
    const amount = typeof data.amount === "string" ? BigInt(data.amount) : BigInt(Number(data.amount));
    
    nestedPayloadBytes = encodeAbiParameters(
      parseAbiParameters("address, uint256, address, address, address, bytes, uint8, bytes32, bytes32"),
      [
        data.token, 
        amount, 
        data.sender, 
        data.recipientRegistrant, 
        data.stealthAddress, 
        data.ephemeralPubKey as `0x${string}`, 
        Number(data.sigV), 
        data.sigR as `0x${string}`, 
        data.sigS as `0x${string}`
      ]
    );
  }
  
  // ==========================================
  // ROUTE 3: GASLESS SWEEP (Bob cashes out)
  // ==========================================
  else if (actionType === 3) {
    runtime.log(`🧹 Compiling SWEEP for Stealth Address: ${data.stealthAddress}`);
    const amount = typeof data.amount === "string" ? BigInt(data.amount) : BigInt(Number(data.amount));
    
    nestedPayloadBytes = encodeAbiParameters(
      parseAbiParameters("address, uint256, address, address, uint8, bytes32, bytes32"),
      [
        data.token, amount, data.stealthAddress, data.destination, 
        Number(data.sigV), data.sigR as `0x${string}`, data.sigS as `0x${string}`
      ]
    );
  } 
  
  // ==========================================
  // ROUTE 4: STEALTH SWAP (mUSDC -> ETH)
  // ==========================================
  else if (actionType === 4) { // Assuming SWAP is enum index 4
    runtime.log(`🔄 Processing Stealth Swap for: ${data.stealthAddress}`);
    
    // 1. Fetch live ETH Price (Using Coinbase API for the hackathon)
    runtime.log("📈 Fetching live ETH/USDC price via CRE HTTP Client...");
    const priceResponse = httpClient.sendRequest(runtime, (requester, url) => {
        const res = requester.sendRequest({ url, method: "GET" }).result();
        if (!ok(res)) throw new Error("Price API failed");
        return JSON.parse(text(res)).data.rates.USDC; // Gets the USDC string value of 1 ETH
    }, consensusIdenticalAggregation<string>())(
        "https://api.coinbase.com/v2/exchange-rates?currency=ETH", ""
    ).result();

    const currentEthPriceUsdc = parseFloat(priceResponse);
    runtime.log(`⚖️  Current Market Rate: 1 ETH = $${currentEthPriceUsdc}`);

    // 2. Calculate the Math
    // mUSDC has 6 decimals, ETH has 18 decimals.
    const amountInUSDC = Number(data.amount) / 1e6; // Convert to raw dollar amount
    const expectedEth = amountInUSDC / currentEthPriceUsdc; // How much ETH that buys
    const ethOutputWei = BigInt(Math.floor(expectedEth * 1e18)); // Convert to Wei
    
    runtime.log(`💱 Swapping ${amountInUSDC} USDC for ${expectedEth.toFixed(6)} ETH`);

    // 3. Encode the payload for the Smart Contract
    nestedPayloadBytes = encodeAbiParameters(
      parseAbiParameters("address, uint256, address, uint256, uint8, bytes32, bytes32"),
      [
        data.token, 
        BigInt(data.amount), 
        data.stealthAddress, 
        ethOutputWei, // 🌟 CRE provides the calculated ETH amount!
        Number(data.sigV), 
        data.sigR as `0x${string}`, 
        data.sigS as `0x${string}`
      ]
    );
  } else {
    throw new Error("❌ Invalid Action Enum");
  }

  const finalCallData = encodeAbiParameters(parseAbiParameters("uint8, bytes"), [actionType, nestedPayloadBytes]);
  const evmConfig = runtime.config.evms[0];
  const network = getNetwork({ chainFamily: 'evm', chainSelectorName: evmConfig.chainSelectorName, isTestnet: evmConfig.isTestnet !== false });
  if (!network) throw new Error(`Network not found`);

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
  const reportResponse = runtime.report({ encodedPayload: hexToBase64(finalCallData), encoderName: 'evm', signingAlgo: 'ecdsa', hashingAlgo: 'keccak256' }).result();

  runtime.log(`🚀 Dispatching to Vault: ${evmConfig.receiverAddress}`);
  const resp = evmClient.writeReport(runtime, { receiver: evmConfig.receiverAddress, report: reportResponse, gasConfig: { gasLimit: evmConfig.gasLimit } }).result();

  if (resp.txStatus !== TxStatus.SUCCESS) {
      throw new Error(`❌ On-chain execution failed: ${resp.errorMessage || resp.txStatus}`);
  }

  runtime.log(`✅ Base Sepolia Execution Complete! Tx Hash: ${bytesToHex(resp.txHash || new Uint8Array(0))}`);
  return `Execution complete. Tx Hash: ${bytesToHex(resp.txHash || new Uint8Array(0))}`;
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run((config) => [handler(new HTTPCapability().trigger({}), onAncileRoute)]);
}
