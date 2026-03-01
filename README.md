# Ancile Stealth

**Programmable Private Routing for Web3.**

Ethereum is radically transparent by default. While native privacy is finally emerging through powerful cryptographic standards like **ERC-5564 (Stealth Addresses)**, the raw protocol has a ceiling. The elliptic curve math enabling non-interactive private transfers is brilliant, but it natively lacks the programmable compliance, Sybil resistance, and gas abstraction required for institutional DeFi adoption.

Ancile bridges this gap. By leveraging the **Chainlink Runtime Environment (CRE)** as an off-chain TEE firewall, Ancile introduces a stateless, non-custodial privacy router protected by Zero-Knowledge proofs (World ID) and programmatic risk safeguards.

### The Problem: Why Raw ERC-5564 Fails in Production

1. **The Gas Funding Trap (The Zero-to-One Problem):** When a user receives tokens in a freshly derived stealth address, that wallet holds exactly 0 ETH. To withdraw or swap the tokens, the user is forced to fund the wallet with gas from a public exchange or their main EOA. This immediately links their public identity to the stealth address, permanently destroying the privacy they just created.
2. **Permissionless Sybil Risk:** Because raw ERC-5564 is strictly permissionless, smart contracts (like DAO treasuries or yield farms) cannot enforce rules on *who* receives funds. Without a compliance layer, automated treasuries are highly vulnerable to bot farming, Sybil attacks, and routing funds to sanctioned entities.
3. **Dead Capital:** Funds hiding in stealth addresses sit idle. Users are currently forced to choose between cypherpunk privacy and capital efficiency (earning 0% yield).

### The Solution: Ancile Stealth

**Ancile Stealth** is a non-custodial, stateless privacy protocol that enables EOAs and smart contracts to execute programmable, compliance-gated private token transfers.

Built natively on **ERC-5564** and orchestrated by the **Chainlink CRE**, Ancile completely abstracts the cryptographic friction of stealth addresses. It acts as an intelligent, off-chain routing brain—enforcing World ID Sybil resistance, computing the heavy scalar math, and providing automated, gasless relayer exits for users, ensuring their transaction graph remains mathematically unbreakable.

---

### Core Use Cases

**1. Peer-to-Peer Verified Stealth Transfers (User-to-User)**
Alice needs to send a payment to Bob, but Bob demands absolute privacy and clean capital: the sender *must* be a verified human (World ID) and pass strict geographic or risk criteria. Alice initiates the payment off-chain by signing an EIP-2612 gasless Permit. The Ancile CRE acts as the off-chain compliance engine—it verifies Alice's World ID, computes the heavy ERC-5564 stealth cryptography using Bob's Meta-Address, and executes the atomic on-chain settlement. The CRE pulls the funds via the Permit and routes them directly into a freshly derived, one-time stealth address exclusively controlled by Bob. When Bob is ready to exit, he uses the Ancile CRE Relayer to anonymously sweep his funds to a centralized exchange, paying for gas entirely via signatures to ensure zero on-chain linkage.

**2. The "Dark Treasury" (Contract-to-Receiver Payouts)**
DeFi vaults, DAOs, and governance protocols constantly need to distribute capital—whether for yield farming, payroll, protocol revenue sharing, or treasury operations—but doing so on a public ledger doxxes their entire contributor graph. Instead of building custom privacy infrastructure from scratch, protocols simply integrate the stateless `AncileRouter` and configure a custom CRE workflow tailored to their specific rules.

* **The Workflow:** A protocol (e.g., a yield farm) mandates that users must submit their ERC-5564 Meta-Address and a World ID ZK-proof to claim their rewards.
* **The Execution:** The CRE verifies the user's unique humanity and executes protocol health safeguards off-chain. Once cleared, the CRE triggers the router to pull the exact funds from the treasury and drop them directly into the user's newly computed stealth address.

Protocols keep their smart contracts simple and public, while users receive their funds with absolute cypherpunk privacy.

---

## Architecture & Core Primitives

Ancile relies on a combination of native Ethereum standards and TEE-based off-chain computation to solve the privacy and verification trilemma, creating a strictly stateless routing layer without requiring centralized custody or liquidity pools.

* **ERC-5564 (Stealth Addresses):** Provides non-interactive, mathematical privacy. The protocol computes a unique, cryptographically secure one-time address for every transfer. Receiver identities are completely obfuscated on-chain. We implement the standard's **1-byte View Tags**, enabling O(1) scanning efficiency so lightweight mobile clients can parse incoming payments without battery-draining elliptic curve operations.
* **Chainlink CRE (Decentralized TEE):** Serves as Ancile's stateless, off-chain orchestrator and compliance engine. It performs the heavy scalar multiplication for stealth address derivation, validates Zero-Knowledge proofs (World ID), evaluates programmable risk APIs, and acts as the gasless relayer for on-chain execution.
* **EIP-2612 (Permits):** Enables completely gasless, signature-based token transfers for senders initiating P2P payments.
* **ERC-4626 (Auto-Yield Integration):** Eliminates the "dead capital" problem of stealth wallets by optionally routing incoming transfers directly into yield-bearing vaults (e.g., sDAI, aUSDC) within the exact same atomic transaction.

## The Technical Flow

Ancile's modular architecture supports two distinct execution paths: **Peer-to-Peer (P2P)** transfers and **Contract-to-Receiver** distributions (e.g., DAO payroll, yield claims).

### 1. Receiver Setup & Rule Creation

* **Bob** generates an ERC-5564 Meta-Address (comprising a viewing public key and a spending public key) locally via a deterministic wallet signature.
* He registers this Meta-Address with the Ancile protocol off-chain and defines his programmable compliance rules (e.g., *"Sender must possess a valid World ID"*).

### 2. The Intent & Payload (Bifurcated Flow)

Depending on the use case, the trigger payload sent to the Ancile CRE API differs:

* **Path A: Peer-to-Peer (Alice ➔ Bob):** Alice wants to pay Bob while respecting his compliance rules. She signs an EIP-2612 Permit for the transfer amount and submits the payload—comprising the Permit, Bob's Meta-Address, and **Alice's World ID Proof**—to the CRE.
* **Path B: The Dark Treasury (DAO ➔ Bob):** A DAO has pre-approved the `AncileRouter` to distribute payroll. To claim his funds without doxxing his identity, Bob submits the payload—comprising the DAO's contract address, his Meta-Address, and **Bob's World ID Proof**—to the CRE.

### 3. Off-Chain Orchestration (Chainlink CRE)

Inside the secure TEE, the CRE executes the core workflow in milliseconds:

1. **The Compliance Firewall:** Validates the provided World ID ZK proof (ensuring Sybil-resistance for the claimant or sender) and checks external risk APIs. If rules fail, the transaction drops.
2. **Stealth Derivation:** If cleared, the CRE computes the one-time `stealthAddress` ($P_{stealth}$) and the `ephemeralPublicKey` ($R$) using standard secp256k1 math based on Bob's Meta-Address.
3. **Transaction Assembly:** Constructs and signs the EVM transaction using the CRE's relayer wallet.

### 4. Atomic On-Chain Settlement (`AncileRouter.sol`)

The CRE submits a single, automated transaction to the Ancile Router, which:

1. Pulls the funds (via Alice's `permit` or the DAO's `transferFrom`).
2. *(Optional)* Deposits assets into an ERC-4626 yield vault.
3. Routes the underlying asset directly to the newly derived `stealthAddress`.
4. Calls the official `ERC5564Announcer` contract to emit the `Announcement` event (containing the ephemeral key $R$ and the View Tag).

### 5. Discovery & Gasless Exit

* Bob's client silently scans the blockchain for `Announcement` events, filtering instantly via View Tags.
* Upon a match, Bob's client uses Diffie-Hellman key exchange to locally derive the private spending key for that specific stealth address.
* **The Exit:** To withdraw the funds to a centralized exchange without funding the stealth address with ETH (which would dox him), Bob signs a meta-transaction payload using *only* the stealth private key. The CRE relays this withdrawal on-chain, paying the gas fee on Bob's behalf and ensuring complete transaction graph obfuscation.

---
