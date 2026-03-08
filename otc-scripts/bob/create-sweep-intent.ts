import { createWalletClient, createPublicClient, http, parseAbi, keccak256, encodePacked } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import * as fs from "fs";
import * as path from "path";
import config from "../../config.json";

const ERC20_ABI = parseAbi([
    "function balanceOf(address account) view returns (uint256)",
    "function nonces(address owner) view returns (uint256)"
]);
const ROUTER_ABI = parseAbi(["function routerNonces(address owner) external view returns (uint256)"]);

async function generateGaslessSweep() {
    console.log("🧹 Bob is preparing his Gasless Batch Sweep...");

    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(config.BASE_SEPOLIA_RPC_URL) });
    
    // 1. Read Bob's specific shard keys
    const shardKeys: `0x${string}`[] = JSON.parse(fs.readFileSync(path.resolve(__dirname, "bob-shards.json"), "utf-8"));

    const sweepPayloads: any = [];
    // 2. Route to Bob's Centralized Exchange address
    const destination = "0x000000000000000000000000000000000000dEaD" as `0x${string}`; 

    for (let i = 0; i < shardKeys.length; i++) {
        const account = privateKeyToAccount(shardKeys[i]);
        const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(config.BASE_SEPOLIA_RPC_URL) });

        // 3. Check balance for mUSDC (which Bob received from Alice)
        const balance = await publicClient.readContract({ 
            address: config.MOCK_USDC_ADDRESS as `0x${string}`, abi: ERC20_ABI, functionName: 'balanceOf', args: [account.address] 
        });

        if (balance > 0n) {
            console.log(`👻 Shard ${account.address} has ${balance} mUSDC. Generating signatures...`);

            const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

            // Fetch on-chain nonces for correct signature generation
            const permitNonce = await publicClient.readContract({
                address: config.MOCK_USDC_ADDRESS as `0x${string}`, abi: ERC20_ABI, functionName: 'nonces', args: [account.address]
            });
            const routerNonce = await publicClient.readContract({
                address: config.ROUTER_ADDRESS as `0x${string}`, abi: ROUTER_ABI, functionName: 'routerNonces', args: [account.address]
            });

            // 4. Sign EIP-2612 Permit for MockUSDC
            const permitSig = await walletClient.signTypedData({
                account,
                domain: {
                    name: "MockUSDC",
                    version: "1",
                    chainId: baseSepolia.id,
                    verifyingContract: config.MOCK_USDC_ADDRESS as `0x${string}`
                },
                types: { Permit: [{ name: "owner", type: "address" }, { name: "spender", type: "address" }, { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }] },
                primaryType: "Permit",
                message: { owner: account.address, spender: config.ROUTER_ADDRESS as `0x${string}`, value: balance, nonce: permitNonce, deadline }
            });

            // 5. Sign Router Intent: keccak256(stealthAddress, destination, amount, routerNonce)
            const messageHash = keccak256(encodePacked(
                ["address", "address", "uint256", "uint256"],
                [account.address, destination, balance, routerNonce]
            ));
            
            const intentSig = await walletClient.signMessage({ account, message: { raw: messageHash } });

            sweepPayloads.push({
                token: config.MOCK_USDC_ADDRESS,
                amount: balance.toString(),
                stealthAddress: account.address,
                destination: destination,
                permit: { deadline: deadline.toString(), signature: permitSig },
                intent: { signature: intentSig }
            });
        }
    }

    if (sweepPayloads.length === 0) {
        console.log("⚠️ No mUSDC found in Bob's shards. Has the Mega-Batch OTC executed yet?");
        return;
    }

    // 6. Output the final payload
    const outPath = path.resolve(__dirname, "bob-sweep-bundle.json");
    fs.writeFileSync(outPath, JSON.stringify({ payloads: sweepPayloads }, null, 2));
    console.log(`✅ Gasless Sweep Intent saved to ${outPath}`);
}

generateGaslessSweep().catch(console.error);