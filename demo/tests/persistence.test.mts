/**
 * Persistence/state-chain tests for the demo private-state flow.
 *
 * Proves the three post-fix invariants:
 *   1. a REVERTED transaction never changes localStorage (the receipt guard
 *      throws before any save is reachable — the exact wiring proveAndSubmit
 *      now uses),
 *   2. a SUCCESSFUL transition updates both the store and the freshly-read
 *      ("in-memory") state,
 *   3. two successful transitions in a row chain commitments/sequences
 *      correctly when the second is built from the saved state — no page
 *      refresh needed (this is the desync that produced InvalidCommitment).
 *
 * Run: npm test  (node --import tsx --test)
 */
import { test } from "node:test";
import assert from "node:assert/strict";

// localStorage shim BEFORE importing the store (module is SSR-guarded).
const mem = new Map<string, string>();
(globalThis as unknown as { window: unknown }).window = {
  localStorage: {
    getItem: (k: string) => (mem.has(k) ? (mem.get(k) as string) : null),
    setItem: (k: string, v: string) => void mem.set(k, String(v)),
    removeItem: (k: string) => void mem.delete(k),
  },
};

const { savePosition, getPosition, listPositions, serializeState, deserializeState } = await import("../lib/state/store.ts");
const { assertReceiptSuccess } = await import("../lib/tx/receipt.ts");
const { makeInitialState, buildTransition, buildRiskTransition, computeCommitment, ACTION_DEPOSIT, ACTION_BORROW } = await import("../lib/zk/witness.ts");

const ADDR = "0x5e75735d00"; // any wallet key (stored lowercased)
const WAD = 10n ** 18n;
const snapshot = () => JSON.stringify([...mem.entries()].sort());

/** Mirrors the hook's exact wiring: the save is reachable ONLY after the guard. */
function saveAfterReceipt(status: string, hash: string, positionId: bigint, newState: ReturnType<typeof makeInitialState>) {
  assertReceiptSuccess(status, hash);
  const stored = getPosition(ADDR, positionId);
  if (stored) savePosition(ADDR, { ...stored, state: serializeState(newState) });
}

test("1. reverted receipt: guard throws and localStorage is untouched", async () => {
  const idx = 10n ** 18n;
  const st = makeInitialState({ positionId: 50n, collateralAsset: 0x1111n, debtAsset: 0x2222n, currentIndex: idx });
  st.collateral = 10n * WAD;
  savePosition(ADDR, { positionId: "50", state: serializeState(st), createdAt: "t" });
  const before = snapshot();

  // the hook's sequence: guard first, save second — a reverted receipt never
  // reaches savePosition
  let saveRan = false;
  assert.throws(() => assertReceiptSuccess("reverted", "0xdeadbeef"), /reverted on-chain/);
  try {
    assertReceiptSuccess("reverted", "0xdeadbeef");
    const stored = getPosition(ADDR, 50n);
    if (stored) savePosition(ADDR, { ...stored, state: serializeState({ ...st, debt: 5n * WAD }) });
    saveRan = true;
  } catch { /* expected — exactly what proveAndSubmit now does */ }
  assert.equal(saveRan, false);
  assert.equal(snapshot(), before, "localStorage changed after a reverted transaction");
});

test("2. successful receipt: store and freshly-read state reflect the new state", async () => {
  const idx = 10n ** 18n;
  const st = makeInitialState({ positionId: 51n, collateralAsset: 0x1111n, debtAsset: 0x2222n, currentIndex: idx });
  st.collateral = 10n * WAD;
  savePosition(ADDR, { positionId: "51", state: serializeState(st), createdAt: "t" });

  const dep = await buildTransition({ oldState: st, actionId: ACTION_DEPOSIT, amount: 3n * WAD, currentIndex: idx, newSalt: 42n });
  assertReceiptSuccess("success", "0xgood");
  const stored = getPosition(ADDR, 51n);
  if (stored) savePosition(ADDR, { ...stored, state: serializeState(dep.newState) });

  // "in-memory" read — same call the selectedState memo makes after the bump
  const fresh = deserializeState(getPosition(ADDR, 51n)!.state);
  assert.deepEqual(fresh, dep.newState);
  assert.equal(fresh.collateral, 13n * WAD);
  assert.equal(fresh.sequence, 1n);
  assert.equal(listPositions(ADDR).length, 2);
});

test("3. two successful transitions chain commitment/sequence without a page refresh", async () => {
  const idx = 10n ** 18n;
  const st0 = makeInitialState({ positionId: 52n, collateralAsset: 0x1111n, debtAsset: 0x2222n, currentIndex: idx });
  savePosition(ADDR, { positionId: "52", state: serializeState(st0), createdAt: "t" });
  const readSaved = () => deserializeState(getPosition(ADDR, 52n)!.state); // what the fixed hook uses in-session

  // transition 1: deposit (state_transition)
  const dep = await buildTransition({ oldState: readSaved(), actionId: ACTION_DEPOSIT, amount: 10n * WAD, currentIndex: idx, newSalt: 1n });
  const C1 = await computeCommitment(dep.newState);
  assert.equal("0x" + BigInt(dep.publicSignals[2]).toString(16).padStart(64, "0"), "0x" + C1.toString(16).padStart(64, "0"));
  assertReceiptSuccess("success", "0xtx1");
  savePosition(ADDR, { positionId: "52", state: serializeState(dep.newState), createdAt: "t" });

  // transition 2: borrow (risk_transition) built from the SAVED state — same session
  const bor = await buildRiskTransition({
    oldState: readSaved(), actionId: ACTION_BORROW, amount: 2n * WAD, currentIndex: idx, newSalt: 2n,
    params: { collateralPrice: 2n * 10n ** 8n, debtPrice: 10n ** 8n, maxLtvBps: 7500n },
    recipient: 0x1725a9ba5en,
  });
  const C2 = await computeCommitment(bor.newState);
  // the borrow's oldCommitment must be the commitment of the SAVED (post-deposit) state
  assert.equal("0x" + BigInt(bor.publicSignals[1]).toString(16).padStart(64, "0"), "0x" + (await computeCommitment(readSaved())).toString(16).padStart(64, "0"));
  // and its newCommitment is exactly what the chain would store next
  assert.equal("0x" + BigInt(bor.publicSignals[2]).toString(16).padStart(64, "0"), "0x" + C2.toString(16).padStart(64, "0"));
  assert.equal(bor.newState.sequence, 2n);
  assertReceiptSuccess("success", "0xtx2");
  savePosition(ADDR, { positionId: "52", state: serializeState(bor.newState), createdAt: "t" });

  // transition 3: repay from the saved state — commitment/sequence advance again
  const rep = await buildTransition({ oldState: readSaved(), actionId: 2n, amount: 2n * WAD, currentIndex: idx, newSalt: 3n });
  assert.equal("0x" + BigInt(rep.publicSignals[1]).toString(16).padStart(64, "0"), "0x" + C2.toString(16).padStart(64, "0"), "repay must chain from the post-borrow commitment");
  assert.equal(BigInt(rep.publicSignals[5]), 3n, "repay newSequence must be seq+1");
  assert.equal(rep.newState.debt, 0n);

  // the old bug, for contrast: building the repay from the PRE-borrow state
  // would present a commitment the chain never had (InvalidCommitment)
  const staleC = await computeCommitment(dep.newState);
  assert.notEqual("0x" + staleC.toString(16).padStart(64, "0"), "0x" + C2.toString(16).padStart(64, "0"));
});
