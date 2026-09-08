# VeilLend

> **Confidential borrow-lend protocol on Horizen.**

VeilLend is a privacy-first lending protocol that keeps **collateral, debt, and health state private** while allowing the protocol to verify solvency, state transitions, and liquidation eligibility on-chain.

Private state is represented by **Poseidon commitments**, and sensitive state transitions are authorized with **Groth16 zero-knowledge proofs** generated client-side and verified by Solidity contracts on Horizen.

---

## Why VeilLend?

Public DeFi lending exposes the financial state that matters most:

* **Collateral** — how much a borrower has posted.
* **Debt** — how much they owe.
* **Health / risk** — how close a position is to liquidation.
* **Liquidation activity** — which positions are being liquidated and for what amounts.

That creates more than a cosmetic privacy issue.

Public lending positions can become targets for:

* copy-trading and transaction monitoring;
* borrower profiling and de-anonymization;
* liquidation strategies based on public risk data;
* financial surveillance of wallets carrying meaningful debt.

VeilLend explores a different model:

> **The protocol should be able to verify financial rules without turning every borrower's financial position into a public credit file.**

---

## The Solution

VeilLend separates **private position state** from the public information required for protocol execution.

A position's private financial state is committed using a versioned, domain-separated **Poseidon commitment over BN254**.

The protocol then uses zero-knowledge proofs to verify statements such as:

* the prover knows the private state behind the active commitment;
* the control secret is correct;
* the position ID matches;
* the state transition is valid;
* sequence and nullifier rules are satisfied;
* a post-action position remains solvent;
* a position satisfies liquidation conditions.

The chain verifies these properties without receiving the underlying collateral, debt, accrued interest, or health factor as plaintext.

Proof generation happens **client-side in the browser** using `snarkjs`.

The blockchain stores commitments and public accounting data, but does not store the private position balances.

---

## Core Properties

### Private Collateral

Collateral amounts are contained in the private position state and represented on-chain by commitments.

Public accounting tracks supported collateral for custody and protocol-level enforcement, but the position's private balance remains hidden.

### Private Debt

Debt is maintained inside the private state.

Interest accrues through a public per-asset debt index, while the actual debt amount remains part of the private witness used by the ZK circuit.

### Private Health / Risk State

Health and solvency are not published as plaintext values.

The protocol verifies the required risk conditions through zero-knowledge proofs.

### Confidential Liquidation

Liquidation eligibility and settlement values are derived from private state inside a dedicated Groth16 circuit.

A liquidator can prove that a position is undercollateralized without learning the borrower's exact collateral, debt, or health factor.

### Non-Custodial Architecture

The protocol provides **no administrative withdrawal path and no custody
backdoor**. The current UUPS deployment has **owner-only upgrade authority**
(`_authorizeUpgrade` is restricted to the contract owner) — no multisig or
timelock governance yet, which is tracked as M2 hardening work.

Private positions are controlled by their cryptographic control secret, which is bound into the commitment and nullifier construction.

The current deployment is a testnet prototype and is not intended to represent a final production governance or upgrade architecture.

---

## How It Works

```text
Private Position State

(collateral, debt, index snapshot, control secret, salt)

                    │
                    ▼

        Poseidon Commitment
       (BN254 / versioned)

                    │
                    ▼

          Groth16 ZK Proof
       generated in the browser

                    │

       "I know the private state,
        control the position,
        and this transition satisfies
        the protocol rules."

                    │
                    ▼

       On-chain Solidity verification

                    │
                    ▼

        New commitment / sequence
        + nullifier consumption
```

The main protocol paths are:

### Deposit / Repay

`state_transition` handles private state transitions for:

* Deposit — `actionId = 1`
* Repay — `actionId = 2`

The transition proof binds the ERC20 amount to the private state update.

### Borrow / Withdraw

`risk_transition` handles:

* Borrow — `actionId = 3`
* Withdraw — `actionId = 4`

The circuit verifies the resulting private state and, for risky actions, enforces post-action solvency.

The core solvency relation is evaluated using integer arithmetic:

```text
collateral × collateralPrice × 10000
    ≥
debt × debtPrice × maxLtvBps
```

Prices are obtained from the on-chain oracle path rather than selected by the caller.

### Interest

Interest uses a public WAD-scaled debt index.

The private debt is updated inside the ZK transition using the current public index.

### Oracle Freshness

Risk-sensitive actions require fresh oracle prices.

Stale or missing prices are rejected on-chain.

---

## Borrow / Withdraw Security Model

VeilLend uses multiple independent protections around private state transitions.

### Position Binding

Proofs are bound to the private position state and the public `positionId`.

A proof generated for one position cannot authorize a different position.

### Recipient Binding

Outbound-value proofs bind the payout recipient as a public signal derived on-chain from:

```solidity
msg.sender
```

Therefore, a proof copied from the mempool cannot simply be replayed by another wallet to steal the payout.

### Sequence and Nullifier Protection

Each state transition advances the position sequence exactly once.

Poseidon nullifiers provide replay protection and are consumed only after successful verification.

### Supported-Collateral Accounting

The contract maintains:

```solidity
supportedCollateral[positionId]
```

This value represents collateral actually supported by token custody.

It increases only from actual deposits and decreases through withdrawals or liquidation.

This prevents fabricated private collateral from being used to obtain protocol funds.

### Borrow Outstanding

The contract also maintains:

```solidity
borrowOutstanding[positionId]
```

This public accounting value tracks cumulative outstanding borrowing for protocol-level enforcement.

### On-Chain LTV Cap

Borrowing is additionally constrained by the public custody ledger:

```text
(outstanding + amount) × debtPrice × 10^collateralDecimals × 10000
    ≤
supportedCollateral × collateralPrice × 10^debtDecimals × maxLtvBps
```

If this limit is exceeded, the transaction fails with `BorrowCapExceeded`.

The cap is a cross-multiplied DOLLAR-VALUE limit: debt and collateral
tokens with different decimals (e.g. 18 vs 6) are normalized through the
oracle prices and each asset's recorded decimals, so the comparison stays
economically exact. This provides defense in depth alongside the private ZK
solvency check (which uses the same 18-dec-normalized price inputs).

### Withdraw Protection

Withdrawals must satisfy both:

1. the private-state transition rule requiring the withdrawal amount to be no greater than hidden collateral; and
2. the on-chain supported-collateral and custody accounting.

---

## Confidential Liquidation

VeilLend includes a dedicated liquidation circuit.

A liquidation proof demonstrates that the private position is undercollateralized:

```text
collateral × price × 10000
    <
debt × price × liquidationThresholdBps
```

The comparison is performed over the private state.

### In-Circuit Settlement

The circuit derives the settlement values:

```text
collateralOut = hidden collateral

debtOut = min(
    hidden debt,
    oracle-parity value of collateral
)
```

The settlement recipient is derived on-chain from `msg.sender`.

The liquidator pays the required parity debt into the protocol reserve and receives the permitted collateral output.

### Liquidation Properties

* Permissionless liquidation.
* Private collateral and debt remain hidden.
* Liquidation eligibility is proven rather than publicly calculated.
* Settlement outputs are derived inside the circuit.
* Oracle freshness is enforced.
* Sequence and nullifier protections apply.
* Collateral seizure is constrained by `supportedCollateral`.

The current demo uses controller self-liquidation to demonstrate the mechanism, but the protocol path itself is permissionless.

### Current PoC Limitation

If liquidation closes a position with residual debt, the remaining outstanding debt is currently wiped.

That bad debt is therefore socialized / absorbed by the protocol reserve.

This is a documented PoC design limitation; production liquidation economics will require additional mechanism design.

---

## Interest-Rate Model

VeilLend currently implements a public debt-index mechanism.

Each asset has a `RateConfig` containing:

```text
baseRateBps

slopeBps

targetUtilizationBps

reserveFactorBps

maxLtvBps

liquidationThresholdBps
```

Configuration values are validated against the ranges required by the protocol and ZK circuits.

### Debt Index

Each asset maintains:

```text
debtIndexStates[asset]
```

The index is WAD-scaled, starts at `1e18`, and is non-decreasing.

### Accrual

`accrueInterest` updates the index based on elapsed time.

The operation is permissionless and currently follows a lazy / keeper-style model.

### ZK Debt Calculation

The circuit calculates accrued private debt using exact ceiling arithmetic:

```text
accruedDebt =
    ceil(oldDebt × currentIndex / oldIndex)
```

The on-chain protocol also rejects stale or decreasing index values.

### Current Scope

The stored utilization-based parameters are intentionally present for the planned production rate model, but they are **not currently active**.

The current accrual formula uses the configured base rate.

Production economics can later introduce utilization-derived rates once the required public aggregate accounting and economic parameters are finalized.

---

## Oracle

### Current Testnet Oracle

The current Horizen testnet deployment prices assets through an owner-gated:

```text
OwnerMockPriceOracle
```

fed by the Testnet/Demo Base-Chainlink relay (Base Mainnet Chainlink
ETH/USD + USDC/USD → `relay/base-price-relay.mjs` → Horizen). It exists for
development and E2E demonstration and is **TESTNET/DEMO ONLY** — the
production oracle path is the deployed Stork adapter (see Production
Oracle Path below).

The oracle includes:

* price freshness checks;
* price bounds;
* configurable maximum staleness.

The testnet oracle is **not production infrastructure**.

### Production Oracle Path (Stork)

The **Horizen Stork oracle** is the production oracle path and is implemented, configured, and deployed on Horizen Testnet behind the same freshness and price-validation interface: the **`StorkPriceOracle` adapter is deployed** (`IPriceOracle` → the real Stork push oracle at `0xacC0…d62`), the official registry feeds are configured — **WETH → `WETHUSD`** (`0x8afba5f1…82b8`), **USDC → `USDCUSD`** (`0x7416a56f…290c`) — and the permissionless same-transaction flow exists (`pushOracleUpdate`: a signed Stork snapshot is relayed and consumed by the user's proof in one transaction).

What is **not yet active** is live Stork testnet publishing/relaying: no subscriber relayer is pushing signed WETHUSD/USDCUSD observations to Horizen testnet yet (Stork's data API requires subscriber credentials). Stork has not been replaced or removed — when publishing starts, the deployment's live price path switches to Stork.

Production price path (intended):

```text
Stork signed data  →  Stork on-chain update  →  VeilLend
```

Stork testnet feeds are not yet actively published (no subscriber relayer is running on Horizen testnet), so the CURRENT testnet deployment temporarily points at a separate **Testnet/Demo price path** (see "Testnet / Demo Price Source" below). These are two distinct paths: Stork remains the production design; the demo path is temporary infrastructure, not a production oracle and not a Stork replacement.

This keeps the privacy and risk architecture separated from the oracle implementation.

---

## Why Horizen?

VeilLend is designed specifically around the privacy requirements of the Horizen ecosystem.

Horizen provides an EVM-native environment where privacy can be implemented at the application layer.

That fits VeilLend's architecture:

```text
Private state

     ↓

Client-side ZK proving

     ↓

Poseidon commitment

     ↓

Horizen EVM

     ↓

On-chain proof verification
```

The result is a lending protocol that can preserve private financial state while still providing verifiable on-chain execution.

VeilLend is also aligned with the Horizen S2 direction around **private borrow-lend infrastructure**, including:

* confidential collateral positions;
* confidential borrow sizes;
* private health factors;
* provable solvency;
* private liquidation;
* reliable interest mechanics;
* integration with the Horizen ecosystem.

---

## Base & Ecosystem Liquidity

VeilLend is deployed on Horizen and is designed to access liquidity originating from the broader Base ecosystem through existing ecosystem infrastructure.

Horizen's position as an EVM-native L3 built on Base provides a path for assets and liquidity originating on Base to enter Horizen markets.

VeilLend will **not build a separate bridge**.

Instead, future production deployment will use existing Base ↔ Horizen bridging and ecosystem infrastructure to make supported Base-originating assets available to VeilLend lending markets on Horizen.

This integration is an ecosystem and liquidity expansion path rather than a dependency for the core confidential lending architecture.

> **Current testnet reality:** Base-originating assets (WETH, USDC) are
> already enabled on the current Testnet deployment. Their testnet prices are
> fed by the temporary **Testnet/Demo** Base-Chainlink relay into an
> owner-gated demo oracle — a convenience for testing, not a production
> oracle. The production price path is Stork (WETHUSD/USDCUSD, configured);
> Base-originating liquidity itself remains future ecosystem work.

Planned integrations include:

* Base-originating liquidity entering supported VeilLend markets;
* supported collateral and debt assets available through Horizen ecosystem infrastructure;
* integrations with relevant Horizen DeFi applications;
* composable lending flows with privacy-focused ecosystem applications;
* additional liquidity integrations as the Horizen ecosystem develops.

---

## Horizen Testnet Deployment

**Network:** Horizen Testnet

**Chain ID:** `2651420`

### Current Deployment (UUPS / ERC-1967)

| Contract | Address |
| --- | --- |
| **VeilLend (UUPS proxy)** | `0xc1e2cDADBf14717DfEE7ffA23EAf2b21e6004a5B` |
| VeilLend implementation | `0x353EcfaFa07a60f1Ed473ed4cE3F1c2624fF7aa5` |
| StorkPriceOracle adapter (production path) | `0xa2c0a60B4A360e88cA5f90860A3B75A3DDfED33D` → Stork `0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62` |
| OwnerMockPriceOracle (Testnet/Demo oracle) | `0x024CF745c737B74f8BCc84d1C73687853310b715` |
| Groth16Verifier — State Transitions | `0xbdF87292EAAd22dB17C5ADCA3eAC33Db891ab3f1` |
| SolvencyVerifier | `0x18C104Dc76A6F4Dad6cC1f2E467D9EbC10162676` |
| RiskTransitionVerifier | `0xB54B51664215ED17F238D52EDD8d5E549D136b26` |
| LiquidationVerifier | `0xe33b96CC86D3c68119312b9B2274F1e734211daa` |
| vCOL (test mock) | `0xb5a5b0f1083965B9d92dCd94E5BCdDb868BfcFCE` |
| vDBT (test mock) | `0xe48a8EC02EB14BB52Fe363D3B2A32e264d3B5D7f` |
| WETH | `0x4200000000000000000000000000000000000006` |
| USDC | `0x01c7AEb2A0428b4159c0E333712f40e127aF639E` |

`ZEN` is not enabled (locked — no ZEN/USD Stork feed).

The Stork adapter is configured with the official registry feeds:
**WETH → `WETHUSD`** (`0x8afba5f1…82b8`), **USDC → `USDCUSD`**
(`0x7416a56f…290c`).

**RPC:** `https://horizen-testnet.rpc.caldera.xyz/http`

**Explorer:** `https://explorer-testnet.horizen.io/`

**Hub / Faucet:** `https://hub-testnet.horizen.io/`

The complete machine-readable deployment record for the current deployment:

`deployments/horizenTestnet-uups.json`

### Historical M1 Deployment (immutable — superseded)

| Contract | Address |
| --- | --- |
| VeilLend (M1, non-proxy) | `0xeCB439fbE792Bec4E005f1809E6DCF4FB37d4787` |
| RiskTransitionVerifier (repaired) | `0x65dcBf151d10E63a43b972c41C760E983154Cefb` |
| Groth16Verifier — State Transitions | `0x0D96E5a05d11c0839037488332CAd29E6Ef6686C` |
| SolvencyVerifier | `0xD33ce96e9A6AF2c8f5E7f73d5214eDf0c9eff24F` |
| LiquidationVerifier | `0x4bf85D6D5f3A730280D707dB0D2d063940A80869` |
| MockPriceOracle | `0xDA4CAA96D6fF78Af30A3955b5310BE9258d57Bc2` |
| vCOL / vDBT | `0x281FbbeD6f2DEA61c86191EA92f2B9B9D2D66a3c` / `0xe27c05934Ad4046d72766808b30F0514e978f612` |

The M1 deployment above is a **historical, immutable, non-proxy
deployment**: it was never upgraded, and the UUPS proxy is a **separate,
newer deployment** that is the current official Testnet contract. M1's
record is preserved in `deployments/horizenTestnet.json` (which also
preserves the first superseded deployment for historical evidence); the
M1-era proof/liquidation evidence documents are marked historical.

---

## Verification Evidence

The current repository contains the following previously completed verification evidence.

### Root Protocol Tests

**156 tests passing**

Coverage includes:

* unit tests;
* ZK circuit tests;
* solvency;
* interest accounting;
* risk transitions;
* supported-collateral accounting;
* adversarial cases;
* recipient binding;
* liquidation;
* replay protection;
* fuzzing;
* invariant testing;
* a local end-to-end lifecycle suite (`test/e2e-lifecycle.test.ts`, 14 tests)
  exercising **all six supported asset pairs** (vCOL/WETH/USDC collateral ×
  vDBT/USDC debt, 6 and 18 decimals) through create → deposit → borrow →
  repay → withdraw with per-step commitment/sequence/balance checks, plus
  negative cases: unsupported asset, over-borrow (value-based decimal-aware
  cap), stale oracle snapshot, tampered proof, wrong-asset witness, replayed
  proof, invalid withdrawal, and no partial state on failure.

### Browser Demo

The `demo/` directory contains a working Next.js frontend using React/TypeScript, wagmi, viem, and browser-side `snarkjs` — **no backend involved in the proving path**.

It runs against the current UUPS Testnet deployment and includes:

* the guided flow Connect → Create (collateral/debt pair chosen once) → Deposit → Borrow → Repay → Withdraw, each action a real ZK proof;
* an **Assets** panel (vCOL/vDBT active; WETH/USDC enabled and testable; ZEN locked) with per-asset balances and decimals;
* a **"Testnet / Demo Price Source — Base Chainlink → Mock Oracle"** panel with live WETH/USD and USDC/USD prices and a **Refresh Prices** action (relay-fed, server-side owner signature — users never submit a price; **TESTNET/DEMO ONLY**, the production oracle path is Stork);
* confidential liquidation demonstration, encrypted private-state recovery prototype, signature determinism test;
* developer/test tools (mint, seed liquidity) visually separated from the user flow.

**Full walkthrough, asset table, deployed addresses, and limitations: see
[`demo/README.md`](demo/README.md).**

## Repository Structure

```text
circuits/

├── veillend_lib.circom       # shared commitment/nullifier/arithmetic logic
├── state_transition.circom   # deposit / repay
├── solvency.circom            # private solvency proof
├── risk_transition.circom     # borrow / withdraw + post-action solvency
└── liquidation.circom         # private liquidation eligibility + settlement

contracts/

├── VeilLend.sol               # protocol
└── zk/                        # generated Solidity verifiers

scripts/

├── prove.ts                   # proving utilities / local E2E
├── deploy.ts                  # full testnet deployment
├── deploy-riskfix.ts          # repaired deployment
├── e2e-riskfix.ts             # lifecycle E2E
└── proof-test.ts              # on-chain ZK integration test

test/                           # unit, ZK, adversarial, fuzz and invariant tests

demo/                           # Next.js browser application

deployments/                    # deployment records and E2E logs

docs/                           # architecture, privacy, security and evidence

architecture.md                 # design reference
```

---

## Quickstart

### Requirements

* Node.js 18+
* Circom 2.2.x
* Hardhat
* A funded Horizen testnet wallet for on-chain operations

The Circom binary can be provided through:

```text
tools/circom.exe
```

or available on `PATH`.

### Install

```bash
npm install
```

### Build the ZK Stack

```bash
npm run zk:build
```

This compiles the circuits, generates the proving artifacts, and regenerates the Solidity verifiers.

### Compile Contracts

```bash
npm run build
```

### Run Tests

```bash
npm test
```

### Run Local Proof Demonstration

```bash
npm run prove
```

### Run the Browser Demo

```bash
cd demo
npm install
npm run dev
```

Then open:

```text
http://localhost:3000
```

### Testnet Operations

For on-chain commands, configure:

```text
HORIZEN_TESTNET_PRIVATE_KEY
```

in `.env`.

See `.env.example` for the expected configuration.

---

## Built vs. Future

### Already Built

* Poseidon-based private state commitments;
* Groth16 zero-knowledge proofs;
* browser-side proof generation;
* on-chain Solidity proof verification;
* private solvency verification;
* private deposit / repay state transitions;
* borrow / withdraw risk transitions;
* post-action solvency enforcement;
* confidential liquidation;
* sequence and nullifier replay protection;
* recipient binding;
* supported-collateral accounting;
* borrow-outstanding accounting;
* oracle freshness enforcement;
* public debt-index interest mechanics;
* the **current UUPS/ERC-1967 testnet deployment** (owner-only
  `_authorizeUpgrade`);
* the **Stork production oracle path**: `StorkPriceOracle` adapter deployed
  and wired to the real Stork push oracle with the official
  **WETHUSD / USDCUSD** feeds and permissionless `pushOracleUpdate`
  (activation awaits Stork testnet publishing);
* the **Testnet/Demo price relay**: Base Chainlink → owner-gated
  `OwnerMockPriceOracle` (**TESTNET/DEMO ONLY**, isolated in `relay/`);
* **WETH (18) / USDC (6)** enabled with decimal-normalized, value-based risk
  accounting — a real WETH/USDC lifecycle executed on-chain;
* working browser frontend;
* encrypted private-state recovery prototype.

### Future Production Milestones

* external security audit;
* Stork production activation/hardening (subscriber credentials/relaying on
  Horizen testnet, then switching the live price path to Stork);
* broader collateral support;
* utilization-based interest-rate economics;
* production incentives and reserve mechanics;
* Base-originating liquidity access through existing Base ↔ Horizen infrastructure;
* deeper Horizen ecosystem integrations;
* mainnet deployment;
* production monitoring and operational hardening;
* real user and liquidity growth.

---

## Honest Scope & Limitations

### Position Privacy, Not Transaction Privacy

VeilLend currently hides the **cumulative private position state**.

The ERC20 layer itself remains public.

Therefore individual token transfer amounts associated with protocol transactions can still be observed.

What remains private is the position's cumulative:

* collateral;
* debt;
* accrued interest;
* health / risk state.

### Unaudited

The protocol has not undergone an external security audit.

A production deployment requires additional security review and audit work.

### Testnet Deployment Model

The **currently live official testnet deployment is the UUPS/ERC-1967 deployment**: proxy `0xc1e2cDADBf14717DfEE7ffA23EAf2b21e6004a5B` → implementation `0x353EcfaFa07a60f1Ed473ed4cE3F1c2624fF7aa5`, with owner-only `_authorizeUpgrade` (record: `deployments/horizenTestnet-uups.json`).

The fixed M1 deployment (immutable verifier addresses, non-upgradeable contract, recorded in `deployments/horizenTestnet.json`) is **historical and superseded** — it was never upgraded; the UUPS proxy is a separate, newer deployment.

Production upgrade governance (multisig/timelock), emergency process, and recovery mechanics remain open M2 work.

### Testnet / Demo Price Source — Base Chainlink → Mock Oracle

The current Testnet deployment temporarily prices assets through a demo-only path:
`Base Mainnet Chainlink (ETH/USD, USDC/USD) → isolated relay (relay/base-price-relay.mjs) → OwnerMockPriceOracle (owner-gated, 0x024C…b715) → VeilLend`. The relay is server-side, holds the owner key in its environment, accepts no user-supplied prices, and can be deleted without touching VeilLend.

This is **TESTNET/DEMO ONLY** — it is not production oracle infrastructure and not a Stork replacement. The production path is Stork (adapter deployed, feeds configured; activates when Stork testnet publishing starts).

### Orphaned Legacy Oracle

The original M1-era `MockPriceOracle` had an open (permissionless) `setPrice` and is **no longer used by the protocol** (orphaned by `setOracle`); the demo oracle is the owner-gated `OwnerMockPriceOracle`.

### Private-State Recovery

Manual recovery is integrated into the main demo: every position offers **Download Recovery File**
(`VeilLend-Position-N-Recovery.json`, one encrypted file per position), and a browser with no local
positions offers **Restore from Recovery File** — select the file, sign the domain-separated challenge,
decrypt, and the recovered state is verified against the current on-chain commitment before anything is
restored. It is a client-side mechanism using encrypted backup material and wallet-derived key material.

It is not an on-chain recovery mechanism and does not grant additional protocol permissions.

Restore relies on deterministic wallet signatures: software wallets (MetaMask and similar) work;
hardware wallets typically sign non-deterministically and cannot restore — re-download the file instead.

Loss of the recovery material means the private state cannot be reconstructed through this mechanism.
The `/recovery-test` page remains as the developer/test flow for the same logic.

### Liquidation Bad Debt

Residual debt is currently wiped when a position closes through liquidation.

The remaining bad debt is therefore socialized / reserve-absorbed.

Production liquidation economics are not finalized.

### Trusted Setup

The current ZK proving artifacts use a PoC single-contributor trusted setup.

A production deployment requires an appropriate trusted setup ceremony or another proving system with suitable production assumptions.

### Interest Accrual

Interest accrual is currently lazy and permissionless.

The index advances when `accrueInterest` is called.

Utilization-based rate parameters are stored but not yet active.

### Test Assets

`vCOL` (collateral) and `vDBT` (debt) are testnet-only mock assets.

`WETH` (18 decimals, Stork feed **WETHUSD**) and `USDC` (6 decimals, Stork
feed **USDCUSD**) are enabled on the current Testnet deployment and fully
testable — a real WETH/USDC lifecycle (create → deposit → borrow → repay →
withdraw with real ZK proofs) has been executed on-chain. Until Stork testnet
publishing starts they are priced by the temporary Base Chainlink demo relay
(see Oracle). `ZEN` remains locked (no ZEN/USD Stork feed). USDT is not
supported.

Nothing in the current deployment represents production mainnet liquidity.

---

## Security Posture

VeilLend currently includes:

* no administrative withdrawal path;
* upgrade authority restricted to the contract owner (UUPS
  `_authorizeUpgrade` is owner-only; no multisig/timelock governance yet —
  tracked as M2 work);
* verifier addresses set once at initialization, changeable only through an
  owner-authorized UUPS upgrade;
* emergency pause without a custody backdoor;
* non-reentrant value-transfer paths;
* paired accounting and token movement;
* range checks on circuit inputs;
* canonical public-signal validation;
* position binding;
* sequence and nullifier replay protection;
* recipient binding;
* supported-collateral enforcement;
* public borrow-outstanding enforcement;
* on-chain LTV caps;
* oracle freshness checks;
* fail-closed handling for unsupported actions.

Internal security reviews identified and addressed several classes of issues, including:

* unsupported commitment extraction;
* fabricated collateral / borrow authorization;
* self-liquidation extraction;
* parameter and oracle range gaps;
* mempool proof theft;
* an inverted borrow action gate in `risk_transition`.

The relevant fixes are covered by adversarial regression tests including:

* `test/supported-collateral.test.ts`
* `test/recipient-binding.test.ts`
* `test/risk-gate.test.ts`

Additional security analysis is documented in `docs/phase3.md`.

---

## Roadmap & Milestones

| Milestone | Objective                       | Primary Outcome                                                                                      | Status                       |
| --------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------- |
| **M1**    | Prove the hard part             | Demonstrate confidential lending state and ZK-enforced lending/liquidation on Horizen Testnet        | **Technically demonstrated** |
| **M2**    | Security & production hardening | Complete external security review and prepare the protocol for production                            | **Planned**                  |
| **M3**    | Mainnet & real usage            | Deploy to Horizen Mainnet, connect to ecosystem liquidity, and demonstrate real lending-market usage | **Planned**                  |

See:

* `docs/roadmap.md`
* `docs/milestones.md`

for the detailed milestone plan and acceptance criteria.

---

## Contact

* Telegram: https://t.me/cr0wel

---

## Project Status

Working testnet prototype for Horizen S2: private position commitments, Groth16 ZK proofs, private solvency, confidential liquidation, replay protection, recipient binding, public accounting safeguards, browser-side proof generation, encrypted private-state recovery prototype, and a working Horizen testnet frontend.

The current release is a **testnet prototype** and has not undergone a production security audit.

The Stork production oracle path is implemented, configured, and deployed on Testnet (WETHUSD/USDCUSD feeds); its live activation plus broader collateral support, utilization-based interest economics, Base-originating ecosystem liquidity, deeper Horizen ecosystem integration, mainnet deployment, and additional security hardening remain future milestone work.

---

## License

Copyright (c) 2026 H-crowe.

- **VeilLend original code** (protocol contracts, project-authored Circom circuits, scripts, tests, documentation, demo) is licensed under the **MIT License** — see [`LICENSE`](LICENSE).
- **`contracts/zk/*` verifiers** are snarkjs-generated build artifacts (from circuits including GPL-3.0 circomlib templates) and retain their **GPL-3.0** SPDX headers.
- **Third-party dependencies** (OpenZeppelin MIT; snarkjs/circomlib/circomlibjs GPL-3.0; others) remain under their own licenses.
