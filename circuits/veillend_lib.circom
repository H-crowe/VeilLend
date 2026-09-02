// VeilLend — shared circuit library (Phase 3)
//
// Single source of truth for the commitment, nullifier and arithmetic
// templates. Included by every VeilLend circuit so no commitment or proof
// logic is ever duplicated.
//
// Hash: Poseidon (circomlib, BN254 scalar field, r < 2^254).
//
// Domain separation constants (ASCII of the version tag, one field element):
//   DOMAIN_COMMITMENT = 0x5645494C5F434F4D4D49544D454E545F5631  "VEIL_COMMITMENT_V1"
//   DOMAIN_NULLIFIER  = 0x5645494C5F4E554C4C49464945525F5631  "VEIL_NULLIFIER_V1"
//
// Value encoding (architecture.md §2):
//   value = lo + hi*2^120, lo < 2^120, hi < 2^80  (value < 2^200)

pragma circom 2.0.0;

include "poseidon.circom";
include "comparators.circom";
include "bitify.circom";

// ---------------------------------------------------------------------------
// Hashing
// ---------------------------------------------------------------------------

// Commitment over the complete private state. Field 15 is fixed zero
// padding for future extensions (versioned via the domain tag).
template StateCommitment() {
    signal input positionId;
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
    signal output out;

    component hasher = Poseidon(16);
    hasher.inputs[0] <== 0x5645494C5F434F4D4D49544D454E545F5631; // "VEIL_COMMITMENT_V1"
    hasher.inputs[1] <== positionId;
    hasher.inputs[2] <== collateralAssetLo;
    hasher.inputs[3] <== collateralAssetHi;
    hasher.inputs[4] <== debtAssetLo;
    hasher.inputs[5] <== debtAssetHi;
    hasher.inputs[6] <== collateralLo;
    hasher.inputs[7] <== collateralHi;
    hasher.inputs[8] <== debtLo;
    hasher.inputs[9] <== debtHi;
    hasher.inputs[10] <== indexLo;
    hasher.inputs[11] <== indexHi;
    hasher.inputs[12] <== sequence;
    hasher.inputs[13] <== controlSecret;
    hasher.inputs[14] <== salt;
    hasher.inputs[15] <== 0;

    out <== hasher.out;
}

// Transition nullifier. Unique per (position, sequence, action); unlinkable
// to the commitment (only the control secret connects them, inside hashes).
template TransitionNullifier() {
    signal input controlSecret;
    signal input positionId;
    signal input newSequence;
    signal input actionId;
    signal output out;

    component hasher = Poseidon(6);
    hasher.inputs[0] <== 0x5645494C5F4E554C4C49464945525F5631; // "VEIL_NULLIFIER_V1"
    hasher.inputs[1] <== controlSecret;
    hasher.inputs[2] <== positionId;
    hasher.inputs[3] <== newSequence;
    hasher.inputs[4] <== actionId;
    hasher.inputs[5] <== 0; // reserved

    out <== hasher.out;
}

// ---------------------------------------------------------------------------
// Arithmetic helpers
// ---------------------------------------------------------------------------

// Splits a value < 2^200 into (lo < 2^120, hi < 2^80) limbs.
template Split200() {
    signal input in;
    signal output lo;
    signal output hi;

    component n2b = Num2Bits(200);
    n2b.in <== in;

    component loBits = Bits2Num(120);
    component hiBits = Bits2Num(80);
    for (var i = 0; i < 120; i++) loBits.in[i] <== n2b.out[i];
    for (var i = 0; i < 80; i++) hiBits.in[i] <== n2b.out[120 + i];

    lo <== loBits.out;
    hi <== hiBits.out;
}

// Range-checks a signal to n bits.
template RangeCheck(n) {
    signal input in;
    component n2b = Num2Bits(n);
    n2b.in <== in;
}

// q = ceil(a*b/c), with 0 < c, all values < 2^n. Exact integer arithmetic:
// a hint provides floor(a*b/c); constraints force a*b = q'*c + r with
// 0 <= r < c, and the ceiling is applied only when r > 0.
template CeilDiv(n) {
    signal input a;
    signal input b;
    signal input c;
    signal output out;

    component cIsZero = IsZero();
    cIsZero.in <== c;
    cIsZero.out === 0; // c must be non-zero

    signal flo;
    flo <-- a * b \ c;

    signal r;
    r <-- a * b - flo * c;

    signal prod;
    prod <== a * b;
    signal qcr;
    qcr <== flo * c;
    qcr + r === prod;

    component rRange = RangeCheck(n);
    rRange.in <== r;

    component rLtC = LessThan(n);
    rLtC.in[0] <== r;
    rLtC.in[1] <== c;
    rLtC.out === 1;

    component rIsZero = IsZero();
    rIsZero.in <== r;

    out <== flo + 1 - rIsZero.out;
}

// out = min(a, b), values < 2^n.
template Min(n) {
    signal input a;
    signal input b;
    signal output out;

    component lt = LessThan(n);
    lt.in[0] <== a;
    lt.in[1] <== b;

    signal aSel;
    aSel <== lt.out * a;
    signal bSel;
    bSel <== (1 - lt.out) * b;
    out <== aSel + bSel;
}
