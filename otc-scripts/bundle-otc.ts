import * as fs from "fs";
import * as path from "path";
import * as crypto from "crypto"; 

function generateEntropy() {
    return "0x" + crypto.randomBytes(32).toString("hex");
}

async function bundle() {
    console.log("📦 Bundling OTC Intents & Generating Entropy...");

    const alicePath = path.resolve(__dirname, "alice/alice-otc-intent.json");
    const bobPath = path.resolve(__dirname, "bob/bob-otc-intent.json");

    const alicePayload = JSON.parse(fs.readFileSync(alicePath, "utf-8"));
    const bobPayload = JSON.parse(fs.readFileSync(bobPath, "utf-8"));

    const masterPayload = {
        payloads: [alicePayload, bobPayload],
        entropyA: generateEntropy(), // Ephemeral Private Key for Alice's destination
        entropyB: generateEntropy()  // Ephemeral Private Key for Bob's destination
    };

    fs.writeFileSync(path.resolve(__dirname, "../otc-workflow/master-otc.json"), JSON.stringify(masterPayload, null, 2));
    console.log("✅ Saved to otc-workflow/master-otc.json with Entropy injected!");
}

bundle().catch(console.error);
