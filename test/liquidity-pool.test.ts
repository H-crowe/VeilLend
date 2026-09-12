import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { HardhatEthersSigner } from "@nomicfoundation/hardhat-ethers/signers";
import type { LiquidityPool, LiquidityPoolV2Mock, MockStorkOracle, StorkPriceOracle, TokenMock, TokenMock6, VeilLend } from "../typechain-types";
import {
  ACTION_BORROW,
  ACTION_DEPOSIT,
  ACTION_REPAY,
  buildRiskTransition,
  buildTransition,
  computeCommitment,
  generateProof,
  makeInitialState,
  requireZkArtifacts,
} from "../scripts/prove";

/**
 * Liquidity Pool MVP tests.
 *
 * Part A — unit tests per debt asset (vDBT 18dec, Mock USDC 6dec): lender
 * deposit/redeem, share accounting, VeilLend-only pull/repay paths, interest
 * raising share value, pause, access control, pool isolation.
 *
 * Part B — full ZK integration through VeilLend for both assets: position
 * create → deposit (proof) → borrow funded by the pool → repay returned to
 * the pool → lender redeem. Proves the real wiring (debtPools) end to end.
 */

const WAD = 10n ** 18n;
const USD6 = 10n ** 6n;
const OFFSET = 1000n; // pool _decimalsOffset() = 3

const randHex = () => ethers.hexlify(ethers.randomBytes(31));
const bytes32 = (v: bigint) => ethers.zeroPadValue(ethers.toBeHex(v), 32);
const chainSecs = async (): Promise<bigint> => BigInt((await ethers.provider.getBlock("latest")).timestamp);

/** 18-dec-normalized price for an asset: raw 1e8 price × 10^(18 − decimals). */
const norm = (raw1e8: bigint, decimals: number) => raw1e8 * 10n ** BigInt(18 - decimals);

// ---------------------------------------------------------------------------
// Part A — unit fixtures/tests
// ---------------------------------------------------------------------------

interface AssetDef {
  name: string;
  symbol: string;
  decimals: number;
  unit: bigint;
}

const ASSETS: AssetDef[] = [
  { name: "Veil Debt", symbol: "vDBT", decimals: 18, unit: WAD },
  { name: "USD Coin", symbol: "USDC", decimals: 6, unit: USD6 },
];

async function poolFixture(assetDef: AssetDef) {
  const [owner, lender, borrower, lend, rando] = await ethers.getSigners();
  const asset =
    assetDef.decimals === 6
      ? ((await (await ethers.getContractFactory("TokenMock6")).deploy(assetDef.name, assetDef.symbol)) as unknown as TokenMock6)
      : ((await (await ethers.getContractFactory("TokenMock")).deploy(assetDef.name, assetDef.symbol)) as unknown as TokenMock);
  const pool = (await upgrades.deployProxy(
    await ethers.getContractFactory("LiquidityPool"),
    [await asset.getAddress(), owner.address, lend.address, `Veil ${assetDef.symbol} Pool`, `vl${assetDef.symbol}P`],
    { kind: "uups" }
  )) as unknown as LiquidityPool;

  const depositLiquidity = async (who: typeof lender, amount: bigint) => {
    await asset.mint(who.address, amount);
    await asset.connect(who).approve(await pool.getAddress(), ethers.MaxUint256);
    await pool.connect(who).deposit(amount, who.address);
  };
  return { owner, lender, borrower, lend, rando, asset, pool, depositLiquidity, assetDef };
}

for (const A of ASSETS) {
  const unitFix = () => poolFixture(A);
  describe(`LiquidityPool MVP — ${A.symbol} (${A.decimals} dec)`, () => {
    it("lender deposits, receives proportional shares; convert views are consistent", async () => {
      const { pool, asset, lender, depositLiquidity, assetDef } = await loadFixture(unitFix);
      const amount = 1000n * assetDef.unit;
      await depositLiquidity(lender, amount);
      expect(await asset.balanceOf(await pool.getAddress())).to.equal(amount);
      expect(await pool.totalAssets()).to.equal(amount);
      expect(await pool.availableLiquidity()).to.equal(amount);
      expect(await pool.totalBorrows()).to.equal(0n);
      const shares = await pool.balanceOf(lender.address);
      expect(shares).to.equal(amount * OFFSET); // first deposit: assets × 10^offset
      expect(await pool.convertToAssets(shares)).to.equal(amount);
      expect(await pool.convertToShares(amount)).to.equal(shares);
    });

    it("lender can redeem shares back for assets", async () => {
      const { pool, asset, lender, depositLiquidity, assetDef } = await loadFixture(unitFix);
      const amount = 500n * assetDef.unit;
      await depositLiquidity(lender, amount);
      const shares = await pool.balanceOf(lender.address);
      const half = shares / 2n;
      await pool.connect(lender).redeem(half, lender.address, lender.address);
      expect(await asset.balanceOf(lender.address)).to.equal(amount / 2n);
      expect(await pool.totalAssets()).to.equal(amount / 2n);
      expect(await pool.availableLiquidity()).to.equal(amount / 2n);
      expect(await pool.balanceOf(lender.address)).to.equal(shares - half);
    });

    it("only the wired lend contract can pull liquidity; pulling decreases availableLiquidity", async () => {
      const { pool, asset, lender, lend, rando, borrower, owner, depositLiquidity, assetDef } = await loadFixture(unitFix);
      const amount = 1000n * assetDef.unit;
      await depositLiquidity(lender, amount);

      await expect(pool.connect(rando).pullLiquidity(borrower.address, 10n)).to.be.revertedWithCustomError(pool, "OnlyLend");
      await expect(pool.connect(lender).pullLiquidity(borrower.address, 10n)).to.be.revertedWithCustomError(pool, "OnlyLend");
      await expect(pool.connect(owner).pullLiquidity(borrower.address, 10n)).to.be.revertedWithCustomError(pool, "OnlyLend");

      const pull = 400n * assetDef.unit;
      await pool.connect(lend).pullLiquidity(borrower.address, pull);
      expect(await asset.balanceOf(borrower.address)).to.equal(pull);
      expect(await pool.availableLiquidity()).to.equal(amount - pull);
      expect(await pool.totalBorrows()).to.equal(pull);
      expect(await pool.totalAssets()).to.equal(amount); // unchanged: principal is out on loan
    });

    it("cannot pull more than available liquidity", async () => {
      const { pool, lender, lend, borrower, depositLiquidity, assetDef } = await loadFixture(unitFix);
      const amount = 100n * assetDef.unit;
      await depositLiquidity(lender, amount);
      await expect(pool.connect(lend).pullLiquidity(borrower.address, amount + 1n)).to.be.revertedWithCustomError(pool, "InsufficientPoolLiquidity");
    });

    it("repayment reduces totalBorrows; interest raises pool asset value and lender payout", async () => {
      const { pool, asset, lender, lend, depositLiquidity, assetDef } = await loadFixture(unitFix);
      const deposit = 1000n * assetDef.unit;
      await depositLiquidity(lender, deposit);
      const principal = 600n * assetDef.unit;
      await pool.connect(lend).pullLiquidity(lend.address, principal);

      // simulate VeilLend forwarding a repayment of principal + interest
      const interest = 30n * assetDef.unit;
      await asset.mint(lend.address, principal + interest);
      await asset.connect(lend).transfer(await pool.getAddress(), principal + interest);
      await pool.connect(lend).onRepayment(principal, interest);

      expect(await pool.totalBorrows()).to.equal(0n);
      expect(await pool.totalAssets()).to.equal(deposit + interest); // interest is pool assets now
      expect(await pool.convertToAssets(await pool.balanceOf(lender.address))).to.be.within(deposit + interest - 5n, deposit + interest);

      // lender redeems — captures principal + share of interest
      await pool.connect(lender).redeem(await pool.balanceOf(lender.address), lender.address, lender.address);
      expect(await asset.balanceOf(lender.address)).to.be.within(deposit + interest - 2n, deposit + interest);
      // ≤ a few wei of rounding dust remain after a full redeem (ERC4626 floor math)
      expect(await pool.totalAssets()).to.be.lessThan(10n);
    });

    it("onRepayment can only be called by the lend contract", async () => {
      const { pool, rando } = await loadFixture(unitFix);
      await expect(pool.connect(rando).onRepayment(1n, 0n)).to.be.revertedWithCustomError(pool, "OnlyLend");
    });

    it("utilization reflects borrows over assets", async () => {
      const { pool, lender, lend, depositLiquidity, assetDef } = await loadFixture(unitFix);
      expect(await pool.utilization()).to.equal(0n);
      const amount = 1000n * assetDef.unit;
      await depositLiquidity(lender, amount);
      await pool.connect(lend).pullLiquidity(lend.address, 400n * assetDef.unit);
      expect(await pool.utilization()).to.equal((400n * assetDef.unit * 10n ** 18n) / (1000n * assetDef.unit));
    });

    it("random account cannot modify pool configuration", async () => {
      const { pool, rando, lend } = await loadFixture(unitFix);
      await expect(pool.connect(rando).setLend(rando.address)).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
      await expect(pool.connect(rando).setPaused(true)).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
      await expect(pool.connect(lend).setLend(rando.address)).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    });

    it("pause blocks deposits, withdrawals and borrow funding; repayments still settle", async () => {
      const { pool, owner, asset, lender, lend, depositLiquidity, assetDef } = await loadFixture(unitFix);
      const amount = 100n * assetDef.unit;
      await depositLiquidity(lender, amount);
      await pool.connect(lend).pullLiquidity(lend.address, 60n * assetDef.unit);

      await expect(pool.connect(owner).setPaused(true)).to.emit(pool, "Paused");
      await expect(pool.connect(lender).deposit(1n, lender.address)).to.be.revertedWithCustomError(pool, "EnforcedPause");
      await expect(pool.connect(lender).withdraw(1n, lender.address, lender.address)).to.be.revertedWithCustomError(pool, "EnforcedPause");
      await expect(pool.connect(lend).pullLiquidity(lender.address, 1n)).to.be.revertedWithCustomError(pool, "EnforcedPause");

      // in-flight debt can always be settled back
      await asset.mint(lend.address, 60n * assetDef.unit);
      await asset.connect(lend).transfer(await pool.getAddress(), 60n * assetDef.unit);
      await expect(pool.connect(lend).onRepayment(60n * assetDef.unit, 0n)).to.emit(pool, "RepaymentReceived");

      await expect(pool.connect(owner).setPaused(false)).to.emit(pool, "Unpaused");
      await pool.connect(lender).withdraw(1n, lender.address, lender.address);
    });

    it("pools are isolated: same-asset pools and cross-asset pools share nothing", async () => {
      const { owner, lend } = await loadFixture(unitFix);
      const assetA = (await (await ethers.getContractFactory(A.decimals === 6 ? "TokenMock6" : "TokenMock")).deploy(A.name, A.symbol)) as unknown as TokenMock;
      const assetB = (await (await ethers.getContractFactory(A.decimals === 6 ? "TokenMock6" : "TokenMock")).deploy(A.name + " B", A.symbol + "B")) as unknown as TokenMock;
      const poolB = (await upgrades.deployProxy(
        await ethers.getContractFactory("LiquidityPool"),
        [await assetB.getAddress(), owner.address, lend.address, "Pool B", "PB"],
        { kind: "uups" }
      )) as unknown as LiquidityPool;
      // same asset, second pool
      const poolA2 = (await upgrades.deployProxy(
        await ethers.getContractFactory("LiquidityPool"),
        [await assetA.getAddress(), owner.address, lend.address, "Pool A2", "PA2"],
        { kind: "uups" }
      )) as unknown as LiquidityPool;

      await assetA.mint(owner.address, 10n * A.unit);
      await assetA.connect(owner).approve(await poolA2.getAddress(), ethers.MaxUint256);
      await poolA2.connect(owner).deposit(10n * A.unit, owner.address);

      // poolB (different asset, empty) and any other pool are unaffected
      expect(await poolB.totalAssets()).to.equal(0n);
      expect(await poolB.availableLiquidity()).to.equal(0n);
      expect(await poolB.totalBorrows()).to.equal(0n);
      // borrowing (pull) from poolB is impossible even though poolA2 has funds
      await expect(poolB.connect(lend).pullLiquidity(owner.address, 1n)).to.be.revertedWithCustomError(poolB, "InsufficientPoolLiquidity");
      expect(await poolA2.totalAssets()).to.equal(10n * A.unit);
    });
  });
}

// ---------------------------------------------------------------------------
// Part A2 — UUPS upgradeability of the pool (proxy keeps depositor state)
// ---------------------------------------------------------------------------

async function upgradeFixture() {
  const f = await poolFixture(ASSETS[0]); // vDBT-shaped asset
  // create state worth preserving: deposit + outstanding principal + interest
  await f.depositLiquidity(f.lender, 1000n * WAD);
  await f.pool.connect(f.lend).pullLiquidity(f.lend.address, 600n * WAD); // totalBorrows = 600
  await f.asset.mint(f.lend.address, 100n * WAD);
  await f.asset.connect(f.lend).transfer(await f.pool.getAddress(), 100n * WAD);
  await f.pool.connect(f.lend).onRepayment(100n * WAD, 0n); // partial: totalBorrows = 500, idle = 500
  return f;
}

describe("LiquidityPool UUPS upgradeability", () => {
  it("initializes exactly once; re-initialization fails", async () => {
    const { pool, asset, owner, lend } = await loadFixture(upgradeFixture);
    await expect(
      (pool as unknown as LiquidityPool).initialize(await asset.getAddress(), owner.address, lend.address, "X", "X")
    ).to.be.revertedWithCustomError(pool, "InvalidInitialization");
  });

  it("non-owners cannot upgrade the proxy", async () => {
    const { pool, lender, lend, rando } = await loadFixture(upgradeFixture);
    const v2 = await ethers.getContractFactory("LiquidityPoolV2Mock");
    const v2Impl = await v2.deploy();
    for (const who of [lender, lend, rando]) {
      await expect(pool.connect(who).upgradeToAndCall(await v2Impl.getAddress(), "0x"))
        .to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    }
    // still V1
    await expect(pool.connect(lend).pullLiquidity(lend.address, 1n)).to.not.be.reverted;
  });

  it("owner upgrades: same proxy, same asset, shares/balances/totalBorrows/liquidity preserved, redeem works, V2 live", async () => {
    const { pool, asset, owner, lender, lend } = await loadFixture(upgradeFixture);
    const poolAddr = await pool.getAddress();

    // ---- state snapshot BEFORE upgrade ----
    const before = {
      asset: await pool.asset(),
      shares: await pool.balanceOf(lender.address),
      lenderAsset: await asset.balanceOf(lender.address),
      poolAsset: await asset.balanceOf(poolAddr),
      totalBorrows: await pool.totalBorrows(),
      available: await pool.availableLiquidity(),
      totalAssets: await pool.totalAssets(),
      utilization: await pool.utilization(),
      decimals: await pool.decimals(),
      name: await pool.name(),
      symbol: await pool.symbol(),
    };
    expect(before.totalBorrows).to.equal(500n * WAD);
    expect(before.available).to.equal(500n * WAD);
    expect(before.shares).to.equal(1000n * WAD * OFFSET);

    // ---- upgrade (owner) ----
    const v2 = await ethers.getContractFactory("LiquidityPoolV2Mock");
    await upgrades.upgradeProxy(poolAddr, v2);
    const upgraded = (await ethers.getContractAt("LiquidityPoolV2Mock", poolAddr)) as unknown as LiquidityPoolV2Mock;

    // ---- same proxy address, preserved ERC4626 metadata ----
    expect(await upgraded.getAddress()).to.equal(poolAddr);
    expect(await upgraded.asset()).to.equal(before.asset);
    expect(await upgraded.name()).to.equal(before.name);
    expect(await upgraded.symbol()).to.equal(before.symbol);
    expect(await upgraded.decimals()).to.equal(before.decimals);

    // ---- storage preserved explicitly (before vs after) ----
    expect(await upgraded.balanceOf(lender.address)).to.equal(before.shares);
    expect(await asset.balanceOf(lender.address)).to.equal(before.lenderAsset);
    expect(await asset.balanceOf(poolAddr)).to.equal(before.poolAsset);
    expect(await upgraded.totalBorrows()).to.equal(before.totalBorrows);
    expect(await upgraded.availableLiquidity()).to.equal(before.available);
    expect(await upgraded.totalAssets()).to.equal(before.totalAssets);
    expect(await upgraded.utilization()).to.equal(before.utilization);

    // ---- V2 implementation is live and its appended state starts fresh ----
    expect(await upgraded.v2Extra()).to.equal(0n);
    await expect(upgraded.v2Ping("upgraded")).to.emit(upgraded, "V2Marker").withArgs("upgraded");
    expect(await upgraded.v2Extra()).to.equal(1n);

    // ---- onlyLend paths still work after upgrade ----
    await upgraded.connect(lend).pullLiquidity(lend.address, 100n * WAD);
    expect(await upgraded.totalBorrows()).to.equal(600n * WAD);
    await asset.mint(lend.address, 100n * WAD);
    await asset.connect(lend).transfer(poolAddr, 100n * WAD);
    await upgraded.connect(lend).onRepayment(100n * WAD, 0n);
    expect(await upgraded.totalBorrows()).to.equal(500n * WAD);

    // ---- lender can still redeem/withdraw after the upgrade ----
    const sharesBefore = await upgraded.balanceOf(lender.address);
    await upgraded.connect(lender).redeem(sharesBefore / 2n, lender.address, lender.address);
    expect(await upgraded.balanceOf(lender.address)).to.equal(sharesBefore - sharesBefore / 2n);
    expect(await asset.balanceOf(lender.address)).to.be.greaterThan(before.lenderAsset);
  });

  it("V1 → V2 storage layout validates (appended state only, offline check)", async () => {
    await loadFixture(upgradeFixture); // ensure compiled
    await upgrades.validateUpgrade(
      await ethers.getContractFactory("LiquidityPool"),
      await ethers.getContractFactory("LiquidityPoolV2Mock"),
      { kind: "uups" }
    );
  });
});

// ---------------------------------------------------------------------------
// Part A3 — hardening edge cases: mint, setLend, donations, withdrawal bounds
// ---------------------------------------------------------------------------

const edgeFix = () => poolFixture(ASSETS[0]);

describe("LiquidityPool hardening edge cases", () => {
  it("initialize rejects a zero asset address", async () => {
    const { owner, lend } = await loadFixture(upgradeFixture);
    await expect(
      (await ethers.getContractFactory("LiquidityPool")).deploy() // impl only
    ).to.not.be.reverted; // deployment of the implementation always works
    await expect(
      upgrades.deployProxy(await ethers.getContractFactory("LiquidityPool"), [
        ethers.ZeroAddress, owner.address, lend.address, "X", "X",
      ], { kind: "uups" })
    ).to.be.revertedWithCustomError(await ethers.getContractFactory("LiquidityPool"), "ZeroAddress");
  });

  it("mint path mints equivalent shares and is pause-gated", async () => {
    // upgradeFixture state: 1000 deposited, 500 borrowed, 500 idle
    const { pool, asset, lender, owner, assetDef } = await loadFixture(upgradeFixture);
    const amount = 250n * assetDef.unit;
    await asset.mint(lender.address, amount);
    await asset.connect(lender).approve(await pool.getAddress(), ethers.MaxUint256);
    const sharesBefore = await pool.balanceOf(lender.address);
    const shares = await pool.convertToShares(amount);
    await expect(pool.connect(lender).mint(shares, lender.address)).to.emit(pool, "Deposit");
    expect(await pool.balanceOf(lender.address)).to.equal(sharesBefore + shares);
    // mint pulled the assets-ceil for those shares into the pool (was 500 idle)
    expect(await asset.balanceOf(await pool.getAddress())).to.be.greaterThanOrEqual(500n * assetDef.unit + amount);
    expect(await asset.balanceOf(await pool.getAddress())).to.be.lessThan(500n * assetDef.unit + amount + 10n);
    expect(await pool.totalAssets()).to.equal(1000n * assetDef.unit + amount);

    await pool.connect(owner).setPaused(true);
    await expect(pool.connect(lender).mint(shares, lender.address)).to.be.revertedWithCustomError(pool, "EnforcedPause");
    await pool.connect(owner).setPaused(false);
  });

  it("setLend rewires the only authorized caller (positive + zero check)", async () => {
    const { pool, owner, lender, lend, rando, depositLiquidity, assetDef } = await loadFixture(edgeFix);
    await depositLiquidity(lender, 500n * assetDef.unit);
    await expect(pool.connect(owner).setLend(ethers.ZeroAddress)).to.be.revertedWithCustomError(pool, "ZeroAddress");

    await expect(pool.connect(owner).setLend(rando.address)).to.emit(pool, "LendSet").withArgs(rando.address);
    // old lend loses authority, new lend gains it
    await expect(pool.connect(lend).pullLiquidity(lend.address, 1n)).to.be.revertedWithCustomError(pool, "OnlyLend");
    await expect(pool.connect(rando).pullLiquidity(rando.address, 1n)).to.not.be.reverted;
    // restore
    await pool.connect(owner).setLend(lend.address);
    await expect(pool.connect(lend).pullLiquidity(lend.address, 1n)).to.not.be.reverted;
  });

  it("direct donations raise assets/share price but mint no shares; donated liquidity is lendable", async () => {
    const { pool, asset, lender, lend, depositLiquidity, assetDef } = await loadFixture(edgeFix);
    const deposit = 1000n * assetDef.unit;
    await depositLiquidity(lender, deposit);
    const shares = await pool.balanceOf(lender.address);

    // donation: no deposit path, no shares
    await asset.mint(lender.address, 50n * assetDef.unit);
    await asset.connect(lender).transfer(await pool.getAddress(), 50n * assetDef.unit);
    expect(await pool.balanceOf(lender.address)).to.equal(shares); // no shares minted
    expect(await pool.availableLiquidity()).to.equal(deposit + 50n * assetDef.unit);
    expect(await pool.totalAssets()).to.equal(deposit + 50n * assetDef.unit);
    // existing lender's claim improved by the donation
    expect(await pool.convertToAssets(shares)).to.be.greaterThan(deposit);
    // donated idle is lendable by VeilLend
    await expect(pool.connect(lend).pullLiquidity(lend.address, 50n * assetDef.unit)).to.not.be.reverted;
  });

  it("withdrawals respect locked liquidity: partial exit at maxWithdraw, full exit only after repayment", async () => {
    const { pool, asset, lender, lend, depositLiquidity, assetDef } = await loadFixture(edgeFix);
    const deposit = 1000n * assetDef.unit;
    await depositLiquidity(lender, deposit);
    const locked = 600n * assetDef.unit;
    await pool.connect(lend).pullLiquidity(lend.address, locked); // idle = 400

    // maxWithdraw is honest: capped by idle, not by the 1000 claim
    const mw = await pool.maxWithdraw(lender.address);
    expect(mw).to.equal(400n * assetDef.unit);
    expect(await pool.maxRedeem(lender.address)).to.equal(await pool.convertToShares(400n * assetDef.unit));

    // withdrawing more than idle fails closed; withdrawing exactly maxWithdraw succeeds
    await expect(pool.connect(lender).withdraw(400n * assetDef.unit + 1n, lender.address, lender.address)).to.be.reverted;
    await expect(pool.connect(lender).withdraw(mw, lender.address, lender.address)).to.not.be.reverted;
    expect(await asset.balanceOf(lender.address)).to.equal(400n * assetDef.unit);

    // remaining claim is stuck until the pool is repaid
    expect(await pool.maxWithdraw(lender.address)).to.equal(0n);
    await expect(pool.connect(lender).withdraw(1n, lender.address, lender.address)).to.be.reverted;

    // full repayment unlocks the entire remaining claim
    await asset.mint(lend.address, locked);
    await asset.connect(lend).transfer(await pool.getAddress(), locked);
    await pool.connect(lend).onRepayment(locked, 0n);
    expect(await pool.totalBorrows()).to.equal(0n);
    const mw2 = await pool.maxWithdraw(lender.address);
    expect(mw2).to.be.greaterThan(599n * assetDef.unit); // ~600 minus rounding dust
    await expect(pool.connect(lender).withdraw(mw2, lender.address, lender.address)).to.not.be.reverted;
    expect(await pool.totalAssets()).to.be.lessThan(10n); // dust only
  });

  it("maxRedeem honors the idle cap; redeeming max succeeds and never touches lent-out principal", async () => {
    const { pool, asset, lender, lend, depositLiquidity, assetDef } = await loadFixture(edgeFix);
    await depositLiquidity(lender, 800n * assetDef.unit);
    await pool.connect(lend).pullLiquidity(lend.address, 700n * assetDef.unit); // idle = 100
    const mr = await pool.maxRedeem(lender.address);
    const idle0 = await pool.availableLiquidity();
    await expect(pool.connect(lender).redeem(mr, lender.address, lender.address)).to.not.be.reverted;
    expect(await pool.availableLiquidity()).to.be.lessThanOrEqual(idle0); // never dips below 0 / into principal
    expect(await pool.totalBorrows()).to.equal(700n * assetDef.unit); // lent-out principal untouched by redeems
  });
});

// ---------------------------------------------------------------------------
// Part A4 — pool economics: fixed rate model, protocol fees, reserves
// ---------------------------------------------------------------------------

describe("LiquidityPool economics (fees, reserves, rate model)", () => {
  it("configurePool validates inputs and is owner-only", async () => {
    const { pool, owner, lender, rando } = await loadFixture(edgeFix);
    await expect(pool.connect(lender).configurePool(100, rando.address)).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    await expect(pool.connect(owner).configurePool(2_001, rando.address)).to.be.revertedWithCustomError(pool, "InvalidParameter");
    await expect(pool.connect(owner).configurePool(100, ethers.ZeroAddress)).to.be.revertedWithCustomError(pool, "ZeroAddress");
    await expect(pool.connect(owner).configurePool(0, ethers.ZeroAddress)).to.emit(pool, "PoolConfigured");
    // fee without recipient is rejected, but rate-only config is fine
    await expect(pool.connect(owner).configurePool(100, rando.address)).to.emit(pool, "PoolConfigured");
  });

  it("protocol fee takes its share of realized interest only; lenders get the rest", async () => {
    const { pool, asset, owner, lender, lend, depositLiquidity, assetDef } = await loadFixture(edgeFix);
    await pool.connect(owner).configurePool(1_000, owner.address); // 10% fee on interest
    const deposit = 1000n * assetDef.unit;
    await depositLiquidity(lender, deposit);
    const shares = await pool.balanceOf(lender.address);
    await pool.connect(lend).pullLiquidity(lend.address, 600n * assetDef.unit);

    // repay principal + 50 units interest → 10% fee = 5 units
    await asset.mint(lend.address, 650n * assetDef.unit);
    await asset.connect(lend).transfer(await pool.getAddress(), 650n * assetDef.unit);
    await expect(pool.connect(lend).onRepayment(600n * assetDef.unit, 50n * assetDef.unit))
      .to.emit(pool, "RepaymentReceived").withArgs(600n * assetDef.unit, 50n * assetDef.unit);

    expect(await pool.totalBorrows()).to.equal(0n);
    expect(await pool.accruedFees()).to.equal(5n * assetDef.unit);
    // share backing = 1000 deposit + 45 lender interest (fee excluded);
    // cash = 400 idle + 650 repaid = 1050, of which 5 is ring-fenced fees
    expect(await pool.totalAssets()).to.equal(1000n * assetDef.unit + 45n * assetDef.unit);
    expect(await pool.convertToAssets(shares)).to.be.within(
      1000n * assetDef.unit + 45n * assetDef.unit - 5n, 1000n * assetDef.unit + 45n * assetDef.unit
    );
    expect(await pool.availableLiquidity()).to.equal(1045n * assetDef.unit);
  });

  it("fees can never be lent out and are claimable by the owner only, to the recipient only", async () => {
    const { pool, asset, owner, lender, lend, rando, depositLiquidity, assetDef } = await loadFixture(edgeFix);
    await pool.connect(owner).configurePool(2_000, rando.address); // 20% fee
    await depositLiquidity(lender, 1000n * assetDef.unit);
    await pool.connect(lend).pullLiquidity(lend.address, 500n * assetDef.unit);
    await asset.mint(lend.address, 510n * assetDef.unit);
    await asset.connect(lend).transfer(await pool.getAddress(), 510n * assetDef.unit);
    await pool.connect(lend).onRepayment(500n * assetDef.unit, 10n * assetDef.unit); // interest 10 → fee 2
    expect(await pool.accruedFees()).to.equal(2n * assetDef.unit);

    // claim: only owner; recipient only; ring-fenced from lending
    await expect(pool.connect(lend).claimFees()).to.be.revertedWithCustomError(pool, "OwnableUnauthorizedAccount");
    await expect(pool.connect(owner).claimFees()).to.emit(pool, "FeesClaimed").withArgs(rando.address, 2n * assetDef.unit);
    expect(await asset.balanceOf(rando.address)).to.equal(2n * assetDef.unit);
    expect(await pool.accruedFees()).to.equal(0n);
    await expect(pool.connect(owner).claimFees()).to.be.revertedWithCustomError(pool, "NothingToClaim");

    // the fee reserve was never lendable: pulling max lendable is fine, one more unit is not
    const lendable = await pool.availableLiquidity();
    expect(lendable).to.equal(1008n * assetDef.unit); // 500 idle + 510 repaid - 2 fees
    await expect(pool.connect(lend).pullLiquidity(rando.address, lendable)).to.not.be.reverted;
    await expect(pool.connect(lend).pullLiquidity(rando.address, 1n)).to.be.revertedWithCustomError(pool, "InsufficientPoolLiquidity");
  });

  it("with feeBps = 0 (default) all interest belongs to lenders", async () => {
    const { pool, asset, owner, lender, lend, depositLiquidity, assetDef } = await loadFixture(edgeFix);
    await depositLiquidity(lender, 1000n * assetDef.unit);
    await pool.connect(lend).pullLiquidity(lend.address, 600n * assetDef.unit);
    await asset.mint(lend.address, 650n * assetDef.unit);
    await asset.connect(lend).transfer(await pool.getAddress(), 650n * assetDef.unit);
    await pool.connect(lend).onRepayment(600n * assetDef.unit, 50n * assetDef.unit);
    expect(await pool.accruedFees()).to.equal(0n);
    expect(await pool.totalAssets()).to.equal(1050n * assetDef.unit);
    await expect(pool.connect(owner).claimFees()).to.be.revertedWithCustomError(pool, "NothingToClaim");
  });

  it("two borrowers: A's principal+interest repayment is recognized while B's principal stays outstanding", async () => {
    const { pool, asset, owner, lender, lend, depositLiquidity, assetDef } = await loadFixture(edgeFix);
    await pool.connect(owner).configurePool(1_000, owner.address); // 10% fee on interest
    const deposit = 2000n * assetDef.unit;
    await depositLiquidity(lender, deposit);

    // borrower A pulls 600, borrower B pulls 400 (two independent borrows)
    await pool.connect(lend).pullLiquidity(lend.address, 600n * assetDef.unit);
    await pool.connect(lend).pullLiquidity(lend.address, 400n * assetDef.unit);
    expect(await pool.totalBorrows()).to.equal(1000n * assetDef.unit);

    // A repays principal 600 + interest 30 → fee 3, B's 400 untouched
    await asset.mint(lend.address, 630n * assetDef.unit);
    await asset.connect(lend).transfer(await pool.getAddress(), 630n * assetDef.unit);
    await pool.connect(lend).onRepayment(600n * assetDef.unit, 30n * assetDef.unit);
    expect(await pool.totalBorrows()).to.equal(400n * assetDef.unit); // B's principal intact
    expect(await pool.accruedFees()).to.equal(3n * assetDef.unit);
    // totalAssets EXCLUDES the ring-fenced fee: lender backing = 2000 + 27 net
    expect(await pool.totalAssets()).to.equal(deposit + 27n * assetDef.unit);
    expect(await pool.convertToAssets(await pool.balanceOf(lender.address))).to.be.within(
      deposit + 27n * assetDef.unit - 2n, deposit + 27n * assetDef.unit + 2n // ±wei rounding
    );

    // B repays principal only (400, zero interest)
    await asset.mint(lend.address, 400n * assetDef.unit);
    await asset.connect(lend).transfer(await pool.getAddress(), 400n * assetDef.unit);
    await pool.connect(lend).onRepayment(400n * assetDef.unit, 0n);
    expect(await pool.totalBorrows()).to.equal(0n);
    expect(await pool.accruedFees()).to.equal(3n * assetDef.unit); // unchanged
    // totalAssets excludes the ring-fenced fee reserve
    expect(await pool.totalAssets()).to.equal(deposit + 27n * assetDef.unit);
  });

  it("principal-only repayment generates no fee and leaves accruedFees untouched", async () => {
    const { pool, asset, owner, lender, lend, depositLiquidity, assetDef } = await loadFixture(edgeFix);
    await pool.connect(owner).configurePool(2_000, owner.address); // 20% fee
    await depositLiquidity(lender, 1000n * assetDef.unit);
    await pool.connect(lend).pullLiquidity(lend.address, 300n * assetDef.unit);
    await asset.mint(lend.address, 300n * assetDef.unit);
    await asset.connect(lend).transfer(await pool.getAddress(), 300n * assetDef.unit);
    await pool.connect(lend).onRepayment(300n * assetDef.unit, 0n); // principal only
    expect(await pool.accruedFees()).to.equal(0n); // principal never generates a fee
    expect(await pool.totalAssets()).to.equal(1000n * assetDef.unit);
  });

  it("writeOffBorrows: onlyLend, realizes loss across lender shares, cannot exceed outstanding", async () => {
    const { pool, asset, owner, lender, lend, rando, depositLiquidity, assetDef } = await loadFixture(edgeFix);
    await depositLiquidity(lender, 1000n * assetDef.unit);
    await pool.connect(lend).pullLiquidity(lend.address, 600n * assetDef.unit); // 600 borrowed, 400 idle

    await expect(pool.connect(rando).writeOffBorrows(100n * assetDef.unit)).to.be.revertedWithCustomError(pool, "OnlyLend");
    await expect(pool.connect(owner).writeOffBorrows(100n * assetDef.unit)).to.be.revertedWithCustomError(pool, "OnlyLend");
    await expect(pool.connect(lend).writeOffBorrows(601n * assetDef.unit)).to.be.revertedWithCustomError(pool, "InvalidParameter");

    const valueBefore = await pool.convertToAssets(await pool.balanceOf(lender.address));
    const totalAssetsBefore = await pool.totalAssets();
    await expect(pool.connect(lend).writeOffBorrows(200n * assetDef.unit))
      .to.emit(pool, "BorrowsWrittenOff").withArgs(200n * assetDef.unit);
    // loss realized: borrows and totalAssets drop; lender share value depreciates proportionally
    expect(await pool.totalBorrows()).to.equal(400n * assetDef.unit);
    expect(await pool.totalAssets()).to.equal(totalAssetsBefore - 200n * assetDef.unit);
    expect(await pool.convertToAssets(await pool.balanceOf(lender.address))).to.be.lessThan(valueBefore);
    // idle liquidity unchanged (no tokens move)
    expect(await pool.availableLiquidity()).to.equal(400n * assetDef.unit);
  });

  it("fixed rate model projects interest informationally and never backs shares", async () => {
    const { pool, owner, lender, lend, depositLiquidity, assetDef } = await loadFixture(edgeFix);
    // the borrower rate is synced from VeilLend by the lend contract
    await pool.connect(lend).updateRateBps(500);
    await depositLiquidity(lender, 1000n * assetDef.unit);
    await pool.connect(lend).pullLiquidity(lend.address, 400n * assetDef.unit);
    const assetsBefore = await pool.totalAssets();

    await time.increase(365n * 24n * 60n * 60n);
    await expect(pool.connect(lender).accrueInterest()).to.emit(pool, "InterestAccrued");
    // 400 units × 5% × ~1yr = 20 units projected (+ fixture-setup drift)
    expect(await pool.projectedInterest()).to.be.within(20n * assetDef.unit, 20n * assetDef.unit + 10n ** 15n);
    // totalAssets unchanged: projected interest is NOT a claim
    expect(await pool.totalAssets()).to.equal(assetsBefore);
    // permissionless and idempotent without elapsed time
    const projected = await pool.projectedInterest();
    await pool.connect(lender).accrueInterest();
    // block timestamps may drift a few seconds between txs — negligible accrual
    expect(await pool.projectedInterest()).to.be.lessThan(projected + 10n ** 15n);
  });

  it("updateRateBps is lend-only", async () => {
    const { pool, lend, lender, rando } = await loadFixture(edgeFix);
    await expect(pool.connect(rando).updateRateBps(500)).to.be.revertedWithCustomError(pool, "OnlyLend");
    await expect(pool.connect(lender).updateRateBps(500)).to.be.revertedWithCustomError(pool, "OnlyLend");
    // only the wired lend contract may set it
    await expect(pool.connect(lend).updateRateBps(500)).to.not.be.reverted;
    expect(await pool.rateBps()).to.equal(500n);
  });
});

// ---------------------------------------------------------------------------
// Part B — full ZK integration through VeilLend (debtPools wiring)
// ---------------------------------------------------------------------------

const PRICE = { vCOL: 2n * 10n ** 8n, vDBT: 1n * 10n ** 8n, USDC: 1n * 10n ** 8n };

interface IntegFixture {
  veil: VeilLend;
  pool: LiquidityPool;
  debt: TokenMock;
  col: TokenMock;
  debtDec: number;
  debtUnit: bigint;
  depositAmount: bigint;
  borrowAmount: bigint;
  pushPrices: (ageSecs?: bigint) => Promise<void>;
  owner: HardhatEthersSigner;
  lender: HardhatEthersSigner;
  user: HardhatEthersSigner;
}

async function integFixture(kind: "vDBT" | "USDC"): Promise<IntegFixture> {
  requireZkArtifacts();
  const [owner, lender, user] = await ethers.getSigners();

  const vcol = (await (await ethers.getContractFactory("TokenMock")).deploy("Veil Collateral", "vCOL")) as TokenMock;
  const debt = kind === "vDBT"
    ? ((await (await ethers.getContractFactory("TokenMock")).deploy("Veil Debt", "vDBT")) as unknown as TokenMock)
    : ((await (await ethers.getContractFactory("TokenMock6")).deploy("USD Coin", "USDC")) as unknown as TokenMock);
  const debtDec = kind === "vDBT" ? 18 : 6;
  const debtUnit = debtDec === 18 ? WAD : USD6;
  const colUnit = WAD;

  const mockStork = (await (await ethers.getContractFactory("MockStorkOracle")).deploy(3600, 1)) as unknown as MockStorkOracle;
  const storkAdapter = (await (await ethers.getContractFactory("StorkPriceOracle")).deploy(await mockStork.getAddress())) as unknown as StorkPriceOracle;
  const feedIds: Record<string, string> = {
    vCOL: ethers.id("vCOLUSD"),
    DEBT: kind === "vDBT" ? ethers.id("vDBTUSD") : ethers.id("USDCUSD"),
  };
  await storkAdapter.setFeedId(await vcol.getAddress(), feedIds.vCOL);
  await storkAdapter.setFeedId(await debt.getAddress(), feedIds.DEBT);
  const pushPrices = async (ageSecs = 0n) => {
    const ts = (await chainSecs()) - ageSecs;
    await mockStork.setValue(feedIds.vCOL, PRICE.vCOL * 10n ** 10n, ts * 1_000_000_000n);
    await mockStork.setValue(feedIds.DEBT, (kind === "vDBT" ? PRICE.vDBT : PRICE.USDC) * 10n ** 10n, ts * 1_000_000_000n);
  };
  await pushPrices();

  const verifier = await (await ethers.getContractFactory("Groth16Verifier")).deploy();
  const solvencyVerifier = await (await ethers.getContractFactory("SolvencyVerifier")).deploy();
  const riskVerifier = await (await ethers.getContractFactory("RiskTransitionVerifier")).deploy();
  const liquidationVerifier = await (await ethers.getContractFactory("LiquidationVerifier")).deploy();
  const veil = (await upgrades.deployProxy(
    await ethers.getContractFactory("VeilLend"),
    [owner.address, await verifier.getAddress(), await solvencyVerifier.getAddress(), await riskVerifier.getAddress(), await liquidationVerifier.getAddress(), await storkAdapter.getAddress()],
    { kind: "uups" }
  )) as unknown as VeilLend;

  await veil.connect(owner).enableCollateralAsset(await vcol.getAddress());
  await veil.connect(owner).enableDebtAsset(await debt.getAddress(), {
    baseRateBps: 500, slopeBps: 2000, targetUtilizationBps: 8000,
    reserveFactorBps: 1000, maxLtvBps: 7_500, liquidationThresholdBps: 8_500,
  });

  // wire the asset's own Liquidity Pool into VeilLend
  const pool = (await upgrades.deployProxy(
    await ethers.getContractFactory("LiquidityPool"),
    [await debt.getAddress(), owner.address, await veil.getAddress(), `Veil ${kind} Pool`, `vl${kind}P`],
    { kind: "uups" }
  )) as unknown as LiquidityPool;
  await veil.connect(owner).setDebtPool(await debt.getAddress(), await pool.getAddress());
  expect(await veil.debtPools(await debt.getAddress())).to.equal(await pool.getAddress());

  // keep deposits comfortably inside the 75% LTV cap for the borrow amount
  // (collateral is always vCOL, 18 dec; borrow is the pool's debt asset)
  const depositAmount = kind === "vDBT" ? 10n * colUnit : 20_000n * colUnit;
  const borrowAmount = kind === "vDBT" ? 5n * WAD : 5_000n * USD6;
  for (const s of [lender, user]) {
    await vcol.mint(s.address, 1_000_000n * colUnit);
    await vcol.connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
    await debt.mint(s.address, 1_000_000n * debtUnit);
    await debt.connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
    await debt.connect(s).approve(await pool.getAddress(), ethers.MaxUint256);
  }

  // lender funds the pool (no debtCustody seeding anywhere)
  await debt.connect(lender).approve(await pool.getAddress(), ethers.MaxUint256);
  const poolFunding = kind === "vDBT" ? 100n * WAD : 100_000n * USD6;
  await pool.connect(lender).deposit(poolFunding, lender.address);

  return { veil, pool, debt, col: vcol, debtDec, debtUnit, depositAmount, borrowAmount, pushPrices, owner, lender, user };
}

function toInputs(p: { publicSignals: bigint[] }) {
  const s = p.publicSignals.map((v) => BigInt(v));
  return {
    positionId: s[0], oldCommitment: s[1], newCommitment: s[2], nullifier: s[3],
    actionId: s[4], newSequence: s[5], currentIndexLo: s[6], currentIndexHi: s[7],
    publicAmount: s[8],
  };
}

for (const kind of ["vDBT", "USDC"] as const) {
  const integFix = () => integFixture(kind);
  describe(`VeilLend × LiquidityPool integration — ${kind}`, () => {
    it("create → deposit → borrow (pool-funded) → repay (pool-returned) → lender redeem", async () => {
      const f = await loadFixture(integFix);
      const { veil, pool, debt, col, user } = f;
      const debtAddr = await debt.getAddress();
      const colAddr = await col.getAddress();

      // lender liquidity is idle in the pool before the borrow
      const poolLiquidity0 = await pool.availableLiquidity();
      expect(poolLiquidity0).to.be.greaterThan(f.borrowAmount);

      // ---------- create ----------
      const id = (await veil.nextPositionId()) + 1n;
      let state = makeInitialState({
        positionId: id, collateralAsset: BigInt(colAddr), debtAsset: BigInt(debtAddr),
        currentIndex: await veil.currentDebtIndex(debtAddr),
        controlSecret: BigInt(randHex()), salt: BigInt(randHex()),
      });
      await veil.createPosition(colAddr, debtAddr, bytes32(await computeCommitment(state)));

      // ---------- deposit collateral ----------
      const depT = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: f.depositAmount, currentIndex: await veil.currentDebtIndex(debtAddr), newSalt: BigInt(randHex()) });
      const depP = await generateProof(depT.inputs);
      await veil.connect(user as never).deposit(toInputs(depT), depP.callArgs.pA, depP.callArgs.pB, depP.callArgs.pC);
      state = depT.newState;

      // ---------- borrow: VeilLend pulls from the pool, pays the borrower ----------
      await f.pushPrices();
      const userDebtBefore = await debt.balanceOf(user.address);
      const currentIndexB = await veil.currentDebtIndex(debtAddr);
      const borT = await buildRiskTransition({
        oldState: state, actionId: ACTION_BORROW, amount: f.borrowAmount,
        currentIndex: currentIndexB, newSalt: BigInt(randHex()),
        params: {
          collateralPrice: norm(PRICE.vCOL, 18),
          debtPrice: norm(kind === "vDBT" ? PRICE.vDBT : PRICE.USDC, f.debtDec),
          maxLtvBps: 7500n,
        },
        recipient: BigInt(user.address),
      });
      const borP = await generateProof(borT.inputs, "risk_transition");
      await veil.connect(user as never).borrow(toInputs(borT), borP.callArgs.pA, borP.callArgs.pB, borP.callArgs.pC);
      state = borT.newState;

      expect((await debt.balanceOf(user.address)) - userDebtBefore).to.equal(f.borrowAmount); // paid by the pool
      expect(await veil.borrowOutstanding(id)).to.equal(f.borrowAmount);
      expect(await pool.availableLiquidity()).to.equal(poolLiquidity0 - f.borrowAmount); // decreased
      expect(await pool.totalBorrows()).to.equal(f.borrowAmount);
      // debtCustody untouched — the pool is the funding source
      expect(await veil.debtCustody(debtAddr)).to.equal(0n);
      expect(await debt.balanceOf(await pool.getAddress())).to.equal(poolLiquidity0 - f.borrowAmount);

      // ---------- repay: borrower → VeilLend → pool ----------
      await f.pushPrices();
      const userDebtBeforeRepay = await debt.balanceOf(user.address);
      const currentIndexR = await veil.currentDebtIndex(debtAddr);
      const repT = await buildTransition({ oldState: state, actionId: ACTION_REPAY, amount: f.borrowAmount, currentIndex: currentIndexR, newSalt: BigInt(randHex()) });
      const repP = await generateProof(repT.inputs);
      await veil.connect(user as never).repay(toInputs(repT), repP.callArgs.pA, repP.callArgs.pB, repP.callArgs.pC);
      state = repT.newState;

      expect(userDebtBeforeRepay - (await debt.balanceOf(user.address))).to.equal(f.borrowAmount);
      expect(await veil.borrowOutstanding(id)).to.equal(0n);
      expect(await pool.totalBorrows()).to.equal(0n); // principal returned
      expect(await pool.availableLiquidity()).to.equal(poolLiquidity0); // fully restored
      expect(await veil.debtCustody(debtAddr)).to.equal(0n); // nothing leaked to the legacy reserve

      // ---------- lender redeems ----------
      const shares = await pool.balanceOf(f.lender.address);
      await pool.connect(f.lender as never).redeem(shares, f.lender.address, f.lender.address);
      expect(await debt.balanceOf(f.lender.address)).to.be.greaterThan(1_000_000n * f.debtUnit - poolLiquidity0);
      expect(await pool.totalAssets()).to.equal(0n);
    });

    it("borrow above available pool liquidity fails closed", async () => {
      const f = await loadFixture(integFix);
      const { veil, pool, debt, col, user } = f;
      const debtAddr = await debt.getAddress();
      const colAddr = await col.getAddress();

      // deep collateral so the in-circuit solvency check passes; the failure
      // point must be the POOL's liquidity guard, not the LTV cap
      const bigDeposit = 100_000n * WAD; // vCOL units
      const id = (await veil.nextPositionId()) + 1n;
      let state = makeInitialState({
        positionId: id, collateralAsset: BigInt(colAddr), debtAsset: BigInt(debtAddr),
        currentIndex: await veil.currentDebtIndex(debtAddr),
        controlSecret: BigInt(randHex()), salt: BigInt(randHex()),
      });
      await veil.createPosition(colAddr, debtAddr, bytes32(await computeCommitment(state)));
      const depT = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: bigDeposit, currentIndex: await veil.currentDebtIndex(debtAddr), newSalt: BigInt(randHex()) });
      const depP = await generateProof(depT.inputs);
      await veil.connect(user as never).deposit(toInputs(depT), depP.callArgs.pA, depP.callArgs.pB, depP.callArgs.pC);
      state = depT.newState;

      await f.pushPrices();
      const oversized = await pool.availableLiquidity() + 1n;
      const currentIndexB = await veil.currentDebtIndex(debtAddr);
      const borT = await buildRiskTransition({
        oldState: state, actionId: ACTION_BORROW, amount: oversized,
        currentIndex: currentIndexB, newSalt: BigInt(randHex()),
        params: {
          collateralPrice: norm(PRICE.vCOL, 18),
          debtPrice: norm(kind === "vDBT" ? PRICE.vDBT : PRICE.USDC, f.debtDec),
          maxLtvBps: 7500n,
        },
        recipient: BigInt(user.address),
      });
      const borP = await generateProof(borT.inputs, "risk_transition");
      // LTV cap fires first (deposit value is far below the oversized borrow)
      await expect(
        veil.connect(user as never).borrow(toInputs(borT), borP.callArgs.pA, borP.callArgs.pB, borP.callArgs.pC)
      ).to.be.revertedWithCustomError(pool, "InsufficientPoolLiquidity");
    });
  });
}

// ---------------------------------------------------------------------------
// Part C — full ECONOMIC cycle: real borrower interest through the ZK layer
// (deposit → borrow → time → accrual → repay principal+interest → lender
//  yield → protocol fee claim), all numbers asserted end to end.
// ---------------------------------------------------------------------------

describe("VeilLend × LiquidityPool economics E2E — interest and fees", () => {
  const econFix = () => integFixture("vDBT");

  it("pool rate is synced from VeilLend's borrower accrual config", async () => {
    const f = await loadFixture(econFix);
    // setDebtPool wired the pool → it learned baseRateBps (500 in the fixture)
    expect(await f.pool.rateBps()).to.equal(500n);
    // owner changes the borrower accrual rate → the wired pool follows
    await f.veil.connect(f.owner).setRateConfig(await f.debt.getAddress(), {
      baseRateBps: 650, slopeBps: 2000, targetUtilizationBps: 8000,
      reserveFactorBps: 1000, maxLtvBps: 7_500, liquidationThresholdBps: 8_500,
    });
    expect(await f.pool.rateBps()).to.equal(650n);
  });

  it("deposit → borrow → time → accrue → repay principal+interest → lender yield → fee claim", async () => {
    const f = await loadFixture(econFix);
    const { veil, pool, debt, col, lender, user, owner } = f;
    const debtAddr = await debt.getAddress();
    const colAddr = await col.getAddress();
    const WAD_ = 10n ** 18n;

    // 10% protocol fee on realized interest
    await pool.connect(owner).configurePool(1_000, owner.address);
    // lender tops up the pool (fixture already deposited 100 WAD)
    await debt.connect(lender).approve(await pool.getAddress(), ethers.MaxUint256);
    await pool.connect(lender).deposit(1000n * WAD_, lender.address);
    const lenderShares = await pool.balanceOf(lender.address);

    // ---------- borrower: create + deposit collateral ----------
    const id = (await veil.nextPositionId()) + 1n;
    const idx0 = await veil.currentDebtIndex(debtAddr);
    let state = makeInitialState({
      positionId: id, collateralAsset: BigInt(colAddr), debtAsset: BigInt(debtAddr),
      currentIndex: idx0, controlSecret: BigInt(randHex()), salt: BigInt(randHex()),
    });
    await veil.createPosition(colAddr, debtAddr, bytes32(await computeCommitment(state)));
    const depT = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: f.depositAmount, currentIndex: idx0, newSalt: BigInt(randHex()) });
    const depP = await generateProof(depT.inputs);
    await veil.connect(user as never).deposit(toInputs(depT), depP.callArgs.pA, depP.callArgs.pB, depP.callArgs.pC);
    state = depT.newState;

    // ---------- borrow 5 vDBT from the pool ----------
    await f.pushPrices();
    const borrowAmount = 5n * WAD_;
    const idxB = await veil.currentDebtIndex(debtAddr);
    const borT = await buildRiskTransition({
      oldState: state, actionId: ACTION_BORROW, amount: borrowAmount,
      currentIndex: idxB, newSalt: BigInt(randHex()),
      params: { collateralPrice: norm(PRICE.vCOL, 18), debtPrice: norm(PRICE.vDBT, 18), maxLtvBps: 7500n },
      recipient: BigInt(user.address),
    });
    const borP = await generateProof(borT.inputs, "risk_transition");
    await veil.connect(user as never).borrow(toInputs(borT), borP.callArgs.pA, borP.callArgs.pB, borP.callArgs.pC);
    state = borT.newState;
    expect(await pool.totalBorrows()).to.equal(borrowAmount);

    // ---------- time passes → borrower interest accrues (public index) ----------
    await time.increase(365n * 24n * 60n * 60n);
    await veil.accrueInterest(debtAddr);
    const idx1 = await veil.currentDebtIndex(debtAddr);
    expect(idx1).to.be.greaterThan(idxB);
    // full repayment amount per the circuit: ceil(debt × currentIndex / oldIndex)
    const repayAmount = ((borrowAmount * idx1) + idxB - 1n) / idxB;
    const interest = repayAmount - borrowAmount;
    expect(interest).to.be.greaterThan(2n * 10n ** 17n); // ≈5% of 5 units = 0.25
    expect(interest).to.be.lessThan(3n * 10n ** 17n);

    // ---------- repay principal + interest through the ZK layer ----------
    await f.pushPrices();
    const repT = await buildTransition({ oldState: state, actionId: ACTION_REPAY, amount: repayAmount, currentIndex: idx1, newSalt: BigInt(randHex()) });
    const repP = await generateProof(repT.inputs);
    await veil.connect(user as never).repay(toInputs(repT), repP.callArgs.pA, repP.callArgs.pB, repP.callArgs.pC);
    state = repT.newState;

    // ---------- pool economics: only ACTUALLY paid interest is realized ----------
    expect(await pool.totalBorrows()).to.equal(0n);
    const fee = (interest * 1000n) / 10000n;           // 10% of interest
    const toLenders = interest - fee;
    expect(await pool.accruedFees()).to.equal(fee);
    // lender share value grew by the interest net of the fee — and ONLY that
    const underlyingAfter = await pool.convertToAssets(lenderShares);
    const underlyingDelta = underlyingAfter - 1100n * WAD_; // 1100 deposited
    expect(underlyingDelta).to.be.within(toLenders - 10n, toLenders + 10n);
    // projected interest (rate model) stays informational: totalAssets = deposits + realized − fees
    expect(await pool.totalAssets()).to.equal(1100n * WAD_ + toLenders);

    // ---------- lender exits with the yield ----------
    await pool.connect(lender as never).redeem(lenderShares, lender.address, lender.address);
    const lenderOut = await debt.balanceOf(lender.address);
    // minted 1M, deposited 1100 total into the pool, redeemed it all back + yield
    expect(lenderOut).to.be.greaterThan(1_000_000n * WAD_ + toLenders - 100n);
    expect(lenderOut).to.be.lessThan(1_000_000n * WAD_ + toLenders + 100n);

    // ---------- protocol claims the fee ----------
    const feeBefore = await debt.balanceOf(owner.address);
    await pool.connect(owner).claimFees();
    expect((await debt.balanceOf(owner.address)) - feeBefore).to.equal(fee);
    expect(await pool.accruedFees()).to.equal(0n);
  });
});
