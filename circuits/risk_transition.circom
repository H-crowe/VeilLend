// VeilLend — risk transition circuit (Phase 3, Milestone 2)
//
// Borrow (actionId 3) and withdraw (actionId 4) as proof-bound private state
// transitions, extending the Phase 2 transition model with a POST-action
// solvency check:
//
//   borrow   (3): newCollateral = oldCollateral
//                 newDebt       = accrued + amount          (debt grows)
//   withdraw (4): newCollateral = oldCollateral - amount    (collateral shrinks)
//                 newDebt       = accrued
//   both:         accrued       = ceil(oldDebt * currentIndex / oldIndex)
//                 newIndexSnapshot = currentIndex
//
//   solvency (post-transition):
//     newCollateral * collateralPrice * 10000 >= newDebt * debtPrice * maxLtvBps
//
// A borrow that would over-leverage, or a withdrawal that would leave the
// position unsafe, is therefore UNPROVABLE — the risk rule is enforced in
// zero knowledge against the hidden balances.
//
// Public signals (exact order):
//   [0]  positionId
//   [1]  oldCommitment
//   [2]  newCommitment
//   [3]  nullifier
//   [4]  actionId            (3 = borrow, 4 = withdraw)
//   [5]  newSequence
//   [6]  currentIndexLo      (currentIndex = lo + hi*2^120)
//   [7]  currentIndexHi
//   [8]  amount              (borrow amount or withdraw amount)
//   [9]  collateralPrice     (1e8-scaled, < 2^64)
//   [10] debtPrice           (1e8-scaled, < 2^64)
//   [11] maxLtvBps           (<= 10000)

pragma circom 2.0.0;

include "veillend_lib.circom";

template RiskTransition() {
    // ---- public signals
    signal input positionId;
    signal input oldCommitment;
    signal input newCommitment;
    signal input nullifier;
    signal input actionId;
    signal input newSequence;
    signal input currentIndexLo;
    signal input currentIndexHi;
    signal input amount;
    signal input collateralPrice;
    signal input debtPrice;
    signal input maxLtvBps;
    // Authorized recipient of the payout (uint160 Ethereum address). Public
    // because the address is public anyway; cryptographically bound by the
    // verification equation (changing it invalidates the proof) and by the
    // Num2Bits constraint below. The contract derives it from msg.sender.
    signal input recipient;

    // ---- private witness: old state + fresh salt (same shape as Phase 2)
    signal input oldCollateralAssetLo;
    signal input oldCollateralAssetHi;
    signal input oldDebtAssetLo;
    signal input oldDebtAssetHi;
    signal input oldCollateralLo;
    signal input oldCollateralHi;
    signal input oldDebtLo;
    signal input oldDebtHi;
    signal input oldIndexLo;
    signal input oldIndexHi;
    signal input oldSequence;
    signal input controlSecret;
    signal input oldSalt;
    signal input newSalt;

    // ---- range checks on the public inputs
    component rcAmount = RangeCheck(128);
    rcAmount.in <== amount;
    component rcCollPrice = RangeCheck(64);
    rcCollPrice.in <== collateralPrice;
    component rcDebtPrice = RangeCheck(64);
    rcDebtPrice.in <== debtPrice;
    component rcLtv = RangeCheck(14);
    rcLtv.in <== maxLtvBps;
    component rcRecipient = Num2Bits(160);
    rcRecipient.in <== recipient;

    // ---- recombine old-state limbs
    signal oldCollateral;
    oldCollateral <== oldCollateralLo + oldCollateralHi * 0x1000000000000000000000000000000;
    signal oldDebt;
    oldDebt <== oldDebtLo + oldDebtHi * 0x1000000000000000000000000000000;
    signal oldIndex;
    oldIndex <== oldIndexLo + oldIndexHi * 0x1000000000000000000000000000000;
    signal idxNow;
    idxNow <== currentIndexLo + currentIndexHi * 0x1000000000000000000000000000000;

    component oldColBits = Num2Bits(128);
    oldColBits.in <== oldCollateral;
    component oldDebtBits = Num2Bits(128);
    oldDebtBits.in <== oldDebt;

    // ---- 1/2: old state preimage
    component oldHash = StateCommitment();
    oldHash.positionId <== positionId;
    oldHash.collateralAssetLo <== oldCollateralAssetLo;
    oldHash.collateralAssetHi <== oldCollateralAssetHi;
    oldHash.debtAssetLo <== oldDebtAssetLo;
    oldHash.debtAssetHi <== oldDebtAssetHi;
    oldHash.collateralLo <== oldCollateralLo;
    oldHash.collateralHi <== oldCollateralHi;
    oldHash.debtLo <== oldDebtLo;
    oldHash.debtHi <== oldDebtHi;
    oldHash.indexLo <== oldIndexLo;
    oldHash.indexHi <== oldIndexHi;
    oldHash.sequence <== oldSequence;
    oldHash.controlSecret <== controlSecret;
    oldHash.salt <== oldSalt;
    oldHash.out === oldCommitment;

    // ---- 5: sequence advances by exactly one
    oldSequence + 1 === newSequence;

    // ---- index monotonicity and validity
    component idxZero = IsZero();
    idxZero.in <== idxNow;
    idxZero.out === 0;
    component oldIdxZero = IsZero();
    oldIdxZero.in <== oldIndex;
    oldIdxZero.out === 0;
    component idxMonotonic = LessEqThan(200);
    idxMonotonic.in[0] <== oldIndex;
    idxMonotonic.in[1] <== idxNow;
    idxMonotonic.out === 1;

    // ---- accrual: accrued = ceil(oldDebt * idxNow / oldIndex)
    component accrue = CeilDiv(200);
    accrue.a <== oldDebt;
    accrue.b <== idxNow;
    accrue.c <== oldIndex;
    signal accruedDebt;
    accruedDebt <== accrue.out;

    // ---- action gating: exactly one of {borrow=3, withdraw=4}
    component isBorrowEq = IsEqual();
    isBorrowEq.in[0] <== actionId;
    isBorrowEq.in[1] <== 3;
    signal isBorrow;
    isBorrow <== isBorrowEq.out;

    component isWithdrawEq = IsEqual();
    isWithdrawEq.in[0] <== actionId;
    isWithdrawEq.in[1] <== 4;
    signal isWithdraw;
    isWithdraw <== isWithdrawEq.out;

    isBorrow + isWithdraw === 1;

    // ---- transition rules
    // withdraw: amount must not exceed hidden collateral. The gate below
    // fires exactly when isWithdraw == 1 (for borrows the product is 0 by
    // construction), so borrows are governed solely by the post-action
    // solvency check further down.
    component amtLeCol = LessEqThan(128);
    amtLeCol.in[0] <== amount;
    amtLeCol.in[1] <== oldCollateral;
    isWithdraw * (1 - amtLeCol.out) === 0; // enforced only for withdraw

    signal newCollateral;
    newCollateral <== oldCollateral - isWithdraw * amount;
    signal newDebt;
    newDebt <== accruedDebt + isBorrow * amount;

    // post-transition balances stay inside the 128-bit economic range
    component newColBits = Num2Bits(128);
    newColBits.in <== newCollateral;
    component newDebtBits = Num2Bits(128);
    newDebtBits.in <== newDebt;

    // ---- solvency AFTER the transition (cross-multiplied, no division)
    signal colVal;
    colVal <== newCollateral * collateralPrice;
    signal debtVal;
    debtVal <== newDebt * debtPrice;
    signal lhs;
    lhs <== colVal * 10000;
    signal rhs;
    rhs <== debtVal * maxLtvBps;
    component solvent = GreaterEqThan(207);
    solvent.in[0] <== lhs;
    solvent.in[1] <== rhs;
    solvent.out === 1;

    // ---- 6: new commitment (same control secret, snapshot = currentIndex)
    component newColSplit = Split200();
    newColSplit.in <== newCollateral;
    component newDebtSplit = Split200();
    newDebtSplit.in <== newDebt;

    component newHash = StateCommitment();
    newHash.positionId <== positionId;
    newHash.collateralAssetLo <== oldCollateralAssetLo;
    newHash.collateralAssetHi <== oldCollateralAssetHi;
    newHash.debtAssetLo <== oldDebtAssetLo;
    newHash.debtAssetHi <== oldDebtAssetHi;
    newHash.collateralLo <== newColSplit.lo;
    newHash.collateralHi <== newColSplit.hi;
    newHash.debtLo <== newDebtSplit.lo;
    newHash.debtHi <== newDebtSplit.hi;
    newHash.indexLo <== currentIndexLo;
    newHash.indexHi <== currentIndexHi;
    newHash.sequence <== newSequence;
    newHash.controlSecret <== controlSecret;
    newHash.salt <== newSalt;
    newHash.out === newCommitment;

    // ---- 7: nullifier derivation
    component nullifierHash = TransitionNullifier();
    nullifierHash.controlSecret <== controlSecret;
    nullifierHash.positionId <== positionId;
    nullifierHash.newSequence <== newSequence;
    nullifierHash.actionId <== actionId;
    nullifierHash.out === nullifier;
}

component main {public [positionId, oldCommitment, newCommitment, nullifier, actionId, newSequence, currentIndexLo, currentIndexHi, amount, collateralPrice, debtPrice, maxLtvBps, recipient]} = RiskTransition();
