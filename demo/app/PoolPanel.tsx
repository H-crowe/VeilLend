"use client";

/**
 * Lender panel — independent per-asset LiquidityPools (ERC4626).
 *
 * Public liquidity with public shares: depositing mints shares that
 * appreciate as borrowers repay interest. Withdrawals are honored up to the
 * pool's free liquidity; claims backed by outstanding loans unlock
 * automatically as borrowers repay. No ZK proofs are involved on this side.
 */

import { useState } from "react";
import { usePools, friendlyPoolError } from "@/hooks/usePools";
import { formatUtilization, formatRateBps, effectiveLenderAprBps } from "@/lib/pool/math";

export default function PoolPanel({ pools }: { pools: ReturnType<typeof usePools> }) {
  const symbols = Object.keys(pools.states);
  const [selected, setSelected] = useState(symbols[0]);
  const [amount, setAmount] = useState("100");
  const st = pools.states[selected];
  const busy = pools.tx.status !== "idle" && pools.tx.status !== "confirmed" && pools.tx.status !== "failed";
  if (!st) return null;
  const aprBps = effectiveLenderAprBps(st.rateBps, st.utilization);
  const decimals = st.decimals;
  const parsed = (() => {
    const t = amount.trim();
    if (!t || isNaN(Number(t))) return 0n;
    return BigInt(Math.floor(Number(t) * 1e6)) * (10n ** BigInt(Math.max(0, decimals - 6)));
  })();
  const fmt = (wei: bigint) => (Number(wei) / 10 ** decimals).toFixed(2);
  const shareDecimals = decimals + 3; // pool _decimalsOffset() = 3

  return (
    <section className="panel">
      <div className="panel-title">Lend to a Liquidity Pool (public liquidity — earns interest, no proofs)</div>
      <p className="plain" style={{ marginBottom: 12 }}>
        Borrowers are funded by these pools. Depositing mints 4626-style shares that appreciate as
        borrowers repay interest. Withdrawals are honored up to the pool&apos;s free liquidity; claims
        backed by outstanding loans unlock automatically as borrowers repay.
      </p>

      <div style={{ display: "flex", gap: 10, marginBottom: 12, flexWrap: "wrap" }}>
        {symbols.map((sym) => (
          <button
            key={sym}
            className={"action-btn" + (sym === selected ? " primary" : "")}
            onClick={() => setSelected(sym)}
            aria-label={`Select ${sym} pool`}
          >
            {sym} Pool{pools.states[sym]?.poolAddress ? "" : " (not configured)"}
          </button>
        ))}
      </div>

      {!st.poolAddress ? (
        <p className="hint">
          The {selected} pool is not configured in this deployment yet. Deploy it with
          <span className="mono"> scripts/deploy-liquidity-pools.ts</span>, wire it into VeilLend with
          <span className="mono"> setDebtPool</span>, then paste its proxy address into
          <span className="mono"> POOLS</span> in <span className="mono">demo/lib/contracts/addresses.ts</span>.
        </p>
      ) : (
        <>
          <div className="pos-row">
            <div className="metric"><div className="label">Pool liquidity (lendable)</div><div className="value">{fmt(st.availableLiquidity)} {selected}</div></div>
            <div className="metric"><div className="label">Utilization</div><div className="value">{formatUtilization(st.utilization)}</div></div>
            <div className="metric"><div className="label">Borrowed / total assets</div><div className="value">{fmt(st.totalBorrows)} / {fmt(st.totalAssets)}</div></div>
            <div className="metric"><div className="label">Rate (fixed, on loans)</div><div className="value">{formatRateBps(st.rateBps)}{Number(st.rateBps) > 0 ? ` → ${formatRateBps(aprBps)} effective` : ""}</div></div>
          </div>
          <div className="pos-row" style={{ marginBottom: 12 }}>
            <div className="metric"><div className="label">Your shares</div><div className="value">{(Number(st.shares) / 10 ** shareDecimals).toFixed(4)}</div></div>
            <div className="metric"><div className="label">Your value (underlying)</div><div className="value">{(Number(st.underlying) / 10 ** decimals).toFixed(4)} {selected}</div></div>
            <div className="metric"><div className="label">Withdrawable right now</div><div className="value">{fmt(st.maxWithdraw)} {selected}</div></div>
          </div>

          <div className="amount-row">
            <label style={{ flex: 2 }}>
              <div className="hint">{`Amount (${selected})`}</div>
              <input type="text" value={amount} onChange={(e) => setAmount(e.target.value)} aria-label={`Pool ${selected} amount`} />
            </label>
            <label style={{ flex: 1 }}>
              <div className="hint">
                Wallet: {fmt(st.walletBalance)} {selected}
                {" "}
                <button className="max-btn" onClick={() => setAmount(fmt(st.walletBalance))}>max</button>
              </div>
            </label>
          </div>
          <div className="actions">
            <button
              className="action-btn primary"
              disabled={busy || !pools.isConnected || !pools.onHorizen || parsed === 0n}
              onClick={() => {
                if (st.allowance < parsed) { pools.approvePool(selected).then(() => pools.deposit(selected, parsed)).catch(() => { /* surfaced in PoolTxStatus */ }); }
                else pools.deposit(selected, parsed).catch(() => { /* surfaced in PoolTxStatus */ });
              }}
            >
              {st.allowance < parsed ? `Approve & Deposit ${selected}` : `Deposit ${selected}`}
            </button>
            <button
              className="action-btn"
              disabled={busy || !pools.isConnected || !pools.onHorizen || st.maxRedeem === 0n}
              title={st.maxRedeem === 0n
                ? "No withdrawable liquidity right now — your claim unlocks as borrowers repay"
                : `Redeem up to ${(Number(st.maxRedeem) / 10 ** shareDecimals).toFixed(4)} shares`}
              onClick={() => pools.redeem(selected, st.maxRedeem).catch(() => { /* surfaced in PoolTxStatus */ })}
            >
              Withdraw max ({fmt(st.maxWithdraw)} {selected})
            </button>
          </div>
          {st.maxWithdraw < st.underlying && st.underlying > 0n && (
            <p className="warn-text" style={{ fontSize: 13, marginTop: 10 }}>
              Part of your claim is currently lent out to borrowers — you can withdraw up to the free
              liquidity shown above; the rest unlocks automatically as loans are repaid. This is normal
              pool behavior: deposits earn interest because they are lent out.
            </p>
          )}
          <PoolTxStatus tx={pools.tx} />
        </>
      )}
    </section>
  );
}

function PoolTxStatus({ tx }: { tx: ReturnType<typeof usePools>["tx"] }) {
  if (tx.status === "idle") return null;
  return (
    <p className={tx.status === "confirmed" ? "ok" : tx.status === "failed" ? "err" : "hint"} style={{ fontSize: 13, margin: "10px 0 0" }}>
      {tx.status === "wallet" && "⏳ Confirm in your wallet…"}
      {tx.status === "confirming" && "⏳ Confirming on-chain…"}
      {tx.status === "confirmed" && <>✓ {tx.label} — confirmed on-chain.{tx.txHash ? <> tx: <span className="mono">{tx.txHash.slice(0, 10)}…</span></> : null}</>}
      {tx.status === "failed" && <>✗ {tx.label} failed — {tx.error ?? friendlyPoolError("")}</>}
    </p>
  );
}
