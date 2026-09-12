import { ethers, network } from "hardhat";
import fs from "fs";
import path from "path";

/**
 * Wires the deployed LiquidityPools into VeilLend (owner-only setDebtPool)
 * and configures pool economics (owner-only configurePool: fee on realized
 * interest + fee recipient; the borrower RATE is synced automatically by
 * VeilLend's rate-sync mechanism, never set here).
 */
const VL = "0xc1e2cDADBf14717DfEE7ffA23EAf2b21e6004a5B";
const WIRING: Array<{ asset: string; pool: string; label: string }> = [
  { asset: "0xe48a8EC02EB14BB52Fe363D3B2A32e264d3B5D7f", pool: "0x21Cf3FFE0FF3ccf422c89A0A55fCE1949C84fB57", label: "vDBT" },
  { asset: "0x01c7AEb2A0428b4159c0E333712f40e127aF639E", pool: "0xf406448E519345C9D8bc08B606DaB677Cb12aCC1", label: "USDC" },
];
const FEE_BPS = 1000n; // 10% of REALIZED interest only (Testnet economics)
const FEE_RECIPIENT = "0x1725a9Ba5E788Ac73AE7f14a2C976DB462c5F204"; // testnet owner/treasury

const VL_ABI = [
  "function setDebtPool(address asset, address pool) external",
  "function debtPools(address) view returns (address)",
  "function debtSupported(address) view returns (bool)",
  "function rateConfigs(address) view returns (uint64,uint64,uint64,uint64,uint64,uint64)",
  "function owner() view returns (address)",
];
const POOL_ABI = [
  "function configurePool(uint256 feeBps_, address feeRecipient_) external",
  "function rateBps() view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function feeRecipient() view returns (address)",
  "function owner() view returns (address)",
  "function asset() view returns (address)",
];

async function main() {
  const [signer] = await ethers.getSigners();
  const veil = new ethers.Contract(VL, VL_ABI, signer);
  if ((await veil.owner()) !== signer.address) throw new Error("caller is not VeilLend owner");

  for (const w of WIRING) {
    const before = await veil.debtPools(w.asset);
    if (before.toLowerCase() === w.pool.toLowerCase()) { console.log(`${w.label}: already wired`); }
    else {
      if (!(await veil.debtSupported(w.asset))) throw new Error(`${w.label} not debt-supported`);
      const tx = await veil.setDebtPool(w.asset, w.pool);
      const r = await tx.wait();
      if (r.status !== 1) throw new Error(`${w.label} setDebtPool reverted`);
      console.log(`${w.label}: setDebtPool tx ${tx.hash} | block ${r.blockNumber} | gas ${r.gasUsed.toString()}`);
    }
    const pool = new ethers.Contract(w.pool, POOL_ABI, signer);
    if ((await pool.asset()).toLowerCase() !== w.asset.toLowerCase()) throw new Error(`${w.label} pool asset mismatch!`);
    if ((await pool.owner()) !== signer.address) throw new Error(`${w.label} pool owner mismatch!`);
    // rate must already be synced by setDebtPool
    const rate = await pool.rateBps();
    const cfg = await veil.rateConfigs(w.asset);
    if (rate !== cfg[0]) throw new Error(`${w.label} rate sync failed: pool ${rate} != veillend ${cfg[0]}`);
    console.log(`${w.label}: rate synced = ${rate} bps`);

    const poolSigner = pool.connect(signer) as {
      feeBps(): Promise<bigint>;
      feeRecipient(): Promise<string>;
      configurePool(feeBps_: bigint, feeRecipient_: string): Promise<any>;
    } & typeof pool;
    if ((await poolSigner.feeBps()) === 0n) {
      const tx = await poolSigner.configurePool(FEE_BPS, FEE_RECIPIENT);
      const r = await tx.wait();
      if (r.status !== 1) throw new Error(`${w.label} configurePool reverted`);
      console.log(`${w.label}: configurePool tx ${tx.hash} | block ${r.blockNumber} | feeBps=${FEE_BPS} recipient=${FEE_RECIPIENT}`);
    } else {
      console.log(`${w.label}: already configured (feeBps=${await poolSigner.feeBps()})`);
    }
    console.log(`${w.label}: final debtPools=${await veil.debtPools(w.asset)} | feeRecipient=${await poolSigner.feeRecipient()}`);
  }

  // persist wiring into the deployment record
  const recFile = path.join(__dirname, "..", "deployments", `liquidity-pools-${network.name}.json`);
  const rec = JSON.parse(fs.readFileSync(recFile, "utf8"));
  rec.wiring = { setDebtPool: "done", feeBps: FEE_BPS, feeRecipient: FEE_RECIPIENT };
  rec.pools = Object.fromEntries(WIRING.map((w) => [w.label, w.pool]));
  fs.writeFileSync(recFile, JSON.stringify(rec, null, 2) + "\n");
  console.log("wiring record updated");
}

main().catch((e) => { console.error("FAILED:", e); process.exitCode = 1; });
