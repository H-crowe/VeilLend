import { ethers, upgrades, network } from "hardhat";
import fs from "fs";
import path from "path";

/**
 * FINALIZED UUPS upgrade — upgrades ALL THREE live proxies to the current
 * implementations in one execution:
 *
 *   1. VeilLend proxy            → current VeilLend implementation
 *      (debtPools + corrected repay/liquidation accounting +
 *       settleOrphanPosition; WETH config already cleared on-chain)
 *   2. vDBT LiquidityPool proxy  → current LiquidityPool implementation
 *      (explicit principal/interest onRepayment + writeOffBorrows)
 *   3. USDC LiquidityPool proxy  → same LiquidityPool implementation
 *
 * Per proxy: (read) ERC-1967 slot + (read) validateUpgrade + (WRITE) upgrade.
 * Proxy addresses are preserved. No mint, no token transfer, no funding, no
 * setDebtPool, no custody movement — implementation code only.
 *
 * Usage:
 *   npx hardhat run scripts/upgrade-all.ts --network horizenTestnet
 */

const DEPLOYMENTS_FILE = path.join(__dirname, "..", "deployments", "horizenTestnet-uups.json");
const POOLS_FILE = path.join(__dirname, "..", "deployments", "liquidity-pools-horizenTestnet.json");
const ERC1967_IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";

const VEILLEND_PROXY = "0xc1e2cDADBf14717DfEE7ffA23EAf2b21e6004a5B";
const VDBT_POOL_PROXY = "0x21Cf3FFE0FF3ccf422c89A0A55fCE1949C84fB57";
const USDC_POOL_PROXY = "0xf406448E519345C9D8bc08B606DaB677Cb12aCC1";

const VDBT_ASSET = "0xe48a8EC02EB14BB52Fe363D3B2A32e264d3B5D7f";
const USDC_ASSET = "0x01c7AEb2A0428b4159c0E333712f40e127aF639E";

async function readImpl(provider: { getStorage(address: string, slot: string): Promise<string> }, proxy: string): Promise<string> {
  const raw = await provider.getStorage(proxy, ERC1967_IMPL_SLOT);
  return ethers.getAddress("0x" + raw.slice(-40));
}

async function main() {
  const dep = JSON.parse(fs.readFileSync(DEPLOYMENTS_FILE, "utf8"));
  const pools = JSON.parse(fs.readFileSync(POOLS_FILE, "utf8"));
  if (dep.addresses.veilLend.toLowerCase() !== VEILLEND_PROXY.toLowerCase()) {
    throw new Error(`config proxy ${dep.addresses.veilLend} does not match target ${VEILLEND_PROXY}`);
  }
  const canonical = Object.fromEntries((pools.canonicalPools ?? []).map((p: { label: string; proxy: string }) => [p.label, p.proxy]));
  if ((canonical["vDBT Pool"] ?? "").toLowerCase() !== VDBT_POOL_PROXY.toLowerCase() ||
      (canonical["USDC Pool"] ?? "").toLowerCase() !== USDC_POOL_PROXY.toLowerCase()) {
    throw new Error("pool record does not match the canonical pool addresses");
  }

  console.log(`network: ${network.name} (chainId ${network.config.chainId})`);

  // ---------- 1. VeilLend ----------
  console.log(`\n[1/3] VeilLend proxy: ${VEILLEND_PROXY}`);
  const currentVeilImpl = await readImpl(ethers.provider, VEILLEND_PROXY);
  console.log(`  current impl: ${currentVeilImpl}`);
  const veilFactory = await ethers.getContractFactory("VeilLend");
  await upgrades.validateUpgrade(currentVeilImpl, veilFactory, { kind: "uups" });
  console.log("  validateUpgrade: PASS");
  const veilUpgraded = await upgrades.upgradeProxy(VEILLEND_PROXY, veilFactory, { kind: "uups" });
  await veilUpgraded.waitForDeployment();
  const newVeilImpl = await readImpl(ethers.provider, VEILLEND_PROXY);
  console.log(`  UPGRADED. new impl: ${newVeilImpl}`);

  // ---------- 2. vDBT LiquidityPool ----------
  console.log(`\n[2/3] vDBT LiquidityPool proxy: ${VDBT_POOL_PROXY}`);
  const currentVdbtImpl = await readImpl(ethers.provider, VDBT_POOL_PROXY);
  console.log(`  current impl: ${currentVdbtImpl}`);
  const poolFactory = await ethers.getContractFactory("LiquidityPool");
  await upgrades.validateUpgrade(currentVdbtImpl, poolFactory, { kind: "uups" });
  console.log("  validateUpgrade: PASS");
  const vdbtUpgraded = await upgrades.upgradeProxy(VDBT_POOL_PROXY, poolFactory, { kind: "uups" });
  await vdbtUpgraded.waitForDeployment();
  const newVdbtImpl = await readImpl(ethers.provider, VDBT_POOL_PROXY);
  console.log(`  UPGRADED. new impl: ${newVdbtImpl}`);

  // ---------- 3. USDC LiquidityPool ----------
  console.log(`\n[3/3] USDC LiquidityPool proxy: ${USDC_POOL_PROXY}`);
  const currentUsdcImpl = await readImpl(ethers.provider, USDC_POOL_PROXY);
  console.log(`  current impl: ${currentUsdcImpl}`);
  await upgrades.validateUpgrade(currentUsdcImpl, poolFactory, { kind: "uups" });
  console.log("  validateUpgrade: PASS");
  const usdcUpgraded = await upgrades.upgradeProxy(USDC_POOL_PROXY, poolFactory, { kind: "uups" });
  await usdcUpgraded.waitForDeployment();
  const newUsdcImpl = await readImpl(ethers.provider, USDC_POOL_PROXY);
  console.log(`  UPGRADED. new impl: ${newUsdcImpl}`);

  // ---------- post-upgrade verification (read-only) ----------
  console.log("\n--- post-upgrade verification ---");
  const veilView = new ethers.Contract(VEILLEND_PROXY, [
    "function owner() view returns (address)",
    "function debtPools(address) view returns (address)",
  ], ethers.provider);
  const poolViewAbi = [
    "function totalBorrows() view returns (uint256)",
    "function totalAssets() view returns (uint256)",
    "function availableLiquidity() view returns (uint256)",
    "function owner() view returns (address)",
  ];
  const vdbtView = new ethers.Contract(VDBT_POOL_PROXY, poolViewAbi, ethers.provider);
  const usdcView = new ethers.Contract(USDC_POOL_PROXY, poolViewAbi, ethers.provider);
  console.log("veil.owner:", await veilView.owner());
  console.log("debtPools[vDBT]:", await veilView.debtPools(VDBT_ASSET));
  console.log("debtPools[USDC]:", await veilView.debtPools(USDC_ASSET));
  console.log("vDBT pool: borrows", (await vdbtView.totalBorrows()).toString(),
    "| assets", (await vdbtView.totalAssets()).toString(),
    "| liquidity", (await vdbtView.availableLiquidity()).toString());
  console.log("USDC pool: borrows", (await usdcView.totalBorrows()).toString(),
    "| assets", (await usdcView.totalAssets()).toString(),
    "| liquidity", (await usdcView.availableLiquidity()).toString());

  // ---------- persist the new implementation addresses ----------
  dep.addresses.veilLendImplementation = newVeilImpl;
  dep.deploymentLog.push({
    label: "UUPS upgrade: VeilLend → pool-accounting implementation",
    txHash: veilUpgraded.deploymentTransaction()?.hash ?? "",
  });
  fs.writeFileSync(DEPLOYMENTS_FILE, JSON.stringify(dep, null, 2) + "\n");

  pools.implementation = newVdbtImpl;
  pools.usdcPoolImplementation = newUsdcImpl;
  pools.upgradeLog = [
    { proxy: VDBT_POOL_PROXY, txHash: vdbtUpgraded.deploymentTransaction()?.hash ?? "" },
    { proxy: USDC_POOL_PROXY, txHash: usdcUpgraded.deploymentTransaction()?.hash ?? "" },
  ];
  fs.writeFileSync(POOLS_FILE, JSON.stringify(pools, null, 2) + "\n");
  console.log("\nupgrade records updated.");
}

main().catch((e) => {
  console.error("upgrade failed:", e);
  process.exitCode = 1;
});
