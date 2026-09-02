/**
 * First real Horizen Testnet liquidation proof test.
 *
 * Uses ONLY the existing deployment (deployments/horizenTestnet.json),
 * existing circuits/artifacts, and real Groth16 proofs. No mocks/bypasses.
 *
 * Flow: create position → deposit 100 vCOL (ZK) → seed debt liquidity
 * → borrow 10 vDBT (ZK, recipient-bound) → oracle price drop ($2 → $0.05)
 * → liquidation proof (recipient = Wallet B) → Wallet B executes liquidate
 * → on-chain verification of settlement, custody, replay protection.
 *
 * Private witness values (control secret, salts, full witness) exist only in
 * process memory — never logged or persisted. Wallet B's key lives only in
 * the gitignored .env.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import type { MockPriceOracle, TokenMock, VeilLend } from "../typechain-types";
import {
  ACTION_BORROW,
  ACTION_DEPOSIT,
  buildLiquidationWitness,
  buildRiskTransition,
  buildTransition,
  computeCommitment,
  computeNullifier,
  generateProof,
  makeInitialState,
  requireZkArtifacts,
} from "./prove";

const EXPECTED_CHAIN_ID = 2651420n;
const bytes32 = (v: bigint) => ethers.zeroPadValue(ethers.toBeHex(v), 32);
const WAD = 10n ** 18n;
const PRICE_SCALE = 10n ** 8n;

const log: Array<Record<string, string>> = [];

function entry(o: Record<string, string>) {
  log.push(o);
  return o;
}

async function main() {
  requireZkArtifacts();

  const bookPath = path.join(__dirname, "..", "deployments", "horizenTestnet.json");
  const book = JSON.parse(fs.readFileSync(bookPath, "utf8"));
  const A = book.addresses;

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) throw new Error(`Wrong network: ${network.chainId}`);
  console.log("Network OK: chainId", network.chainId.toString());

  const [walletA] = await ethers.getSigners();
  if (!walletA) throw new Error("Wallet A missing");
  if (walletA.address.toLowerCase() !== "0x1725a9ba5e788ac73ae7f14a2c976db462c5f204") {
    throw new Error(`Unexpected Wallet A: ${walletA.address}`);
  }

  // Wallet B (liquidator) from gitignored env — key never printed
  const liqKey = process.env.HORIZEN_TESTNET_LIQUIDATOR_PRIVATE_KEY;
  if (!liqKey) throw new Error("HORIZEN_TESTNET_LIQUIDATOR_PRIVATE_KEY missing from .env");
  const walletB = new ethers.Wallet(liqKey, ethers.provider);
  console.log("Wallet A (owner)    :", walletA.address);
  console.log("Wallet B (liquidator):", walletB.address);

  // attach to deployed contracts + code checks
  const veil = (await ethers.getContractAt("VeilLend", A.veilLend)) as VeilLend;
  const vcol = (await ethers.getContractAt("TokenMock", A.collateralToken)) as TokenMock;
  const vdbt = (await ethers.getContractAt("TokenMock", A.debtToken)) as TokenMock;
  const oracle = (await ethers.getContractAt("MockPriceOracle", A.mockPriceOracle)) as MockPriceOracle;
  for (const [name, addr] of Object.entries(A)) {
    if ((await ethers.provider.getCode(addr)) === "0x") throw new Error(`No code at ${name}: ${addr}`);
  }
  console.log("✓ all deployed contracts contain code");

  // ---------- funding Wallet B (test-only: ETH gas + vDBT settlement funds) ----------
  const bEth = await ethers.provider.getBalance(walletB.address);
  if (bEth < ethers.parseEther("0.0005")) {
    const tx = await walletA.sendTransaction({ to: walletB.address, value: ethers.parseEther("0.002") });
    await tx.wait();
    entry({ label: "funding: ETH A→B", txHash: tx.hash, block: String((await tx.wait())!.blockNumber) });
    console.log("funded Wallet B with 0.002 ETH for gas");
  }
  const bVdbt = await vdbt.balanceOf(walletB.address);
  if (bVdbt < 10n * WAD) {
    await (await vdbt.mint(walletB.address, 10n * WAD)).wait();
    console.log("minted 10 vDBT to Wallet B (test token mechanism)");
  }
  // Wallet B must allow VeilLend to pull the settlement debt
  const allowance = await vdbt.allowance(walletB.address, A.veilLend);
  if (allowance < 10n * WAD) {
    const tx = await vdbt.connect(walletB).approve(A.veilLend, ethers.MaxUint256);
    await tx.wait();
    entry({ label: "approve: Wallet B vDBT→VeilLend", txHash: tx.hash, block: String((await tx.wait())!.blockNumber) });
    console.log("Wallet B approved VeilLend for vDBT");
  }

  // ---------- Step A: create fresh position (correct ID handling) ----------
  const nextId = (await veil.nextPositionId()) + 1n;
  const currentIndex = await veil.currentDebtIndex(A.debtToken);
  const state = makeInitialState({
    positionId: nextId,
    collateralAsset: BigInt(A.collateralToken),
    debtAsset: BigInt(A.debtToken),
    currentIndex,
    controlSecret: BigInt(ethers.hexlify(ethers.randomBytes(31))),
    salt: BigInt(ethers.hexlify(ethers.randomBytes(31))),
  });
  const C0 = await computeCommitment(state);
  {
    const tx = await veil.connect(walletA).createPosition(A.collateralToken, A.debtToken, bytes32(C0));
    const r = await tx.wait();
    entry({ label: "createPosition", positionId: nextId.toString(), txHash: tx.hash, block: String(r!.blockNumber), gasUsed: r!.gasUsed.toString() });
    const on = await veil.positions(nextId);
    if (on.activeCommitment !== bytes32(C0) || on.status !== 1n) throw new Error("Position # verification failed");
    console.log(`✓ Position #${nextId} created (Active, sequence ${on.sequence}, commitment C0 stored)`);
  }

  // Wallet A needs vCOL for the deposit (previous aborted runs left prior
  // mints locked in custody against orphaned positions 3/5/7)
  if ((await vcol.balanceOf(walletA.address)) < 100n * WAD) {
    await (await vcol.mint(walletA.address, 100n * WAD)).wait();
    console.log("minted 100 vCOL to Wallet A");
  }

  // ---------- Step B: deposit 100 vCOL (real state_transition proof) ----------
  const custody0 = await veil.collateralCustody(A.collateralToken);
  const supported0 = await veil.supportedCollateral(nextId);
  const depSalt = BigInt(ethers.hexlify(ethers.randomBytes(31)));
  {
    const t = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 100n * WAD, currentIndex, newSalt: depSalt });
    const { callArgs } = await generateProof(t.inputs);
    const ps = t.publicSignals;
    const tx = await veil.connect(walletA).deposit(
      { positionId: ps[0], oldCommitment: ps[1], newCommitment: ps[2], nullifier: ps[3], actionId: ps[4], newSequence: ps[5], currentIndexLo: ps[6], currentIndexHi: ps[7], publicAmount: ps[8] },
      callArgs.pA, callArgs.pB, callArgs.pC
    );
    const r = await tx.wait();
    entry({ label: "deposit (ZK verified)", positionId: nextId.toString(), txHash: tx.hash, block: String(r!.blockNumber), gasUsed: r!.gasUsed.toString() });
    console.log("✓ deposit verified on-chain; custody:", (await veil.collateralCustody(A.collateralToken)).toString(), "supported:", (await veil.supportedCollateral(nextId)).toString());
  }
  state.collateral = 100n * WAD;
  state.sequence = 1n;
  state.salt = depSalt;
  const C1 = await computeCommitment(state);

  // Wallet A needs vDBT to fund the liquidity seed (repay pulls from sender)
  if ((await vdbt.balanceOf(walletA.address)) < 50n * WAD) {
    await (await vdbt.mint(walletA.address, 50n * WAD)).wait();
    console.log("minted 50 vDBT to Wallet A (liquidity seed funding)");
  }
  if ((await vdbt.allowance(walletA.address, A.veilLend)) < 50n * WAD) {
    await (await vdbt.connect(walletA).approve(A.veilLend, ethers.MaxUint256)).wait();
    console.log("Wallet A approved VeilLend for vDBT");
  }

  // ---------- Step C: seed debt liquidity (originated-debt position repays) ----------
  const seedId = (await veil.nextPositionId()) + 1n;
  const seedState = makeInitialState({
    positionId: seedId,
    collateralAsset: BigInt(A.collateralToken),
    debtAsset: BigInt(A.debtToken),
    currentIndex: await veil.currentDebtIndex(A.debtToken),
    controlSecret: BigInt(ethers.hexlify(ethers.randomBytes(31))),
    salt: BigInt(ethers.hexlify(ethers.randomBytes(31))),
  });
  seedState.debt = 50n * WAD; // originated debt
  await (await veil.connect(walletA).createPosition(A.collateralToken, A.debtToken, bytes32(await computeCommitment(seedState)))).wait();
  {
    const t = await buildTransition({ oldState: seedState, actionId: 2n, amount: 50n * WAD, currentIndex: await veil.currentDebtIndex(A.debtToken), newSalt: BigInt(ethers.hexlify(ethers.randomBytes(31))) });
    const { callArgs } = await generateProof(t.inputs);
    const ps = t.publicSignals;
    const tx = await veil.connect(walletA).repay(
      { positionId: ps[0], oldCommitment: ps[1], newCommitment: ps[2], nullifier: ps[3], actionId: ps[4], newSequence: ps[5], currentIndexLo: ps[6], currentIndexHi: ps[7], publicAmount: ps[8] },
      callArgs.pA, callArgs.pB, callArgs.pC
    );
    const r = await tx.wait();
    entry({ label: "seed liquidity (repay 50 vDBT)", txHash: tx.hash, block: String(r!.blockNumber), gasUsed: r!.gasUsed.toString() });
    console.log("✓ debtCustody seeded:", (await veil.debtCustody(A.debtToken)).toString());
  }

  // ---------- Step D: borrow 10 vDBT (real risk_transition proof, recipient-bound) ----------
  // Ensure the oracle is fresh and at the healthy price ($2) — prior aborted
  // runs may have left a stale/dropped price on-chain. The proof must match
  // the oracle.
  await (await oracle.setPrice(A.collateralToken, 2n * PRICE_SCALE)).wait();
  await (await oracle.setPrice(A.debtToken, 1n * PRICE_SCALE)).wait();
  console.log("oracle refreshed: vCOL $2.00, vDBT $1.00");
  const debtCustodyAfterSeed = await veil.debtCustody(A.debtToken);
  const b = await buildRiskTransition({
    oldState: state,
    actionId: ACTION_BORROW,
    amount: 10n * WAD,
    currentIndex: await veil.currentDebtIndex(A.debtToken),
    newSalt: BigInt(ethers.hexlify(ethers.randomBytes(31))),
    params: { collateralPrice: 2n * PRICE_SCALE, debtPrice: 1n * PRICE_SCALE, maxLtvBps: 7500n },
    recipient: BigInt(walletA.address),
  });
  const bProof = await generateProof(b.inputs, "risk_transition");
  {
    const ps = b.publicSignals;
    const tx = await veil.connect(walletA).borrow(
      { positionId: ps[0], oldCommitment: ps[1], newCommitment: ps[2], nullifier: ps[3], actionId: ps[4], newSequence: ps[5], currentIndexLo: ps[6], currentIndexHi: ps[7], publicAmount: ps[8] },
      bProof.callArgs.pA, bProof.callArgs.pB, bProof.callArgs.pC
    );
    const r = await tx.wait();
    entry({ label: "borrow (ZK verified, recipient-bound)", positionId: nextId.toString(), txHash: tx.hash, block: String(r!.blockNumber), gasUsed: r!.gasUsed.toString() });
    console.log("✓ borrow verified on-chain; borrowOutstanding:", (await veil.borrowOutstanding(nextId)).toString(), "debtCustody:", (await veil.debtCustody(A.debtToken)).toString());
  }
  state.debt = b.newState.debt;
  state.interestIndex = b.newState.interestIndex;
  state.sequence = b.newState.sequence;
  state.salt = b.newState.salt;
  const debtCustodyAfterBorrow = await veil.debtCustody(A.debtToken);

  // ---------- Step E: healthy position check ----------
  const healthy = await veil.positions(nextId);
  const [pColBefore] = await veil.getFreshPrice(A.collateralToken);
  const [pDebtBefore] = await veil.getFreshPrice(A.debtToken);
  console.log("\n--- Step E: healthy position ---");
  console.log("status:", healthy.status.toString(), "| sequence:", healthy.sequence.toString(), "| supported:", (await veil.supportedCollateral(nextId)).toString(), "| outstanding:", (await veil.borrowOutstanding(nextId)).toString());
  console.log("oracle vCOL:", pColBefore.toString(), "| vDBT:", pDebtBefore.toString());
  // solvency at current prices: 100·2·10^4 = 2e6 ≥ 10·1·7500 = 7.5e4 ✓ healthy

  // ---------- Step 6: oracle price drop $2 → $0.05 ----------
  const oldPrice = pColBefore;
  const newPrice = 5n * 10n ** 6n; // $0.05
  {
    const tx = await oracle.setPrice(A.collateralToken, newPrice);
    const r = await tx.wait();
    entry({ label: "oracle price drop vCOL $2→$0.05", txHash: tx.hash, block: String(r!.blockNumber) });
    const [fresh] = await veil.getFreshPrice(A.collateralToken);
    if (fresh !== newPrice) throw new Error("oracle price update failed");
    console.log("✓ vCOL price dropped:", oldPrice.toString(), "→", (await veil.getFreshPrice(A.collateralToken))[0].toString());
  }

  // ---------- Step 7: real liquidation proof (recipient = Wallet B) ----------
  const dropped = { collateralPrice: newPrice, debtPrice: 1n * PRICE_SCALE, liquidationThresholdBps: 8500n };
  const w = await buildLiquidationWitness(state, dropped, BigInt(walletB.address));
  console.log("eligibility (circuit witness): collateralOut =", w.amounts.collateralOut.toString(), "debtOut =", w.amounts.debtOut.toString());
  if (w.amounts.collateralOut !== 100n * WAD || w.amounts.debtOut !== 5n * WAD) {
    throw new Error(`Unexpected settlement amounts: ${JSON.stringify(w.amounts)}`);
  }
  const lProof = await generateProof(w.inputs, "liquidation");
  console.log("REAL liquidation proof generated (liquidation circuit, recipient=Wallet B) — public signals:", lProof.publicSignals.length);

  // ---------- Step 8: preflight + liquidate from Wallet B ----------
  const debtOut = w.amounts.debtOut;
  const collateralOut = w.amounts.collateralOut;
  const bVdbtBefore = await vdbt.balanceOf(walletB.address);
  const bVcolBefore = await vcol.balanceOf(walletB.address);
  if (bVdbtBefore < debtOut) throw new Error("Wallet B lacks vDBT for settlement");
  if ((await ethers.provider.getBalance(walletB.address)) === 0n) throw new Error("Wallet B lacks gas");
  if ((await vdbt.allowance(walletB.address, A.veilLend)) < debtOut) throw new Error("Wallet B allowance insufficient");
  const posNow = await veil.positions(nextId);
  if (posNow.status !== 1n) throw new Error("Position not Active");
  const [cPrice] = await veil.getFreshPrice(A.collateralToken);
  const [dPrice] = await veil.getFreshPrice(A.debtToken);
  if (cPrice !== newPrice || dPrice !== 1n * PRICE_SCALE) throw new Error("Oracle prices do not match proof inputs");

  const tx = await veil.connect(walletB).liquidate(nextId, collateralOut, debtOut, lProof.callArgs.pA, lProof.callArgs.pB, lProof.callArgs.pC);
  const r = await tx.wait();
  entry({ label: "LIQUIDATION (ZK verified, recipient=Wallet B)", positionId: nextId.toString(), txHash: tx.hash, block: String(r!.blockNumber), gasUsed: r!.gasUsed.toString() });
  console.log("✓ LIQUIDATION EXECUTED — tx:", tx.hash, "block:", r!.blockNumber, "gas:", r!.gasUsed.toString());

  // ---------- Step 9: on-chain verification ----------
  const pos = await veil.positions(nextId);
  const custodyAfter = await veil.collateralCustody(A.collateralToken);
  const debtCustodyAfter = await veil.debtCustody(A.debtToken);
  const supportedAfter = await veil.supportedCollateral(nextId);
  const outstandingAfter = await veil.borrowOutstanding(nextId);
  const bVcolAfter = await vcol.balanceOf(walletB.address);
  const bVdbtAfter = await vdbt.balanceOf(walletB.address);
  const aVcolAfter = await vcol.balanceOf(walletA.address);

  const checks: Record<string, boolean> = {
    positionClosed: pos.status === 2n,
    borrowOutstandingZeroed: outstandingAfter === 0n,
    supportedZeroed: supportedAfter === 0n,
    collateralCustodyDecreasedByCollateralOut: custodyAfter === custody0 + 100n * WAD - collateralOut,
    debtCustodyIncreasedByDebtOut: debtCustodyAfter === debtCustodyAfterBorrow + debtOut,
    walletBReceivedExactlyCollateralOut: bVcolAfter === bVcolBefore + collateralOut,
    walletBPaidExactlyDebtOut: bVdbtAfter === bVdbtBefore - debtOut,
    walletADidNotReceiveCollateral: aVcolAfter === 0n,
    commitmentUnchangedByLiquidation: pos.activeCommitment === healthy.activeCommitment, // liquidation closes the position; commitment stays at the last verified transition state (documented behavior)
    replayBlocked: false,
  };
  // replay: re-liquidating must revert with PositionNotActive
  let replayResult = "not attempted";
  try {
    await veil.connect(walletB).liquidate(nextId, collateralOut, debtOut, lProof.callArgs.pA, lProof.callArgs.pB, lProof.callArgs.pC);
    checks.replayBlocked = false;
    replayResult = "UNEXPECTEDLY SUCCEEDED";
  } catch (e: unknown) {
    checks.replayBlocked = true;
    replayResult = "reverted (PositionNotActive expected)";
  }

  console.log("\n--- Step 9: on-chain verification ---");
  for (const [k, v] of Object.entries(checks)) console.log(`${v ? "✓" : "✗"} ${k}: ${v}`);
  const allOk = Object.values(checks).every(Boolean);
  if (!allOk) throw new Error("One or more post-liquidation checks failed");

  // ---------- evidence artifact (public data only) ----------
  const evidence = {
    network: "horizenTestnet",
    chainId: EXPECTED_CHAIN_ID.toString(),
    walletA: walletA.address,
    walletB: walletB.address,
    contracts: A,
    positionId: nextId.toString(),
    commitments: { C0: C0.toString(), C_afterBorrow: healthy.activeCommitment, final: pos.activeCommitment, note: "liquidation does not advance the commitment; position is Closed" },
    transactions: log,
    oracle: { vCOLBefore: oldPrice.toString(), vCOLAfter: newPrice.toString(), vDBT: "100000000" },
    settlement: { collateralOut: collateralOut.toString(), debtOut: debtOut.toString(), badDebtWrittenOff: (state.debt - debtOut).toString() },
    positionBefore: { status: "Active", sequence: healthy.sequence.toString(), supportedCollateral: "100000000000000000000", borrowOutstanding: "10000000000000000000", activeCommitment: healthy.activeCommitment },
    positionAfter: { status: "Closed", borrowOutstanding: outstandingAfter.toString(), supportedCollateral: supportedAfter.toString(), activeCommitment: pos.activeCommitment },
    custody: { collateralCustodyBefore: custody0.toString(), collateralCustodyAfter: custodyAfter.toString(), debtCustodyAfterSeed: debtCustodyAfterSeed.toString(), debtCustodyAfterBorrow: debtCustodyAfterBorrow.toString(), debtCustodyAfterLiquidation: debtCustodyAfter.toString() },
    walletB: { vCOLBefore: bVcolBefore.toString(), vCOLAfter: bVcolAfter.toString(), vDBTBefore: bVdbtBefore.toString(), vDBTAfter: bVdbtAfter.toString() },
    liquidationEvent: { name: "Liquidated", args: { positionId: nextId.toString(), collateralAsset: A.collateralToken, debtAsset: A.debtToken, collateralOut: collateralOut.toString(), debtOut: debtOut.toString() } },
    proofVerifiedOnChain: true,
    replayAttemptResult: replayResult,
  };
  const out = path.join(__dirname, "..", "deployments", "testnet-liquidation-proof-test.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(evidence, null, 2) + "\n");
  console.log("evidence written to", out);
  console.log("TESTNET LIQUIDATION PROOF: PASS");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
