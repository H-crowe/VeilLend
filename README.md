# VeilLend

> **Confidential borrow-lend protocol on Horizen.**

VeilLend is a privacy-first lending protocol that keeps **collateral, debt, and position health private** while verifying state transitions, solvency, and liquidation eligibility on-chain.

Private position state is represented by **Poseidon commitments** and updated with **Groth16 zero-knowledge proofs** generated client-side and verified by Solidity contracts on Horizen.

**Status:** Working Horizen Testnet prototype · testnet/demo only · unaudited · not production infrastructure.

Current deployment and roadmap: [`docs/MILESTONES.md`](docs/MILESTONES.md)

---

## Why VeilLend?

Traditional DeFi lending exposes collateral, debt, health factors, and liquidation activity publicly.

VeilLend separates the **private state of a lending position** from the public data required for protocol execution. The chain verifies that a user knows a valid private state and that an operation satisfies the protocol rules without publishing the underlying collateral or debt amounts.

### Core Properties

* **Private collateral and debt** — position amounts remain inside the private state commitment.
* **Private position health** — solvency is verified with zero-knowledge proofs.
* **Confidential liquidation** — liquidation eligibility is proven from private position state.
* **Proof-bound actions** — deposits, repayments, borrowing, and withdrawals require valid state transitions.
* **Replay protection** — sequence numbers and Poseidon nullifiers prevent proof reuse.
* **Recipient binding** — proof-bound payouts cannot be redirected by copying a transaction.
* **Custody enforcement** — private collateral claims are backed by real on-chain custody.
* **Liquidity pools** — each supported debt asset has its own lender pool.

---

## How It Works

```text
Private Position State
(collateral, debt, index snapshot, control secret, salt)
                ↓
        Poseidon Commitment
                ↓
       Groth16 ZK Proof
       generated client-side
                ↓
      Solidity verification
                ↓
     New commitment + sequence
```

### Position Actions

* **Deposit / Repay** — `state_transition` proofs update the private position state.
* **Borrow / Withdraw** — `risk_transition` proofs enforce post-action solvency.
* **Interest** — debt uses a public per-asset interest index while the debt amount remains private.
* **Liquidation** — a dedicated circuit proves that a hidden position is below its liquidation threshold and derives the settlement amounts.

Risk-sensitive operations require a fresh oracle price and fail closed when oracle data is stale or unavailable.

---

## Confidential Liquidation

Liquidation eligibility is proven against the private position state:

```text
collateral value < debt value × liquidation threshold
```

The circuit derives the settlement amounts without exposing the position's collateral or debt.

Liquidation is permissionless, proof-bound, recipient-bound, and protected against replay.

**Current limitation:** residual bad debt is written off and socialized across lender shares. There is currently no liquidation bonus or reserve system.

---

## Oracle

VeilLend currently has two separate oracle paths:

### Testnet / Demo

Base Chainlink ETH/USD data is relayed through:

```text
Base Chainlink
      ↓
isolated relay
      ↓
OwnerMockPriceOracle
      ↓
VeilLend
```

This path is **testnet/demo infrastructure only**.

### Production Path

The production architecture uses **Stork signed price data** through the deployed `StorkPriceOracle` adapter and permissionless `pushOracleUpdate`.

The adapter is deployed and configured on Testnet; production activation depends on Stork publishing the required feeds on the target network.

---

## Liquidity Pools

Each supported debt asset has an independent UUPS `LiquidityPool`.

* Lenders deposit assets and receive pool shares.
* Borrowers draw liquidity through VeilLend.
* Repayments return principal and realized interest to the pool.
* Protocol fees apply only to realized interest.
* Bad debt from liquidation is written off against pool borrows.
* Pool accounting is isolated per debt asset.

Current pools:

* **vDBT**
* **USDC**

ZEN is currently locked/unavailable in the demo.

---

## Horizen Testnet

**Chain ID:** `2651420`

**RPC:** `https://horizen-testnet.rpc.caldera.xyz/http`

**Explorer:** `https://explorer-testnet.horizen.io/`

### Current Deployment

| Contract                     | Address                                      |
| ---------------------------- | -------------------------------------------- |
| VeilLend UUPS Proxy          | `0xc1e2cDADBf14717DfEE7ffA23EAf2b21e6004a5B` |
| VeilLend Implementation      | `0xfb8a61658110e47a1f79c0632061e97bc37b2c3d` |
| vDBT LiquidityPool           | `0x21Cf3FFE0FF3ccf422c89A0A55fCE1949C84fB57` |
| USDC LiquidityPool           | `0xf406448E519345C9D8bc08B606DaB677Cb12aCC1` |
| LiquidityPool Implementation | `0x3c081adab71c5237ac3b21590dbbc60b26b5967d` |
| StorkPriceOracle Adapter     | `0xa2c0a60B4A360e88cA5f90860A3B75A3DDfED33D` |
| OwnerMockPriceOracle         | `0x024CF745c737B74f8BCc84d1C73687853310b715` |
| State Transition Verifier    | `0xbdF87292EAAd22dB17C5ADCA3eAC33Db891ab3f1` |
| Solvency Verifier            | `0x18C104Dc76A6F4Dad6cC1f2E467D9EbC10162676` |
| Risk Transition Verifier     | `0xB54B51664215ED17F238D52EDD8d5E549D136b26` |
| Liquidation Verifier         | `0xe33b96CC86D3c68119312b9B2274F1e734211daa` |
| USDC                         | `0x01c7AEb2A0428b4159c0E333712f40e127aF639E` |

---

## Demo

The frontend supports the full private-position lifecycle:

```text
Connect → Create → Deposit → Borrow → Repay → Withdraw
```

The demo:

* generates ZK proofs in the browser;
* keeps collateral, debt, and health private;
* displays only public on-chain position data;
* provides encrypted recovery files for private position state;
* includes a lender-side liquidity pool interface.

### Run locally

```bash
cd demo
npm install
npm run dev
```

Production build:

```bash
npm run build
npm start
```

---

## Verification

The repository currently includes:

* **208/208 protocol tests passing**
* **23/23 demo tests passing**
* ZK circuit tests
* solvency and risk tests
* liquidation tests
* replay and nullifier protection
* recipient-binding tests
* custody and accounting tests
* liquidity-pool economics
* UUPS upgrade and storage-layout validation
* Stork integration tests
* end-to-end lifecycle tests
* seeded fuzz/invariant tests

CI builds the ZK artifacts on Linux and runs the complete test suite successfully.

---

## Quickstart

Requirements:

* Node.js
* Circom
* Hardhat
* funded Horizen Testnet wallet for on-chain operations

```bash
npm install

npm run zk:build
npm run build
npm test
npm run prove
```

See `.env.example` for required environment variables.

---

## Recovery

Each position can export an encrypted recovery file containing its private state.

Recovery verifies the restored state against the on-chain commitment before restoring the position locally.

Recovery is **client-side only**. Losing both the recovery file and the private witness results in loss of access to the position.

---

## Limitations

VeilLend is currently a **testnet prototype**.

* **Unaudited** — no external security audit has been completed.
* **Not transaction-private** — ERC20 transfers, timing, and transaction relationships remain public.
* **Test assets** — vCOL and vDBT are test mocks.
* **Temporary oracle infrastructure** — the demo relay is not production infrastructure.
* **Trusted setup** — current ZK artifacts use a PoC single-contributor setup.
* **Bad debt** — liquidation shortfalls are socialized across lender shares.
* **Interest model** — interest accrual is currently lazy and permissionless.
* **Governance** — UUPS upgrades are owner-controlled; production multisig/timelock governance is still required.
* **Recovery** — private-state recovery remains client-side.

---

## Roadmap

### Production Hardening

* External security audit
* Formal threat model
* ZK trusted-setup ceremony
* Production recovery improvements
* Stronger upgrade governance

### Mainnet Readiness

* Production oracle activation
* Mainnet deployment
* Production asset configuration
* Real lender/borrower liquidity
* Monitoring and operational tooling

### Ecosystem Expansion

* Additional supported assets
* Additional Horizen ecosystem integrations
* Expanded liquidity sources and market infrastructure

---

## License

Copyright (c) 2026 H-crowe.

VeilLend original code is licensed under the **MIT License** — see [`LICENSE`](LICENSE).

Generated ZK verifier artifacts under `contracts/zk/` retain their applicable GPL-3.0 headers.

Third-party dependencies remain under their respective licenses.
