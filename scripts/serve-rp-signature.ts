import { signRequest } from "@worldcoin/idkit-core/signing";
import * as dotenv from "dotenv";
import * as fs from "fs";
import * as path from "path";
import { createServer, type IncomingMessage, type ServerResponse } from "http";

const PORT = 3765;
const DEFAULT_ACTION = "test-ancile-verification";

dotenv.config({ path: path.resolve(__dirname, ".env") });

const RP_SIGNING_KEY = process.env.RP_SIGNING_KEY;
const APP_ID = process.env.APP_ID;
const RP_ID = process.env.RP_ID ?? process.env.APP_ID;

let ALICE_PUBLIC_ADDRESS = process.env.ALICE_PUBLIC_ADDRESS ?? "";
if (!ALICE_PUBLIC_ADDRESS) {
  try {
    const configPath = path.resolve(__dirname, "../../config.json");
    const config = JSON.parse(fs.readFileSync(configPath, "utf-8"));
    ALICE_PUBLIC_ADDRESS = config.ALICE_PUBLIC_ADDRESS ?? "";
  } catch (_) {}
}

if (!RP_SIGNING_KEY || !RP_ID) {
  console.error("Missing RP_SIGNING_KEY or RP_ID in .env");
  process.exit(1);
}

function send(res: ServerResponse, status: number, body: object) {
  res.writeHead(status, {
    "Content-Type": "application/json",
    "Access-Control-Allow-Origin": "*",
  });
  res.end(JSON.stringify(body));
}

createServer((req: IncomingMessage, res: ServerResponse) => {
  const url = new URL(req.url ?? "/", `http://localhost:${PORT}`);

  if (url.pathname === "/rp-context" && req.method === "GET") {
    const action = url.searchParams.get("action") ?? DEFAULT_ACTION;
    try {
      const { sig, nonce, createdAt, expiresAt } = signRequest(action, RP_SIGNING_KEY as string);
      send(res, 200, {
        sig,
        nonce,
        created_at: createdAt,
        expires_at: expiresAt,
        signature: sig,
        rp_id: RP_ID,
        app_id: APP_ID,
        signal_hint: ALICE_PUBLIC_ADDRESS || undefined,
      });
    } catch (e) {
      send(res, 500, { error: String(e) });
    }
    return;
  }

  send(res, 404, { error: "Not found" });
}).listen(PORT, () => {
  console.log(`http://localhost:${PORT}/rp-context`);
});
