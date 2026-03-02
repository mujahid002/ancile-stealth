import {
  HTTPCapability,
  handler,
  type Runtime,
  type HTTPPayload,
  Runner,
  decodeJson,
  cre,
  getNetwork,
  hexToBase64,
  bytesToHex,
  TxStatus
} from "@chainlink/cre-sdk";
import { encodeAbiParameters, parseAbiParameters } from "viem";
import { z } from "zod";

const configSchema = z.object({
  evms: z.array(
      z.object({
          /** CRE receiver (e.g. AncileStealthReceiver). Must implement onReport; do not use ERC-6538 registry address here. */
          receiverAddress: z.string(),
          chainSelectorName: z.string(),
          gasLimit: z.string(),
      })
  ),
});

type Config = z.infer<typeof configSchema>;

type BobRegistrationPayload = {
  registrant: `0x${string}`;
  schemeId: number;
  stealthMetaAddressRaw: `0x${string}`;
  signature: `0x${string}`;
  rules: { requiresWorldID: boolean };
};

const onBobRegistration = async (runtime: Runtime<Config>, payload: HTTPPayload): Promise<string> => {
  runtime.log("⚙️ CRE Backend initializing in Wasm Sandbox...");

  // 1. Parse the strictly formatted Single JSON Object
  const data = decodeJson(payload.input) as BobRegistrationPayload;
  runtime.log(`👤 Processing registration for: ${data.registrant}`);

  const evmConfig = runtime.config.evms[0];
  const network = getNetwork({
      chainFamily: 'evm',
      chainSelectorName: evmConfig.chainSelectorName,
      isTestnet: true,
  });

  if (!network) throw new Error(`Network not found: ${evmConfig.chainSelectorName}`);

  const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);

  // 2. Encode report payload (Wasm Safe). uint8 rule must match AncileStealthReceiver.ComplianceRule (0 = DEFAULT, 1 = WORLD_ID_VERIFICATION).
  const ruleEnum = data.rules.requiresWorldID ? 1 : 0;

  const callData = encodeAbiParameters(
      parseAbiParameters("address, uint256, bytes, bytes, uint8"),
      [
          data.registrant,
          BigInt(data.schemeId),
          data.signature,
          data.stealthMetaAddressRaw,
          ruleEnum
      ]
  );

  // 3. Chainlink Consensus
  const reportResponse = runtime.report({
      encodedPayload: hexToBase64(callData),
      encoderName: 'evm',
      signingAlgo: 'ecdsa',
      hashingAlgo: 'keccak256',
  }).result();

  // 4. Dispatch via Chainlink Forwarder (receiver must implement onReport; use AncileStealthReceiver, not registry)
  runtime.log(`🚀 Dispatching writeReport to ${evmConfig.receiverAddress}...`);
  const resp = evmClient.writeReport(runtime, {
      receiver: evmConfig.receiverAddress,
      report: reportResponse,
      gasConfig: { gasLimit: evmConfig.gasLimit },
  }).result();

  // 5. Strict Status Check
  if (resp.txStatus !== TxStatus.SUCCESS) {
      throw new Error(`❌ On-chain execution failed: ${resp.errorMessage || resp.txStatus}`);
  }

  const txHash = resp.txHash ? bytesToHex(resp.txHash) : "0x_mock_hash";
  runtime.log(`✅ Transaction Success! Tx Hash: ${txHash}`);
  runtime.log(`💾 [Mock DB] Rules Saved: Requires WorldID = ${data.rules.requiresWorldID}`);

  return `Registration complete. Hash: ${txHash}`;
};

const initWorkflow = (config: Config) => {
  const http = new HTTPCapability();
  return [ handler(http.trigger({}), onBobRegistration) ];
};

export async function main() {
  const runner = await Runner.newRunner<Config>({ configSchema });
  await runner.run(initWorkflow);
}
