import {
    HTTPCapability, handler, type Runtime, type HTTPPayload,
    Runner, decodeJson, cre, getNetwork, hexToBase64, bytesToHex, TxStatus
} from "@chainlink/cre-sdk";
import { encodeAbiParameters, parseAbiParameters, hexToSignature, hexToBytes } from "viem";
import { generateStealthAddress } from "@scopelift/stealth-address-sdk";
import { z } from "zod";

const configSchema = z.object({
    evms: z.array(z.object({ receiverAddress: z.string(), chainSelectorName: z.string(), gasLimit: z.string(), isTestnet: z.boolean().optional() })),
});
type Config = z.infer<typeof configSchema>;

const onOtcRoute = async (runtime: Runtime<Config>, payload: HTTPPayload): Promise<string> => {
    runtime.log("🤝 Initializing Ancile OTC Matchmaker...");

    const rawPayload = decodeJson(payload.input) as any;
    const payloads = rawPayload.payloads;
    const entropyA = rawPayload.entropyA; 
    const entropyB = rawPayload.entropyB;

    const alicePayload = payloads.find((p: any) => p.maker === "Alice");
    const bobPayload = payloads.find((p: any) => p.maker === "Bob");

    if (!alicePayload || !bobPayload || !entropyA || !entropyB) {
        throw new Error("❌ Missing payloads or entropy for match");
    }

    // 1. Derive Stealth Addresses (Trustlessly injecting the entropy)
    runtime.log("🧮 Generating Double-Blind Stealth Addresses...");
    const stealthA = generateStealthAddress({ 
        stealthMetaAddressURI: `st:eth:${alicePayload.stealthMetaAddress}`,
        ephemeralPrivateKey: hexToBytes(entropyA as `0x${string}`)
    });
    const stealthB = generateStealthAddress({ 
        stealthMetaAddressURI: `st:eth:${bobPayload.stealthMetaAddress}`,
        ephemeralPrivateKey: hexToBytes(entropyB as `0x${string}`)
    });

    // 2. Parse EIP-2612 Signatures
    const sigA = hexToSignature(alicePayload.permit.signature as `0x${string}`);
    const sigB = hexToSignature(bobPayload.permit.signature as `0x${string}`);

    // ==========================================
    // ROUTE 5: OTC DOUBLE-BLIND SWAP
    // ==========================================
    const actionType = 5;

    runtime.log("📦 Bundling Dual-Permit Payload...");
    const otcAbi = [{
        type: "tuple",
        components: [
            { name: "tokenA", type: "address" }, { name: "ownerA", type: "address" }, { name: "amountA", type: "uint256" }, { name: "deadlineA", type: "uint256" }, { name: "vA", type: "uint8" }, { name: "rA", type: "bytes32" }, { name: "sA", type: "bytes32" }, { name: "stealthAddressB", type: "address" }, { name: "ephemeralPubKeyB", type: "bytes" },
            { name: "tokenB", type: "address" }, { name: "ownerB", type: "address" }, { name: "amountB", type: "uint256" }, { name: "deadlineB", type: "uint256" }, { name: "vB", type: "uint8" }, { name: "rB", type: "bytes32" }, { name: "sB", type: "bytes32" }, { name: "stealthAddressA", type: "address" }, { name: "ephemeralPubKeyA", type: "bytes" }
        ]
    }] as const;

    // @ts-ignore
    const nestedPayloadBytes = encodeAbiParameters(otcAbi, [{
        tokenA: alicePayload.giveToken, ownerA: alicePayload.permit.owner, amountA: BigInt(alicePayload.giveAmount), deadlineA: BigInt(alicePayload.permit.deadline), vA: Number(sigA.v), rA: sigA.r as `0x${string}`, sA: sigA.s as `0x${string}`, stealthAddressB: stealthB.stealthAddress as `0x${string}`, ephemeralPubKeyB: stealthB.ephemeralPublicKey as `0x${string}`,
        tokenB: bobPayload.giveToken, ownerB: bobPayload.permit.owner, amountB: BigInt(bobPayload.giveAmount), deadlineB: BigInt(bobPayload.permit.deadline), vB: Number(sigB.v), rB: sigB.r as `0x${string}`, sB: sigB.s as `0x${string}`, stealthAddressA: stealthA.stealthAddress as `0x${string}`, ephemeralPubKeyA: stealthA.ephemeralPublicKey as `0x${string}`
    }]);

    const finalCallData = encodeAbiParameters(parseAbiParameters("uint8, bytes"), [actionType, nestedPayloadBytes]);

    // 3. Dispatch to Smart Contract
    const evmConfig = runtime.config.evms[0];
    const network = getNetwork({ chainFamily: 'evm', chainSelectorName: evmConfig.chainSelectorName, isTestnet: evmConfig.isTestnet !== false });
    if (!network) throw new Error(`Network not found`);

    const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
    const reportResponse = runtime.report({ encodedPayload: hexToBase64(finalCallData), encoderName: 'evm', signingAlgo: 'ecdsa', hashingAlgo: 'keccak256' }).result();

    runtime.log(`🚀 Dispatching OTC Settlement to Router: ${evmConfig.receiverAddress}`);
    const resp = evmClient.writeReport(runtime, { receiver: evmConfig.receiverAddress, report: reportResponse, gasConfig: { gasLimit: evmConfig.gasLimit } }).result();

    if (resp.txStatus !== TxStatus.SUCCESS) throw new Error(`❌ On-chain execution failed: ${resp.errorMessage || resp.txStatus}`);

    const txHash = bytesToHex(resp.txHash || new Uint8Array(0));
    runtime.log(`✅ OTC Settlement Complete! Tx Hash: ${txHash}`);
    return `OTC Execution complete. Tx Hash: ${txHash}`;
};

export async function main() {
    const runner = await Runner.newRunner<Config>({ configSchema });
    await runner.run((config) => [handler(new HTTPCapability().trigger({}), onOtcRoute)]);
}
