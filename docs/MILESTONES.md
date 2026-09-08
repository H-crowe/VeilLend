# VeilLend — Milestones & Acceptance Criteria

> This document is the single source of truth for milestone status.
>
> **M1 = everything currently implemented and tested** (the technical
> objective plus all supporting implementation work present in the
> repository). **M2 = Security & Production Hardening** and **M3 = Mainnet,
> Liquidity & Real Usage** — their objectives, requirements, and status are
> unchanged; both remain planned/not complete as documented below.
>
> A milestone is complete only when its acceptance criteria and supporting
> evidence are satisfied. Planned work must not be presented as implemented.

---

# 1. Milestone Overview

| Milestone | Objective | Primary Outcome | Status |
| --------- | --------- | --------------- | ------ |
| M1 | Prove the hard part | Confidential lending state and ZK-enforced lending/liquidation demonstrated on Horizen Testnet — **including all implementation and supporting work currently in the repository** | **Implemented, tested, demonstrated** |
| M2 | Security & production hardening | Complete external security review and prepare the protocol for production | **Planned — in progress, not complete** |
| M3 | Mainnet & real usage | Deploy to Horizen Mainnet, connect to ecosystem liquidity, demonstrate real lending-market usage | **Planned** |

---

# 2. M1 — Prove the Hard Part (current implemented state)

## Objective

> Private lending state can be represented through cryptographic commitments
> and manipulated through zero-knowledge proofs while the meaningful
> collateral, debt, and solvency state remains hidden from the public chain —
> demonstrated end-to-end on Horizen Testnet with real Groth16 proofs and real
> on-chain verification.

Everything below is **implemented and tested in the current repository**
(evidence pointers given). Design details: [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).

## 2.1 Implemented

### Privacy mechanism
- Private position state (collateral, debt, interest snapshot, control secret,
  salt) bound into versioned, domain-separated **Poseidon commitments**
  (`circuits/veillend_lib.circom`, `state_transition.circom`).
- Control via secret knowledge only — no plaintext owner on-chain.
- Commitment rotation after every valid transition.

### ZK state transitions (Groth16, BN254, snarkjs)
- Deposit (actionId 1) / Repay (2) — `state_transition.circom`.
- Borrow (3) / Withdraw (4) — `risk_transition.circom` with **post-action
  solvency enforced in-circuit** (unsafe transitions are unprovable).
- Nullifier + sequence replay protection; nullifiers consumed only after
  verification.
- Recipient binding: outbound payouts commit the recipient as a public input
  derived on-chain from `msg.sender` (mempool proof theft mitigated).
- Four snarkjs-generated immutable Solidity verifiers (`contracts/zk/`).

### Public accounting & risk enforcement
- Custody conservation invariants (`collateralCustody`/`debtCustody`),
  `supportedCollateral` and `borrowOutstanding` ledgers, on-chain value-based
  decimal-aware borrow cap (`BorrowCapExceeded`).
- Oracle freshness + price bounds fail closed (`getFreshPrice`).
- Public WAD-scaled debt-index interest mechanics (utilization parameters
  stored but not active).

### Confidential liquidation
- Eligibility proven over hidden state (`liquidation.circom`); settlement
  amounts computed in-circuit; **real liquidation executed and verified on
  Testnet**; replay-proof via position closure.

### Contract architecture (hardening present in the current deployment)
- **UUPS/ERC-1967 upgradeable** with owner-only `_authorizeUpgrade`
  (`test/upgrade.test.ts`).
- Emergency pause (`PausableUpgradeable`) without custody backdoor;
  two-step ownership (`Ownable2StepUpgradeable`).
- Stork oracle integration behind `IPriceOracle`: `StorkPriceOracle` adapter
  deployed and wired to the real Stork push oracle with official
  WETHUSD/USDCUSD feeds and permissionless same-transaction
  `pushOracleUpdate` (`test/stork-integration.test.ts`); **live activation
  awaits Stork testnet publishing**.
- Decimal-aware, value-based borrow cap and 18-dec normalized price
  convention (`test/decimal-cap.test.ts`).
- Internal-review hardening fixes F1–F5 (unsupported-commitment extraction,
  fabricated collateral/borrow authorization, parameter/oracle bounds,
  mempool proof-theft mitigation) — `test/supported-collateral.test.ts`,
  `test/risk-gate.test.ts`, `test/recipient-binding.test.ts` (adversarial A–I).

### Testing
- **Root suite: 156/156 passing** (`npm test`, re-verified 2026-09): unit,
  circuit-level, solvency, risk, liquidation, supported-collateral,
  recipient-binding adversarial, seeded fuzz/invariant harness, upgrade,
  Stork integration, and a local E2E lifecycle suite covering **all six
  supported asset pairs** plus negative/security cases
  (`test/e2e-lifecycle.test.ts`).
- **Demo suite: 17/17 passing** (`demo/`: persistence, recovery,
  signature-determinism).
- Clean Solidity build; TypeScript clean; production build clean.

### Demo application
- Browser-only proving path (React/TypeScript/wagmi/viem/snarkjs — no backend
  in proving): guided flow Connect → Create → Deposit → Borrow → Repay →
  Withdraw, every action a real ZK proof; asset registry; Testnet/Demo price
  panel; confidential liquidation demonstration; developer tools separated.
- **Encrypted private-state recovery integrated into the main demo**: per-
  position **Download Recovery File** (`VeilLend-Position-N-Recovery.json`)
  and **Restore from Recovery File** — wallet-signature-derived key
  (domain-separated EIP-191 challenge → HKDF → AES-256-GCM), decrypted state
  verified against the current on-chain commitment before anything is
  restored (`demo/lib/recovery/`, `demo/tests/` 17/17). `/recovery-test` and
  `/sigtest` remain as developer/test pages.
- Fail-closed receipt guard: a mined-but-reverted transaction never advances
  local private state (`demo/lib/tx/receipt.ts`).

### Testnet deployments
- **Current (official): UUPS/ERC-1967 deployment** — proxy
  `0xc1e2cDADBf14717DfEE7ffA23EAf2b21e6004a5B` (implementation
  `0x353EcfaFa07a60f1Ed473ed4cE3F1c2624fF7aa5`),
  4 verifiers, Stork adapter configured (WETHUSD/USDCUSD), WETH/USDC + vCOL/
  vDBT enabled. Record: `deployments/horizenTestnet-uups.json`.
- A **real WETH/USDC lifecycle** (create → deposit → borrow → repay → withdraw,
  real ZK proofs, relay-fed live prices) executed on-chain against the UUPS
  deployment: `deployments/demo-e2e-uups.json` (`allPass: true`).
- Testnet/Demo pricing temporarily flows through the isolated
  Base-Chainlink relay → owner-gated `OwnerMockPriceOracle` (TESTNET/DEMO
  ONLY; production path is Stork). See ARCHITECTURE §10.2.

## 2.2 Evidence index

| Evidence | Location |
| --- | --- |
| Current UUPS deployment record (addresses, config, verification) | `deployments/horizenTestnet-uups.json` |
| On-chain lifecycle against the UUPS deployment (real WETH/USDC) | `deployments/demo-e2e-uups.json` |
| Historical M1 deployment record | `deployments/horizenTestnet.json` |
| Historical M1 proof-chain evidence (deposit/withdraw) | `deployments/onchain-proof-test.json` |
| Historical M1 lifecycle E2E (Position #32) | `deployments/e2e-lifecycle-test.json` |
| Historical M1 confidential liquidation | `deployments/testnet-liquidation-proof-test.json` |
| Root test suite (156) / demo suite (17) | `test/`, `demo/tests/` |
| Circuits / contracts / scripts | `circuits/`, `contracts/`, `scripts/` |

### Historical on-chain evidence (superseded deployments — condensed)

> The two M1-era records below were recorded against **superseded, immutable
> non-proxy deployments**. They remain valid proof that the mechanism worked
> on-chain; they are **not** the current deployment. Full per-step tx/block/gas
> lists live in the evidence JSONs — not repeated here.

**Historical deployment addresses:**

| Contract | First M1 deployment | Repaired M1 deployment |
|---|---|---|
| VeilLend | `0x9fd6477Dd3b5eDB4e55A7D7F962Af0e8e332a9B9` | `0xeCB439fbE792Bec4E005f1809E6DCF4FB37d4787` |
| Groth16Verifier (state transitions) | `0x0D96E5a05d11c0839037488332CAd29E6Ef6686C` | `0x0D96E5a05d11c0839037488332CAd29E6Ef6686C` |
| SolvencyVerifier | `0xD33ce96e9A6AF2c8f5E7f73d5214eDf0c9eff24F` | `0xD33ce96e9A6AF2c8f5E7f73d5214eDf0c9eff24F` |
| RiskTransitionVerifier | `0x533Fd1381b7a3aAc107c07983bf82f6681D98b4a` | `0x65dcBf151d10E63a43b972c41C760E983154Cefb` (repaired action gate) |
| LiquidationVerifier | `0x4bf85D6D5f3A730280D707dB0D2d063940A80869` | `0x4bf85D6D5f3A730280D707dB0D2d063940A80869` |
| MockPriceOracle (test-only, now orphaned) | `0xDA4CAA96D6fF78Af30A3955b5310BE9258d57Bc2` | same |
| vCOL / vDBT (test mocks) | `0x281FbbeD6f2DEA61c86191EA92f2B9B9D2D66a3c` / `0xe27c05934Ad4046d72766808b30F0514e978f612` | same |

Deployer/test wallet A (owner): `0x1725a9Ba5E788Ac73AE7f14a2C976DB462c5F204` ·
Wallet B (liquidator): `0x1202bBE2e0eEAE5aC3C905Cf451e7107e6c11a30`.

**Proof chain (Position #2, first M1 deployment):**

| Step | Tx hash | Block | Gas |
|---|---|---|---|
| `createPosition` (stores C0) | `0x17796ffbd9671b027e98b8295b8d8f6fe3dee7b0e1ef4be8803358b21ae3acbc` | 26,721,799 | 148,938 |
| `deposit` — real ZK proof verified on-chain | `0x5e50000ad35435fe947d94e5d56272b0dfbbbb2fc2789a24454a9186df57d4c8` | 26,721,810 | 410,361 |
| `withdrawCollateral` — real ZK proof, recipient-bound | `0xc0a429d678c8e53520ef9f9141195aee407dd31bbd6720b0a21943d5e921e4b8` | 26,721,815 | 387,547 |

Commitment chain (public by design):
`C0 = 9498478820913575246157620662779099336911672124961233694062922867225704157547`
→ `C1 = 8932868119535140476080033462695729124242989530078434323614105386508226739808`
→ `C2 = 19777129796821667301691296523388428648547402301289360294863945356651295504709`.
Sequences 0→1→2, both nullifiers consumed, custody conserved 100e18 in/out.
`deployments/onchain-proof-test.json`.

**Confidential liquidation (first M1 deployment):** deposit 100 vCOL → seed 50
vDBT → borrow 10 vDBT (recipient-bound) → price drop (vCOL $2.00 → $0.05) →
liquidation proof verified on-chain. Two successful liquidations were recorded:
Position #22 (tx
`0x8b6cc153be3061976b0a9b4a892371efbd019f85c4c305642c312cc50ad893b1`, block
26,775,051) and the final fully-verified run — **Position #24, tx
`0xbfd6ffe40d7e4d987a9d93d2c8c0a69eea639abc0a654210c3a0da4cc17fc43f`** (block
26,775,401, gas 355,932). Settlement (Position #24): 100 vCOL seized, 5 vDBT
parity payment, 5 vDBT socialized bad debt, position Closed, replay attempt
reverted. `deployments/testnet-liquidation-proof-test.json`.

**Current-deployment lifecycle (UUPS, Position #9):** real WETH/USDC prices via
the relay (price-refresh tx
`0xaf61551517f341685413a0fbeb4cdd9a8e8553ff882dcdf7c000cce0f8b8e8bc`), full
create → deposit → borrow → repay → withdraw with per-step state checks —
`deployments/demo-e2e-uups.json`.

## 2.3 M1 Acceptance Criteria

* [x] Private position state is represented through cryptographic commitments.
* [x] Poseidon commitments are used for private state binding.
* [x] Valid state transitions require valid ZK proofs.
* [x] Invalid state transitions are rejected.
* [x] Private collateral is not stored directly as public position state.
* [x] Private debt is not stored directly as public position state.
* [x] Solvency/risk conditions are enforced through the proof system.
* [x] Borrowing is proof-enforced.
* [x] Withdrawal is proof-enforced.
* [x] Replay protection is implemented.
* [x] Recipient binding is implemented for relevant payouts.
* [x] Confidential liquidation is demonstrated.
* [x] Liquidation eligibility is proven over hidden state.
* [x] Liquidation has been executed and verified on Horizen Testnet.
* [x] Public custody/accounting constraints remain enforceable.
* [x] The implementation is reproducible from the repository.

### M1 Status

**IMPLEMENTED — TECHNICAL OBJECTIVE DEMONSTRATED (current repository state).**

M1 does **not** imply: production readiness, external security audit, mainnet
deployment, production oracle infrastructure, production trusted setup, real
economic liquidity, or full transaction-level privacy.

Reproduction:

```bash
npm install
npm run zk:build   # circuits → pot14 → zkeys → Solidity verifiers
npm run build && npm test        # 156/156
cd demo && npm test              # 17/17
npm run prove                    # local ZK end-to-end
# Testnet scripts (require funded HORIZEN_TESTNET_PRIVATE_KEY):
npx hardhat run scripts/verify-network.ts    --network horizenTestnet
npx hardhat run scripts/proof-test.ts        --network horizenTestnet
npx hardhat run scripts/liquidation-test.ts  --network horizenTestnet
```

## 2.4 Known limitations (honest)

- **No external audit**; circuits unaudited.
- **PoC single-contribution trusted setup** (pot14) — a real ceremony is
  required before any mainnet-style deployment.
- **Position/state privacy, not transaction privacy** — per-action ERC20
  amounts, timing, and graph are public.
- Single-oracle trust model; admin-set risk parameters; admin is a single
  owner (no multisig/timelock yet — M2 work).
- No liquidation bonus; residual debt socialized with no reserve accounting.
- Witness-holder-only proof generation (no decentralized liquidation yet).
- No borrowable supply side beyond repayments; `closePosition` fail-closed
  (unimplemented).
- Testnet only; vCOL/vDBT are mocks; demo price path is TESTNET/DEMO ONLY.
- Recovery: client-side only, requires deterministic wallet signatures
  (hardware wallets cannot restore), grants no on-chain permissions; loss of
  the recovery material/witness means loss of position access.

---

# 3. M2 — Security & Production Hardening

## Objective

Transform the M1 technical demonstration into an implementation that has undergone rigorous security review and is suitable for production deployment.

M2 is intentionally separate from M1: successful technical demonstration does not constitute a security audit.

### M2 status (in progress — not complete)

Work already done toward M2 (implemented and tested locally):

* UUPS upgradeable architecture (ERC-1967 proxy, owner-only `_authorizeUpgrade`, upgrade safety tests);
* emergency pause on-chain (`PausableUpgradeable`) and two-step ownership (`Ownable2StepUpgradeable`);
* real Stork oracle integration behind the `IPriceOracle` boundary (adapter + same-tx signed-snapshot flow), pending deployment;
* decimal-aware, value-based borrow cap and 18-dec normalized price convention;
* earlier hardening fixes F1–F5 (unsupported-commitment extraction, parameter/oracle bounds, mempool proof-theft mitigation via recipient binding, decimal-aware cap);
* existing fuzz and invariant test suites;
* local E2E lifecycle suite covering all six supported asset pairs plus negative/security cases (`test/e2e-lifecycle.test.ts`, 14/14 passing; full suite 156/156);
* the Testnet deployment carrying the UUPS + Stork changes **is done**: the current official Testnet deployment is the UUPS/ERC-1967 proxy `0xc1e2cDADBf14717DfEE7ffA23EAf2b21e6004a5B` (implementation `0x353EcfaFa07a60f1Ed473ed4cE3F1c2624fF7aa5`), with the Stork adapter deployed and configured (WETH → WETHUSD, USDC → USDCUSD). Testnet price data currently flows through the temporary Base-Chainlink demo relay into an owner-gated oracle until Stork testnet publishing starts; a full real WETH/USDC lifecycle has been executed on-chain.

Still outstanding for M2:

* external security audit;
* finalized comprehensive threat model;
* on-chain recovery/escape mechanism (recovery remains a client-side prototype);
* expanded fuzz and invariant testing;
* deeper access-control/administration hardening review;

---

## 3.1 M2 Deliverables

### A. Smart Contract Security

Review and harden:

* Access control
* Administrative permissions
* Emergency pause mechanisms
* Recovery mechanisms
* Custody accounting
* Borrow accounting
* LTV enforcement
* Oracle integration
* Configuration validation
* Upgradeability/immutability assumptions
* Token interaction safety
* Reentrancy and state-ordering risks

### B. ZK Circuit Security

Review:

* Circuit constraints
* Public inputs
* Private witnesses
* Commitment construction
* Nullifier construction
* Sequence handling
* Range constraints
* Arithmetic safety
* State-transition correctness
* Solvency constraints
* Liquidation constraints
* Recipient binding
* Replay protection

### C. Threat Model

Finalize a comprehensive threat model covering:

* Borrowers
* Lenders
* Liquidators
* Proof generators
* Malicious transaction submitters
* Front-running
* Proof replay
* Commitment substitution
* Oracle manipulation
* Administrative compromise
* Trusted-setup compromise
* Privacy leakage
* Economic attacks
* Bad debt
* Denial-of-service scenarios

### D. Testing

Expand:

* Unit tests
* Integration tests
* Circuit tests
* Fuzz testing
* Invariant testing
* Adversarial testing
* Liquidation edge cases
* Oracle failure scenarios
* Accounting consistency tests
* Recovery-path tests
* Emergency-path tests

### E. External Security Audit

Complete an independent security audit covering, as appropriate:

* Solidity contracts
* ZK circuits
* Protocol architecture
* Cryptographic assumptions
* Trusted setup
* Access control
* Economic/security assumptions

The auditor should be acceptable to the Horizen Foundation where required by the funding agreement.

---

## 3.2 M2 Evidence

Required evidence should include:

* Final threat model
* Security architecture documentation
* Expanded automated test results
* Fuzz/invariant results
* External audit report
* Finding/remediation report
* Regression tests covering resolved findings
* Final deployment configuration
* Updated security limitations

---

## 3.3 M2 Acceptance Criteria

M2 is accepted when:

* [ ] External security audit is completed.
* [ ] Critical/high-risk findings are resolved or formally accepted.
* [ ] Remediated code has passed regression testing.
* [ ] ZK circuits have been reviewed.
* [ ] Protocol threat model is finalized.
* [ ] Access-control model is reviewed.
* [ ] Emergency mechanisms are tested.
* [ ] Recovery mechanisms are tested.
* [ ] Production deployment configuration is documented.
* [ ] Known security assumptions are explicitly documented.

### M2 Status

**PLANNED — NOT COMPLETE**

Internal security reviews and automated testing do not replace an independent external audit.

---

# 4. M3 — Mainnet, Ecosystem Liquidity & Real Usage

## Objective

Deploy VeilLend to Horizen Mainnet and demonstrate that the protocol can operate as a real lending market while connecting to the broader Horizen and Base liquidity ecosystem.

Horizen's Season 2 framework emphasizes demonstrated mainnet usage and in-market metrics such as users, transaction volume, TVL, and utilization.

---

## 4.1 M3 Deliverables

### A. Production Infrastructure

* Production deployment configuration
* Production ZK verification infrastructure
* Production oracle infrastructure
* Monitoring
* Alerting
* Operational procedures
* Emergency procedures
* Recovery procedures
* Production frontend
* Deployment documentation

### B. Mainnet Deployment

Deploy:

* VeilLend protocol contracts
* ZK verification contracts
* Supported collateral configuration
* Production oracle configuration
* Required protocol parameters

### C. Initial Liquidity

Establish initial production liquidity for:

* Supported collateral assets
* Borrowable assets

Liquidity deployment should be sufficient to demonstrate meaningful protocol functionality without representing artificial or unsustainable usage.

### D. Base & Ecosystem Liquidity Integration

VeilLend will connect to liquidity originating from the broader Base ecosystem through **existing Base ↔ Horizen bridging and ecosystem infrastructure**.

VeilLend will not build a separate bridge. The protocol will remain focused on its lending functionality on Horizen while using existing infrastructure to make supported Base-originating assets available to Horizen lending markets.

Planned work includes:

* Integrate supported Base-originating assets into Horizen lending flows
* Connect VeilLend to relevant Horizen ecosystem liquidity
* Enable capital originating on Base to access supported VeilLend markets on Horizen
* Support composable lending flows with ecosystem applications
* Explore integrations with privacy-focused DeFi applications
* Evaluate additional liquidity and interoperability integrations as the ecosystem develops

Base connectivity is therefore an ecosystem and liquidity expansion path rather than a dependency for the core confidential lending mechanism.

### E. Real Lending Activity

Enable:

* Real deposits
* Real borrowing
* Real repayments
* Real withdrawals
* Real liquidations

### F. Production Liquidation

Demonstrate that liquidation continues to work under real market conditions while preserving the protocol's privacy properties.

### G. Usage Measurement

Track:

* Total collateral deposited
* Total outstanding borrows
* Utilization rate
* Unique borrowers
* Unique lenders
* Active positions
* Transaction volume
* Liquidations
* Liquidations executed without unnecessary privacy leakage
* Interest revenue
* Protocol liquidity

These metrics correspond closely to the guidepost metrics identified by the Horizen private borrow-lend RFP.

---

## 4.2 M3 Evidence

Evidence should include:

* Mainnet contract addresses
* Deployment transactions
* Production configuration
* Mainnet activity
* Real user interactions
* Liquidity records
* Borrow/repay activity
* Liquidation records
* Usage metrics
* Privacy-preservation evidence
* Protocol accounting reconciliation
* Operational monitoring evidence
* Evidence of Base-originating liquidity access where applicable
* Relevant ecosystem integration records

---

## 4.3 M3 Acceptance Criteria

M3 is accepted when:

* [ ] VeilLend is deployed on Horizen Mainnet.
* [ ] Production ZK verification infrastructure is operational.
* [ ] Production oracle infrastructure is operational.
* [ ] Real liquidity is available.
* [ ] Real users interact with the protocol.
* [ ] Real borrowing and lending activity is demonstrated.
* [ ] Repayment and withdrawal operate correctly.
* [ ] Liquidation operates correctly.
* [ ] Protocol accounting remains consistent.
* [ ] Privacy properties remain intact during production operation.
* [ ] Meaningful usage metrics are recorded.
* [ ] Results can be independently verified from on-chain data where appropriate.
* [ ] Base-originating liquidity can access supported VeilLend markets through existing ecosystem infrastructure where applicable.

### M3 Status

**PLANNED — NOT COMPLETE**

All currently recorded deployment evidence is Testnet evidence unless explicitly stated otherwise.

---

# 5. Cross-Milestone Security Requirements

Security is not limited to M2. The following must remain enforced throughout:

### Privacy
* Private position state remains hidden.
* Public inputs are minimized.
* Proof outputs reveal only information required for protocol execution.
* Known metadata leakage is documented.

### State Integrity
* Every state transition references a valid prior state.
* Commitments cannot be substituted.
* Nullifiers cannot be reused.
* Sequences cannot be replayed.

### Financial Integrity
* Protocol custody reconciles with supported assets.
* Borrow limits remain enforceable.
* LTV constraints cannot be bypassed.
* Unsupported collateral cannot create borrowing power.
* Oracle values are validated before risk-sensitive operations.

### Authorization
* Proofs cannot be redirected to unauthorized recipients.
* Administrative privileges remain minimal.
* Recovery mechanisms cannot arbitrarily seize user funds.

### Liquidation
* Only eligible positions can be liquidated.
* Liquidation cannot be replayed.
* Settlement follows protocol rules.
* Hidden position state is not unnecessarily disclosed.

---

# 6. Definition of Done

A milestone is considered **Done** only when:

1. The implementation exists in the repository.
2. The implementation is tested.
3. The relevant behavior is reproducible.
4. Evidence is recorded.
5. Security assumptions are documented.
6. Known limitations are documented.
7. The acceptance criteria for the milestone are satisfied.

A feature that exists only in a plan or application is **Planned**, not **Implemented**.

---

# 7. Status Language

* **Implemented** — the functionality exists in the repository.
* **Tested** — automated or documented tests demonstrate the behavior.
* **Demonstrated** — demonstrated through a reproducible end-to-end workflow.
* **Testnet-Validated** — exercised successfully on Horizen Testnet with recorded evidence.
* **Audited** — undergone an independent external security audit.
* **Production-Ready** — security, operational, deployment, and testing requirements completed.
* **Mainnet-Validated** — successfully exercised on Horizen Mainnet.
* **Planned** — part of the development plan, not yet completed.

---

# 8. Current Project Position

```text
M1 — Prove the Hard Part        → IMPLEMENTED / TECHNICAL OBJECTIVE DEMONSTRATED
M2 — Security & Production Hardening → PLANNED (in progress, not complete)
M3 — Mainnet, Liquidity & Real Usage → PLANNED
```

The next major engineering objective is **M2: security hardening and
independent review**. VeilLend maps to the Horizen S2 Builder Ecosystem Fund
progression (M1 prove the hard privacy capability → M2 audit/hardening → M3
real mainnet usage), aligned with the private borrow-lend RFP requirements
(confidential collateral/debt/health, provable solvency, reliable interest,
liquidation without exposing borrowers).

---

# 9. Milestone Dependencies

```text
M1
│
├── Private State Model
├── ZK State Transitions
├── Solvency
├── Confidential Liquidation
└── Testnet Evidence
        │
        ▼
M2
│
├── Security Hardening
├── Threat Model
├── Fuzz / Invariants
├── ZK Review
└── External Audit
        │
        ▼
M3
│
├── Production Infrastructure
├── Mainnet Deployment
├── Ecosystem Liquidity
├── Base-Originating Liquidity
├── Real Liquidity
├── Real Users
└── Usage Metrics
```

M3 should not be treated as a simple deployment step. It depends on completing the security and operational requirements necessary to safely handle real user funds.

---

# 10. Relationship to the Horizen S2 Program

| VeilLend Stage | Horizen S2 Focus                             |
| -------------- | -------------------------------------------- |
| M1             | Prove the hard privacy capability            |
| M2             | Security audit / production hardening        |
| M3             | Real mainnet usage and ecosystem integration |

Horizen's private borrow-lend RFP specifically identifies confidential collateral positions, confidential borrow sizes, confidential health factors, provable solvency, reliable interest-rate mechanics, and functioning liquidation without exposing borrowers as core requirements.

VeilLend therefore treats these capabilities as first-class protocol requirements rather than optional features.

The M3 stage additionally provides a path for connecting the protocol to liquidity originating from Base through existing ecosystem and bridging infrastructure, while keeping the core protocol deployment focused on Horizen.

---

# 11. Long-Term Success Criteria

Beyond the initial milestones, VeilLend aims to establish a sustainable private lending market on Horizen. Long-term success will be measured through:

* Growing collateral deposits
* Sustainable borrowing activity
* Healthy utilization
* Repeat borrowers and lenders
* Reliable liquidation
* Sustainable protocol revenue
* Additional collateral markets
* Ecosystem integrations
* Meaningful ZEN utility
* Continued privacy improvements

The long-term objective is not simply to deploy a private lending contract.

It is to establish a usable, secure, and composable confidential credit primitive for the Horizen ecosystem.
