/**
 * Browser Groth16 proving via the snarkjs UMD bundle (/snarkjs.min.js).
 * Real proving against the repository's circuits — no mocks.
 */

interface Groth16Proof {
  pi_a: string[];
  pi_b: string[][];
  pi_c: string[];
  protocol: string;
}

interface SnarkJs {
  groth16: {
    fullProve(
      input: Record<string, string>,
      wasmUrl: string,
      zkeyUrl: string
    ): Promise<{ proof: Groth16Proof; publicSignals: string[] }>;
  };
}

declare global {
  interface Window {
    snarkjs?: SnarkJs;
  }
}

export type CircuitName = "state_transition" | "risk_transition" | "liquidation";

const ARTIFACTS: Record<CircuitName, { wasm: string; zkey: string }> = {
  state_transition: { wasm: "/zk/state_transition_js/state_transition.wasm", zkey: "/zk/state_transition_final.zkey" },
  risk_transition: { wasm: "/zk/risk_transition_js/risk_transition.wasm", zkey: "/zk/risk_transition_final.zkey" },
  liquidation: { wasm: "/zk/liquidation_js/liquidation.wasm", zkey: "/zk/liquidation_final.zkey" },
};

export function loadSnarkJs(): SnarkJs {
  if (typeof window === "undefined") throw new Error("snarkjs is browser-only");
  if (!window.snarkjs) throw new Error("snarkjs not loaded");
  return window.snarkjs;
}

export interface ProofResult {
  proof: Groth16Proof;
  publicSignals: string[];
  /** Calldata-ready arrays for the deployed Solidity verifiers. */
  callArgs: { pA: [bigint, bigint]; pB: [[bigint, bigint], [bigint, bigint]]; pC: [bigint, bigint]; pub: bigint[] };
}

/** Generates a real Groth16 proof in the browser. */
export async function generateProof(inputs: Record<string, string>, circuit: CircuitName): Promise<ProofResult> {
  const snarkjs = loadSnarkJs();
  const { wasm, zkey } = ARTIFACTS[circuit];
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, wasm, zkey);

  // Solidity verifier argument mapping (matches snarkjs exportSolidityCallData)
  const callArgs = {
    pA: [BigInt(proof.pi_a[0]), BigInt(proof.pi_a[1])] as [bigint, bigint],
    pB: [
      [BigInt(proof.pi_b[0][1]), BigInt(proof.pi_b[0][0])],
      [BigInt(proof.pi_b[1][1]), BigInt(proof.pi_b[1][0])],
    ] as [[bigint, bigint], [bigint, bigint]],
    pC: [BigInt(proof.pi_c[0]), BigInt(proof.pi_c[1])] as [bigint, bigint],
    pub: publicSignals.map((v) => BigInt(v)),
  };
  return { proof, publicSignals, callArgs };
}
