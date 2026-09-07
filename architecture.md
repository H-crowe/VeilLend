# VeilLend — Architecture

> **VeilLend — Privacy-first confidential lending for the Horizen ecosystem.**

This document is the single design reference. It describes what is
implemented, the exact ZK constructions in use, and the honest boundary
between what is private and what is public. Statuses are honest: nothing
claims to be complete if it is not.

---

## 1. Core flow (Phase 3 state)

```text
Private State ──(Poseidon)──► Commitment ──(on-chain, authoritative)
      │
      └─(control secret inside)── Ownership / Control (proven in ZK)
                                     │
Nullifier ◄──(Poseidon: secret, position, sequence, action)
                                     │
ZK State Transition Proof (Groth16) ──► On-chain verification ──► New Commitment
                                     │
Public Oracle Prices + Risk Parameters
                                     │
ZK Solvency Proof ──► Borrow / Withdraw authorization (risk_transition.circom)
                                     │
ZK Liquidation Eligibility Proof ──► Confidential Settlement (liquidation.circom)
```

Phase 3 implemented the full solvency/risk/liquidation stack. The detailed
models live in docs/solvency-model.md, docs/oracle-model.md,
docs/liquidation-model.md and docs/phase3.md; the sections below stay
consistent with them.

---

## 2. Private state (v1) — exact specification

One position = one collateral asset, one debt asset. The hidden state:

| # | Field | Encoding | Constraint |
|---|-------|----------|------------|
| 1 | `positionId` | single field element | < 2^64 in practice (on-chain counter) |
| 2 | `collateralAsset` | lo/hi limbs | 160-bit address, lo < 2^120, hi < 2^80 |
| 3 | `debtAsset` | lo/hi limbs | 160-bit address, same |
| 4 | `collateral` (atomic units) | lo/hi limbs | < 2^200 |
| 5 | `debt` (atomic units) | lo/hi limbs | < 2^200 |
| 6 | `interestIndexSnapshot` (WAD) | lo/hi limbs | < 2^200, ≥ 1e18 |
| 7 | `sequence` | single field element | < 2^64 |
| 8 | `controlSecret` | single field element | 248-bit random, never revealed |
| 9 | `salt` | single field element | 248-bit random, refreshed per transition |

**Integer encoding:** every value is `value = lo + hi·2^120` with
`lo < 2^120`, `hi < 2^80` (so `value < 2^200`). The BN254 scalar field
(`r ≈ 2^254`) hosts all of it with margin. The 200-bit ceiling is range-
constrained in-circuit (`Num2Bits(200)` on the recombined value), so no limb
aliasing or overflow is possible.

**Address encoding:** a 160-bit address is split into the same lo/hi limb
form off-chain. There is exactly one canonical encoding per value (the
circuit rejects any non-canonical split because recombination is constrained
through the bit decomposition).

**Domain separation / versioning:** constants are the ASCII hex of version
tags, each a single field element (< 2^120):

```
DOMAIN_COMMITMENT = 0x5645494C5F434F4D4D49544D454E545F5631  ("VEIL_COMMITMENT_V1")
DOMAIN_NULLIFIER  = 0x5645494C5F4E554C4C49464945525F5631  ("VEIL_NULLIFIER_V1")
```

A future commitment format gets a new domain tag (V2), not a silent change.

---

## 3. Commitment design

Hash function: **Poseidon** (circomlib implementation, BN254 scalar field,
arity 16). Poseidon is the standard SNARK-friendly choice for this stack
(circom + snarkjs + Groth16 on BN254); it is collision-resistant in the
random-oracle model used for SNARK applications and cheap enough for the
7.5k-constraint PoC circuit.

```
Commitment = Poseidon16(
    DOMAIN_COMMITMENT,          // [0]  domain separation + version
    positionId,                 // [1]
    collateralAssetLo,          // [2]
    collateralAssetHi,          // [3]
    debtAssetLo,                // [4]
    debtAssetHi,                // [5]
    collateralLo,               // [6]
    collateralHi,               // [7]
    debtLo,                     // [8]
    debtHi,                     // [9]
    interestIndexSnapshotLo,    // [10]
    interestIndexSnapshotHi,    // [11]
    sequence,                   // [12]
    controlSecret,              // [13]
    salt,                       // [14]
    0                           // [15] reserved (zero-padded)
)
```

Properties: deterministic (same state → same commitment — tested), complete
binding of every private field (each field change flips the commitment —
tested), collision-resistant under Poseidon, reproducible off-chain
(`scripts/prove.ts` via circomlibjs with identical constants), and verifiable
inside the circuit (the preimage check is the core constraint). Asset ids are
inside the commitment so later solvency/liquidation proofs can bind private
balances to specific public prices. The asset *identity* of a position is
pinned on-chain at creation (`positions[id].collateralAsset/debtAsset` are
immutable); the hidden assets are bound to that positionId through the
commitment.

---

## 4. Ownership / control model

Control = knowledge of `controlSecret` (a dedicated secret field, **not**
mere knowledge of the commitment preimage as a whole). Concretely, every
transition proof proves simultaneously:

1. the prover knows the full old state (which contains `controlSecret`) that
   hashes to the active on-chain commitment, and
2. the nullifier — a public signal — is derived from `controlSecret`.

So only the holder of the control secret can advance a position's state, and
the secret itself never appears on-chain in any form. There is no plaintext
owner field anywhere. (Phase 3 candidate, documented not implemented:
nullifier-only linkability analysis for view-key / delegation patterns.)

---

## 5. Nullifier / replay model

```
Nullifier = Poseidon6(
    DOMAIN_NULLIFIER,   // [0] domain separation + version
    controlSecret,      // [1]
    positionId,         // [2]
    newSequence,        // [3]  sequence AFTER the transition (old+1)
    actionId,           // [4]  1 = deposit, 2 = repay
    0                   // [5]  reserved
)
```

Soundness argument: the contract enforces `newSequence == sequence + 1` and
the circuit enforces that the nullifier matches `(controlSecret, positionId,
newSequence, actionId)`. A transition id is therefore unique per
(position, sequence, action), and the sequence rule makes each id usable at
most once — a reused id hits `consumedTransitions` and reverts
(`TransitionConsumed`). The on-chain check order is: canonical-field check →
nullifier-consumed check → commitment/sequence binding → index binding →
Groth16 verification; the nullifier is marked consumed **only after** the
proof verifies. Unlinkability: the nullifier shares only `controlSecret` with
the commitment, inside two independently domain-separated hashes, so
nullifiers cannot be linked to commitments without brute-forcing the secret.

---

## 6. State transition circuit

`circuits/state_transition.circom` — 7875 constraints, 9 public inputs, 14
private inputs, Groth16 over BN254.

The circuit proves:

1. knowledge of the old private state;
2. `Poseidon(old state) == oldCommitment` (preimage check);
3. control via `controlSecret` (see §4);
4. the transition is valid for the claimed action;
5. `newSequence == oldSequence + 1`;
6. `Poseidon(new state) == newCommitment`;
7. the nullifier is correctly derived;
8. internal consistency of all values (limb recombination, ranges);
9. the action rules below hold.

### Transition rules (deposit = actionId 1)

```
newCollateral   = oldCollateral + publicAmount
accruedDebt     = ceil(oldDebt * currentIndex / oldIndex)
newDebt         = accruedDebt
newIndexSnapshot= currentIndex
```

### Transition rules (repay = actionId 2)

```
accruedDebt     = ceil(oldDebt * currentIndex / oldIndex)
newDebt         = max(accruedDebt - publicAmount, 0)
newCollateral   = oldCollateral
newIndexSnapshot= currentIndex
```

`publicAmount` is public by design: it is the amount moved at the ERC20
layer, which is not confidential (see §10). Only the resulting *cumulative*
balances stay private. Action set is constrained to {1, 2} in-circuit
(`isDeposit + isRepay === 1`).

### Interest accounting in ZK (exact)

```
accruedDebt = ceil(oldDebt * currentIndex / oldIndex)
```

Implemented as integer `CeilDiv(200)`: a witness hint provides
`floor(a·b/c)`; constraints force `a·b = q'·c + r` with `0 ≤ r < c`
(both range-checked), and the ceiling is applied iff `r > 0`. No
floating-point approximation anywhere. Boundary: `currentIndex` must be
non-zero and ≥ the position's snapshot (monotone index). All products stay
below 2^254 given the 200-bit input ranges — conservative for the PoC and
tested at the boundaries (exact division, +1 remainder, overflow rejection).

---

## 7. Public signals — exact order (the Solidity verifier depends on it)

```
[0] positionId
[1] oldCommitment
[2] newCommitment
[3] nullifier
[4] actionId            (1 = deposit, 2 = repay)
[5] newSequence
[6] currentIndexLo      (currentIndex = lo + hi·2^120)
[7] currentIndexHi
[8] publicAmount
```

The contract reassembles `pubSignals` in exactly this order for the Groth16
call (`VeilLend._applyVerifiedTransition`), and an integration test pins the
order against snarkjs output.

## 8. Private signals

`oldCollateralAssetLo/Hi, oldDebtAssetLo/Hi, oldCollateralLo/Hi,
oldDebtLo/Hi, oldIndexLo/Hi, oldSequence, controlSecret, oldSalt, newSalt`
(14 witness values). Nothing here is ever public; the prover holds them.

---

## 9. On-chain integration & custody binding

`VeilLend.deposit(t, pA, pB, pC)` / `VeilLend.repay(t, pA, pB, pC)` run the
shared pipeline `_applyVerifiedTransition`:

1. all inputs canonical (< field order), non-zero amount, action matches the
   entry point, position active;
2. nullifier unused; oldCommitment == active commitment; newSequence ==
   sequence + 1;
3. `currentIndex` equals the contract's current debt index (`StaleIndex`
   otherwise — proofs cannot be banked against future indexes);
4. Groth16 verification via the **immutable** verifier
   (`contracts/zk/Groth16Verifier.sol`, generated by snarkjs);
5. only then: consume nullifier, update commitment/sequence/snapshot, pull
   the ERC20 amount (exact-amount check rejects fee-on-transfer drift), bump
   `collateralCustody` / `debtCustody`, emit events.

**Deposit binding (the Phase 2 goal):** the proof forces the hidden
collateral to grow by exactly `publicAmount`, and the contract pulls exactly
`publicAmount` into custody. Therefore for every supported asset:

```
collateralCustody(asset) == Σ hidden collateral of all positions  (tested invariant)
                     == token.balanceOf(VeilLend)
```

The per-position split stays hidden: on-chain state stores only the
aggregate. `debtCustody(asset)` similarly accumulates repaid tokens
(protocol reserve until the private supply side exists).

**Borrow / withdraw:** fully implemented (Phase 3) — proof-gated via
`_applyVerifiedRiskTransition` with on-chain-derived prices/LTV and 1:1
custody payouts. **Close:** remains fail-closed (`UnsupportedAction`) —
the settlement path is not implemented. No plaintext fallback exists for
any of them.

---

## 10. Privacy boundary — what is actually private

| Data | Status |
|---|---|
| Cumulative collateral per position | **private** (inside commitment) |
| Cumulative debt + accrued interest per position | **private** (inside commitment) |
| Health factor / solvency state | **private** (no on-chain analog exists) |
| Position ↔ user identity | **not recorded** (control secret only) |
| Sequence, index snapshot, commitment hashes | public |
| Per-action deposit/repay **amount** | **public** (ERC20 transfer layer) |
| Timing/graph of transactions | public (standard blockchain) |

This is **not** transaction-private: an observer sees who deposited what
when. What they cannot see is the resulting position — total collateral,
total debt, interest burden, health — or whether any two commitments belong
to the same user. Full amount confidentiality would require shielded-flow
constructs, out of scope.

---

## 10b. Phase 3 — solvency, risk transitions, confidential liquidation

Four circuits, all including the shared veillend_lib.circom (single source
of the commitment/nullifier constructions — no duplication):

| Circuit | Constraints | Public signals (exact order) |
|---|---|---|
| state_transition (deposit=1, repay=2) | 7875 | positionId, oldCommitment, newCommitment, nullifier, actionId, newSequence, currentIndexLo, currentIndexHi, publicAmount |
| solvency | ~2.8k | positionId, positionCommitment, collateralPrice, debtPrice, maxLtvBps |
| risk_transition (borrow=3, withdraw=4) | ~7.5k | the 9 transition fields + collateralPrice, debtPrice, maxLtvBps, **recipient** |
| liquidation | ~3.5k | collateralOut, debtOut, positionId, positionCommitment, collateralPrice, debtPrice, liquidationThresholdBps, **recipient** |

**Recipient binding (F5):** every outbound value-moving circuit commits the
authorized payout recipient (a uint160 address, public by design) as a
public input, range-checked in-circuit (`Num2Bits(160)`). The contract
DERIVES this input from `msg.sender` — callers cannot supply it — so a proof
generated for wallet A verifies only in a transaction from wallet A: copied
mempool proofs cannot redirect value. Deposit/repay (state_transition) move
value INBOUND from the submitter and are deliberately unchanged (Phase 2
byte-compatible interface). Consequence: payouts always go to the
transaction sender; meta-relaying for smart-contract wallets is future work.

**Price normalization (multi-decimals support):** the contract feeds the
circuits 18-dec-NORMALIZED prices — `normalized = raw oracle price ×
10^(18 − decimals)` — so `colAtomic × normalizedPrice` reduces to the
position's dollar value for ANY supported token decimals (6..18, enforced at
enable time). The circuits' price range checks were widened accordingly
(2^64 → 2^104) and the value comparators to 223 bits. For 18-decimals tokens
the normalization is the identity (backward compatible).

Key relations (cross-multiplied, integer-exact — full fixed-point convention
in docs/solvency-model.md):

```text
solvent:    collateral*collPrice*10000 >= debt*debtPrice*maxLtvBps
eligible:   collateral*collPrice*10000 <  debt*debtPrice*liquidationThresholdBps  (strict)
accrual:    accrued = ceil(oldDebt*currentIndex/oldIndex)                        (exact CeilDiv)
borrow:     newDebt = accrued + amount       (post-action solvency enforced in-circuit)
withdraw:   newCollateral = oldCollateral - amount  (post-action solvency enforced in-circuit)
settlement: collateralOut = collateral; debtOut = min(debt, ceil(collateral*collPrice/debtPrice))
```

On-chain: four immutable Groth16 verifiers (contracts/zk/). borrow and
withdrawCollateral pay out 1:1 from aggregate custody
(debtCustody / collateralCustody); liquidate seizes the entire hidden
collateral against the parity debt payment and closes the position.
closePosition remains the only fail-closed-unimplemented action.

## 11. Emergency pause, access control, oracle

Unchanged from Phase 1 (see git history / earlier revision for the full
tables). Summary:

- Pause blocks every proof-bound state transition (deposit/repay/borrow/
  withdraw) and liquidation; accrual, position creation and views stay
  available. Only closePosition remains fail-closed-unimplemented
  (UnsupportedAction). No custody backdoor exists behind the pause.
- Admin (`Ownable2StepUpgradeable`) manages parameters/assets/oracle/
  staleness/pause only. No fund-moving function exists (ABI whitelist test).
- UUPS upgrade authority is owner-only (`_authorizeUpgrade`); the upgrade
  swaps implementation code and adds no fund-moving capability (enforced by
  the ABI-whitelist and upgrade tests).
- Oracle boundary `getFreshPrice` enforces freshness; borrow, withdraw and
  liquidate gate on it on-chain (stale/absent prices revert).

---

## 12. Reproducibility

```bash
npm run zk:build   # compile circuits → ptau (2^14) → zkeys → Groth16 verifiers
npm run prove      # private state → commitment → proof → local verification
npm test           # full suite (unit + ZK + fuzz/invariant)
```

Trusted setup: single deterministic contribution, PoC only — a real
multi-party ceremony is required before any mainnet-style deployment
(documented limitation, not a claim of readiness).

---

## 13. Phase 3 limitations (explicit)

1. **No liquidation incentive/bonus**; residual hidden debt at settlement is
   socialized bad debt with no reserve accounting yet.
2. **Witness availability**: solvency/liquidation proofs require the private
   witness; decentralized witness disclosure (keepers) is future work.
3. **Single-oracle trust model** and admin-set risk parameters
   (docs/oracle-model.md).
4. **No borrowable-liquidity supply side beyond repayments** — the borrow
   reserve is debtCustody only.
5. **Per-action amounts public** (see §10); fee-on-transfer tokens rejected.
6. **Trusted setup is a single deterministic contribution** (PoC); circuits
   unaudited.
7. **Horizen Testnet deployment (current).** Standard EVM bytecode
   (`evmVersion: paris`) kept the stack deployable across Horizen
   environments; the full protocol is deployed and Blockscout-verified (see
   README / deployments). The CURRENT official Testnet deployment is the UUPS
   upgradeable deployment (ERC-1967 proxy `0xc1e2…4a5B`, owner-only
   `_authorizeUpgrade`, `deployments/horizenTestnet-uups.json`). The M1
   non-proxy deployment remains historical and was never upgraded. Testnet
   demo pricing currently runs through an owner-gated oracle fed by an
   isolated Base-Chainlink relay (testnet/demo only); the Stork adapter with
   WETHUSD/USDCUSD feeds is deployed and is the intended production path.

---

## 14. Historical framing note (written during Phase 3)

> **This section is a historical framing written while Phase 3 was the next
> unfinished phase.** Its content — the solvency/borrow/withdraw/liquidation
> plan below — was subsequently implemented and is part of the current
> architecture (§10b). The project's actual forward-looking plan now lives in
> [`docs/milestones.md`](docs/milestones.md) (M1 CLOSED; M2 Security &
> Production Hardening in progress) and
> [`docs/roadmap.md`](docs/roadmap.md). Nothing in this section changes the
> current state: the current Testnet deployment is the UUPS deployment
> (§7.7), with the Stork adapter as the intended production oracle and a
> Testnet/Demo-only Base-Chainlink relay (see
> [`docs/oracle-model.md`](docs/oracle-model.md) §5) while Stork testnet
> publishing is pending.

**Phase 3 — Confidential Liquidation readiness:** solvency proof circuit
(private collateral/debt vs public oracle prices + public threshold),
borrow/withdraw transitions gated on it, then liquidation-eligibility proofs
and confidential liquidation. The commitment/nullifier/transition machinery
from this phase carries over unchanged.

Repository structure (current):

```text
VeilLend/
├── circuits/
│   ├── veillend_lib.circom       # shared commitment/nullifier/arithmetic templates
│   ├── state_transition.circom   # deposit / repay
│   ├── solvency.circom           # private solvency proof
│   ├── risk_transition.circom    # borrow / withdraw with post-action solvency
│   └── liquidation.circom        # eligibility + settlement outputs
├── contracts/
│   ├── VeilLend.sol              # protocol surface + 4 Groth16 verifier integrations (UUPS)
│   ├── oracles/                  # IPriceOracle, StorkPriceOracle, IStork, StorkStructs
│   ├── zk/                       # generated, real verifiers (4)
│   └── test/                     # TokenMock, MockPriceOracle, MockStorkOracle (test-only)
├── scripts/
│   ├── prove.ts                  # prover library + zk:build + local demo
│   ├── deploy.ts                 # Horizen Testnet deployment (full stack)
│   ├── deploy-riskfix.ts         # repaired deployment (fixed risk verifier + VeilLend)
│   ├── e2e-riskfix.ts            # resumable lifecycle E2E (deploy → verify → reconcile)
│   ├── proof-test.ts             # on-chain ZK proof integration test
│   ├── liquidation-test.ts       # on-chain confidential liquidation test
│   └── verify-network.ts         # read-only network/deployment precheck
├── relay/                        # TESTNET/DEMO ONLY: Base Chainlink -> Horizen OwnerMockPriceOracle relay (temporary; Stork is production)
test/                         # unit / ZK / solvency / risk / risk-gate / adversarial / liquidation / fuzz
├── demo/                         # Next.js browser app (in-browser Groth16 proving)
│   ├── app/                      # main page + /recovery-test + /sigtest
│   ├── lib/                      # witness/poseidon/recovery/store/tx guard
│   ├── public/zk/                # browser proving artifacts (wasm/zkey)
│   ├── tests/                    # persistence / recovery / signature-determinism
│   └── README.md
├── deployments/                  # address book + deployment/E2E evidence records
├── docs/                         # milestones, roadmap, models, evidence packages
├── architecture.md               # this document
├── README.md
├── LICENSE                       # MIT (verifiers: GPL-3.0 per their headers)
├── hardhat.config.ts
├── package.json
└── tsconfig.json
```
