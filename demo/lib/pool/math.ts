/**
 * Pure LiquidityPool display/economics helpers — no wallet, no contracts.
 * Unit-tested in tests/pool-math.test.mts; used by usePools + PoolPanel.
 */

/** 1e18-based utilization value → human percent string ("42.3%"). */
export function formatUtilization(utilization1e18: bigint): string {
  const pct = Number(utilization1e18) / 1e16; // 1e18 → 100%
  return `${pct.toFixed(1)}%`;
}

/** Fixed annual rate in bps → human APR string ("5.00%"). */
export function formatRateBps(rateBps: bigint): string {
  return `${(Number(rateBps) / 100).toFixed(2)}%`;
}

/**
 * Projected lender APR on shares given pool state. The pool's fixed rate
 * applies to OUTSTANDING principal only, so the effective rate on deposits
 * scales with utilization: effective = rate × utilization.
 */
export function effectiveLenderAprBps(rateBps: bigint, utilization1e18: bigint): bigint {
  return (rateBps * utilization1e18) / 10n ** 18n;
}

/**
 * Realized-interest fee split (mirrors the current LiquidityPool.onRepayment,
 * which receives the principal/interest split from VeilLend's per-position
 * ledger): fee = interest × feeBps / 1e4. Principal never generates a fee.
 */
export function splitRepayment(
  principal: bigint,
  interest: bigint,
  feeBps: bigint
): { principal: bigint; interest: bigint; fee: bigint; toLenders: bigint } {
  const fee = interest > 0n && feeBps > 0n ? (interest * feeBps) / 10n ** 4n : 0n;
  return { principal, interest, fee, toLenders: interest - fee };
}

/** Projected interest over a period at the fixed rate (mirrors the contract). */
export function projectInterest(totalBorrows: bigint, rateBps: bigint, seconds: bigint): bigint {
  const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
  if (totalBorrows === 0n || rateBps === 0n || seconds === 0n) return 0n;
  return (totalBorrows * rateBps * seconds) / (10n ** 4n * SECONDS_PER_YEAR);
}

/** Decimals-aware amount formatting shared with the main page. */
export function formatAmount(wei: bigint, decimals: number): string {
  return (Number(wei) / 10 ** decimals).toFixed(2);
}
