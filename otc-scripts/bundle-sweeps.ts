import * as fs from "fs";
import * as path from "path";

function bundleSweeps() {
    console.log("📦 Bundling Alice and Bob's Sweep Intents...");

    const alicePath = path.resolve(__dirname, "alice/alice-sweep-bundle.json");
    const bobPath = path.resolve(__dirname, "bob/bob-sweep-bundle.json");
    const outPath = path.resolve(__dirname, "../otc-workflow/master-sweep.json");

    if (!fs.existsSync(alicePath) || !fs.existsSync(bobPath)) {
        throw new Error("❌ Missing one of the sweep bundles. Ensure both Alice and Bob generated their intents.");
    }

    const aliceData = JSON.parse(fs.readFileSync(alicePath, "utf-8"));
    const bobData = JSON.parse(fs.readFileSync(bobPath, "utf-8"));

    // Combine both payload arrays into one
    const combinedPayloads = [...aliceData.payloads, ...bobData.payloads];

    // Wrap it in the top-level object the CRE expects
    const finalMasterPayload = {
        payloads: combinedPayloads
    };

    fs.writeFileSync(outPath, JSON.stringify(finalMasterPayload, null, 2));

    console.log(`✅ Master sweep payload successfully bundled (${combinedPayloads.length} total shards) at: ${outPath}`);
}

bundleSweeps();