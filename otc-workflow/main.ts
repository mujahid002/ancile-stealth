import {
    HTTPCapability, handler, type Runtime, type HTTPPayload,
    Runner, decodeJson, cre, getNetwork, hexToBase64, bytesToHex, TxStatus
} from "@chainlink/cre-sdk";
import { encodeAbiParameters, parseAbiParameters, hexToSignature } from "viem";
import { z } from "zod";

const configSchema = z.object({
    evms: z.array(z.object({ 
        receiverAddress: z.string(), 
        chainSelectorName: z.string(), 
        gasLimit: z.string(), 
        isTestnet: z.boolean().optional() 
    })),
});
type Config = z.infer<typeof configSchema>;

const onAncileRoute = async (runtime: Runtime<Config>, payload: HTTPPayload): Promise<string> => {
    const rawPayload = decodeJson(payload.input) as any;
    const payloads = rawPayload.payloads; 

    if (!payloads || payloads.length === 0) {
        throw new Error("❌ Missing payloads for execution");
    }

    const isSweep = payloads[0].stealthAddress !== undefined;

    let finalCallData: `0x${string}`;
    let logPrefix: string;

    if (isSweep) {
        // ==========================================
        // ROUTE 7: GASLESS BATCH SWEEP
        // ==========================================
        runtime.log("🧹 Initializing Ancile Gasless Sweep Relayer...");
        logPrefix = "Batch Sweep";

        const formattedSweeps = payloads.map((sweep: any) => {
            const pSig = hexToSignature(sweep.permit.signature as `0x${string}`);
            const iSig = hexToSignature(sweep.intent.signature as `0x${string}`);
            
            return {
                token: sweep.token as `0x${string}`,
                amount: BigInt(sweep.amount),
                stealthAddress: sweep.stealthAddress as `0x${string}`,
                destination: sweep.destination as `0x${string}`,
                permit: { deadline: BigInt(sweep.permit.deadline), v: Number(pSig.v), r: pSig.r as `0x${string}`, s: pSig.s as `0x${string}` },
                intent: { v: Number(iSig.v), r: iSig.r as `0x${string}`, s: iSig.s as `0x${string}` }
            };
        });

        const sweepAbi = [{
            type: "tuple[]",
            components: [
                { name: "token", type: "address" }, { name: "amount", type: "uint256" }, { name: "stealthAddress", type: "address" }, { name: "destination", type: "address" },
                { name: "permit", type: "tuple", components: [{ name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] },
                { name: "intent", type: "tuple", components: [{ name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] }
            ]
        }] as const;

        // @ts-ignore
        const payloadBytes = encodeAbiParameters(sweepAbi, [formattedSweeps]);
        finalCallData = encodeAbiParameters(parseAbiParameters("uint8, bytes"), [7, payloadBytes]);

    } else {
        // ==========================================
        // ROUTE 6: MEGA-BATCH OTC (SHARDED)
        // ==========================================
        runtime.log("🤝 Initializing Ancile Mega-Batch Router...");
        logPrefix = "Mega-Batch OTC";

        const alicePayload = payloads.find((p: any) => p.maker === "Alice");
        const bobPayload = payloads.find((p: any) => p.maker === "Bob");

        if (!alicePayload || !bobPayload) throw new Error("❌ Missing payloads for OTC match");

        runtime.log("🧮 Parsing Client-Side Shards...");

        const sigA = hexToSignature(alicePayload.permit.signature as `0x${string}`);
        const sigB = hexToSignature(bobPayload.permit.signature as `0x${string}`);

        const pulls = [
            { token: alicePayload.giveToken as `0x${string}`, owner: alicePayload.permit.owner as `0x${string}`, amount: BigInt(alicePayload.giveAmount), deadline: BigInt(alicePayload.permit.deadline), v: Number(sigA.v), r: sigA.r as `0x${string}`, s: sigA.s as `0x${string}` },
            { token: bobPayload.giveToken as `0x${string}`, owner: bobPayload.permit.owner as `0x${string}`, amount: BigInt(bobPayload.giveAmount), deadline: BigInt(bobPayload.permit.deadline), v: Number(sigB.v), r: sigB.r as `0x${string}`, s: sigB.s as `0x${string}` }
        ];

        const pushes: { token: `0x${string}`; to: `0x${string}`; amount: bigint }[] = [];
        
        const bobChunk = BigInt(alicePayload.giveAmount) / BigInt(bobPayload.receivingShards.length);
        for(const shard of bobPayload.receivingShards) {
            pushes.push({ token: alicePayload.giveToken as `0x${string}`, to: shard as `0x${string}`, amount: bobChunk });
        }

        const aliceChunk = BigInt(bobPayload.giveAmount) / BigInt(alicePayload.receivingShards.length);
        for(const shard of alicePayload.receivingShards) {
            pushes.push({ token: bobPayload.giveToken as `0x${string}`, to: shard as `0x${string}`, amount: aliceChunk });
        }

        runtime.log(`📦 Bundling ${pulls.length} Pulls and ${pushes.length} Pushes...`);

        const batchAbi = [
            { type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "owner", type: "address" }, { name: "amount", type: "uint256" }, { name: "deadline", type: "uint256" }, { name: "v", type: "uint8" }, { name: "r", type: "bytes32" }, { name: "s", type: "bytes32" }] },
            { type: "tuple[]", components: [{ name: "token", type: "address" }, { name: "to", type: "address" }, { name: "amount", type: "uint256" }] }
        ] as const;

        // @ts-ignore
        const nestedPayloadBytes = encodeAbiParameters(batchAbi, [pulls, pushes]);
        finalCallData = encodeAbiParameters(parseAbiParameters("uint8, bytes"), [6, nestedPayloadBytes]);
    }

    // ==========================================
    // DISPATCH TO EVM ROUTER
    // ==========================================
    const evmConfig = runtime.config.evms[0];
    const network = getNetwork({ chainFamily: 'evm', chainSelectorName: evmConfig.chainSelectorName, isTestnet: evmConfig.isTestnet !== false });
    if (!network) throw new Error(`Network not found`);

    const evmClient = new cre.capabilities.EVMClient(network.chainSelector.selector);
    const reportResponse = runtime.report({ encodedPayload: hexToBase64(finalCallData), encoderName: 'evm', signingAlgo: 'ecdsa', hashingAlgo: 'keccak256' }).result();

    runtime.log(`🚀 Dispatching ${logPrefix} to Router: ${evmConfig.receiverAddress}`);
    const resp = evmClient.writeReport(runtime, { receiver: evmConfig.receiverAddress, report: reportResponse, gasConfig: { gasLimit: evmConfig.gasLimit } }).result();

    if (resp.txStatus !== TxStatus.SUCCESS) throw new Error(`❌ On-chain execution failed: ${resp.errorMessage || resp.txStatus}`);

    const txHash = bytesToHex(resp.txHash || new Uint8Array(0));
    runtime.log(`✅ ${logPrefix} Settlement Complete! Tx Hash: ${txHash}`);
    return `${logPrefix} Execution complete. Tx Hash: ${txHash}`;
};

export async function main() {
    const runner = await Runner.newRunner<Config>({ configSchema });
    await runner.run((config) => [handler(new HTTPCapability().trigger({}), onAncileRoute)]);
}
