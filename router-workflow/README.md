# P2P Workflow (Ancile Stealth Registration)

This template provides a simple Typescript workflow example. It shows how to create a simple "Hello World" workflow using Typescript.

Steps to run the example

## 1. Update .env file

You need to add a private key to env file. This is specifically required if you want to simulate chain writes. For that to work the key should be valid and funded.
If your workflow does not do any chain write then you can just put any dummy key as a private key. e.g.

```
CRE_ETH_PRIVATE_KEY=0000000000000000000000000000000000000000000000000000000000000001
```

Note: Make sure your `workflow.yaml` file is pointing to the config.json, example:

```yaml
staging-settings:
  user-workflow:
    workflow-name: "hello-world"
  workflow-artifacts:
    workflow-path: "./main.ts"
    config-path: "./config.json"
```

## 2. Install dependencies

If `bun` is not already installed, see https://bun.com/docs/installation for installing in your environment.

```bash
cd <workflow-name> && bun install
```

Example: For a workflow directory named `hello-world` the command would be:

```bash
cd hello-world && bun install
```

## 3. Simulate the workflow

Run the command from <b>project root directory</b>

```bash
cre workflow simulate <path-to-workflow-directory> --target=staging-settings
```

Example: For workflow named `hello-world` the command would be:

```bash
cre workflow simulate ./p2p-workflow --target=staging-settings
```

Non-interactive with HTTP payload (run from project root). Some CLI versions pass a file path as literal payload; use inline JSON to avoid "unexpected token: '.'":

```bash
cre workflow simulate ./p2p-workflow --target staging-settings \
  --non-interactive --trigger-index 0 --http-payload '{"registrant":"0x...","schemeId":1,"stealthMetaAddressRaw":"0x...","signature":"0x...","rules":{"requiresWorldID":true}}'
```

Or try file path with `@` prefix: `--http-payload @./scripts/bob-payload.json`

## Troubleshooting: "wasm unreachable" during subscribe

If you see:

```text
Failed to create engine: failed to execute subscribe: error while executing at wasm backtrace: ...
Caused by: wasm trap: wasm `unreachable` instruction executed
```

the failure happens when the workflow engine registers triggers (before your handler runs). Common causes:

1. **ethers in WASM** – The workflow is compiled to WASM (QuickJS). The `ethers` (v5) stack can use APIs that aren’t supported there and trigger an `unreachable` when the module loads. To confirm:
   - In `workflow.yaml`, under `workflow-artifacts`, temporarily set `workflow-path: "./main.minimal.ts"`.
   - Run the same simulate command. If simulation succeeds with `main.minimal.ts` (no ethers) but fails with `main.ts`, the issue is ethers/WASM compatibility. For production onchain writes, consider using the CRE SDK’s EVM client (report-based flow) instead of raw ethers where possible, or report the incompatibility to Chainlink.

2. **More detail** – Run with engine and CLI logs:
   ```bash
   cre workflow simulate ./p2p-workflow --target staging-settings --engine-logs --verbose \
     --non-interactive --trigger-index 0 --http-payload ./scripts/bob-payload.json
   ```

3. **Payload path** – For file payloads, use a path that’s valid from the directory you run the command from (e.g. `./scripts/bob-payload.json` from project root), or put the payload in the workflow folder and use e.g. `--http-payload ./bob-payload.json`.
