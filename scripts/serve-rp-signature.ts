import { signRequest } from "@worldcoin/idkit-core/signing";
import * as dotenv from "dotenv";
import * as path from "path";
import * as fs from "fs";
import { createServer, type IncomingMessage, type ServerResponse } from "http";

const PORT = 3765;
const DEFAULT_ACTION = "cre-ancile-stealth-verification";

dotenv.config({ path: path.resolve(__dirname, ".env") });

const RP_SIGNING_KEY = process.env.RP_SIGNING_KEY;
const APP_ID = process.env.APP_ID;
const RP_ID = process.env.RP_ID ?? process.env.APP_ID;

if (!RP_SIGNING_KEY || !RP_ID) {
  console.error("Missing RP_SIGNING_KEY or RP_ID in .env");
  process.exit(1);
}

function send(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
  });
  res.end(JSON.stringify(body));
}

createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  // Handle CORS Preflight
  if (req.method === "OPTIONS") {
      send(res, 204, {});
      return;
  }

  // 1. RP Context Endpoint
  if (url.pathname === "/rp-context" && req.method === "GET") {
    const action = url.searchParams.get("action") ?? DEFAULT_ACTION;
    try {
      const { sig, nonce, createdAt, expiresAt } = signRequest(action, RP_SIGNING_KEY as string);
      send(res, 200, {
        sig, nonce, created_at: createdAt, expires_at: expiresAt, signature: sig, rp_id: RP_ID, app_id: APP_ID,
      });
    } catch (e) {
      send(res, 500, { error: String(e) });
    }
    return;
  }

  // Auto-Save Endpoint
  if (url.pathname === "/save-proof" && req.method === "POST") {
    let body = "";
    req.on("data", chunk => body += chunk.toString());
    req.on("end", () => {
        try {
            const proofPath = path.resolve(__dirname, "world-id-proof.json");
            // Pretty-print the JSON and save it
            fs.writeFileSync(proofPath, JSON.stringify(JSON.parse(body), null, 2), "utf-8");
            console.log(`\n💾 SUCCESS: Proof auto-saved to ${proofPath}`);
            send(res, 200, { success: true, path: proofPath });
        } catch (e) {
            console.error("Save Error:", e);
            send(res, 500, { error: String(e) });
        }
    });
    return;
  }

  send(res, 404, { error: "Not found" });
}).listen(PORT, () => {
  console.log(`🚀 Ancile Local Server Running:`);
  console.log(`   - RP Engine: http://localhost:${PORT}/rp-context`);
  console.log(`   - File Saver: http://localhost:${PORT}/save-proof`);
});
