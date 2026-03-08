import { createWalletClient, createPublicClient, http, parseUnits, parseAbi } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import * as fs from "fs";
import * as path from "path";
import config from "../../config.json";

const erc20Abi = parseAbi(["function nonces(address owner) view returns (uint256)"]);

async function generateAliceAsk() {
    console.log("🌸 Alice is preparing her Sharded OTC Intent...");

    const account = privateKeyToAccount(config.ALICE_PRIVATE_KEY as `0x${string}`);
    const publicClient = createPublicClient({
        chain: baseSepolia,
        transport: http(config.BASE_SEPOLIA_RPC_URL)
    });
    const walletClient = createWalletClient({ 
        account, 
        chain: baseSepolia, 
        transport: http(config.BASE_SEPOLIA_RPC_URL) 
    });

    // 1. Generate 5 one-time Shard Wallets for maximum anonymity
    const shards: `0x${string}`[] = [];
    const shardPrivateKeys: `0x${string}`[] = [];
    
    console.log("🧮 Generating 5 temporary ghost addresses...");
    for(let i = 0; i < 5; i++) {
        const pk = generatePrivateKey();
        shardPrivateKeys.push(pk);
        shards.push(privateKeyToAccount(pk).address);
    }

    // Save keys locally so the sweep script can find them later
    const shardsPath = path.resolve(__dirname, "alice-shards.json");
    fs.writeFileSync(shardsPath, JSON.stringify(shardPrivateKeys, null, 2));
    console.log(`🔐 Private keys safely stored at: ${shardsPath}`);

    // 2. Fetch Alice's Current Nonce for MockUSDC
    console.log("🔍 Fetching Alice's current token nonce...");
    const currentNonce = await publicClient.readContract({ 
        address: config.MOCK_USDC_ADDRESS as `0x${string}`, 
        abi: erc20Abi, 
        functionName: 'nonces', 
        args: [account.address] 
    });

    // 3. Sign the EIP-2612 Permit for 1000 mUSDC
    const giveAmount = parseUnits("1000", 6);
    const wantAmount = parseUnits("500", 6); // Alice expects 500 mWLD in return
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); // 1 hour

    console.log(`📝 Signing gasless permit with nonce ${currentNonce} for 1,000 mUSDC...`);
    const signature = await walletClient.signTypedData({
        account,
        domain: { 
            name: "MockUSDC", // Update this if your token name is different
            version: "1", 
            chainId: baseSepolia.id, 
            verifyingContract: config.MOCK_USDC_ADDRESS as `0x${string}` 
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
            value: giveAmount, 
            nonce: currentNonce, // 🌟 DYNAMIC NONCE
            deadline 
        } 
    });

    // 4. Build the final Intent Payload
    const payload = {
        maker: "Alice",
        giveToken: config.MOCK_USDC_ADDRESS,
        giveAmount: giveAmount.toString(),
        wantToken: config.MOCK_WLD_ADDRESS, 
        wantAmount: wantAmount.toString(), 
        receivingShards: shards, // 🌟 The 5 public addresses the CRE will push mWLD to
        permit: { 
            owner: account.address, 
            deadline: deadline.toString(), 
            signature 
        }
    };

    const intentPath = path.resolve(__dirname, "alice-otc-intent.json");
    fs.writeFileSync(intentPath, JSON.stringify(payload, null, 2));
    console.log("✅ Alice's Sharded Intent successfully saved!");
}

generateAliceAsk().catch(console.error);
