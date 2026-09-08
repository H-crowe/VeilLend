/**
 * Encrypted-backup storage abstraction.
 *
 * The blob is ciphertext (AES-256-GCM, wallet-derived key) — nothing in it is
 * sensitive, so the storage layer only needs durability. The VeilLend backend
 * is deliberately NOT one of the adapters.
 *
 * This milestone ships:
 *   - MemoryBackupStore  — tests / same-tab flows
 *   - FileBackupStore    — durable file the user keeps (download / upload)
 * Future adapters (same interface, no protocol changes): IPFS pin, Arweave,
 * or a Registry contract that maps wallet → blob pointer.
 */

export interface BackupStore {
  /** Persists the blob JSON durably and returns the lookup name. */
  save(name: string, blobJson: string): Promise<string>;
  /** Loads the blob JSON by lookup name. */
  load(name: string): Promise<string>;
}

export function backupFileName(address: string, positionId: string, recoveryId: string): string {
  return `veillend-recovery-${address.toLowerCase().slice(0, 10)}-pos${positionId}-${recoveryId.slice(0, 8)}.json`;
}

/**
 * User-facing recovery filename used by the main demo page — clearly
 * identifies the position number it restores.
 */
export function recoveryFileName(positionId: string): string {
  return `VeilLend-Position-${positionId}-Recovery.json`;
}

export class MemoryBackupStore implements BackupStore {
  private entries = new Map<string, string>();
  async save(name: string, blobJson: string): Promise<string> {
    this.entries.set(name, blobJson);
    return name;
  }
  async load(name: string): Promise<string> {
    const v = this.entries.get(name);
    if (v === undefined) throw new Error(`backup not found: ${name}`);
    return v;
  }
}

/** Durable file adapter: "save" downloads the blob; "load" reads a chosen file. */
export class FileBackupStore implements BackupStore {
  async save(name: string, blobJson: string): Promise<string> {
    if (typeof document === "undefined") throw new Error("FileBackupStore.save is browser-only");
    const url = URL.createObjectURL(new Blob([blobJson], { type: "application/json" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return name;
  }
  async load(name: string): Promise<string> {
    throw new Error(`FileBackupStore.load(${name}) is handled by the file picker in the UI — call loadFromFile(file) instead`);
  }
}

export async function loadFromFile(file: File): Promise<string> {
  return file.text();
}
