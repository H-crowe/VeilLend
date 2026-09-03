"use client";

/**
 * DIAGNOSTIC TEST PAGE (test-only artifact, trivially removable).
 *
 * Proves or refutes the deterministic-signature assumption ON THE REAL
 * INJECTED WALLET: sign the same canonical EIP-191 challenge from different
 * sessions (page reloads / tabs) and compare the raw signature bytes.
 *
 * No recovery, encryption or storage logic lives here by design — this page
 * gates the recovery prototype architecture.
 */

import { useState } from "react";
import { useAccount, useSignMessage } from "wagmi";
import { recoverMessageAddress } from "viem";

const STORAGE_KEY = "veillend:recovery-sigtest";

function challenge(address: string, recoveryId: string): string {
  return [
    "VeilLend Recovery V1",
    "This signature encrypts your private lending state backup.",
    `Wallet: ${address.toLowerCase()}`,
    `Recovery ID: ${recoveryId}`,
    "Chain ID: 2651420",
    "",
    "Only sign in the VeilLend demo app.",
  ].join("\n");
}

const RID = "a".repeat(64); // fixed recovery id — the SAME one must be re-signed

export default function SigTestPage() {
  const { address, isConnected } = useAccount();
  const { signMessageAsync } = useSignMessage();
  const [current, setCurrent] = useState("");
  const [recovered, setRecovered] = useState("");
  const [error, setError] = useState("");

  const previous = typeof window !== "undefined" ? (window.localStorage.getItem(STORAGE_KEY) ?? "") : "";

  async function sign() {
    setError("");
    if (!address) return;
    try {
      const sig = await signMessageAsync({ message: challenge(address, RID) });
      setCurrent(sig);
      // verify the signature recovers to the connected address
      let rec = "";
      try {
        rec = await recoverMessageAddress({ message: challenge(address, RID), signature: sig });
      } catch { rec = "recovery failed"; }
      setRecovered(rec);
      window.localStorage.setItem(STORAGE_KEY, sig);
    } catch (e) {
      setError(String((e as Error).message ?? e).slice(0, 160));
    }
  }

  function reset() {
    window.localStorage.removeItem(STORAGE_KEY);
    setCurrent("");
    setRecovered("");
  }

  const identical = previous !== "" && current !== "" && previous === current;
  const addressMatches = recovered.toLowerCase() === (address ?? "").toLowerCase();

  return (
    <div className="container">
      <header className="header">
        <div className="brand">
          <span className="brand-name">VeilLend</span>
          <span className="brand-tag">Signature determinism test (diagnostic only)</span>
        </div>
      </header>

      <section className="panel">
        <div className="panel-title">Same wallet + same EIP-191 challenge → identical signature bytes?</div>
        {!isConnected ? (
          <p className="hint">Connect the injected wallet first (top-right button on the main page, then reload here).</p>
        ) : (
          <>
            <div className="proof-box">
              <div className="row"><span className="k">Wallet</span><span className="mono">{address}</span></div>
              <div className="row"><span className="k">Recovery ID (fixed)</span><span className="mono">{RID.slice(0, 16)}…</span></div>
            </div>
            <div className="spacer" />
            <button className="action-btn primary" onClick={() => void sign()}>Sign challenge</button>
            <button className="action-btn" onClick={reset} style={{ marginLeft: 10 }}>Reset stored signature</button>
            {error && <p className="err" style={{ marginTop: 12 }}>{error}</p>}
            {current && (
              <div className="proof-box" style={{ marginTop: 14 }}>
                <div className="row"><span className="k">This session</span><span className="mono">{current.slice(0, 30)}…{current.slice(-10)}</span></div>
                <div className="row"><span className="k">Previous session</span><span className="mono">{previous ? previous.slice(0, 30) + "…" + previous.slice(-10) : "—"}</span></div>
                <div className="row"><span className="k">Recovered address</span><span className={"mono" + (addressMatches ? "" : " err")}>{recovered || "—"} {addressMatches ? "✓ matches" : ""}</span></div>
                <div className="row"><span className="k">VERDICT</span><span>{previous === "" ? "sign again after a page reload (or in a new tab) to compare" : identical ? "✓ IDENTICAL — deterministic on this wallet" : "✗ DIFFERENT — signature is NOT deterministic on this wallet"}</span></div>
              </div>
            )}
            <p className="hint" style={{ marginTop: 12 }}>
              Procedure: click Sign → note the verdict prompt → reload this page (or open it in a second tab) →
              click Sign again → the verdict compares the raw bytes across sessions.
            </p>
          </>
        )}
      </section>
    </div>
  );
}
