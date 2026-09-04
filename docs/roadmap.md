# VeilLend — Development Roadmap

> **VeilLend** is a privacy-preserving borrow-lend protocol designed for Horizen. It keeps individual collateral, debt, and health state confidential while using zero-knowledge proofs to enforce protocol rules and execute lending actions without exposing the underlying financial state on-chain.

This roadmap describes the progression from the current technical prototype to a security-reviewed mainnet protocol and real ecosystem usage.

---

# 1. Current State — Built & Testnet-Validated

VeilLend has demonstrated the core confidential lending mechanism required by the protocol.

### Implemented

* Private lending position state
* Poseidon-based position commitments
* Commitment-based state transitions
* Groth16 zero-knowledge proofs
* Solidity on-chain proof verification
* Private collateral state
* Private debt state
* Private solvency / health conditions
* Proof-based deposit and withdrawal
* Proof-based borrowing and repayment
* Privacy-preserving liquidation
* Recipient-bound proofs
* Nullifier and sequence-based replay protection
* Public custody and accounting constraints
* LTV and borrow-limit enforcement
* Oracle freshness and price-bound validation
* Security regression tests
* Fuzz and invariant testing
* Recovery / escape mechanism prototype
* Horizen Testnet deployment
* Browser-based demonstration
* End-to-end proof and liquidation evidence

The current implementation is documented separately in the M1 evidence package and supporting technical documentation.

### Current Status

**Technical prototype demonstrated on Horizen Testnet.**

The project has not yet undergone an external security audit and is not considered production-ready.

---

# 2. M1 — Prove the Hard Part

## Objective

Demonstrate that VeilLend can implement the core confidential lending mechanism in a reproducible, end-to-end system.

The central M1 objective is:

> **Keep the meaningful financial state private while allowing the protocol to verify state transitions, solvency, and liquidation conditions through zero-knowledge proofs.**

### M1 Work

#### Privacy Architecture

* Finalize the privacy model
* Define exactly which state remains private
* Define which information must remain public for settlement and accounting
* Document privacy leakage and known limitations
* Formalize the commitment-based position model

#### ZK Infrastructure

* Harden state-transition circuits
* Harden risk-transition circuits
* Harden solvency constraints
* Harden liquidation circuits
* Finalize public/private signal definitions
* Validate witness and commitment handling
* Document trusted-setup requirements
* Establish reproducible proof-generation workflows

#### Confidential Lending

* Private collateral state
* Private debt state
* Private solvency conditions
* Private health-factor representation
* Borrow and withdrawal enforcement through ZK proofs
* Repayment and state-transition enforcement
* Commitment rotation after valid transitions

#### Confidential Liquidation

* Prove undercollateralization without revealing the complete position
* Calculate liquidation settlement from hidden state
* Prevent unauthorized liquidation
* Prevent replayed liquidation proofs
* Bind settlement to the authorized transaction participant
* Preserve hidden residual debt/state where applicable

#### Protocol Accounting

* Maintain public custody accounting
* Maintain supported-collateral accounting
* Maintain outstanding-borrow limits
* Enforce LTV constraints
* Validate oracle freshness and bounds
* Ensure hidden state transitions cannot create unsupported protocol liabilities

#### Verification & Reproducibility

* Deploy required verification contracts
* Maintain deterministic deployment records
* Reproduce proof generation locally
* Reproduce on-chain verification
* Maintain Testnet evidence
* Maintain automated regression coverage

### M1 Acceptance Criteria

M1 is considered complete when:

* Private position state can be represented through cryptographic commitments.
* Valid state transitions require valid ZK proofs.
* Invalid transitions are rejected.
* Solvency rules are enforced inside the proof system.
* Liquidation eligibility can be proven without revealing the complete private position.
* A liquidation can execute successfully on Horizen Testnet.
* Replay and recipient-binding protections are demonstrated.
* Public custody/accounting remains consistent with the hidden state model.
* The complete flow is reproducible from the repository.

**Current position: M1 technical objective demonstrated.**

---

# 3. M2 — Security & Production Hardening

## Objective

Transform the demonstrated privacy protocol into a security-reviewed implementation suitable for production deployment.

### Smart Contract Security

* Complete contract-level security review
* Harden access control
* Minimize administrative authority
* Review emergency controls
* Review recovery mechanisms
* Review custody invariants
* Review accounting invariants
* Review oracle integration
* Define production upgradeability architecture
* Minimize unnecessary trust assumptions

### ZK Security

* Review every circuit constraint
* Review public/private signal boundaries
* Validate commitment binding
* Validate nullifier construction
* Validate sequence handling
* Review replay resistance
* Review recipient binding
* Review trusted-setup assumptions
* Test malformed proofs and adversarial witnesses
* Review circuit arithmetic and range constraints

### Advanced Testing

* Expand fuzz testing
* Expand invariant testing
* Add adversarial state-transition tests
* Add liquidation edge-case tests
* Test oracle manipulation scenarios
* Test accounting inconsistencies
* Test unexpected token behavior
* Test denial-of-service conditions
* Test recovery and emergency paths

### Threat Model

Finalize and maintain a complete threat model covering:

* Borrowers
* Lenders
* Liquidators
* Malicious proof generators
* Malicious transaction submitters
* Front-running
* Proof replay
* Commitment substitution
* Oracle manipulation
* Administrative compromise
* Trusted-setup compromise
* Privacy leakage
* Economic attacks
* Bad-debt scenarios

### External Security Audit

* Select a Foundation-approved security auditor
* Audit smart contracts
* Audit ZK circuits
* Audit protocol assumptions
* Audit trusted-setup requirements
* Remediate findings
* Re-test after remediation
* Publish appropriate audit documentation

### M2 Acceptance Criteria

* External security audit completed
* Critical/high findings resolved or formally accepted
* Regression suite passes after remediation
* ZK circuits reviewed
* Threat model finalized
* Emergency and recovery mechanisms tested
* Production deployment architecture documented

**Status: Planned / Not yet complete.**

---

# 4. M3 — Mainnet, Liquidity & Real Usage

## Objective

Deploy VeilLend to Horizen Mainnet and demonstrate real protocol usage while connecting the protocol to the broader Horizen and Base liquidity ecosystem.

Horizen's S2 framework emphasizes real mainnet usage and metrics such as users, transaction volume, TVL, utilization, and privacy-preserving liquidations.

### Mainnet Preparation

* Complete M2 security requirements
* Finalize production ZK parameters
* Establish production trusted-setup process
* Deploy production verification infrastructure
* Configure production oracle infrastructure
* Configure monitoring and alerting
* Finalize emergency procedures
* Finalize recovery procedures
* Prepare production frontend
* Prepare deployment and rollback procedures

### Mainnet Launch

* Deploy VeilLend contracts to Horizen Mainnet
* Deploy production ZK verifiers
* Configure supported collateral
* Seed initial liquidity
* Enable lending
* Enable borrowing
* Enable repayment
* Enable withdrawals
* Enable liquidation
* Monitor protocol health and accounting

### Horizen & Base Liquidity Integration

VeilLend will connect to liquidity originating from the broader Base ecosystem through **existing Base ↔ Horizen bridging and ecosystem infrastructure**, rather than building a new bridge.

Planned work includes:

* Connect supported Base-originating assets to Horizen liquidity flows
* Integrate with relevant Horizen ecosystem liquidity
* Enable capital to move from Base into Horizen-supported lending markets
* Support composable lending flows
* Explore integrations with privacy-focused DeFi applications
* Integrate with relevant ecosystem infrastructure as liquidity and usage mature

The initial implementation will remain focused on Horizen. Base connectivity is an ecosystem and liquidity expansion path rather than a requirement for the core confidential lending mechanism.

### Real Usage

Measure and report:

* Total collateral deposited
* Total outstanding borrows
* Utilization rate
* Unique borrowers
* Unique lenders
* Number of active positions
* Liquidations executed without unnecessary privacy leakage
* Protocol interest revenue
* Transaction volume
* Protocol liquidity

### Production Liquidation

Demonstrate that liquidation works reliably under real market conditions while preserving the confidentiality properties of individual positions.

### M3 Acceptance Criteria

* Production deployment completed
* Real liquidity supplied
* Real users interact with the protocol
* Borrowing and lending occur on mainnet
* Base-originating liquidity can access supported Horizen markets through existing infrastructure
* Liquidations function correctly
* Protocol accounting remains consistent
* Privacy guarantees remain intact under production operation
* Meaningful usage metrics are recorded and reported

**Status: Planned / Not yet complete.**

---

# 5. Ecosystem & Asset Expansion

## Collateral Expansion

VeilLend will initially focus on a limited set of well-supported collateral assets.

After production validation:

* Add additional collateral types
* Add production oracle feeds
* Establish asset-specific risk parameters
* Validate each asset through the privacy and accounting model

Collateral selection will prioritize assets with meaningful ecosystem liquidity, reliable price feeds, and appropriate risk characteristics.

## ZEN Integration

ZEN will be considered a priority asset for ecosystem alignment and protocol utility.

Potential areas include:

* ZEN as supported collateral
* ZEN-denominated lending markets
* ZEN-related incentives
* Protocol revenue alignment
* Integration with relevant Horizen ecosystem economics

Any ZEN integration will be designed around actual protocol utility rather than token speculation.

---

# 6. Long-Term Protocol Development

After the initial mainnet launch, development will focus on improving capital efficiency, privacy, usability, and ecosystem composability.

### Protocol Improvements

* More collateral markets
* Improved interest-rate models
* Dynamic utilization-based rates
* Better liquidation economics
* Bad-debt management
* Liquidity optimization
* Improved capital efficiency
* Additional risk controls

### Privacy Improvements

* Reduce metadata leakage where practical
* Improve transaction privacy
* Improve proof-generation UX
* Explore additional proving infrastructure
* Evaluate Horizen privacy infrastructure integrations where beneficial
* Explore selective disclosure mechanisms

VeilLend will adopt additional privacy infrastructure only where it provides a concrete technical or economic benefit.

### User Experience

* Simple lending interface
* Simple borrowing interface
* Private position management
* Clear proof-generation status
* Wallet integration
* Transaction monitoring
* Liquidation notifications
* Recovery workflows
* Selective disclosure where appropriate

---

# 7. Development Progression

```text
CURRENT PROTOTYPE
        │
        ▼
M1 — PROVE THE HARD PART
        │
        ├── Private State
        ├── ZK State Transitions
        ├── Private Solvency
        ├── Confidential Liquidation
        └── Testnet Evidence
        │
        ▼
M2 — SECURITY & PRODUCTION HARDENING
        │
        ├── Threat Model
        ├── Fuzz & Invariants
        ├── ZK Hardening
        ├── Contract Hardening
        └── External Audit
        │
        ▼
M3 — MAINNET & ECOSYSTEM LIQUIDITY
        │
        ├── Production Deployment
        ├── Real Liquidity
        ├── Base-Originating Liquidity
        ├── Real Borrowing/Lending
        ├── Production Liquidations
        └── Usage Metrics
        │
        ▼
LONG-TERM
        │
        ├── Ecosystem Integration
        ├── More Collateral
        ├── ZEN Utility
        ├── Better Capital Efficiency
        └── Protocol Growth
```

---

# 8. Source-of-Truth Documentation

| Document                               | Purpose                                               |
| -------------------------------------- | ----------------------------------------------------- |
| `docs/roadmap.md`                      | Overall project direction and development progression |
| `docs/milestones.md`                   | Detailed milestone objectives and acceptance criteria |
| `docs/M1-evidence.md`                  | Recorded evidence of the M1 technical achievement     |
| `docs/privacy-model.md`                | Privacy architecture and visibility model             |
| `docs/zk-poc.md`                       | ZK proof-of-concept documentation                     |
| `docs/testnet-proof-evidence.md`       | Testnet proof-chain evidence                          |
| `docs/testnet-liquidation-evidence.md` | Testnet liquidation evidence                          |
| `docs/liquidation-model.md`            | Confidential liquidation design                       |
| `docs/phase3.md`                       | Security hardening and internal findings              |

The roadmap describes **where the project is going**.

The milestone documentation describes **what must be achieved**.

The evidence documentation describes **what has actually been demonstrated**.

This separation is intentional so that planned work is never presented as completed functionality.

---

# 9. Core Product Objective

VeilLend's long-term objective is to make private credit possible on an EVM-compatible network without sacrificing the core guarantees required from a lending market.

The protocol therefore aims to preserve the following properties simultaneously:

* **Confidential positions**
* **Provable solvency**
* **Correct accounting**
* **Reliable interest mechanics**
* **Permissionless liquidation**
* **Replay resistance**
* **Non-custodial asset control**
* **Verifiable protocol rules**
* **Composable EVM infrastructure**

The fundamental design principle is:

> **Private State → Cryptographic Commitment → Zero-Knowledge Proof → On-Chain Verification → Verifiable State Transition**

VeilLend's goal is to transform lending from a public-state model into a proof-based private-state model, where users can interact with credit markets without exposing the complete financial state that those interactions depend on.
