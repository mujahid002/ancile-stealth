import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { generateStealthAddress } from "@scopelift/stealth-address-sdk";
import fs from "fs";
import * as path from "path";

import config from "../../config.json";

const tokenAbi = parseAbi([
    "function balanceOf(address account) external view returns (uint256)",
    "function nonces(address owner) external view returns (uint256)",
    "function name() external view returns (string)"
]);

const registryAbi = parseAbi([
    "function stealthMetaAddressOf(address registrant, uint256 schemeId) external view returns (bytes)"
]);

const routerAbi = parseAbi([
    "function creSchemeIds(address registrant) external view returns (uint256)"
]);

async function runAliceTransfer() {
    console.log("🌸 Initializing Alice's Stealth Transfer Engine...");

    if (config.TOKEN_ADDRESS.includes("YOUR_") || config.ROUTER_ADDRESS.includes("YOUR_")) {
        throw new Error("Set TOKEN_ADDRESS and ROUTER_ADDRESS in config.json");
    }

    const rpcUrl = config.BASE_SEPOLIA_RPC_URL;
    const privateKey = config.ALICE_PRIVATE_KEY as `0x${string}`;
    if (!rpcUrl || !privateKey) throw new Error("Missing BASE_SEPOLIA_RPC_URL or ALICE_PRIVATE_KEY");

    const account = privateKeyToAccount(privateKey);
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });

    let schemeId = await publicClient.readContract({
        address: config.ROUTER_ADDRESS as `0x${string}`, abi: routerAbi, functionName: 'creSchemeIds', args: [config.BOB_PUBLIC_ADDRESS as `0x${string}`]
    });

    if (schemeId === 0n) {
        console.log("⚠️ Bob not yet registered in Router. Defaulting to Scheme 1.");
        schemeId = 1n;
    }

    const amountToTransfer = BigInt(10 * 10 ** 6);
    const balance = await publicClient.readContract({
        address: config.TOKEN_ADDRESS as `0x${string}`, abi: tokenAbi, functionName: 'balanceOf', args: [account.address]
    });

    if (balance < amountToTransfer) {
        throw new Error(`❌ Insufficient balance!`);
    }

    console.log(`🔍 Fetching Meta-Address for Bob (Scheme ${schemeId})...`);
    const bobMetaAddress = await publicClient.readContract({
        address: config.REGISTRY_ADDRESS as `0x${string}`,
        abi: registryAbi,
        functionName: 'stealthMetaAddressOf',
        args: [config.BOB_PUBLIC_ADDRESS as `0x${string}`, schemeId]
    });

    if (!bobMetaAddress || bobMetaAddress === '0x') {
        throw new Error("❌ Bob has no stealth meta-address registered on-chain!");
    }

    const { stealthAddress, ephemeralPublicKey } = generateStealthAddress({
        stealthMetaAddressURI: `st:eth:${bobMetaAddress}`
    });
    console.log(`📍 Stealth Address generated: ${stealthAddress}`);

    const nonce = await publicClient.readContract({
        address: config.TOKEN_ADDRESS as `0x${string}`, abi: tokenAbi, functionName: 'nonces', args: [account.address]
    });

    // 🌟 FIX 1: Exact string fetch for Domain Separator
    const exactTokenName = await publicClient.readContract({
        address: config.TOKEN_ADDRESS as `0x${string}`, abi: tokenAbi, functionName: 'name'
    });

    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const signature = await walletClient.signTypedData({
        domain: {
            name: exactTokenName,
            version: "1",
            chainId: baseSepolia.id,
            verifyingContract: config.TOKEN_ADDRESS as `0x${string}`
        },
        types: {
            Permit: [
                { name: "owner", type: "address" },
                { name: "spender", type: "address" },
                { name: "value", type: "uint256" },
                { name: "nonce", type: "uint256" },
                { name: "deadline", type: "uint256" }
            ]
        },
        primaryType: "Permit",
        message: {
            owner: account.address,
            spender: config.ROUTER_ADDRESS as `0x${string}`,
            value: amountToTransfer,
            nonce,
            deadline
        }
    });

    const r = signature.slice(0, 66) as `0x${string}`;
    const s = "0x" + signature.slice(66, 130) as `0x${string}`;

    // 🌟 FIX 2: Strict OpenZeppelin standard formatting
    let v = parseInt(signature.slice(130, 132), 16);
    if (v < 27) v += 27;

    const proofPath = fs.existsSync(path.resolve(__dirname, "world-id-proof.json"))
        ? path.resolve(__dirname, "world-id-proof.json")
        : path.resolve(__dirname, "../world-id-proof.json");

    let worldIdProof = null;
    if (fs.existsSync(proofPath)) {
        worldIdProof = JSON.parse(fs.readFileSync(proofPath, "utf-8"));
    }

    const newPayload = {
        action: 2,
        data: {
            token: config.TOKEN_ADDRESS as `0x${string}`,
            amount: amountToTransfer.toString(),
            sender: account.address,
            recipientRegistrant: config.BOB_PUBLIC_ADDRESS as `0x${string}`,
            stealthAddress: stealthAddress as `0x${string}`,
            ephemeralPubKey: ephemeralPublicKey as `0x${string}`,
            permitDeadline: deadline.toString(),
            permitV: v,
            permitR: r,
            permitS: s,
            worldIdProof
        }
    };

    const latestPath = path.resolve(__dirname, "alice-latest-payload.json");
    fs.writeFileSync(latestPath, JSON.stringify(newPayload, null, 2));

    console.log(`✅ Saved single object for CRE to alice-latest-payload.json`);
}

runAliceTransfer().catch(console.error);
