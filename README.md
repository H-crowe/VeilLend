# VeilLend

> **Confidential borrow-lend protocol on Horizen.**

VeilLend is a privacy-first lending protocol that keeps **collateral, debt, and health state private** while the protocol verifies solvency, state transitions, and liquidation eligibility on-chain. Private state is represented by **Poseidon commitments**; state transitions are authorized with **Groth16 zero-knowledge proofs** generated client-side and verified by Solidity contracts on Horizen.

**Status: working testnet prototype (M1 implemented — see [`docs/MILESTONES.md`](docs/MILESTONES.md)). Testnet/demo only; not audited; not production infrastructure.**

---

## Why VeilLend?

Public DeFi lending exposes the financial state that matters most — collateral, debt, health/risk, and liquidation activity — enabling copy-trading, borrower profiling, liquidation targeting, and financial surveillance.

VeilLend separates **private position state** from the public information required for protocol execution: the chain verifies proofs (knowledge of the private state, control secret, valid transition, sequence/nullifier rules, post-action solvency, liquidation conditions) without receiving collateral, debt, accrued interest, or health factor as plaintext.

### Core Properties

* **Private Collateral / Debt** — amounts live inside the commitment; public accounting tracks custody/limits only. Interest accrues via a public per-asset debt index while the debt amount stays in the private witness.
* **Private Health / Risk State** — verified through ZK proofs, never published.
* **Confidential Liquidation** — eligibility and settlement are derived from private state inside a dedicated circuit.
* **Non-Custodial** — no administrative withdrawal path and no custody backdoor. Owner-only UUPS upgrade authority (no multisig/timelock yet — M2 work).

---

## How It Works

```text
Private Position State
(collateral, debt, index snapshot, control secret, salt)
        ↓
Poseidon Commitment (BN254, versioned)
        ↓
Groth16 ZK Proof — generated in the browser
        ↓
On-chain Solidity verification
        ↓
New commitment / sequence + nullifier consumption
```

* **Deposit / Repay** — `state_transition` (actionIds 1/2): binds the ERC20 amount to the private state update.
* **Borrow / Withdraw** — `risk_transition` (3/4): enforces post-action solvency in zero knowledge — `collateral × collateralPrice × 10000 ≥ debt × debtPrice × maxLtvBps` — with prices from the on-chain oracle (never caller-selected).
* **Interest** — public WAD-scaled, non-decreasing debt index; accrued debt computed in-circuit with exact ceiling arithmetic.
* **Oracle freshness** — stale/missing prices reject risk-sensitive actions on-chain.

### Security Model

| Protection | Mechanism |
|---|---|
| Position binding | proofs commit the position's private state + public `positionId` |
| Recipient binding | payout recipient is a public input derived on-chain from `msg.sender` — mempool-copied proofs cannot redirect value |
| Replay protection | sequence +1 per transition; Poseidon nullifiers consumed only after verification |
| Custody enforcement | `supportedCollateral[positionId]` grows only from real deposits; fabricated private collateral cannot back borrows |
| Borrow cap | value-based, decimal-aware on-chain LTV cap → `BorrowCapExceeded` |
| Withdraw protection | in-circuit hidden-collateral coverage + on-chain accounting |

### Confidential Liquidation

A dedicated circuit proves `collateral × price × 10000 < debt × price × liquidationThresholdBps` over the hidden state and derives settlement in-circuit (`collateralOut` = full hidden collateral; `debtOut` = min(hidden debt, oracle-parity)). Permissionless, oracle-freshness-gated, recipient-bound, replay-proof. **PoC limitation:** residual debt is written off (socialized; no bonus, no reserve accounting).

Full design — exact commitment/nullifier constructions, circuit signals, solvency fixed-point math, oracle trust model: **[`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md)**.

---

## Oracle

Two distinct paths — do not mix:

* **Testnet/Demo (TEMPORARY):** Base Mainnet Chainlink → isolated relay (`relay/base-price-relay.mjs`, server-side owner key, no user price input) → owner-gated `OwnerMockPriceOracle` → VeilLend. **TESTNET/DEMO ONLY** — not production infrastructure, not a Stork replacement.
* **Production (intended):** Stork signed data → permissionless `pushOracleUpdate` → deployed `StorkPriceOracle` adapter (official **WETHUSD**/`0x8afba5f1a5d4969d23c3b42db1b88f8a9c8176392de5bf066752260478ce82b8` and **USDCUSD**/`0x7416a56f222e196d0487dce8a1a8003936862e7a15092a91898d69fa8bce290c` feeds). The adapter is deployed and configured; it becomes the live price path when Stork testnet publishing starts (no subscriber relayer on Horizen testnet yet).

---

## Horizen Testnet Deployment

**Network:** Horizen Testnet · **Chain ID:** `2651420` · **RPC:** `https://horizen-testnet.rpc.caldera.xyz/http` · **Explorer:** `https://explorer-testnet.horizen.io/` · **Faucet:** `https://hub-testnet.horizen.io/`

### Current Deployment (UUPS / ERC-1967) — official

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
| vCOL / vDBT (test mocks) | `0xb5a5b0f1083965B9d92dCd94E5BCdDb868BfcFCE` / `0xe48a8EC02EB14BB52Fe363D3B2A32e264d3B5D7f` |
| WETH / USDC (ecosystem assets) | `0x4200000000000000000000000000000000000006` / `0x01c7AEb2A0428b4159c0E333712f40e127aF639E` |

`ZEN` is locked (no ZEN/USD Stork feed); USDT is not supported.

Machine-readable record: `deployments/horizenTestnet-uups.json`.

### Historical / Superseded

| Deployment | VeilLend address | Record | Status |
| --- | --- | --- | --- |
| First M1 deployment | `0x9fd6477Dd3b5eDB4e55A7D7F962Af0e8e332a9B9` | `deployments/horizenTestnet.json` | Historical — superseded |
| Repaired M1 deployment | `0xeCB439fbE792Bec4E005f1809E6DCF4FB37d4787` | `deployments/horizenTestnet.json` | Historical — superseded |

Both are **immutable, non-proxy deployments** that were never upgraded; the UUPS proxy is a separate, newer deployment. M1-era on-chain proof/liquidation evidence (summarized in [`docs/MILESTONES.md`](docs/MILESTONES.md) §2.2) was recorded against them. The M1-era `MockPriceOracle` (permissionless `setPrice`) is orphaned — the protocol no longer points at it.

---

## Browser Demo

`demo/` is a Next.js frontend (React/TypeScript, wagmi, viem, browser-side `snarkjs`) — **no backend in the proving path** — running against the current UUPS Testnet deployment.

**Run:**

```bash
cd demo
npm install
npm run dev        # http://localhost:3000
npm run build && npm start   # production build (Vercel-compatible)
```

Proving artifacts (`.wasm`/`.zkey`) and the snarkjs browser bundle are included under `demo/public/`.

**Flow:** Connect Wallet (injected; wrong network offers a switch button) → **Create** (collateral/debt pair chosen once, fixed for the position's life; commitment computed locally) → **Deposit** (real `state_transition` proof; custody 1:1) → **Borrow** (`risk_transition` proof, post-borrow solvency, recipient-bound payout from the repayment-funded reserve) → **Repay** → **Withdraw** (proof-gated, custody 1:1). The position card shows only public on-chain data — collateral/debt/health are marked 🔒 private. A progress strip tracks Connect → Create → Deposit → Borrow → Repay → Withdraw.

**Assets:** vCOL/vDBT (demo mocks, active), WETH/USDC (enabled, priced via the demo relay), ZEN locked.

**Price panel:** "Testnet / Demo Price Source — Base Chainlink → Mock Oracle" shows live WETH/USD + USDC/USD and a **Refresh Prices** action (relay-fed, server-side owner signature — users never submit a price). If the relay is offline the panel says so; risk actions need fresh prices.

**Recovery:** every position offers **Download Recovery File** (`VeilLend-Position-N-Recovery.json`, one encrypted file per position); a browser with no local positions offers **Restore from Recovery File** — file → wallet signature → decrypt → verify against the on-chain commitment → restore. `/recovery-test` and `/sigtest` are developer/test pages. Details: [`demo/lib/recovery/README.md`](demo/lib/recovery/README.md).

**Developer tools** (minting, liquidity seeding) are visually separated from the user flow.

---

## Verification Evidence

* **Root protocol suite: 156/156 passing** (`npm test`) — unit, ZK circuit, solvency, risk, supported-collateral, adversarial recipient-binding, liquidation, replay, seeded fuzz/invariant, upgrade, Stork integration, and a local E2E lifecycle over **all six supported asset pairs** with negative cases (unsupported asset, over-borrow, stale oracle, tampered proof, wrong-asset witness, replayed proof, invalid withdrawal, no partial state on failure).
* **Demo suite: 17/17 passing** (`demo/tests/`).
* **On-chain evidence:** real ZK proof transitions and a real confidential liquidation recorded on Testnet — summarized in [`docs/MILESTONES.md`](docs/MILESTONES.md) §2.2 (records in `deployments/*.json`).

---

## Quickstart

Requirements: Node 18+, Circom 2.2.x (`tools/circom.exe` or on `PATH`), Hardhat; funded testnet wallet (`HORIZEN_TESTNET_PRIVATE_KEY` in `.env`, see `.env.example`) for on-chain commands.

```bash
npm install
npm run zk:build   # compile circuits → pot14 → zkeys → Solidity verifiers
npm run build      # compile contracts
npm test           # full protocol suite
npm run prove      # local ZK end-to-end demonstration
```

---

## Honest Scope & Limitations

* **Position/state privacy, not transaction privacy.** The ERC20 layer is public: per-action transfer amounts, timing, and graph are observable. What stays private is the cumulative collateral, debt, accrued interest, and health of each position.
* **Unaudited.** No external security review yet (M2 work).
* **Testnet/demo only.** Nothing here handles real funds; vCOL/vDBT are mocks; the demo price relay is temporary infrastructure.
* **Trusted setup:** PoC single-contributor setup; a production deployment requires a proper ceremony.
* **Interest accrual** is lazy/permissionless; utilization-based rate parameters are stored but not active.
* **Liquidation bad debt** is socialized (no bonus/reserve accounting).
* **Recovery limitations:** client-side only; requires deterministic wallet signatures (software wallets work, hardware wallets typically cannot restore); grants no on-chain permissions; loss of the recovery file or the private witness means loss of position access.
* **Governance:** owner-only UUPS upgrades; multisig/timelock production governance is open M2 work.

Security posture details and the internal-review fixes (F1–F5): see [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) §11–13 and the regression suites (`test/supported-collateral.test.ts`, `test/recipient-binding.test.ts`, `test/risk-gate.test.ts`).

---

## Milestones

| Milestone | Objective | Status |
| --------- | --------- | ------ |
| **M1** | Prove the hard part — everything implemented & tested today | **Implemented / demonstrated** |
| **M2** | Security & production hardening (external audit, threat model, on-chain recovery) | **Planned — not complete** |
| **M3** | Mainnet, ecosystem liquidity & real usage | **Planned** |

Details and acceptance criteria: **[`docs/MILESTONES.md`](docs/MILESTONES.md)**.

**Base & ecosystem liquidity:** VeilLend will use existing Base ↔ Horizen bridging/ecosystem infrastructure rather than building a bridge. Base-originating assets (WETH, USDC) are already enabled on Testnet; their production liquidity access remains future ecosystem work.

---

## Contact

* Telegram: https://t.me/cr0wel

## Project Status

Working testnet prototype for Horizen S2: private position commitments, Groth16 ZK proofs, private solvency, confidential liquidation, replay protection, recipient binding, public accounting safeguards, browser-side proving, encrypted private-state recovery, and a working Horizen Testnet frontend. The release is a **testnet prototype**, unaudited. The Stork production oracle path is implemented and deployed (activation pending); mainnet, real liquidity, and additional hardening remain future milestone work (M2/M3).

---

## License

Copyright (c) 2026 H-crowe.

* **VeilLend original code** (protocol contracts, project-authored Circom circuits, scripts, tests, documentation, demo) is licensed under the **MIT License** — see [`LICENSE`](LICENSE).
* **`contracts/zk/*` verifiers** are snarkjs-generated build artifacts (from circuits including GPL-3.0 circomlib templates) and retain their **GPL-3.0** SPDX headers.
* **Third-party dependencies** (OpenZeppelin MIT; snarkjs/circomlib/circomlibjs GPL-3.0; others) remain under their own licenses.
