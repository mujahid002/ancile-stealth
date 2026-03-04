import { createPublicClient, createWalletClient, http, parseAbi, encodePacked, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { computeStealthKey } from "@scopelift/stealth-address-sdk";
import fs from "fs";
import * as path from "path";
import config from "../../config.json";

const erc20Abi = parseAbi(["function nonces(address owner) view returns (uint256)"]);
const routerAbi = parseAbi(["function routerNonces(address owner) external view returns (uint256)"]);

async function runBobSweep() {
    console.log("🧹 Initializing Bob's Gasless Sweep Engine...");

    const aliceData = JSON.parse(fs.readFileSync(path.resolve(__dirname, "../alice/alice-latest-payload.json"), "utf-8")).data;
    const stealthPrivateKeyHex = computeStealthKey({
        ephemeralPublicKey: aliceData.ephemeralPubKey,
        schemeId: 1 as any, // 🌟 FIX: Added the missing schemeId!
        viewingPrivateKey: config.BOB_VIEWING_KEY as `0x${string}`,  
        spendingPrivateKey: config.BOB_SPENDING_KEY as `0x${string}`
    });
    
    const stealthAccount = privateKeyToAccount(stealthPrivateKeyHex as `0x${string}`);
    const rpcUrl = config.BASE_SEPOLIA_RPC_URL;
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
    const stealthWalletClient = createWalletClient({ account: stealthAccount, chain: baseSepolia, transport: http(rpcUrl) });

    const destinationWallet = "0x000000000000000000000000000000000000dEaD"; // Destination
    const amountToSweep = BigInt(aliceData.amount);

    // ==========================================
    // SIGNATURE 1: EIP-2612 PERMIT
    // ==========================================
    console.log("📝 Generating EIP-2612 Permit Signature (from Stealth Address)...");
    const tokenNonce = await publicClient.readContract({ address: config.TOKEN_ADDRESS as `0x${string}`, abi: erc20Abi, functionName: 'nonces', args: [stealthAccount.address] });
    const deadline = BigInt(Math.floor(Date.now() / 1000) + 3600);

    const permitSignature = await stealthWalletClient.signTypedData({
        account: stealthAccount,
        domain: { name: "Mock USDC", version: "1", chainId: baseSepolia.id, verifyingContract: config.TOKEN_ADDRESS as `0x${string}` },
        types: {
            Permit: [
                { name: "owner", type: "address" }, { name: "spender", type: "address" },
                { name: "value", type: "uint256" }, { name: "nonce", type: "uint256" }, { name: "deadline", type: "uint256" }
            ]
        },
        primaryType: "Permit",
        message: { owner: stealthAccount.address, spender: config.ROUTER_ADDRESS as `0x${string}`, value: amountToSweep, nonce: tokenNonce, deadline: deadline }
    });

    // ==========================================
    // SIGNATURE 2: ROUTER INTENT
    // ==========================================
    console.log("🔐 Generating Router Intent Signature...");
    const routerNonce = await publicClient.readContract({ address: config.ROUTER_ADDRESS as `0x${string}`, abi: routerAbi, functionName: 'routerNonces', args: [stealthAccount.address] });
    
    const intentHash = keccak256(encodePacked(['address', 'address', 'uint256', 'uint256'], [stealthAccount.address, destinationWallet as `0x${string}`, amountToSweep, routerNonce]));
    const intentSignature = await stealthWalletClient.signMessage({ account: stealthAccount, message: { raw: intentHash } });

    function splitSig(sig: string) {
        const r = sig.slice(0, 66) as `0x${string}`;
        const s = "0x" + sig.slice(66, 130) as `0x${string}`;
        let v = parseInt(sig.slice(130, 132), 16); if (v < 27) v += 27;
        return { v, r, s };
    }

    const sweepPayload = {
        action: 3,
        data: {
            token: config.TOKEN_ADDRESS, amount: amountToSweep.toString(), stealthAddress: stealthAccount.address, destination: destinationWallet,
            permit: { deadline: deadline.toString(), ...splitSig(permitSignature) },
            intent: { ...splitSig(intentSignature) }
        }
    };

    fs.writeFileSync(path.resolve(__dirname, "bob-sweep-payload.json"), JSON.stringify(sweepPayload, null, 2));
    console.log(`✅ Success! Bob's Sweep Payload saved! Ready for CRE relay.`);
}

runBobSweep().catch(console.error);