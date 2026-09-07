# VeilLend — M1 Evidence Package

> Milestone 1 evidence: **private lending state can be represented as
> cryptographic commitments and manipulated through zero-knowledge proofs
> while the relevant private collateral/debt state remains hidden from the
> public chain** — demonstrated end-to-end on Horizen Testnet with real
> Groth16 proofs and real on-chain verification.
>
> This document claims only what the recorded evidence shows. It does not
> claim that the Horizen blockchain itself is private, that the code is
> audited, or that anything is production-ready.

---

> **Deployment note (post-M1):** the `risk_transition` circuit's action gate
> was corrected (the borrow/withdraw amount cap must apply to withdrawals
> only), which changes its verification key. A new `RiskTransitionVerifier`
> and a new `VeilLend` were deployed on the same Horizen Testnet — current
> addresses live in [`deployments/horizenTestnet.json`](../deployments/horizenTestnet.json)
> (VeilLend `0xeCB439fbE792Bec4E005f1809E6DCF4FB37d4787`). The addresses and
> transactions below are the **recorded historical evidence** against the
> superseded deployment and are kept unchanged.
>
> **Update:** the CURRENT Testnet deployment is now the separate UUPS/ERC-1967
> deployment (proxy `0xc1e2…4a5B`, record:
> [`deployments/horizenTestnet-uups.json`](../deployments/horizenTestnet-uups.json));
> `horizenTestnet.json` and the addresses below are historical M1 records.

## 1. What M1 proves

VeilLend's hard technical capability, demonstrated on a live network:

1. The confidential financial state is represented by a Poseidon commitment
   on-chain, while separate public accounting variables enforce custody and
   protocol-level limits.
2. Every state change (deposit, repay, borrow, withdraw) requires a **real
   Groth16 proof** that the transition follows the protocol rules over the
   hidden state — verified by deployed Solidity verifiers.
3. Risk rules are enforced **in zero knowledge**: an unsafe borrow or
   withdrawal is unprovable; a liquidation requires proving hidden
   undercollateralization without revealing it.
4. Public accounting (custody, supported collateral, outstanding borrow,
   nullifiers, sequences) reconciles exactly with the hidden state that only
   proof-holders can act on.

### Public vs private — precise separation

| Data | Visibility |
|---|---|
| Commitments (C0/C1/C2), sequences, nullifiers | **Public** — the on-chain state model (hashes only) |
| Per-action token amounts (deposit/borrow/repay/withdraw/liquidation) | **Public** — the ERC20 transfer layer is not confidential |
| Oracle prices, LTV/threshold parameters | **Public** by design (public circuit inputs) |
| Cumulative hidden collateral / debt / interest | **Private** — inside commitments; never in storage, events, or ABI |
| Health factor / solvency state | **Private** — only binary proof outcomes are observable |
| Control secret, salts, full witness | **Private** — holder-only; never leaves the proving process |
| Position ↔ user identity | **Not recorded** — control is knowledge of the control secret |

An observer learns: that transactions occurred, the token amounts that moved
(necessarily public), and binary proof outcomes. An observer cannot learn:
any position's cumulative collateral, debt, interest, health factor, or
who controls which position.

## 2. RFP requirements → implemented evidence

| Requirement | Implementation | Evidence | Repository | Testnet reference |
|---|---|---|---|---|
| Private collateral position | Hidden collateral bound into Poseidon commitment; on-chain ledger is a custody control, not the private state | Deposit proof verified on-chain; custody 1:1 | `contracts/VeilLend.sol` (`deposit`), `circuits/state_transition.circom` | `docs/testnet-proof-evidence.md` §3 |
| Private borrow/debt amount | Hidden debt grows only via verified transitions; borrow-outstanding ledger is a cap, not the private state | Borrow proof verified on-chain | `contracts/VeilLend.sol` (`borrow`), `circuits/risk_transition.circom` | `deployments/testnet-liquidation-proof-test.json` |
| Private solvency/health condition | In-circuit inequality `collateral·price·10⁴ ≥ debt·price·LTV` (borrow/withdraw) and strict undercollateralization for liquidation | Local proof/rejection tests incl. boundaries | `circuits/solvency.circom`, `circuits/risk_transition.circom` | local suite (`test/solvency.test.ts`) |
| ZK proof verification | 4 snarkjs-generated Groth16 verifiers deployed, immutable | Real proofs verified on-chain | `contracts/zk/` | tx `0x5e50000a…4c8` (deposit), `0xbfd6ffe4…c43f` (liquidation) |
| Confidential liquidation | Eligibility proven over hidden state; settlement amounts computed in-circuit | **Real liquidation executed and verified on-chain** | `contracts/VeilLend.sol` (`liquidate`), `circuits/liquidation.circom` | tx `0xbfd6ffe40d7e4d987a9d93d2c8c0a69eea639abc0a654210c3a0da4cc17fc43f` |
| Liquidation without exposing private state | Liquidator proves eligibility + settlement without learning hidden balances beyond the transferred amounts | Amounts derived in-circuit; residual debt stays hidden | `docs/liquidation-model.md` | `deployments/testnet-liquidation-proof-test.json` |
| Working privacy feature (end-to-end) | Full lifecycle: commitment → proof → verification → transition | C0→C1→C2 chain + liquidation lifecycle | `scripts/proof-test.ts`, `scripts/liquidation-test.ts` | `deployments/onchain-proof-test.json` |
| Horizen Testnet deployment | Full stack deployed, address book recorded | 8 contracts with on-chain code | `deployments/horizenTestnet.json` | explorer link below |
| Real on-chain proof execution | 3 circuits exercised live (state_transition, risk_transition, liquidation) | All succeeded | `scripts/proof-test.ts`, `scripts/liquidation-test.ts` | see §4 |

## 3. The end-to-end Testnet proof (verified against repository evidence)

**Correction to earlier drafts:** the final, fully-verified liquidation run
executed **Position #24** (not #22). Position #22 was an earlier *also
successful* liquidation (tx `0x8b6cc153be3061976b0a9b4a892371efbd019f85c4c305642c312cc50ad893b1`,
block 26,775,051). The numbers below are read from
`deployments/testnet-liquidation-proof-test.json`.

### Liquidation lifecycle (Position #24)

| Step | Result | On-chain |
|---|---|---|
| 1. Create private position | commitment C0 stored, Active | tx recorded in evidence JSON |
| 2. Deposit 100 vCOL | real `state_transition` proof verified on-chain; custody +100e18 | tx recorded |
| 3. Seed debt liquidity | 50 vDBT repaid into `debtCustody` (real proof) | tx recorded |
| 4. Borrow 10 vDBT | real `risk_transition` proof, recipient-bound; `borrowOutstanding` = 10e18 | tx recorded |
| 5. Oracle price drop | vCOL $2.00 → $0.05 (vDBT $1.00) | tx recorded |
| 6. Generate liquidation proof | in-circuit: `collateralOut = 100 vCOL`, `debtOut = min(10, ceil(100·0.05/1)) = 5 vDBT` | local proving |
| 7–8. Submit liquidation | **deployed LiquidationVerifier verifies the proof on-chain** | tx `0xbfd6ffe40d7e4d987a9d93d2c8c0a69eea639abc0a654210c3a0da4cc17fc43f` |
| 9. Settlement | 100 vCOL released to the liquidator (exactly) | verified by read calls |
| 10. Debt settled | 5 vDBT paid by the liquidator (exactly) | verified by read calls |
| 11. Bad debt | remaining 5 vDBT written off (documented PoC design) | hidden residual |
| 12. Position Closed | `status = Closed` | verified by read calls |
| 13. Replay | second liquidation attempt reverts (`PositionNotActive`) | verified |

**Liquidation transaction:** `0xbfd6ffe40d7e4d987a9d93d2c8c0a69eea639abc0a654210c3a0da4cc17fc43f`
**Block:** 26,775,401 · **Gas:** 355,932

### Deposit/withdraw proof chain (Position #2, earlier evidence run)

C0 `94984788…4157547` → C1 `89328681…26739808` (deposit, tx
`0x5e50000a…f57d4c8`, block 26,721,810, gas 410,361) → C2
`19777129…95504709` (recipient-bound withdraw, tx `0xc0a429d6…1e4b8`, block
26,721,815, gas 387,547) — sequences 0→1→2, nullifiers consumed, custody
conserved. Full detail: `docs/testnet-proof-evidence.md`.

## 4. How the privacy works, per action

**Architecture (one line):** Private State → Poseidon Commitment → Groth16
Proof → Solidity Verifier → On-chain state transition.

**Deposit.** The depositor proves (without revealing balances) that the new
commitment is the old commitment with hidden collateral increased by exactly
the publicly transferred amount. Custody increases only after the deployed
verifier accepts; the hidden state and the public custody stay bound 1:1.

**Borrow.** The borrower proves: knowledge of the active commitment
preimage, control of the position, sequence+1, a fresh nullifier, and that
the **post-borrow** hidden position satisfies the solvency inequality
against current public prices and the configured LTV. The protocol pays out;
no collateral/debt amount is revealed.

**Withdraw.** Same shape, with the hidden collateral proven to cover the
withdrawal. The proof is **recipient-bound**: the payout recipient is a
public circuit input derived on-chain from `msg.sender`, so a copied
mempool proof cannot redirect value.

**Liquidation.** The liquidator proves the hidden position satisfies
`collateralValue < debtValue · threshold` and the circuit computes the
settlement (`collateralOut = hidden collateral`, `debtOut = min(hidden
debt, oracle-parity)`) as public signals — the liquidator learns the public settlement amounts
(`collateralOut` and `debtOut`) required for settlement, but does not learn
the position's full hidden collateral, debt, or residual debt state.

## 5. Deployed contract evidence

Read from `deployments/horizenTestnet.json` (all addresses verified to
contain deployed code on-chain):

| Contract | Address |
|---|---|
| VeilLend | `0x9fd6477Dd3b5eDB4e55A7D7F962Af0e8e332a9B9` — [explorer](https://explorer-testnet.horizen.io/address/0x9fd6477Dd3b5eDB4e55A7D7F962Af0e8e332a9B9) |
| Groth16Verifier (state transitions) | `0x0D96E5a05d11c0839037488332CAd29E6Ef6686C` |
| SolvencyVerifier | `0xD33ce96e9A6AF2c8f5E7f73d5214eDf0c9eff24F` |
| RiskTransitionVerifier | `0x533Fd1381b7a3aAc107c07983bf82f6681D98b4a` |
| LiquidationVerifier | `0x4bf85D6D5f3A730280D707dB0D2d063940A80869` |
| MockPriceOracle (test-only) | `0xDA4CAA96D6fF78Af30A3955b5310BE9258d57Bc2` |
| TokenMock vCOL (test-only) | `0x281FbbeD6f2DEA61c86191EA92f2B9B9D2D66a3c` |
| TokenMock vDBT (test-only) | `0xe27c05934Ad4046d72766808b30F0514e978f612` |

## 6. Automated test evidence (verified against the repository)

- **Full local suite: 111/111 passing at the time of this M1 record** (156 passing in the current repository) (`npm test` — unit, circuit-level,
  solvency, risk, liquidation incl. the five audit-gap tests, adversarial
  recipient-binding A–I, supported-collateral F1–F3 regressions, seeded
  fuzz/invariant harness).
- **Solidity build: clean** — 19 files, 0 warnings (`npm run build`).
- **Local ZK end-to-end demo: PASS** (`npm run prove` — witness →
  commitment → real Groth16 proof → local verification).
- **Liquidation suite: 14 passing** (`npx hardhat test test/liquidation.test.ts`).
- **Real Testnet liquidation: PASS** (see §3).

Reproduction commands:

```bash
npm install
npm run zk:build   # circuits → pot14 → zkeys → Solidity verifiers
npm run build && npm test
npm run prove

npx hardhat run scripts/verify-network.ts  --network horizenTestnet
npx hardhat run scripts/proof-test.ts      --network horizenTestnet
npx hardhat run scripts/liquidation-test.ts --network horizenTestnet
```

## 7. Security hardening backing M1

Implemented and regression-tested (findings F1–F5 from the internal
security review, documented in `docs/phase3.md`):

- **Deposit commitment binding + `supportedCollateral` accounting** — fabricated
  initial commitments cannot withdraw/liquidate unsupported collateral (F1/F3).
- **`borrowOutstanding` accounting + borrow cap** — `outstanding + amount ≤
  supported·LTV/10000`; fabricated collateral cannot back real borrows (F2).
- **Parameter bounds** — `0 < maxLtvBps, liquidationThresholdBps ≤ 10000`
  enforced at configuration (F4).
- **Oracle price bounds** — prices ≥ 2⁶⁴ rejected at `getFreshPrice`, matching
  the circuits' `RangeCheck(64)` (F4).
- **Recipient-bound proofs** — borrow/withdraw/liquidate commit the payout
  recipient as a public input derived on-chain from `msg.sender` (F5).
- **Replay protection** — nullifiers consumed only after verification;
  liquidation replay blocked by position closure.
- **Custody invariants** — `Σ supportedCollateral == collateralCustody` and
  per-position `outstanding ≤ supported·LTV/10000` asserted continuously in
  the fuzz harness.

Known limitations (honest): no external audit; PoC single-contribution
trusted setup; single-oracle/admin trust model; no meta-relaying (proofs
bind to `msg.sender`); first-submitter advantage for permissionless
liquidation; no liquidation bonus or bad-debt reserve accounting; Testnet
only; per-action amounts public (position privacy, not transaction privacy).

## 8. Milestone Status

### M1 — Prove the hard part
**Status: TECHNICAL OBJECTIVE DEMONSTRATED.**
The M1 technical objective has been demonstrated end-to-end on Horizen
Testnet: private state is represented through cryptographic commitments,
real ZK proofs enforce state transitions and risk rules, deployed Solidity
verifiers perform on-chain verification, and confidential liquidation has
been successfully executed with recorded transaction evidence and 111/111
local regression tests at the time of the record (132 passing in the
current repository).

### M2 — Security Audit
**Status: NOT COMPLETE.** Internal testing and an internal security review
exist; that is not an external audit. An audit of the circuits, the
protocol contract, and the trusted-setup process is required.

### M3 — Mainnet Usage
**Status: NOT COMPLETE.** All evidence is Testnet evidence. Production
oracle, real assets, ceremony-backed trusted setup, operational tooling,
and the M2 audit are prerequisites.

## 9. Evidence index

| Evidence | Location |
| --- | --- |
| M1 evidence (this document) | docs/M1-evidence.md |
| Testnet deployment record | deployments/horizenTestnet.json |
| ZK proof evidence (deposit/withdraw) | deployments/onchain-proof-test.json |
| M1 lifecycle E2E (create → deposit → borrow → repay → withdraw) | deployments/e2e-lifecycle-test.json — **historical M1 lifecycle evidence from the earlier deployment (Position #32); retained as valid historical M1 evidence** |
| Liquidation evidence | deployments/testnet-liquidation-proof-test.json |
| Testnet proof documentation | docs/testnet-proof-evidence.md |
| Liquidation documentation | docs/testnet-liquidation-evidence.md |
| Circuits | circuits/ |
| Solidity contracts | contracts/ |
| Tests | test/ |
| Proof generation & deployment tooling | scripts/ |
