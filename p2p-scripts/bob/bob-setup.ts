import { createWalletClient, http, createPublicClient, concatHex, keccak256, toHex, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { ethers } from "ethers"; 
import * as fs from "fs";
import * as path from "path";

import config from "../../config.json";

const ERC6538_REGISTRY_ADDRESS = config.REGISTRY_ADDRESS as `0x${string}`;

const registryAbi = [
    {
        "inputs": [{ "internalType": "address", "name": "registrant", "type": "address" }],
        "name": "nonceOf",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    }
] as const;

const currentSchemeIdForBob = config.ANCILE_SCHEME_ID_FOR_ACCOUNT_SETUP;

async function bobBackendSetup() {
    console.log("⚙️  Initializing Bob's Privacy Setup...");

    const rpcUrl = config.BASE_SEPOLIA_RPC_URL;
    const privateKey = config.BOB_PRIVATE_KEY as `0x${string}`;
    if (!rpcUrl || !privateKey) throw new Error("Missing BASE_SEPOLIA_RPC_URL or BOB_PRIVATE_KEY");

    const account = privateKeyToAccount(privateKey);
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });

    console.log(`👤 Bob's Main Address:  ${account.address}`);

    const currentNonce = await publicClient.readContract({
        address: ERC6538_REGISTRY_ADDRESS, abi: registryAbi, functionName: 'nonceOf', args: [account.address]
    });
    console.log(`🔢 Current On-Chain Nonce: ${currentNonce}`);

    // Generate Keys
    const staticMessage = "Sign this message to generate your Ancile Privacy Keys.";
    const signedMessage = await walletClient.signMessage({ message: staticMessage });

    const spendingPrivateKey = keccak256(signedMessage);
    const viewingPrivateKey = keccak256(concatHex([spendingPrivateKey, toHex(stringToBytes("viewing"))]));

    const spendingPublicKey = ethers.utils.computePublicKey(spendingPrivateKey, true) as `0x${string}`;
    const viewingPublicKey = ethers.utils.computePublicKey(viewingPrivateKey, true) as `0x${string}`;

    const stealthMetaAddressRaw = concatHex([spendingPublicKey, viewingPublicKey]);
    console.log(`📍 Raw Meta-Address: ${stealthMetaAddressRaw}`);

    const signature = await walletClient.signTypedData({
        domain: {
            name: "ERC6538Registry",
            version: "1.0",
            chainId: baseSepolia.id,
            verifyingContract: ERC6538_REGISTRY_ADDRESS
        },
        types: {
            Erc6538RegistryEntry: [
                { name: "schemeId", type: "uint256" },
                { name: "stealthMetaAddress", type: "bytes" },
                { name: "nonce", type: "uint256" }
            ]
        },
        primaryType: "Erc6538RegistryEntry",
        message: {
            schemeId: BigInt(currentSchemeIdForBob),
            stealthMetaAddress: stealthMetaAddressRaw,
            nonce: currentNonce
        }
    });

    const addressProofPath = path.resolve(__dirname, `../../${account.address}-world-proof.json`);
    const genericProofPath = path.resolve(__dirname, "../../world-id-proof.json");
    const proofPath = fs.existsSync(addressProofPath) ? addressProofPath : genericProofPath;

    if (!fs.existsSync(proofPath)) {
        throw new Error(`❌ Missing world-id-proof.json! Bob must complete World ID verification first. Expected: ${addressProofPath}`);
    }

    const worldIdProof = JSON.parse(fs.readFileSync(proofPath, "utf-8"));
    console.log(`🛡️  World ID Proof loaded from: ${path.basename(proofPath)}`);

    // Final Payload
    const newPayload = {
        action: 1,
        data: {
            registrant: account.address,
            schemeId: currentSchemeIdForBob,
            stealthMetaAddressRaw: stealthMetaAddressRaw,
            signature: signature,
            rules: { requiresWorldID: true },
            worldIdProof: worldIdProof
        }
    };

    const latestPath = path.resolve(__dirname, "bob-latest-payload.json");
    const historyPath = path.resolve(__dirname, "bob-payload-history.json");
    fs.writeFileSync(latestPath, JSON.stringify(newPayload, null, 2));
    fs.writeFileSync(historyPath, JSON.stringify(newPayload, null, 2));

    console.log(`✅ Saved Payload to bob-latest-payload.json ready for CRE dispatch!`);
}

bobBackendSetup().catch(console.error);
