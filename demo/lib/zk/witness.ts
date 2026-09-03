/**
 * Client-side witness builders — exact mirror of scripts/prove.ts and the
 * Circom circuits. Commitments and nullifiers use the same domain-separated
 * Poseidon construction the deployed verifiers constrain.
 */
import { poseidon } from "./poseidon";

export const DOMAIN_COMMITMENT = 0x5645494c5f434f4d4d49544d454e545f5631n; // "VEIL_COMMITMENT_V1"
export const DOMAIN_NULLIFIER = 0x5645494c5f4e554c4c49464945525f5631n; // "VEIL_NULLIFIER_V1"
export const ACTION_DEPOSIT = 1n;
export const ACTION_REPAY = 2n;
export const ACTION_BORROW = 3n;
export const ACTION_WITHDRAW = 4n;

export const LIMB_SHIFT = 1n << 120n;
export const MAX_VALUE_200 = (1n << 200n) - 1n;
export const MAX_POSITIONS = 10_000_000n;

export function splitLimbs(value: bigint): { lo: bigint; hi: bigint } {
  if (value < 0n || value > MAX_VALUE_200) throw new Error("value out of 200-bit range");
  return { lo: value & (LIMB_SHIFT - 1n), hi: value >> 120n };
}

export function addressToField(address: string): bigint {
  return BigInt(address);
}

/** The hidden position state — held ONLY in this browser (localStorage). */
export interface PrivateState {
  positionId: bigint;
  collateralAsset: bigint;
  debtAsset: bigint;
  collateral: bigint;
  debt: bigint;
  interestIndex: bigint;
  sequence: bigint;
  controlSecret: bigint;
  salt: bigint;
}

export async function computeCommitment(state: PrivateState): Promise<bigint> {
  const colAsset = splitLimbs(state.collateralAsset);
  const debtAsset = splitLimbs(state.debtAsset);
  const col = splitLimbs(state.collateral);
  const debt = splitLimbs(state.debt);
  const idx = splitLimbs(state.interestIndex);
  return poseidon([
    DOMAIN_COMMITMENT,
    state.positionId,
    colAsset.lo, colAsset.hi,
    debtAsset.lo, debtAsset.hi,
    col.lo, col.hi,
    debt.lo, debt.hi,
    idx.lo, idx.hi,
    state.sequence,
    state.controlSecret,
    state.salt,
    0n,
  ]);
}

export async function computeNullifier(state: PrivateState, actionId: bigint, newSequence: bigint): Promise<bigint> {
  return poseidon([DOMAIN_NULLIFIER, state.controlSecret, state.positionId, newSequence, actionId, 0n]);
}

export function makeInitialState(params: {
  positionId: bigint;
  collateralAsset: bigint;
  debtAsset: bigint;
  currentIndex: bigint;
}): PrivateState {
  return {
    positionId: params.positionId,
    collateralAsset: params.collateralAsset,
    debtAsset: params.debtAsset,
    collateral: 0n,
    debt: 0n,
    interestIndex: params.currentIndex,
    sequence: 0n,
    controlSecret: randomSecret(),
    salt: randomSecret(),
  };
}

export function randomSecret(): bigint {
  const bytes = new Uint8Array(31);
  crypto.getRandomValues(bytes);
  return BigInt("0x" + Array.from(bytes).map((b) => b.toString(16).padStart(2, "0")).join(""));
}

/** Exact integer ceiling division. */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("division by zero");
  return (numerator + denominator - 1n) / denominator;
}

export interface TransitionRequest {
  oldState: PrivateState;
  actionId: bigint;
  amount: bigint;
  currentIndex: bigint;
  newSalt: bigint;
}

export interface PreparedTransition {
  oldState: PrivateState;
  newState: PrivateState;
  accruedDebt: bigint;
  inputs: Record<string, string>;
  publicSignals: string[];
}

/** Deposit (actionId 1) / repay (actionId 2) witness — state_transition circuit. */
export async function buildTransition(req: TransitionRequest): Promise<PreparedTransition> {
  const s = req.oldState;
  if (req.currentIndex === 0n) throw new Error("currentIndex must be non-zero");
  if (req.currentIndex < s.interestIndex) throw new Error("interest index must be non-decreasing");

  const accruedDebt = ceilDiv(s.debt * req.currentIndex, s.interestIndex);

  let newCollateral = s.collateral;
  let newDebt = accruedDebt;
  if (req.actionId === ACTION_DEPOSIT) {
    newCollateral = s.collateral + req.amount;
  } else if (req.actionId === ACTION_REPAY) {
    const repaid = accruedDebt < req.amount ? accruedDebt : req.amount;
    newDebt = accruedDebt - repaid;
  } else {
    throw new Error(`unsupported actionId ${req.actionId}`);
  }

  const newState: PrivateState = { ...s, collateral: newCollateral, debt: newDebt, interestIndex: req.currentIndex, sequence: s.sequence + 1n, salt: req.newSalt };

  const oldCommitment = await computeCommitment(s);
  const newCommitment = await computeCommitment(newState);
  const nullifier = await computeNullifier(s, req.actionId, newState.sequence);

  const colAsset = splitLimbs(s.collateralAsset);
  const debtAsset = splitLimbs(s.debtAsset);
  const col = splitLimbs(s.collateral);
  const debt = splitLimbs(s.debt);
  const idx = splitLimbs(s.interestIndex);
  const nowIdx = splitLimbs(req.currentIndex);

  const inputs: Record<string, string> = {
    positionId: s.positionId.toString(),
    oldCommitment: oldCommitment.toString(),
    newCommitment: newCommitment.toString(),
    nullifier: nullifier.toString(),
    actionId: req.actionId.toString(),
    newSequence: newState.sequence.toString(),
    currentIndexLo: nowIdx.lo.toString(),
    currentIndexHi: nowIdx.hi.toString(),
    publicAmount: req.amount.toString(),
    oldCollateralAssetLo: colAsset.lo.toString(),
    oldCollateralAssetHi: colAsset.hi.toString(),
    oldDebtAssetLo: debtAsset.lo.toString(),
    oldDebtAssetHi: debtAsset.hi.toString(),
    oldCollateralLo: col.lo.toString(),
    oldCollateralHi: col.hi.toString(),
    oldDebtLo: debt.lo.toString(),
    oldDebtHi: debt.hi.toString(),
    oldIndexLo: idx.lo.toString(),
    oldIndexHi: idx.hi.toString(),
    oldSequence: s.sequence.toString(),
    controlSecret: s.controlSecret.toString(),
    oldSalt: s.salt.toString(),
    newSalt: req.newSalt.toString(),
  };

  const publicSignals = [
    s.positionId, oldCommitment, newCommitment, nullifier, req.actionId,
    newState.sequence, nowIdx.lo, nowIdx.hi, req.amount,
  ].map((v) => v.toString());

  return { oldState: s, newState, accruedDebt, inputs, publicSignals };
}

export interface RiskParams {
  collateralPrice: bigint;
  debtPrice: bigint;
  maxLtvBps: bigint;
}

/**
 * Borrow (actionId 3) / withdraw (actionId 4) witness — risk_transition
 * circuit, with the POST-action solvency inequality enforced in-circuit and
 * the payout recipient bound to the connected address.
 */
export async function buildRiskTransition(req: {
  oldState: PrivateState;
  actionId: bigint;
  amount: bigint;
  currentIndex: bigint;
  newSalt: bigint;
  params: RiskParams;
  recipient: bigint;
}): Promise<PreparedTransition> {
  const s = req.oldState;
  if (req.currentIndex === 0n) throw new Error("currentIndex must be non-zero");
  if (req.currentIndex < s.interestIndex) throw new Error("interest index must be non-decreasing");

  const accruedDebt = ceilDiv(s.debt * req.currentIndex, s.interestIndex);

  let newCollateral = s.collateral;
  let newDebt = accruedDebt;
  if (req.actionId === ACTION_BORROW) {
    newDebt = accruedDebt + req.amount;
  } else if (req.actionId === ACTION_WITHDRAW) {
    if (req.amount > s.collateral) throw new Error("withdraw exceeds hidden collateral");
    newCollateral = s.collateral - req.amount;
  } else {
    throw new Error(`unsupported actionId ${req.actionId}`);
  }

  const newState: PrivateState = { ...s, collateral: newCollateral, debt: newDebt, interestIndex: req.currentIndex, sequence: s.sequence + 1n, salt: req.newSalt };

  const oldCommitment = await computeCommitment(s);
  const newCommitment = await computeCommitment(newState);
  const nullifier = await computeNullifier(s, req.actionId, newState.sequence);

  const colAsset = splitLimbs(s.collateralAsset);
  const debtAsset = splitLimbs(s.debtAsset);
  const col = splitLimbs(s.collateral);
  const debt = splitLimbs(s.debt);
  const idx = splitLimbs(s.interestIndex);
  const nowIdx = splitLimbs(req.currentIndex);

  const inputs: Record<string, string> = {
    positionId: s.positionId.toString(),
    oldCommitment: oldCommitment.toString(),
    newCommitment: newCommitment.toString(),
    nullifier: nullifier.toString(),
    actionId: req.actionId.toString(),
    newSequence: newState.sequence.toString(),
    currentIndexLo: nowIdx.lo.toString(),
    currentIndexHi: nowIdx.hi.toString(),
    amount: req.amount.toString(),
    collateralPrice: req.params.collateralPrice.toString(),
    debtPrice: req.params.debtPrice.toString(),
    maxLtvBps: req.params.maxLtvBps.toString(),
    recipient: req.recipient.toString(),
    oldCollateralAssetLo: colAsset.lo.toString(),
    oldCollateralAssetHi: colAsset.hi.toString(),
    oldDebtAssetLo: debtAsset.lo.toString(),
    oldDebtAssetHi: debtAsset.hi.toString(),
    oldCollateralLo: col.lo.toString(),
    oldCollateralHi: col.hi.toString(),
    oldDebtLo: debt.lo.toString(),
    oldDebtHi: debt.hi.toString(),
    oldIndexLo: idx.lo.toString(),
    oldIndexHi: idx.hi.toString(),
    oldSequence: s.sequence.toString(),
    controlSecret: s.controlSecret.toString(),
    oldSalt: s.salt.toString(),
    newSalt: req.newSalt.toString(),
  };

  const publicSignals = [
    s.positionId, oldCommitment, newCommitment, nullifier, req.actionId,
    newState.sequence, nowIdx.lo, nowIdx.hi, req.amount,
    req.params.collateralPrice, req.params.debtPrice, req.params.maxLtvBps,
    req.recipient,
  ].map((v) => v.toString());

  return { oldState: s, newState, accruedDebt, inputs, publicSignals };
}

export interface LiquidationParams {
  collateralPrice: bigint;
  debtPrice: bigint;
  liquidationThresholdBps: bigint;
}

/** True iff collateralValue·10⁴ < debtValue·threshold (strict). */
export function isLiquidatable(state: PrivateState, params: LiquidationParams): boolean {
  return state.collateral * params.collateralPrice * 10000n < state.debt * params.debtPrice * params.liquidationThresholdBps;
}

/** Settlement amounts the circuit outputs: full collateral, parity-capped debt. */
export function settlementAmounts(state: PrivateState, params: LiquidationParams): { collateralOut: bigint; debtOut: bigint } {
  const parityDebt = ceilDiv(state.collateral * params.collateralPrice, params.debtPrice);
  return { collateralOut: state.collateral, debtOut: state.debt < parityDebt ? state.debt : parityDebt };
}

/** Liquidation eligibility witness — liquidation circuit. */
export async function buildLiquidationWitness(
  state: PrivateState,
  params: LiquidationParams,
  recipient: bigint
): Promise<{ inputs: Record<string, string>; publicSignals: string[]; amounts: { collateralOut: bigint; debtOut: bigint }; commitment: bigint }> {
  const commitment = await computeCommitment(state);
  const colAsset = splitLimbs(state.collateralAsset);
  const debtAsset = splitLimbs(state.debtAsset);
  const col = splitLimbs(state.collateral);
  const debt = splitLimbs(state.debt);
  const idx = splitLimbs(state.interestIndex);
  const amounts = settlementAmounts(state, params);

  const inputs: Record<string, string> = {
    positionId: state.positionId.toString(),
    positionCommitment: commitment.toString(),
    collateralPrice: params.collateralPrice.toString(),
    debtPrice: params.debtPrice.toString(),
    liquidationThresholdBps: params.liquidationThresholdBps.toString(),
    recipient: recipient.toString(),
    collateralAssetLo: colAsset.lo.toString(),
    collateralAssetHi: colAsset.hi.toString(),
    debtAssetLo: debtAsset.lo.toString(),
    debtAssetHi: debtAsset.hi.toString(),
    collateralLo: col.lo.toString(),
    collateralHi: col.hi.toString(),
    debtLo: debt.lo.toString(),
    debtHi: debt.hi.toString(),
    indexLo: idx.lo.toString(),
    indexHi: idx.hi.toString(),
    sequence: state.sequence.toString(),
    controlSecret: state.controlSecret.toString(),
    salt: state.salt.toString(),
  };

  const publicSignals = [
    amounts.collateralOut, amounts.debtOut, state.positionId, commitment,
    params.collateralPrice, params.debtPrice, params.liquidationThresholdBps, recipient,
  ].map((v) => v.toString());

  return { inputs, publicSignals, amounts, commitment };
}

/** Public inputs struct for the VeilLend state-transition / risk functions. */
export function toTransitionInputs(publicSignals: bigint[] | string[]) {
  const ps = publicSignals.map((v) => BigInt(v));
  return {
    positionId: ps[0],
    oldCommitment: ps[1],
    newCommitment: ps[2],
    nullifier: ps[3],
    actionId: ps[4],
    newSequence: ps[5],
    currentIndexLo: ps[6],
    currentIndexHi: ps[7],
    publicAmount: ps[8],
  };
}
