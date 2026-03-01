import { createWalletClient, http, createPublicClient, concatHex, keccak256, toHex, stringToBytes } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { ethers } from "ethers"; // Only used for the compressed public key math
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";

dotenv.config({ path: path.resolve(__dirname, '.env.staging') });

const ERC6538_REGISTRY_ADDRESS = "0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538";

// Minimal ABI to read the nonce
const registryAbi = [
    {
        "inputs": [{ "internalType": "address", "name": "registrant", "type": "address" }],
        "name": "nonceOf",
        "outputs": [{ "internalType": "uint256", "name": "", "type": "uint256" }],
        "stateMutability": "view",
        "type": "function"
    }
] as const;

async function bobBackendSetup() {
    console.log("⚙️  Initializing Bob's Privacy Setup (Viem Engine)...");

    const rpcUrl = process.env.BASE_SEPOLIA_RPC_URL;
    const privateKey = process.env.BOB_PRIVATE_KEY as `0x${string}`;
    if (!rpcUrl || !privateKey) throw new Error("Missing env vars in .env.staging");

    const account = privateKeyToAccount(privateKey);
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });

    console.log(`👤 Bob's Main Address:  ${account.address}`);

    // 1. Fetch exact nonce from Base Sepolia
    const currentNonce = await publicClient.readContract({
        address: ERC6538_REGISTRY_ADDRESS,
        abi: registryAbi,
        functionName: 'nonceOf',
        args: [account.address]
    });
    console.log(`🔢 Current On-Chain Nonce: ${currentNonce}`);

    // 2. Generate Keys
    const staticMessage = "Sign this message to generate your Ancile Privacy Keys.";
    const signedMessage = await walletClient.signMessage({ message: staticMessage });

    const spendingPrivateKey = keccak256(signedMessage);
    const viewingPrivateKey = keccak256(concatHex([spendingPrivateKey, toHex(stringToBytes("viewing"))]));

    const spendingPublicKey = ethers.utils.computePublicKey(spendingPrivateKey, true) as `0x${string}`;
    const viewingPublicKey = ethers.utils.computePublicKey(viewingPrivateKey, true) as `0x${string}`;

    // 3. Raw 66-byte concatenation (Bypasses SDK string bugs)
    const stealthMetaAddressRaw = concatHex([spendingPublicKey, viewingPublicKey]);
    console.log(`📍 Raw Meta-Address: ${stealthMetaAddressRaw.substring(0, 15)}...`);

    // 4. Perfect EIP-712 Signature
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
            schemeId: 1n,
            stealthMetaAddress: stealthMetaAddressRaw,
            nonce: currentNonce
        }
    });

    // 5. Save Payload
    const newPayload = {
        timestamp: new Date().toISOString(),
        registrant: account.address,
        schemeId: 1,
        stealthMetaAddressRaw: stealthMetaAddressRaw,
        signature: signature,
        rules: { requiresWorldID: true }
    };

    // Save history to the array
    const historyPath = path.resolve(__dirname, "bob-payload-history.json");
    let payloads: any[] = [];
    if (fs.existsSync(historyPath)) {
        try {
            payloads = JSON.parse(fs.readFileSync(historyPath, "utf-8"));
            if (!Array.isArray(payloads)) payloads = [payloads];
        } catch (e) { payloads = []; }
    }
    payloads.push(newPayload);
    fs.writeFileSync(historyPath, JSON.stringify(payloads, null, 2));

    // 🌟 THE BYPASS: Save strictly as a single object for the Wasm CLI
    const latestPath = path.resolve(__dirname, "latest-payload.json");
    fs.writeFileSync(latestPath, JSON.stringify(newPayload, null, 2));

    console.log(`✅ Appended history to bob-payload-history.json`);
    console.log(`✅ Saved single object for CRE to latest-payload.json`);
}

bobBackendSetup().catch(console.error);
