# Ancile Protocol: Privacy Infrastructure for DeFi

> **Programmable, compliance-gated private routing for Web3: powered by ERC-5564 Stealth Addresses, Chainlink CRE, and World ID.**

Ethereum is radically transparent by default. While native privacy is emerging through cryptographic standards like **ERC-5564 (Stealth Addresses)**, the raw protocol has a ceiling: it lacks programmable compliance, Sybil resistance, and the gas abstraction required for institutional DeFi adoption.

**Ancile bridges this gap.** By leveraging the **Chainlink Runtime Environment (CRE)** as an off-chain TEE firewall, Ancile introduces a stateless, non-custodial privacy router protected by Zero-Knowledge proofs (World ID) and programmatic risk safeguards: without centralized custody or liquidity pools.

> The goal: any DeFi protocol should be able to route funds privately, with custom compliance, in a single signature. No vault. No custodian. No exposure.

---

## The Problem: Why Raw ERC-5564 Fails in Production


| Failure Mode                  | What Happens in Practice                                                                                                                                                                                                                                                    |
| ----------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **The Gas Funding Trap**      | A user receives tokens in a freshly derived stealth address holding 0 ETH. To withdraw or swap, they must fund it from a public exchange or their main wallet: permanently linking their identity to the stealth address. The privacy they paid for is instantly destroyed. |
| **Permissionless Sybil Risk** | Any bot, any script, any sanctioned address can receive funds. DAOs and treasuries have no way to enforce rules on *who* receives funds. Hackers can spam stealth Announcement logs, forcing users to endlessly scan the chain for their own events.                        |
| **Scanning Friction**         | There is no indexed registry of "which stealth addresses belong to me." Users must scan every block and every Announcement event, performing elliptic curve math on each one to check ownership. On a busy contract, this is a dead end for mobile clients.                 |
| **Dead Capital**              | Funds hiding in stealth addresses sit idle. Users are forced to choose between cypherpunk-grade privacy and capital efficiency.                                                                                                                                             |


Ancile eliminates all four failure modes: without custodians, without liquidity pools, without trusted relayers.

---

## The Solution: How Ancile Works

```
User creates intent (EIP-2612 Permit + World ID ZK proof)
              │
              ▼
   ┌─────────────────────────────────────────────────────┐
   │        Chainlink CRE: Off-Chain TEE Firewall        │
   │                                                     │
   │  1. Verify World ID ZK proof (Sybil gate)           │
   │  2. Compute ERC-5564 stealth address (secp256k1)    │
   │  3. Encode + attest atomic EVM calldata             │
   │  4. Submit signed report to AncileRouter on-chain   │
   └─────────────────────────────────────────────────────┘
              │
              ▼
   ┌─────────────────────────────────────────────────────┐
   │       AncileRouter.sol: Base Sepolia                │
   │                                                     │
   │  → Decodes ActionType from CRE attestation          │
   │  → Pulls funds gaslessly via EIP-2612 Permit        │
   │  → Routes to derived one-time stealth address       │
   │  → Emits ERC-5564 Announcement (ephemeralKey+tag)   │
   └─────────────────────────────────────────────────────┘
```

**Four guarantees that matter:**

- **Non-custodial**: the router never holds user funds beyond a single atomic transaction
- **Stateless**: no user balances, no on-chain ledger, only replay-protection nonces
- **Gasless**: every user action is signature-only (EIP-2612 Permit + intent hash); the CRE pays gas
- **Sybil-resistant**: World ID ZK proof verified inside the TEE before any chain interaction

---

## Two Use Cases That Ship Today

### 1. Peer-to-Peer Verified Stealth Transfers

Bob wants to receive payments privately on his terms. He registers his ERC-5564 Meta-Address on-chain and sets a compliance rule: **senders must prove humanity via World ID**: eliminating bots and Sybil-spam from poisoning his stealth address log.

Alice wants to pay Bob. She:

1. Signs an EIP-2612 Permit authorizing the router to pull her tokens: zero ETH required
2. Attaches her World ID ZK proof proving she is a unique human
3. Submits the payload to the Chainlink CRE: and does nothing else

The CRE verifies Alice's ZK proof inside the TEE, computes a fresh one-time stealth address for Bob using his registered Meta-Address, and atomically routes the funds on-chain. Bob's wallet never appears in Alice's transaction graph.

When Bob wants to withdraw, he signs a sweep intent using only the stealth private key. The CRE relays the transaction on his behalf, paying gas. **Zero ETH ever touches the stealth address.** The transaction graph is cryptographically unbreakable.

**Live testnet proof:**

- [P2P Bob Registration](https://sepolia.basescan.org/tx/0x7cd762efe79255343fabaa8cd0a5946a3e74f6bb7ae3e76221cc039f82aa6a2f): Bob registers Meta-Address + compliance rule
- [P2P Transfer](https://sepolia.basescan.org/tx/0xcf2e6670a931d237c15837f2819e15c0bfa14be1d96162c8e27f1d055b34b5f8): Alice → Bob's stealth address via Permit
- [P2P Sweep](https://sepolia.basescan.org/tx/0xcf4691a2b9bb83b843781aa70c84849df8ebc5e4c89ed9c0dc8a78fe454df59c): Bob gasless exit from stealth address, zero ETH used

---

### 2. Sharded OTC Darkpool: Absolute MEV Protection (Brokered Settlements)

Alice holds 1,000 mUSDC and wants mWLD. Bob holds mWLD and wants mUSDC. They want to trade without exposing their wallets, alerting the public mempool, or being front-run by MEV bots.

**How Ancile solves it:**

Both parties generate **5 ephemeral ghost wallets each** and sign EIP-2612 Permits for their tokens. Intent matching happens entirely off-chain inside the Chainlink CRE TEE. The CRE builds a single "Mega-Batch" transaction that:

1. Pulls Alice's 1,000 mUSDC via her permit
2. Pulls Bob's 500 mWLD via his permit
3. Pushes mWLD split across Alice's 5 ghost wallets (100 mWLD each)
4. Pushes mUSDC split across Bob's 5 ghost wallets (200 mUSDC each)

The entire settlement executes in **one atomic transaction**. There is no public mempool exposure: the matching is private inside the TEE. **Front-running is structurally impossible** because by the time the transaction hits the chain, it is already finalized. MEV bots see a completed settlement, not a pending intent. The on-chain result: zero link between Alice, Bob, and the receiving ghost wallets.

**Live testnet proof:**

- [OTC Alice Registration](https://sepolia.basescan.org/tx/0x5541c0992f4ebd5a7b77a29d6d00621edaadcaeabe92a626ab4409d08b2eceb0): Alice registers Meta-Address + compliance rule
- [Standard 1-to-1 OTC](https://sepolia.basescan.org/tx/0x994697d4039a357cb789395bdb1318dd856bd9329a8a6ad912924d8a696593aa)
- [Sharded Mega-Batch OTC](https://sepolia.basescan.org/tx/0x160b597afc57bee11495fa44d3c70bfb57e7b21efdc1ffadaf7b94b5f7414373)
- [OTC Sharded Batch-Sweep](https://sepolia.basescan.org/tx/0xf60a779f2f325d6e89534104a88259c6bb3c6ee710ede559d6127ea1d2f4dfe8)
- [Ghost Wallet Sweep 1](https://sepolia.basescan.org/tx/0xd38c3dd8b6e4566811f4ee889356fd23ba5b4fdf1885c136439da0c0a5eb31c8)
- [Ghost Wallet Sweep 2](https://sepolia.basescan.org/tx/0x0b434143601890edc2704b4f533a5d8da419b06533463f27adde2f4d7d3ce263)

---

## The AncileRouter: A Programmable Privacy Interface

`AncileRouter.sol` is not a specific application: it is a **general-purpose stateless privacy primitive** that any DeFi protocol can integrate without modifying their core contracts.

```
Protocol Contract           AncileRouter              Chainlink CRE
      │                          │                         │
      │  approve(router, amt)    │                         │
      │─────────────────────────>│                         │
      │                          │  Custom CRE Workflow    │
      │                          │  (your compliance rules)│
      │                          │<────────────────────────│
      │                          │  onReport(attestation)  │
      │                          │<────────────────────────│
      │                          │  → pull via permit      │
      │                          │  → route to stealth addr│
```

**What "programmable" means:** Each CRE workflow is independently configurable per protocol. A yield farm can require World ID + minimum balance. A DAO can require a governance token snapshot. A payments protocol can enforce Chainalysis risk scoring. None of this requires touching `AncileRouter.sol`: compliance logic lives in the CRE workflow, which is hot-swappable without affecting the on-chain proxy or its security model.

This is the key architectural insight: **new capability = new ActionType + new CRE workflow**. The existing proxy address and trust model stay unchanged.

---

## Security Model

### Dual Signature Verification

Every action requires two independent cryptographic proofs:

**Proof 1: EIP-2612 Permit:** Authorizes the router to pull a specific token amount. Verified by the ERC-20 contract itself against its domain-separated EIP-712 hash. The router cannot forge permits: it can only consume valid ones signed by the token owner.

**Proof 2: Ancile Intent Hash:** Authorizes the specific execution route. Verified on-chain via `ecrecover` against a replay-protected hash:

```
messageHash   = keccak256(sender ‖ destination ‖ amount ‖ routerNonces[sender])
ethSignedHash = keccak256("\x19Ethereum Signed Message:\n32" ‖ messageHash)
require(ecrecover(ethSignedHash, v, r, s) == sender)
routerNonces[sender]++
```

Nonces increment after every execution. A previously valid signature cannot be replayed: ever.

### The World ID Compliance Gate

World ID 4.0 (Semaphore ZK proofs) verification runs exclusively inside the Chainlink CRE's TEE **before** any on-chain call is made. If the proof is invalid, belongs to a different signal, or has been nullified (already used), the CRE workflow throws. Nothing hits the chain. Zero gas is wasted. The ZK proof itself never appears in calldata, preserving complete privacy.

### Trust Model


| Component            | Trust Level       | Notes                                                             |
| -------------------- | ----------------- | ----------------------------------------------------------------- |
| `AncileRouter.sol`   | Trustless         | Open source, verified on Basescan, UUPS upgradeable by owner only |
| Chainlink Forwarder  | Protocol-trusted  | The only address permitted to call `onReport` on-chain            |
| Chainlink CRE TEE    | Hardware-attested | Off-chain compute integrity via hardware attestation              |
| World ID (Semaphore) | ZK-proven         | Nullifier-based, no trusted setup, Sybil-proof by design          |
| User private keys    | Self-custodied    | Never transmitted: only signatures leave the user's device        |


---

## Deployed Contracts: Base Sepolia


| Contract                      | Address                                                                                                                              |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| AncileRouter (Proxy)          | `[0x81c693D8Df38BfCda1a578a1733E822C12f58d2f](https://sepolia.basescan.org/address/0x81c693D8Df38BfCda1a578a1733E822C12f58d2f#code)` |
| AncileRouter (Implementation) | `[0x2dA2ABAFE8013Ba940B7bEb2FfAC0757431524a9](https://sepolia.basescan.org/address/0x2dA2ABAFE8013Ba940B7bEb2FfAC0757431524a9#code)` |
| ERC-6538 Registry             | `0x6538E6bf4B0eBd30A8Ea093027Ac2422ce5d6538`                                                                                         |
| Chainlink Forwarder           | `0x82300bd7c3958625581cc2F77bC6464dcEcDF3e5`                                                                                         |
| MockUSDC                      | `0x9CC99Dfedf08aE1E5347cB4CfbD57b04CAe6029D`                                                                                         |
| MockWLD                       | `0x6D138c0d2557c2A3C978EebB258A042e9a6d6d43`                                                                                         |


---

## Roadmap: Expanding the Privacy Stack

The current implementation proves the **stateless routing primitive** end-to-end with live testnet transactions: P2P stealth transfers and sharded OTC settlements, fully on-chain, no custodian.

The next phase introduces a **lightweight vault architecture** (minimum required: a protocol-controlled ERC-4626 vault that pre-approves the router) to unlock contract-to-receiver privacy flows. This unblocks the full DeFi privacy stack:


| Extension                          | Status           | What It Unlocks                                                                  | Mechanism                                                                                                                                                                                   |
| ---------------------------------- | ---------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Dark Treasury: Private Payouts** | Next milestone   | DAO payroll, yield distribution, and airdrop claims that never doxx contributors | Protocol pre-approves `AncileRouter`; contributors submit World ID proof to CRE; CRE verifies + routes claim directly into a derived stealth address: contributor graph permanently private |
| **Yield-bearing Stealth Wallets**  | Requires vault   | Eliminates dead capital in stealth addresses                                     | `SWAP` action deposits incoming tokens directly into ERC-4626 vaults (sDAI, aUSDC) in the same atomic transaction                                                                           |
| **Sanctioned-Address Firewall**    | CRE workflow     | Institutional compliance without custodianship                                   | Chainalysis/TRM API call inside the CRE before execution: compliance off-chain, enforcement on-chain                                                                                        |
| **Private Auction Settlements**    | Requires vault   | MEV-free sealed-bid auctions                                                     | Bids matched entirely inside the TEE and settled atomically to ghost wallets: zero front-running by design                                                                                  |
| **Cross-chain Private Transfers**  | CRE workflow     | Privacy across chains from a single signature                                    | CCIP integration in the CRE workflow: private stealth transfer across any supported chain                                                                                                   |
| **Shielded Governance**            | CRE workflow     | Anonymous on-chain voting                                                        | Votes cast from stealth addresses with World ID uniqueness: one human, one vote, zero doxx                                                                                                  |
| **Private NFT Sales**              | Router extension | ERC-721 privacy                                                                  | ERC-721 + ERC-20 pulled and routed atomically: NFT sale with no buyer-seller link                                                                                                           |


The architectural commitment to **stateless, non-custodial routing from day one** means every extension above is purely additive. New capability = new `ActionType` + new CRE workflow. The existing proxy address and security model stay unchanged.

---

## Standards Implemented


| Standard                                            | Role in Ancile                                                                    |
| --------------------------------------------------- | --------------------------------------------------------------------------------- |
| [ERC-5564](https://eips.ethereum.org/EIPS/eip-5564) | Stealth address derivation, 1-byte view tag scanning, Announcement events         |
| [ERC-6538](https://eips.ethereum.org/EIPS/eip-6538) | On-chain stealth meta-address registry: receivers register their public keys here |
| [EIP-2612](https://eips.ethereum.org/EIPS/eip-2612) | Gasless permit-based token approvals: every action is signature-only              |
| [EIP-712](https://eips.ethereum.org/EIPS/eip-712)   | Typed structured data signing for all permits and intent hashes                   |
| [ERC-1967](https://eips.ethereum.org/EIPS/eip-1967) | UUPS upgradeable proxy: logic upgradeable by owner, storage slot standardized     |
| [ERC-4626](https://eips.ethereum.org/EIPS/eip-4626) | Yield vault integration: dead capital elimination (roadmap)                       |


## Technology Stack


| Layer                   | Technology                                                |
| ----------------------- | --------------------------------------------------------- |
| Smart Contracts         | Solidity 0.8.28, OpenZeppelin UUPS, Hardhat v3            |
| Off-chain Orchestration | Chainlink CRE (Trusted Execution Environment), TypeScript |
| Privacy Primitive       | ERC-5564 secp256k1 ECDH stealth address derivation        |
| Sybil Resistance        | World ID 4.0 (Semaphore ZK proofs), IDKit Core v4         |
| Chain                   | Base Sepolia (testnet)                                    |
| Transaction Signing     | viem, ethers.js v6                                        |


---

> **To run the demos yourself:** all contracts are already deployed on Base Sepolia. Add a Base Sepolia RPC URL to `config.json` and CRE_ETH_PRIVATE_KEY to `.env`: that's it. Full step-by-step CLI instructions, repository architecture, and live transaction proofs: see [TECHNICAL_GUIDE.md](./TECHNICAL_GUIDE.md)

*Built for the Chainlink CRE Hackathon 2026. Non-custodial. Open source. Stateless by design.*

*Project: **ancile-cre-stealth***