import test from "node:test";
import assert from "node:assert/strict";
import {
  formatUtilization, formatRateBps, effectiveLenderAprBps,
  splitRepayment, projectInterest, formatAmount,
} from "../lib/pool/math.ts";

/** Pool economics math — pure functions mirroring LiquidityPool.sol. */

const WAD = 10n ** 18n;

test("formatUtilization renders 1e18-scaled utilization as percent", () => {
  assert.equal(formatUtilization(0n), "0.0%");
  assert.equal(formatUtilization(42n * 10n ** 16n + 3n * 10n ** 15n), "42.3%");
  assert.equal(formatUtilization(WAD), "100.0%");
});

test("formatRateBps renders bps as APR", () => {
  assert.equal(formatRateBps(500n), "5.00%");
  assert.equal(formatRateBps(0n), "0.00%");
  assert.equal(formatRateBps(1234n), "12.34%");
});

test("effectiveLenderAprBps scales the fixed rate by utilization", () => {
  // 5% rate at 50% utilization → 2.5% effective on deposits
  assert.equal(effectiveLenderAprBps(500n, WAD / 2n), 250n);
  // zero utilization → nothing accrues
  assert.equal(effectiveLenderAprBps(500n, 0n), 0n);
});

test("splitRepayment mirrors the explicit principal/interest split", () => {
  // principal-only repayment
  assert.deepEqual(splitRepayment(600n * WAD, 0n, 1000n), {
    principal: 600n * WAD, interest: 0n, fee: 0n, toLenders: 0n,
  });
  // principal + interest with 10% fee: interest 50 → fee 5 → lenders 45
  assert.deepEqual(splitRepayment(600n * WAD, 50n * WAD, 1000n), {
    principal: 600n * WAD, interest: 50n * WAD, fee: 5n * WAD, toLenders: 45n * WAD,
  });
  // zero fee: all interest to lenders
  assert.deepEqual(splitRepayment(600n * WAD, 50n * WAD, 0n), {
    principal: 600n * WAD, interest: 50n * WAD, fee: 0n, toLenders: 50n * WAD,
  });
});

test("projectInterest matches the contract formula", () => {
  const YEAR = 365n * 24n * 60n * 60n;
  // 400 units at 5% for a year → 20 units
  assert.equal(projectInterest(400n * WAD, 500n, YEAR), 20n * WAD);
  assert.equal(projectInterest(400n * WAD, 500n, 0n), 0n);
  assert.equal(projectInterest(0n, 500n, YEAR), 0n);
  assert.equal(projectInterest(400n * WAD, 0n, YEAR), 0n);
  // half a year → half the interest
  assert.equal(projectInterest(400n * WAD, 500n, YEAR / 2n), 10n * WAD);
});

test("formatAmount is decimals-aware", () => {
  assert.equal(formatAmount(1500000n, 6), "1.50");
  assert.equal(formatAmount(WAD, 18), "1.00");
});
