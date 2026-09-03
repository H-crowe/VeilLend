/**
 * VeilLend — risk_transition circuit fix deployment (Horizen Testnet only).
 *
 * The corrected risk_transition circuit changes its verification key, and
 * VeilLend wires its verifiers immutably in the constructor (no admin
 * setter). This script therefore:
 *
 *   1. deploys the NEW RiskTransitionVerifier,
 *   2. deploys a NEW VeilLend wired to it, REUSING the existing unchanged
 *      contracts: TokenMock (vCOL/vDBT), MockPriceOracle, Groth16Verifier
 *      (state_transition), SolvencyVerifier, LiquidationVerifier,
 *   3. re-runs the asset/oracle configuration,
 *   4. records the new addresses in deployments/horizenTestnet.json
 *      (previous veilLend + riskTransitionVerifier kept under
 *      "replacedAddresses").
 *
 * Run: npx hardhat run scripts/deploy-riskfix.ts --network horizenTestnet
 */
import { ethers } from "hardhat";
import fs from "fs";
import path from "path";

const EXPECTED_CHAIN_ID = 2651420n; // Horizen Testnet

function expectEqual(actual: unknown, expected: unknown, label: string) {
  const a = typeof actual === "bigint" ? actual.toString() : String(actual);
  const e = typeof expected === "bigint" ? expected.toString() : String(expected);
  if (a !== e) throw new Error(`Post-deploy check FAILED for ${label}: ${a} !== ${e}`);
  console.log(`  ✓ ${label}`);
}

/** Same per-debt-asset risk configuration as the original deployment. */
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
  let block = "", gasUsed = "";
  if (tx) {
    const receipt = await tx.wait();
    block = String(receipt?.blockNumber);
    gasUsed = receipt?.gasUsed.toString() ?? "";
    deployLog.push({ label, address, txHash: tx.hash, block, gasUsed });
    console.log(`${label}: ${address}  tx=${tx.hash} block=${block} gas=${gasUsed}`);
  }
  return contract;
}

async function txLogged(label: string, txPromise: Promise<ethers.ContractTransactionResponse>) {
  const tx = await txPromise;
  const receipt = await tx.wait();
  deployLog.push({ label, txHash: tx.hash, block: String(receipt?.blockNumber), gasUsed: receipt?.gasUsed.toString() });
  console.log(`${label}: tx=${tx.hash} block=${receipt?.blockNumber} gas=${receipt?.gasUsed.toString()}`);
  return receipt;
}

async function main() {
  const chainId = (await ethers.provider.getNetwork()).chainId;
  if (chainId !== EXPECTED_CHAIN_ID) throw new Error(`wrong network: ${chainId} !== ${EXPECTED_CHAIN_ID}`);

  const bookPath = path.join(__dirname, "..", "deployments", "horizenTestnet.json");
  const book = JSON.parse(fs.readFileSync(bookPath, "utf8"));
  const prev = book.addresses;
  console.log("Reusing unchanged deployments:");
  console.log("  vCOL:", prev.collateralToken);
  console.log("  vDBT:", prev.debtToken);
  console.log("  oracle:", prev.mockPriceOracle);
  console.log("  stateTransitionVerifier:", prev.stateTransitionVerifier);
  console.log("  solvencyVerifier:", prev.solvencyVerifier);
  console.log("  liquidationVerifier:", prev.liquidationVerifier);

  const [deployer] = await ethers.getSigners();
  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("Deployer  :", deployer.address, "ETH:", ethers.formatEther(balance));

  // --- 1. new risk verifier (fixed circuit VK)
  const riskVerifier = await deployLogged("RiskTransitionVerifier (fixed gate)", (await ethers.getContractFactory("RiskTransitionVerifier")).deploy());

  // --- 2. new VeilLend wired to the new risk verifier + existing verifiers
  const veil = await deployLogged(
    "VeilLend (risk fix)",
    (await ethers.getContractFactory("VeilLend")).deploy(
      deployer.address,
      prev.stateTransitionVerifier,
      prev.solvencyVerifier,
      await riskVerifier.getAddress(),
      prev.liquidationVerifier,
      prev.mockPriceOracle
    )
  );
  const veilAddress = await veil.getAddress();

  // --- 3. configuration (fresh protocol state)
  console.log("\nConfiguring protocol…");
  const oracle = (await ethers.getContractAt("MockPriceOracle", prev.mockPriceOracle)) as ethers.Contract;
  await txLogged("enableCollateralAsset", (veil as unknown as { enableCollateralAsset(a: string): Promise<ethers.ContractTransactionResponse> }).enableCollateralAsset(prev.collateralToken));
  await txLogged("enableDebtAsset", (veil as unknown as { enableDebtAsset(a: string, c: typeof RATE): Promise<ethers.ContractTransactionResponse> }).enableDebtAsset(prev.debtToken, RATE));
  await txLogged("oracle.setPrice(collateral)", oracle.setPrice(prev.collateralToken, 2_000n * 10n ** 8n));
  await txLogged("oracle.setPrice(debt)", oracle.setPrice(prev.debtToken, 10n ** 8n));

  // --- 4. sanity
  expectEqual(await veil.verifier(), prev.stateTransitionVerifier, "state verifier (reused)");
  expectEqual(await veil.solvencyVerifier(), prev.solvencyVerifier, "solvency verifier (reused)");
  expectEqual(await veil.riskVerifier(), await riskVerifier.getAddress(), "risk verifier (NEW)");
  expectEqual(await veil.liquidationVerifier(), prev.liquidationVerifier, "liquidation verifier (reused)");
  expectEqual(await veil.debtSupported(prev.debtToken), true, "debt asset supported");
  expectEqual(await veil.currentDebtIndex(prev.debtToken), 10n ** 18n, "initial debt index");
  expectEqual(await veil.owner(), deployer.address, "owner");

  // --- 5. address book update (previous addresses preserved)
  book.replacedAddresses = { ...(book.replacedAddresses ?? {}), veilLend: prev.veilLend, riskTransitionVerifier: prev.riskTransitionVerifier };
  book.addresses.riskTransitionVerifier = await riskVerifier.getAddress();
  book.addresses.veilLend = veilAddress;
  book.deployedAt = new Date().toISOString();
  book.deploymentLog = [...(book.deploymentLog ?? []), ...deployLog];
  fs.writeFileSync(bookPath, JSON.stringify(book, null, 2) + "\n");
  console.log("\nAddress book updated:", bookPath);
  console.log("NEW VeilLend            :", veilAddress);
  console.log("NEW RiskTransitionVerifier:", await riskVerifier.getAddress());
  console.log("DEPLOYMENT COMPLETE");
}

main().catch((e) => { console.error(e); process.exit(1); });
