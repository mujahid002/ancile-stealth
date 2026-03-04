import { createPublicClient, createWalletClient, http, parseAbi, encodePacked, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { generateStealthAddress } from "@scopelift/stealth-address-sdk";
import fs from "fs";
import * as path from "path";
import config from "../../config.json";

// --- ABIs ---
const erc20Abi = parseAbi([
    "function approve(address spender, uint256 amount) external returns (bool)",
    "function balanceOf(address account) external view returns (uint256)"
]);

const vaultAbi = parseAbi([
    "function deposit(address token, uint256 amount) external",
    "function vaultNonces(address owner) external view returns (uint256)",
    "function creSchemeIds(address registrant) external view returns (uint256)"
]);

const registryAbi = parseAbi([
    "function stealthMetaAddressOf(address registrant, uint256 schemeId) external view returns (bytes)"
]);

async function runAliceFullFlow() {
    console.log("🌸 Initializing Alice's One-Click Vault & Dispatch Engine...");

    const rpcUrl = config.BASE_SEPOLIA_RPC_URL;
    const privateKey = config.ALICE_PRIVATE_KEY as `0x${string}`;
    const account = privateKeyToAccount(privateKey);
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(rpcUrl) });
    const walletClient = createWalletClient({ account, chain: baseSepolia, transport: http(rpcUrl) });

    // 10 mUSDC (Assuming 6 decimals)
    const amountToProcess = 10n * 10n ** 6n; 

    // ==========================================
    // STEP 1: NATIVE ON-CHAIN DEPOSIT (Fixed RPC Desync)
    // ==========================================
    console.log(`\n💰 Phase 1: Depositing ${amountToProcess.toString()} units into Vault...`);
    
    console.log("   -> Approving Vault...");
    // Bypass simulateContract to prevent RPC lag. Send directly!
    const approveTx = await walletClient.writeContract({
        account,
        address: config.TOKEN_ADDRESS as `0x${string}`,
        abi: erc20Abi,
        functionName: 'approve',
        args: [config.ROUTER_ADDRESS as `0x${string}`, amountToProcess],
        chain: baseSepolia
    });
    
    const approveReceipt = await publicClient.waitForTransactionReceipt({ hash: approveTx });
    if (approveReceipt.status !== 'success') {
        throw new Error(`❌ Approve transaction reverted on-chain! Make sure Alice has ETH for gas.`);
    }
    console.log(`   ✅ Approved! (Tx: ${approveTx})`);

    // Give the RPC nodes 2 seconds to catch their breath and sync the state
    await new Promise(resolve => setTimeout(resolve, 2000));

    console.log("   -> Executing Deposit...");
    const depositTx = await walletClient.writeContract({
        account,
        address: config.ROUTER_ADDRESS as `0x${string}`,
        abi: vaultAbi,
        functionName: 'deposit',
        args: [config.TOKEN_ADDRESS as `0x${string}`, amountToProcess],
        chain: baseSepolia
    });
    
    const depositReceipt = await publicClient.waitForTransactionReceipt({ hash: depositTx });
    if (depositReceipt.status !== 'success') {
        throw new Error(`❌ Deposit transaction reverted! Make sure Alice actually has ${amountToProcess.toString()} tokens in her wallet.`);
    }
    console.log(`   ✅ Deposit Complete! Alice's funds are secured in the Vault. (Tx: ${depositTx})`);

    // ==========================================
    // STEP 2: OFF-CHAIN ROUTING PAYLOAD
    // ==========================================
    console.log("\n🔐 Phase 2: Generating Stealth Routing Payload for CRE...");

    let schemeId = await publicClient.readContract({
        address: config.ROUTER_ADDRESS as `0x${string}`, abi: vaultAbi, functionName: 'creSchemeIds', args: [config.BOB_PUBLIC_ADDRESS as `0x${string}`]
    });
    if (schemeId === 0n) {
        console.log("!Bob not registered")
        return;
    }
    console.log(`   -> Fetching Meta-Address for Bob...`);
    const bobMetaAddress = await publicClient.readContract({
        address: config.REGISTRY_ADDRESS as `0x${string}`, abi: registryAbi, functionName: 'stealthMetaAddressOf', args: [config.BOB_PUBLIC_ADDRESS as `0x${string}`, schemeId]
    });

    const { stealthAddress, ephemeralPublicKey } = generateStealthAddress({ stealthMetaAddressURI: `st:eth:${bobMetaAddress}` });
    console.log(`   📍 Destination Stealth Address: ${stealthAddress}`);

    const nonce = await publicClient.readContract({
        address: config.ROUTER_ADDRESS as `0x${string}`, abi: vaultAbi, functionName: 'vaultNonces', args: [account.address]
    });

    // Hash: sender + stealthAddress + amount + nonce
    const messageHash = keccak256(
        encodePacked(
            ['address', 'address', 'uint256', 'uint256'],
            [account.address, stealthAddress as `0x${string}`, amountToProcess, nonce]
        )
    );

    const signature = await walletClient.signMessage({ account, message: { raw: messageHash } });
    const r = signature.slice(0, 66) as `0x${string}`;
    const s = "0x" + signature.slice(66, 130) as `0x${string}`;
    let v = parseInt(signature.slice(130, 132), 16);
    if (v < 27) v += 27;

    const proofPath = path.resolve(__dirname, "../world-id-proof.json");
    let worldIdProof = fs.existsSync(proofPath) ? JSON.parse(fs.readFileSync(proofPath, "utf-8")) : null;

    const newPayload = {
        action: 2,
        data: {
            token: config.TOKEN_ADDRESS,
            amount: amountToProcess.toString(),
            sender: account.address,
            recipientRegistrant: config.BOB_PUBLIC_ADDRESS,
            stealthAddress: stealthAddress,
            ephemeralPubKey: ephemeralPublicKey,
            sigV: v, sigR: r, sigS: s,
            worldIdProof
        }
    };

    const payloadPath = path.resolve(__dirname, "alice-latest-payload.json");
    fs.writeFileSync(payloadPath, JSON.stringify(newPayload, null, 2));
    console.log(`\n✅ Success! Payload saved to ${payloadPath}`);
    console.log(`🚀 Ready to broadcast via Chainlink CRE!`);
}

runAliceFullFlow().catch(console.error);
