"use client";

import { useEffect, useState } from "react";
import { useDisconnect, usePublicClient, useSignMessage } from "wagmi";
import { useVeilLend, type ActionKind, type TxState } from "@/hooks/useVeilLend";
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

/** The guided demo flow steps. */
const FLOW_STEPS = ["Connect", "Setup", "Create", "Deposit", "Borrow", "Repay", "Withdraw"] as const;

export default function Page() {
  // wagmi restores wallet state from localStorage during the first client
  // render, which cannot match the server prerender. Gate the dynamic UI
  // behind a mounted flag so the hydration render is identical on server
  // and client; dynamic content renders only after hydration completes.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const v = useVeilLend();
  const publicClient = usePublicClient();
  const { signMessageAsync } = useSignMessage();
  const [recoveryBusy, setRecoveryBusy] = useState(false);
  const [recoveryMsg, setRecoveryMsg] = useState<null | { ok: boolean; text: string }>(null);
  // Pair selection happens ONLY at position-creation time; the pair is then
  // fixed for the position's life. ZEN is locked and never listed.
  const collateralChoices = v.ASSETS.filter((a) => a.status !== "locked" && a.symbol !== "vDBT");
  const debtChoices = v.ASSETS.filter((a) => a.status !== "locked" && a.symbol !== "vCOL" && a.symbol !== "WETH");
  const [collateralSymbol, setCollateralSymbol] = useState("vCOL");
  const [debtSymbol, setDebtSymbol] = useState("vDBT");
  const collateral = collateralChoices.find((a) => a.symbol === collateralSymbol) ?? collateralChoices[0];
  const debt = debtChoices.find((a) => a.symbol === debtSymbol) ?? debtChoices[0];
  const [amountDeposit, setAmountDeposit] = useState("10");
  const [amountBorrow, setAmountBorrow] = useState("5");
  const [amountRepay, setAmountRepay] = useState("5");
  const [amountWithdraw, setAmountWithdraw] = useState("10");

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

  // Flow-step strip: completed steps are derived from real state.
  const flowProgress = ((): number => {
    if (!v.isConnected) return 0;
    if (v.positions.length === 0) return 2;
    if (!oc || oc.status !== 1) return 3;
    return 4;
  })();

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

      {!v.isConnected ? (
        <>
          <section className="hero">
            <h1>Private lending, without public positions.</h1>
            <p>
              Deposit collateral, borrow, and repay — without anyone seeing your balances, debt, or health
              factor. Amounts stay hidden behind zero-knowledge proofs; the chain only verifies that every
              action keeps your position solvent.
            </p>
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
          <FlowStrip step={flowProgress} />

          {/* STEP 1 — setup: balances, minting, approvals */}
          <SetupPanel v={v} />

          {/* STEP 2 — create a position (pair is chosen here, once) */}
          <section className="panel">
            <div className="panel-title">2 · Create a position</div>
            <p className="plain" style={{ marginBottom: 12 }}>
              A position holds <strong>one collateral asset</strong> and <strong>one debt asset</strong> —
              you choose the pair below and it stays fixed for the life of the position. Your collateral,
              debt, and health stay private: the chain sees only cryptographic commitments and zero-knowledge
              proofs, never the amounts.
            </p>
            {v.positions.length > 0 ? (
              <div style={{ display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
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
                <button
                  className="action-btn"
                  disabled={recoveryBusy || !v.selectedState}
                  onClick={() => void downloadRecoveryFile()}
                  title="Download an encrypted recovery file for the selected position"
                >
                  {recoveryBusy ? "Working…" : `Download Recovery File${v.selectedId ? ` (Position #${v.selectedId})` : ""}`}
                </button>
                <span className="hint">Only you can open your positions — the private state lives in this browser.</span>
              </div>
            ) : (
              <div style={{ marginBottom: 8 }}>
                <p className="hint">
                  No positions in this browser yet — create your first one below, or{" "}
                  <strong>restore an existing position</strong> from its recovery file.
                </p>
                <label style={{ display: "inline-block" }}>
                  <input
                    type="file"
                    accept="application/json,.json"
                    aria-label="Restore from recovery file"
                    disabled={recoveryBusy}
                    onChange={(e) => { const f = e.target.files?.[0]; if (f) void restoreRecoveryFile(f); e.target.value = ""; }}
                  />
                </label>
                <span className="hint" style={{ marginLeft: 8 }}>Restore from Recovery File</span>
              </div>
            )}

            {/* Manual recovery status — backup download / restore result */}
            {recoveryMsg && (
              <p className={recoveryMsg.ok ? "ok" : "err"} style={{ fontSize: 13, margin: "10px 0 0" }}>
                {recoveryMsg.text}
              </p>
            )}
            <div className="footnote" style={{ marginTop: 10 }}>
              <strong>Recovery files:</strong> each position has its own encrypted file
              (<span className="mono">VeilLend-Position-N-Recovery.json</span>), signed with your wallet and
              restorable only by the same wallet. Restore flow: select the file → wallet signature → decrypt →
              the recovered state is verified against the on-chain commitment before anything is restored.
              Note: restore relies on deterministic wallet signatures — software wallets (MetaMask and
              similar) work; hardware wallets typically sign non-deterministically and cannot restore.
            </div>
            <div className="amount-row">
              <label style={{ flex: 1 }}><div className="hint">Collateral you will deposit (needs balance + approval in Step 1)</div>
                <select className="select" value={collateral.symbol} onChange={(e) => setCollateralSymbol(e.target.value)} aria-label="Collateral asset">
                  {collateralChoices.map((a) => (
                    <option key={a.symbol} value={a.symbol} disabled={a.status !== "active"}>
                      {`${a.symbol}${a.status === "active" ? "" : " — not yet enabled"}`}
                    </option>
                  ))}
                </select>
              </label>
              <label style={{ flex: 1 }}><div className="hint">Asset you will borrow</div>
                <select className="select" value={debt.symbol} onChange={(e) => setDebtSymbol(e.target.value)} aria-label="Debt asset">
                  {debtChoices.map((a) => (
                    <option key={a.symbol} value={a.symbol} disabled={a.status !== "active"}>
                      {`${a.symbol}${a.status === "active" ? "" : " — not yet enabled"}`}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <button className="action-btn" disabled={busy} onClick={() => act("create")}>Create New Position</button>
            <div className="footnote">
              WETH and USDC are enabled on this Testnet deployment and priced by the temporary
              Testnet/Demo Base Chainlink relay. Their production price path is Stork (WETHUSD/USDCUSD),
              already configured — it activates when Stork testnet publishing starts.
            </div>
          </section>

          {/* STEP 3 — position lifecycle */}
          {v.selectedId && oc && posCollateral && posDebt && (
            <section className="panel">
              <div className="panel-title">3 · Position #{v.selectedId} — deposit, borrow, repay, withdraw</div>
              <div style={{ display: "flex", gap: 14, alignItems: "center", marginBottom: 14 }}>
                <span className="status-dot" style={oc.status !== 1 ? { background: "var(--text-dim)" } : undefined} />
                <span className="mono">{oc.status === 1 ? "ACTIVE" : oc.status === 2 ? "CLOSED" : "—"}</span>
                <span className="hint">
                  Pair: {posCollateral.symbol} as collateral · {posDebt.symbol} as debt
                </span>
              </div>
              <div className="pos-row">
                <div className="metric"><div className="label">Collateral</div><div className="value"><span className="private-tag">🔒 Only you see this</span></div></div>
                <div className="metric"><div className="label">Debt</div><div className="value"><span className="private-tag">🔒 Only you see this</span></div></div>
                <div className="metric"><div className="label">Health</div><div className="value"><span className="private-tag">🔒 Only you see this</span></div></div>
              </div>
              <p className="plain" style={{ fontSize: 13, marginBottom: 4 }}>
                Amounts are hidden — anyone can verify the position is solvent, but nobody (besides you, on
                this device) can see how much you deposited or owe.
              </p>

              {/* Deposit / Withdraw — collateral asset */}
              <div className="amount-row">
                <label style={{ flex: 2 }}><div className="hint">{`Amount (${posCollateral.symbol}) — used by both actions`}</div>
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
                <button className="action-btn primary" disabled={disabled} onClick={() => act("deposit", amountDeposit, posCollateral.decimals)}>Deposit {posCollateral.symbol}</button>
                <button className="action-btn" disabled={disabled} onClick={() => act("withdraw", amountWithdraw, posCollateral.decimals)}>Withdraw {posCollateral.symbol}</button>
              </div>
              <div className="hint">
                Deposit needs: {posCollateral.symbol} balance + approval (Step 1). Withdraw needs: hidden
                collateral to cover the amount. The approval is requested automatically if missing.
              </div>

              {/* Borrow / Repay — debt asset */}
              <div className="amount-row" style={{ marginTop: 16 }}>
                <label style={{ flex: 2 }}><div className="hint">{`Amount (${posDebt.symbol}) — used by both actions`}</div>
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
                <button className="action-btn primary" disabled={disabled} onClick={() => act("borrow", amountBorrow, posDebt.decimals)}>Borrow {posDebt.symbol}</button>
                <button className="action-btn" disabled={disabled} onClick={() => act("repay", amountRepay, posDebt.decimals)}>Repay {posDebt.symbol}</button>
              </div>
              <div className="hint">
                Borrow needs: fresh oracle prices + reserve liquidity (Seed liquidity in Testnet tools if
                empty) + 75% LTV. Repay needs: {posDebt.symbol} balance + approval (auto-requested) and
                existing debt.
              </div>

              <div className="two-col" style={{ marginTop: 14 }}>
                <div className="hint">{`Public on-chain: collateral value backing borrows — ${fmtAssetBalance(oc.supported, posCollateral.decimals)} ${posCollateral.symbol}`}</div>
                <div className="hint">{`Public on-chain: borrows drawn so far — ${fmtAssetBalance(oc.outstanding, posDebt.decimals)} ${posDebt.symbol}`}</div>
              </div>
              <div className="footnote" style={{ marginTop: 6 }}>
                Borrow rule: you can borrow up to 75% of your deposit&apos;s value at current market prices.
                Borrowing more is rejected — by the zero-knowledge proof itself and by the contract. Assets
                with different decimals (like WETH and USDC) are valued exactly in dollar terms.
              </div>
              <div className="footnote">
                Prices: risk actions use the current testnet oracle (see the Testnet/Demo price source
                below); if prices go stale, use Refresh Prices there first.
              </div>
            </section>
          )}

          {v.selectedId && <ProofStatus tx={v.tx} commitment={oc?.activeCommitment} sequence={oc?.sequence} snarkReady={v.snarkReady} />}

          {/* STEP 4 — self-liquidation */}
          {v.selectedId && oc && oc.status === 1 && (
            <section className="panel">
              <div className="panel-title">4 · Self-liquidation (private)</div>
              <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 12 }}>
                When a position becomes undercollateralized it can be liquidated. VeilLend proves the
                condition in zero knowledge — the hidden amounts are never revealed. In this demo the
                position owner can run that proof on their own position. Prerequisites: the position must
                actually be undercollateralized at current oracle prices.
              </p>
              {v.isEligible === null ? (
                <p className="hint">Load this position&apos;s private state in this browser to evaluate eligibility.</p>
              ) : v.isEligible ? (
                <>
                  <p className="warn-text" style={{ fontSize: 13, marginBottom: 10 }}>
                    This position is undercollateralized at current oracle prices — eligible for liquidation.
                  </p>
                  <button className="action-btn primary" disabled={busy} onClick={() => act("liquidate")}>Generate Proof &amp; Liquidate</button>
                </>
              ) : (
                <p className="hint">Not eligible — the position is healthy, so no liquidation proof can be generated.</p>
              )}
            </section>
          )}

          {/* FINAL VERIFICATION — public on-chain state of the selected position */}
          {v.selectedId && oc && posCollateral && posDebt && (
            <section className="panel">
              <div className="panel-title">Final position state (public on-chain data)</div>
              <div className="proof-box" style={{ marginTop: 0 }}>
                <div className="row"><span className="k">status</span><span>{oc.status === 1 ? "ACTIVE" : oc.status === 2 ? "CLOSED" : "—"}</span></div>
                <div className="row"><span className="k">sequence (transitions)</span><span>{oc.sequence.toString()}</span></div>
                <div className="row"><span className="k">active commitment</span><span>{short(oc.activeCommitment)}</span></div>
                <div className="row"><span className="k">collateral backing borrows</span><span>{`${fmtAssetBalance(oc.supported, posCollateral.decimals)} ${posCollateral.symbol}`}</span></div>
                <div className="row"><span className="k">borrows drawn</span><span>{`${fmtAssetBalance(oc.outstanding, posDebt.decimals)} ${posDebt.symbol}`}</span></div>
                <div className="row"><span className="k">hidden collateral / debt / health</span><span>🔒 private — never on-chain</span></div>
              </div>
              <div className="footnote">
                Private amounts live only in this browser. The chain stores commitments, sequences, and
                public accounting — verifiable by anyone, readable by no one.
              </div>
            </section>
          )}

          {/* reference — supported assets */}
          <section className="panel">
            <div className="panel-title">Supported assets</div>
            <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
              <thead>
                <tr style={{ textAlign: "left", color: "var(--muted, #888)" }}>
                  <th style={{ padding: "4px 8px" }}>Asset</th>
                  <th style={{ padding: "4px 8px" }}>Role</th>
                  <th style={{ padding: "4px 8px" }}>Decimals</th>
                  <th style={{ padding: "4px 8px" }}>Price source</th>
                  <th style={{ padding: "4px 8px" }}>Status</th>
                </tr>
              </thead>
              <tbody>
                {v.ASSETS.map((a) => (
                  <tr key={a.symbol} style={{ borderTop: "1px solid rgba(128,128,128,0.25)" }}>
                    <td style={{ padding: "4px 8px" }}>
                      <strong>{a.symbol}</strong>
                      {a.address ? <span style={{ color: "var(--muted, #888)" }}> · {a.address.slice(0, 8)}…</span> : null}
                    </td>
                    <td style={{ padding: "4px 8px" }}>{a.symbol === "vCOL" || a.symbol === "WETH" ? "Collateral" : a.symbol === "ZEN" ? "—" : "Debt"}</td>
                    <td style={{ padding: "4px 8px" }}>{a.decimals}</td>
                    <td style={{ padding: "4px 8px" }}>{a.storkFeedId ? "Stork (live prices)" : "Mock oracle"}</td>
                    <td style={{ padding: "4px 8px" }}>
                      {a.status === "active" ? <span style={{ color: "var(--accent)" }}>Usable now</span>
                        : a.status === "pending" ? <span style={{ color: "var(--warn)" }}>Awaiting Stork testnet publishing</span>
                        : <span style={{ color: "var(--text-dim)" }}>🔒 Locked — no price feed</span>}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
            <div className="footnote">
              All four lending assets are enabled and testable. WETH/USDC prices come from the temporary
              Testnet/Demo Base Chainlink relay; the production price path is Stork (WETHUSD/USDCUSD,
              configured, awaiting Stork testnet publishing). ZEN has no price feed and stays locked.
              USDT is not supported.
            </div>
          </section>

          {/* ——— testnet/demo price source ——— */}
          <PricePanel v={v} />

          {/* ——— developer / testnet-only tools: clearly separated ——— */}
          <hr className="divider" />
          <p className="devtools-label">Developer tools — Testnet only, not part of the user flow</p>
          <section className="panel devtools">
            <div className="panel-title">Testnet tools (test-only)</div>
            <p style={{ color: "var(--text-secondary)", fontSize: 13, marginBottom: 12 }}>
              Pre-fund the borrow reserve with demo tokens — a convenience for testing that real users
              would never need (minting and approvals now live in Step 1 above).
            </p>
            <div className="actions" style={{ gridTemplateColumns: "1fr" }}>
              <button className="action-btn" disabled={busy || !v.isConnected} onClick={() => v.seedLiquidity(20n * 10n ** 18n)}>Seed 20 vDBT liquidity</button>
            </div>
            <div className="footnote">
              Seeding mints vDBT and repays it into the protocol reserve — on this Testnet, borrows are
              funded by repayments. With the Stork-backed deployment this button becomes a Stork signed-price
              relay; in production no manual price push exists.
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
        <span className="brand-tag">Confidential lending</span>
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

/** Compact progress strip for the guided flow. */
function FlowStrip({ step }: { step: number }) {
  return (
    <div className="flow-strip" aria-label="Demo flow progress">
      {FLOW_STEPS.map((s, i) => (
        <span key={s} className={"flow-step" + (i < step ? " done" : i === step ? " active" : "")}>
          {i + 1}. {s}
        </span>
      ))}
    </div>
  );
}

/** STEP 1 — Testnet assets: balances, minting, approvals. */
function SetupPanel({ v }: { v: ReturnType<typeof useVeilLend> }) {
  const [mintAmounts, setMintAmounts] = useState<Record<string, string>>({});
  const setupAssets = v.ASSETS.filter((a) => a.status !== "locked" && a.address !== "");
  const defaults: Record<string, string> = { vCOL: "100", vDBT: "100", WETH: "0.05", USDC: "10000" };
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
      <div className="panel-title">1 · Testnet assets — balances, minting, approvals</div>
      <p className="plain" style={{ marginBottom: 12 }}>
        Setup for everything that follows: each action pulls a specific token. Mint what you need, then
        approve VeilLend to move it (one signature per asset). The exact required asset for each position
        action is shown in Step 3. vDBT also needs reserve liquidity for borrows — use
        &quot;Seed liquidity&quot; in the Testnet tools below.
      </p>
      <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
        <thead>
          <tr style={{ textAlign: "left", color: "var(--muted, #888)" }}>
            <th style={{ padding: "4px 8px" }}>Asset</th>
            <th style={{ padding: "4px 8px" }}>Wallet balance</th>
            <th style={{ padding: "4px 8px" }}>Mint / wrap</th>
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
                      {a.symbol === "WETH" ? "Wrap ETH" : "Mint"}
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
                    title={approved ? "Already approved" : "Approve VeilLend to move this token (required before deposit/repay)"}>
                    {approved ? "Approved" : "Approve"}
                  </button>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      <div className="footnote">
        Approvals are also requested automatically right before a Deposit/Repay if missing — the buttons
        above let you grant them proactively. WETH is wrapped from chain ETH (the mint amount is the ETH
        value). ZEN is locked and not shown (no ZEN/USD Stork feed).
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
        {["WETH", "USDC"].map((sym) => {
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
          Prices unavailable — the testnet price relay is currently offline. Live testnet prices are
          temporarily unavailable; borrowing and withdrawing need fresh prices and will fail until the
          relay is back online.
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

function SafetyPanel() {
  return (
    <section className="panel">
      <div className="panel-title">How the protocol protects you</div>
      <div className="safety">
        <div className="item"><div className="k">Privacy</div><div className="v">Amounts hidden in ZK proofs</div></div>
        <div className="item"><div className="k">Solvency</div><div className="v">Every action proven solvent</div></div>
        <div className="item"><div className="k">Prices</div><div className="v">Signed oracle snapshots, checked on-chain</div></div>
        <div className="item"><div className="k">Replay protection</div><div className="v">Each proof works exactly once</div></div>
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
