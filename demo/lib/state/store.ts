/**
 * Local private-state storage.
 *
 * The hidden position state (control secret, salts, balances) lives ONLY in
 * this browser's localStorage, keyed by wallet address. It is the user's
 * copy of their own witness material — losing it means losing access to the
 * position (no one, including the protocol, can recover it).
 *
 * NOTE (demo limitation): localStorage is convenient but not a secure
 * keystore. Export/import is provided for backup. Production would use a
 * proper wallet-integrated keystore.
 */
import type { PrivateState } from "../zk/witness";

const KEY_PREFIX = "veillend:positions:";
const LAST_SELECTED_PREFIX = "veillend:lastSelected:";

export interface StoredPosition {
  positionId: string;
  state: {
    positionId: string;
    collateralAsset: string;
    debtAsset: string;
    collateral: string;
    debt: string;
    interestIndex: string;
    sequence: string;
    controlSecret: string;
    salt: string;
  };
  createdAt: string;
}

function keyFor(address: string) {
  return KEY_PREFIX + address.toLowerCase();
}

export function listPositions(address: string): StoredPosition[] {
  if (typeof window === "undefined") return [];
  try {
    return JSON.parse(window.localStorage.getItem(keyFor(address)) ?? "[]") as StoredPosition[];
  } catch {
    return [];
  }
}

export function savePosition(address: string, position: StoredPosition) {
  const all = listPositions(address).filter((p) => p.positionId !== position.positionId);
  all.push(position);
  window.localStorage.setItem(keyFor(address), JSON.stringify(all));
}

export function getPosition(address: string, positionId: bigint): StoredPosition | undefined {
  return listPositions(address).find((p) => p.positionId === positionId.toString());
}

/**
 * Remembers which position the user last had open, per wallet — UI
 * convenience only, so a browser refresh restores the same selection.
 * `null` clears the entry.
 */
export function saveLastSelected(address: string, positionId: string | null): void {
  if (typeof window === "undefined") return;
  const key = LAST_SELECTED_PREFIX + address.toLowerCase();
  if (positionId === null) window.localStorage.removeItem(key);
  else window.localStorage.setItem(key, positionId);
}

export function getLastSelected(address: string): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(LAST_SELECTED_PREFIX + address.toLowerCase());
}

/** Wipes every private-state key for a wallet (recovery-test flow). */
export function clearLocalState(address: string): void {
  if (typeof window === "undefined") return;
  const prefixes = [KEY_PREFIX + address.toLowerCase(), LAST_SELECTED_PREFIX + address.toLowerCase()];
  for (const k of Object.keys(window.localStorage)) {
    if (prefixes.some((p) => k.startsWith(p))) window.localStorage.removeItem(k);
  }
}

/** Serializes a private state for storage (string-encoded field elements). */
export function serializeState(state: PrivateState): StoredPosition["state"] {
  return {
    positionId: state.positionId.toString(),
    collateralAsset: state.collateralAsset.toString(),
    debtAsset: state.debtAsset.toString(),
    collateral: state.collateral.toString(),
    debt: state.debt.toString(),
    interestIndex: state.interestIndex.toString(),
    sequence: state.sequence.toString(),
    controlSecret: state.controlSecret.toString(),
    salt: state.salt.toString(),
  };
}

export function deserializeState(raw: StoredPosition["state"]): PrivateState {
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

/** Export (backup) — the user's own secret material, handled client-side. */
export function exportPositions(address: string): string {
  return JSON.stringify({ app: "VeilLend demo", version: 1, positions: listPositions(address) }, null, 2);
}

export function importPositions(address: string, json: string): number {
  const parsed = JSON.parse(json) as { positions?: StoredPosition[] };
  if (!Array.isArray(parsed.positions)) throw new Error("invalid backup format");
  const existing = new Set(listPositions(address).map((p) => p.positionId));
  let added = 0;
  for (const p of parsed.positions) {
    if (!p.positionId || !p.state?.controlSecret) continue;
    if (!existing.has(p.positionId)) {
      listPositionsInit(address, p);
      added++;
    }
  }
  return added;
}

function listPositionsInit(address: string, p: StoredPosition) {
  savePosition(address, p);
}
