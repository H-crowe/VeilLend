"use client";

import { useEffect, useState } from "react";
import { useDisconnect, usePublicClient, useSignMessage } from "wagmi";
import { useVeilLend, type ActionKind, type TxState } from "@/hooks/useVeilLend";
import { usePools } from "@/hooks/usePools";
import PoolPanel from "./PoolPanel";
import { explorerAddress, horizenTestnet } from "@/lib/chains";
import { createRecoveryBlob } from "@/lib/recovery/recovery";
import { parseRecoveryFile, verifyAndRestore } from "@/lib/recovery/restore";
import { FileBackupStore, recoveryFileName } from "@/lib/recovery/storage";
import { saveLastSelected, savePosition, serializeState } from "@/lib/state/store";
import type { AssetEntry } from "@/lib/contracts/addresses";

function short(a: string) { return a.slice(0, 6) + "…" + a.slice(-4); }
/** Decimals-aware formatting for the asset registry (USDC has 6 decimals). */
function fmtAssetBalance(wei: bigint, decimals: number) { return (Number(wei) / 10 ** decimals).toFixed(2); }
function parseAmount(s: string, decimals: number): bigint {
  const t = s.trim();
  if (!t || isNaN(Number(t))) return 0n;
  // 1e6 fractional precision, scaled to the asset's decimals (>= 6 everywhere)
  return BigInt(Math.floor(Number(t) * 1e6)) * (10n ** BigInt(decimals - 6));
}
function assetByAddress(assets: readonly AssetEntry[], addr: string): AssetEntry {
  return (
    assets.find((a) => a.address !== "" && a.address.toLowerCase() === addr.toLowerCase()) ?? {
      symbol: "Unknown", address: addr, decimals: 18, storkFeedId: "", status: "locked",
      note: "Asset not in the demo registry",
    }
  );
}

/**
 * Position-creation wizard steps. The wizard reuses the exact same
 * runAction("create" | "deposit" | "borrow") pipeline as the standalone
 * actions — it only sequences and presents them.
 */
const WIZARD_STEPS = ["Choose Assets", "Collateral", "Borrow", "Review", "Created"] as const;

export default function Page() {
  // wagmi restores wallet state from localStorage during the first client
  // render, which cannot match the server prerender. Gate the dynamic UI
  // behind a mounted flag so the hydration render is identical on server
  // and client; dynamic content renders only after hydration completes.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const v = useVeilLend();
  const pools = usePools();
  const publicClient = usePublicClient();
  const { signMessageAsync } = useSignMessage();
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryMsg, setRecoveryMsg] = useState<null | { ok: boolean; text: string }>(null);

  // MVP asset configuration: vCOL is the ONLY collateral; vDBT and USDC are
  // the ONLY debt assets. ZEN stays locked (no price feed).
  const collateralChoices = v.ASSETS.filter((a) => a.status !== "locked" && a.symbol !== "vDBT");
  const debtChoices = v.ASSETS.filter((a) => a.status !== "locked" && a.symbol !== "vCOL");
  const [collateralSymbol] = useState("vCOL"); // only one collateral in the MVP
  const [debtSymbol, setDebtSymbol] = useState("vDBT");
  const collateral = collateralChoices.find((a) => a.symbol === collateralSymbol) ?? collateralChoices[0];
  const debt = debtChoices.find((a) => a.symbol === debtSymbol) ?? debtChoices[0];

  const [amountDeposit, setAmountDeposit] = useState("10");
  const [amountBorrow, setAmountBorrow] = useState("5");
  const [amountRepay, setAmountRepay] = useState("5");
  const [amountWithdraw, setAmountWithdraw] = useState("10");

  // ----- Position creation wizard state -----
  const [wizardOpen, setWizardOpen] = useState(false);
  const [wStep, setWStep] = useState(1);
  const [wSkipBorrow, setWSkipBorrow] = useState(false);
  const wDebt = debtChoices.find((a) => a.symbol === debtSymbol) ?? debtChoices[0];
  const wDepositAmt = parseAmount(amountDeposit, collateral.decimals);
  const wBorrowAmt = parseAmount(amountBorrow, wDebt.decimals);

  const oc = v.onChain;
  const busy = v.tx.status !== "idle" && v.tx.status !== "confirmed" && v.tx.status !== "failed";
  const disabled = busy || !v.snarkReady || !v.isConnected || !v.onHorizen;

  // The selected position's ACTUAL asset pair (from on-chain state), not the
  // dropdowns — the pair was chosen once at creation and cannot change.
  const posCollateral = oc ? assetByAddress(v.ASSETS, oc.collateralAsset) : null;
  const posDebt = oc ? assetByAddress(v.ASSETS, oc.debtAsset) : null;

  async function act(kind: ActionKind, amountStr?: string, decimals?: number) {
    const amount = amountStr ? parseAmount(amountStr, decimals ?? 18) : null;
    const pair = { collateral: collateral.address, debt: debt.address };
    try { await v.runAction(kind, amount, pair); } catch { /* surfaced via tx state */ }
  }
  function maxFor(symbol: string, decimals: number, setter: (s: string) => void) {
    const bal = v.assetBalances[symbol];
    if (bal !== undefined) setter(fmtAssetBalance(bal, decimals));
  }

  /** Runs the full wizard execution on the Review step: create → deposit →
   *  borrow (optional). Each action is the unchanged, proof-bound pipeline. */
  async function runWizard() {
    await act("create");
    await act("deposit", amountDeposit, collateral.decimals);
    if (!wSkipBorrow && wBorrowAmt > 0n) {
      await act("borrow", amountBorrow, wDebt.decimals);
    }
    setWStep(5);
  }

  // ——— Manual recovery (reuses lib/recovery unchanged) ———
  const signer = async (msg: string) => signMessageAsync({ message: msg });

  /** Encrypted backup of the SELECTED position — one file per position. */
  async function downloadRecoveryFile() {
    if (!v.address || !v.selectedState || !v.selectedId || recoveryBusy) return;
    setRecoveryBusy(true);
    setRecoveryMsg(null);
    try {
      const { blob } = await createRecoveryBlob({
        state: v.selectedState,
        address: v.address,
        chainId: horizenTestnet.id,
        positionId: v.selectedId,
        signMessage: signer,
      });
      const name = recoveryFileName(v.selectedId);
      await new FileBackupStore().save(name, JSON.stringify(blob, null, 2));
      setRecoveryMsg({
        ok: true,
        text: `✓ ${name} downloaded — an encrypted backup of Position #${v.selectedId}'s private state. Keep it safe: restoring requires this file and the same wallet.`,
      });
    } catch (e) {
      setRecoveryMsg({ ok: false, text: `✗ Backup failed: ${(e as Error).message}` });
    } finally {
      setRecoveryBusy(false);
    }
  }

  /** Restore flow: file → signature → decrypt → on-chain commitment check → restore. */
  async function restoreRecoveryFile(file: File) {
    if (!v.address || !publicClient || recoveryBusy) return;
    if (v.positions.length > 0 && !window.confirm(
      "Restore will ADD this position to this browser's saved positions (existing ones are kept). Continue?"
    )) {
      return;
    }
    setRecoveryBusy(true);
    setRecoveryMsg(null);
    try {
      const blob = await parseRecoveryFile(file);
      const res = await verifyAndRestore({ blob, address: v.address, chainId: horizenTestnet.id, publicClient, signMessage: signer });
      if (res.pass && res.recovered) {
        savePosition(v.address, { positionId: blob.positionId, state: serializeState(res.recovered), createdAt: new Date().toISOString() });
        v.refreshPositions();
        v.setSelectedId(blob.positionId);
        setRecoveryMsg({
          ok: true,
          text: `✓ Position #${blob.positionId} restored — the recovered witness material matches the on-chain commitment. You can use the position normally.`,
        });
      } else {
        setRecoveryMsg({ ok: false, text: `✗ Recovery failed: ${res.detail ?? "commitment mismatch"} — nothing was restored.` });
      }
    } catch (e) {
      setRecoveryMsg({ ok: false, text: `✗ Recovery failed: ${(e as Error).message} — nothing was restored.` });
    } finally {
      setRecoveryBusy(false);
    }
  }

  function openWizard() {
    setWStep(1);
    setWSkipBorrow(false);
    setWizardOpen(true);
  }

  if (!mounted) {
    return (
      <div className="container">
        <Header v={v} />
        <section className="hero">
          <h1>Private lending, without public positions.</h1>
          <p>Your financial state stays private.<br />The protocol still proves what matters.</p>
        </section>
      </div>
    );
  }

  return (
    <div className="container">
      <Header v={v} />
      <TxStatus tx={v.tx} />

      {!v.isConnected ? (
        <>
          <section className="hero">
            <h1>Private lending, without public positions.</h1>
            <p>
              Deposit collateral, borrow, and repay — without anyone seeing your balances, debt, or
              health factor. Amounts stay hidden behind zero-knowledge proofs; the chain only verifies
              that every action keeps your position solvent.
            </p>
            <div className="spacer" />
            <button className="action-btn primary" style={{ padding: "12px 28px" }} onClick={() => v.connect()}>
              Connect Wallet
            </button>
            <p className="hint" style={{ marginTop: 14 }}>
              Connect an injected wallet (MetaMask / compatible) to Horizen Testnet (chain ID 2651420).
            </p>
          </section>
          <HowItWorks />
        </>
      ) : !v.onHorizen ? (
        <section className="panel">
          <div className="panel-title">Wrong network</div>
          <p style={{ color: "var(--text-secondary)", marginBottom: 16 }}>
            VeilLend runs on Horizen Testnet (chain ID 2651420). Your wallet is connected to a different network.
          </p>
          <button className="action-btn primary" style={{ padding: "10px 20px" }} onClick={() => v.switchChain()}>
            Switch to Horizen Testnet
          </button>
        </section>
      ) : (
        <>
          {/* ————————————————— 1 · YOUR POSITIONS ————————————————— */}
          <section className="section">
            <div className="section-head">
              <h2 className="section-title">Your Positions</h2>
              {v.positions.length > 0 && (
                <button className="action-btn" onClick={openWizard}>+ New Position</button>
              )}
            </div>

            {v.positions.length > 0 && (
              <div className="pos-row" style={{ marginBottom: 14 }}>
                <select
                  className="select"
                  value={v.selectedId ?? ""}
                  onChange={(e) => v.setSelectedId(e.target.value)}
                  aria-label="Select position"
                  style={{ flex: 1 }}
                >
                  {v.positions.map((p) => (
                    <option key={p.positionId} value={p.positionId}>Position #{p.positionId}</option>
                  ))}
                </select>
                <button
                  className="action-btn"
                  disabled={recoveryBusy || !v.selectedState}
                  onClick={() => void downloadRecoveryFile()}
                  title="Download an encrypted Recovery File for the selected position"
                >
                  {recoveryBusy ? "Working…" : "Backup Recovery File"}
                </button>
              </div>
            )}

            {v.positions.length === 0 ? (
              /* ——— empty state: create or restore ——— */
              <div className="empty-state">
                <p className="plain" style={{ marginBottom: 14 }}>
                  You have no positions in this browser yet. Create one below — or restore an existing
                  Position from its Recovery File.
                </p>
                <div className="btn-row" style={{ justifyContent: "center" }}>
                  <button className="action-btn primary" onClick={openWizard}>Create a Position</button>
                  <label className="action-btn" style={{ cursor: "pointer" }}>
                    Restore Existing Position
                    <input
                      type="file"
                      accept="application/json,.json"
                      aria-label="Restore from recovery file"
                      disabled={recoveryBusy}
                      style={{ display: "none" }}
                      onChange={(e) => { const f = e.target.files?.[0]; if (f) void restoreRecoveryFile(f); e.target.value = ""; }}
                    />
                  </label>
                </div>
                <RecoveryNote compact />
              </div>
            ) : (
              /* ——— active position card ——— */
              v.selectedId && oc && posCollateral && posDebt && (
                <div className="panel" style={{ marginTop: 0 }}>
                  <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 14, flexWrap: "wrap" }}>
                    <span className="status-dot" style={oc.status !== 1 ? { background: "var(--text-dim)" } : undefined} />
                    <strong>Position #{v.selectedId}</strong>
                    <span className="mono">{oc.status === 1 ? "ACTIVE" : oc.status === 2 ? "CLOSED" : "—"}</span>
                    <span className="hint">{posCollateral.symbol} collateral · {posDebt.symbol} debt</span>
                  </div>

                  <div className="pos-row">
                    <div className="metric"><div className="label">Collateral</div><div className="value"><span className="private-tag">🔒 Only you see this</span></div></div>
                    <div className="metric"><div className="label">Debt</div><div className="value"><span className="private-tag">🔒 Only you see this</span></div></div>
                    <div className="metric"><div className="label">Health</div><div className="value"><span className="private-tag">🔒 Only you see this</span></div></div>
                    <div className="metric"><div className="label">Borrows drawn (public)</div><div className="value">{fmtAssetBalance(oc.outstanding, posDebt.decimals)} {posDebt.symbol}</div></div>
                  </div>

                  {/* Manage: deposit / withdraw collateral */}
                  <div className="amount-row" style={{ marginTop: 16 }}>
                    <label style={{ flex: 2 }}><div className="hint">{`Amount (${posCollateral.symbol})`}</div>
                      <input type="text" value={amountDeposit} onChange={(e) => { setAmountDeposit(e.target.value); setAmountWithdraw(e.target.value); }} aria-label={`Deposit or withdraw amount in ${posCollateral.symbol}`} />
                    </label>
                    <label style={{ flex: 1 }}>
                      <div className="hint">
                        Wallet: {v.assetBalances[posCollateral.symbol] !== undefined
                          ? `${fmtAssetBalance(v.assetBalances[posCollateral.symbol], posCollateral.decimals)} ${posCollateral.symbol}` : "…"}
                        {" "}
                        <button className="max-btn" onClick={() => maxFor(posCollateral.symbol, posCollateral.decimals, setAmountWithdraw)}>max</button>
                      </div>
                    </label>
                  </div>
                  <div className="actions">
                    <button className="action-btn primary" disabled={disabled} onClick={() => act("deposit", amountDeposit, posCollateral.decimals)}>Deposit Collateral</button>
                    <button className="action-btn" disabled={disabled} onClick={() => act("withdraw", amountWithdraw, posCollateral.decimals)}>Withdraw Collateral</button>
                  </div>

                  {/* Manage: borrow / repay debt */}
                  <div className="amount-row" style={{ marginTop: 14 }}>
                    <label style={{ flex: 2 }}><div className="hint">{`Amount (${posDebt.symbol})`}</div>
                      <input type="text" value={amountBorrow} onChange={(e) => { setAmountBorrow(e.target.value); setAmountRepay(e.target.value); }} aria-label={`Borrow or repay amount in ${posDebt.symbol}`} />
                    </label>
                    <label style={{ flex: 1 }}>
                      <div className="hint">
                        Wallet: {v.assetBalances[posDebt.symbol] !== undefined
                          ? `${fmtAssetBalance(v.assetBalances[posDebt.symbol], posDebt.decimals)} ${posDebt.symbol}` : "…"}
                        {" "}
                        <button className="max-btn" onClick={() => maxFor(posDebt.symbol, posDebt.decimals, setAmountRepay)}>max</button>
                      </div>
                    </label>
                  </div>
                  <div className="actions">
                    <button className="action-btn primary" disabled={disabled} onClick={() => act("borrow", amountBorrow, posDebt.decimals)}>Borrow</button>
                    <button className="action-btn" disabled={disabled} onClick={() => act("repay", amountRepay, posDebt.decimals)}>Repay</button>
                  </div>
                  <div className="hint">
                    Borrow: up to 75% of your collateral&apos;s value at current prices, funded by the
                    {posDebt.symbol} liquidity pool. Repay: {posDebt.symbol} balance + approval (auto-requested).
                  </div>

                  {/* Liquidation status */}
                  {oc.status === 1 && (
                    v.isEligible ? (
                      <div style={{ marginTop: 14 }}>
                        <p className="warn-text" style={{ fontSize: 13, marginBottom: 8 }}>
                          This position is undercollateralized at current oracle prices — eligible for liquidation.
                        </p>
                        <button className="action-btn" disabled={busy} onClick={() => act("liquidate")}>Liquidate (self)</button>
                      </div>
                    ) : (
                      <p className="hint" style={{ marginTop: 14 }}>
                        Liquidation: position is healthy — nothing to do.
                      </p>
                    )
                  )}

                  {/* Recovery (concise) */}
                  <div className="protect-card">
                    <div className="protect-title">Protect your Position</div>
                    <p className="hint" style={{ margin: "4px 0 10px" }}>
                      This Position&apos;s private state exists only in this browser. Its encrypted
                      Recovery File (<span className="mono">VeilLend-Position-{v.selectedId}-Recovery.json</span>) is
                      required to restore it on another browser or device.
                    </p>
                    {recoveryMsg && (
                      <p className={recoveryMsg.ok ? "ok" : "err"} style={{ fontSize: 13, margin: "0 0 10px" }}>{recoveryMsg.text}</p>
                    )}
                    <button
                      className="action-btn"
                      disabled={recoveryBusy || !v.selectedState}
                      onClick={() => void downloadRecoveryFile()}
                    >
                      {recoveryBusy ? "Working…" : "Download Recovery File"}
                    </button>
                    <span className="hint" style={{ marginLeft: 10 }}>
                      Restorable only with the same wallet. Hardware wallets typically sign non-deterministically and cannot restore.
                    </span>
                  </div>
                </div>
              )
            )}

            {/* Restore is always available next to existing positions too */}
            {v.positions.length > 0 && (
              <div style={{ marginTop: 10, display: "flex", alignItems: "center", gap: 10, flexWrap: "wrap" }}>
                <label className="action-btn" style={{ cursor: "pointer", padding: "6px 12px", fontSize: 13 }}>
                  Restore Existing Position
                  <input
                    type="file"
                    accept="application/json,.json"
                    aria-label="Restore from recovery file"
                    disabled={recoveryBusy}
                    style={{ display: "none" }}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void restoreRecoveryFile(f); e.target.value = ""; }}
                  />
                </label>
                {recoveryMsg && <span className={recoveryMsg.ok ? "ok" : "err"} style={{ fontSize: 13 }}>{recoveryMsg.text}</span>}
              </div>
            )}

            {/* ——— Position creation wizard ——— */}
            {wizardOpen && (
              <div className="wizard">
                <div className="wizard-steps" aria-label="Position creation progress">
                  {WIZARD_STEPS.map((s, i) => (
                    <span key={s} className={"wstep" + (i + 1 === wStep ? " active" : i + 1 < wStep ? " done" : "")}>
                      {i + 1}. {s}
                    </span>
                  ))}
                </div>

                {wStep === 1 && (
                  <>
                    <div className="panel-title">Choose your assets</div>
                    <p className="hint" style={{ marginBottom: 12 }}>
                      The pair is fixed for the life of the Position. Amounts stay private — the chain
                      only sees commitments and proofs.
                    </p>
                    <div className="amount-row">
                      <label style={{ flex: 1 }}><div className="hint">Collateral</div>
                        <select className="select" value={collateral.symbol} aria-label="Collateral asset" disabled>
                          {collateralChoices.map((a) => <option key={a.symbol} value={a.symbol}>{a.symbol}</option>)}
                        </select>
                      </label>
                      <label style={{ flex: 1 }}><div className="hint">Borrow asset</div>
                        <select className="select" value={debtSymbol} onChange={(e) => setDebtSymbol(e.target.value)} aria-label="Debt asset">
                          {debtChoices.map((a) => <option key={a.symbol} value={a.symbol}>{a.symbol}</option>)}
                          <option disabled>ZEN — locked (no price feed)</option>
                        </select>
                      </label>
                    </div>
                    <div className="btn-row">
                      <button className="action-btn" onClick={() => setWizardOpen(false)}>Cancel</button>
                      <button className="action-btn primary" onClick={() => setWStep(2)}>Next: Collateral</button>
                    </div>
                  </>
                )}

                {wStep === 2 && (
                  <>
                    <div className="panel-title">Deposit collateral ({collateral.symbol})</div>
                    <div className="amount-row">
                      <label style={{ flex: 2 }}><div className="hint">Amount</div>
                        <input type="text" value={amountDeposit} onChange={(e) => setAmountDeposit(e.target.value)} aria-label="Collateral deposit amount" />
                      </label>
                      <label style={{ flex: 1 }}>
                        <div className="hint">
                          Wallet: {v.assetBalances[collateral.symbol] !== undefined
                            ? `${fmtAssetBalance(v.assetBalances[collateral.symbol], collateral.decimals)} ${collateral.symbol}` : "…"}
                          {" "}
                          <button className="max-btn" onClick={() => maxFor(collateral.symbol, collateral.decimals, setAmountDeposit)}>max</button>
                        </div>
                      </label>
                    </div>
                    <p className="hint">
                      Needs {collateral.symbol} balance + approval (auto-requested). Need testnet tokens?
                      Mint them in Advanced / Testnet Tools below.
                    </p>
                    <div className="btn-row">
                      <button className="action-btn" onClick={() => setWStep(1)}>Back</button>
                      <button className="action-btn primary" disabled={wDepositAmt === 0n} onClick={() => setWStep(3)}>Next: Borrow</button>
                    </div>
                  </>
                )}

                {wStep === 3 && (
                  <>
                    <div className="panel-title">Borrow ({wDebt.symbol}) — optional</div>
                    <div className="amount-row">
                      <label style={{ flex: 2 }}><div className="hint">Amount</div>
                        <input type="text" value={amountBorrow} onChange={(e) => setAmountBorrow(e.target.value)} aria-label="Borrow amount" />
                      </label>
                      <label style={{ flex: 1 }}><div className="hint">Up to 75% LTV</div></label>
                    </div>
                    <p className="hint">
                      You can also borrow later from the Position card. Borrowing now needs fresh oracle
                      prices and available {wDebt.symbol} pool liquidity.
                    </p>
                    <div className="btn-row">
                      <button className="action-btn" onClick={() => setWStep(2)}>Back</button>
                      <button className="action-btn" onClick={() => { setWSkipBorrow(true); setWStep(4); }}>Skip</button>
                      <button className="action-btn primary" disabled={wBorrowAmt === 0n} onClick={() => { setWSkipBorrow(false); setWStep(4); }}>Next: Review</button>
                    </div>
                  </>
                )}

                {wStep === 4 && (
                  <>
                    <div className="panel-title">Review</div>
                    <div className="review-row"><span>Collateral asset</span><strong>{collateral.symbol}</strong></div>
                    <div className="review-row"><span>Collateral deposit</span><strong>{amountDeposit} {collateral.symbol}</strong></div>
                    <div className="review-row"><span>Debt asset</span><strong>{wDebt.symbol}</strong></div>
                    <div className="review-row"><span>Borrow now</span><strong>{wSkipBorrow || wBorrowAmt === 0n ? "— (borrow later)" : `${amountBorrow} ${wDebt.symbol}`}</strong></div>
                    <div className="review-row"><span>Privacy</span><strong>🔒 amounts hidden in ZK proofs</strong></div>
                    <p className="hint" style={{ marginTop: 10 }}>
                      This sends up to 3 transactions (create → deposit{wSkipBorrow ? "" : " → borrow"}), each confirmed in your wallet.
                    </p>
                    <div className="btn-row">
                      <button className="action-btn" disabled={busy} onClick={() => setWStep(3)}>Back</button>
                      <button className="action-btn primary" disabled={busy || disabled} onClick={() => void runWizard()}>
                        {busy ? "Working…" : "Confirm & Create Position"}
                      </button>
                    </div>
                  </>
                )}

                {wStep === 5 && (
                  <>
                    <div className="panel-title">✓ Position Created</div>
                    <p className="ok" style={{ fontSize: 14 }}>
                      Your Position is live and its private state is saved in this browser.
                    </p>
                    <div className="btn-row">
                      <button className="action-btn primary" onClick={() => setWizardOpen(false)}>Open my Position</button>
                      <button
                        className="action-btn"
                        disabled={recoveryBusy || !v.selectedState}
                        onClick={() => void downloadRecoveryFile()}
                      >
                        Download Recovery File now
                      </button>
                    </div>
                  </>
                )}
              </div>
            )}
          </section>

          {/* ————————————————— 2 · LIQUIDITY POOLS ————————————————— */}
          <section className="section">
            <div className="section-head">
              <h2 className="section-title">Liquidity Pools</h2>
            </div>
            <PoolPanel pools={pools} />
          </section>

          {/* ————————————————— 3 · HOW VEILLEND WORKS ————————————————— */}
          <section className="section">
            <div className="section-head">
              <h2 className="section-title">How VeilLend Works</h2>
            </div>
            <HowItWorks />
          </section>

          {/* ————————————————— ADVANCED / TESTNET TOOLS ————————————————— */}
          <details className="devtools-wrap">
            <summary>Advanced / Testnet Tools</summary>
            <SetupPanel v={v} />
            <PricePanel v={v} />
            <section className="panel devtools">
              <div className="panel-title">Testnet tools (test-only)</div>
              <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 12 }}>
                Pre-fund the borrow reserve with demo tokens — a convenience for testing that real users
                would never need.
              </p>
              <div className="actions" style={{ gridTemplateColumns: "1fr" }}>
                <button className="action-btn" disabled={busy || !v.isConnected} onClick={() => v.seedLiquidity(20n * 10n ** 18n)}>Seed 20 vDBT liquidity</button>
              </div>
              <div className="footnote">
                Seeding mints vDBT and repays it into the protocol reserve — on this Testnet, borrows are
                funded by repayments until the LiquidityPools are wired in (setDebtPool), after which
                borrows are funded by the asset&apos;s pool.
              </div>
            </section>
            <ProofStatus tx={v.tx} commitment={oc?.activeCommitment} sequence={oc?.sequence} snarkReady={v.snarkReady} />
            <AssetsPanel v={v} />
          </details>

          <footer style={{ marginTop: 40, paddingBottom: 20 }}>
            <p className="footnote">
              VeilLend — testnet only · unaudited · vCOL/vDBT are mocks.
              Protocol and audit documentation: see the repository README.
            </p>
          </footer>
        </>
      )}
    </div>
  );
}

function Header({ v }: { v: ReturnType<typeof useVeilLend> }) {
  // wagmi's standard disconnect action (the same wallet-state layer that
  // manages the connection). Clearing the position selection returns the UI
  // cleanly to the disconnected hero state.
  const { disconnect } = useDisconnect();
  const onDisconnect = () => {
    v.setSelectedId(null);
    disconnect();
  };
  return (
    <header className="header">
      <div className="brand">
        <span className="brand-name">VeilLend</span>
        <span className="brand-tag">Private Borrowing</span>
      </div>
      <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
        <span className={"net-badge" + (v.isConnected && !v.onHorizen ? " bad" : "")}>Horizen Testnet · 2651420</span>
        {!v.isConnected ? (
          <button className="action-btn primary" style={{ padding: "8px 16px" }} onClick={() => v.connect()}>
            Connect Wallet
          </button>
        ) : (
          <>
            <a className="net-badge mono" href={explorerAddress(v.address!)} target="_blank" rel="noreferrer">{short(v.address!)}</a>
            <button className="action-btn disconnect-btn" style={{ padding: "8px 14px" }} onClick={onDisconnect} aria-label="Disconnect wallet">
              Disconnect
            </button>
          </>
        )}
      </div>
    </header>
  );
}

/** Short, product-style explainer grid. */
function HowItWorks() {
  return (
    <section className="panel">
      <div className="panel-title">How VeilLend Works</div>
      <div className="safety">
        <div className="item"><div className="k">1 · Collateral</div><div className="v">Deposit vCOL into a private Position — the amount is never published.</div></div>
        <div className="item"><div className="k">2 · Borrow privately</div><div className="v">Borrow vDBT or USDC; a zero-knowledge proof proves solvency without revealing balances.</div></div>
        <div className="item"><div className="k">3 · Repay anytime</div><div className="v">Repay principal + interest; withdraw your collateral once the Position is healthy.</div></div>
        <div className="item"><div className="k">Under the hood</div><div className="v">Groth16 proofs · Poseidon commitments · one-time nullifiers · oracle-checked prices.</div></div>
      </div>
    </section>
  );
}

/** Concise recovery protection note (empty state / compact contexts). */
function RecoveryNote({ compact }: { compact?: boolean }) {
  return (
    <div className="protect-card" style={compact ? { marginTop: 14, textAlign: "left" } : { marginTop: 14 }}>
      <div className="protect-title">Protect your Position</div>
      <p className="hint" style={{ margin: "4px 0 0" }}>
        Each Position has its own encrypted Recovery File. Keep it safe — it is required to restore
        your private Position on another browser or device.
      </p>
    </div>
  );
}

/** STEP 1 — Testnet assets: balances, minting, approvals (Advanced tools). */
function SetupPanel({ v }: { v: ReturnType<typeof useVeilLend> }) {
  const [mintAmounts, setMintAmounts] = useState<Record<string, string>>({});
  const setupAssets = v.ASSETS.filter((a) => a.status !== "locked" && a.address !== "");
  const defaults: Record<string, string> = { vCOL: "100", vDBT: "100", USDC: "10000" };
  const busy = v.tx.status !== "idle" && v.tx.status !== "confirmed" && v.tx.status !== "failed";

  function mint(symbol: string, decimals: number) {
    const raw = (mintAmounts[symbol] ?? defaults[symbol] ?? "0").trim();
    const amt = parseAmount(raw, decimals);
    if (amt === 0n) return;
    v.mintAsset(symbol, amt).catch(() => { /* surfaced via tx state */ });
  }
  function approve(symbol: string) {
    const a = v.ASSETS.find((x) => x.symbol === symbol);
    if (!a || a.address === "") return;
    v.ensureAllowance(a.address, 2n ** 256n - 1n).catch(() => { /* surfaced via tx state */ });
  }

  return (
    <section className="panel">
      <div className="panel-title">Testnet assets — mint & approvals</div>
      <p className="plain" style={{ marginBottom: 12 }}>
        Demo tokens for testing. Each Position action pulls a specific token; approvals are also
        requested automatically when needed.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--muted, #888)" }}>
            <th style={{ padding: "4px 8px" }}>Asset</th>
            <th style={{ padding: "4px 8px" }}>Wallet balance</th>
            <th style={{ padding: "4px 8px" }}>Mint</th>
            <th style={{ padding: "4px 8px" }}>Approval for VeilLend</th>
            <th style={{ padding: "4px 8px" }}>Approve</th>
          </tr>
        </thead>
        <tbody>
          {setupAssets.map((a) => {
            const bal = v.assetBalances[a.symbol];
            const al = v.allowances[a.symbol];
            const approved = al !== undefined && al > 0n;
            return (
              <tr key={a.symbol} style={{ borderTop: "1px solid rgba(128,128,128,0.25)" }}>
                <td style={{ padding: "6px 8px" }}><strong>{a.symbol}</strong> <span className="hint">({a.decimals} decimals)</span></td>
                <td style={{ padding: "6px 8px" }}>{bal !== undefined ? fmtAssetBalance(bal, a.decimals) : "…"}</td>
                <td style={{ padding: "6px 8px" }}>
                  <div style={{ display: "flex", gap: 6, alignItems: "center" }}>
                    <input
                      type="text"
                      style={{ width: 110, padding: "6px 8px" }}
                      value={mintAmounts[a.symbol] ?? defaults[a.symbol] ?? ""}
                      onChange={(e) => setMintAmounts((m) => ({ ...m, [a.symbol]: e.target.value }))}
                      aria-label={`Amount of ${a.symbol} to mint`}
                    />
                    <button className="action-btn" style={{ padding: "6px 10px" }} disabled={busy || !v.isConnected}
                      onClick={() => mint(a.symbol, a.decimals)}>
                      Mint
                    </button>
                  </div>
                </td>
                <td style={{ padding: "6px 8px" }} className="mono">
                  {al !== undefined ? (approved ? <span style={{ color: "var(--accent)" }}>✓ approved</span> : al.toString()) : "…"}
                </td>
                <td style={{ padding: "6px 8px" }}>
                  <button className="action-btn" style={{ padding: "6px 10px" }}
                    disabled={busy || !v.isConnected || approved}
                    onClick={() => approve(a.symbol)}
                    title={approved ? "Already approved" : "Approve VeilLend to move this token"}>
                    {approved ? "Approved" : "Approve"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="footnote">
        ZEN is locked — no price feed.
      </div>
    </section>
  );
}

/** TESTNET/DEMO ONLY — Base Chainlink → relay → OwnerMockPriceOracle. */
function PricePanel({ v }: { v: ReturnType<typeof useVeilLend> }) {
  const fmt = (p1e8: string) => "$" + (Number(p1e8) / 1e8).toFixed(6);
  const ago = (u?: number) => (u ? `${Math.max(0, Math.round((Date.now() / 1000 - u) / 60))} min ago` : "—");
  return (
    <section className="panel">
      <div className="panel-title">Testnet / Demo Price Source — Base Chainlink → Mock Oracle</div>
      <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 12 }}>
        Real market prices from Base mainnet Chainlink are relayed into the testnet demo oracle by an
        isolated server-side service. This is a temporary demo mechanism — the production oracle is
        Stork (activated once Stork testnet publishing starts). You cannot set prices manually.
      </p>
      <div className="two-col">
        {["USDC"].map((sym) => {
          const info = v.relayedPrices.find((r) => r.symbol === sym);
          return (
            <div className="metric" key={sym}>
              <div className="label">{`${sym} / USD (Base Chainlink)`}</div>
              <div className="value" style={{ fontFamily: "var(--mono)" }}>
                {info ? (info.price1e8 !== "0" ? fmt(info.price1e8) : "—") : "…"}
              </div>
              <div className="hint">Updated: {info ? ago(info.horizenUpdatedAt) : "—"}</div>
            </div>
          );
        })}
      </div>
      {v.relayUnreachable && (
        <p className="warn-text" style={{ fontSize: 13, marginBottom: 10 }}>
          Prices unavailable — the testnet price relay is currently offline. Borrowing and withdrawing
          need fresh prices and will fail until the relay is back online.
        </p>
      )}
      <button
        className="action-btn"
        disabled={(v.tx.status !== "idle" && v.tx.status !== "confirmed" && v.tx.status !== "failed") || !v.isConnected}
        onClick={() => void v.refreshOraclePrices()}
      >
        Refresh Prices
      </button>
      <div className="footnote">
        Risk actions (borrow/withdraw/liquidate) need fresh prices — if they revert with a staleness
        error, press Refresh Prices here and retry.
      </div>
    </section>
  );
}

/** Supported-assets reference (Advanced tools). */
function AssetsPanel({ v }: { v: ReturnType<typeof useVeilLend> }) {
  return (
    <section className="panel">
      <div className="panel-title">Supported assets</div>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--muted, #888)" }}>
            <th style={{ padding: "4px 8px" }}>Asset</th>
            <th style={{ padding: "4px 8px" }}>Role</th>
            <th style={{ padding: "4px 8px" }}>Decimals</th>
            <th style={{ padding: "4px 8px" }}>Status</th>
          </tr>
        </thead>
        <tbody>
          {v.ASSETS.map((a) => (
            <tr key={a.symbol} style={{ borderTop: "1px solid rgba(128,128,128,0.25)" }}>
              <td style={{ padding: "4px 8px" }}><strong>{a.symbol}</strong></td>
              <td style={{ padding: "4px 8px" }}>
                {a.symbol === "vCOL" ? "Collateral"
                  : a.symbol === "vDBT" || a.symbol === "USDC" ? "Debt"
                  : "—"}
              </td>
              <td style={{ padding: "4px 8px" }}>{a.decimals}</td>
              <td style={{ padding: "4px 8px" }}>
                {a.status === "active" ? <span style={{ color: "var(--accent)" }}>Active</span>
                  : <span style={{ color: "var(--text-dim)" }}>🔒 Locked / not in MVP</span>}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      <div className="footnote">
        MVP configuration: vCOL collateral · vDBT and USDC debt · ZEN locked (no price feed).
        USDC prices come from the temporary Testnet/Demo Base Chainlink relay; the production
        price path is Stork, awaiting testnet publishing.
      </div>
    </section>
  );
}

function ProofStatus({ tx, commitment, sequence, snarkReady }: { tx: TxState; commitment?: string; sequence?: bigint; snarkReady: boolean }) {
  return (
    <section className="panel">
      <div className="panel-title">Zero-knowledge proof (technical)</div>
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
      {tx.status !== "failed" && (
        <div className="step-indicator">
          {steps.map((s, i) => (
            <span key={s} className={"step" + (i < idx ? " done" : i === idx ? " active" : "")}>{s}</span>
          ))}
        </div>
      )}
      {tx.status === "failed" && (
        <p className="err" style={{ fontSize: 14, margin: "8px 0" }}>
          ✗ The transaction did not go through — nothing was created or changed on-chain.
        </p>
      )}
      {tx.status === "failed" && tx.error && <p className="err" style={{ fontSize: 13 }}>{tx.error}</p>}
      {tx.status === "confirmed" && (
        <p className="ok" style={{ fontSize: 14, margin: "8px 0" }}>✓ Confirmed on-chain.</p>
      )}
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
