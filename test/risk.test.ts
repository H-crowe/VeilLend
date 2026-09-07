import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { MockPriceOracle, TokenMock, VeilLend } from "../typechain-types";
import {
  ACTION_BORROW,
  ACTION_DEPOSIT,
  ACTION_WITHDRAW,
  PrivateState,
  RiskParams,
  buildRiskTransition,
  buildTransition,
  computeCommitment,
  generateProof,
  makeInitialState,
  requireZkArtifacts,
} from "../scripts/prove";

/**
 * Phase 3, Milestone 2 — proof-bound borrow & withdraw.
 *
 * Both actions are private state transitions whose circuit embeds the
 * POST-action solvency check: a borrow that over-leverages or a withdrawal
 * that would leave the position unsafe is unprovable. The contract derives
 * prices/LTV on-chain and pays out 1:1 from the aggregate custody.
 */

const WAD = 10n ** 18n;
const PARAMS: RiskParams = { collateralPrice: 2n * 10n ** 8n, debtPrice: 1n * 10n ** 8n, maxLtvBps: 7500n };
const RATE = {
  baseRateBps: 500,
  slopeBps: 2000,
  targetUtilizationBps: 8000,
  reserveFactorBps: 1000,
  maxLtvBps: 7_500,
  liquidationThresholdBps: 8_500,
};

const randHex = () => ethers.hexlify(ethers.randomBytes(31));
const bytes32 = (v: bigint) => ethers.zeroPadValue(ethers.toBeHex(v), 32);

async function deployFixture() {
  requireZkArtifacts();
  const [owner, user, liquidator, other] = await ethers.getSigners();
  const collateral = (await (await ethers.getContractFactory("TokenMock")).deploy("Collateral", "COL")) as TokenMock;
  const debt = (await (await ethers.getContractFactory("TokenMock")).deploy("Debt", "DBT")) as TokenMock;
  const oracle = (await (await ethers.getContractFactory("MockPriceOracle")).deploy()) as MockPriceOracle;
  const verifier = await (await ethers.getContractFactory("Groth16Verifier")).deploy();
  const solvencyVerifier = await (await ethers.getContractFactory("SolvencyVerifier")).deploy();
  const riskVerifier = await (await ethers.getContractFactory("RiskTransitionVerifier")).deploy();
  const liquidationVerifier = await (await ethers.getContractFactory("LiquidationVerifier")).deploy();
  const veil = ((await upgrades.deployProxy(
            await ethers.getContractFactory("VeilLend"),
            [owner.address, await verifier.getAddress(), await solvencyVerifier.getAddress(), await riskVerifier.getAddress(), await liquidationVerifier.getAddress(), await oracle.getAddress()],
            { kind: "uups" },
          ))) as VeilLend;

  await veil.connect(owner).enableCollateralAsset(await collateral.getAddress());
  await veil.connect(owner).enableDebtAsset(await debt.getAddress(), RATE);
  await oracle.setPrice(await collateral.getAddress(), PARAMS.collateralPrice);
  await oracle.setPrice(await debt.getAddress(), PARAMS.debtPrice);

  for (const s of [user, liquidator, other]) {
    await collateral.mint(s.address, 1_000_000n * WAD);
    await debt.mint(s.address, 1_000_000n * WAD);
    await collateral.connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
    await debt.connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
  }
  return { veil, collateral, debt, oracle, owner, user, liquidator, other };
}

async function createPosition(
  veil: VeilLend,
  collateral: TokenMock,
  debt: TokenMock,
  opts: { initialDebt?: bigint } = {}
) {
  const id = (await veil.nextPositionId()) + 1n;
  const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
  const state = makeInitialState({
    positionId: id,
    collateralAsset: BigInt(await collateral.getAddress()),
    debtAsset: BigInt(await debt.getAddress()),
    currentIndex,
    controlSecret: BigInt(randHex()),
    salt: BigInt(randHex()),
  });
  state.debt = opts.initialDebt ?? 0n;
  await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(state)));
  return { id, state };
}

async function proveAndSubmit(
  veil: VeilLend,
  from: { address: string },
  prepared: { publicSignals: bigint[]; inputs: Record<string, string> },
  fn: "deposit" | "repay" | "borrow" | "withdrawCollateral"
) {
  const ps = prepared.publicSignals;
  const inputs = {
    positionId: ps[0],
    oldCommitment: ps[1],
    newCommitment: ps[2],
    nullifier: ps[3],
    actionId: ps[4],
    newSequence: ps[5],
    currentIndexLo: ps[6],
    currentIndexHi: ps[7],
    publicAmount: ps[8],
  };
  const circuit = fn === "deposit" || fn === "repay" ? "state_transition" : "risk_transition";
  const { callArgs } = await generateProof(prepared.inputs, circuit);
  return veil.connect(from as never)[fn](inputs, callArgs.pA, callArgs.pB, callArgs.pC);
}

describe("Phase 3 M2 — proof-bound borrow & withdraw", () => {
  it("borrows from protocol liquidity with a proof-bound private debt increase", async () => {
    const { veil, user, liquidator, collateral, debt } = await loadFixture(deployFixture);

    // seed borrowable liquidity: position 1 repays its originated debt
    const p1 = await createPosition(veil, collateral, debt, { initialDebt: 500n * WAD });
    const repayT = await buildTransition({
      oldState: p1.state,
      actionId: ACTION_DEPOSIT === 1n ? 2n : 2n, // ACTION_REPAY
      amount: 500n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
    });
    await proveAndSubmit(veil, liquidator, repayT, "repay");
    expect(await veil.debtCustody(await debt.getAddress())).to.equal(500n * WAD);

    // position 2: deposit 100e18 collateral, then borrow 10e18
    const p2 = await createPosition(veil, collateral, debt);
    const depT = await buildTransition({
      oldState: p2.state,
      actionId: ACTION_DEPOSIT,
      amount: 100n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
    });
    await proveAndSubmit(veil, user, depT, "deposit");
    const afterDeposit = depT.newState;

    const borrowAmount = 10n * WAD;
    const bT = await buildRiskTransition({
      oldState: afterDeposit,
      actionId: ACTION_BORROW,
      amount: borrowAmount,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: PARAMS,
      recipient: BigInt(user.address),
    });

    const debtBefore = await debt.balanceOf(user.address);
    await expect(proveAndSubmit(veil, user, bT, "borrow"))
      .to.emit(veil, "Borrow")
      .withArgs(p2.id, await debt.getAddress(), borrowAmount);
    expect(await debt.balanceOf(user.address)).to.equal(debtBefore + borrowAmount);
    expect(await veil.debtCustody(await debt.getAddress())).to.equal(500n * WAD - borrowAmount);

    // hidden debt grew by exactly the borrowed amount; commitment advanced
    expect(bT.newState.debt).to.equal(borrowAmount); // debt was 0, no accrual yet
    expect((await veil.positions(p2.id)).activeCommitment).to.equal(bytes32(await computeCommitment(bT.newState)));
    expect((await veil.positions(p2.id)).sequence).to.equal(2n);

    // custody conservation: hidden collateral still equals custody
    expect(bT.newState.collateral).to.equal(await veil.collateralCustody(await collateral.getAddress()));
  });

  it("rejects a borrow that would over-leverage the hidden position", async () => {
    const { veil, user, collateral, debt } = await loadFixture(deployFixture);
    const p = await createPosition(veil, collateral, debt);
    const depT = await buildTransition({
      oldState: p.state,
      actionId: ACTION_DEPOSIT,
      amount: 100n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
    });
    await proveAndSubmit(veil, user, depT, "deposit");

    // solvent limit: 100e18 * 2 * 10000 / (1 * 7500) = 266.67e18 debt
    const tooMuch = 267n * WAD;
    const t = await buildRiskTransition({
      oldState: depT.newState,
      actionId: ACTION_BORROW,
      amount: tooMuch,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: PARAMS,
      recipient: BigInt(user.address),
    });
    // circuit-level rejection: post-borrow solvency is unprovable
    await expect(generateProof(t.inputs, "risk_transition")).to.be.rejected;
  });

  it("withdraws collateral 1:1 from custody while staying solvent", async () => {
    const { veil, user, collateral, debt } = await loadFixture(deployFixture);
    const p = await createPosition(veil, collateral, debt);
    const depT = await buildTransition({
      oldState: p.state,
      actionId: ACTION_DEPOSIT,
      amount: 100n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
    });
    await proveAndSubmit(veil, user, depT, "deposit");

    const wT = await buildRiskTransition({
      oldState: depT.newState,
      actionId: ACTION_WITHDRAW,
      amount: 50n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: PARAMS,
      recipient: BigInt(user.address),
    });

    const balBefore = await collateral.balanceOf(user.address);
    await expect(proveAndSubmit(veil, user, wT, "withdrawCollateral"))
      .to.emit(veil, "Withdrawal")
      .withArgs(p.id, await collateral.getAddress(), 50n * WAD);
    expect(await collateral.balanceOf(user.address)).to.equal(balBefore + 50n * WAD);
    expect(await veil.collateralCustody(await collateral.getAddress())).to.equal(50n * WAD);
    expect(wT.newState.collateral).to.equal(50n * WAD); // hidden == custody
    expect((await veil.positions(p.id)).sequence).to.equal(2n);
  });

  it("rejects an unsafe withdrawal (would leave position under-collateralized)", async () => {
    const { veil, user, collateral, debt } = await loadFixture(deployFixture);
    const p = await createPosition(veil, collateral, debt, { initialDebt: 100n * WAD });
    const depT = await buildTransition({
      oldState: p.state,
      actionId: ACTION_DEPOSIT,
      amount: 100n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
    });
    await proveAndSubmit(veil, user, depT, "deposit");
    // hidden: col 100e18 (val 200), debt 100e18 (val 100, required 75)
    // withdraw 30e18 → col 70e18 (val 140) ≥ 75 ✓ ok. withdraw 40e18 → val 120 ≥ 75 ✓.
    // withdraw 90e18 → col val 20 < 75 ✗ unsafe
    const wT = await buildRiskTransition({
      oldState: depT.newState,
      actionId: ACTION_WITHDRAW,
      amount: 90n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: PARAMS,
      recipient: BigInt(user.address),
    });
    await expect(proveAndSubmit(veil, user, wT, "withdrawCollateral")).to.be.rejected; // unprovable
  });

  it("rejects withdrawing more than the hidden collateral", async () => {
    const { veil, user, collateral, debt } = await loadFixture(deployFixture);
    const p = await createPosition(veil, collateral, debt);
    const depT = await buildTransition({
      oldState: p.state,
      actionId: ACTION_DEPOSIT,
      amount: 10n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
    });
    await proveAndSubmit(veil, user, depT, "deposit");
    await expect(
      buildRiskTransition({
        oldState: depT.newState,
        actionId: ACTION_WITHDRAW,
        amount: 11n * WAD,
        currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
        newSalt: BigInt(randHex()),
        params: PARAMS,
        recipient: BigInt(user.address),
      })
    ).to.be.rejected; // circuit: amount > oldCollateral
  });

  it("enforces protocol safety on-chain: liquidity, routing, replay, staleness, tamper", async () => {
    const { veil, user, liquidator, collateral, debt, oracle } = await loadFixture(deployFixture);
    const p = await createPosition(veil, collateral, debt);
    const depT = await buildTransition({
      oldState: p.state,
      actionId: ACTION_DEPOSIT,
      amount: 100n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
    });
    await proveAndSubmit(veil, user, depT, "deposit");

    // borrow with NO liquidity seeded → proof valid, custody insufficient
    const bT = await buildRiskTransition({
      oldState: depT.newState,
      actionId: ACTION_BORROW,
      amount: 1n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: PARAMS,
      recipient: BigInt(user.address),
    });
    await expect(proveAndSubmit(veil, user, bT, "borrow")).to.be.revertedWithCustomError(veil, "InsufficientLiquidity");

    // seed liquidity via a repay on another position, then borrow works
    const p2 = await createPosition(veil, collateral, debt, { initialDebt: 2n * WAD });
    const rT = await buildTransition({
      oldState: p2.state,
      actionId: 2n,
      amount: 2n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
    });
    await proveAndSubmit(veil, liquidator, rT, "repay");
    await proveAndSubmit(veil, user, bT, "borrow"); // now succeeds
    await expect(proveAndSubmit(veil, user, bT, "borrow")).to.be.revertedWithCustomError(veil, "TransitionConsumed"); // replay

    // wrong routing: borrow proof submitted as withdraw
    const b2 = await buildRiskTransition({
      oldState: bT.newState,
      actionId: ACTION_BORROW,
      amount: 1n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: PARAMS,
      recipient: BigInt(user.address),
    });
    await expect(proveAndSubmit(veil, user, b2, "withdrawCollateral")).to.be.revertedWithCustomError(veil, "InvalidAction");

    // stale index: accrue after proving (and refresh oracle timestamps so
    // only the index — not the price — is stale)
    await time.increase(30n * 24n * 60n * 60n);
    await oracle.setPrice(await collateral.getAddress(), PARAMS.collateralPrice);
    await oracle.setPrice(await debt.getAddress(), PARAMS.debtPrice);
    await veil.accrueInterest(await debt.getAddress());
    const staleT = await buildRiskTransition({
      oldState: bT.newState,
      actionId: ACTION_BORROW,
      amount: 1n * WAD,
      currentIndex: bT.newState.interestIndex, // now-stale index
      newSalt: BigInt(randHex()),
      params: PARAMS,
      recipient: BigInt(user.address),
    });
    await expect(proveAndSubmit(veil, user, staleT, "borrow")).to.be.revertedWithCustomError(veil, "StaleIndex");

    // tampered proof
    const freshT = await buildRiskTransition({
      oldState: bT.newState,
      actionId: ACTION_BORROW,
      amount: 1n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()), // fresh index
      newSalt: BigInt(randHex()),
      params: PARAMS,
      recipient: BigInt(user.address),
    });
    const ps = freshT.publicSignals;
    const inputs = {
      positionId: ps[0],
      oldCommitment: ps[1],
      newCommitment: ps[2],
      nullifier: ps[3],
      actionId: ps[4],
      newSequence: ps[5],
      currentIndexLo: ps[6],
      currentIndexHi: ps[7],
      publicAmount: ps[8],
    };
    const { callArgs } = await generateProof(freshT.inputs, "risk_transition");
    const tamperedP: [bigint, bigint] = [callArgs.pA[0] + 1n, callArgs.pA[1]];
    await expect(veil.connect(user).borrow(inputs, tamperedP, callArgs.pB, callArgs.pC)).to.be.revertedWithCustomError(veil, "InvalidProof");
  });

  it("keeps borrow/withdraw blocked while paused", async () => {
    const { veil, owner, user, collateral, debt } = await loadFixture(deployFixture);
    const p = await createPosition(veil, collateral, debt);
    const depT = await buildTransition({
      oldState: p.state,
      actionId: ACTION_DEPOSIT,
      amount: 10n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
    });
    await proveAndSubmit(veil, user, depT, "deposit");
    const wT = await buildRiskTransition({
      oldState: depT.newState,
      actionId: ACTION_WITHDRAW,
      amount: 1n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: PARAMS,
      recipient: BigInt(user.address),
    });
    await veil.connect(owner).setPaused(true);
    await expect(proveAndSubmit(veil, user, wT, "withdrawCollateral")).to.be.revertedWithCustomError(veil, "EnforcedPause");
  });
});
