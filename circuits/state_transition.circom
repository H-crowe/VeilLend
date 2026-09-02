// VeilLend — private state transition circuit (Phase 2/3)
//
// Proves knowledge of a valid old private state (whose hash equals the
// position's active on-chain commitment) and of the position's control
// secret, and that the requested transition (deposit / repay) produces the
// claimed new commitment and nullifier per the protocol rules.
// Shared templates come from veillend_lib.circom (single source of truth).

pragma circom 2.0.0;

include "veillend_lib.circom";

template StateTransition() {
    // ---- public signals (order is fixed; the Solidity verifier depends on it)
    signal input positionId;
    signal input oldCommitment;
    signal input newCommitment;
    signal input nullifier;
    signal input actionId;
    signal input newSequence;
    signal input currentIndexLo;
    signal input currentIndexHi;
    signal input publicAmount;

    // ---- private signals: the old state (incl. its asset ids and control
    //      secret) and the new salt
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

    // ---- range-check every limb of the old state and the public inputs
    component rcColAssetLo = RangeCheck(120);
    rcColAssetLo.in <== oldCollateralAssetLo;
    component rcColAssetHi = RangeCheck(80);
    rcColAssetHi.in <== oldCollateralAssetHi;
    component rcDebtAssetLo = RangeCheck(120);
    rcDebtAssetLo.in <== oldDebtAssetLo;
    component rcDebtAssetHi = RangeCheck(80);
    rcDebtAssetHi.in <== oldDebtAssetHi;
    component rcOldColLo = RangeCheck(120);
    rcOldColLo.in <== oldCollateralLo;
    component rcOldColHi = RangeCheck(80);
    rcOldColHi.in <== oldCollateralHi;
    component rcOldDebtLo = RangeCheck(120);
    rcOldDebtLo.in <== oldDebtLo;
    component rcOldDebtHi = RangeCheck(80);
    rcOldDebtHi.in <== oldDebtHi;
    component rcOldIdxLo = RangeCheck(120);
    rcOldIdxLo.in <== oldIndexLo;
    component rcOldIdxHi = RangeCheck(80);
    rcOldIdxHi.in <== oldIndexHi;
    component rcOldSeq = RangeCheck(64);
    rcOldSeq.in <== oldSequence;
    component rcPubAmount = RangeCheck(200);
    rcPubAmount.in <== publicAmount;
    component rcIdxNowLo = RangeCheck(120);
    rcIdxNowLo.in <== currentIndexLo;
    component rcIdxNowHi = RangeCheck(80);
    rcIdxNowHi.in <== currentIndexHi;

    // ---- recombine limbs
    // 2^120 as a constant multiplier
    signal oldCollateral;
    oldCollateral <== oldCollateralLo + oldCollateralHi * 0x1000000000000000000000000000000;
    signal oldDebt;
    oldDebt <== oldDebtLo + oldDebtHi * 0x1000000000000000000000000000000;
    signal oldIndex;
    oldIndex <== oldIndexLo + oldIndexHi * 0x1000000000000000000000000000000;
    signal idxNow;
    idxNow <== currentIndexLo + currentIndexHi * 0x1000000000000000000000000000000;

    // ---- 1/2: the old private state hashes to oldCommitment
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

    // ---- 3: ownership — controlSecret is part of the old state preimage and
    //         of the nullifier; no plaintext owner exists anywhere

    // ---- 5: sequence advances by exactly one
    oldSequence + 1 === newSequence;

    // ---- interest: currentIndex must be a valid, non-decreasing index
    component idxZero = IsZero();
    idxZero.in <== idxNow;
    idxZero.out === 0;

    component idxMonotonic = LessEqThan(200);
    idxMonotonic.in[0] <== oldIndex;
    idxMonotonic.in[1] <== idxNow;
    idxMonotonic.out === 1;

    // ---- interest accounting (exact, ceiling):
    //      accrued = ceil(oldDebt * idxNow / oldIndex)
    component idxIsZero = IsZero();
    idxIsZero.in <== oldIndex;
    idxIsZero.out === 0; // snapshot is always >= 1e18

    component accrue = CeilDiv(200);
    accrue.a <== oldDebt;
    accrue.b <== idxNow;
    accrue.c <== oldIndex;
    signal accruedDebt;
    accruedDebt <== accrue.out;

    // ---- action gating: exactly one of {deposit=1, repay=2}
    component isDepositEq = IsEqual();
    isDepositEq.in[0] <== actionId;
    isDepositEq.in[1] <== 1;
    signal isDeposit;
    isDeposit <== isDepositEq.out;

    component isRepayEq = IsEqual();
    isRepayEq.in[0] <== actionId;
    isRepayEq.in[1] <== 2;
    signal isRepay;
    isRepay <== isRepayEq.out;

    isDeposit + isRepay === 1;

    // ---- transition rules
    signal newCollateral;
    newCollateral <== oldCollateral + isDeposit * publicAmount;

    component repaidMin = Min(200);
    repaidMin.a <== accruedDebt;
    repaidMin.b <== publicAmount;
    signal newDebt;
    newDebt <== accruedDebt - isRepay * repaidMin.out;

    // ---- 6: the new state (snapshot refreshed to idxNow, sequence advanced,
    //         same control secret, fresh salt) hashes to newCommitment
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

    // ---- 7: the nullifier is correctly derived
    component nullifierHash = TransitionNullifier();
    nullifierHash.controlSecret <== controlSecret;
    nullifierHash.positionId <== positionId;
    nullifierHash.newSequence <== newSequence;
    nullifierHash.actionId <== actionId;
    nullifierHash.out === nullifier;
}

component main {public [positionId, oldCommitment, newCommitment, nullifier, actionId, newSequence, currentIndexLo, currentIndexHi, publicAmount]} = StateTransition();
