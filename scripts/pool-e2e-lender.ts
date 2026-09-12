import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

/**
 * Lender-side pool E2E on the live deployment: mint test tokens → approve →
 * supply to each pool. Borrows are then funded by these pools (verified by
 * scripts/e2e-uups.ts borrower flow). Testnet mocks — minting is the
 * established testnet pattern; custody funds stay untouched.
 */
const VL = "0xc1e2cDADBf14717DfEE7ffA23EAf2b21e6004a5B";
const POOLS: Record<string, string> = {
  vDBT: "0x21Cf3FFE0FF3ccf422c89A0A55fCE1949C84fB57",
  USDC: "0xf406448E519345C9D8bc08B606DaB677Cb12aCC1",
};
const ASSETS: Record<string, { address: string; decimals: number; mint: bigint }> = {
  vDBT: { address: "0xe48a8EC02EB14BB52Fe363D3B2A32e264d3B5D7f", decimals: 18, mint: 100n * 10n ** 18n },
  USDC: { address: "0x01c7AEb2A0428b4159c0E333712f40e127aF639E", decimals: 6, mint: 2000n * 10n ** 6n },
};
const TOKEN_ABI = ["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)", "function allowance(address,address) view returns (uint256)"];
const POOL_ABI = ["function deposit(uint256,address) returns (uint256)", "function balanceOf(address) view returns (uint256)", "function totalAssets() view returns (uint256)", "function availableLiquidity() view returns (uint256)", "function totalBorrows() view returns (uint256)", "function convertToAssets(uint256) view returns (uint256)", "function rateBps() view returns (uint256)", "function feeBps() view returns (uint256)"];

async function main() {
  const [signer] = await ethers.getSigners();
  console.log("lender:", signer.address);
  for (const [sym, cfg] of Object.entries(ASSETS)) {
    const poolAddr = POOLS[sym];
    const token = new ethers.Contract(cfg.address, TOKEN_ABI, signer);
    const pool = new ethers.Contract(poolAddr, POOL_ABI, signer);
    console.log(`--- ${sym} pool ---`);
    if ((await token.balanceOf(signer.address)) < cfg.mint) {
      const t = await token.mint(signer.address, cfg.mint);
      await t.wait();
      console.log(`  mint ${sym}: ${t.hash}`);
    }
    if ((await token.allowance(signer.address, poolAddr)) < cfg.mint) {
      const t = await token.approve(poolAddr, 2n ** 256n - 1n);
      await t.wait();
      console.log(`  approve pool: ${t.hash}`);
    }
    const sharesBefore = await pool.balanceOf(signer.address);
    const t2 = await pool.deposit(cfg.mint, signer.address);
    const r2 = await t2.wait();
    if (r2.status !== 1) throw new Error(`${sym} deposit reverted`);
    const shares = (await pool.balanceOf(signer.address)) - sharesBefore;
    console.log(`  deposit ${t2.hash} | block ${r2.blockNumber} | ${sym} deposited=${cfg.mint} shares minted=${shares}`);
    console.log(`  pool after: totalAssets=${await pool.totalAssets()} liquidity=${await pool.availableLiquidity()} borrows=${await pool.totalBorrows()} rate=${await pool.rateBps()} fee=${await pool.feeBps()}`);
  }
  console.log("LENDER SUPPLY COMPLETE");
}

main().catch((e) => { console.error("FAILED:", e); process.exitCode = 1; });
