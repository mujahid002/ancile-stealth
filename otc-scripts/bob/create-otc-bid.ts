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

async function generateBobOTCIntent() {
    console.log("📝 Generating Bob's OTC Bid (mWLD -> mUSDC)...");

    const account = privateKeyToAccount(config.BOB_PRIVATE_KEY as `0x${string}`);
    const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(config.BASE_SEPOLIA_RPC_URL) });
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(config.BASE_SEPOLIA_RPC_URL) });

    // Fetch his receiving Meta-Address directly from the Registry
    const stealthMetaRaw = await publicClient.readContract({
        address: config.REGISTRY_ADDRESS as `0x${string}`, abi: REGISTRY_ABI, functionName: 'stealthMetaAddressOf', args: [account.address, 13n]
    });

    const amountB = parseUnits("500", 6); // Gives 500 mWLD
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const permitSignature = await walletClient.signTypedData({
        account,
        domain: { name: "MockWLD", version: "1", chainId: baseSepolia.id, verifyingContract: config.MOCK_WLD_ADDRESS as `0x${string}` },
        types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
        primaryType: "Permit",
        message: { owner: account.address, spender: config.ROUTER_ADDRESS as `0x${string}`, value: amountB, nonce: 0n, deadline }
    });

    const payload = {
        maker: "Bob",
        giveToken: config.MOCK_WLD_ADDRESS,
        giveAmount: amountB.toString(),
        wantToken: config.MOCK_USDC_ADDRESS,
        wantAmount: parseUnits("1000", 6).toString(),
        counterparty: config.ALICE_PUBLIC_ADDRESS,
        stealthMetaAddress: stealthMetaRaw, // Attached for the CRE
        permit: { owner: account.address, deadline: deadline.toString(), signature: permitSignature }
    };

    fs.writeFileSync(path.resolve(__dirname, "bob-otc-intent.json"), JSON.stringify(payload, null, 2));
    console.log("✅ Bob's OTC Intent saved!");
}

generateBobOTCIntent().catch(console.error);
