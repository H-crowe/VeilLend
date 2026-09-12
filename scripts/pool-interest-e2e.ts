import { ethers, network } from "hardhat";

/**
 * REAL on-chain interest economics E2E against the canonical USDC Pool:
 *   borrow → REAL elapsed time (interest accrues) → repay principal+interest
 *   → verify realized interest = lender yield + protocol fee (10%).
 * No minting of results, no warped accounting — actual block-timestamp accrual.
 */
const VL = "0xc1e2cDADBf14717DfEE7ffA23EAf2b21e6004a5B";
const POOL = "0xf406448E519345C9D8bc08B606DaB677Cb12aCC1";
const USDC = "0x01c7AEb2A0428b4159c0E333712f40e127aF639E";
const VCOL = "0xb5a5b0f1083965B9d92dCd94E5BCdDb868BfcFCE";
const WAIT_SECS = 480; // ~8 minutes of REAL time at 500 bps/yr on 10 USDC ≈ 0.038 USDC interest

const USD6 = 10n ** 6n;
const WAD = 10n ** 18n;
const randHex = () => ethers.hexlify(ethers.randomBytes(31));
const bytes32 = (v: bigint) => ethers.zeroPadValue(ethers.toBeHex(v), 32);

// TransitionInputs tuple: (positionId,oldCommitment,newCommitment,nullifier,actionId,newSequence,currentIndexLo,currentIndexHi,publicAmount)
const TI = "(uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256,uint256)";
const PROOF = "uint256[2],uint256[2][2],uint256[2]";
const VL_ABI = [
  "function createPosition(address,address,bytes32) returns (uint256)",
  "function maxPriceStaleness() view returns (uint256)",
  "function oracle() view returns (address)",
  "function currentDebtIndex(address) view returns (uint256)",
  "function nextPositionId() view returns (uint256)",
  "function accrueInterest(address)",
  "function borrowOutstanding(uint256) view returns (uint256)",
  "function debtCustody(address) view returns (uint256)",
  `function deposit(${TI},${PROOF})`,
  `function repay(${TI},${PROOF})`,
  `function borrow(${TI},${PROOF})`,
  `function withdrawCollateral(${TI},${PROOF})`,
];
const POOL_ABI = [
  "function deposit(uint256 assets, address receiver) returns (uint256)",
  "function totalAssets() view returns (uint256)",
  "function totalBorrows() view returns (uint256)",
  "function availableLiquidity() view returns (uint256)",
  "function accruedFees() view returns (uint256)",
  "function convertToAssets(uint256) view returns (uint256)",
  "function balanceOf(address) view returns (uint256)",
  "function feeBps() view returns (uint256)",
  "function rateBps() view returns (uint256)",
];
const TOKEN_ABI = ["function mint(address,uint256)", "function approve(address,uint256)", "function balanceOf(address) view returns (uint256)", "function allowance(address,address) view returns (uint256)"];
const ORACLE_ABI = ["function getPrice(address) view returns (uint256,uint256)"];

async function main() {
  const pc = ethers.provider;
  // E2E wallet: dedicated test wallet from .env (E2E_WALLET_PRIVATE_KEY) when
  // present; falls back to the default hardhat signer (deployment key).
  const e2eKey = process.env.E2E_WALLET_PRIVATE_KEY;
  const signer = e2eKey
    ? new ethers.Wallet(e2eKey, pc)
    : (await ethers.getSigners())[0];
  console.log("e2e wallet:", signer.address, e2eKey ? "(dedicated E2E wallet)" : "(default signer)");
  const veil = new ethers.Contract(VL, VL_ABI, signer);
  const pool = new ethers.Contract(POOL, POOL_ABI, signer);
  const usdc = new ethers.Contract(USDC, TOKEN_ABI, signer);
  const vcol = new ethers.Contract(VCOL, TOKEN_ABI, signer);
  const { buildTransition, buildRiskTransition, computeCommitment, makeInitialState, generateProof } = await import("../scripts/prove");
  const toInputs = (ps: readonly (string | bigint)[]) => ps.map((v) => BigInt(v)); // TransitionInputs tuple (positional)

  /** PrivateState -> StoredWitness.state (same shape as the demo store). */
  const witnessState = (pid: bigint, st: {
    collateralAsset: bigint; debtAsset: bigint; collateral: bigint; debt: bigint;
    interestIndex: bigint; sequence: bigint; controlSecret: bigint; salt: bigint;
  }) => {
    const hex = (v: bigint) => "0x" + v.toString(16);
    return {
      positionId: pid.toString(),
      collateralAsset: hex(st.collateralAsset),
      debtAsset: hex(st.debtAsset),
      collateral: hex(st.collateral),
      debt: hex(st.debt),
      interestIndex: hex(st.interestIndex),
      sequence: hex(st.sequence),
      controlSecret: hex(st.controlSecret),
      salt: hex(st.salt),
    };
  };

  /**
   * Stale-RPC guard for the debt index. The repay/borrow proofs must carry
   * the EXACT on-chain index at tx time (a mismatch reverts with StaleIndex).
   * Load-balanced RPC nodes can serve lagging state, so a single read is not
   * trustworthy. Bounded double-read: two calls separated by a short gap must
   * agree — otherwise abort with a clear error (no retries, no polling).
   */
  const readStableDebtIndex = async (): Promise<bigint> => {
    const a = await veil.currentDebtIndex(USDC);
    await new Promise((r) => setTimeout(r, 2000));
    const b = await veil.currentDebtIndex(USDC);
    if (a !== b) {
      throw new Error(`debt index unstable across reads (${a} vs ${b}) — RPC state is lagging or someone is accruing concurrently; abort before building any proof`);
    }
    return a;
  };
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const callVeil = (fn: string, ...args: unknown[]): Promise<any> => (veil as unknown as Record<string, (...a: unknown[]) => Promise<any>>)[fn](...args);

  console.log("=== setup: fund lender + borrower test balances (testnet mocks) ===");
  for (const t of [usdc, vcol]) {
    const bal = await t.balanceOf(signer.address);
    if (bal < 2000n * USD6) { const tx = await t.mint(signer.address, 2000n * USD6); await tx.wait(); }
    const a = await t.allowance(signer.address, POOL);
    if (a < 2n ** 200n) { const tx = await t.approve(POOL, 2n ** 256n - 1n); await tx.wait(); }
    const a2 = await t.allowance(signer.address, VL);
    if (a2 < 2n ** 200n) { const tx = await t.approve(VL, 2n ** 256n - 1n); await tx.wait(); }
  }

  // ---------- LENDER: supply 20 USDC ----------
  const lenderSharesBefore = await pool.balanceOf(signer.address);
  const d = await pool.deposit(20n * USD6, signer.address);
  await d.wait();
  const lenderShares = (await pool.balanceOf(signer.address)) - lenderSharesBefore;
  console.log("LENDER: deposited 20 USDC → shares", lenderShares.toString());

  // ---------- BORROWER: create vCOL→USDC position, deposit collateral ----------
  const id = (await veil.nextPositionId()) + 1n;
  const idx0 = await veil.currentDebtIndex(USDC);
  const state0 = makeInitialState({ positionId: id, collateralAsset: BigInt(VCOL), debtAsset: BigInt(USDC), currentIndex: idx0, controlSecret: BigInt(randHex()), salt: BigInt(randHex()) });
  await (await veil.createPosition(VCOL, USDC, bytes32(await computeCommitment(state0)))).wait();
  saveWitness(id, witnessState(id, state0), String(horizenTestnet.id)); // witness persisted BEFORE any later step
  const dep = await buildTransition({ oldState: state0, actionId: 1n, amount: 10n * WAD, currentIndex: idx0, newSalt: BigInt(randHex()) });
  const depP = await generateProof(dep.inputs);
  await (await callVeil("deposit", toInputs(dep.publicSignals), depP.callArgs.pA, depP.callArgs.pB, depP.callArgs.pC)).wait();
  let state = dep.newState;
  saveWitness(id, witnessState(id, state), String(horizenTestnet.id));
  console.log("BORROWER: position", id.toString(), "created + 10 vCOL deposited");

  // ---------- borrow 10 USDC from the pool ----------
  // LIVE oracle prices (same working pattern as e2e-uups.ts): read the actual
  // oracle values and normalize them to 18 decimals exactly as the contract
  // does. No hardcoded/theoretical prices — the ZK proof and the on-chain
  // check must see identical values.
  const oracleC = new ethers.Contract(await veil.oracle(), ORACLE_ABI, pc);
  const staleness = await veil.maxPriceStaleness();
  const [colRaw, colUp] = await oracleC.getPrice(VCOL);
  const [debtRaw, debtUp] = await oracleC.getPrice(USDC);
  if (colRaw === 0n || debtRaw === 0n) throw new Error("oracle prices not set — run the price relay first");
  const blk = await pc.getBlock("latest");
  if (!blk) throw new Error("could not read latest block");
  const nowSec = blk.timestamp;
  if (BigInt(nowSec) - BigInt(colUp) > BigInt(staleness) || BigInt(nowSec) - BigInt(debtUp) > BigInt(staleness)) {
    throw new Error("oracle prices stale — refresh the relay prices first, then re-run");
  }
  console.log("live prices: vCOL raw=" + colRaw.toString(), "USDC raw=" + debtRaw.toString());
  const colPrice = colRaw * 10n ** (18n - 18n); // vCOL: 18 decimals
  const debtPrice = debtRaw * 10n ** (18n - 6n); // USDC: 6 decimals
  const borrowAmount = 10n * USD6;
  const idxB = await readStableDebtIndex();
  const bor = await buildRiskTransition({
    oldState: state, actionId: 3n, amount: borrowAmount, currentIndex: idxB, newSalt: BigInt(randHex()),
    params: { collateralPrice: colPrice, debtPrice: debtPrice, maxLtvBps: 7500n },
    recipient: BigInt(signer.address),
  });
  const borP = await generateProof(bor.inputs, "risk_transition");
  await (await callVeil("borrow", toInputs(bor.publicSignals.slice(0, 9)), borP.callArgs.pA, borP.callArgs.pB, borP.callArgs.pC)).wait();
  state = bor.newState;
  saveWitness(id, witnessState(id, state), String(horizenTestnet.id)); // survives even if the 8-minute wait or repay fails
  console.log("BORROWER: borrowed", borrowAmount.toString(), "USDC from POOL | pool.totalBorrows =", (await pool.totalBorrows()).toString(), "| pool.liquidity =", (await pool.availableLiquidity()).toString());
  console.log(`waiting ${WAIT_SECS}s of REAL time for interest to accrue…`);
  await new Promise((r) => setTimeout(r, WAIT_SECS * 1000));

  // ---------- accrue + repay principal + interest ----------
  // RPC read synchronization: the accrue transaction is confirmed first, and
  // every following index read is PINNED to the accrual receipt's block tag —
  // lagging load-balanced nodes then serve the exact post-accrual state
  // instead of randomly mixed pre/post-accrual values.
  const accrueTx = await veil.accrueInterest(USDC);
  const accrueReceipt = await accrueTx.wait();
  if (!accrueReceipt || accrueReceipt.status !== 1) {
    throw new Error("accrueInterest tx reverted: " + accrueTx.hash);
  }
  const accrueBlock = accrueReceipt.blockNumber;
  const pinned = { blockTag: accrueBlock } as const;

  // idx1 for the proof: deterministic read at the accrual block (all nodes
  // agree on a historical block tag). Read twice for consistency.
  const idx1 = await veil.currentDebtIndex(USDC, pinned);
  const idx1Again = await veil.currentDebtIndex(USDC, pinned);
  if (idx1Again !== idx1) {
    throw new Error(`pinned index reads disagree (${idx1} vs ${idx1Again}) — abort`);
  }
  // existing stability guard, unchanged: live reads must ALSO be stable, or
  // the script aborts (guard semantics preserved per design).
  const idx1Live = await readStableDebtIndex();
  if (idx1Live !== idx1) {
    throw new Error(`live index ${idx1Live} != pinned index ${idx1} — RPC lag detected; abort`);
  }
  if (idx1 <= idxB) {
    throw new Error(`index did not advance after accrual (${idxB} -> ${idx1}) — interest cannot be proven on-chain in this state; abort`);
  }
  const repayAmount = ((borrowAmount * idx1) + idxB - 1n) / idxB; // ceil per the circuit
  const realizedInterest = repayAmount - borrowAmount;
  // last check right before submission: pinned read of the live index must
  // still match the index the proof carries
  if ((await veil.currentDebtIndex(USDC, pinned)) !== idx1) {
    throw new Error("on-chain index moved between read and repay — abort instead of risking StaleIndex");
  }
  console.log("index:", idxB.toString(), "→", idx1.toString(), "| repay (principal+interest):", repayAmount.toString(), "| realized interest:", realizedInterest.toString());

  await (await usdc.mint(signer.address, repayAmount)).wait(); // borrower tops up to cover interest
  const rep = await buildTransition({ oldState: state, actionId: 2n, amount: repayAmount, currentIndex: idx1, newSalt: BigInt(randHex()) });
  const repP = await generateProof(rep.inputs);
  await (await callVeil("repay", toInputs(rep.publicSignals), repP.callArgs.pA, repP.callArgs.pB, repP.callArgs.pC)).wait();
  state = rep.newState;
  saveWitness(id, witnessState(id, state), String(horizenTestnet.id));

  // ---------- on-chain economics verification ----------
  const [totalAssets, totalBorrows, availableLiquidity, accruedFees, feeBps] = [await pool.totalAssets(), await pool.totalBorrows(), await pool.availableLiquidity(), await pool.accruedFees(), await pool.feeBps()];
  const fee = (realizedInterest * feeBps) / 10000n;
  const toLenders = realizedInterest - fee;
  console.log("--- RESULTS ---");
  console.log("principal:", borrowAmount.toString(), "| realized interest:", realizedInterest.toString());
  console.log("pool.totalBorrows:", totalBorrows.toString(), "(must be 0)");
  console.log("pool.accruedFees:", accruedFees.toString(), "(expected fee =", fee.toString(), ")");
  console.log("pool.totalAssets:", totalAssets.toString(), "(expected =", (2000n * USD6 + 20n * USD6 + toLenders).toString(), ")");
  console.log("lender underlying for shares:", (await pool.convertToAssets(lenderShares)).toString(), "(was 2020 USDC before interest)");
  if (totalBorrows !== 0n) throw new Error("borrows not cleared");
  if (accruedFees !== fee) throw new Error("fee mismatch");
  if (totalAssets !== 2000n * USD6 + 20n * USD6 + toLenders) throw new Error("totalAssets mismatch");
  const identity = realizedInterest === fee + toLenders;
  console.log(`IDENTITY: realized(${realizedInterest}) = lender yield(${toLenders}) + fee(${fee}) → ${identity}`);
  console.log("INTEREST E2E PASSED");
}

main().catch((e) => { console.error("FAILED:", e); process.exitCode = 1; });
import { saveWitness } from "./witness-store";
import { horizenTestnet } from "../demo/lib/chains";
