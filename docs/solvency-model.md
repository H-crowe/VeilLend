# VeilLend — Solvency Model (Phase 3)

## 1. Mathematical relation

A private position `(collateral, debt)` — both hidden inside the position's
Poseidon commitment — is **solvent** iff:

```text
collateral * collateralPrice * 10_000  >=  debt * debtPrice * maxLtvBps
```

and **liquidation-eligible** iff (strict):

```text
collateral * collateralPrice * 10_000  <   debt * debtPrice * liquidationThresholdBps
```

Both relations are cross-multiplied: there is **no division** anywhere in the
circuit. The two relations are implemented in separate circuits
(`solvency.circom`, `liquidation.circom`); the borrow/withdraw circuit
(`risk_transition.circom`) embeds the solvency relation evaluated on the
POST-transition balances, so an unsafe transition is not merely rejected —
it is *unprovable*.

## 2. Fixed-point precision (exact convention)

| Quantity | Representation | Range constraint (in-circuit) |
|---|---|---|
| Token amounts (collateral, debt) | token atomic units | < 2^128 |
| Oracle prices | fixed-point, 1e8 scale (one unit = "price of 1 whole token / 1e8"; ChainLink-style) | < 2^64 |
| LTV / thresholds | basis points, implicit denominator 10000 | ≤ 10000 |
| `collateralValue = collateral·collateralPrice` | implied | < 2^192 |
| Full inequality terms | "atomic·price·bps" | < 2^206, compared in 207 bits |

Rounding: only the debt **accrual** division rounds — `ceil(oldDebt ·
currentIndex / oldIndex)` via exact integer `CeilDiv` (prover hint for the
floor quotient, constraints force `a·b = q'·c + r`, `0 ≤ r < c`, ceiling
applied iff `r > 0`). The solvency/eligibility inequalities themselves are
exact integer comparisons — no rounding of any kind.

The Solidity side interprets prices with the same 1e8 convention and LTV in
bps; the interpretation never appears in Solidity arithmetic (the contract
only passes the values as public inputs to the Groth16 verifier), so
circuit/Solidity consistency reduces to passing identical integers, which
the verification equation guarantees.

## 3. Public / private inputs

### solvency.circom — public (5, exact order)

```text
positionId, positionCommitment, collateralPrice, debtPrice, maxLtvBps
```

### risk_transition.circom — public (12, exact order)

```text
positionId, oldCommitment, newCommitment, nullifier, actionId,
newSequence, currentIndexLo, currentIndexHi, amount,
collateralPrice, debtPrice, maxLtvBps
```

### liquidation.circom — public (7, outputs first)

```text
collateralOut, debtOut, positionId, positionCommitment,
collateralPrice, debtPrice, liquidationThresholdBps
```

### Private witness (all circuits, identical shape)

```text
collateralAssetLo/Hi, debtAssetLo/Hi, collateralLo/Hi, debtLo/Hi,
indexLo/Hi, sequence, controlSecret, salt(+ newSalt for transitions)
```

Private collateral, debt, accrued interest and health are NEVER public
signals. The only amounts that ever become public are amounts that move at
the public ERC20 layer anyway (deposit/repay/borrow/withdraw amounts, and
the liquidation settlement amounts — see liquidation-model.md).

## 4. Commitment binding

Every circuit recomputes `Poseidon16(old private state) == positionCommitment`
using the shared `StateCommitment` template (`veillend_lib.circom`) — the
same construction the on-chain contract stores as the position's
authoritative state. Consequences:

- a solvency/eligibility proof is bound to one position and one state
  version; a proof for position A can never authorize anything for
  position B (tested);
- a stale proof cannot be replayed after the state advances (the on-chain
  active commitment changes; the old proof's `positionCommitment` no longer
  matches — `InvalidCommitment`/`InvalidProof`);
- `positionId` and the asset ids are inside the hash, binding the hidden
  balances to the on-chain position's asset pair.

## 5. Borrow authorization (risk_transition actionId 3)

```text
accrued  = ceil(oldDebt * currentIndex / oldIndex)
newDebt  = accrued + borrowAmount
newCollateral = oldCollateral
require: newCollateral·collPrice·10000 ≥ newDebt·debtPrice·maxLtvBps
```

On-chain, after proof verification: nullifier consumed, commitment/sequence/
snapshot advanced, `borrowAmount` paid out of `debtCustody[debtAsset]`
(the repayment-funded protocol reserve) to the submitter, `Borrow` emitted.
If the reserve is short the transaction reverts (`InsufficientLiquidity`) —
the proof alone never creates liquidity.

## 6. Withdraw authorization (risk_transition actionId 4)

```text
accrued  = ceil(oldDebt * currentIndex / oldIndex)
newCollateral = oldCollateral - withdrawAmount   (amount ≤ oldCollateral enforced in-circuit)
newDebt  = accrued
require: newCollateral·collPrice·10000 ≥ newDebt·debtPrice·maxLtvBps
```

On-chain: custody decreases 1:1 with the hidden collateral, tokens transfer
to the submitter, `Withdrawal` emitted. A withdrawal that would leave the
position under-collateralized cannot be proven at all.

## 7. Proof lifecycle

```text
(holder of control secret) reads on-chain commitment + index + fresh prices
  → builds witness → generates Groth16 proof
  → submits to VeilLend (proof only; public inputs re-derived on-chain)
  → contract checks: canonicality, active commitment, sequence+1, nullifier,
    stale index, fresh prices → Groth16 verify → effects
```

Because the contract derives commitment/index/prices/LTV itself, callers
cannot aim a valid proof at a different position, a stale state, or chosen
prices.

## 8. Trust assumptions & limitations (honest)

- Oracle: single source behind `IPriceOracle`, admin-configured; freshness
  enforced (`maxPriceStaleness`). A compromised oracle manipulates
  solvency outcomes — the standard single-oracle PoC trust model.
- Risk parameters (`maxLtvBps`, `liquidationThresholdBps`) are admin-set
  per debt asset; the circuit constrains them ≤ 10000 but the values are
  governance inputs.
- Economic ranges: amounts must stay < 2^128 and prices < 2^64 for proofs
  to exist; index growth is bounded implicitly by the same ranges.
- Proof generation currently requires the position's private witness: only
  the control-secret holder can prove solvency/eligibility for their own
  position today. Decentralized liquidation therefore needs the witness-
  disclosure mechanisms planned for a later phase (see liquidation-model.md).
- Trusted setup is a deterministic single contribution (PoC), circuits are
  unaudited, and nothing is deployed to Horizen.
