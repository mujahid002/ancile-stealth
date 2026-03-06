import { createWalletClient, createPublicClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import * as fs from "fs";
import * as path from "path";
import config from "../../config.otc.json";

const REGISTRY_ABI = [{
    "inputs": [{ "internalType": "address", "name": "registrant", "type": "address" }, { "internalType": "uint256", "name": "schemeId", "type": "uint256" }],
    "name": "stealthMetaAddressOf", "outputs": [{ "internalType": "bytes", "name": "", "type": "bytes" }], "stateMutability": "view", "type": "function"
}] as const;

async function generateAliceOTCIntent() {
    console.log("📝 Generating Alice's OTC Ask (mUSDC -> mWLD)...");

    const account = privateKeyToAccount(config.ALICE_PRIVATE_KEY as `0x${string}`);
    const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(config.BASE_SEPOLIA_RPC_URL) });
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(config.BASE_SEPOLIA_RPC_URL) });

    // Fetch her receiving Meta-Address directly from the Registry (using schemeId 13)
    const stealthMetaRaw = await publicClient.readContract({
        address: config.REGISTRY_ADDRESS as `0x${string}`, abi: REGISTRY_ABI, functionName: 'stealthMetaAddressOf', args: [account.address, 13n]
    });

    const amountA = parseUnits("1000", 6); // Gives 1,000 mUSDC
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); 

    const permitSignature = await walletClient.signTypedData({
        account,
        domain: { name: "MockUSDC", version: "1", chainId: baseSepolia.id, verifyingContract: config.MOCK_USDC_ADDRESS as `0x${string}` },
        types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
        primaryType: "Permit",
        message: { owner: account.address, spender: config.ROUTER_ADDRESS as `0x${string}`, value: amountA, nonce: 0n, deadline } 
    });

    const payload = {
        maker: "Alice",
        giveToken: config.MOCK_USDC_ADDRESS,
        giveAmount: amountA.toString(),
        wantToken: config.MOCK_WLD_ADDRESS, 
        wantAmount: parseUnits("500", 6).toString(), 
        counterparty: config.BOB_PUBLIC_ADDRESS, 
        stealthMetaAddress: stealthMetaRaw, // Attached for the CRE
        permit: { owner: account.address, deadline: deadline.toString(), signature: permitSignature }
    };

    fs.writeFileSync(path.resolve(__dirname, "alice-otc-intent.json"), JSON.stringify(payload, null, 2));
    console.log("✅ Alice's OTC Intent saved!");
}

generateAliceOTCIntent().catch(console.error);
