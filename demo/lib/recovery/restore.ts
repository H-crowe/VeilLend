/**
 * Shared restore pipeline used by the main demo page AND /recovery-test.
 *
 * recovery file → parse → wallet signature → decrypt (recovery.ts) →
 * recompute the Poseidon commitment → compare against the CURRENT on-chain
 * `activeCommitment` for that position → only then hand back the state.
 * Callers persist nothing unless `pass` is true.
 */
import type { Address, PublicClient } from "viem";
import type { PrivateState } from "../zk/witness";
import { computeCommitment } from "../zk/witness";
import { recoverStateFromBlob, type RecoveryBlob } from "./recovery";
import { ADDRESSES } from "../contracts/addresses";
import { veilLendAbi } from "../contracts/abis";

export interface RestoreResult {
  pass: boolean;
  recovered?: PrivateState;
  recoveredCommitment?: string;
  onChainCommitment?: string;
  detail?: string;
}

/** Parses and sanity-checks an uploaded recovery file before any signing. */
export async function parseRecoveryFile(file: File): Promise<RecoveryBlob> {
  let blob: RecoveryBlob;
  try {
    blob = JSON.parse(await file.text()) as RecoveryBlob;
  } catch {
    throw new Error("the selected file is not a valid recovery file (unreadable JSON)");
  }
  if (!blob || typeof blob !== "object" || blob.v !== 1 || blob.app !== "VeilLend Recovery V1") {
    throw new Error("the selected file is not a VeilLend Recovery V1 file");
  }
  if (!blob.positionId || !blob.state?.ct || !blob.wrap?.ct) {
    throw new Error("the recovery file is incomplete — refusing to restore");
  }
  return blob;
}

/** Reads the CURRENT on-chain active commitment for a position. */
export async function readOnChainCommitment(
  publicClient: PublicClient,
  positionId: bigint,
): Promise<{ commitment: string; active: boolean }> {
  const raw = await publicClient.readContract({
    address: ADDRESSES.veilLend as Address,
    abi: veilLendAbi,
    functionName: "positions",
    args: [positionId],
  }) as unknown;
  // viem returns a positional tuple for the 6-field struct; Object.values
  // covers the named-fields shape.
  const f: unknown[] = Array.isArray(raw) ? raw : Object.values((raw ?? {}) as Record<string, unknown>);
  return { commitment: String(f[2]), active: Number(f[5]) === 1 };
}

/**
 * Full restore verification. Throws on parse/signature/decrypt failures
 * (fail-closed in recovery.ts); a decrypted-but-stale or inactive position
 * returns `pass: false` with a detail message instead.
 */
export async function verifyAndRestore(params: {
  blob: RecoveryBlob;
  address: string;
  chainId: number;
  publicClient: PublicClient;
  signMessage: (message: string) => Promise<string>;
}): Promise<RestoreResult> {
  const recovered = await recoverStateFromBlob({
    blob: params.blob,
    address: params.address,
    chainId: params.chainId,
    signMessage: params.signMessage,
  });

  const onChain = await readOnChainCommitment(params.publicClient, BigInt(params.blob.positionId));
  const recoveredCommitment = "0x" + (await computeCommitment(recovered)).toString(16).padStart(64, "0");
  const match = recoveredCommitment.toLowerCase() === onChain.commitment.toLowerCase();

  return {
    pass: match && onChain.active,
    recovered,
    recoveredCommitment,
    onChainCommitment: onChain.commitment,
    detail: !onChain.active
      ? "position is not Active on-chain"
      : match
        ? undefined
        : "commitment mismatch — the backup is stale or belongs to a different position; nothing was restored",
  };
}
