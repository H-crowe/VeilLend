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

// ---------------------------------------------------------------------------
// Web Worker proving — keeps the UI responsive during multi-second proofs.
// Falls back transparently to main-thread proving when workers are
// unavailable (SSR, old browsers) or when the worker itself fails.
// ---------------------------------------------------------------------------

let worker: Worker | null = null;
let workerBroken = false;
let nextJobId = 1;
const pendingJobs = new Map<number, { resolve: (p: { proof: Groth16Proof; publicSignals: string[] }) => void; reject: (e: Error) => void }>();

function getWorker(): Worker | null {
  if (workerBroken || typeof Worker === "undefined") return null;
  if (!worker) {
    try {
      worker = new Worker("/zk-worker.js");
      worker.onmessage = (ev: MessageEvent) => {
        const { id, ok, proof, publicSignals, error } = ev.data || {};
        const job = pendingJobs.get(id);
        if (!job) return;
        pendingJobs.delete(id);
        if (ok) job.resolve({ proof, publicSignals });
        else job.reject(new Error(error));
      };
      worker.onerror = () => {
        // Worker failed to load/execute — stop using it, drain jobs as failures
        // so the caller falls back to the main thread.
        workerBroken = true;
        for (const [, job] of pendingJobs) job.reject(new Error("worker failed"));
        pendingJobs.clear();
        try { worker?.terminate(); } catch { /* already dead */ }
        worker = null;
      };
    } catch {
      workerBroken = true;
      return null;
    }
  }
  return worker;
}

/** Generates a real Groth16 proof in the browser (Web Worker first). */
export async function generateProof(inputs: Record<string, string>, circuit: CircuitName): Promise<ProofResult> {
  const { wasm, zkey } = ARTIFACTS[circuit];

  const wk = getWorker();
  if (wk) {
    const id = nextJobId++;
    try {
      const result = await new Promise<{ proof: Groth16Proof; publicSignals: string[] }>((resolve, reject) => {
        pendingJobs.set(id, { resolve, reject });
        wk.postMessage({ id, inputs, wasm, zkey });
      });
      return toProofResult(result, circuit);
    } catch {
      // fall through to the main-thread path (worker unusable)
    }
  }

  const snarkjs = loadSnarkJs();
  const { proof, publicSignals } = await snarkjs.groth16.fullProve(inputs, wasm, zkey);
  return toProofResult({ proof, publicSignals }, circuit);
}

function toProofResult(
  r: { proof: Groth16Proof; publicSignals: string[] },
  circuit: CircuitName
): ProofResult {
  void circuit;

  // Solidity verifier argument mapping (matches snarkjs exportSolidityCallData)
  const callArgs = {
    pA: [BigInt(r.proof.pi_a[0]), BigInt(r.proof.pi_a[1])] as [bigint, bigint],
    pB: [
      [BigInt(r.proof.pi_b[0][1]), BigInt(r.proof.pi_b[0][0])],
      [BigInt(r.proof.pi_b[1][1]), BigInt(r.proof.pi_b[1][0])],
    ] as [[bigint, bigint], [bigint, bigint]],
    pC: [BigInt(r.proof.pi_c[0]), BigInt(r.proof.pi_c[1])] as [bigint, bigint],
    pub: r.publicSignals.map((v) => BigInt(v)),
  };
  return { proof: r.proof, publicSignals: r.publicSignals, callArgs };
}
