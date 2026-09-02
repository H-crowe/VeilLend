// VeilLend — solvency (health) circuit (Phase 3, Milestone 1)
//
// Proves that a private lending position is solvent under public market and
// risk parameters, WITHOUT revealing collateral, debt, or any other private
// state. The proof is cryptographically bound to the position's on-chain
// Poseidon commitment (same scheme as state transitions — see
// veillend_lib.circom), so a proof for one position can never authorize
// another.
//
// Fixed-point model (exact, integers only):
//   prices        : single field elements, 1e8-scaled (oracle convention),
//                   constrained < 2^64
//   amounts       : token atomic units, lo/hi limbs, constrained < 2^128
//   LTV           : basis points, implicit denominator 10000, <= 10000
//   solvency      : collateral * collateralPrice * 10000
//                       >= debt * debtPrice * maxLtvBps
//   (both sides in "atomic * price * bps" units; no division anywhere;
//    products < 2^128 * 2^64 * 2^14 = 2^206, compared in 207 bits)
//
// Public signals (exact order):
//   [0] positionId
//   [1] positionCommitment
//   [2] collateralPrice
//   [3] debtPrice
//   [4] maxLtvBps
//
// A zero-debt position is always solvent; a zero-collateral position is
// solvent only if debt is zero.

pragma circom 2.0.0;

include "veillend_lib.circom";

template Solvency() {
    // ---- public signals (order fixed; Solidity verifier depends on it)
    signal input positionId;
    signal input positionCommitment;
    signal input collateralPrice;
    signal input debtPrice;
    signal input maxLtvBps;

    // ---- private witness: the complete private state (index/sequence are
    //      not used in the inequality but bind the commitment to the
    //      position's full state)
    signal input collateralAssetLo;
    signal input collateralAssetHi;
    signal input debtAssetLo;
    signal input debtAssetHi;
    signal input collateralLo;
    signal input collateralHi;
    signal input debtLo;
    signal input debtHi;
    signal input indexLo;
    signal input indexHi;
    signal input sequence;
    signal input controlSecret;
    signal input salt;

    // ---- recombine limbs and range-check the economically meaningful
    //      quantities so no product can approach the field order
    signal collateral;
    collateral <== collateralLo + collateralHi * 0x1000000000000000000000000000000;
    signal debt;
    debt <== debtLo + debtHi * 0x1000000000000000000000000000000;

    component colBits = Num2Bits(128);
    colBits.in <== collateral;
    component debtBits = Num2Bits(128);
    debtBits.in <== debt;

    component rcCollPrice = RangeCheck(64);
    rcCollPrice.in <== collateralPrice;
    component rcDebtPrice = RangeCheck(64);
    rcDebtPrice.in <== debtPrice;
    component rcLtv = RangeCheck(14);
    rcLtv.in <== maxLtvBps;

    // ---- 1: the private state hashes to the on-chain position commitment
    //      (same StateCommitment as state transitions; binds positionId and
    //      the asset ids too)
    component commitment = StateCommitment();
    commitment.positionId <== positionId;
    commitment.collateralAssetLo <== collateralAssetLo;
    commitment.collateralAssetHi <== collateralAssetHi;
    commitment.debtAssetLo <== debtAssetLo;
    commitment.debtAssetHi <== debtAssetHi;
    commitment.collateralLo <== collateralLo;
    commitment.collateralHi <== collateralHi;
    commitment.debtLo <== debtLo;
    commitment.debtHi <== debtHi;
    commitment.indexLo <== indexLo;
    commitment.indexHi <== indexHi;
    commitment.sequence <== sequence;
    commitment.controlSecret <== controlSecret;
    commitment.salt <== salt;
    commitment.out === positionCommitment;

    // ---- 2: solvency, cross-multiplied (no division)
    //      collateral * collateralPrice * 10000 >= debt * debtPrice * maxLtvBps
    signal colVal;
    colVal <== collateral * collateralPrice;
    signal debtVal;
    debtVal <== debt * debtPrice;
    signal lhs;
    lhs <== colVal * 10000;
    signal rhs;
    rhs <== debtVal * maxLtvBps;

    component solvent = GreaterEqThan(207);
    solvent.in[0] <== lhs;
    solvent.in[1] <== rhs;
    solvent.out === 1;
}

component main {public [positionId, positionCommitment, collateralPrice, debtPrice, maxLtvBps]} = Solvency();
