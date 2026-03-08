import * as fs from "fs";
import * as path from "path";

async function bundleShardedOTC() {
    console.log("📦 Bundling Sharded OTC Intents...");

    // 1. Resolve paths to the generated JSON intents
    const alicePath = path.resolve(__dirname, "alice/alice-otc-intent.json");
    const bobPath = path.resolve(__dirname, "bob/bob-otc-intent.json");

    // Ensure the files actually exist before bundling
    if (!fs.existsSync(alicePath)) {
        throw new Error("❌ Alice's intent not found! Run 'create-otc-ask.ts' first.");
    }
    if (!fs.existsSync(bobPath)) {
        throw new Error("❌ Bob's intent not found! Run 'create-otc-bid.ts' first.");
    }

    // 2. Read the intents
    const aliceIntent = JSON.parse(fs.readFileSync(alicePath, "utf-8"));
    const bobIntent = JSON.parse(fs.readFileSync(bobPath, "utf-8"));

    // 3. Construct the Master Payload
    const masterPayload = {
        payloads: [
            aliceIntent,
            bobIntent
        ]
    };

    // 4. Save to master-otc.json for the Chainlink CRE (in the correct folder!)
    const masterPath = path.resolve(__dirname, "../otc-workflow/master-otc.json");
    fs.writeFileSync(masterPath, JSON.stringify(masterPayload, null, 2));

    console.log(`✅ Master payload successfully bundled at: ${masterPath}`);
    console.log(`\n🎉 You are ready to execute the Darkpool!`);
    console.log(`➡️ Run: cre workflow simulate ./otc-workflow --target staging-settings --non-interactive --trigger-index 0 --http-payload "$(cat ./otc-workflow/master-otc.json)" --broadcast`);
}

bundleShardedOTC().catch(console.error);
