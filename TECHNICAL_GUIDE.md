# Ancile Protocol: Technical Guide & Execution Manual

> Step-by-step CLI instructions, repository architecture, contract interface reference, and live transaction proofs for the Ancile Protocol.

For the project overview and vision: see [README.md](./README.md)

---

## Table of Contents

1. [Architecture Overview](#1-architecture-overview)
2. [Smart Contract Interface](#2-smart-contract-interface)
3. [Repository Structure](#3-repository-structure)
4. [Prerequisites & Setup](#4-prerequisites--setup)
5. [Flow 1: P2P Private Transfer](#5-flow-1-p2p-private-transfer)
6. [Flow 2: Sharded OTC Darkpool](#6-flow-2-sharded-otc-darkpool)
7. [How the CRE Workflows Work](#7-how-the-cre-workflows-work)
8. [Security: Signature Verification In Depth](#8-security-signature-verification-in-depth)
9. [Deployed Contracts](#9-deployed-contracts)

---

## 1. Architecture Overview

Ancile has three distinct layers that interact in a strict pipeline:

```
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 1: Off-chain Intent Builders (p2p-scripts / otc-scripts)      │
│                                                                      │
│  User runs a local TypeScript script that:                           │
│   • Derives ERC-5564 stealth keys from a deterministic wallet sig    │
│   • Reads on-chain state (token nonces, router nonces, registry)     │
│   • Signs EIP-2612 Permit + Ancile Intent hash                       │
│   • Writes a JSON payload file for the CRE to consume                │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ JSON payload (never hits mempool)
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 2: Chainlink CRE Workflow (p2p-workflow / otc-workflow)       │
│                              [TEE]                                   │
│  TypeScript workflow running inside a Trusted Execution Environment: │
│   • Validates World ID ZK proof (Semaphore nullifier check)          │
│   • Derives stealth address via secp256k1 ECDH (ERC-5564 math)       │
│   • Builds and signs on-chain calldata                               │
│   • Submits single atomic transaction via the Chainlink Forwarder    │
└───────────────────────────────┬──────────────────────────────────────┘
                                │ onReport(metadata, ABI-encoded report)
                                ▼
┌──────────────────────────────────────────────────────────────────────┐
│  LAYER 3: AncileRouter.sol (Base Sepolia)                            │
│                                                                      │
│  Single on-chain execution engine:                                   │
│   • Decodes ActionType from the CRE attestation                      │
│   • Verifies intent signature via ecrecover (replay-protected)       │
│   • Pulls tokens via EIP-2612 Permit (gasless for user)              │
│   • Routes funds to derived stealth address in same atomic tx        │
│   • Emits ERC-5564 Announcement event (ephemeralPubKey + viewTag)    │
└──────────────────────────────────────────────────────────────────────┘
```

**The critical insight:** The user never submits a transaction. The user never spends ETH. Every action from the user's side is a cryptographic signature. The Chainlink CRE is the exclusive on-chain actor: funded from a separate relayer wallet: making it impossible to link user actions to the resulting chain state via gas funding.

---

## 2. Smart Contract Interface

### `AncileRouter.sol`

UUPS upgradeable proxy. One public entry point: `onReport`, callable exclusively by the Chainlink Forwarder address registered at deployment.

```solidity
function onReport(bytes calldata metadata, bytes calldata report) external;
```

The `report` is ABI-encoded as `(ActionType actionType, bytes payload)`. The router decodes the action and dispatches internally.

```solidity
enum ActionType {
    DEFAULT,         // 0: unused
    REGISTER,        // 1: Register ERC-5564 meta-address + set compliance rules
    P2P_DISPATCH,    // 2: Pull from sender via permit, push to derived stealth address
    SWEEP,           // 3: Single stealth address -> destination (signature-gated)
    SWAP,            // 4: Token -> ETH from stealth address (roadmap)
    OTC_SWAP,        // 5: Atomic 1-to-1 token swap (direct OTC)
    MEGA_BATCH_OTC,  // 6: Sharded darkpool: N inputs -> M ghost wallet outputs
    BATCH_SWEEP      // 7: Multi-shard batch: sweep K ghost wallets in one transaction
}
```

### Key Internal State

```solidity
// Replay protection for intent signatures
mapping(address => uint256) public routerNonces;

// Per-user compliance rules (set during REGISTER)
mapping(address => ComplianceRule) public complianceRules;

// ERC-6538 registry reference (for meta-address lookups)
IERC6538Registry public immutable registry;
```

### `ComplianceRule` Options

| Value | Meaning |
|---|---|
| `NONE` | No compliance requirement: anyone can send |
| `WORLD_ID_REQUIRED` | Sender must present a valid World ID ZK proof to the CRE |

Roadmap: Include ZK, social verifications and passport.xyz integration.

### Action Payloads (ABI-encoded inside `report`)

**REGISTER (1)**
```
(address user, bytes metaAddress, uint8 schemeId, ComplianceRule rule, WorldIdProof proof)
```

**P2P_DISPATCH (2)**
```
(address sender, address stealthAddress, uint256 amount, address token,
 PermitData permit, IntentSig intent)
```

**MEGA_BATCH_OTC (6)**
```
(PermitPull[] pulls, ShardPush[] pushes)
// pulls: [{owner, token, amount, permit}]
// pushes: [{recipient, token, amount}]
```

**BATCH_SWEEP (7)**
```
(SweepEntry[] sweeps)
// sweeps: [{stealthAddress, destination, token, amount, permit, intentSig}]
```

Roadmap: Contract also include SWAP methos which acts as private swaps but AncileRouter should acts as basic vault or liquidity pool but current focus is on stateless router.

---

## 3. Repository Structure

```
ancile-cre-stealth/
│
├── contracts/                           # Hardhat v3 project
│   ├── contracts/
│   │   ├── AncileRouter.sol             # Core router: UUPS upgradeable
│   │   │                                #   All ActionType handlers
│   │   │                                #   routerNonces (replay protection)
│   │   │                                #   complianceRules (per-user)
│   │   │                                #   ERC-6538 registry interface
│   │   └── ProxyImport.sol              # ERC1967Proxy wrapper (artifact generation)
│   ├── scripts/
│   │   ├── deploy-ancile-router.ts      # Deploys impl + UUPS proxy, logs addresses
│   │   ├── deploy-ancile.ts             # Alternate deploy script
│   │   └── verify-ancile.ts             # Hardhat v3 Basescan verification
│   ├── hardhat.config.ts                # Hardhat v3 + hardhat-verify, baseSepolia config
│   └── package.json
│
├── p2p-workflow/                        # Chainlink CRE workflow: P2P flows
│   ├── main.ts                          # Handles: REGISTER(1), P2P_DISPATCH(2), SWEEP(3)
│   └── config.staging.json              # CRE workflow deployment config
│
├── otc-workflow/                        # Chainlink CRE workflow: OTC flows
│   ├── main.ts                          # Auto-routes: MEGA_BATCH_OTC(6) or BATCH_SWEEP(7)
│   │                                    # Detection: payload.stealthAddress -> BATCH_SWEEP
│   └── config.staging.json              # CRE workflow deployment config
│
├── p2p-scripts/                         # P2P flow intent builders
│   ├── bob/
│   │   ├── bob-setup.ts                 # Derives stealth keypair (sign -> keccak256)
│   │   │                                # Loads World ID proof
│   │   │                                # Builds REGISTER payload
│   │   │                                # Output: bob-latest-payload.json
│   │   ├── bob-sweep.ts                 # Signs EIP-2612 Permit from stealth address
│   │   │                                # Signs intent hash (stealthAddr, dest, amt, nonce)
│   │   │                                # Output: bob-sweep-payload.json
│   │   └── bobBackendSetup.ts           # Backend-friendly registration (config.p2p.json)
│   ├── alice/
│   │   └── alice-dispatch.ts            # Reads ERC-6538 registry for Bob's meta-address
│   │                                    # Derives one-time stealth address (ERC-5564 ECDH)
│   │                                    # Signs Permit + intent hash
│   │                                    # Loads World ID proof (address-specific file)
│   │                                    # Output: alice-latest-payload.json
│   ├── utils/
│   │   └── verify-registration.ts       # Reads on-chain registration status for any addr
│   └── package.json
│
├── otc-scripts/                         # OTC darkpool intent builders
│   ├── alice/
│   │   ├── alice-setup.ts               # ERC-5564 registration (mirrors bob-setup)
│   │   ├── create-otc-ask.ts            # Generates 5 ghost wallets (ephemeral keypairs)
│   │   │                                # Saves private keys -> alice-shards.json
│   │   │                                # Signs EIP-2612 Permit for 1000 mUSDC
│   │   │                                # Output: alice-otc-intent.json
│   │   ├── create-sweep-intent.ts       # Reads on-chain mWLD balances per shard
│   │   │                                # Reads ERC20.nonces + routerNonces on-chain
│   │   │                                # Signs Permit + intent per shard
│   │   │                                # Output: alice-sweep-bundle.json
│   │   └── sweep-shards.ts              # Alternate sweep helper
│   ├── bob/
│   │   ├── create-otc-bid.ts            # Same as alice's ask, for mWLD
│   │   │                                # Output: bob-otc-intent.json + bob-shards.json
│   │   └── create-sweep-intent.ts       # Sweeps mUSDC from bob's ghost wallets
│   │                                    # Output: bob-sweep-bundle.json
│   ├── bundle-otc.ts                    # Reads alice-otc-intent + bob-otc-intent
│   │                                    # Merges -> otc-workflow/master-otc.json
│   ├── bundle-sweeps.ts                 # Reads alice-sweep-bundle + bob-sweep-bundle
│   │                                    # Merges -> otc-workflow/master-sweep.json
│   └── package.json
│
├── serve-rp-signature.ts                # Local World ID Relying Party server
│                                        # POST /save-proof -> {address}-world-proof.json
│                                        # Handles IDKit nonce signing
├── world-id-generator.html              # Browser UI: IDKit Core v4
│                                        # Scan QR with World ID Simulator -> generates proof
│                                        # Auto-POSTs to /save-proof endpoint
│
├── config.json                          # Shared: RPC URL, private keys, contract addresses
├── config.p2p.json                      # P2P-specific config overrides
├── config.otc.json                      # OTC-specific config overrides
└── package.json                         # Root scripts (serve-rp, world-id-generator, etc.)
```

---

## 4. Prerequisites & Setup

### Requirements

- Node.js 20+
- [Chainlink CRE CLI](https://docs.chain.link/chainlink-cre) installed
- Base Sepolia RPC URL (Alchemy, Infura, or public)
- Basescan API key (for contract verification)
- World ID Simulator app (iOS or Android): for generating ZK proofs

### Install Dependencies

```bash
# Root (serve-rp server + world-id-generator)
npm install

# Smart contracts
cd contracts && npm install && cd ..

# P2P scripts
cd p2p-scripts && npm install && cd ..

# OTC scripts
cd otc-scripts && npm install && cd ..
```

### Configure `config.json`

```json
{
  "BASE_SEPOLIA_RPC_URL": "https://base-sepolia.g.alchemy.com/v2/YOUR_KEY",
  "ALICE_PRIVATE_KEY": "0x...",
  "BOB_PRIVATE_KEY": "0x...",
  "ROUTER_ADDRESS": "0x81c693D8Df38BfCda1a578a1733E822C12f58d2f",
  "MOCK_USDC_ADDRESS": "0x9CC99Dfedf08aE1E5347cB4CfbD57b04CAe6029D",
  "MOCK_WLD_ADDRESS": "0x6D138c0d2557c2A3C978EebB258A042e9a6d6d43",
  "IMPLEMENATION_ADDRESS": "0x2dA2ABAFE8013Ba940B7bEb2FfAC0757431524a9"
}
```

### Deploy & Verify (optional: contracts already live)

```bash
cd contracts

# Add to .env:
# BASE_SEPOLIA_RPC_URL=https://...
# CRE_PRIVATE_KEY=0x...
# BASESCAN_API_KEY=...

npx hardhat compile
npx hardhat run scripts/deploy-ancile-router.ts --network baseSepolia
# -> Copy ROUTER_ADDRESS and IMPLEMENATION_ADDRESS into config.json

npx hardhat run scripts/verify-ancile.ts --network baseSepolia
# -> Verifies both implementation and proxy on Basescan
```

---

## 5. Flow 1: P2P Private Transfer

[![](https://mermaid.ink/img/pako:eNqdV8tu20YU_ZULFkYlhHIlPiSaaALIEl0bzUMw3QQoDBQjcigNTM4ww5FjxTDQbLpsgCSbtAGy6qabLpN1P8U_0HxCL0nJoSnJTisIEjk65z7PHY7OtUCEVHO1ra1zxply4fyYAxxrakoTeqy5eDkmGV7plfXHRDIyjmmWAwpC_lMqWULkfCBiIUvmV-2o0zPIglzBHNEzVcVF7WgnilZxu0KGVF6zSIlNdyrImHF6IyCjgeBhPTDHiKwqSlGpWB0UWKRLKyASKCF3Tyabsit_L2LeFE0BuTX9AnX_tsy4UBSjuR6yEVpODVN31wtDMwrqhm4vNUbFToligte99uwdx16PXDFrOuMwcq416OmM8oA-nCXj69CVusRkTONdcVb3Tzo7xlrcalKGYwW9OvTWCsVCpLeCMjbhJL451wJya_8jwdUeSVg8LxGJ4CJLSYBizCEXx_ziYmvrmC9LN2RkIklS0slMCV7U8pgvVnI5QT9mAQWSwaf3rz4u7ho-5Vih5hI5FmcgJ2PS6Fg6dLq2DoZp6tDe7thN5L15BY-iqDWYEsbh8uc3UFzhCJ7AkefBHpP0GYnj0lb-SgmOVcBSwhUMDr3c--Vvb__5-LLCxPWSgKGsxtHFOByMo2PsLOO4_P11buERrwSyi5sU-DQVMSPr3R-KGQ55mf_rd9DnAYtpubidiQ0xH4kTykvOn2_BOxy0jDY0kh_84aC5nuErSmI1LTl_fIBdMf46u1p9gtWhaiXdskEILWm__lVcNw5pQNlppT2SBmp9f9pOJZ6HOM8gkFh2WccKu3D55sWmN8Bov-970IG_P8DwwB_1jwb7cBPjs6_CQ-veveLbhT2qguki6QdUkVY_DCXNMoikSIoCdm3TgUM6YZmS8412BiJJsTXQaSmW0Kv6La01cFdPDbt70gFvMNxvbrTj48CBdzBqGd2OASMqE6bgDhxwRbFZ-ySbrlKLcvmzcQ7FgtRJd-CJkHEIB0MYSSGiZXPyF1KXBh5TyaJ5aRSLccVp5Juj4GBAgDmiXHF-IZjS4KRZt1Oq0wXBD1HZUjVGxuinZX90GJF5LEjYrAZQUipcGqBoci00yvDzlJtw9-5iA7h893oNuZC9C2mReWOB_OXVAqBDPxEzrpqbmUoSnkVU7mHXK_xFGxddbN4QtpeXPJeLbXctHFaODgM8enDV8NL8DCJJPJqNv6dzHR4z-uyITJorY1UZl9o2smFcULf6MoIvmBcjl8d3ff--5_vgP_G80VV3zeYXzg-6xLTx04UhKub0s9ZHMn-GUsAcvx3Lb-6VE3Q9eRRjnj3jkxy21moxAf4zStO18odGYXfpFK0062aq87AwVCovT7_M1wVzdQxW5FuUqKrb_67a6wr6IvnWKf9bx2sMDWmmGC9OOhUrBbm1bMCn9y9fwN6MhxkQWXQ4f2A9p1KAd7QPWZq3YjzPi32lYE3XJpKFmqvkjOoadjwh-a22ejzHo-1Jfiy4QA4-gX4UIlnSpJhNppobkTjDu1kaopwWR4WrVVkcAAZ5HTTXsHpmYUVzz7UzvDd72z3DMKy20bUto23o2lxzTWd7p9Nt22bHsawunv0udO154ba97RhGz-6adrtttS3TdnSNhgwfbg_KvxnFv42LfwH-6xAH?type=png)](https://mermaid.live/edit#pako:eNqdV8tu20YU_ZULFkYlhHIlPiSaaALIEl0bzUMw3QQoDBQjcigNTM4ww5FjxTDQbLpsgCSbtAGy6qabLpN1P8U_0HxCL0nJoSnJTisIEjk65z7PHY7OtUCEVHO1ra1zxply4fyYAxxrakoTeqy5eDkmGV7plfXHRDIyjmmWAwpC_lMqWULkfCBiIUvmV-2o0zPIglzBHNEzVcVF7WgnilZxu0KGVF6zSIlNdyrImHF6IyCjgeBhPTDHiKwqSlGpWB0UWKRLKyASKCF3Tyabsit_L2LeFE0BuTX9AnX_tsy4UBSjuR6yEVpODVN31wtDMwrqhm4vNUbFToligte99uwdx16PXDFrOuMwcq416OmM8oA-nCXj69CVusRkTONdcVb3Tzo7xlrcalKGYwW9OvTWCsVCpLeCMjbhJL451wJya_8jwdUeSVg8LxGJ4CJLSYBizCEXx_ziYmvrmC9LN2RkIklS0slMCV7U8pgvVnI5QT9mAQWSwaf3rz4u7ho-5Vih5hI5FmcgJ2PS6Fg6dLq2DoZp6tDe7thN5L15BY-iqDWYEsbh8uc3UFzhCJ7AkefBHpP0GYnj0lb-SgmOVcBSwhUMDr3c--Vvb__5-LLCxPWSgKGsxtHFOByMo2PsLOO4_P11buERrwSyi5sU-DQVMSPr3R-KGQ55mf_rd9DnAYtpubidiQ0xH4kTykvOn2_BOxy0jDY0kh_84aC5nuErSmI1LTl_fIBdMf46u1p9gtWhaiXdskEILWm__lVcNw5pQNlppT2SBmp9f9pOJZ6HOM8gkFh2WccKu3D55sWmN8Bov-970IG_P8DwwB_1jwb7cBPjs6_CQ-veveLbhT2qguki6QdUkVY_DCXNMoikSIoCdm3TgUM6YZmS8412BiJJsTXQaSmW0Kv6La01cFdPDbt70gFvMNxvbrTj48CBdzBqGd2OASMqE6bgDhxwRbFZ-ySbrlKLcvmzcQ7FgtRJd-CJkHEIB0MYSSGiZXPyF1KXBh5TyaJ5aRSLccVp5Juj4GBAgDmiXHF-IZjS4KRZt1Oq0wXBD1HZUjVGxuinZX90GJF5LEjYrAZQUipcGqBoci00yvDzlJtw9-5iA7h893oNuZC9C2mReWOB_OXVAqBDPxEzrpqbmUoSnkVU7mHXK_xFGxddbN4QtpeXPJeLbXctHFaODgM8enDV8NL8DCJJPJqNv6dzHR4z-uyITJorY1UZl9o2smFcULf6MoIvmBcjl8d3ff--5_vgP_G80VV3zeYXzg-6xLTx04UhKub0s9ZHMn-GUsAcvx3Lb-6VE3Q9eRRjnj3jkxy21moxAf4zStO18odGYXfpFK0062aq87AwVCovT7_M1wVzdQxW5FuUqKrb_67a6wr6IvnWKf9bx2sMDWmmGC9OOhUrBbm1bMCn9y9fwN6MhxkQWXQ4f2A9p1KAd7QPWZq3YjzPi32lYE3XJpKFmqvkjOoadjwh-a22ejzHo-1Jfiy4QA4-gX4UIlnSpJhNppobkTjDu1kaopwWR4WrVVkcAAZ5HTTXsHpmYUVzz7UzvDd72z3DMKy20bUto23o2lxzTWd7p9Nt22bHsawunv0udO154ba97RhGz-6adrtttS3TdnSNhgwfbg_KvxnFv42LfwH-6xAH)

### Phase 0: Bob's One-Time Registration

Bob only does this once. It registers his ERC-5564 Meta-Address on-chain and sets a compliance rule requiring senders to be World ID verified.

[![](https://mermaid.ink/img/pako:eNqFVt2K20YUfpVBZYtNZVeSJf-IshDvOumSJhvsZQPBNyPpyDtdaUYdjbJ2F0MptFeFtkmgtAmEQt-hve6j7As0j9Azkr3I9m4MxsyMvu-c7_zMka6NUERg-MbBwTXjTPnkesoJmRrqAlKYGj4uA5rjyqydn1PJaJBArgElQT_KJEupXByJRMiK-YlNbeqsyTXMGcxVHQcWWHG8ixsKGYGsI3thh0JUQyaMw0cBOYSCR9vCuo7dqQtTIBXbAllxx-1aNRANlZDDy9l90VXPS833qSkhe8MvUV_ti4wLBaimjnEiO-gOtjDb7kI38OIdQ_tTjarYS6qY4Fte3dCOBt7dyB2ztNcPYrpRoG8K4CE8LdJgE7qTl4QGkAzFfMu_DXbgBnfhdrx3I6cfDbahezOUCJHtBeVsxmny8VhLyN76x4KrhzRlyaJCpIKLPKMhNpuGLKd8uTw4mPJ16o4ZnUmaVnRaKMHLXE756kS3ExmKgNCcfHj_61_lujGGENhLkM0KlVG8AiHLKFfk-clxhf3pF_JcyCQiJ8dra4GYEzkLaMN2XJN4fZM4nZ5JrLbtNZHx5hU5jePW0QVlnNx894aUK7yml-RsNCIPmYQrmiSVrW2_R-OR9nvzx-___fNzjYnnFQF4tKujaxK77-GfM1jruHn7Wls45TUhQxxkZAKZSBi92_1YFDgIqshfvyMPeMgSqA7bubhH8xhmFeO377XL0fio1fU6fX3OciUXO8Ix-a3DQ0yxTx4BB0kVkBePyTMpREzw92WRUpzFKyLiWghHko8mVSE5udIVabGolWlK--tcYIDvfqhbL-HHILG-ZKKAJuqCPIZFThqTDKUwPiOfknMGV7hq7hCPBEflRajIE1C09SCKJOTI1bF5XtfdYGBtfDIpgpQp8owuEkEj8u_fm8zP0GSaYd6xWcm4SABP1iGv0_IUpxAR2I-ktPjh_ds_y3zOIcQC5ITxnEW6gGEhoewlXVRF0wxklYnKDrLXqs4xAfHitoNvXX4RyM8PG3pKYaDExlQ42E6YIokXChuUMNWsG6tawCeCj7F9pGqMR49OJmejsYl11W_QaBV4cx1MxahRj0HjNhJEs-2sVLpWIvJSNqq--fEVkfh0hLe6uW0eZj6q1p0GUhf4lA_hgiZxA4tjbhRhTYVZq6Zr1aXlsMYqhqEu120zrfys83k2160RM5lCZJjGTLLI8LFRwDRSkCnVW2P3CwLfvpd6ci2Rg1fmhRDpmiZFMbsw_JgmOe6KLMLLsJpmt6cSG1ZP8YIrw3fcXq-0YvjXxhz3nV675ziOazldz3UsxzQWht_ptwd21_I6dt91uz1vsDSNb0u3VrvvOD2v2_Esy7XcDs4vAyKGA_JJ9SVUfhAt_wcAuOw9?type=png)](https://mermaid.live/edit#pako:eNqFVt2K20YUfpVBZYtNZVeSJf-IshDvOumSJhvsZQPBNyPpyDtdaUYdjbJ2F0MptFeFtkmgtAmEQt-hve6j7As0j9Azkr3I9m4MxsyMvu-c7_zMka6NUERg-MbBwTXjTPnkesoJmRrqAlKYGj4uA5rjyqydn1PJaJBArgElQT_KJEupXByJRMiK-YlNbeqsyTXMGcxVHQcWWHG8ixsKGYGsI3thh0JUQyaMw0cBOYSCR9vCuo7dqQtTIBXbAllxx-1aNRANlZDDy9l90VXPS833qSkhe8MvUV_ti4wLBaimjnEiO-gOtjDb7kI38OIdQ_tTjarYS6qY4Fte3dCOBt7dyB2ztNcPYrpRoG8K4CE8LdJgE7qTl4QGkAzFfMu_DXbgBnfhdrx3I6cfDbahezOUCJHtBeVsxmny8VhLyN76x4KrhzRlyaJCpIKLPKMhNpuGLKd8uTw4mPJ16o4ZnUmaVnRaKMHLXE756kS3ExmKgNCcfHj_61_lujGGENhLkM0KlVG8AiHLKFfk-clxhf3pF_JcyCQiJ8dra4GYEzkLaMN2XJN4fZM4nZ5JrLbtNZHx5hU5jePW0QVlnNx894aUK7yml-RsNCIPmYQrmiSVrW2_R-OR9nvzx-___fNzjYnnFQF4tKujaxK77-GfM1jruHn7Wls45TUhQxxkZAKZSBi92_1YFDgIqshfvyMPeMgSqA7bubhH8xhmFeO377XL0fio1fU6fX3OciUXO8Ix-a3DQ0yxTx4BB0kVkBePyTMpREzw92WRUpzFKyLiWghHko8mVSE5udIVabGolWlK--tcYIDvfqhbL-HHILG-ZKKAJuqCPIZFThqTDKUwPiOfknMGV7hq7hCPBEflRajIE1C09SCKJOTI1bF5XtfdYGBtfDIpgpQp8owuEkEj8u_fm8zP0GSaYd6xWcm4SABP1iGv0_IUpxAR2I-ktPjh_ds_y3zOIcQC5ITxnEW6gGEhoewlXVRF0wxklYnKDrLXqs4xAfHitoNvXX4RyM8PG3pKYaDExlQ42E6YIokXChuUMNWsG6tawCeCj7F9pGqMR49OJmejsYl11W_QaBV4cx1MxahRj0HjNhJEs-2sVLpWIvJSNqq--fEVkfh0hLe6uW0eZj6q1p0GUhf4lA_hgiZxA4tjbhRhTYVZq6Zr1aXlsMYqhqEu120zrfys83k2160RM5lCZJjGTLLI8LFRwDRSkCnVW2P3CwLfvpd6ci2Rg1fmhRDpmiZFMbsw_JgmOe6KLMLLsJpmt6cSG1ZP8YIrw3fcXq-0YvjXxhz3nV675ziOazldz3UsxzQWht_ptwd21_I6dt91uz1vsDSNb0u3VrvvOD2v2_Esy7XcDs4vAyKGA_JJ9SVUfhAt_wcAuOw9)

```bash
# Terminal 1: Start the World ID Relying Party signing server
npm run serve-rp
# -> Starts HTTP server at localhost:3000
# -> POST /save-proof saves proofs as {address}-world-proof.json

# Terminal 2: Open the World ID proof generator UI
npm run world-id-generator
# -> Opens world-id-generator.html in your browser
# -> Enter Bob's wallet address as the signal
# -> Scan the QR code with the World ID Simulator app
# -> Proof is generated client-side and auto-saved via /save-proof
# -> File saved: ./0x{BOB_ADDRESS}-world-proof.json

# Generate Bob's stealth keypair + registration payload
npm run bob-setup
# -> Signs a static message with Bob's wallet to derive spending/viewing keys:
#     spendingKey = keccak256(walletSignature)
#     viewingKey  = keccak256(spendingKey ‖ "viewing")
# -> Constructs ERC-5564 Meta-Address (spending pubkey + viewing pubkey)
# -> Loads World ID proof from 0x{BOB_ADDRESS}-world-proof.json
# -> Output: p2p-scripts/bob/bob-latest-payload.json

# Submit to Chainlink CRE -> AncileRouter
npm run ancile-bob-setup
# CRE executes:
#   1. Validates World ID ZK proof (Semaphore nullifier check)
#   2. Encodes REGISTER payload with Bob's meta-address + ComplianceRule.WORLD_ID_REQUIRED
#   3. Submits to AncileRouter.onReport via Chainlink Forwarder
# AncileRouter executes:
#   1. Registers Bob's meta-address on ERC-6538 registry
#   2. Sets complianceRules[bob] = WORLD_ID_REQUIRED
```

### Phase 1: Alice Sends to Bob's Stealth Address

```bash
# Alice builds her dispatch payload (no ETH required from Alice)
npm run alice-p2p-dispatch
# -> Reads Bob's registered meta-address from ERC-6538 registry on-chain
# -> Derives a one-time stealth address for Bob using secp256k1 ECDH:
#     sharedSecret = alice_ephemeral_private * bob_spending_public
#     stealthAddress = bob_spending_public + keccak256(sharedSecret) * G
# -> Reads Alice's current ERC20 nonce on-chain (prevents permit replay)
# -> Reads Alice's current routerNonce on-chain (prevents intent replay)
# -> Signs EIP-2612 Permit: spender=router, value=100 mUSDC, deadline=+1h
# -> Signs intent hash: keccak256(alice ‖ stealthAddress ‖ amount ‖ routerNonce)
# -> Loads Alice's World ID proof from 0x{ALICE_ADDRESS}-world-proof.json
# -> Output: p2p-scripts/alice/alice-latest-payload.json

# Submit to Chainlink CRE -> AncileRouter
npm run ancile-transfer-alice-to-bob
# CRE executes:
#   1. Reads Bob's complianceRules[bob] from chain
#   2. Verifies Alice's World ID proof (rule: WORLD_ID_REQUIRED)
#   3. Confirms the derived stealthAddress matches Alice's intent
#   4. Encodes P2P_DISPATCH payload
#   5. Submits transaction
# AncileRouter executes:
#   1. Verifies intent signature via ecrecover
#   2. Increments routerNonces[alice]
#   3. Calls ERC20.permit (Alice's token approval: gasless)
#   4. ERC20.transferFrom(alice, stealthAddress, amount)
#   5. Emits ERC5564Announcer.Announcement(ephemeralPubKey, viewTag)
```

**Live transaction:** [`0x243213b3e874e0cdd377c81471b1fb37cb0259d61c0984397c70dc7f2993ea3c`](https://sepolia.basescan.org/tx/0x243213b3e874e0cdd377c81471b1fb37cb0259d61c0984397c70dc7f2993ea3c)

### Phase 2: Bob Sweeps Gaslessly

Bob's stealth address holds mUSDC but 0 ETH. He signs everything locally using only the derived stealth private key. The CRE pays gas.

```bash
# Bob builds his sweep payload (stealth private key signs: NOT Bob's main wallet)
npm run bob-p2p-sweep
# -> Rederives stealth private key from Bob's wallet sig (deterministic):
#     stealthKey = computeStealthKey(ephemeralPubKey, viewingKey, spendingKey)
# -> Reads stealth address's current ERC20 nonce on-chain
# -> Reads stealth address's current routerNonce on-chain
# -> Signs EIP-2612 Permit: owner=stealthAddress, spender=router
# -> Signs intent hash: keccak256(stealthAddr ‖ destination ‖ amount ‖ routerNonce)
# -> Both signatures are from the STEALTH private key, not Bob's main wallet
# -> Output: p2p-scripts/bob/bob-sweep-payload.json

# Submit to Chainlink CRE -> AncileRouter
npm run ancile-p2p-bob-sweep
# CRE routes to ActionType.BATCH_SWEEP (7)
# AncileRouter executes:
#   1. ecrecover(intentHash) == stealthAddress  ✓
#   2. routerNonces[stealthAddress]++
#   3. ERC20.permit (stealth address approves router: gasless)
#   4. ERC20.transferFrom(stealthAddress, destination, amount)
# Result: Funds arrive at Bob's destination. Stealth address is drained.
# On-chain: no link between Bob's main wallet and the destination address.
```

**Live transaction:** [`0xa748ffb7181d0fb08707800aedc7f55116a54c0e8b18434a8456564bd2642693`](https://sepolia.basescan.org/tx/0xa748ffb7181d0fb08707800aedc7f55116a54c0e8b18434a8456564bd2642693)

---

## 6. Flow 2: Sharded OTC Darkpool

### The Full Picture

[![](https://mermaid.ink/img/pako:eNqlV91u40QUfpUjoy6JNim2E-dPsFKSeruV2jRqsrsIilZje5wMcWbC2Nm2VJXYC7hdsVsJ8SPtBS8AFwgk7niUvgA8Amc8Sermr0hUlWOPz_edn_nOsX1p-CKgRsPY2blknCUNuDzlAKdGMqRjemo08NQjMZ4VMuvPiGTEi2isDFKAujWRbEzkRVtEQmrke5ZvOqXSDJyx6dPzJGsXBmE5DFftWkIGVGYtg3q5QrOWEeN0q0FMfcGDpcBsapkVJ2OVUJmwJaMyMctlmjEifiJkazTYlJ2-n8a8KZrU5N70U6vD-zLjIqEYTdam5JnVSnnJZsWdSbzQXya6v9QYFXtJEib4kteKZ1uktt5yhZbWqvWwfmeDvphS7tPOdOzdNV2pS0Q8GrXE-ZJ_OzBNx15nt-Kd2JZPVijvrVAkxOReo5gNOIm255qa3Lv_oeDJYzJm0YW2GAsu4gnxUYzK5OqUX13t7Jzyeen2GBlIMtZwMk0ET2t5ymcrSk7QjJhPgcTwz7uvf_n7j9ezhdwRGVEJf_0OA_aSxjB-2ttr57PAlvBmsF8VTF3m-kug54d7M8yEYCf5bEJ4Au3DA428_g5aUx5EiOn5kk2SeWieOAc58EjOtqoFqJoFsEv1Api7lpNXuDdwHIbF9pAwDjdfXUN6hj0_gr7rwmMm6RmJIs214v3EVd5vfvhehX2LxHUNoDxYicOqFMCqOXiwF3Hc_PhWMRzzTCAtnIrQoxMRMbLe_YmY4lTR-b_9CZrcZxHVi7ux2BDz_lDESVODvv1Tb9H7MTj6RrwF1FqAcINWIJlUJfWT9TU3a_lbBx0cCiBe0plwCriXDbi5fqX_AbpPmj0XLKWBg07f7fRh3-24J83-wXEHHkDraWfv8KCzD7eYW-6UsfjoUfrbgH3KqSTozgF3oh4wkkQ6eniOu0uTGHKS8ECMYUQvJoTJOL-RrIctBu5Bt2hXLBu6VI5ZAiHK2DJNU6t7FZsm15t6ypakayLxiyQe7X4eCz6vnPrD4qI9Hv9v2BmijSE7KmJsrWVUNlwPV1SwHgtWgkW7ufURlQOKxskQGE8ox-BuvnkDYxKjHhXBDLwEPXEb0JKCBD4azqxRexcRLm1TlmNhB9XxUKpsURbSF3RHrJGWraR15O43i61mv_0E3I_d9tNUXbkj9xl0JdL4CQ3yayWG1PP4u0Rir86zRtKQ8QBzwQn2kZ6BD2ZXWN0PPfnBo9aURQFMplEUf_oZPMSzeEjxdJl-HrvgJzgJZJJT4b5Iw31x3G8XNEVhhs9nt0ZDMxxtwePpmC5a_sGsj7UcUEpzgeS3kHTRX0boEEoUn87x4UJNehXZ1xDp-dPAQfLuZ2SLh7coJZfleQQ5dAaU-MP8JrKWIrv-TZNlQlN0dycV5Oy7ZGultTygtw6teQQr4iopHWhd9Z67bhdyqofOhByFkThLn6FFqfLQbaJeaASHan7rONNtqZrZgfiM0slCdGnFB-lowFGAmS4qGtA4YTx9V8qvb_P_xreo6XrCLe1cTKnT9lfbOfOEbiSj2YG1QfJa7WkR8-mTMS1bAN4FIDuJkmEzCCSNMWhGo2Cr5l6_gj2pnrArOlOZYdvigM3kF2_V3IJsSWXbqFBxRsEYSBYYjUROacHAqT4m6tJY_TLCr4qReiO7Qgw-iD8RYjyHYREGQ6MRkijGq-kkwOfE7C1tsSrRm3o7nfLEaNjlSj1lMRqXxjlel6q7Vdu2y6Zdccq2aReMC6NRqu3WrQp-dli1crlSdepXBePL1K25W7PtqlMpYb-WzXLJqRUMGjB8fzvSX3jph97Vv7loc-o?type=png)](https://mermaid.live/edit#pako:eNqlV91u40QUfpUjoy6JNim2E-dPsFKSeruV2jRqsrsIilZje5wMcWbC2Nm2VJXYC7hdsVsJ8SPtBS8AFwgk7niUvgA8Amc8Sermr0hUlWOPz_edn_nOsX1p-CKgRsPY2blknCUNuDzlAKdGMqRjemo08NQjMZ4VMuvPiGTEi2isDFKAujWRbEzkRVtEQmrke5ZvOqXSDJyx6dPzJGsXBmE5DFftWkIGVGYtg3q5QrOWEeN0q0FMfcGDpcBsapkVJ2OVUJmwJaMyMctlmjEifiJkazTYlJ2-n8a8KZrU5N70U6vD-zLjIqEYTdam5JnVSnnJZsWdSbzQXya6v9QYFXtJEib4kteKZ1uktt5yhZbWqvWwfmeDvphS7tPOdOzdNV2pS0Q8GrXE-ZJ_OzBNx15nt-Kd2JZPVijvrVAkxOReo5gNOIm255qa3Lv_oeDJYzJm0YW2GAsu4gnxUYzK5OqUX13t7Jzyeen2GBlIMtZwMk0ET2t5ymcrSk7QjJhPgcTwz7uvf_n7j9ezhdwRGVEJf_0OA_aSxjB-2ttr57PAlvBmsF8VTF3m-kug54d7M8yEYCf5bEJ4Au3DA428_g5aUx5EiOn5kk2SeWieOAc58EjOtqoFqJoFsEv1Api7lpNXuDdwHIbF9pAwDjdfXUN6hj0_gr7rwmMm6RmJIs214v3EVd5vfvhehX2LxHUNoDxYicOqFMCqOXiwF3Hc_PhWMRzzTCAtnIrQoxMRMbLe_YmY4lTR-b_9CZrcZxHVi7ux2BDz_lDESVODvv1Tb9H7MTj6RrwF1FqAcINWIJlUJfWT9TU3a_lbBx0cCiBe0plwCriXDbi5fqX_AbpPmj0XLKWBg07f7fRh3-24J83-wXEHHkDraWfv8KCzD7eYW-6UsfjoUfrbgH3KqSTozgF3oh4wkkQ6eniOu0uTGHKS8ECMYUQvJoTJOL-RrIctBu5Bt2hXLBu6VI5ZAiHK2DJNU6t7FZsm15t6ypakayLxiyQe7X4eCz6vnPrD4qI9Hv9v2BmijSE7KmJsrWVUNlwPV1SwHgtWgkW7ufURlQOKxskQGE8ox-BuvnkDYxKjHhXBDLwEPXEb0JKCBD4azqxRexcRLm1TlmNhB9XxUKpsURbSF3RHrJGWraR15O43i61mv_0E3I_d9tNUXbkj9xl0JdL4CQ3yayWG1PP4u0Rir86zRtKQ8QBzwQn2kZ6BD2ZXWN0PPfnBo9aURQFMplEUf_oZPMSzeEjxdJl-HrvgJzgJZJJT4b5Iw31x3G8XNEVhhs9nt0ZDMxxtwePpmC5a_sGsj7UcUEpzgeS3kHTRX0boEEoUn87x4UJNehXZ1xDp-dPAQfLuZ2SLh7coJZfleQQ5dAaU-MP8JrKWIrv-TZNlQlN0dycV5Oy7ZGultTygtw6teQQr4iopHWhd9Z67bhdyqofOhByFkThLn6FFqfLQbaJeaASHan7rONNtqZrZgfiM0slCdGnFB-lowFGAmS4qGtA4YTx9V8qvb_P_xreo6XrCLe1cTKnT9lfbOfOEbiSj2YG1QfJa7WkR8-mTMS1bAN4FIDuJkmEzCCSNMWhGo2Cr5l6_gj2pnrArOlOZYdvigM3kF2_V3IJsSWXbqFBxRsEYSBYYjUROacHAqT4m6tJY_TLCr4qReiO7Qgw-iD8RYjyHYREGQ6MRkijGq-kkwOfE7C1tsSrRm3o7nfLEaNjlSj1lMRqXxjlel6q7Vdu2y6Zdccq2aReMC6NRqu3WrQp-dli1crlSdepXBePL1K25W7PtqlMpYb-WzXLJqRUMGjB8fzvSX3jph97Vv7loc-o)


### Phase 1: One-Time Registration (Both Parties)

```bash
npm run alice-setup && npm run ancile-alice-setup
# Same as Bob's setup above: Alice registers her ERC-5564 meta-address
# Only required once; skip if already registered
```

### Phase 2: Create OTC Intents

```bash
# Alice: give 1000 mUSDC, want 500 mWLD
npm run alice-otc-ask
# -> Generates 5 random ephemeral keypairs (ghost wallets)
# -> Saves private keys: otc-scripts/alice/alice-shards.json  ← KEEP THIS
# -> Reads Alice's current ERC20 nonce from chain
# -> Signs EIP-2612 Permit: spender=router, value=1000 mUSDC
# -> Builds payload with ghost wallet PUBLIC addresses (receivingShards)
# -> Output: otc-scripts/alice/alice-otc-intent.json

# Bob: give 500 mWLD, want 1000 mUSDC
npm run bob-otc-bid
# -> Same process for Bob: bob-shards.json + bob-otc-intent.json

# Bundle both intents into one master payload
npm run ancile-bundle-otc
# -> Reads alice-otc-intent.json + bob-otc-intent.json
# -> Merges into otc-workflow/master-otc.json
# -> Structure:
#   {
#     payloads: [
#       { permit: alicePermit, giveToken: mUSDC, shards: bobGhosts },
#       { permit: bobPermit,   giveToken: mWLD,  shards: aliceGhosts }
#     ]
#   }
```

### Phase 3: CRE Executes Mega-Batch OTC

```bash
npm run ancile-otc
# CRE (otc-workflow/main.ts) reads master-otc.json:
#   1. Detects no stealthAddress field -> routes to MEGA_BATCH_OTC (6)
#   2. Builds PermitPull[]: one per party:
#       [{alice, mUSDC, 1000, alicePermit}, {bob, mWLD, 500, bobPermit}]
#   3. Builds ShardPush[]: one per ghost wallet:
#       [{ghost_A1, mWLD, 100}, {ghost_A2, mWLD, 100}, ... x5]
#       [{ghost_B1, mUSDC, 200}, {ghost_B2, mUSDC, 200}, ... x5]
#   4. ABI-encodes as MEGA_BATCH_OTC (6) and submits
#
# AncileRouter._handleMegaBatchOTC:
#   1. ERC20.permit(alice) -> router approved for 1000 mUSDC
#   2. ERC20.transferFrom(alice, router, 1000 mUSDC)
#   3. ERC20.permit(bob) -> router approved for 500 mWLD
#   4. ERC20.transferFrom(bob, router, 500 mWLD)
#   5. For each of Bob's 5 ghost wallets: transfer(ghost_Bi, mUSDC, 200)
#   6. For each of Alice's 5 ghost wallets: transfer(ghost_Ai, mWLD, 100)
#
# On-chain result:
#   Alice -> Router -> 5 ghost addresses (mWLD)
#   Bob -> Router -> 5 ghost addresses (mUSDC)
#   No direct link between Alice and Bob. No link between main wallets and ghosts.
```

**Live transactions:**
- [Standard 1-to-1 OTC](https://sepolia.basescan.org/tx/0x994697d4039a357cb789395bdb1318dd856bd9329a8a6ad912924d8a696593aa)
- [Sharded Mega-Batch OTC](https://sepolia.basescan.org/tx/0xceeec3cbad1c7cbf8c096c1707fe62fdef70514d150af6e143196cae1b468077)

### Phase 4: Sweep Ghost Wallets

Alice's 5 ghost wallets each hold 100 mWLD. Bob's 5 each hold 200 mUSDC. Both sweep gaslessly.

```bash
# Alice signs sweep intents for her 5 mWLD ghost wallets
npm run alice-otc-sweep-intent
# -> Reads alice-shards.json (the private keys from Phase 2)
# -> For each shard:
#     checkBalance(ghost_Ai, mWLD): skip if 0
#     read ERC20.nonces(ghost_Ai) on-chain
#     read routerNonces(ghost_Ai) on-chain
#     sign EIP-2612 Permit: owner=ghost_Ai, spender=router, value=balance
#     sign intentHash = keccak256(ghost_Ai ‖ destination ‖ amount ‖ routerNonce)
# -> Output: otc-scripts/alice/alice-sweep-bundle.json

# Bob signs sweep intents for his 5 mUSDC ghost wallets
npm run bob-otc-sweep-intent
# -> Same process for bob-shards.json
# -> Output: otc-scripts/bob/bob-sweep-bundle.json

# Bundle both sweep payloads
npm run ancile-bundle-sweeps
# -> Merges alice-sweep-bundle + bob-sweep-bundle
# -> Output: otc-workflow/master-sweep.json (flat array of SweepEntry objects)

# CRE executes BATCH_SWEEP
npm run ancile-otc-sweep
# CRE reads master-sweep.json:
#   1. Detects stealthAddress field -> routes to BATCH_SWEEP (7)
#   2. Submits single transaction with all 10 sweep entries
#
# AncileRouter._handleBatchSweep (for each entry):
#   1. ecrecover(intentHash) == stealthAddress  ✓
#   2. routerNonces[stealthAddress]++
#   3. ERC20.permit(ghost_i, router, amount)
#   4. ERC20.transferFrom(ghost_i, destination, amount)
```

**Live sweep transactions:**
- [`0xd38c3dd8b6e4566811f4ee889356fd23ba5b4fdf1885c136439da0c0a5eb31c8`](https://sepolia.basescan.org/tx/0xd38c3dd8b6e4566811f4ee889356fd23ba5b4fdf1885c136439da0c0a5eb31c8)
- [`0x0b434143601890edc2704b4f533a5d8da419b06533463f27adde2f4d7d3ce263`](https://sepolia.basescan.org/tx/0x0b434143601890edc2704b4f533a5d8da419b06533463f27adde2f4d7d3ce263)

---

## 7. How the CRE Workflows Work

### p2p-workflow/main.ts

Handles `REGISTER`, `P2P_DISPATCH`, and `SWEEP` actions. The workflow receives a JSON payload via HTTP trigger, reads the `action` field to route, then:

- For **REGISTER**: validates the World ID ZK proof (checks nullifier hash, root, signal), then encodes the registration calldata.
- For **P2P_DISPATCH**: reads the compliance rule for the recipient from chain. If `WORLD_ID_REQUIRED`, validates the sender's proof. Derives the stealth address using ERC-5564 ECDH. Encodes and submits.
- For **SWEEP**: verifies the permit and intent signatures match the declared stealth address. Encodes and submits.

### otc-workflow/main.ts

Auto-routes between `MEGA_BATCH_OTC` and `BATCH_SWEEP` based on payload shape:

```typescript
const isSweep = payloads[0].stealthAddress !== undefined;
// stealthAddress present -> BATCH_SWEEP (7)
// not present -> MEGA_BATCH_OTC (6)
```

This means the same CRE endpoint handles both the initial OTC settlement and the post-OTC ghost wallet sweeps. One workflow, two action types, zero configuration change needed between them.

### World ID Proof Format

Proofs are generated via IDKit Core v4 in the browser and saved as:

```
./0x{USER_ADDRESS}-world-proof.json
```

```json
{
  "merkle_root": "0x...",
  "nullifier_hash": "0x...",
  "proof": "0x...",
  "verification_level": "orb"
}
```

Scripts prefer the address-specific file and fall back to a generic `world-id-proof.json` if it exists.

---

## 8. Security: Signature Verification In Depth

### Why Two Signatures?

A single EIP-2612 Permit allows anyone who holds it to pull tokens from any spender. Without the intent hash, the CRE could theoretically route funds to a different destination than the user intended. The intent hash binds the permit to a specific execution route cryptographically.

**Permit** -> proves the user authorized the router to pull funds
**Intent** -> proves the user authorized *where* those funds go

Neither signature alone is sufficient. Together, they create a complete authorization for exactly one specific action, spendable exactly once.

### Nonce Architecture

Two separate nonce systems protect against different replay vectors:

| Nonce | Location | Protects Against |
|---|---|---|
| `ERC20.nonces(owner)` | Token contract | EIP-2612 permit replay across contracts |
| `routerNonces[sender]` | AncileRouter | Ancile intent replay within the same router |

Both are read on-chain by the intent builder scripts before signing. Hardcoding nonces was a known issue that was fixed: all scripts now perform live on-chain reads.

### Intent Hash Construction

```
messageHash = keccak256(
    abi.encodePacked(
        address sender,       // who is authorizing
        address destination,  // where funds go (cannot be changed by CRE)
        uint256 amount,       // exact amount (cannot be inflated)
        uint256 routerNonce   // consumed exactly once
    )
)

ethSignedHash = keccak256(
    abi.encodePacked(
        "\x19Ethereum Signed Message:\n32",
        messageHash
    )
)

recovered = ecrecover(ethSignedHash, v, r, s)
require(recovered == sender, "Invalid intent signature")
routerNonces[sender]++
```

---

## 9. Deployed Contracts

All contracts deployed and verified on Base Sepolia.

| Contract | Address | Explorer |
|---|---|---|
| AncileRouter (Proxy) | `0x81c693D8Df38BfCda1a578a1733E822C12f58d2f` | [Basescan](https://sepolia.basescan.org/address/0x81c693D8Df38BfCda1a578a1733E822C12f58d2f#code) |
| AncileRouter (Implementation) | `0x2dA2ABAFE8013Ba940B7bEb2FfAC0757431524a9` | [Basescan](https://sepolia.basescan.org/address/0x2dA2ABAFE8013Ba940B7bEb2FfAC0757431524a9#code) |
| ERC-6538 Registry | `0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538` | Standard deployment |
| Chainlink Forwarder | `0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5` | |
| MockUSDC | `0x9CC99Dfedf08aE1E5347cB4CfbD57b04CAe6029D` | [Basescan](https://sepolia.basescan.org/address/0x9CC99Dfedf08aE1E5347cB4CfbD57b04CAe6029D) |
| MockWLD | `0x6D138c0d2557c2A3C978EebB258A042e9a6d6d43` | [Basescan](https://sepolia.basescan.org/address/0x6D138c0d2557c2A3C978EebB258A042e9a6d6d43) |

### Live Transaction Index

| Action | Transaction |
|---|---|
| P2P Transfer (Alice -> Bob stealth) | [0x2432...ea3c](https://sepolia.basescan.org/tx/0x243213b3e874e0cdd377c81471b1fb37cb0259d61c0984397c70dc7f2993ea3c) |
| P2P Sweep (Bob gasless exit) | [0xa748...2693](https://sepolia.basescan.org/tx/0xa748ffb7181d0fb08707800aedc7f55116a54c0e8b18434a8456564bd2642693) |
| OTC Direct 1-to-1 | [0x9946...3aa](https://sepolia.basescan.org/tx/0x994697d4039a357cb789395bdb1318dd856bd9329a8a6ad912924d8a696593aa) |
| OTC Sharded Mega-Batch | [0xceee...077](https://sepolia.basescan.org/tx/0xceeec3cbad1c7cbf8c096c1707fe62fdef70514d150af6e143196cae1b468077) |
| Ghost Wallet Sweep 1 | [0xd38c...31c8](https://sepolia.basescan.org/tx/0xd38c3dd8b6e4566811f4ee889356fd23ba5b4fdf1885c136439da0c0a5eb31c8) |
| Ghost Wallet Sweep 2 | [0x0b43...263](https://sepolia.basescan.org/tx/0x0b434143601890edc2704b4f533a5d8da419b06533463f27adde2f4d7d3ce263) |

---

*For project vision, use cases, and roadmap: see [README.md](./README.md)*
