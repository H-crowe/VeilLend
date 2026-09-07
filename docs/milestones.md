# VeilLend — Milestones & Acceptance Criteria

> This document defines the engineering milestones for VeilLend, including the objective, deliverables, evidence requirements, and acceptance criteria for each stage of development.
>
> The milestone structure is aligned with the project's progression from a demonstrated privacy prototype to a security-reviewed mainnet protocol with real usage.
>
> **Important:** A milestone is considered complete only when its acceptance criteria and supporting evidence have been satisfied. Planned work must not be presented as implemented functionality.

---

# 1. Milestone Overview

| Milestone | Objective                       | Primary Outcome                                                                                      | Status                       |
| --------- | ------------------------------- | ---------------------------------------------------------------------------------------------------- | ---------------------------- |
| M1        | Prove the hard part             | Demonstrate confidential lending state and ZK-enforced lending/liquidation on Horizen Testnet        | **Technically demonstrated** |
| M2        | Security & production hardening | Complete external security review and prepare the protocol for production                            | **Planned**                  |
| M3        | Mainnet & real usage            | Deploy to Horizen Mainnet, connect to ecosystem liquidity, and demonstrate real lending-market usage | **Planned**                  |

The milestone progression is:

```text
M1
Prove the Privacy-Critical Mechanism
        ↓
M2
Security Review & Production Hardening
        ↓
M3
Mainnet, Ecosystem Liquidity & Real Usage
```

---

# 2. M1 — Prove the Hard Part

## Objective

Demonstrate the core technical capability that VeilLend depends on:

> Private lending state can be represented through cryptographic commitments and manipulated through zero-knowledge proofs while the meaningful collateral, debt, and solvency state remains hidden from the public chain.

The M1 milestone focuses on proving that the privacy mechanism is functional rather than merely theoretical.

---

## 2.1 M1 Deliverables

### A. Private State Model

* Commitment-based private position representation
* Poseidon commitments
* Hidden collateral state
* Hidden debt state
* Hidden interest/state variables where applicable
* Position control through secret knowledge
* Commitment rotation after valid state transitions

### B. Zero-Knowledge State Transitions

Implement and validate ZK-enforced transitions for:

* Deposit
* Borrow
* Repay
* Withdraw

Each transition must:

* Verify knowledge of the previous private state
* Validate the required protocol rules
* Produce a valid next commitment
* Prevent unauthorized state manipulation
* Prevent replay of an already-consumed transition

### C. Private Risk Enforcement

The proof system must enforce:

* Borrow limits
* Withdrawal safety
* Solvency conditions
* LTV constraints
* Required sequence progression
* Valid position control

Invalid risk transitions must be unprovable or rejected by on-chain verification.

### D. Confidential Liquidation

Demonstrate that:

* A position can be proven undercollateralized without revealing its complete private state.
* Liquidation eligibility is enforced through a ZK proof.
* Settlement values are derived from the hidden state.
* The position cannot be liquidated twice.
* Unauthorized parties cannot redirect the settlement.
* Hidden residual state remains private where applicable.

### E. On-Chain Verification

Deploy Solidity verification infrastructure capable of:

* Verifying generated Groth16 proofs
* Rejecting invalid proofs
* Enforcing state transitions only after successful verification
* Binding relevant actions to the authorized transaction participant

### F. Public Accounting

Maintain public protocol-level accounting for:

* Asset custody
* Supported collateral
* Outstanding borrow limits
* Nullifiers
* Position sequences
* Protocol configuration

Public accounting must not expose the private position state unnecessarily.

### G. Testnet Demonstration

Demonstrate the complete lifecycle on Horizen Testnet:

```text
Private State
      ↓
Poseidon Commitment
      ↓
Groth16 Proof
      ↓
Solidity Verification
      ↓
On-Chain State Transition
      ↓
New Commitment
```

The lifecycle must include a successful confidential liquidation demonstration.

---

## 2.2 M1 Evidence

M1 evidence should include:

* Reproducible local proof generation
* Local proof verification
* Automated protocol tests
* Circuit-level tests
* Adversarial tests
* Fuzz/invariant testing where applicable
* Deployed verifier contracts
* Horizen Testnet deployment records
* Real on-chain proof-verification transactions
* Real on-chain liquidation transaction
* Commitment/state-transition evidence
* Reproduction instructions

The primary M1 evidence package is:

`docs/M1-evidence.md`

Supporting evidence may include:

* `docs/testnet-proof-evidence.md`
* `docs/testnet-liquidation-evidence.md`
* Deployment records
* Circuit source
* Contract source
* Test suites
* Proof-generation scripts

---

## 2.3 M1 Acceptance Criteria

M1 is accepted when all of the following are demonstrated:

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

**TECHNICAL OBJECTIVE DEMONSTRATED**

The detailed recorded evidence and limitations are documented in `docs/M1-evidence.md`.

M1 does **not** imply:

* Production readiness
* External security audit
* Mainnet deployment
* Production oracle infrastructure
* Production trusted setup
* Real economic liquidity
* Full transaction-level privacy

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
* local E2E lifecycle suite covering all six supported asset pairs plus negative/security cases (`test/e2e-lifecycle.test.ts`, 14/14 passing; full suite 156/156).

Still outstanding for M2:

* external security audit;
* finalized comprehensive threat model;
* on-chain recovery/escape mechanism (recovery remains a client-side prototype);
* expanded fuzz and invariant testing;
* deeper access-control/administration hardening review;
* the next Testnet deployment carrying the UUPS + Stork changes.

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

Security is not limited to M2.

The following properties must remain enforced throughout the project.

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

# 6. Milestone Dependencies

The milestones have explicit dependencies:

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

# 7. Definition of Done

A milestone is considered **Done** only when:

1. The implementation exists in the repository.
2. The implementation is tested.
3. The relevant behavior is reproducible.
4. Evidence is recorded.
5. Security assumptions are documented.
6. Known limitations are documented.
7. The acceptance criteria for the milestone are satisfied.

A feature that exists only in the roadmap or application is **Planned**, not **Implemented**.

---

# 8. Status Language

To keep project documentation and grant reporting precise, VeilLend uses the following status terminology.

### Implemented

The functionality exists in the repository.

### Tested

The functionality has automated or documented tests demonstrating the expected behavior.

### Demonstrated

The functionality has been demonstrated through a reproducible end-to-end workflow.

### Testnet-Validated

The functionality has been exercised successfully on Horizen Testnet with recorded evidence.

### Audited

The relevant implementation has undergone an independent external security audit.

### Production-Ready

The required security, operational, deployment, and testing requirements have been completed.

### Mainnet-Validated

The functionality has been successfully exercised on Horizen Mainnet.

### Planned

The functionality is part of the development plan but has not yet been completed.

---

# 9. Current Project Position

At the time of this document:

```text
M1 — Prove the Hard Part
        │
        └── TECHNICAL OBJECTIVE DEMONSTRATED

M2 — Security & Production Hardening
        │
        └── PLANNED

M3 — Mainnet, Ecosystem Liquidity & Real Usage
        │
        └── PLANNED
```

The current implementation has demonstrated the core privacy mechanism and confidential lending lifecycle on Horizen Testnet.

The next major engineering objective is therefore **security hardening and independent review**, followed by production deployment, ecosystem liquidity integration, and real market usage.

---

# 10. Relationship to the Horizen S2 Program

VeilLend's milestone structure maps directly to the core progression expected by the Horizen S2 Builder Ecosystem Fund:

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

Beyond the initial milestones, VeilLend aims to establish a sustainable private lending market on Horizen.

Long-term success will be measured through:

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
