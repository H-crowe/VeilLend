/**
 * VeilLend — Horizen Testnet deployment (M1).
 *
 * Deploys the full stack to the Horizen Testnet (chainId 2651420):
 *   TokenMock (collateral) + TokenMock (debt)   [TEST-ONLY mock ERC20s]
 *   MockPriceOracle                              [TEST-ONLY placeholder oracle]
 *   4 × Groth16 verifiers (state / solvency / risk / liquidation)
 *   VeilLend (wired to the verifiers + oracle)
 * then runs the protocol configuration (assets, rates, staleness).
 *
 * NOT executed as part of this step — run explicitly with:
 *   npx hardhat run scripts/deploy.ts --network horizenTestnet
 *
 * Requires ZK artifacts (npm run zk:build) and HORIZEN_TESTNET_PRIVATE_KEY
 * in .env funded with testnet ETH.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import { requireZkArtifacts } from "./prove";

const EXPECTED_CHAIN_ID = 2651420n; // Horizen Testnet

/** Per-debt-asset risk configuration used for the testnet deployment. */
const RATE = {
  baseRateBps: 500,
  slopeBps: 2000,
  targetUtilizationBps: 8000,
  reserveFactorBps: 1000,
  maxLtvBps: 7_500,
  liquidationThresholdBps: 8_500,
};

/** Deployment log entry: address + tx hash + block + gas cost. */
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
  return contract;
}

async function txLogged(label: string, txPromise: Promise<ethers.ContractTransactionResponse>) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  deployLog.push({ label, txHash: tx.hash, block: String(receipt?.blockNumber), gasUsed: receipt?.gasUsed.toString() });
}

async function main() {
  requireZkArtifacts();

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) {
    throw new Error(`Wrong network: connected to chainId ${network.chainId}, expected ${EXPECTED_CHAIN_ID}. Use --network horizenTestnet.`);
  }
  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No deployer account — set HORIZEN_TESTNET_PRIVATE_KEY in .env");

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Network   : Horizen Testnet (chainId", network.chainId.toString() + ")");
  console.log("Deployer  :", deployer.address);
  console.log("Balance   :", (Number(balance) / 1e18).toFixed(6), "ETH");
  if (balance === 0n) throw new Error("Deployer has no funds");

  const addresses: Record<string, string> = {};

  // --- TEST-ONLY mock assets + oracle (placeholders until real assets/oracle) ---
  const tokenFactory = await ethers.getContractFactory("TokenMock");
  const collateral = await deployLogged("TokenMock (collateral)", tokenFactory.deploy("VeilLend Test Collateral", "vCOL"));
  addresses.collateralToken = await collateral.getAddress();
  console.log("TokenMock (collateral) :", addresses.collateralToken);

  const debt = await deployLogged("TokenMock (debt)", tokenFactory.deploy("VeilLend Test Debt", "vDBT"));
  addresses.debtToken = await debt.getAddress();
  console.log("TokenMock (debt)       :", addresses.debtToken);

  const oracle = await deployLogged("MockPriceOracle", (await ethers.getContractFactory("MockPriceOracle")).deploy());
  addresses.mockPriceOracle = await oracle.getAddress();
  console.log("MockPriceOracle        :", addresses.mockPriceOracle);

  // --- Groth16 verifiers ---
  const verifier = await deployLogged("Groth16Verifier", (await ethers.getContractFactory("Groth16Verifier")).deploy());
  addresses.stateTransitionVerifier = await verifier.getAddress();
  console.log("Groth16Verifier        :", addresses.stateTransitionVerifier);

  const solvencyVerifier = await deployLogged("SolvencyVerifier", (await ethers.getContractFactory("SolvencyVerifier")).deploy());
  addresses.solvencyVerifier = await solvencyVerifier.getAddress();
  console.log("SolvencyVerifier       :", addresses.solvencyVerifier);

  const riskVerifier = await deployLogged("RiskTransitionVerifier", (await ethers.getContractFactory("RiskTransitionVerifier")).deploy());
  addresses.riskTransitionVerifier = await riskVerifier.getAddress();
  console.log("RiskTransitionVerifier :", addresses.riskTransitionVerifier);

  const liquidationVerifier = await deployLogged("LiquidationVerifier", (await ethers.getContractFactory("LiquidationVerifier")).deploy());
  addresses.liquidationVerifier = await liquidationVerifier.getAddress();
  console.log("LiquidationVerifier    :", addresses.liquidationVerifier);

  // --- Protocol ---
  const veilFactory = await ethers.getContractFactory("VeilLend");
  const veil = await deployLogged(
    "VeilLend",
    veilFactory.deploy(
      deployer.address,
      addresses.stateTransitionVerifier,
      addresses.solvencyVerifier,
      addresses.riskTransitionVerifier,
      addresses.liquidationVerifier,
      addresses.mockPriceOracle
    )
  );
  addresses.veilLend = await veil.getAddress();
  console.log("VeilLend               :", addresses.veilLend);

  // --- Configuration ---
  console.log("\nConfiguring protocol…");
  await txLogged("enableCollateralAsset", veil.enableCollateralAsset(addresses.collateralToken));
  await txLogged("enableDebtAsset", veil.enableDebtAsset(addresses.debtToken, RATE));
  await txLogged("oracle.setPrice(collateral)", oracle.setPrice(addresses.collateralToken, 2_000n * 10n ** 8n));
  await txLogged("oracle.setPrice(debt)", oracle.setPrice(addresses.debtToken, 10n ** 8n));
  console.log("Assets enabled, oracle seeded, maxPriceStaleness = 1h (default)");

  // sanity: on-chain state matches expectations
  expectEqual(await veil.verifier(), addresses.stateTransitionVerifier, "state verifier");
  expectEqual(await veil.solvencyVerifier(), addresses.solvencyVerifier, "solvency verifier");
  expectEqual(await veil.riskVerifier(), addresses.riskTransitionVerifier, "risk verifier");
  expectEqual(await veil.liquidationVerifier(), addresses.liquidationVerifier, "liquidation verifier");
  expectEqual(await veil.debtSupported(addresses.debtToken), true, "debt asset supported");
  expectEqual(await veil.currentDebtIndex(addresses.debtToken), 10n ** 18n, "initial debt index");

  const outDir = path.join(__dirname, "..", "deployments");
  fs.mkdirSync(outDir, { recursive: true });
  const outFile = path.join(outDir, "horizenTestnet.json");
  fs.writeFileSync(
    outFile,
    JSON.stringify({ network: "horizenTestnet", chainId: EXPECTED_CHAIN_ID.toString(), deployer: deployer.address, deployedAt: new Date().toISOString(), addresses, deploymentLog: deployLog }, null, 2) + "\n"
  );
  console.log("\n=== deployment log (tx hash / block / gas) ===");
  for (const e of deployLog) {
    console.log(`${e.label}: addr=${e.address ?? "-"} tx=${e.txHash} block=${e.block} gas=${e.gasUsed}`);
  }
  console.log("\nAddress book written to", outFile);
  console.log("DEPLOYMENT COMPLETE");
}

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = typeof actual === "bigint" ? actual.toString() : String(actual);
  const e = typeof expected === "bigint" ? expected.toString() : String(expected);
  if (a !== e) throw new Error(`Post-deploy check FAILED for ${label}: ${a} !== ${e}`);
  console.log(`  ✓ ${label}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
