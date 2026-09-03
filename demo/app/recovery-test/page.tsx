"use client";

/**
 * Recovery milestone test page — Private State → wallet-derived key →
 * encrypted backup → clear local state → recover in a fresh session →
 * decrypt → Poseidon commitment must match the on-chain active commitment.
 *
 * Test-only page: no protocol changes, no ZK repay/withdraw here. The backup
 * is stored OUTSIDE localStorage (downloaded encrypted blob via the
 * FileBackupStore adapter — replaceable with decentralized storage).
 */

import { useState } from "react";
import { useAccount, usePublicClient, useSignMessage } from "wagmi";
import { createRecoveryBlob, recoverStateFromBlob, type RecoveryBlob } from "@/lib/recovery/recovery";
import { FileBackupStore, backupFileName, loadFromFile } from "@/lib/recovery/storage";
import { clearLocalState, saveLastSelected, savePosition, serializeState } from "@/lib/state/store";
import { computeCommitment } from "@/lib/zk/witness";
import { horizenTestnet, explorerAddress } from "@/lib/chains";
import { ADDRESSES } from "@/lib/contracts/addresses";
import { veilLendAbi } from "@/lib/contracts/abis";
import { useVeilLend } from "@/hooks/useVeilLend";
import type { Address } from "viem";

type Phase = "idle" | "backing-up" | "clearing" | "recovering";

function short32(v: string) {
  return v.length > 20 ? v.slice(0, 12) + "…" + v.slice(-8) : v;
}

export default function RecoveryTestPage() {
  const v = useVeilLend();
  const publicClient = usePublicClient();
  const { signMessageAsync } = useSignMessage();
  const [phase, setPhase] = useState<Phase>("idle");
  const [message, setMessage] = useState("");
  const [result, setResult] = useState<null | { pass: boolean; recoveredCommitment?: string; onChainCommitment?: string; detail?: string }>(null);
  const [lastBlob, setLastBlob] = useState<{ name: string; json: string } | null>(null);

  const busy = phase !== "idle";
  const signer = async (msg: string) => signMessageAsync({ message: msg });

  async function backup() {
    if (!v.address || !v.selectedState || !v.selectedId) return;
    setPhase("backing-up");
    setResult(null);
    try {
      const { blob, recoveryId } = await createRecoveryBlob({
        state: v.selectedState,
        address: v.address,
        chainId: horizenTestnet.id,
        positionId: v.selectedId,
        signMessage: signer,
      });
      const json = JSON.stringify(blob, null, 2);
      const name = backupFileName(v.address, v.selectedId, recoveryId);
      await new FileBackupStore().save(name, json);
      setLastBlob({ name, json });
      setMessage(`Encrypted backup created and downloaded as ${name}. Store it anywhere durable — it is ciphertext bound to your wallet.`);
    } catch (e) {
      setMessage(`Backup failed: ${(e as Error).message}`);
    } finally {
      setPhase("idle");
    }
  }

  function clearLocal() {
    if (!v.address) return;
    setPhase("clearing");
    clearLocalState(v.address);
    setMessage("All local private state for this wallet was cleared. Reload the page — the app will look like a fresh session.");
    setPhase("idle");
  }

  async function recover(file: File) {    setPhase("recovering");
    setResult(null);
    try {
      if (!v.address || !publicClient) throw new Error("wallet not connected");
      const blob = JSON.parse(await loadFromFile(file)) as RecoveryBlob;
      const recovered = await recoverStateFromBlob({ blob, address: v.address, chainId: horizenTestnet.id, signMessage: signer });

      // read the CURRENT on-chain active commitment for this position
      const raw = await publicClient.readContract({
        address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "positions", args: [BigInt(blob.positionId)],
      }) as unknown;
      const f: unknown[] = Array.isArray(raw) ? raw : Object.values((raw ?? {}) as Record<string, unknown>);
      const onChainCommitment = String(f[2]);
      const active = Number(f[5]) === 1;

      const recoveredCommitment = "0x" + (await computeCommitment(recovered)).toString(16).padStart(64, "0");
      const match = recoveredCommitment.toLowerCase() === onChainCommitment.toLowerCase();

      setResult({ pass: match && active, recoveredCommitment, onChainCommitment, detail: active ? undefined : "position is not Active on-chain" });
      if (match && active) {
        // restore into the app: local store + selection, then a reload makes
        // the main page use the recovered witness material
        savePosition(v.address, { positionId: blob.positionId, state: serializeState(recovered), createdAt: new Date().toISOString() });
        saveLastSelected(v.address, blob.positionId);
        setMessage("Recovery PASS — local state restored. Reload the app to use the recovered position.");
      } else {
        setMessage("Recovery FAILED the commitment check — nothing was restored.");
      }
    } catch (e) {
      setResult({ pass: false, detail: (e as Error).message });
      setMessage("Recovery FAILED — no state was restored.");
    } finally {
      setPhase("idle");
    }
  }

  function clearLocalState(address: string) {
    const prefixes = [`veillend:positions:${address.toLowerCase()}`, `veillend:lastSelected:${address.toLowerCase()}`];
    for (const k of Object.keys(window.localStorage)) {
      if (prefixes.some((p) => k.startsWith(p))) window.localStorage.removeItem(k);
    }
  }

  return (
    <div className="container">
      <header className="header">
        <div className="brand">
          <span className="brand-name">VeilLend</span>
          <span className="brand-tag">Recovery prototype — milestone 1</span>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          {!v.isConnected ? (
            <button className="action-btn primary" style={{ padding: "8px 16px" }} onClick={() => v.connect()}>Connect Wallet</button>
          ) : (
            <a className="net-badge mono" href={explorerAddress(v.address!)} target="_blank" rel="noreferrer">{short32(v.address!)}</a>
          )}
        </div>
      </header>

      {!v.isConnected ? (
        <section className="panel"><p className="hint">Connect the wallet that owns the position you want to back up / recover.</p></section>
      ) : (
        <>
          <section className="panel">
            <div className="panel-title">1 · Select a position to back up</div>
            {v.positions.length > 0 ? (
              <select className="select" value={v.selectedId ?? ""} onChange={(e) => v.setSelectedId(e.target.value)} aria-label="Select position">
                <option value="">— select —</option>
                {v.positions.map((p) => (<option key={p.positionId} value={p.positionId}>Position #{p.positionId}</option>))}
              </select>
            ) : (
              <p className="hint">No local positions. Create one on the main page first.</p>
            )}
            <div className="hint" style={{ marginTop: 8 }}>
              {v.selectedState
                ? `Witness loaded: seq ${v.selectedState.sequence.toString()}, collateral ${Number(v.selectedState.collateral) / 1e18} vCOL, debt ${Number(v.selectedState.debt) / 1e18} vDBT`
                : "No position selected / no witness material."}
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">2 · Create encrypted backup (download — not localStorage)</div>
            <button className="action-btn primary" disabled={busy || !v.selectedState} onClick={() => void backup()}>
              Create Encrypted Backup
            </button>
            <div className="hint" style={{ marginTop: 8 }}>
              Signs the domain-separated challenge with your wallet (deterministic), encrypts the private state with a
              random AES-256-GCM data key, and wraps that key with the signature-derived key. The downloaded file is ciphertext.
            </div>
          </section>

          <section className="panel">
            <div className="panel-title">3 · Clear local state (simulates a fresh browser)</div>
            <button className="action-btn" disabled={busy || !v.address} onClick={() => { clearLocal(); window.location.reload(); }}>
              Clear Local State
            </button>
            <div className="hint" style={{ marginTop: 8 }}>Wipes all private-state keys for this wallet. The encrypted backup file is unaffected.</div>
          </section>

          <section className="panel">
            <div className="panel-title">4 · Recover from the encrypted backup</div>
            <input
              type="file" accept="application/json,.json" aria-label="Backup file"
              disabled={busy || !v.isConnected}
              onChange={(e) => { const f = e.target.files?.[0]; if (f) void recover(f); }}
            />
            <div className="hint" style={{ marginTop: 8 }}>
              Signs the same challenge again with the same wallet, decrypts, recomputes the Poseidon commitment and
              compares it with the on-chain active commitment before restoring anything.
            </div>
          </section>

          {message && <section className="panel"><div className="panel-title">Status</div><p className="hint">{message}</p></section>}

          {result && (
            <section className="panel">
              <div className="panel-title">{result.pass ? "✓ RECOVERY PASS" : "✗ RECOVERY FAIL"}</div>
              <div className="proof-box">
                <div className="row"><span className="k">Recovered commitment</span><span className="mono">{result.recoveredCommitment ? short32(result.recoveredCommitment) : "—"}</span></div>
                <div className="row"><span className="k">On-chain commitment</span><span className="mono">{result.onChainCommitment ? short32(result.onChainCommitment) : "—"}</span></div>
                <div className="row"><span className="k">Match</span><span>{result.pass ? "YES" : "NO"}</span></div>
                {result.detail && <div className="row"><span className="k">Detail</span><span>{result.detail}</span></div>}
              </div>
              {result.pass && <p className="hint">Reload the app — the recovered position is selected and its witness material is usable for proofs.</p>}
            </section>
          )}
        </>
      )}
    </div>
  );
}
