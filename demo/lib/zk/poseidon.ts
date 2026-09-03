/**
 * Pure-TypeScript Poseidon (BN254 scalar field) — exact port of
 * circomlibjs `buildPoseidon` (poseidon_opt), verified against it.
 *
 * Used by the demo to compute commitments and nullifiers in the browser
 * with the exact same construction the Circom circuits constrain.
 */
import { N_ROUNDS_F, N_ROUNDS_P, POSEIDON_CONSTANTS } from "./poseidon-constants";

/** BN254 scalar field order. */
export const SNARK_SCALAR_FIELD = 21888242871839275222246405745257275088548364400416034343698204186575808495617n;

type Fp = bigint;

function add(a: Fp, b: Fp): Fp { return (a + b) % SNARK_SCALAR_FIELD; }
function mul(a: Fp, b: Fp): Fp { return (a * b) % SNARK_SCALAR_FIELD; }
function pow5(a: Fp): Fp {
  const a2 = mul(a, a);
  const a4 = mul(a2, a2);
  return mul(a4, a);
}

function unsringify(o: unknown): unknown {
  if (typeof o === "string") {
    return o.startsWith("0x") ? BigInt(o) : BigInt(o.trim().match(/^-?\d+$/) ? o : BigInt(0));
  }
  if (typeof o === "number") return BigInt(o);
  if (Array.isArray(o)) return o.map((v) => unsringify(v));
  if (o !== null && typeof o === "object") {
    const res: Record<string, unknown> = {};
    for (const k of Object.keys(o)) res[k] = unsringify((o as Record<string, unknown>)[k]);
    return res;
  }
  return o;
}

const cache = new Map<number, { C: Fp[]; S: Fp[]; M: Fp[][]; P: Fp[][]; nRoundsP: number }>();

function constants(t: number) {
  const hit = cache.get(t);
  if (hit) return hit;
  const raw = POSEIDON_CONSTANTS[t];
  if (!raw) throw new Error(`Poseidon constants for t=${t} not included`);
  const res = {
    C: unsringify(raw.C) as Fp[],
    S: unsringify(raw.S) as Fp[],
    M: unsringify(raw.M) as Fp[][],
    P: unsringify(raw.P) as Fp[][],
    nRoundsP: N_ROUNDS_P[t],
  };
  cache.set(t, res);
  return res;
}

/**
 * Poseidon hash over `inputs.length` field elements (t = len + 1),
 * identical to circomlib `Poseidon(nInputs)`.
 * All inputs must be reduced field elements (< r).
 */
export function poseidon(inputs: bigint[]): bigint {
  if (inputs.length === 0) throw new Error("poseidon: no inputs");
  if (inputs.length > 16) throw new Error("poseidon: max 16 inputs");
  for (const v of inputs) {
    if (v < 0n || v >= SNARK_SCALAR_FIELD) throw new Error("poseidon input not a field element");
  }

  const t = inputs.length + 1;
  const { C, S, M, P, nRoundsP } = constants(t);
  const nRoundsF = N_ROUNDS_F;

  let state: Fp[] = [0n, ...inputs];

  state = state.map((a, i) => add(a, C[i]));

  for (let r = 0; r < nRoundsF / 2 - 1; r++) {
    state = state.map((a) => pow5(a));
    state = state.map((a, i) => add(a, C[(r + 1) * t + i]));
    state = state.map((_, i) => state.reduce((acc, a, j) => add(acc, mul(M[j][i], a)), 0n));
  }
  state = state.map((a) => pow5(a));
  state = state.map((a, i) => add(a, C[(nRoundsF / 2 - 1 + 1) * t + i]));
  state = state.map((_, i) => state.reduce((acc, a, j) => add(acc, mul(P[j][i], a)), 0n));
  for (let r = 0; r < nRoundsP; r++) {
    state[0] = pow5(state[0]);
    state[0] = add(state[0], C[(nRoundsF / 2 + 1) * t + r]);

    const s0 = state.reduce((acc, a, j) => add(acc, mul(S[(t * 2 - 1) * r + j], a)), 0n);
    for (let k = 1; k < t; k++) {
      state[k] = add(state[k], mul(state[0], S[(t * 2 - 1) * r + t + k - 1]));
    }
    state[0] = s0;
  }
  for (let r = 0; r < nRoundsF / 2 - 1; r++) {
    state = state.map((a) => pow5(a));
    state = state.map((a, i) => add(a, C[(nRoundsF / 2 + 1) * t + nRoundsP + r * t + i]));
    state = state.map((_, i) => state.reduce((acc, a, j) => add(acc, mul(M[j][i], a)), 0n));
  }
  state = state.map((a) => pow5(a));
  state = state.map((_, i) => state.reduce((acc, a, j) => add(acc, mul(M[j][i], a)), 0n));

  return state[0];
}
