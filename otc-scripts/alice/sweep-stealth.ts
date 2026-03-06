import { createPublicClient, createWalletClient, http, parseAbi } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { computeStealthAddress, checkStealthAddress } from "@scopelift/stealth-address-sdk";
import config from "../../config.otc.json";

const ROUTER_ABI = parseAbi([
  "event Announcement(uint256 indexed schemeId, address indexed stealthAddress, bytes ephemeralPubKey, bytes metadata)",
  "function stealthBalance(address token, address stealthAddr) view returns (uint256)"
]);

const ERC20_ABI = parseAbi(["function transfer(address to, uint256 amount) public returns (bool)"]);

async function aliceSweep() {
    console.log("🕵️ Alice is scanning for her stealth funds...");

    // 1. Setup Keys (In production, these come from Alice's Meta-Address registration)
    const spendKey = config.ALICE_SPEND_KEY as `0x${string}`;
    const viewKey = config.ALICE_VIEW_KEY as `0x${string}`;
    
    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(config.BASE_SEPOLIA_RPC_URL) });

    // 2. Look for recent Announcements
    const logs = await publicClient.getContractEvents({
        address: config.ROUTER_ADDRESS as `0x${string}`,
        abi: ROUTER_ABI,
        eventName: 'Announcement',
        fromBlock: 'latest' // Change to a specific block number if needed
    });

    for (const log of logs) {
        const { stealthAddress, ephemeralPubKey, metadata } = log.args;

        // 3. Cryptographic Check: Is this Alice's money?
        const isMine = checkStealthAddress({
            stealthAddress: stealthAddress as `0x${string}`,
            ephemeralPublicKey: ephemeralPubKey as `0x${string}`,
            spendingPublicKey: config.ALICE_SPEND_PUB_KEY as `0x${string}`,
            viewingPrivateKey: viewKey
        });

        if (isMine) {
            console.log(`🎉 Found Alice's Stealth Address: ${stealthAddress}`);
            
            // 4. Generate the Private Key for this specific Stealth Address
            // This is the "Ghost Key" that only exists for this one transaction
            const stealthPrivateKey = computeStealthAddress({
                ephemeralPublicKey: ephemeralPubKey as `0x${string}`,
                spendingPrivateKey: spendKey,
                viewingPrivateKey: viewKey
            });

            const stealthAccount = privateKeyToAccount(stealthPrivateKey as `0x${string}`);
            const stealthWallet = createWalletClient({ 
                account: stealthAccount, 
                chain: baseSepolia, 
                transport: http(config.BASE_SEPOLIA_RPC_URL) 
            });

            console.log(`🚀 Sweeping funds to Alice's Coinbase Wallet: ${config.ALICE_COINBASE_ADDRESS}`);
            
            // Note: The stealth address needs a tiny bit of ETH for gas to perform this transfer
            const tx = await stealthWallet.writeContract({
                address: config.MOCK_USDC_ADDRESS as `0x${string}`,
                abi: ERC20_ABI,
                functionName: 'transfer',
                args: [config.ALICE_COINBASE_ADDRESS as `0x${string}`, 1000n * 10n**6n]
            });

            console.log(`✅ Sweep Complete! Tx: ${tx}`);
        }
    }
}

aliceSweep().catch(console.error);