# VeilLend — Phase 3 Report (ZK Solvency, Borrow/Withdraw, Confidential Liquidation)

Status: implemented and tested. Phase 2 behavior preserved. Nothing is
deployed to Horizen; the trusted setup remains a single deterministic
contribution (PoC); the circuits are unaudited.

## What was built

```text
Private Collateral + Private Debt  (Poseidon commitment, unchanged from Phase 2)
        + Public Oracle Prices     (getFreshPrice, 1e8 fixed-point, freshness-enforced)
        + Public Risk Parameters   (maxLtvBps, liquidationThresholdBps per debt asset)
        ↓
ZK Solvency Proof                  (circuits/solvency.circom)
        ↓
ZK Borrow / Withdraw Transitions   (circuits/risk_transition.circom)
        ↓
ZK Liquidation Eligibility Proof   (circuits/liquidation.circom)
        ↓
Confidential Settlement            (VeilLend.liquidate → Closed)
```

## Milestones

### Milestone 1 — solvency proof

- Shared circuit library `circuits/veillend_lib.circom` extracted
  (StateCommitment, TransitionNullifier, Split200, RangeCheck, CeilDiv, Min);
  all circuits include it — zero duplication of commitment logic.
- `circuits/solvency.circom` (public: positionId, positionCommitment,
  collateralPrice, debtPrice, maxLtvBps): proves
  `collateral·collPrice·10000 ≥ debt·debtPrice·maxLtvBps` over the hidden
  state bound to the active commitment. Cross-multiplied, no division.
- Contract: `verifySolvency(positionId, proof)` — derives ALL public inputs
  on-chain (commitment, fresh prices, configured LTV); callers cannot aim
  proofs at other positions/states/prices.
- **Real bug found and fixed by the new tests:** the limb-recombination
  constant was 2^96 instead of the documented 2^120. Invisible in Phase 2
  (all tested values fit the low limb) but a genuine encoding divergence for
  large balances. Fixed in all circuits; artifacts rebuilt.

### Milestone 2 — borrow / withdraw

- `circuits/risk_transition.circom` (12 public signals): borrow (actionId 3)
  and withdraw (4) as full private state transitions with the POST-action
  solvency relation enforced in-circuit — an unsafe borrow/withdraw is
  unprovable, not merely rejected.
- Contract: `borrow`/`withdrawCollateral` verify the proof with on-chain-
  derived prices/LTV, consume the nullifier, advance the commitment, and pay
  out 1:1 from custody (`debtCustody` / `collateralCustody`). Borrow
  liquidity = repayment-funded reserve; `InsufficientLiquidity` otherwise.

### Milestone 3 — confidential liquidation

- `circuits/liquidation.circom`: eligibility
  `colValue·10000 < debtValue·threshold` (strict) over hidden state, with
  settlement amounts (`collateralOut` = full hidden collateral, `debtOut` =
  min(debt, parity value)) as circuit outputs / public signals.
- Contract: `liquidate(positionId, collateralOut, debtOut, proof)` —
  verifies, moves custody 1:1, pulls the settlement debt from the liquidator,
  closes the position, emits `Liquidated`. Permissionless submission;
  pause-gated; replay-proof (closed positions are inert).
- Honest boundary: proof generation needs the private witness, so witness
  disclosure/keeper infrastructure for fully decentralized liquidation is
  future work. Residual debt at settlement is socialized bad debt (PoC).

### Milestone 4 — security testing & docs

- New suites: `test/solvency.test.ts` (11), `test/risk.test.ts` (7),
  `test/liquidation.test.ts` (9), Phase 3 invariant block in the fuzz
  harness (3), plus Phase 2 suites kept green.
- **Recipient binding (post-review hardening, F5):** borrow / withdraw /
  liquidate proofs commit the authorized recipient (public circuit input,
  `Num2Bits(160)`); the contract derives it from `msg.sender`, making copied
  mempool proofs unusable. Phase 2's deposit/repay circuit is unchanged.
- Docs: `docs/solvency-model.md`, `docs/oracle-model.md`,
  `docs/liquidation-model.md`, this file; `architecture.md` and `README.md`
  updated.

## Invariants established (and tested)

1. A position cannot become borrowable unless the ZK condition holds —
   over-leveraging borrows are unprovable (witness-level + on-chain).
2. A withdrawal cannot bypass solvency — unsafe withdrawals are unprovable.
3. Liquidation cannot execute unless eligibility is proven — junk proofs
   always revert; healthy positions are unprovable.
4. A proof for commitment A never authorizes commitment B — the commitment
   is a public input derived on-chain (tested cross-position, cross-state).
5. Private collateral/debt never appear as public state or events — struct
   shape + ABI whitelist + signal-order tests.
6. Invalid/stale oracle data cannot authorize risky transitions —
   `StalePrice` fires before any proof logic.
7. Every accepted transition produces the correct new commitment — the fuzz
   harness recomputes commitments every action across randomized sequences.

## Known limitations / production gaps

- Single-oracle trust model (see oracle-model.md); admin-set risk params.
- No liquidation incentive/bonus; residual debt socialized; no reserve
  accounting for bad debt.
- Witness availability for liquidation is not decentralized yet.
- Deterministic single-contribution trusted setup; unaudited; not deployed.
- Per-action amounts are public (ERC20 layer) — position privacy, not
  transaction privacy.
