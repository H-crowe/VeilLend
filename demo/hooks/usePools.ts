"use client";

/**
 * Lender-side hook for the per-debt-asset LiquidityPools (UUPS / ERC4626).
 *
 * Independent of useVeilLend's ZK position flows: pools hold PUBLIC lender
 * liquidity, borrow funding is pulled by the VeilLend contract during ZK-gated
 * borrows. Pool addresses come from lib/contracts/addresses (POOLS) — an
 * asset with an empty address is "not deployed yet" and the UI disables it.
 */

import { useCallback, useEffect, useState } from "react";
import { useAccount, usePublicClient, useWalletClient } from "wagmi";
import { getAddress, type Address } from "viem";
import { ADDRESSES, POOLS } from "../lib/contracts/addresses";
import { poolAbi, tokenAbi } from "../lib/contracts/abis";
import { assertReceiptSuccess } from "../lib/tx/receipt";

export interface PoolState {
  symbol: string;
  poolAddress: string | null; // null = not deployed/wired yet
  asset: string;
  decimals: number;
  // pool stats
  totalAssets: bigint;
  totalBorrows: bigint;
  availableLiquidity: bigint;
  utilization: bigint;
  rateBps: bigint;
  feeBps: bigint;
  accruedFees: bigint;
  projectedInterest: bigint;
  // lender-specific
  shares: bigint;
  underlying: bigint; // convertToAssets(shares)
  maxWithdraw: bigint;
  maxRedeem: bigint;
  walletBalance: bigint;
  allowance: bigint;
}

export interface PoolTxState {
  status: "idle" | "wallet" | "confirming" | "confirmed" | "failed";
  label?: string;
  txHash?: string;
  explorerUrl?: string;
  error?: string;
}

const IDLE: Omit<PoolState, "symbol" | "poolAddress" | "asset" | "decimals"> = {
  totalAssets: 0n, totalBorrows: 0n, availableLiquidity: 0n, utilization: 0n,
  rateBps: 0n, feeBps: 0n, accruedFees: 0n, projectedInterest: 0n,
  shares: 0n, underlying: 0n, maxWithdraw: 0n, maxRedeem: 0n,
  walletBalance: 0n, allowance: 0n,
};

export function usePools() {
  const { address, chainId } = useAccount();
  const publicClient = usePublicClient();
  const { data: walletClient } = useWalletClient();
  const [states, setStates] = useState<Record<string, PoolState>>({});
  const [tx, setTx] = useState<PoolTxState>({ status: "idle" });
  const [refreshTick, setRefreshTick] = useState(0);

  const refresh = useCallback(() => setRefreshTick((t) => t + 1), []);

  // ---- reads ----
  useEffect(() => {
    let cancelled = false;
    async function load() {
      if (!publicClient) { if (!cancelled) setStates({}); return; }
      const entries = await Promise.all(Object.entries(POOLS).map(async ([symbol, poolAddress]) => {
        const assetEntry = { vDBT: ADDRESSES.debtToken, USDC: "0x01c7AEb2A0428b4159c0E333712f40e127aF639E" }[symbol];
        const decimals = symbol === "USDC" ? 6 : 18;
        if (!poolAddress) return [symbol, { symbol, poolAddress: null, asset: assetEntry, decimals, ...IDLE }] as const;
        const pool = poolAddress as Address;
        try {
          const [totalAssets, totalBorrows, availableLiquidity, utilization, rateBps, feeBps, accruedFees, projectedInterest, asset] =
            await Promise.all([
              publicClient.readContract({ address: pool, abi: poolAbi, functionName: "totalAssets" }),
              publicClient.readContract({ address: pool, abi: poolAbi, functionName: "totalBorrows" }),
              publicClient.readContract({ address: pool, abi: poolAbi, functionName: "availableLiquidity" }),
              publicClient.readContract({ address: pool, abi: poolAbi, functionName: "utilization" }),
              publicClient.readContract({ address: pool, abi: poolAbi, functionName: "rateBps" }),
              publicClient.readContract({ address: pool, abi: poolAbi, functionName: "feeBps" }),
              publicClient.readContract({ address: pool, abi: poolAbi, functionName: "accruedFees" }),
              publicClient.readContract({ address: pool, abi: poolAbi, functionName: "projectedInterest" }),
              publicClient.readContract({ address: pool, abi: poolAbi, functionName: "asset" }),
            ]) as bigint[];
          let shares = 0n, underlying = 0n, maxWithdraw = 0n, maxRedeem = 0n, walletBalance = 0n, allowance = 0n;
          if (address) {
            [shares, maxWithdraw, maxRedeem, walletBalance, allowance] = await Promise.all([
              publicClient.readContract({ address: pool, abi: poolAbi, functionName: "balanceOf", args: [address] }),
              publicClient.readContract({ address: pool, abi: poolAbi, functionName: "maxWithdraw", args: [address] }),
              publicClient.readContract({ address: pool, abi: poolAbi, functionName: "maxRedeem", args: [address] }),
              publicClient.readContract({ address: assetEntry as Address, abi: tokenAbi, functionName: "balanceOf", args: [address] }),
              publicClient.readContract({ address: assetEntry as Address, abi: tokenAbi, functionName: "allowance", args: [address, pool] }),
            ]) as bigint[];
            underlying = (await publicClient.readContract({
              address: pool, abi: poolAbi, functionName: "convertToAssets", args: [shares],
            })) as bigint;
          }
          return [symbol, {
            symbol, poolAddress, asset, decimals,
            totalAssets, totalBorrows, availableLiquidity, utilization,
            rateBps, feeBps, accruedFees, projectedInterest,
            shares, underlying, maxWithdraw, maxRedeem, walletBalance, allowance,
          }] as const;
        } catch {
          // contract not present at that address (misconfig) — render disabled
          return [symbol, { symbol, poolAddress, asset: assetEntry, decimals, ...IDLE }] as const;
        }
      }));
      if (!cancelled) setStates(Object.fromEntries(entries));
    }
    void load();
    return () => { cancelled = true; };
  }, [publicClient, address, chainId, refreshTick]);

  // ---- actions (public lender paths; no ZK, no VeilLend interaction) ----
  const runTx = useCallback(async (label: string, fn: (wc: NonNullable<typeof walletClient>) => Promise<`0x${string}`>) => {
    const wc = walletClient;
    if (!wc || !publicClient) throw new Error("Wallet not connected");
    setTx({ status: "wallet", label });
    try {
      const hash = await fn(wc);
      setTx({ status: "confirming", label, txHash: hash });
      const receipt = await publicClient.waitForTransactionReceipt({ hash });
      assertReceiptSuccess(receipt.status, hash);
      setTx({ status: "confirmed", label, txHash: hash });
      refresh();
    } catch (e) {
      const msg = (e as Error).message ?? String(e);
      setTx((t) => t.status === "confirmed" ? t : { status: "failed", label, error: friendlyPoolError(msg) });
      throw e;
    }
  }, [walletClient, publicClient, refresh]);

  const approvePool = useCallback(async (symbol: string) => {
    const st = states[symbol];
    if (!st?.poolAddress) throw new Error("Pool not configured for " + symbol);
    const poolAddr = getAddress(st.poolAddress);
    await runTx(`Approve ${symbol} for the pool`, (w) =>
      w.writeContract({
        address: getAddress(st.asset), abi: tokenAbi, functionName: "approve",
        args: [poolAddr, 2n ** 256n - 1n],
      }));
  }, [states, walletClient, runTx]);

  const deposit = useCallback(async (symbol: string, assets: bigint) => {
    const st = states[symbol];
    if (!st?.poolAddress) throw new Error("Pool not configured for " + symbol);
    if (assets === 0n) throw new Error("Amount must be greater than zero");
    if (st.walletBalance < assets) throw new Error(`Insufficient ${symbol} balance`);
    const poolAddr = getAddress(st.poolAddress);
    const receiver = getAddress(address!);
    await runTx(`Deposit ${symbol} into the pool`, (w) =>
      w.writeContract({
        address: poolAddr, abi: poolAbi, functionName: "deposit",
        args: [assets, receiver],
      }));
  }, [states, walletClient, address, runTx]);

  const redeem = useCallback(async (symbol: string, shares: bigint) => {
    const st = states[symbol];
    if (!st?.poolAddress) throw new Error("Pool not configured for " + symbol);
    if (shares === 0n) throw new Error("No shares to withdraw");
    if (st.maxRedeem === 0n) throw new Error(
      "Withdrawal temporarily unavailable — your claim is backed by loans that have not been repaid yet. You can withdraw up to the pool's current idle liquidity; the rest unlocks as borrowers repay.");
    const poolAddr = getAddress(st.poolAddress);
    const self = getAddress(address!);
    await runTx(`Withdraw from the ${symbol} pool`, (w) =>
      w.writeContract({
        address: poolAddr, abi: poolAbi, functionName: "redeem",
        args: [shares, self, self],
      }));
  }, [states, walletClient, address, runTx]);

  return {
    states, tx, refresh,
    isConnected: !!address, onHorizen: chainId === 2651420,
    approvePool, deposit, redeem,
  };
}

/** Maps pool contract errors to plain-English UI messages. */
export function friendlyPoolError(raw: string): string {
  const m = raw.match(/InsufficientPoolLiquidity/) ?? raw.match(/InsufficientLiquidity/);
  if (m) return "The pool does not have enough free liquidity right now (it is lent out to borrowers). Try a smaller amount or wait for repayments.";
  if (/EnforcedPause/.test(raw)) return "The pool is paused for maintenance. Deposits and withdrawals are temporarily disabled.";
  if (/OnlyLend/.test(raw)) return "Only the VeilLend contract can perform this action.";
  if (/user rejected|UserRejected/.test(raw)) return "The request was rejected in your wallet.";
  if (/ERC20: insufficient allowance/.test(raw)) return "Token approval missing — approve the pool first.";
  if (/ERC20: transfer amount exceeds balance/.test(raw)) return "Insufficient token balance in your wallet.";
  if (/InvalidInitialization/.test(raw)) return "Contract not initialized.";
  return raw.length > 300 ? raw.slice(0, 300) + "…" : raw;
}
