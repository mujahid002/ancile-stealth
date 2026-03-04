import { createPublicClient, http, encodePacked, keccak256 } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { baseSepolia } from "viem/chains";
import { computeStealthKey } from "@scopelift/stealth-address-sdk";
import fs from "fs";
import * as path from "path";
import config from "../../config.json";

const vaultAbi = [{ type: "function", name: "vaultNonces", inputs: [{ name: "owner", type: "address" }], outputs: [{ type: "uint256" }], stateMutability: "view" }];

async function runBobSweep() {
    console.log("🕵️  Initializing Bob's Gasless Sweep Engine...");

    // 1. Grab Alice's generated public data (for the hackathon demo, we read from Alice's payload)
    const alicePayloadPath = path.resolve(__dirname, "../alice/alice-latest-payload.json");
    const aliceData = JSON.parse(fs.readFileSync(alicePayloadPath, "utf-8")).data;

    // 2. Cryptographically derive the Stealth Private Key using Bob's Secrets
    console.log("   -> Deriving Stealth Private Key locally...");
    const stealthPrivateKeyHex = computeStealthKey({
        ephemeralPublicKey: aliceData.ephemeralPubKey,
        viewingPrivateKey: config.BOB_VIEWING_KEY,   // Your raw 32-byte hex keys from setup
        spendingPrivateKey: config.BOB_SPENDING_KEY
    });

    // Create a local signer using the derived Stealth Private Key
    const stealthAccount = privateKeyToAccount(stealthPrivateKeyHex as `0x${string}`);
    console.log(`   📍 Derived Address matches payload: ${stealthAccount.address === aliceData.stealthAddress}`);

    // 3. Setup the Sweep Details
    const destinationWallet = "0x000000000000000000000000000000000000dEaD"; // e.g. Binance Deposit Address
    const amountToSweep = BigInt(aliceData.amount);

    const publicClient = createPublicClient({ chain: baseSepolia, transport: http(config.BASE_SEPOLIA_RPC_URL) });
    const nonce = await publicClient.readContract({
        address: config.ROUTER_ADDRESS as `0x${string}`, abi: vaultAbi, functionName: 'vaultNonces', args: [stealthAccount.address]
    });

    // 4. Sign the authorization exactly like Alice did, but with the stealth key!
    const messageHash = keccak256(encodePacked(
        ['address', 'address', 'uint256', 'uint256'],
        [stealthAccount.address, destinationWallet as `0x${string}`, amountToSweep, nonce]
    ));

    const signature = await stealthAccount.signMessage({ message: { raw: messageHash } });
    const r = signature.slice(0, 66);
    const s = "0x" + signature.slice(66, 130);
    let v = parseInt(signature.slice(130, 132), 16);
    if (v < 27) v += 27;

    // 5. Package for CRE Relay
    const sweepPayload = {
        action: 3,
        data: {
            token: config.TOKEN_ADDRESS,
            amount: amountToSweep.toString(),
            stealthAddress: stealthAccount.address,
            destination: destinationWallet,
            sigV: v, sigR: r, sigS: s
        }
    };

    fs.writeFileSync(path.resolve(__dirname, "bob-sweep-payload.json"), JSON.stringify(sweepPayload, null, 2));
    console.log(`✅ Success! Bob's stealth signature is ready to be relayed by CRE.`);
}

runBobSweep().catch(console.error);