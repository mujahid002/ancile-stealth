import { createPublicClient, createWalletClient, http, parseAbi, encodePacked, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { generateStealthAddress } from "@scopelift/stealth-address-sdk";
import fs from "fs";
import * as path from "path";
import config from "../../config.json";

const erc20Abi = parseAbi(["function nonces(address owner) view returns (uint256)"]);
const routerAbi = parseAbi(["function routerNonces(address owner) external view returns (uint256)", "function creSchemeIds(address registrant) external view returns (uint256)"]);
const registryAbi = parseAbi(["function stealthMetaAddressOf(address registrant, uint256 schemeId) external view returns (bytes)"]);

async function runAliceDispatch() {
    console.log("🌸 Initializing Alice's Double-Permit Dispatch Engine...");

    const rpcUrl = config.BASE_SEPOLIA_RPC_URL;
    const account = privateKeyToAccount(config.ALICE_PRIVATE_KEY as `0x${string}`);
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });
    const amountToProcess = 100n * 10n ** 6n; 

    // Generate Stealth Address
    let schemeId = await publicClient.readContract({ address: config.ROUTER_ADDRESS as `0x${string}`, abi: routerAbi, functionName: 'creSchemeIds', args: [config.BOB_PUBLIC_ADDRESS as `0x${string}`] });
    if (schemeId === 0n) schemeId = 1n; 

    const bobMetaAddress = await publicClient.readContract({ address: config.REGISTRY_ADDRESS as `0x${string}`, abi: registryAbi, functionName: 'stealthMetaAddressOf', args: [config.BOB_PUBLIC_ADDRESS as `0x${string}`, schemeId] });
    const { stealthAddress, ephemeralPublicKey } = generateStealthAddress({ stealthMetaAddressURI: `st:eth:${bobMetaAddress}` });

    // ==========================================
    // SIGNATURE 1: EIP-2612 PERMIT (For the Token)
    // ==========================================
    console.log("📝 Generating EIP-2612 Permit Signature...");
    const tokenNonce = await publicClient.readContract({ address: config.MOCK_USDC_ADDRESS as `0x${string}`, abi: erc20Abi, functionName: 'nonces', args: [account.address] });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour

    const permitSignature = await walletClient.signTypedData({
        account,
        domain: { name: "MockUSDC", version: "1", chainId: baseSepolia.id, verifyingContract: config.MOCK_USDC_ADDRESS as `0x${string}` },
        types: {
            Permit: [
                { name: "owner", type: "address" }, { name: "spender", type: "address" },
                { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }
            ]
        },
        primaryType: "Permit",
        message: { owner: account.address, spender: config.ROUTER_ADDRESS as `0x${string}`, value: amountToProcess, nonce: tokenNonce, deadline: deadline }
    });

    // ==========================================
    // SIGNATURE 2: ROUTER INTENT (For the Ancile Router)
    // ==========================================
    console.log("🔐 Generating Router Intent Signature...");
    const routerNonce = await publicClient.readContract({ address: config.ROUTER_ADDRESS as `0x${string}`, abi: routerAbi, functionName: 'routerNonces', args: [account.address] });
    
    const intentHash = keccak256(encodePacked(['address', 'address', 'uint256', 'uint256'], [account.address, stealthAddress as `0x${string}`, amountToProcess, routerNonce]));
    const intentSignature = await walletClient.signMessage({ account, message: { raw: intentHash } });

    // Format and Save Payload
    function splitSig(sig: string) {
        const r = sig.slice(0, 66) as `0x${string}`;
        const s = "0x" + sig.slice(66, 130) as `0x${string}`;
        let v = parseInt(sig.slice(130, 132), 16); if (v < 27) v += 27;
        return { v, r, s };
    }

    const addressProofPath = path.resolve(__dirname, `../../${account.address}-world-proof.json`);
    const genericProofPath = path.resolve(__dirname, "../../world-id-proof.json");
    const proofPath = fs.existsSync(addressProofPath) ? addressProofPath : genericProofPath;
    const worldIdProof = fs.existsSync(proofPath) ? JSON.parse(fs.readFileSync(proofPath, "utf-8")) : null;
    if (worldIdProof) console.log(`🛡️  World ID Proof loaded from: ${path.basename(proofPath)}`);
    else console.warn("⚠️  No World ID proof found — dispatching without proof.");

    const newPayload = {
        action: 2,
        data: {
            token: config.MOCK_USDC_ADDRESS, amount: amountToProcess.toString(), sender: account.address, recipientRegistrant: config.BOB_PUBLIC_ADDRESS,
            stealthAddress: stealthAddress, ephemeralPubKey: ephemeralPublicKey, worldIdProof,
            permit: { deadline: deadline.toString(), ...splitSig(permitSignature) },
            intent: { ...splitSig(intentSignature) }
        }
    };

    fs.writeFileSync(path.resolve(__dirname, "alice-latest-payload.json"), JSON.stringify(newPayload, null, 2));
    console.log(`✅ Success! Double-Signature Payload saved! Ready for CRE broadcast.`);
}

runAliceDispatch().catch(console.error);
