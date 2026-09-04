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

The protocol does not provide an administrative withdrawal backdoor or upgrade key.

Private positions are controlled by their cryptographic control secret, which is bound into the commitment and nullifier construction.

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
outstanding + amount
    ≤
supportedCollateral × maxLtvBps / 10000
```

If this limit is exceeded, the transaction fails with `BorrowCapExceeded`.

This provides defense in depth alongside the private ZK solvency check.

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

The current Horizen testnet deployment uses an owner-managed:

```text
MockPriceOracle
```

It exists for development and E2E demonstration.

The oracle includes:

* price freshness checks;
* price bounds;
* configurable maximum staleness.

The testnet oracle is **not production infrastructure**.

### Production Direction

The planned production integration is the **Horizen Stork oracle** behind the same freshness and price-validation interface.

This allows the privacy and risk architecture to remain separated from the current testnet oracle implementation.

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

## Horizen Testnet Deployment

**Network:** Horizen Testnet
**Chain ID:** `2651420`

### Current Deployment

| Contract                                | Address                                      |
| --------------------------------------- | -------------------------------------------- |
| **VeilLend**                            | `0xeCB439fbE792Bec4E005f1809E6DCF4FB37d4787` |
| **RiskTransitionVerifier**              | `0x65dcBf151d10E63a43b972c41C760E983154Cefb` |
| **Groth16Verifier — State Transitions** | `0x0D96E5a05d11c0839037488332CAd29E6Ef6686C` |
| **SolvencyVerifier**                    | `0xD33ce96e9A6AF2c8f5E7f73d5214eDf0c9eff24F` |
| **LiquidationVerifier**                 | `0x4bf85D6D5f3A730280D707dB0D2d063940A80869` |
| **MockPriceOracle**                     | `0xDA4CAA96D6fF78Af30A3955b5310BE9258d57Bc2` |
| **vCOL**                                | `0x281FbbeD6f2DEA61c86191EA92f2B9B9D2D66a3c` |
| **vDBT**                                | `0xe27c05934Ad4046d72766808b30F0514e978f612` |

**RPC:** `https://horizen-testnet.rpc.caldera.xyz/http`

**Explorer:** `https://explorer-testnet.horizen.io/`

**Hub / Faucet:** `https://hub-testnet.horizen.io/`

The current VeilLend deployment uses the repaired `RiskTransitionVerifier` following a circuit gate correction. The state-transition, solvency, and liquidation verifiers were reused unchanged.

The complete machine-readable deployment record is available in:

[`deployments/horizenTestnet.json`](deployments/horizenTestnet.json)

The file also preserves the superseded first deployment for historical evidence.

---

## Verification Evidence

The current repository contains the following previously completed verification evidence.

### Root Protocol Tests

**120 tests passing**

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
* invariant testing.

### Browser Demo Tests

**13 / 13 passing**

Coverage includes:

* state persistence;
* encrypted private-state recovery prototype;
* signature determinism.

### Horizen Testnet E2E

Real Groth16 proofs have been exercised against the Horizen testnet deployment for:

```text
Create Position
      ↓
Deposit
      ↓
Borrow
      ↓
Repay
      ↓
Withdraw
```

The commitment chain advances on-chain through the lifecycle.

The liquidation path has also been exercised:

```text
Undercollateralize position
      ↓
Generate liquidation proof
      ↓
On-chain verification
      ↓
In-circuit settlement
      ↓
Position closed
```

The recovery prototype has additionally demonstrated:

```text
Encrypted backup
      ↓
Clear local state
      ↓
Recover private state
      ↓
Recompute Poseidon commitment
      ↓
Match on-chain commitment
```

Historical testnet evidence is preserved in:

* [`docs/testnet-proof-evidence.md`](docs/testnet-proof-evidence.md)
* [`docs/testnet-liquidation-evidence.md`](docs/testnet-liquidation-evidence.md)

---

## Browser Demo

The [`demo/`](demo/) directory contains a working Next.js frontend using:

* React / TypeScript;
* wagmi;
* viem;
* browser-side `snarkjs`;
* the deployed Horizen testnet contracts.

There is **no backend involved in the proving path**.

The core demo flow is:

```text
Connect wallet
    ↓
Create position
    ↓
Mint test tokens
    ↓
Deposit collateral
    ↓
Refresh oracle when required
    ↓
Generate browser-side ZK proof
    ↓
Borrow
    ↓
Repay
    ↓
Withdraw
```

The demo also includes:

* confidential liquidation demonstration;
* encrypted private-state recovery prototype;
* signature determinism test.

See [`demo/README.md`](demo/README.md) for the detailed walkthrough.

### Test Assets

`vCOL` is the test collateral token.

`vDBT` is the test debt token.

Both are **test/demo assets only** and are not production assets.

---

## Repository Structure

```text
circuits/
├── veillend_lib.circom          # shared commitment/nullifier/arithmetic logic
├── state_transition.circom      # deposit / repay
├── solvency.circom              # private solvency proof
├── risk_transition.circom       # borrow / withdraw + post-action solvency
└── liquidation.circom           # private liquidation eligibility + settlement

contracts/
├── VeilLend.sol                 # protocol
└── zk/                          # generated Solidity verifiers

scripts/
├── prove.ts                     # proving utilities / local E2E
├── deploy.ts                    # full testnet deployment
├── deploy-riskfix.ts            # repaired deployment
├── e2e-riskfix.ts               # lifecycle E2E
└── proof-test.ts                # on-chain ZK integration test

test/                             # unit, ZK, adversarial, fuzz and invariant tests

demo/                             # Next.js browser application

deployments/                      # deployment records and E2E logs

docs/                             # architecture, privacy, security and evidence

architecture.md                   # design reference
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

### Build the ZK stack

```bash
npm run zk:build
```

This compiles the circuits, generates the proving artifacts, and regenerates the Solidity verifiers.

### Compile contracts

```bash
npm run build
```

### Run tests

```bash
npm test
```

### Run local proof demonstration

```bash
npm run prove
```

### Run the browser demo

```bash
cd demo
npm install
npm run dev
```

Then open:

```text
http://localhost:3000
```

### Testnet operations

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
* Horizen testnet deployment;
* working browser frontend;
* encrypted private-state recovery prototype.

### Future Production Milestones

* external security audit;
* production Stork oracle integration;
* broader collateral support;
* utilization-based interest-rate economics;
* production incentives and reserve mechanics;
* ecosystem liquidity integrations;
* deeper Horizen ecosystem integration;
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

### Immutable Deployment

Verifier addresses are fixed during deployment.

Future circuit changes require a new deployment.

This architecture was already exercised when the repaired risk-transition circuit required a new verifier and VeilLend deployment.

### Testnet Oracle

The current oracle is a mock, owner-managed implementation.

Its administrative staleness configuration does not currently have a technical upper bound.

Production should use a production oracle such as Horizen Stork.

### Private-State Recovery

The recovery mechanism is currently a client-side prototype using encrypted backup material and wallet-derived key material.

It is not an on-chain recovery mechanism and does not grant additional protocol permissions.

Loss of the recovery material currently means the private state cannot be reconstructed through this prototype.

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

`vCOL` and `vDBT` are testnet-only mock assets.

Nothing in the current deployment represents production mainnet liquidity.

---

## Security Posture

VeilLend currently includes:

* no administrative withdrawal path;
* no upgrade key;
* immutable verifier addresses;
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

* [`test/supported-collateral.test.ts`](test/supported-collateral.test.ts)
* [`test/recipient-binding.test.ts`](test/recipient-binding.test.ts)
* [`test/risk-gate.test.ts`](test/risk-gate.test.ts)

Additional security analysis is documented in [`docs/phase3.md`](docs/phase3.md).

---

## License

MIT for the protocol contracts.

The generated `snarkjs` Solidity verifiers retain the licensing indicated in their generated headers.

---

## License

MIT for the protocol contracts and application code.

The snarkjs-generated Solidity verifiers inherit snarkjs licensing (GPL-3.0)
as marked in their headers.
