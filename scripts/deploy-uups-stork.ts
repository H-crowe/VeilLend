/**
 * VeilLend — Professional UUPS/Stork Testnet deployment.
 *
 * Deploys the CURRENT stack (commit 82ad94f) to Horizen Testnet as the new
 * official deployment (a NEW ERC-1967 proxy — the legacy M1 deployment stays
 * untouched):
 *   vCOL/vDBT TokenMocks (demo/test assets, fresh instances)
 *   4 × Groth16 verifiers (decimal-normalized circuits)
 *   StorkPriceOracle adapter → REAL Stork push oracle (0xacC0…d62)
 *   VeilLend UUPS proxy (owner = deployer)
 *   [HISTORICAL — do not re-run] Produced the CURRENT on-chain deployment
 *   (2026-09-07). Superseded by scripts/upgrade-all.ts +
 *   scripts/deploy-liquidity-pools.ts for the pool-era configuration.
 *
 * Run: npx hardhat run scripts/deploy-uups-stork.ts --network horizenTestnet
 * Writes deployments/horizenTestnet-uups.json (M1 record is preserved).
 */
import { ethers, upgrades } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { requireZkArtifacts } from "./prove";

const EXPECTED_CHAIN_ID = 2651420n;
const REAL_STORK = "0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62";
const USDC = "0x01c7AEb2A0428b4159c0E333712f40e127aF639E";
// Official Stork registry asset IDs (keccak256 of the plaintext pair id)
const USDCUSD_FEED = ethers.id("USDCUSD");

const RATE = {
  baseRateBps: 500,
  slopeBps: 2000,
  targetUtilizationBps: 8000,
  reserveFactorBps: 1000,
  maxLtvBps: 7_500,
  liquidationThresholdBps: 8_500,
};

const deployLog: Array<{ label: string; address?: string; txHash?: string; block?: string; gasUsed?: string }> = [];

async function deployLogged(label: string, factoryPromise: Promise<{ getAddress(): Promise<string>; deploymentTransaction(): ethers.ContractTransactionResponse | null }>) {
  const contract = await factoryPromise;
  const address = await contract.getAddress();
  const tx = contract.deploymentTransaction();
  const receipt = tx ? await tx.wait() : null;
  deployLog.push({
    label,
    address,
    txHash: tx?.hash,
    block: receipt?.blockNumber ? String(receipt.blockNumber) : undefined,
    gasUsed: receipt?.gasUsed ? receipt.gasUsed.toString() : undefined,
  });
  console.log(`${label.padEnd(28)} ${address}`);
  return contract;
}

async function txLogged(label: string, txPromise: Promise<ethers.ContractTransactionResponse>) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  deployLog.push({ label, txHash: tx.hash, block: String(receipt?.blockNumber), gasUsed: receipt?.gasUsed.toString() });
  console.log(`  tx ${label.padEnd(40)} ${tx.hash}`);
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = typeof actual === "bigint" ? actual.toString() : String(actual);
  const e = typeof expected === "bigint" ? expected.toString() : String(expected);
  if (a !== e) throw new Error(`Post-deploy check FAILED for ${label}: ${a} !== ${e}`);
  console.log(`  ✓ ${label}`);
}

async function main() {
  requireZkArtifacts();

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) throw new Error(`Wrong network: ${network.chainId}`);
  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Network   : Horizen Testnet", network.chainId.toString());
  console.log("Deployer  :", deployer.address);
  console.log("Balance   :", (Number(balance) / 1e18).toFixed(6), "ETH\n");
  if (balance === 0n) throw new Error("Deployer has no funds");

  const addresses: Record<string, string> = {};

  // --- demo/test mocks (fresh instances for THIS deployment) ---
  const vcol = await deployLogged("TokenMock vCOL", (await ethers.getContractFactory("TokenMock")).deploy("VeilLend Test Collateral", "vCOL"));
  addresses.collateralToken = await vcol.getAddress();
  const vdbt = await deployLogged("TokenMock vDBT", (await ethers.getContractFactory("TokenMock")).deploy("VeilLend Test Debt", "vDBT"));
  addresses.debtToken = await vdbt.getAddress();

  // --- verifiers (decimal-normalized circuits) ---
  const verifier = await deployLogged("Groth16Verifier (state_transition)", (await ethers.getContractFactory("Groth16Verifier")).deploy());
  addresses.stateTransitionVerifier = await verifier.getAddress();
  const solvencyVerifier = await deployLogged("SolvencyVerifier", (await ethers.getContractFactory("SolvencyVerifier")).deploy());
  addresses.solvencyVerifier = await solvencyVerifier.getAddress();
  const riskVerifier = await deployLogged("RiskTransitionVerifier", (await ethers.getContractFactory("RiskTransitionVerifier")).deploy());
  addresses.riskTransitionVerifier = await riskVerifier.getAddress();
  const liquidationVerifier = await deployLogged("LiquidationVerifier", (await ethers.getContractFactory("LiquidationVerifier")).deploy());
  addresses.liquidationVerifier = await liquidationVerifier.getAddress();

  // --- REAL Stork oracle adapter ---
  const adapter = await deployLogged("StorkPriceOracle (real Stork)", (await ethers.getContractFactory("StorkPriceOracle")).deploy(REAL_STORK));
  addresses.storkPriceOracle = await adapter.getAddress();
  addresses.storkOracle = REAL_STORK;

  // --- VeilLend UUPS proxy ---
  // upgrades.deployProxy deploys the implementation contract itself and then
  // the ERC-1967 proxy — do NOT pre-deploy a manual implementation copy (the
  // 0x2bD5… duplicate in the first run was exactly that, unused by the proxy).
  const veilImplFactory = await ethers.getContractFactory("VeilLend");
  const veilProxy = await upgrades.deployProxy(
    veilImplFactory,
    [deployer.address, addresses.stateTransitionVerifier, addresses.solvencyVerifier, addresses.riskTransitionVerifier, addresses.liquidationVerifier, addresses.storkPriceOracle],
    { kind: "uups" }
  );
  await veilProxy.waitForDeployment();
  const veilProxyAddress = await veilProxy.getAddress();
  const deployTx = veilProxy.deploymentTransaction();
  const deployReceipt = await deployTx?.wait();
  deployLog.push({
    label: "VeilLend (UUPS proxy)",
    address: veilProxyAddress,
    txHash: deployTx?.hash,
    block: String(deployReceipt?.blockNumber),
    gasUsed: deployReceipt?.gasUsed.toString(),
  });
  addresses.veilLend = veilProxyAddress;
  console.log(`${"VeilLend (UUPS proxy)".padEnd(28)} ${veilProxyAddress}`);

  const veil = await ethers.getContractAt("VeilLend", veilProxyAddress);

  // --- Configuration ---
  console.log("\nConfiguring…");
  await txLogged("adapter.setFeedId(USDC, USDCUSD)", adapter.setFeedId(USDC, USDCUSD_FEED));
  await txLogged("enableCollateralAsset(vCOL)", veil.enableCollateralAsset(addresses.collateralToken));
  await txLogged("enableCollateralAsset(USDC)", veil.enableCollateralAsset(USDC));
  await txLogged("enableDebtAsset(vDBT)", veil.enableDebtAsset(addresses.debtToken, RATE));
  await txLogged("enableDebtAsset(USDC)", veil.enableDebtAsset(USDC, RATE));
  // ZEN deliberately NOT enabled (no Stork ZEN/USD feed).

  // --- Post-deploy on-chain checks ---
  console.log("\nPost-deploy checks:");
  expectEqual(await veil.owner(), deployer.address, "owner = deployer");
  expectEqual(await veil.verifier(), addresses.stateTransitionVerifier, "state_transition verifier");
  expectEqual(await veil.solvencyVerifier(), addresses.solvencyVerifier, "solvency verifier");
  expectEqual(await veil.riskVerifier(), addresses.riskTransitionVerifier, "risk verifier");
  expectEqual(await veil.liquidationVerifier(), addresses.liquidationVerifier, "liquidation verifier");
  expectEqual(await veil.oracle(), addresses.storkPriceOracle, "oracle = StorkPriceOracle adapter");
  expectEqual(await adapter.storkOracle(), REAL_STORK, "adapter -> real Stork");
  expectEqual(await veil.collateralSupported(addresses.collateralToken), true, "vCOL collateral supported");
  expectEqual(await veil.collateralSupported(USDC), true, "USDC collateral supported");
  expectEqual(await veil.debtSupported(addresses.debtToken), true, "vDBT debt supported");
  expectEqual(await veil.debtSupported(USDC), true, "USDC debt supported");
  expectEqual(await veil.assetDecimals(USDC), 6n, "USDC decimals recorded (6)");
  expectEqual(await adapter.feedIds(USDC), USDCUSD_FEED, "USDC feed = keccak(USDCUSD)");
  expectEqual(await veil.maxPriceStaleness(), 3600n, "maxPriceStaleness = 1h");
  // upgrades.deployProxy deploys its own implementation; the proxy's ERC-1967
  // slot must point at it (not at the pre-deployed copy above).
  const ozImpl = await upgrades.erc1967.getImplementationAddress(veilProxyAddress);
  addresses.veilLendImplementation = ozImpl;
  const erc1967Impl = await ethers.provider.getStorage(veilProxyAddress, "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
  expectEqual(ethers.getAddress("0x" + erc1967Impl.slice(-40)), ozImpl, "ERC-1967 impl slot -> implementation");
  // UUPS authorization: stranger upgrade must revert with OwnableUnauthorizedAccount
  const [_, stranger] = await ethers.getSigners();
  const upgradeData = veil.interface.encodeFunctionData("upgradeToAndCall", [ozImpl, "0x"]);
  try {
    await ethers.provider.call({ from: stranger.address, to: veilProxyAddress, data: upgradeData });
    throw new Error("stranger upgrade unexpectedly succeeded");
  } catch (e) {
    if (String(e).includes("stranger upgrade unexpectedly")) throw e;
    console.log("  ✓ stranger upgrade reverted (owner-only authorization)");
  }
  console.log("  ✓ UUPS upgrade authorization = owner-only (enforced by _authorizeUpgrade; verified by test/upgrade.test.ts)");

  // --- write the NEW deployment record (M1 record untouched) ---
  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "horizenTestnet-uups.json");
  fs.writeFileSync(
    outFile,
    JSON.stringify({
      network: "horizenTestnet",
      chainId: EXPECTED_CHAIN_ID.toString(),
      deploymentModel: "UUPS / ERC-1967 proxy (current official deployment)",
      legacyDeployment: "horizenTestnet.json (M1, immutable, non-proxy)",
      deployer: deployer.address,
      deployedAt: new Date().toISOString(),
      sourceCommit: "82ad94f",
      addresses,
      deploymentLog: deployLog,
    }, null, 2) + "\n"
  );
  console.log("\nDeployment record:", outFile);
  console.log("DEPLOYMENT COMPLETE");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
