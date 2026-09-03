/**
 * Recovery prototype security tests (offline — no chain, no wallet).
 *
 * Covers: encrypt/decrypt round-trip + commitment equality, tampered
 * ciphertext, wrong wallet, wrong recoveryId, stale-state detection, and
 * "no signing secret / no plaintext secret in the blob".
 *
 * Run: npm test (demo) — node --import tsx --test
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

const { generatePrivateKey, privateKeyToAccount } = await import("viem/accounts");
const { createRecoveryBlob, recoverStateFromBlob, buildChallenge } = await import("../lib/recovery/recovery.ts");
const { makeInitialState, computeCommitment } = await import("../lib/zk/witness.ts");
const { serializeState, savePosition, listPositions, getPosition, deserializeState } = await import("../lib/state/store.ts");

const WAD = 10n ** 18n;
const CHAIN = 2651420;
const pkA = generatePrivateKey();
const signerA = privateKeyToAccount(pkA);
const signerB = privateKeyToAccount(generatePrivateKey());
const WALLET_A = signerA.address; // the backup owner IS the signing account
const signWith = (acct: typeof signerA) => async (message: string) => acct.signMessage({ message });

function fundedState(positionId: bigint) {
  const st = makeInitialState({ positionId, collateralAsset: 0x1111n, debtAsset: 0x2222n, currentIndex: 10n ** 18n });
  st.collateral = 10n * WAD;
  return st;
}

test("1. same wallet: backup -> recover round-trip, Poseidon commitment identical", async () => {
  const st = fundedState(77n);
  const { blob, recoveryId } = await createRecoveryBlob({
    state: st, address: WALLET_A, chainId: CHAIN, positionId: "77", signMessage: signWith(signerA),
  });
  assert.equal(recoveryId.length, 32);
  const recovered = await recoverStateFromBlob({ blob, address: WALLET_A, chainId: CHAIN, signMessage: signWith(signerA) });
  assert.deepEqual(recovered, st);
  // the whole point: the recovered state re-commits to the exact on-chain commitment
  assert.equal(await computeCommitment(recovered), await computeCommitment(st));
});

test("2. tampered ciphertext: integrity fails, nothing is returned", async () => {
  const st = fundedState(78n);
  const { blob } = await createRecoveryBlob({ state: st, address: WALLET_A, chainId: CHAIN, positionId: "78", signMessage: signWith(signerA) });
  const tampered = structuredClone(blob);
  const flip = tampered.state.ct.startsWith("0x") ? "0x1" : "0x0"; // flip first ciphertext nibble
  tampered.state.ct = flip + tampered.state.ct.slice(3);
  await assert.rejects(
    () => recoverStateFromBlob({ blob: tampered, address: WALLET_A, chainId: CHAIN, signMessage: signWith(signerA) }),
    /decryption failed|integrity/i,
  );
  // tampering the wrapped data key fails the same way
  const tampered2 = structuredClone(blob);
  tampered2.wrap.ct = (tampered2.wrap.ct === "0x00" ? "0x01" : "0x00") + tampered2.wrap.ct.slice(3);
  await assert.rejects(
    () => recoverStateFromBlob({ blob: tampered2, address: WALLET_A, chainId: CHAIN, signMessage: signWith(signerA) }),
    /decryption failed|recovery denied/i,
  );
});

test("3. wrong wallet: recovery denied before any state is produced", async () => {
  const st = fundedState(79n);
  const { blob } = await createRecoveryBlob({ state: st, address: WALLET_A, chainId: CHAIN, positionId: "79", signMessage: signWith(signerA) });
  // wallet B signs the same challenge — its address does not match the backup owner
  await assert.rejects(
    () => recoverStateFromBlob({ blob, address: WALLET_A, chainId: CHAIN, signMessage: signWith(signerB) }),
    /wrong wallet/i,
  );
  // and a different wallet CONNECTING (owner mismatch) is denied before signing
  await assert.rejects(
    () => recoverStateFromBlob({ blob, address: signerB.address, chainId: CHAIN, signMessage: signWith(signerB) }),
    /wrong wallet/i,
  );
});

test("4. wrong recoveryId / modified challenge: fail closed", async () => {
  const st = fundedState(80n);
  const { blob } = await createRecoveryBlob({ state: st, address: WALLET_A, chainId: CHAIN, positionId: "80", signMessage: signWith(signerA) });
  const wrongRid = structuredClone(blob);
  wrongRid.recoveryId = "b".repeat(32);
  await assert.rejects(
    () => recoverStateFromBlob({ blob: wrongRid, address: WALLET_A, chainId: CHAIN, signMessage: signWith(signerA) }),
    /challenge mismatch|modified/i,
  );
  const tamperedChallenge = structuredClone(blob);
  tamperedChallenge.challenge = buildChallenge(WALLET_A, blob.recoveryId, CHAIN).replace("Chain ID: 2651420", "Chain ID: 1");
  await assert.rejects(
    () => recoverStateFromBlob({ blob: tamperedChallenge, address: WALLET_A, chainId: CHAIN, signMessage: signWith(signerA) }),
    /challenge mismatch|modified/i,
  );
});

test("5. stale state: recovered commitment does NOT match the newer on-chain commitment", async () => {
  const stOld = fundedState(81n); // pre-deposit snapshot (seq 0, collateral 0)
  const { blob } = await createRecoveryBlob({ state: stOld, address: WALLET_A, chainId: CHAIN, positionId: "81", signMessage: signWith(signerA) });
  const recovered = await recoverStateFromBlob({ blob, address: WALLET_A, chainId: CHAIN, signMessage: signWith(signerA) });

  const stNew = fundedState(81n);
  stNew.collateral = 10n * WAD; // post-deposit reality on-chain
  stNew.sequence = 1n;
  const onChainCommitment = await computeCommitment(stNew);

  const recoveredCommitment = await computeCommitment(recovered);
  assert.notEqual(recoveredCommitment, onChainCommitment, "stale blob must be detected by commitment comparison");
});

test("7. full milestone flow: create backup -> wipe local state -> recover -> store restored with matching commitment", async () => {
  const idx = 10n ** 18n;
  const st = makeInitialState({ positionId: 83n, collateralAsset: 0x1111n, debtAsset: 0x2222n, currentIndex: idx });
  st.collateral = 10n * WAD;
  st.sequence = 1n;
  savePosition(WALLET_A, { positionId: "83", state: serializeState(st), createdAt: "t" });
  const { blob } = await createRecoveryBlob({ state: st, address: WALLET_A, chainId: CHAIN, positionId: "83", signMessage: signWith(signerA) });
  const onChainCommitment = await computeCommitment(st); // what the chain stores at seq 1

  // ---- "clear local state": wipe every veillend key for this wallet
  const prefixes = [`veillend:positions:${WALLET_A.toLowerCase()}`, `veillend:lastSelected:${WALLET_A.toLowerCase()}`];
  for (const k of [...mem.keys()]) if (prefixes.some((p) => k.startsWith(p))) mem.delete(k);
  assert.equal(listPositions(WALLET_A).length, 0, "local state must be empty after the wipe");

  // ---- recover from the external blob with the same wallet
  const recovered = await recoverStateFromBlob({ blob, address: WALLET_A, chainId: CHAIN, signMessage: signWith(signerA) });
  assert.deepEqual(recovered, st);
  const recoveredCommitment = await computeCommitment(recovered);
  assert.equal(recoveredCommitment, onChainCommitment, "recovered commitment must equal the on-chain commitment");

  // ---- restore into the store (what the recovery page does on PASS)
  savePosition(WALLET_A, { positionId: "83", state: serializeState(recovered), createdAt: "t" });
  assert.equal(listPositions(WALLET_A).length, 1);
  assert.equal(await computeCommitment(deserializeState(getPosition(WALLET_A, 83n)!.state)), onChainCommitment);
});

test("6. blob leaks no secrets: no signing key, no plaintext controlSecret/salt", async () => {
  const st = fundedState(82n);
  const { blob } = await createRecoveryBlob({ state: st, address: WALLET_A, chainId: CHAIN, positionId: "82", signMessage: signWith(signerA) });
  const s = JSON.stringify(blob);
  assert.ok(!s.includes(pkA.slice(2)), "signing key material in blob");
  assert.ok(!s.includes(st.controlSecret.toString()), "plaintext controlSecret in blob");
  assert.ok(!s.includes(st.salt.toString()), "plaintext salt in blob");
  assert.ok(!s.includes(st.collateral.toString()), "plaintext collateral in blob");
});
