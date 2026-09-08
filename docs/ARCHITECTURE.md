# VeilLend — Architecture

> **VeilLend — Privacy-first confidential lending for the Horizen ecosystem.**
>
> This is the single design reference: the privacy model, the exact ZK
> constructions in use, the solvency/liquidation design, the oracle design,
> and the honest boundary between what is private and what is public.
> Statuses are honest: nothing claims to be complete if it is not.
> Milestone status lives in [`docs/MILESTONES.md`](MILESTONES.md).

---

## 1. Core flow

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

**Integer encoding:** every value is `value = lo + hi·2^120` with `lo < 2^120`,
`hi < 2^80` (so `value < 2^200`). The BN254 scalar field (`r ≈ 2^254`) hosts
all of it with margin. The 200-bit ceiling is range-constrained in-circuit
(`Num2Bits(200)` on the recombined value), so no limb aliasing or overflow is
possible. A 160-bit address splits into the same lo/hi limb form off-chain;
exactly one canonical encoding exists per value (the circuit rejects any
non-canonical split because recombination is constrained through the bit
decomposition).

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
arity 16) — the standard SNARK-friendly choice for this stack (circom +
snarkjs + Groth16 on BN254).

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
inside the commitment so solvency/liquidation proofs bind private balances to
specific public prices. The asset *identity* of a position is pinned on-chain
at creation (`positions[id].collateralAsset/debtAsset` are immutable); the
hidden assets are bound to that positionId through the commitment.

---

## 4. Ownership / control model

Control = knowledge of `controlSecret` (a dedicated secret field, **not** mere
knowledge of the commitment preimage as a whole). Every transition proof
proves simultaneously:

1. the prover knows the full old state (which contains `controlSecret`) that
   hashes to the active on-chain commitment, and
2. the nullifier — a public signal — is derived from `controlSecret`.

Only the holder of the control secret can advance a position's state, and the
secret never appears on-chain in any form. There is no plaintext owner field
anywhere. (Documented, not implemented: nullifier-only linkability analysis
for view-key / delegation patterns.)

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

**Soundness:** the contract enforces `newSequence == sequence + 1` and the
circuit enforces that the nullifier matches `(controlSecret, positionId,
newSequence, actionId)`. A transition id is unique per
(position, sequence, action), and the sequence rule makes each id usable at
most once — a reused id hits `consumedTransitions` and reverts
(`TransitionConsumed`). The on-chain check order is: canonical-field check →
nullifier-consumed check → commitment/sequence binding → index binding →
Groth16 verification; the nullifier is marked consumed **only after** the
proof verifies. **Unlinkability:** the nullifier shares only `controlSecret`
with the commitment, inside two independently domain-separated hashes, so
nullifiers cannot be linked to commitments without brute-forcing the secret.

---

## 6. State transition circuit (deposit / repay)

`circuits/state_transition.circom` — 7875 constraints, 9 public inputs,
14 private inputs, Groth16 over BN254. It proves:

1. knowledge of the old private state;
2. `Poseidon(old state) == oldCommitment` (preimage check);
3. control via `controlSecret` (§4);
4. the transition is valid for the claimed action;
5. `newSequence == oldSequence + 1`;
6. `Poseidon(new state) == newCommitment`;
7. the nullifier is correctly derived;
8. internal consistency of all values (limb recombination, ranges);
9. the action rules below hold.

### Deposit (actionId 1)

```
newCollateral   = oldCollateral + publicAmount
accruedDebt     = ceil(oldDebt * currentIndex / oldIndex)
newDebt         = accruedDebt
newIndexSnapshot= currentIndex
```

### Repay (actionId 2)

```
accruedDebt     = ceil(oldDebt * currentIndex / oldIndex)
newDebt         = max(accruedDebt - publicAmount, 0)
newCollateral   = oldCollateral
newIndexSnapshot= currentIndex
```

`publicAmount` is public by design: it is the amount moved at the ERC20 layer,
which is not confidential (§10). Only the resulting *cumulative* balances stay
private. The action set is constrained to {1, 2} in-circuit
(`isDeposit + isRepay === 1`).

### Interest accounting in ZK (exact)

```
accruedDebt = ceil(oldDebt * currentIndex / oldIndex)
```

Implemented as integer `CeilDiv(200)`: a witness hint provides `floor(a·b/c)`;
constraints force `a·b = q'·c + r` with `0 ≤ r < c` (both range-checked), and
the ceiling is applied iff `r > 0`. No floating point anywhere. Boundary:
`currentIndex` must be non-zero and ≥ the position's snapshot (monotone
index). All products stay below 2^254 given the 200-bit input ranges — tested
at the boundaries (exact division, +1 remainder, overflow rejection).

### Public signals — exact order (the Solidity verifier depends on it)

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
call (`VeilLend._applyVerifiedTransition`); an integration test pins the order
against snarkjs output.

### Private signals

`oldCollateralAssetLo/Hi, oldDebtAssetLo/Hi, oldCollateralLo/Hi,
oldDebtLo/Hi, oldIndexLo/Hi, oldSequence, controlSecret, oldSalt, newSalt`
(14 witness values). Nothing here is ever public.

---

## 7. On-chain integration & custody binding

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
5. only then: consume nullifier, update commitment/sequence/snapshot, pull the
   ERC20 amount (exact-amount check rejects fee-on-transfer drift), bump
   `collateralCustody` / `debtCustody`, emit events.

**Deposit binding:** the proof forces the hidden collateral to grow by exactly
`publicAmount`, and the contract pulls exactly `publicAmount` into custody.
Therefore for every supported asset:

```
collateralCustody(asset) == Σ hidden collateral of all positions  (tested invariant)
                     == token.balanceOf(VeilLend)
```

The per-position split stays hidden: on-chain state stores only the aggregate.
`debtCustody(asset)` similarly accumulates repaid tokens (protocol reserve
until the private supply side exists). `closePosition` remains the only
fail-closed-unimplemented action (`UnsupportedAction`) — no plaintext fallback
exists for any action.

---

## 8. Privacy boundary — what is actually private

| Data | Status |
|---|---|
| Cumulative collateral per position | **private** (inside commitment) |
| Cumulative debt + accrued interest per position | **private** (inside commitment) |
| Health factor / solvency state | **private** (no on-chain analog exists) |
| Position ↔ user identity | **not recorded** (control secret only) |
| Sequence, index snapshot, commitment hashes | public |
| Per-action deposit/repay/borrow/withdraw **amount** | **public** (ERC20 transfer layer) |
| Timing/graph of transactions | public (standard blockchain) |

This is **not** transaction-private: an observer sees who moved what when.
What they cannot see is the resulting position — total collateral, total debt,
interest burden, health — or whether any two commitments belong to the same
user. Full amount confidentiality would require shielded-flow constructs, out
of scope.

---

## 9. Risk transitions & confidential liquidation (circuit set)

Four circuits, all including the shared `veillend_lib.circom` (single source
of the commitment/nullifier constructions — no duplication):

| Circuit | Constraints | Public signals (exact order) |
|---|---|---|
| state_transition (deposit=1, repay=2) | 7875 | positionId, oldCommitment, newCommitment, nullifier, actionId, newSequence, currentIndexLo, currentIndexHi, publicAmount |
| solvency | ~2.8k | positionId, positionCommitment, collateralPrice, debtPrice, maxLtvBps |
| risk_transition (borrow=3, withdraw=4) | ~7.5k | the 9 transition fields + collateralPrice, debtPrice, maxLtvBps, **recipient** |
| liquidation | ~3.5k | collateralOut, debtOut, positionId, positionCommitment, collateralPrice, debtPrice, liquidationThresholdBps, **recipient** |

**Recipient binding:** every outbound value-moving circuit commits the
authorized payout recipient (uint160, public by design) as a public input,
range-checked in-circuit (`Num2Bits(160)`). The contract DERIVES this input
from `msg.sender` — callers cannot supply it — so a proof generated for wallet
A verifies only in a transaction from wallet A: copied mempool proofs cannot
redirect value. Deposit/repay move value INBOUND and are deliberately
unchanged. Consequence: payouts always go to the transaction sender;
meta-relaying for smart-contract wallets is future work.

**Price normalization (multi-decimals):** the contract feeds the circuits
18-dec-NORMALIZED prices — `normalized = raw oracle price × 10^(18 − decimals)`
— so `colAtomic × normalizedPrice` reduces to the position's dollar value for
ANY supported token decimals (6..18, enforced at enable time). The circuits'
price range checks were widened accordingly (2^64 → 2^104) and the value
comparators to 223 bits. For 18-decimals tokens the normalization is the
identity (backward compatible).

### 9.1 Solvency model

A private position `(collateral, debt)` — both hidden inside the commitment —
is **solvent** iff:

```text
collateral * collateralPrice * 10_000  >=  debt * debtPrice * maxLtvBps
```

and **liquidation-eligible** iff (strict):

```text
collateral * collateralPrice * 10_000  <   debt * debtPrice * liquidationThresholdBps
```

Both relations are cross-multiplied: **no division** anywhere in the circuits.
`risk_transition.circom` embeds the solvency relation on the POST-transition
balances, so an unsafe transition is not merely rejected — it is *unprovable*.

Fixed-point precision (exact convention):

| Quantity | Representation | Range constraint (in-circuit) |
|---|---|---|
| Token amounts (collateral, debt) | token atomic units | < 2^128 |
| Oracle prices | fixed-point, 1e8 scale (ChainLink-style) | < 2^64 raw; < 2^104 normalized |
| LTV / thresholds | basis points, implicit denominator 10000 | ≤ 10000 |
| Full inequality terms | "atomic·price·bps" | < 2^206, compared in 207 bits |

Rounding: only the debt **accrual** division rounds (exact `CeilDiv`). The
solvency/eligibility inequalities themselves are exact integer comparisons.
The Solidity side interprets prices with the same 1e8 convention and LTV in
bps; the interpretation never appears in Solidity arithmetic — the contract
only passes the values as public inputs, so circuit/Solidity consistency
reduces to passing identical integers.

With normalization, `colAtomic × normalizedPrice = position dollars × 1e26`
for ANY token decimals, so mixed-decimals collateral/debt pairs compare exact
dollar values. For 18-decimals tokens the normalization is the identity.

**Commitment binding:** every circuit recomputes
`Poseidon16(old private state) == positionCommitment` via the shared
`StateCommitment` template — the same construction the contract stores.
Consequences: a proof is bound to one position and one state version (tested
cross-position, cross-state); a stale proof cannot be replayed after the state
advances (`InvalidCommitment`/`InvalidProof`); `positionId` and asset ids are
inside the hash, binding hidden balances to the on-chain asset pair.

### 9.2 Borrow authorization (actionId 3)

```text
accrued  = ceil(oldDebt * currentIndex / oldIndex)
newDebt  = accrued + borrowAmount
newCollateral = oldCollateral
require: newCollateral·collPrice·10000 ≥ newDebt·debtPrice·maxLtvBps
```

On-chain, after proof verification: nullifier consumed, commitment/sequence/
snapshot advanced, `borrowAmount` paid out of `debtCustody[debtAsset]` (the
repayment-funded reserve). If the reserve is short the transaction reverts
(`InsufficientLiquidity`) — the proof alone never creates liquidity.

### 9.3 Withdraw authorization (actionId 4)

```text
accrued  = ceil(oldDebt * currentIndex / oldIndex)
newCollateral = oldCollateral - withdrawAmount   (amount ≤ oldCollateral in-circuit)
newDebt  = accrued
require: newCollateral·collPrice·10000 ≥ newDebt·debtPrice·maxLtvBps
```

Custody decreases 1:1 with the hidden collateral; tokens transfer to the
submitter (recipient-bound). A withdrawal that would leave the position
under-collateralized cannot be proven at all.

### 9.4 Confidential liquidation

Eligibility is proven over the **hidden** balances bound to the commitment
(strict inequality — a position exactly at the threshold is NOT eligible).
Settlement amounts are computed **in-circuit** and output as public signals:

```text
collateralOut = collateral                                   (entire hidden collateral)
debtOut       = min(debt, ceil(collateral * collateralPrice / debtPrice))
```

`collateralOut`/`debtOut` are public signals: the tokens they denote move at
the public ERC20 layer in the settlement anyway, so publishing them reveals
nothing beyond what the settlement itself shows. Parity pricing: the liquidator
pays exactly the debt-value of the seized collateral (capped at the full hidden
debt). **No liquidation bonus/incentive** — documented limitation. Residual
hidden debt (`debt − debtOut`) is written off when the position closes:
**socialized bad debt**, absorbed by the protocol in this PoC (no reserve/loss
accounting yet).

Settlement flow (`VeilLend.liquidate`): canonicality + amount checks →
position Active + fresh prices + configured threshold → public signals built
on-chain → Groth16 verify (`InvalidProof` on failure) → custody moves 1:1,
debt pulled from the liquidator, position → Closed, collateral transferred,
`Liquidated` emitted. `liquidate` is `whenNotPaused`; replay-proof (closed
positions are inert, `PositionNotActive`); recipient-bound to `msg.sender`.

**Who knows what:**

| Party | Knows |
|---|---|
| Liquidator | prices, threshold, the proof, and the public settlement amounts; **NOT** the private balances, control secret, or pre-settlement state detail |
| Contract / observers | position id, commitment hash, prices, threshold, settlement amounts, that eligibility was proven |
| Verifier | only the 8 public signals — hidden state enters solely through the Groth16 verification equation |
| Position owner | the private state; generates the eligibility proof |

**Honest boundary:** the eligibility proof requires the position's **private
witness**, so today only the control-secret holder (or whoever they disclose
the witness to) can produce it. Fully permissionless/decentralized liquidation
requires a witness-disclosure mechanism (encrypted witness streams / keeper
network) that is explicitly **out of scope** — no liquidation service, backend,
or witness distribution is built. The existing commitment already binds
everything a more expressive liquidation needs (partial liquidations with
user-approved new commitments, dutch-auction settlement, bad-debt accounting);
extensions are additional circuit actions and contract settlement policies.

---

## 10. Oracle design

Intentionally minimal but architecturally correct: **one price source per
asset behind a single interface, with on-chain freshness enforcement.** No
aggregation, no routing, no multi-provider quorum — production concerns
deliberately out of scope.

```solidity
interface IPriceOracle {
    function getPrice(address asset) external view returns (uint256 price, uint256 updatedAt);
}
```

- `price`: fixed-point, **1e8 scale** (same convention as ChainLink USD
  feeds), constrained `< 2^64` raw inside ZK circuits.
- `updatedAt`: unix timestamp of the observation.

`VeilLend.getFreshPrice(asset)` fails closed:

| Condition | Error |
|---|---|
| no oracle configured | `OracleNotSet` |
| `price == 0` | `InvalidPrice` |
| `updatedAt` in the future | `InvalidPrice` |
| `block.timestamp - updatedAt > maxPriceStaleness` (admin-set, default 1h) | `StalePrice` |

Every risky operation reads prices through `getFreshPrice` and passes them
into the Groth16 verifier as public inputs **in the same transaction** —
invalid or stale oracle data cannot authorize a risky transition (a proof
computed against different prices simply reverts; the submitter re-proves).

### 10.1 Trust assumptions (explicit)

1. **Single oracle, admin-set.** The owner can change the oracle (`setOracle`)
   and the staleness window. A compromised oracle can manipulate
   solvency/liquidation outcomes for proofs generated after the manipulation —
   the standard PoC trust model; the admin still cannot touch custody.
2. **Prices are public inputs** — only the balances they multiply remain
   private.
3. **Timestamp trust:** `updatedAt` is reported by the oracle itself.
4. **Decimal normalization** (§9).

### 10.2 Two distinct Testnet/production paths — do not mix

**Testnet/Demo path (TEMPORARY, NOT production):**

```text
Base Mainnet Chainlink (ETH/USD 0x50015f8b17fb2C290Dde41fDc246ed0dcEE93a8b, USDC/USD 0x01Bab8761d882A3d34690f515EB3126455501bB5)
        ↓
relay/base-price-relay.mjs (isolated, server-side owner key, no user price input)
        ↓
OwnerMockPriceOracle (owner-gated, 0x024CF745c737B74f8BCc84d1C73687853310b715) on Horizen Testnet
        ↓
VeilLend (via the existing owner-only setOracle)
```

This exists ONLY to make the current Testnet deployment usable while Stork
testnet feeds have no active publisher. Not production-secure, not a Stork
replacement; isolated in `relay/` so it can be deleted without touching
VeilLend. The M1-era `MockPriceOracle` (permissionless `setPrice`) is orphaned
— the protocol no longer points at it.

**Production path (intended):**

```text
Stork signed data  →  Stork on-chain update (pushOracleUpdate, permissionless)
        ↓
VeilLend (StorkPriceOracle adapter: WETH → WETHUSD, USDC → USDCUSD)
```

### 10.3 Stork integration (deployed; publishing pending)

Implemented behind the same freshness/bounds interface: `IPriceOracle` →
`StorkPriceOracle` adapter → official Stork contract interface
(`IStork`/`StorkStructs`), registry feed IDs for WETHUSD/USDCUSD, owner-only
per-asset feed registration, and a permissionless same-transaction flow — a
publisher-signed snapshot is relayed through `VeilLend.pushOracleUpdate` and
consumed by the user's ZK proof in one transaction. Local tests cover the full
path against the mocked Stork interface (`test/stork-integration.test.ts`).

The adapter is deployed on Testnet (`0xa2c0a60B4A360e88cA5f90860A3B75A3DDfED33D`) and wired to the real Stork
contract with the official feeds (WETH → WETHUSD
`0x8afba5f1a5d4969d23c3b42db1b88f8a9c8176392de5bf066752260478ce82b8`, USDC →
USDCUSD `0x7416a56f222e196d0487dce8a1a8003936862e7a15092a91898d69fa8bce290c`);
it becomes the active oracle once Stork
testnet publishing starts (no subscriber relayer operates on Horizen yet —
Stork's data API requires subscriber credentials). Multi-source aggregation,
deviation/heartbeat checks, sequencer/uptime feeds, and liquidation-grade
price safety are deliberately NOT built; the `IPriceOracle` + freshness
boundary is the seam where a real oracle network plugs in without touching
circuits or position state.

---

## 11. Emergency pause, access control, upgradeability

- Pause blocks every proof-bound state transition (deposit/repay/borrow/
  withdraw) and liquidation; accrual, position creation and views stay
  available. Only `closePosition` remains fail-closed-unimplemented. **No
  custody backdoor exists behind the pause.**
- Admin (`Ownable2StepUpgradeable`) manages parameters/assets/oracle/
  staleness/pause only. **No fund-moving function exists** (ABI whitelist
  test).
- UUPS upgrade authority is owner-only (`_authorizeUpgrade`); the upgrade
  swaps implementation code and adds no fund-moving capability (enforced by
  ABI-whitelist and upgrade tests). No multisig/timelock governance yet —
  tracked as M2 hardening work.
- Oracle boundary `getFreshPrice` enforces freshness; borrow, withdraw and
  liquidate gate on it on-chain.

---

## 12. Trust boundaries & important constraints (summary)

| Boundary | Constraint |
|---|---|
| Position control | knowledge of `controlSecret` only; no plaintext owner on-chain |
| Custody | `Σ supportedCollateral == collateralCustody == balanceOf(VeilLend)` per asset (tested invariant) |
| Borrowing | in-circuit post-action solvency AND on-chain value-based borrow cap (`BorrowCapExceeded`) |
| Liquidation | only eligible positions; replay-proof; recipient-bound; residual debt socialized (PoC) |
| Oracle | single source, admin-set; freshness + bounds fail closed |
| Admin | no fund-moving function; owner-only upgrades; no multisig/timelock yet |
| Trusted setup | single deterministic contribution (PoC) — a real ceremony is required before any mainnet-style deployment; circuits unaudited |

## 13. Limitations (explicit)

1. No liquidation incentive/bonus; residual hidden debt is socialized bad debt
   with no reserve accounting yet.
2. Witness availability: solvency/liquidation proofs require the private
   witness; decentralized witness disclosure (keepers) is future work.
3. Single-oracle trust model; admin-set risk parameters (§10.1).
4. No borrowable-liquidity supply side beyond repayments (borrow reserve =
   `debtCustody` only).
5. Per-action amounts public (§8) — position privacy, not transaction privacy.
6. Trusted setup is a single deterministic contribution (PoC); circuits
   unaudited.
7. Testnet-only deployment. The CURRENT official Testnet deployment is the
   UUPS deployment (ERC-1967 proxy `0xc1e2cDADBf14717DfEE7ffA23EAf2b21e6004a5B`); the M1 non-proxy deployment
   is historical and was never upgraded. Testnet demo pricing runs through an
   owner-gated oracle fed by the isolated Base-Chainlink relay (§10.2).

## 14. Reproducibility & repository layout

```bash
npm run zk:build   # compile circuits → ptau (2^14) → zkeys → Groth16 verifiers
npm run prove      # private state → commitment → proof → local verification
npm test           # full suite (unit + ZK + fuzz/invariant)
```

```text
VeilLend/
├── circuits/                     # veillend_lib + state_transition + solvency + risk_transition + liquidation
├── contracts/
│   ├── VeilLend.sol              # protocol surface + 4 Groth16 verifier integrations (UUPS)
│   ├── oracles/                  # IPriceOracle, StorkPriceOracle, IStork, StorkStructs
│   ├── zk/                       # generated, real verifiers (4)
│   └── test/                     # TokenMock, MockPriceOracle, MockStorkOracle (test-only)
├── scripts/                      # prove, deploy*, e2e*, proof-test, liquidation-test, verify-network
├── relay/                        # TESTNET/DEMO ONLY: Base Chainlink → Horizen OwnerMockPriceOracle relay
├── test/                         # unit / ZK / solvency / risk / risk-gate / adversarial / liquidation / fuzz / invariant / upgrade / stork / e2e-lifecycle
├── demo/                         # Next.js browser app (in-browser Groth16 proving)
│   ├── app/                      # main page + /recovery-test + /sigtest
│   ├── lib/                      # witness/poseidon/recovery/store/tx guard (see demo/lib/recovery/README.md)
│   ├── public/zk/                # browser proving artifacts (wasm/zkey)
│   └── tests/                    # persistence / recovery / signature-determinism
├── deployments/                  # address book + deployment/E2E evidence records (JSON)
├── docs/                         # ARCHITECTURE.md (this file), MILESTONES.md
├── README.md
└── LICENSE                       # MIT (verifiers: GPL-3.0 per their headers)
```
