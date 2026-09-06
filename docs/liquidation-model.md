# VeilLend — Liquidation Model (Phase 3, Milestone 3)

## 1. Eligibility (proven in ZK)

A position is liquidation-eligible iff, over the **hidden** balances bound
to the position commitment:

```text
collateral * collateralPrice * 10_000  <  debt * debtPrice * liquidationThresholdBps
```

Strict inequality: a position exactly at the threshold is NOT eligible.
`liquidationThresholdBps` is a public per-debt-asset risk parameter
(admin-set, ≤ 10000). Neither collateral, debt, nor any health value is
revealed — only the binary fact "a valid eligibility proof exists for this
position under these prices/threshold".

## 2. Settlement amounts (computed in-circuit, output as public signals)

```text
collateralOut = collateral                                   (entire hidden collateral)
debtOut       = min(debt, ceil(collateral * collateralPrice / debtPrice))
```

- `collateralOut`/`debtOut` are **circuit outputs** and therefore public
  signals: the tokens they denote move at the public ERC20 layer in the
  settlement transaction anyway, so publishing them reveals nothing beyond
  what the settlement itself shows.
- Parity pricing: the liquidator pays exactly the debt-value of the seized
  collateral (capped at the full hidden debt). There is **no liquidation
  bonus/incentive** in this phase — documented limitation.
- Any residual hidden debt after settlement (`debt - debtOut`) is written
  off when the position closes: **socialized bad debt**, absorbed by the
  protocol in this PoC (no reserve/loss accounting yet). This is the main
  economic simplification of Milestone 3.

## 3. Who knows what

| Party | Knows |
|---|---|
| Liquidator | prices, threshold, the proof, and the settlement amounts (public at the token layer); **NOT** the private balances, the control secret, or any pre-settlement state detail |
| Contract / observers | the same public data: position id, commitment hash, prices, threshold, settlement amounts, and that eligibility was proven |
| ZK circuit (verifier) | only the 8 public signals (6 inputs + 2 settlement outputs) — the hidden state enters solely through the Groth16 verification equation |
| Position owner (proof holder) | the private state; generates the eligibility proof |

## 4. Settlement flow (`VeilLend.liquidate`)

```text
liquidator submits (positionId, collateralOut, debtOut, Groth16 proof)
  contract: canonicality + amount > 0 checks
  contract: position Active, fresh prices via getFreshPrice, threshold from config
  contract: builds pubSignals [collateralOut, debtOut, positionId,
             activeCommitment, collateralPrice, debtPrice, thresholdBps]
  contract: Groth16 verify → InvalidProof on failure
  effects:  collateralCustody -= collateralOut   (1:1 custody conservation)
            pull debtOut debt-tokens from liquidator (exact-amount check) → debtCustody
            position → Closed
            transfer collateralOut to liquidator
            emit Liquidated(positionId, collateralAsset, debtAsset, collateralOut, debtOut)
```

- Pause: `liquidate` is `whenNotPaused` — liquidation is a risky action and
  is blocked by the emergency pause.
- Replay: eligibility is bound to the position's CURRENT commitment; after
  settlement the position is `Closed` and cannot be liquidated again
  (`PositionNotActive`).
- Recipient binding: the settlement recipient is a public circuit input,
  derived on-chain from `msg.sender` — a proof is bound to one liquidator
  address and cannot be copied or redirected by another wallet.
- Permissionless in the sense that anyone may generate a witness and a proof
  for their own address; only the bound address can execute settlement.

## 5. Honest boundary — who can generate the proof

The eligibility proof requires the position's **private witness**, so today
only the control-secret holder (or whoever they disclose the witness to) can
produce it. A fully permissionless liquidation flow therefore requires a
witness-disclosure mechanism (e.g., encrypted witness streams / keeper
network) that is explicitly **out of scope** for this phase — no liquidation
service, backend, or witness distribution system is built. The
cryptographic primitive (eligibility proof + confidential settlement) is
complete and tested; the incentive/operational layer around witness
availability is future work.

## 6. Path forward (unchanged position model)

The existing commitment already binds everything a future, more expressive
liquidation needs (partial liquidations with user-approved new commitments,
dutch-auction settlement, bad-debt socialization accounting). No redesign
of the position model is required; extensions are additional circuit
actions and contract settlement policies.
