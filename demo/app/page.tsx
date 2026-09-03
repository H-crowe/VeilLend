"use client";

import { useEffect, useState } from "react";
import { useVeilLend, type ActionKind, type TxState } from "@/hooks/useVeilLend";
import { explorerAddress } from "@/lib/chains";

function short(a: string) { return a.slice(0, 6) + "…" + a.slice(-4); }
function fmtTokens(wei: bigint) { return (Number(wei) / 1e18).toFixed(2); }
function parseAmount(s: string): bigint {
  const t = s.trim();
  if (!t || isNaN(Number(t))) return 0n;
  return BigInt(Math.floor(Number(t) * 1e6)) * (10n ** 12n); // 18-decimals, 1e6 precision
}

export default function Page() {
  // wagmi restores wallet state from localStorage during the first client
  // render, which cannot match the server prerender. Gate the dynamic UI
  // behind a mounted flag so the hydration render is identical on server
  // and client; dynamic content renders only after hydration completes.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const v = useVeilLend();
  const [amountDeposit, setAmountDeposit] = useState("10");
  const [amountBorrow, setAmountBorrow] = useState("5");
  const [amountRepay, setAmountRepay] = useState("5");
  const [amountWithdraw, setAmountWithdraw] = useState("10");

  const oc = v.onChain;
  const busy = v.tx.status !== "idle" && v.tx.status !== "confirmed" && v.tx.status !== "failed";
  const disabled = busy || !v.snarkReady || !v.isConnected || !v.onHorizen;

  async function act(kind: ActionKind, amountStr?: string) {
    const amount = amountStr ? parseAmount(amountStr) : null;
    try { await v.runAction(kind, amount); } catch { /* surfaced via tx state */ }
  }

  if (!mounted) {
    return (
      <div className="container">
        <header className="header">
          <div className="brand">
            <span className="brand-name">VeilLend</span>
            <span className="brand-tag">Confidential lending</span>
          </div>
          <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
            <span className="net-badge">Horizen Testnet · 2651420</span>
          </div>
        </header>
        <section className="hero">
          <h1>Private lending, without public positions.</h1>
          <p>Your financial state stays private.<br />The protocol still proves what matters.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="container">
      <header className="header">
        <div className="brand">
          <span className="brand-name">VeilLend</span>
          <span className="brand-tag">Confidential lending</span>
        </div>
        <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
          <span className={"net-badge" + (v.isConnected && !v.onHorizen ? " bad" : "")}>Horizen Testnet · 2651420</span>
          {!v.isConnected ? (
            <button className="action-btn primary" style={{ padding: "8px 16px" }} onClick={() => v.connect()}>
              Connect Wallet
            </button>
          ) : (
            <a className="net-badge mono" href={explorerAddress(v.address!)} target="_blank" rel="noreferrer">{short(v.address!)}</a>
          )}
        </div>
      </header>

      {!v.isConnected ? (
        <>
          <section className="hero">
            <h1>Private lending, without public positions.</h1>
            <p>Your financial state stays private.<br />The protocol still proves what matters.</p>
            <div className="spacer" />
            <button className="action-btn primary" style={{ padding: "12px 28px" }} onClick={() => v.connect()}>
              Connect Wallet
            </button>
            <p className="hint" style={{ marginTop: 14 }}>
              Connect an injected wallet (MetaMask / compatible) to Horizen Testnet (chain ID 2651420).
            </p>
          </section>
          <SafetyPanel />
        </>
      ) : !v.onHorizen ? (
        <section className="panel">
          <div className="panel-title">Wrong network</div>
          <p style={{ color: "var(--text-secondary)", marginBottom: 16 }}>
            This demo runs on Horizen Testnet (chain ID 2651420). Your wallet is connected to a different network.
          </p>
          <button className="action-btn primary" style={{ padding: "10px 20px" }} onClick={() => v.switchChain()}>
            Switch to Horizen Testnet
          </button>
        </section>
      ) : (
        <>
          {/* positions */}
          <section className="panel">
            <div className="panel-title">Your private positions</div>
            {v.positions.length > 0 ? (
              <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
                <select
                  className="select"
                  value={v.selectedId ?? ""}
                  onChange={(e) => v.setSelectedId(e.target.value)}
                  aria-label="Select position"
                >
                  {v.positions.map((p) => (
                    <option key={p.positionId} value={p.positionId}>Position #{p.positionId}</option>
                  ))}
                </select>
                <span className="hint">Private state is stored in this browser only.</span>
              </div>
            ) : (
              <p className="hint">No positions in this browser yet — create one to begin.</p>
            )}
            <div className="spacer" />
            <button className="action-btn" disabled={busy} onClick={() => act("create")}>Create New Position</button>
            <div className="footnote">vCOL / vDBT are testnet demo assets, not production tokens.</div>
          </section>

          {/* position card + actions */}
          {v.selectedId && oc && (
            <section className="panel">
              <div className="panel-title">Position #{v.selectedId}</div>
              <div style={{ marginBottom: 14 }}>
                <span className="status-dot" style={oc.status !== 1 ? { background: "var(--text-dim)" } : undefined} />
                <span className="mono">{oc.status === 1 ? "ACTIVE" : oc.status === 2 ? "CLOSED" : "—"}</span>
              </div>
              <div className="pos-row">
                <div className="metric"><div className="label">Collateral</div><div className="value"><span className="private-tag">🔒 PRIVATE</span></div></div>
                <div className="metric"><div className="label">Debt</div><div className="value"><span className="private-tag">🔒 PRIVATE</span></div></div>
                <div className="metric"><div className="label">Health</div><div className="value"><span className="private-tag">🔒 PRIVATE</span></div></div>
              </div>
              <div className="actions">
                <button className="action-btn primary" disabled={disabled} onClick={() => act("deposit", amountDeposit)}>Deposit</button>
                <button className="action-btn" disabled={disabled} onClick={() => act("borrow", amountBorrow)}>Borrow</button>
                <button className="action-btn" disabled={disabled} onClick={() => act("repay", amountRepay)}>Repay</button>
                <button className="action-btn" disabled={disabled} onClick={() => act("withdraw", amountWithdraw)}>Withdraw</button>
              </div>
              <div className="amount-row">
                <label style={{ flex: 1 }}><div className="hint">Deposit / Withdraw (vCOL)</div>
                  <input type="text" value={amountDeposit} onChange={(e) => { setAmountDeposit(e.target.value); setAmountWithdraw(e.target.value); }} aria-label="Deposit or withdraw amount in vCOL" />
                </label>
                <label style={{ flex: 1 }}><div className="hint">Borrow / Repay (vDBT)</div>
                  <input type="text" value={amountBorrow} onChange={(e) => { setAmountBorrow(e.target.value); setAmountRepay(e.target.value); }} aria-label="Borrow or repay amount in vDBT" />
                </label>
              </div>
              <div className="two-col" style={{ marginTop: 6 }}>
                <div className="hint">Supported collateral (public): {fmtTokens(oc.supported)} vCOL</div>
                <div className="hint">Outstanding borrow (public): {fmtTokens(oc.outstanding)} vDBT</div>
              </div>
              <div className="footnote" style={{ marginTop: 6 }}>
                Borrow rule (deployed circuit): a borrow may not exceed this position&apos;s hidden collateral and must
                keep it solvent at current oracle prices (max LTV 75%).
              </div>
            </section>
          )}

          {v.selectedId && <ProofStatus tx={v.tx} commitment={oc?.activeCommitment} sequence={oc?.sequence} snarkReady={v.snarkReady} />}

          {v.selectedId && oc && oc.status === 1 && (
            <section className="panel">
              <div className="panel-title">Private liquidation</div>
              <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 12 }}>
                A position can be liquidated when it becomes undercollateralized. The condition is proven in
                zero knowledge — the hidden collateral and debt are not revealed. In this demo the controller
                can self-liquidate when the testnet oracle makes the position eligible.
              </p>
              {v.isEligible === null ? (
                <p className="hint">Load this position&apos;s private state in this browser to evaluate eligibility.</p>
              ) : v.isEligible ? (
                <>
                  <p className="warn-text" style={{ fontSize: 13, marginBottom: 10 }}>
                    Position is undercollateralized at current oracle prices — eligible for liquidation.
                  </p>
                  <button className="action-btn primary" disabled={busy} onClick={() => act("liquidate")}>Generate Proof &amp; Liquidate</button>
                </>
              ) : (
                <p className="hint">Not eligible at current oracle prices — the eligibility proof cannot be generated for a healthy position.</p>
              )}
            </section>
          )}

          {/* test assets */}
          <section className="panel">
            <div className="panel-title">Testnet assets (test-only)</div>
            <div className="actions" style={{ gridTemplateColumns: "1fr 1fr 1fr 1fr" }}>
              <button className="action-btn" disabled={busy || !v.isConnected} onClick={() => v.mintTestTokens("vCOL", 100n * 10n ** 18n)}>Mint 100 vCOL</button>
              <button className="action-btn" disabled={busy || !v.isConnected} onClick={() => v.mintTestTokens("vDBT", 50n * 10n ** 18n)}>Mint 50 vDBT</button>
              <button className="action-btn" disabled={busy || !v.isConnected} onClick={() => v.seedLiquidity(20n * 10n ** 18n)}>Seed 20 vDBT liquidity</button>
              <button className="action-btn" disabled={busy || !v.isConnected} onClick={() => v.refreshOraclePrices().catch(() => { /* surfaced via tx state */ })}>Refresh oracle prices</button>
            </div>
            <div className="footnote">
              Seeding liquidity mints vDBT and repays it into the protocol reserve — the M1 design funds
              borrows from repayments. Borrow/withdraw/liquidate require fresh oracle prices (1h limit on
              the mock testnet oracle) — refresh them here when they go stale.
            </div>
          </section>

          <TxStatus tx={v.tx} />
          <SafetyPanel />

          <footer style={{ marginTop: 40, paddingBottom: 20 }}>
            <p className="footnote">
              Demo for Horizen Builder Ecosystem Fund S2 · testnet only · unaudited · vCOL/vDBT are mocks.
              Protocol and audit documentation: see the repository README.
            </p>
          </footer>
        </>
      )}
    </div>
  );
}

function SafetyPanel() {
  return (
    <section className="panel">
      <div className="panel-title">Protocol safety</div>
      <div className="safety">
        <div className="item"><div className="k">Oracle</div><div className="v ok">✓ Fresh</div></div>
        <div className="item"><div className="k">Solvency</div><div className="v ok">✓ Proven in ZK</div></div>
        <div className="item"><div className="k">Recipient binding</div><div className="v ok">✓ Active</div></div>
        <div className="item"><div className="k">Replay protection</div><div className="v ok">✓ Active</div></div>
      </div>
    </section>
  );
}

function ProofStatus({ tx, commitment, sequence, snarkReady }: { tx: TxState; commitment?: string; sequence?: bigint; snarkReady: boolean }) {
  return (
    <section className="panel">
      <div className="panel-title">ZK verification</div>
      {!snarkReady && <p className="hint">Loading proving engine…</p>}
      <div className="proof-box">
        <div className="row"><span className="k">System</span><span>Groth16 · BN254</span></div>
        <div className="row"><span className="k">Circuits</span><span>state_transition · risk_transition · liquidation</span></div>
        <div className="row"><span className="k">Sequence</span><span>{sequence !== undefined ? String(sequence).padStart(2, "0") : "—"}</span></div>
        <div className="row"><span className="k">Commitment</span><span>{commitment ? short(commitment) : "—"}</span></div>
        <div className="row"><span className="k">Last proof</span><span className={tx.proofVerified ? "ok" : ""}>{tx.proofVerified ? "✓ Verified on-chain" : tx.status === "proving" ? "generating…" : "—"}</span></div>
      </div>
    </section>
  );
}

function TxStatus({ tx }: { tx: TxState }) {
  if (tx.status === "idle") return null;
  const steps = ["preparing", "proving", "submitting", "wallet", "confirming", "confirmed"];
  const idx = tx.status === "failed" ? -1 : steps.indexOf(tx.status);
  return (
    <section className="panel">
      <div className="panel-title">Transaction</div>
      <div className="step-indicator">
        {steps.map((s, i) => (
          <span key={s} className={"step" + (tx.status === "failed" ? " err" : i < idx ? " done" : i === idx ? " active" : "")}>{s}</span>
        ))}
        {tx.status === "failed" && <span className="step err">Failed</span>}
      </div>
      {tx.status === "failed" && tx.error && <p className="err" style={{ fontSize: 13 }}>{tx.error}</p>}
      {tx.status === "confirmed" && tx.softWarning && (
        <p className="warn-text" style={{ fontSize: 13 }}>
          {tx.softWarning} The transaction itself succeeded and was not re-sent.
        </p>
      )}
      {tx.txHash && (
        <div className="proof-box">
          {tx.block !== undefined && <div className="row"><span className="k">block</span><span>{tx.block}</span></div>}
          {tx.gasUsed && <div className="row"><span className="k">gas</span><span>{tx.gasUsed}</span></div>}
          {tx.explorerUrl && <div className="row"><span className="k">explorer</span><a href={tx.explorerUrl} target="_blank" rel="noreferrer">View on Explorer</a></div>}
        </div>
      )}
    </section>
  );
}
