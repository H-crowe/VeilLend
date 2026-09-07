/**
 * VeilLend — REAL Horizen Testnet lifecycle E2E against the CURRENT UUPS
 * deployment (proxy 0xc1e2…4a5B) with the relay-fed OwnerMockPriceOracle
 * (real Base Chainlink prices).
 *
 * Flow: wrap ETH → WETH · seed USDC liquidity (seed position repay) ·
 *       create → deposit → borrow → repay → withdraw, each step a REAL
 *       transaction with a real locally-generated Groth16 proof.
 *
 * Run: npx hardhat run scripts/e2e-uups.ts --network horizenTestnet
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  ACTION_BORROW, ACTION_DEPOSIT, ACTION_REPAY, ACTION_WITHDRAW,
  buildRiskTransition, buildTransition, computeCommitment, generateProof,
  makeInitialState, requireZkArtifacts,
} from "./prove";

const randHex = () => ethers.hexlify(ethers.randomBytes(31));
const bytes32 = (v: bigint) => ethers.zeroPadValue(ethers.toBeHex(v), 32);
const USD6 = 10n ** 6n;
const WAD = 10n ** 18n;

function toInputs(p: { publicSignals: bigint[] }) {
  const s = p.publicSignals.map((v) => BigInt(v));
  return {
    positionId: s[0], oldCommitment: s[1], newCommitment: s[2], nullifier: s[3],
    actionId: s[4], newSequence: s[5], currentIndexLo: s[6], currentIndexHi: s[7],
    publicAmount: s[8],
  };
}

async function main() {
  requireZkArtifacts();
  const record = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "horizenTestnet-uups.json"), "utf8"));
  const A = record.addresses;
  const [user] = await ethers.getSigners();
  console.log("user:", user.address);

  const veil = await ethers.getContractAt("VeilLend", A.veilLend);
  const weth = await ethers.getContractAt("TokenMock", A.WETH);
  const usdc = await ethers.getContractAt("TokenMock6", A.USDC);
  void weth; void usdc;
  const wethC = new ethers.Contract(A.WETH, ["function deposit() payable", "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], user);
  const usdcC = new ethers.Contract(A.USDC, ["function mint(address,uint256)", "function balanceOf(address) view returns (uint256)", "function approve(address,uint256) returns (bool)"], user);
  const oracleC = new ethers.Contract(A.mockPriceOracle, ["function getPrice(address) view returns (uint256,uint256)"], user);

  // live, relayed prices (real Base Chainlink data)
  const [colRaw, colUp] = await oracleC.getPrice(A.WETH);
  const [debtRaw, debtUp] = await oracleC.getPrice(A.USDC);
  if (colRaw === 0n || debtRaw === 0n) throw new Error("oracle prices not set — run the price relay first");
  const ageMin = (Date.now() / 1000 - Number(colUp)) / 60;
  console.log(`live prices: WETH $${(Number(colRaw) / 1e8).toFixed(4)} · USDC $${(Number(debtRaw) / 1e8).toFixed(4)} (updated ${ageMin.toFixed(1)} min ago)`);
  if (ageMin > 55) throw new Error("oracle prices stale — run the relay (POST /refresh) first");
  // 18-dec-normalized prices, same convention the contract feeds the circuits
  const colPrice = colRaw * 10n ** (18n - 18n);
  const debtPrice = debtRaw * 10n ** (18n - 6n);

  // --- wrap some ETH into WETH (0.02 ETH ≈ $50 — keep gas headroom) ---
  const depositAmt = 2n * WAD / 100n; // 0.02 WETH
  const wethBal = await wethC.balanceOf(user.address);
  if (wethBal < depositAmt) {
    const t = await wethC.deposit({ value: depositAmt });
    await t.wait();
    console.log("wrapped ETH → WETH:", t.hash);
  }
  await (await wethC.approve(A.veilLend, ethers.MaxUint256)).wait();
  if ((await usdcC.balanceOf(user.address)) < 10_000n * USD6) {
    await (await usdcC.mint(user.address, 10_000n * USD6)).wait();
  }
  await (await usdcC.approve(A.veilLend, ethers.MaxUint256)).wait();
  console.log("approvals done");

  // --- seed USDC borrow liquidity (seed position + repay) ---
  const custodyBefore = await veil.debtCustody(A.USDC);
  if (custodyBefore < 1_000n * USD6) {
    const seedId = (await veil.nextPositionId()) + 1n;
    const idx0 = await veil.currentDebtIndex(A.USDC);
    const seed = makeInitialState({
      positionId: seedId, collateralAsset: BigInt(A.WETH), debtAsset: BigInt(A.USDC),
      currentIndex: idx0, controlSecret: BigInt(randHex()), salt: BigInt(randHex()),
    });
    seed.debt = 5_000n * USD6;
    await (await veil.createPosition(A.WETH, A.USDC, bytes32(await computeCommitment(seed)))).wait();
    const t = await buildTransition({ oldState: seed, actionId: ACTION_REPAY, amount: 5_000n * USD6, currentIndex: idx0, newSalt: BigInt(randHex()) });
    const proof = await generateProof(t.inputs);
    const r = await (await veil.repay(toInputs(t), proof.callArgs.pA, proof.callArgs.pB, proof.callArgs.pC)).wait();
    console.log("seed repay 5000 USDC → reserve:", r?.hash);
  } else {
    console.log("USDC reserve already funded:", custodyBefore.toString());
  }

  // ---------- lifecycle ----------
  const id = (await veil.nextPositionId()) + 1n;
  const idx = await veil.currentDebtIndex(A.USDC);
  let state = makeInitialState({
    positionId: id, collateralAsset: BigInt(A.WETH), debtAsset: BigInt(A.USDC),
    currentIndex: idx, controlSecret: BigInt(randHex()), salt: BigInt(randHex()),
  });
  await (await veil.createPosition(A.WETH, A.USDC, bytes32(await computeCommitment(state)))).wait();
  console.log("CREATE  position", id.toString());

  // deposit 0.1 WETH
  const amt = WAD / 50n; // 0.02 WETH (matches the wrapped amount)
  const dep = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: amt, currentIndex: idx, newSalt: BigInt(randHex()) });
  const depP = await generateProof(dep.inputs);
  const rDep = await (await veil.deposit(toInputs(dep), depP.callArgs.pA, depP.callArgs.pB, depP.callArgs.pC)).wait();
  state = dep.newState;
  console.log("DEPOSIT 0.02 WETH:", rDep?.hash, "| supportedCollateral:", (await veil.supportedCollateral(id)).toString());

  // refresh prices right before risk actions (same-tx-freshness model)
  const [colRaw2] = await oracleC.getPrice(A.WETH);
  const [debtRaw2] = await oracleC.getPrice(A.USDC);
  const col2 = colRaw2 * 10n ** 0n;
  const debt2 = debtRaw2 * 10n ** 12n;
  // borrow 100 USDC (≤75% of 0.1 WETH value)
  const bor = await buildRiskTransition({
    oldState: state, actionId: ACTION_BORROW, amount: 20n * USD6,
    currentIndex: await veil.currentDebtIndex(A.USDC), newSalt: BigInt(randHex()),
    params: { collateralPrice: col2, debtPrice: debt2, maxLtvBps: 7500n },
    recipient: BigInt(user.address),
  });
  const borP = await generateProof(bor.inputs, "risk_transition");
  const rBor = await (await veil.borrow(toInputs(bor), borP.callArgs.pA, borP.callArgs.pB, borP.callArgs.pC)).wait();
  state = bor.newState;
  console.log("BORROW  20 USDC:", rBor?.hash, "| outstanding:", (await veil.borrowOutstanding(id)).toString());

  // repay full
  const rep = await buildTransition({ oldState: state, actionId: ACTION_REPAY, amount: 20n * USD6, currentIndex: await veil.currentDebtIndex(A.USDC), newSalt: BigInt(randHex()) });
  const repP = await generateProof(rep.inputs);
  const rRep = await (await veil.repay(toInputs(rep), repP.callArgs.pA, repP.callArgs.pB, repP.callArgs.pC)).wait();
  state = rep.newState;
  console.log("REPAY   20 USDC:", rRep?.hash, "| outstanding:", (await veil.borrowOutstanding(id)).toString());

  // withdraw full
  const wd = await buildRiskTransition({
    oldState: state, actionId: ACTION_WITHDRAW, amount: amt,
    currentIndex: await veil.currentDebtIndex(A.USDC), newSalt: BigInt(randHex()),
    params: { collateralPrice: col2, debtPrice: debt2, maxLtvBps: 7500n },
    recipient: BigInt(user.address),
  });
  const wdP = await generateProof(wd.inputs, "risk_transition");
  const rWd = await (await veil.withdrawCollateral(toInputs(wd), wdP.callArgs.pA, wdP.callArgs.pB, wdP.callArgs.pC)).wait();
  state = wd.newState;
  console.log("WITHDRAW 0.02 WETH:", rWd?.hash, "| supportedCollateral:", (await veil.supportedCollateral(id)).toString());

  const pos = await veil.positions(id);
  console.log("\nFINAL: sequence", pos.sequence.toString(), "| status", pos.status.toString(),
    "| outstanding", (await veil.borrowOutstanding(id)).toString(),
    "| supported", (await veil.supportedCollateral(id)).toString());
  console.log("E2E COMPLETE");
}

main()
  .then(() => process.exit(0))
  .catch((err) => { console.error(err); process.exit(1); });
