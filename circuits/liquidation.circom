// VeilLend — liquidation eligibility circuit (Phase 3, Milestone 3)
//
// Proves that a private position is eligible for liquidation WITHOUT
// revealing collateral, debt or a health factor, and computes the
// settlement amounts inside the circuit:
//
//   eligibility (cross-multiplied, strict):
//     collateral * collateralPrice * 10000  <  debt * debtPrice * liquidationThresholdBps
//
//   settlement (oracle-parity swap, capped at the hidden debt):
//     collateralOut = collateral                        (entire hidden collateral)
//     debtOut       = min(debt, ceil(collateral * collateralPrice / debtPrice))
//
// collateralOut/debtOut are circuit OUTPUTS (public signals): the tokens
// they denote move at the public ERC20 layer anyway, so publishing them
// leaks nothing beyond what the settlement transaction itself reveals. The
// REMAINING private state (e.g. any residual debt written off at settlement)
// stays hidden.
//
// The proof is bound to the position's on-chain Poseidon commitment (same
// StateCommitment as every other circuit).
//
// Public signals (exact order — outputs first):
//   [0] collateralOut
//   [1] debtOut
//   [2] positionId
//   [3] positionCommitment
//   [4] collateralPrice      (1e8-scaled, < 2^64)
//   [5] debtPrice            (1e8-scaled, < 2^64)
//   [6] liquidationThresholdBps (<= 10000)

pragma circom 2.0.0;

include "veillend_lib.circom";

template Liquidation() {
    // ---- public outputs (settlement amounts)
    signal output collateralOut;
    signal output debtOut;

    // ---- public inputs
    signal input positionId;
    signal input positionCommitment;
    signal input collateralPrice;
    signal input debtPrice;
    signal input liquidationThresholdBps;
    // Authorized recipient of the seized collateral (uint160 address) — the
    // liquidator. Bound by the verification equation and Num2Bits below;
    // derived on-chain from msg.sender.
    signal input recipient;

    // ---- private witness: the complete private state
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

    // ---- range checks
    component rcCollPrice = RangeCheck(64);
    rcCollPrice.in <== collateralPrice;
    component rcDebtPrice = RangeCheck(64);
    rcDebtPrice.in <== debtPrice;
    component rcThresh = RangeCheck(14);
    rcThresh.in <== liquidationThresholdBps;
    component rcRecipient = Num2Bits(160);
    rcRecipient.in <== recipient;

    signal collateral;
    collateral <== collateralLo + collateralHi * 0x1000000000000000000000000000000;
    signal debt;
    debt <== debtLo + debtHi * 0x1000000000000000000000000000000;

    component colBits = Num2Bits(128);
    colBits.in <== collateral;
    component debtBits = Num2Bits(128);
    debtBits.in <== debt;

    // ---- commitment binding (same scheme as all VeilLend circuits)
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

    // ---- eligibility: collateral * collateralPrice * 10000 < debt * debtPrice * threshold
    signal colVal;
    colVal <== collateral * collateralPrice;
    signal debtVal;
    debtVal <== debt * debtPrice;
    signal lhs;
    lhs <== colVal * 10000;
    signal rhs;
    rhs <== debtVal * liquidationThresholdBps;

    component eligible = LessThan(207);
    eligible.in[0] <== lhs;
    eligible.in[1] <== rhs;
    eligible.out === 1;

    // ---- settlement amounts
    collateralOut <== collateral;
    component parityCeil = CeilDiv(200);
    parityCeil.a <== collateral;
    parityCeil.b <== collateralPrice;
    parityCeil.c <== debtPrice;
    component capped = Min(200);
    capped.a <== debt;
    capped.b <== parityCeil.out;
    debtOut <== capped.out;
}

component main {public [positionId, positionCommitment, collateralPrice, debtPrice, liquidationThresholdBps, recipient]} = Liquidation();
