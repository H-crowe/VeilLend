/**
 * VeilLend — ZK prover tooling (Phase 2).
 *
 * Responsibilities:
 *  1. `build` subcommand (`npm run zk:build`): compiles the circom circuit,
 *     runs the local Groth16 trusted setup (deterministic single-contribution
 *     ceremony — PoC only), and emits the real Solidity verifier into
 *     contracts/zk/Groth16Verifier.sol.
 *  2. Library used by the test suite: private-state encoding, commitment and
 *     nullifier computation (mirroring the circuit exactly), witness
 *     preparation, proof generation, local verification, and
 *     call-argument assembly for the on-chain verifier.
 *  3. `demo` subcommand (`npm run prove`): end-to-end reproducibility flow —
 *     private state → commitment → proof generation → local verification.
 *
 * Commitment (v1), on the BN254 scalar field with Poseidon-16:
 *   H(DOMAIN_COMMITMENT_V1, positionId, collateralAssetLo, collateralAssetHi,
 *     debtAssetLo, debtAssetHi, collateralLo, collateralHi, debtLo, debtHi,
 *     indexLo, indexHi, sequence, controlSecret, salt, 0)
 * where every value < 2^200 is hashed as lo + hi*2^120 (lo < 2^120, hi < 2^80).
 *
 * Nullifier (v1):
 *   H(DOMAIN_NULLIFIER_V1, controlSecret, positionId, newSequence, actionId, 0)
 */
import { execSync } from "child_process";
import * as fs from "fs";
import * as path from "path";

// eslint-disable-next-line @typescript-eslint/no-var-requires
const snarkjs = require("snarkjs");
// eslint-disable-next-line @typescript-eslint/no-var-requires
const circomlibjs = require("circomlibjs");

// ---------------------------------------------------------------------------
// Protocol constants (must mirror circuits/state_transition.circom)
// ---------------------------------------------------------------------------

export const DOMAIN_COMMITMENT = 0x5645494c5f434f4d4d49544d454e545f5631n; // "VEIL_COMMITMENT_V1"
export const DOMAIN_NULLIFIER = 0x5645494c5f4e554c4c49464945525f5631n; // "VEIL_NULLIFIER_V1"
export const ACTION_DEPOSIT = 1n;
export const ACTION_REPAY = 2n;
export const ACTION_BORROW = 3n;
export const ACTION_WITHDRAW = 4n;

export const LIMB_SHIFT = 1n << 120n;
export const LIMB_LOW_MASK = LIMB_SHIFT - 1n;
export const MAX_VALUE_200 = (1n << 200n) - 1n;

/** BN254 scalar field order (SNARK scalar field). */
export const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const ROOT = path.join(__dirname, "..");
export const ZK_DIR = path.join(ROOT, "artifacts-zk");
const CIRCOM_BIN = fs.existsSync(path.join(ROOT, "tools", "circom.exe")) ? path.join(ROOT, "tools", "circom.exe") : "circom";
const POT = path.join(ZK_DIR, "pot14_final.ptau");
const POT_POWER = 14; // largest circuit (risk transitions) needs > 2^13 capacity

/** Circuits known to the build. state_transition is the Phase 2 core. */
export const CIRCUITS = ["state_transition", "solvency", "risk_transition", "liquidation"] as const;
export type CircuitName = (typeof CIRCUITS)[number];

/** Verifier contract file per circuit (contracts/zk/<Name>.sol). */
export const VERIFIER_CONTRACTS: Record<CircuitName, string> = {
  state_transition: "Groth16Verifier",
  solvency: "SolvencyVerifier",
  risk_transition: "RiskTransitionVerifier",
  liquidation: "LiquidationVerifier",
};

function circuitPaths(name: CircuitName) {
  return {
    source: path.join(ROOT, "circuits", `${name}.circom`),
    r1cs: path.join(ZK_DIR, `${name}.r1cs`),
    wasm: path.join(ZK_DIR, `${name}_js`, `${name}.wasm`),
    zkey: path.join(ZK_DIR, `${name}_final.zkey`),
    vkey: path.join(ZK_DIR, `${name}_vkey.json`),
    verifierSol: path.join(ROOT, "contracts", "zk", `${VERIFIER_CONTRACTS[name]}.sol`),
  };
}

const STATE = circuitPaths("state_transition");
const WASM = STATE.wasm;
const ZKEY = STATE.zkey;

export function requireZkArtifacts(circuit: CircuitName = "state_transition"): void {
  const p = circuitPaths(circuit);
  const missing = [p.wasm, p.zkey, p.vkey].filter((f) => !fs.existsSync(f));
  if (missing.length > 0) {
    throw new Error(`ZK artifacts missing for "${circuit}" (${missing.join(", ")}). Run: npm run zk:build`);
  }
}

// ---------------------------------------------------------------------------
// Poseidon (circomlibjs — same constants as the circom circuit)
// ---------------------------------------------------------------------------

type PoseidonLib = { (inputs: Array<bigint | unknown>): unknown; F: { toObject(e: unknown): bigint } };
let poseidonLib: PoseidonLib | null = null;

async function getPoseidon(): Promise<PoseidonLib> {
  if (poseidonLib === null) {
    poseidonLib = (await circomlibjs.buildPoseidon()) as PoseidonLib;
  }
  return poseidonLib;
}

export async function poseidon(inputs: bigint[]): Promise<bigint> {
  const lib = await getPoseidon();
  return lib.F.toObject(lib(inputs)) as bigint;
}

// ---------------------------------------------------------------------------
// Private state
// ---------------------------------------------------------------------------

/**
 * The exact private state bound by the commitment (v1). Field order above.
 * Asset ids are 160-bit addresses (< 2^200); all values must be < 2^200
 * except sequence (< 2^64) and the 253-bit secrets.
 */
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

export function splitLimbs(value: bigint): { lo: bigint; hi: bigint } {
  if (value < 0n || value > MAX_VALUE_200) throw new Error(`value out of 200-bit range: ${value}`);
  return { lo: value & LIMB_LOW_MASK, hi: value >> 120n };
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
    colAsset.lo,
    colAsset.hi,
    debtAsset.lo,
    debtAsset.hi,
    col.lo,
    col.hi,
    debt.lo,
    debt.hi,
    idx.lo,
    idx.hi,
    state.sequence,
    state.controlSecret,
    state.salt,
    0n,
  ]);
}

export async function computeNullifier(state: PrivateState, actionId: bigint, newSequence: bigint): Promise<bigint> {
  return poseidon([DOMAIN_NULLIFIER, state.controlSecret, state.positionId, newSequence, actionId, 0n]);
}

/** Builds the initial (empty) private state for a new position. */
export function makeInitialState(params: {
  positionId: bigint;
  collateralAsset: bigint;
  debtAsset: bigint;
  currentIndex: bigint;
  controlSecret: bigint;
  salt: bigint;
}): PrivateState {
  return {
    positionId: params.positionId,
    collateralAsset: params.collateralAsset,
    debtAsset: params.debtAsset,
    collateral: 0n,
    debt: 0n,
    interestIndex: params.currentIndex,
    sequence: 0n,
    controlSecret: params.controlSecret,
    salt: params.salt,
  };
}

// ---------------------------------------------------------------------------
// Transition preparation (mirrors the circuit's transition rules exactly)
// ---------------------------------------------------------------------------

/** Exact integer ceiling division. */
export function ceilDiv(numerator: bigint, denominator: bigint): bigint {
  if (denominator === 0n) throw new Error("ceilDiv by zero");
  return (numerator + denominator - 1n) / denominator;
}

export interface TransitionRequest {
  oldState: PrivateState;
  actionId: bigint;
  /** Deposit amount (added to hidden collateral) or repay amount (subtracted from accrued debt). */
  amount: bigint;
  /** Current public interest index (WAD). */
  currentIndex: bigint;
  newSalt: bigint;
}

/** Exact public-signal order — the Solidity verifier depends on it. */
export const PUBLIC_SIGNAL_ORDER = [
  "positionId",
  "oldCommitment",
  "newCommitment",
  "nullifier",
  "actionId",
  "newSequence",
  "currentIndexLo",
  "currentIndexHi",
  "publicAmount",
] as const;

export interface PreparedTransition {
  oldState: PrivateState;
  newState: PrivateState;
  /** accrued = ceil(oldDebt * currentIndex / oldIndex) */
  accruedDebt: bigint;
  /** Witness input keyed exactly like the circuit's signal names. */
  inputs: Record<string, string>;
  /** Public signals in PUBLIC_SIGNAL_ORDER. */
  publicSignals: bigint[];
}

/**
 * Computes commitments/nullifier via Poseidon and prepares the witness input
 * and public signals for a transition. Mirrors the circuit's rules exactly.
 */
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

  const newState: PrivateState = {
    ...s,
    collateral: newCollateral,
    debt: newDebt,
    interestIndex: req.currentIndex,
    sequence: s.sequence + 1n,
    salt: req.newSalt,
  };

  const oldCommitment = await computeCommitment(s);
  const newCommitment = await computeCommitment(newState);
  const nullifier = await computeNullifier(s, req.actionId, newState.sequence);

  const oldColAsset = splitLimbs(s.collateralAsset);
  const oldDebtAsset = splitLimbs(s.debtAsset);
  const oldCol = splitLimbs(s.collateral);
  const oldDebt = splitLimbs(s.debt);
  const oldIdx = splitLimbs(s.interestIndex);
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
    oldCollateralAssetLo: oldColAsset.lo.toString(),
    oldCollateralAssetHi: oldColAsset.hi.toString(),
    oldDebtAssetLo: oldDebtAsset.lo.toString(),
    oldDebtAssetHi: oldDebtAsset.hi.toString(),
    oldCollateralLo: oldCol.lo.toString(),
    oldCollateralHi: oldCol.hi.toString(),
    oldDebtLo: oldDebt.lo.toString(),
    oldDebtHi: oldDebt.hi.toString(),
    oldIndexLo: oldIdx.lo.toString(),
    oldIndexHi: oldIdx.hi.toString(),
    oldSequence: s.sequence.toString(),
    controlSecret: s.controlSecret.toString(),
    oldSalt: s.salt.toString(),
    newSalt: req.newSalt.toString(),
  };

  const publicSignals: bigint[] = [
    s.positionId,
    oldCommitment,
    newCommitment,
    nullifier,
    req.actionId,
    newState.sequence,
    nowIdx.lo,
    nowIdx.hi,
    req.amount,
  ];

  return { oldState: s, newState, accruedDebt, inputs, publicSignals };
}

// ---------------------------------------------------------------------------
// Proof generation / verification
// ---------------------------------------------------------------------------

export interface ProofCallArgs {
  pA: [bigint, bigint];
  pB: [[bigint, bigint], [bigint, bigint]];
  pC: [bigint, bigint];
  pub: bigint[];
}

export interface GeneratedProof {
  proof: unknown;
  /** Public signals exactly as snarkjs emits them (strings). */
  publicSignals: string[];
  callArgs: ProofCallArgs;
}

export async function generateProof(
  inputs: Record<string, string>,
  circuit: CircuitName = "state_transition"
): Promise<GeneratedProof> {
  requireZkArtifacts(circuit);
  const p = circuitPaths(circuit);
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, p.wasm, p.zkey);
  const callArgs = await exportCallArgs(proof, publicSignals);
  return { proof, publicSignals, callArgs };
}

/** Converts a snarkjs proof into the exact argument shape of Groth16Verifier.verifyProof. */
export async function exportCallArgs(proof: unknown, publicSignals: string[]): Promise<ProofCallArgs> {
  const calldata: string = await snarkjs.groth16.exportSolidityCallData(proof, publicSignals);
  const argv = JSON.parse(`[${calldata}]`) as string[][];
  return {
    pA: [BigInt(argv[0][0]), BigInt(argv[0][1])],
    pB: [
      [BigInt(argv[1][0][0]), BigInt(argv[1][0][1])],
      [BigInt(argv[1][1][0]), BigInt(argv[1][1][1])],
    ],
    pC: [BigInt(argv[2][0]), BigInt(argv[2][1])],
    pub: argv[3].map((v) => BigInt(v)),
  };
}

export async function verifyLocally(
  publicSignals: string[],
  proof: unknown,
  circuit: CircuitName = "state_transition"
): Promise<boolean> {
  requireZkArtifacts(circuit);
  const vkey = JSON.parse(fs.readFileSync(circuitPaths(circuit).vkey, "utf8"));
  return snarkjs.groth16.verify(vkey, publicSignals, proof);
}

// ---------------------------------------------------------------------------
// Build subcommand: circuit → wasm/r1cs → ptau → zkey → Solidity verifier
// ---------------------------------------------------------------------------

function sh(cmd: string): void {
  console.log(`> ${cmd}`);
  execSync(cmd, { stdio: "inherit", cwd: ROOT });
}

export async function buildArtifacts(): Promise<void> {
  fs.mkdirSync(ZK_DIR, { recursive: true });
  fs.mkdirSync(path.join(ROOT, "contracts", "zk"), { recursive: true });

  if (!fs.existsSync(POT)) {
    const pot0 = path.join(ZK_DIR, "pot14_0000.ptau");
    const pot1 = path.join(ZK_DIR, "pot14_0001.ptau");
    sh(`npx snarkjs powersoftau new bn128 ${POT_POWER} "${pot0}" -v`);
    sh(`npx snarkjs powersoftau contribute "${pot0}" "${pot1}" --name="VeilLend PoC" -e="VeilLend deterministic entropy 2026" -v`);
    sh(`npx snarkjs powersoftau prepare phase2 "${pot1}" "${POT}" -v`);
    fs.rmSync(pot0, { force: true });
    fs.rmSync(pot1, { force: true });
  } else {
    console.log("powersoftau found, skipping setup");
  }

  for (const name of CIRCUITS) {
    const p = circuitPaths(name);
    console.log(`
=== building circuit "${name}" ===`);
    sh(`"${CIRCOM_BIN}" circuits/${name}.circom --wasm --r1cs --sym -o artifacts-zk -l node_modules/circomlib/circuits`);
    sh(`npx snarkjs groth16 setup "${p.r1cs}" "${POT}" "${p.zkey}"`);
    sh(`npx snarkjs zkey export verificationkey "${p.zkey}" "${p.vkey}"`);
    sh(`npx snarkjs zkey export solidityverifier "${p.zkey}" "${p.verifierSol}"`);
    normalizeVerifier(p.verifierSol, VERIFIER_CONTRACTS[name]);
    console.log(`Wrote ${p.verifierSol}`);
  }

console.log("\nZK build complete.");
}

/** Normalizes the snarkjs-generated verifier (pragma + contract name) for the project toolchain. Keeps the snarkjs SPDX header. */
function normalizeVerifier(verifierSol: string, contractName: string): void {
  let src = fs.readFileSync(verifierSol, "utf8");
  src = src.replace(/^pragma solidity[^;]+;/m, "pragma solidity ^0.8.24;");
  src = src.replace(/contract\s+\w+\s*{/, `contract ${contractName} {`);
  fs.writeFileSync(verifierSol, src);
}

// ---------------------------------------------------------------------------
// Demo subcommand: private state → commitment → proof → local verification
// ---------------------------------------------------------------------------

async function demo(): Promise<void> {
  requireZkArtifacts();
  const state = makeInitialState({
    positionId: 1n,
    collateralAsset: 0x1001n,
    debtAsset: 0x2002n,
    currentIndex: 10n ** 18n,
    controlSecret: 0xdeadbeefcafebabe112233445566778899aabbccddeeff0011223344556677n,
    salt: 0x1234n,
  });
  const commitment = await computeCommitment(state);
  console.log("initial commitment:", commitment.toString());

  const prepared = await buildTransition({
    oldState: state,
    actionId: ACTION_DEPOSIT,
    amount: 5n * 10n ** 18n,
    currentIndex: 10n ** 18n,
    newSalt: 0x5678n,
  });
  console.log("deposit 5e18 → new collateral:", prepared.newState.collateral.toString());
  console.log("nullifier:", prepared.publicSignals[3].toString());

  const { proof, publicSignals } = await generateProof(prepared.inputs);
  const ok = await verifyLocally(publicSignals, proof);
  console.log("local Groth16 verification:", ok ? "PASS" : "FAIL");
  if (!ok) process.exitCode = 1;
}

// ---------------------------------------------------------------------------
// Solvency circuit helpers (Phase 3, Milestone 1)
// ---------------------------------------------------------------------------

/** Public risk/market parameters for a solvency proof. Prices are 1e8-scaled. */
export interface SolvencyParams {
  collateralPrice: bigint;
  debtPrice: bigint;
  maxLtvBps: bigint;
}

/** Exact public-signal order of the solvency circuit. */
export const SOLVENCY_SIGNAL_ORDER = [
  "positionId",
  "positionCommitment",
  "collateralPrice",
  "debtPrice",
  "maxLtvBps",
] as const;

/** TS mirror of the circuit's solvency inequality (for expectations/tests). */
export function isSolvent(state: PrivateState, params: SolvencyParams): boolean {
  return state.collateral * params.collateralPrice * 10000n >= state.debt * params.debtPrice * params.maxLtvBps;
}

/** Builds the witness input + public signals for the solvency circuit. */
export async function buildSolvencyWitness(
  state: PrivateState,
  params: SolvencyParams
): Promise<{ inputs: Record<string, string>; publicSignals: bigint[]; commitment: bigint }> {
  const commitment = await computeCommitment(state);
  const colAsset = splitLimbs(state.collateralAsset);
  const debtAsset = splitLimbs(state.debtAsset);
  const col = splitLimbs(state.collateral);
  const debt = splitLimbs(state.debt);
  const idx = splitLimbs(state.interestIndex);

  const inputs: Record<string, string> = {
    positionId: state.positionId.toString(),
    positionCommitment: commitment.toString(),
    collateralPrice: params.collateralPrice.toString(),
    debtPrice: params.debtPrice.toString(),
    maxLtvBps: params.maxLtvBps.toString(),
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

  const publicSignals = [state.positionId, commitment, params.collateralPrice, params.debtPrice, params.maxLtvBps];

  return { inputs, publicSignals, commitment };
}

// ---------------------------------------------------------------------------
// Risk-transition circuit helpers (Phase 3, Milestone 2: borrow / withdraw)
// ---------------------------------------------------------------------------

export interface RiskParams {
  collateralPrice: bigint;
  debtPrice: bigint;
  maxLtvBps: bigint;
}

/** Exact public-signal order of the risk-transition circuit. */
export const RISK_SIGNAL_ORDER = [
  "positionId",
  "oldCommitment",
  "newCommitment",
  "nullifier",
  "actionId",
  "newSequence",
  "currentIndexLo",
  "currentIndexHi",
  "amount",
  "collateralPrice",
  "debtPrice",
  "maxLtvBps",
  "recipient",
] as const;

/**
 * Builds the witness + public signals for a borrow/withdraw transition.
 * Mirrors the circuit: debt accrues to currentIndex, borrow adds `amount`
 * to debt, withdraw subtracts `amount` from collateral; the post-transition
 * position must satisfy the solvency inequality.
 */
export async function buildRiskTransition(req: {
  oldState: PrivateState;
  actionId: bigint; // ACTION_BORROW | ACTION_WITHDRAW
  amount: bigint;
  currentIndex: bigint;
  newSalt: bigint;
  params: RiskParams;
  /** Authorized payout recipient (uint160 address as bigint). The on-chain
   * contract derives this from msg.sender, so proofs are sender-bound. */
  recipient: bigint;
}): Promise<PreparedTransition> {
  const s = req.oldState;
  if (req.currentIndex === 0n) throw new Error("currentIndex must be non-zero");
  if (req.currentIndex < s.interestIndex) throw new Error("interest index must be non-decreasing");
  if (req.recipient < 0n || req.recipient >= 2n ** 160n) throw new Error("recipient out of uint160 range");

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

  const newState: PrivateState = {
    ...s,
    collateral: newCollateral,
    debt: newDebt,
    interestIndex: req.currentIndex,
    sequence: s.sequence + 1n,
    salt: req.newSalt,
  };

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
    s.positionId,
    oldCommitment,
    newCommitment,
    nullifier,
    req.actionId,
    newState.sequence,
    nowIdx.lo,
    nowIdx.hi,
    req.amount,
    req.params.collateralPrice,
    req.params.debtPrice,
    req.params.maxLtvBps,
    req.recipient,
  ];

  return { oldState: s, newState, accruedDebt, inputs, publicSignals };
}

// ---------------------------------------------------------------------------
// Liquidation circuit helpers (Phase 3, Milestone 3)
// ---------------------------------------------------------------------------

export interface LiquidationParams {
  collateralPrice: bigint;
  debtPrice: bigint;
  liquidationThresholdBps: bigint;
}

/** Exact public-signal order of the liquidation circuit (outputs first). */
export const LIQUIDATION_SIGNAL_ORDER = [
  "collateralOut",
  "debtOut",
  "positionId",
  "positionCommitment",
  "collateralPrice",
  "debtPrice",
  "liquidationThresholdBps",
  "recipient",
] as const;

/** TS mirror of the circuit's eligibility inequality (strict <). */
export function isLiquidatable(state: PrivateState, params: LiquidationParams): boolean {
  return state.collateral * params.collateralPrice * 10000n < state.debt * params.debtPrice * params.liquidationThresholdBps;
}

/** Settlement amounts the circuit outputs: full collateral, parity-capped debt. */
export function settlementAmounts(state: PrivateState, params: LiquidationParams): { collateralOut: bigint; debtOut: bigint } {
  const collateralOut = state.collateral;
  const parityDebt = ceilDiv(state.collateral * params.collateralPrice, params.debtPrice);
  const debtOut = state.debt < parityDebt ? state.debt : parityDebt;
  return { collateralOut, debtOut };
}

/** Builds the witness + expected public signals for the liquidation circuit. */
export async function buildLiquidationWitness(
  state: PrivateState,
  params: LiquidationParams,
  /** Authorized settlement recipient (uint160 address as bigint) — the
   * liquidator. Derived on-chain from msg.sender. */
  recipient: bigint
) {
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
    amounts.collateralOut,
    amounts.debtOut,
    state.positionId,
    commitment,
    params.collateralPrice,
    params.debtPrice,
    params.liquidationThresholdBps,
    recipient,
  ];

  return { inputs, publicSignals, amounts, commitment };
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  const cmd = process.argv[2] ?? "demo";
  if (cmd === "build") await buildArtifacts();
  else if (cmd === "demo") await demo();
  else throw new Error(`unknown command "${cmd}" (use build | demo)`);
}

if (require.main === module) {
  main()
    .then(() => process.exit(0))
    .catch((err) => {
      console.error(err);
      process.exit(1);
    });
}
