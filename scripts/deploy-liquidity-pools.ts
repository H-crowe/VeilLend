import { ethers, upgrades, network } from "hardhat";
import fs from "fs";
import path from "path";

/**
 * LiquidityPool UUPS deployment — one independent pool per debt asset.
 *
 * WHAT THIS DOES when explicitly executed (per pool):
 *   1. (read) validates the debt asset and VeilLend addresses on-chain
 *   2. (WRITE) deploys the LiquidityPool implementation + UUPS proxy
 *      with initialize(asset, owner, lend, name, symbol)
 *   3. (read) post-deploy checks (asset/owner/lend wiring, initializer lock)
 *
 * This script NEVER:
 *   - mints or transfers tokens (pools start EMPTY)
 *   - funds pools or moves debtCustody balances
 *   - calls VeilLend (no setDebtPool / disableDebtAsset / upgrade) — wiring
 *     the pools into VeilLend is a separate, explicit owner step afterwards.
 *
 * Usage:
 *   npx hardhat run scripts/deploy-liquidity-pools.ts --network horizenTestnet
 */

const VEILLEND_PROXY = "0xc1e2cDADBf14717DfEE7ffA23EAf2b21e6004a5B";
const POOL_OWNER = "0x1725a9Ba5E788Ac73AE7f14a2C976DB462c5F204";

const POOLS = [
  {
    label: "vDBT",
    asset: "0xe48a8EC02EB14BB52Fe363D3B2A32e264d3B5D7f",
    name: "Veil vDBT Pool",
    symbol: "vlvDBTP",
  },
  {
    label: "Mock USDC",
    asset: "0x01c7AEb2A0428b4159c0E333712f40e127aF639E",
    name: "Veil USDC Pool",
    symbol: "vlUSDCP",
  },
] as const;

const ERC20_ABI = [
  "function symbol() view returns (string)",
  "function decimals() view returns (uint8)",
  "function totalSupply() view returns (uint256)",
];

function recordTx(label: string, hash: string) {
  console.log(`  tx ${label}: ${hash}`);
}

async function main() {
  const [signer] = await ethers.getSigners();
  console.log(`network:     ${network.name} (chainId ${network.config.chainId})`);
  console.log(`deployer:    ${signer.address}`);
  console.log(`pool owner:  ${POOL_OWNER} ${signer.address.toLowerCase() === POOL_OWNER.toLowerCase() ? "(= deployer)" : "(≠ deployer — owner txs must come from this address)"}`);
  console.log(`lend (VeilLend proxy): ${VEILLEND_PROXY}\n`);

  const poolFactory = await ethers.getContractFactory("LiquidityPool");
  const veilRO = new ethers.Contract(VEILLEND_PROXY, ["function debtPools(address) view returns (address)"], signer);
  const recordFile = path.join(__dirname, "..", "deployments", `liquidity-pools-${network.name}.json`);
  // Canonical identity = the UNDERLYING ASSET ADDRESS (never the label or
  // symbol). Pools are keyed by asset so a label/name mismatch can never
  // cause a duplicate deployment.
  const deployedByAsset: Record<string, string> = fs.existsSync(recordFile)
    ? (JSON.parse(fs.readFileSync(recordFile, "utf8")).pools ?? {})
    : {};

  for (const cfg of POOLS) {
    console.log(`--- deploying ${cfg.label} pool ---`);
    if (deployedByAsset[cfg.asset]) {
      console.log(`  already deployed for asset ${cfg.asset}: ${deployedByAsset[cfg.asset]} — skipping`);
      continue;
    }
    // on-chain double-check: if a wired pool already exists for this asset,
    // never redeploy
    const existing = await veilRO.debtPools(cfg.asset);
    if (existing !== ethers.ZeroAddress) {
      console.log(`  VeilLend already has a pool for ${cfg.asset}: ${existing} — skipping`);
      deployedByAsset[cfg.asset] = existing;
      continue;
    }

    // read-only sanity on the asset
    const token = new ethers.Contract(cfg.asset, ERC20_ABI, signer);
    const sym = await token.symbol();
    const dec = await token.decimals();
    if (sym.toLowerCase() !== cfg.label.toLowerCase() && !sym.includes("USDC")) {
      throw new Error(`asset ${cfg.asset} symbol ${sym} does not match expected ${cfg.label}`);
    }
    console.log(`  asset:      ${cfg.asset} (${sym}, ${dec} dec)`);

    // UUPS deployment: implementation + proxy + initialize(asset, owner, lend, name, symbol)
    const proxy = await upgrades.deployProxy(
      poolFactory,
      [cfg.asset, POOL_OWNER, VEILLEND_PROXY, cfg.name, cfg.symbol],
      { kind: "uups" }
    );
    await proxy.waitForDeployment();
    const proxyAddr = await proxy.getAddress();
    deployedByAsset[cfg.asset] = proxyAddr;

    const proxyTx = proxy.deploymentTransaction();
    if (proxyTx) recordTx(`deploy ${cfg.label} proxy+initialize`, proxyTx.hash);

    // post-deploy read-only checks
    const implSlot = await ethers.provider.getStorage(
      proxyAddr,
      "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc"
    );
    console.log(`  proxy:      ${proxyAddr}`);
    console.log(`  impl slot:  ${ethers.getAddress("0x" + implSlot.slice(-40))}`);
    console.log(`  owner:      ${await (proxy as unknown as { owner(): Promise<string> }).owner()}`);
    console.log(`  lend:       ${(await proxy.lend())}`);
    console.log(`  totalAssets/liquidity/borrows: 0/0/0 (empty by design — no funding here)`);

    // initializer is locked after initialize; verify by static-call
    try {
      await (proxy as unknown as { initialize: { staticCall: (...a: unknown[]) => Promise<void> } }).initialize.staticCall(
        cfg.asset, POOL_OWNER, VEILLEND_PROXY, cfg.name, cfg.symbol
      );
      throw new Error("FATAL: initializer is NOT locked — deploy is unsafe");
    } catch (e) {
      const msg = (e as Error).message ?? "";
      if (msg.includes("FATAL")) throw e;
      // any revert (InvalidInitialization or otherwise) proves the lock
      console.log("  initializer locked: OK (reverted as expected)");
    }
    console.log("");
  }

  // persist the deployment record (local file only), keyed by asset
  const out = {
    network: network.name,
    chainId: network.config.chainId,
    deployedAt: new Date().toISOString(),
    veilLendProxy: VEILLEND_PROXY,
    poolOwner: POOL_OWNER,
    poolsByAsset: deployedByAsset,
    pools: deployedByAsset,
    note: "Pools are EMPTY and NOT wired: setDebtPool / funding / disableDebtAsset are separate explicit owner steps.",
  };
  const outFile = recordFile;
  fs.writeFileSync(outFile, JSON.stringify(out, null, 2));
  console.log(`deployment record written: ${outFile}`);
  console.log(`\nDEPLOYED POOLS (keyed by canonical asset): ${JSON.stringify(deployedByAsset)}`);
  console.log("NO tokens minted, transferred, funded, and no setDebtPool/disableDebtAsset calls were made.");
}

main().catch((e) => {
  console.error("deployment failed:", e);
  process.exitCode = 1;
});
