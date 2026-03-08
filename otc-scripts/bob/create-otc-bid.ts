import { createWalletClient, createPublicClient, http, parseUnits, parseAbi } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import * as fs from "fs";
import * as path from "path";
import config from "../../config.json";

const erc20Abi = parseAbi(["function nonces(address owner) view returns (uint256)"]);

async function generateBobBid() {
    console.log("🟦 Bob is preparing his Sharded OTC Intent...");

    const account = privateKeyToAccount(config.BOB_PRIVATE_KEY as `0x${string}`);
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
    
    console.log("🧮 Generating 5 temporary ghost addresses for Bob...");
    for(let i = 0; i < 5; i++) {
        const pk = generatePrivateKey();
        shardPrivateKeys.push(pk);
        shards.push(privateKeyToAccount(pk).address);
    }

    const shardsPath = path.resolve(__dirname, "bob-shards.json");
    fs.writeFileSync(shardsPath, JSON.stringify(shardPrivateKeys, null, 2));
    console.log(`🔐 Bob's private keys safely stored at: ${shardsPath}`);

    // 2. Fetch Bob's Current Nonce for MockWLD
    console.log("🔍 Fetching Bob's current token nonce...");
    const currentNonce = await publicClient.readContract({ 
        address: config.MOCK_WLD_ADDRESS as `0x${string}`, 
        abi: erc20Abi, 
        functionName: 'nonces', 
        args: [account.address] 
    });

    // 3. Sign the EIP-2612 Permit for 500 mWLD
    const giveAmount = parseUnits("500", 6); // Assuming mWLD has 6 decimals, adjust if 18
    const wantAmount = parseUnits("1000", 6); 
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600); 

    console.log(`📝 Signing gasless permit with nonce ${currentNonce} for 500 mWLD...`);
    const signature = await walletClient.signTypedData({
        account,
        domain: { 
            name: "MockWLD", // Ensure this matches your token's exact string name
            version: "1", 
            chainId: baseSepolia.id, 
            verifyingContract: config.MOCK_WLD_ADDRESS as `0x${string}` 
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

    const payload = {
        maker: "Bob",
        giveToken: config.MOCK_WLD_ADDRESS,
        giveAmount: giveAmount.toString(),
        wantToken: config.MOCK_USDC_ADDRESS, 
        wantAmount: wantAmount.toString(), 
        receivingShards: shards, 
        permit: { 
            owner: account.address, 
            deadline: deadline.toString(), 
            signature 
        }
    };

    const intentPath = path.resolve(__dirname, "bob-otc-intent.json");
    fs.writeFileSync(intentPath, JSON.stringify(payload, null, 2));
    console.log("✅ Bob's Sharded Intent successfully saved!");
}

generateBobBid().catch(console.error);
