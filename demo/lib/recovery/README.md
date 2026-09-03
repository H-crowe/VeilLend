# VeilLend Recovery Prototype (Milestone 1)

Encrypted, wallet-owned backup of the private lending state — no localStorage
dependency for recovery, no VeilLend backend/server. Prototype scope: it only
restores the local witness material; every protocol action still goes through
the existing ZK + on-chain checks.

## Flow

```
Private State ──> domain-separated EIP-191 challenge ──> wallet signature
                                                        │
                          HKDF-SHA256(sig, salt=recoveryId, info=…Wrap V1)
                                                        │ wrapKey
random dataKey ── AES-256-GCM ──> encrypted state ──────┤
dataKey ──────── AES-256-GCM ───> wrapped key ──────────┴──> backup blob
                                                  (external storage, ciphertext)
```

Recovery: fetch blob → re-sign the SAME challenge with the SAME wallet →
re-derive wrapKey → unwrap dataKey → decrypt state → recompute the Poseidon
commitment → compare with the on-chain `activeCommitment` → only then restore
locally.

## Design decisions

- **Deterministic signature assumption.** The wrap key is derived from the
  signature bytes, so the wallet must produce identical bytes for the same
  challenge. Verified on the demo stack (viem and ethers v6 both use
  @noble/secp256k1 with RFC 6979 deterministic k) across independent
  processes (`tests/signature-determinism.test.mts`, 3/3) and on the real
  injected wallet (`/sigtest` page). NOT guaranteed for hardware wallets —
  they sign non-deterministically; recovery will fail closed and the backup
  must be re-created from the (still usable) session.
- **EIP-191 domain-separated challenge.** The signed text is
  `"VeilLend Recovery V1" + purpose + wallet address + per-backup random
  recoveryId + chain id + app-only warning`. The recoveryId is fresh random
  16 bytes per backup (public); the address binds the blob to one wallet;
  the domain strings prevent cross-protocol signature reuse.
- **HKDF-SHA256.** `wrapKey = HKDF-SHA256(ikm = signature, salt = recoveryId,
  info = "VeilLend Recovery Wrap Key V1")`, 256-bit output. Domain-separated
  derivation; no raw signature is ever used directly as a key.
- **AES-256-GCM.** The state is encrypted with a fresh random 256-bit data
  key (random 96-bit IV); the data key is wrapped with the signature-derived
  key. Both layers are GCM-authenticated and bound via AAD
  `"VeilLend Recovery V1|<chainId>|<address>"` — any edit to the ciphertext,
  recoveryId or challenge fails authentication.
- **Backup lives outside localStorage.** The blob is opaque ciphertext stored
  via the `BackupStore` abstraction (`lib/recovery/storage.ts`). This
  milestone: `FileBackupStore` (durable file the user keeps). The key is only
  ever reconstructed inside the wallet holder's session.
- **Commitment verification.** After decryption the recovered state is
  re-committed with the production Poseidon circuit hash
  (`computeCommitment`) and compared against the on-chain `activeCommitment`
  for that position. Mismatch (e.g. a stale pre-deposit blob) = FAIL —
  nothing is restored.
- **Recovery grants no on-chain permissions.** It only restores local witness
  material. Borrow/withdraw/liquidate still require Groth16 proofs with the
  on-chain-derived `msg.sender` recipient binding and the existing caps; a
  recovered state is exactly as powerful as a locally kept one.
- **Fail-closed everywhere.** Wrong wallet, wrong recoveryId, modified
  challenge/ciphertext, or an incomplete decrypted record abort with distinct
  errors and restore nothing.

## Files

- `lib/recovery/recovery.ts` — challenge, HKDF, AES-GCM, blob create/recover
- `lib/recovery/storage.ts` — `BackupStore` abstraction (File / Memory)
- `app/recovery-test/page.tsx` — milestone UI (backup / clear / recover / verdict)
- `app/sigtest/page.tsx` — diagnostic page that gated the determinism assumption
- `tests/recovery.test.mts` (7), `tests/signature-determinism.test.mts` (3),
  `tests/persistence.test.mts` (3)

## Results (recorded at milestone close)

- demo test suite: **13/13 passed**
- root protocol suite: **120 passed** (unchanged)
- manual: Backup → Clear Local State → Recover → Poseidon commitment matched
  the on-chain active commitment (same wallet, fresh session)

## Current limitations

- Hardware wallets (non-deterministic signatures) cannot recover; re-create
  the backup from a live session instead.
- Losing the backup file = no recovery (by design — no central copies).
- Anyone who can make the wallet sign the exact challenge (phishing the same
  text) could decrypt the blob; mitigated by the visible domain-separated
  text and the fact the blob grants no on-chain rights.
- `FileBackupStore` is manual durability; discovery by wallet address is not
  implemented.

## Deferred (explicitly out of scope for this milestone)

- Registry contract mapping wallet → backup pointer/hash (only if address
  discovery without a file is wanted — no secret material on-chain).
- IPFS / Arweave adapters (same `BackupStore` interface).
- ZK repay/withdraw executed directly from the recovered state (next
  milestone).
