/**
 * Transaction receipt guard — fail-closed.
 *
 * viem's waitForTransactionReceipt resolves with the receipt even when the
 * transaction was MINED AND REVERTED. Every private-state transition must
 * pass through this guard before any state (localStorage or in-memory) is
 * updated, otherwise a reverted transaction would advance the local witness
 * state and permanently desync it from the on-chain commitment chain.
 */
export function assertReceiptSuccess(status: string, hash: string): void {
  if (status !== "success") {
    throw new Error(`Transaction reverted on-chain (tx ${hash}). Local state was NOT changed — reload and retry.`);
  }
}
