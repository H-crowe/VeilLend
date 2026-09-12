/**
 * Script-side private-witness persistence.
 *
 * Same StoredPosition/state JSON shape as demo/lib/state/store.ts (all
 * fields hex-string), but persisted to FILES instead of localStorage so
 * hardhat E2E scripts can resume/complete positions if a later step fails.
 *
 * SECURITY: the store contains control secrets. It lives in
 * `.witness-store/` which MUST stay gitignored — never commit it.
 */

import fs from "fs";
import path from "path";

export interface WitnessState {
  positionId: string;
  collateralAsset: string;
  debtAsset: string;
  collateral: string;
  debt: string;
  interestIndex: string;
  sequence: string;
  controlSecret: string;
  salt: string;
}

export interface StoredWitness {
  positionId: string;
  state: WitnessState;
  createdAt: string;
  updatedAt: string;
  chainId: string;
}

const STORE_DIR = path.join(__dirname, "..", ".witness-store");

function fileFor(positionId: bigint | string, chainId: string): string {
  return path.join(STORE_DIR, `chain-${chainId}-position-${positionId.toString()}.json`);
}

/** Persists (or updates) the witness for a position. Call IMMEDIATELY after
 *  createPosition and after every successful state transition. */
export function saveWitness(positionId: bigint | string, state: WitnessState, chainId: string): string {
  if (!fs.existsSync(STORE_DIR)) fs.mkdirSync(STORE_DIR, { recursive: true });
  const file = fileFor(positionId, chainId);
  const existing = fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, "utf8")) as StoredWitness) : null;
  const record: StoredWitness = {
    positionId: positionId.toString(),
    state,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    chainId,
  };
  fs.writeFileSync(file, JSON.stringify(record, null, 2) + "\n");
  return file;
}

/** Loads the latest saved witness for a position (for resuming a failed run). */
export function loadWitness(positionId: bigint | string, chainId: string): StoredWitness | null {
  const file = fileFor(positionId, chainId);
  if (!fs.existsSync(file)) return null;
  return JSON.parse(fs.readFileSync(file, "utf8")) as StoredWitness;
}
