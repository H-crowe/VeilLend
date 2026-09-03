/**
 * VeilLend Recovery V1 — deterministic wallet-derived backup encryption.
 *
 * Threat-model-relevant properties:
 *  - The encryption wrap key is derived from an EIP-191 personal signature of
 *    a STRICTLY DOMAIN-SEPARATED challenge (app name + wallet address +
 *    per-backup random recoveryId + chain id). The signing secret never
 *    leaves the wallet and is never stored.
 *  - The wrap key therefore exists only by re-signing the SAME challenge with
 *    the SAME wallet (verified deterministic on the demo wallet — see
 *    tests/signature-determinism.test.mts; limitation: hardware wallets sign
 *    non-deterministically and cannot recover — re-run backup instead).
 *  - The state itself is encrypted with a fresh random data key (AES-256-GCM),
 *    which is wrapped with the signature-derived key. Both layers are
 *    authenticated (GCM) and bound to (domain | chainId | address) via AAD.
 *  - A different wallet, a different recoveryId, or a tampered blob fails
 *    closed BEFORE any private state is returned.
 *  - Recovery grants no on-chain permissions: it only restores the local
 *    witness material. Every protocol action still requires ZK proofs with
 *    on-chain-derived recipient binding.
 */

import { fromHex, recoverMessageAddress, toHex } from "viem";
import type { PrivateState } from "../zk/witness";
import { serializeState, type StoredPosition } from "../state/store";

const APP_DOMAIN = "VeilLend Recovery V1";
const HKDF_INFO = new TextEncoder().encode("VeilLend Recovery Wrap Key V1");

export interface RecoveryBlob {
  v: 1;
  app: string;
  chainId: number;
  address: string; // owner wallet (lowercase)
  positionId: string;
  recoveryId: string; // 32 hex chars (16 random bytes) — public
  challenge: string; // exact signed text — public
  state: { iv: string; ct: string }; // AES-256-GCM(dataKey)
  wrap: { iv: string; ct: string }; // AES-256-GCM(wrapKey) over the raw dataKey
}

export function buildChallenge(address: string, recoveryIdHex: string, chainId: number): string {
  return [
    APP_DOMAIN,
    "This signature encrypts your private lending state backup.",
    `Wallet: ${address.toLowerCase()}`,
    `Recovery ID: ${recoveryIdHex}`,
    `Chain ID: ${chainId}`,
    "",
    "Only sign in the VeilLend demo app.",
  ].join("\n");
}

function randomBytes(n: number): Uint8Array {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return b;
}

function aad(address: string, chainId: number): Uint8Array {
  return new TextEncoder().encode(`${APP_DOMAIN}|${chainId}|${address.toLowerCase()}`);
}

async function aesEncrypt(key: CryptoKey, iv: Uint8Array, plaintext: Uint8Array, additionalData: Uint8Array): Promise<{ iv: string; ct: string }> {
  const ct = await crypto.subtle.encrypt({ name: "AES-GCM", iv: iv as unknown as BufferSource, additionalData: additionalData as unknown as BufferSource, tagLength: 128 }, key, plaintext as unknown as BufferSource);
  return { iv: toHex(iv), ct: toHex(new Uint8Array(ct)) };
}

async function aesDecrypt(key: CryptoKey, enc: { iv: string; ct: string }, additionalData: Uint8Array): Promise<Uint8Array> {
  const pt = await crypto.subtle.decrypt(
    { name: "AES-GCM", iv: fromHex(enc.iv as `0x${string}`, "bytes") as unknown as BufferSource, additionalData: additionalData as unknown as BufferSource, tagLength: 128 },
    key,
    fromHex(enc.ct as `0x${string}`, "bytes") as unknown as BufferSource,
  );
  return new Uint8Array(pt);
}

async function importAesKey(raw: Uint8Array): Promise<CryptoKey> {
  return crypto.subtle.importKey("raw", raw as unknown as BufferSource, "AES-GCM", false, ["encrypt", "decrypt"]);
}

async function deriveWrapKey(signatureHex: string, recoveryIdHex: string): Promise<CryptoKey> {
  const ikm = fromHex(signatureHex as `0x${string}`, "bytes");
  const base = await crypto.subtle.importKey("raw", ikm as unknown as BufferSource, "HKDF", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits(
    { name: "HKDF", hash: "SHA-256", salt: fromHex(`0x${recoveryIdHex}`, "bytes") as unknown as BufferSource, info: HKDF_INFO },
    base,
    256,
  );
  return importAesKey(new Uint8Array(bits));
}

async function expectAddress(sig: string, message: string, expected: string, what: string): Promise<void> {
  let recovered = "";
  try {
    recovered = await recoverMessageAddress({ message, signature: sig as `0x${string}` });
  } catch {
    throw new Error(`VeilLend recovery: invalid signature for ${what}`);
  }
  if (recovered.toLowerCase() !== expected.toLowerCase()) {
    throw new Error(`VeilLend recovery: ${what} was signed by ${recovered}, expected ${expected} — wrong wallet, recovery denied`);
  }
}

export async function createRecoveryBlob(params: {
  state: PrivateState;
  address: string;
  chainId: number;
  positionId: string;
  signMessage: (message: string) => Promise<string>;
}): Promise<{ blob: RecoveryBlob; recoveryId: string }> {
  const address = params.address.toLowerCase();
  const recoveryId = toHex(randomBytes(16)).slice(2);
  const challenge = buildChallenge(address, recoveryId, params.chainId);
  const signature = await params.signMessage(challenge);
  await expectAddress(signature, challenge, address, "backup challenge");

  const wrapKey = await deriveWrapKey(signature, recoveryId);
  const dataKey = randomBytes(32);
  const additionalData = aad(address, params.chainId);

  const state = await aesEncrypt(
    await importAesKey(dataKey),
    randomBytes(12),
    new TextEncoder().encode(JSON.stringify(serializeState(params.state))),
    additionalData,
  );
  const wrap = await aesEncrypt(wrapKey, randomBytes(12), dataKey, additionalData);

  return {
    recoveryId,
    blob: { v: 1, app: APP_DOMAIN, chainId: params.chainId, address, positionId: params.positionId, recoveryId, challenge, state, wrap },
  };
}

export async function recoverStateFromBlob(params: {
  blob: RecoveryBlob;
  address: string;
  chainId: number;
  signMessage: (message: string) => Promise<string>;
}): Promise<PrivateState> {
  const blob = params.blob;
  const address = params.address.toLowerCase();

  if (blob.v !== 1 || blob.app !== APP_DOMAIN) throw new Error("VeilLend recovery: unsupported backup format");
  if (blob.chainId !== params.chainId) throw new Error(`VeilLend recovery: backup is for chain ${blob.chainId}, expected ${params.chainId}`);
  if (blob.address.toLowerCase() !== address) {
    throw new Error(`VeilLend recovery: backup belongs to ${blob.address}, connected wallet is ${address} — wrong wallet, recovery denied`);
  }

  // The challenge must be exactly the one the domain rules produce for this
  // wallet + recoveryId — any edit here is a tamper signal.
  const challenge = buildChallenge(address, blob.recoveryId, params.chainId);
  if (challenge !== blob.challenge) throw new Error("VeilLend recovery: challenge mismatch — backup was modified or recoveryId is wrong");

  const signature = await params.signMessage(blob.challenge);
  await expectAddress(signature, blob.challenge, address, "recovery challenge");

  let dataKey: Uint8Array;
  try {
    const wrapKey = await deriveWrapKey(signature, blob.recoveryId);
    dataKey = await aesDecrypt(wrapKey, blob.wrap, aad(address, params.chainId));
  } catch {
    throw new Error("VeilLend recovery: backup decryption failed (wrong wallet, wrong recoveryId, or corrupted wrap) — no state was restored");
  }

  let stateJson: string;
  try {
    stateJson = new TextDecoder().decode(await aesDecrypt(await importAesKey(dataKey), blob.state, aad(address, params.chainId)));
  } catch {
    throw new Error("VeilLend recovery: state decryption failed — backup integrity check failed, no state was restored");
  }

  let raw: StoredPosition["state"];
  try {
    raw = JSON.parse(stateJson) as StoredPosition["state"];
  } catch {
    throw new Error("VeilLend recovery: decrypted payload is not a valid state record");
  }
  for (const k of ["positionId", "collateralAsset", "debtAsset", "collateral", "debt", "interestIndex", "sequence", "controlSecret", "salt"] as const) {
    if (raw[k] === undefined || !/^-?\d+$/.test(String(raw[k]))) {
      throw new Error(`VeilLend recovery: decrypted state is incomplete (missing ${k}) — refusing to restore`);
    }
  }
  return {
    positionId: BigInt(raw.positionId),
    collateralAsset: BigInt(raw.collateralAsset),
    debtAsset: BigInt(raw.debtAsset),
    collateral: BigInt(raw.collateral),
    debt: BigInt(raw.debt),
    interestIndex: BigInt(raw.interestIndex),
    sequence: BigInt(raw.sequence),
    controlSecret: BigInt(raw.controlSecret),
    salt: BigInt(raw.salt),
  };
}

export function decryptedStateToStored(recovered: PrivateState, createdAt: string): StoredPosition {
  return { positionId: recovered.positionId.toString(), state: serializeState(recovered), createdAt };
}
