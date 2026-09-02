import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { MockPriceOracle, TokenMock, VeilLend } from "../typechain-types";
import {
  ACTION_BORROW,
  ACTION_DEPOSIT,
  ACTION_WITHDRAW,
  buildLiquidationWitness,
  buildRiskTransition,
  buildTransition,
  computeCommitment,
  generateProof,
  makeInitialState,
  requireZkArtifacts,
} from "../scripts/prove";

/**
 * Regression tests for the Phase 3 security-review blocking findings F1/F2/F3:
 * fabricated initial commitments (hidden collateral that was never deposited)
 * must be economically inert. The per-position supported-collateral ledger
 * caps every exit, so these attacks revert even when the aggregate pool is
 * fully funded — proving the boundary is per-position, not aggregate.
 */

const WAD = 10n ** 18n;
const RATE = {
  baseRateBps: 500,
  slopeBps: 2000,
  targetUtilizationBps: 8000,
  reserveFactorBps: 1000,
  maxLtvBps: 7_500,
  liquidationThresholdBps: 8_500,
};
const PARAMS = { collateralPrice: 2n * 10n ** 8n, debtPrice: 1n * 10n ** 8n, maxLtvBps: 7500n };
const LIQ_PARAMS = { collateralPrice: 2n * 10n ** 8n, debtPrice: 1n * 10n ** 8n, liquidationThresholdBps: 8500n };

const randHex = () => ethers.hexlify(ethers.randomBytes(31));
const bytes32 = (v: bigint) => ethers.zeroPadValue(ethers.toBeHex(v), 32);

async function deployFixture() {
  requireZkArtifacts();
  const [owner, attacker, victim, liquidator] = await ethers.getSigners();
  const collateral = (await (await ethers.getContractFactory("TokenMock")).deploy("Collateral", "COL")) as TokenMock;
  const debt = (await (await ethers.getContractFactory("TokenMock")).deploy("Debt", "DBT")) as TokenMock;
  const oracle = (await (await ethers.getContractFactory("MockPriceOracle")).deploy()) as MockPriceOracle;
  const verifier = await (await ethers.getContractFactory("Groth16Verifier")).deploy();
  const solvencyVerifier = await (await ethers.getContractFactory("SolvencyVerifier")).deploy();
  const riskVerifier = await (await ethers.getContractFactory("RiskTransitionVerifier")).deploy();
  const liquidationVerifier = await (await ethers.getContractFactory("LiquidationVerifier")).deploy();
  const veil = (await (await ethers.getContractFactory("VeilLend")).deploy(
    owner.address,
    await verifier.getAddress(),
    await solvencyVerifier.getAddress(),
    await riskVerifier.getAddress(),
    await liquidationVerifier.getAddress(),
    await oracle.getAddress()
  )) as VeilLend;

  await veil.connect(owner).enableCollateralAsset(await collateral.getAddress());
  await veil.connect(owner).enableDebtAsset(await debt.getAddress(), RATE);
  await oracle.setPrice(await collateral.getAddress(), PARAMS.collateralPrice);
  await oracle.setPrice(await debt.getAddress(), PARAMS.debtPrice);

  for (const s of [attacker, victim, liquidator]) {
    await collateral.mint(s.address, 1_000_000n * WAD);
    await debt.mint(s.address, 1_000_000n * WAD);
    await collateral.connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
    await debt.connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
  }
  return { veil, collateral, debt, owner, attacker, victim, liquidator };
}

/** Creates a position whose initial hidden state claims `claimedCollateral`. */
async function createFabricatedPosition(
  veil: VeilLend,
  collateral: TokenMock,
  debt: TokenMock,
  claimedCollateral: bigint,
  claimedDebt = 0n
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
  state.collateral = claimedCollateral; // FABRICATED — nothing was ever deposited
  state.debt = claimedDebt;
  await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(state)));
  return { id, state };
}

function toInputs(publicSignals: bigint[]) {
  return {
    positionId: publicSignals[0],
    oldCommitment: publicSignals[1],
    newCommitment: publicSignals[2],
    nullifier: publicSignals[3],
    actionId: publicSignals[4],
    newSequence: publicSignals[5],
    currentIndexLo: publicSignals[6],
    currentIndexHi: publicSignals[7],
    publicAmount: publicSignals[8],
  };
}

describe("F1/F2/F3 regressions — fabricated initial commitments are inert", () => {
  it("Attack A: withdrawal against a fabricated collateral claim reverts even with a funded pool", async () => {
    const { veil, victim, attacker, collateral, debt } = await loadFixture(deployFixture);

    // honest user funds the pool so AGGREGATE custody would cover the attack
    const honestId = (await veil.nextPositionId()) + 1n;
    const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
    const honestState = makeInitialState({
      positionId: honestId,
      collateralAsset: BigInt(await collateral.getAddress()),
      debtAsset: BigInt(await debt.getAddress()),
      currentIndex,
      controlSecret: BigInt(randHex()),
      salt: BigInt(randHex()),
    });
    await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(honestState)));
    const dep = await buildTransition({
      oldState: honestState,
      actionId: ACTION_DEPOSIT,
      amount: 500n * WAD,
      currentIndex,
      newSalt: BigInt(randHex()),
    });
    const depProof = await generateProof(dep.inputs);
    await veil.connect(victim).deposit(toInputs(dep.publicSignals), depProof.callArgs.pA, depProof.callArgs.pB, depProof.callArgs.pC);
    expect(await veil.collateralCustody(await collateral.getAddress())).to.equal(500n * WAD); // pool fully funded

    // attacker fabricates a position claiming 50e18 hidden collateral, deposits nothing
    const { id, state } = await createFabricatedPosition(veil, collateral, debt, 50n * WAD);
    expect(await veil.supportedCollateral(id)).to.equal(0n);

    // the withdraw proof itself is generatable (the circuit cannot see custody)…
    const w = await buildRiskTransition({
      oldState: state,
      actionId: ACTION_WITHDRAW,
      amount: 50n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: PARAMS,
      recipient: BigInt(attacker.address),
    });
    const { callArgs } = await generateProof(w.inputs, "risk_transition");
    // …but the contract must reject it on the per-position supported ledger.
    await expect(veil.connect(attacker).withdrawCollateral(toInputs(w.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC)).to.be.revertedWithCustomError(
      veil,
      "UnsupportedCollateral"
    );

    // pool untouched
    expect(await veil.collateralCustody(await collateral.getAddress())).to.equal(500n * WAD);
    expect(await collateral.balanceOf(attacker.address)).to.equal(1_000_000n * WAD);
  });

  it("Attack B: borrowing against fabricated collateral reverts even with seeded liquidity", async () => {
    const { veil, victim, attacker, liquidator, collateral, debt } = await loadFixture(deployFixture);

    // seed borrowable liquidity via an honest repayment
    const honestId = (await veil.nextPositionId()) + 1n;
    const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
    const honestState = makeInitialState({
      positionId: honestId,
      collateralAsset: BigInt(await collateral.getAddress()),
      debtAsset: BigInt(await debt.getAddress()),
      currentIndex,
      controlSecret: BigInt(randHex()),
      salt: BigInt(randHex()),
    });
    honestState.debt = 20n * WAD; // originated debt repaid to seed the reserve
    await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(honestState)));
    const rep = await buildTransition({
      oldState: honestState,
      actionId: 2n, // repay
      amount: 20n * WAD,
      currentIndex,
      newSalt: BigInt(randHex()),
    });
    const repProof = await generateProof(rep.inputs);
    await veil.connect(liquidator as never).repay(toInputs(rep.publicSignals), repProof.callArgs.pA, repProof.callArgs.pB, repProof.callArgs.pC);
    expect(await veil.debtCustody(await debt.getAddress())).to.equal(20n * WAD); // liquidity available

    // fabricated position claims 50e18 hidden collateral, borrows 10e18
    const { id, state } = await createFabricatedPosition(veil, collateral, debt, 50n * WAD);
    const b = await buildRiskTransition({
      oldState: state,
      actionId: ACTION_BORROW,
      amount: 10n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: PARAMS,
      recipient: BigInt(attacker.address),
    });
    const { callArgs } = await generateProof(b.inputs, "risk_transition");
    await expect(veil.connect(attacker).borrow(toInputs(b.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC)).to.be.revertedWithCustomError(
      veil,
      "BorrowCapExceeded"
    );

    // reserve untouched
    expect(await veil.debtCustody(await debt.getAddress())).to.equal(20n * WAD);
    expect(await debt.balanceOf(attacker.address)).to.equal(1_000_000n * WAD);
  });

  it("Liquidation regression: seizure against a fabricated claim reverts", async () => {
    const { veil, victim, attacker, liquidator, collateral, debt } = await loadFixture(deployFixture);

    // fund the pool honestly
    const honestId = (await veil.nextPositionId()) + 1n;
    const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
    const honestState = makeInitialState({
      positionId: honestId,
      collateralAsset: BigInt(await collateral.getAddress()),
      debtAsset: BigInt(await debt.getAddress()),
      currentIndex,
      controlSecret: BigInt(randHex()),
      salt: BigInt(randHex()),
    });
    await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(honestState)));
    const dep = await buildTransition({
      oldState: honestState,
      actionId: ACTION_DEPOSIT,
      amount: 500n * WAD,
      currentIndex,
      newSalt: BigInt(randHex()),
    });
    const depProof = await generateProof(dep.inputs);
    await veil.connect(victim).deposit(toInputs(dep.publicSignals), depProof.callArgs.pA, depProof.callArgs.pB, depProof.callArgs.pC);

    // fabricated underwater position: claims 50e18 collateral (supported 0), debt 200e18 → eligible
    const { id, state } = await createFabricatedPosition(veil, collateral, debt, 50n * WAD, 200n * WAD);
    const w = await buildLiquidationWitness(state, LIQ_PARAMS, BigInt(liquidator.address));
    expect(w.amounts).to.deep.equal({ collateralOut: 50n * WAD, debtOut: 100n * WAD });
    const { callArgs } = await generateProof(w.inputs, "liquidation");
    await expect(
      veil.connect(liquidator).liquidate(id, w.amounts.collateralOut, w.amounts.debtOut, callArgs.pA, callArgs.pB, callArgs.pC)
    ).to.be.revertedWithCustomError(veil, "UnsupportedCollateral");

    expect(await veil.collateralCustody(await collateral.getAddress())).to.equal(500n * WAD);
    expect((await veil.positions(id)).status).to.equal(1); // still Active
  });

  it("honest positions retain full functionality under the cap", async () => {
    const { veil, victim, collateral, debt } = await loadFixture(deployFixture);
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
    await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(state)));

    // deposit 100e18 → supported 100e18, borrow cap 75e18
    const dep = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 100n * WAD, currentIndex, newSalt: BigInt(randHex()) });
    const depProof = await generateProof(dep.inputs);
    await veil.connect(victim).deposit(toInputs(dep.publicSignals), depProof.callArgs.pA, depProof.callArgs.pB, depProof.callArgs.pC);
    expect(await veil.supportedCollateral(id)).to.equal(100n * WAD);

    // borrow up to the cap works (need liquidity: seed via a second honest repay)
    const seedId = (await veil.nextPositionId()) + 1n;
    const seedState = makeInitialState({
      positionId: seedId,
      collateralAsset: BigInt(await collateral.getAddress()),
      debtAsset: BigInt(await debt.getAddress()),
      currentIndex,
      controlSecret: BigInt(randHex()),
      salt: BigInt(randHex()),
    });
    seedState.debt = 100n * WAD;
    await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(seedState)));
    const rep = await buildTransition({ oldState: seedState, actionId: 2n, amount: 100n * WAD, currentIndex, newSalt: BigInt(randHex()) });
    const repProof = await generateProof(rep.inputs);
    await veil.connect(victim).repay(toInputs(rep.publicSignals), repProof.callArgs.pA, repProof.callArgs.pB, repProof.callArgs.pC);

    const b = await buildRiskTransition({
      oldState: dep.newState,
      actionId: ACTION_BORROW,
      amount: 75n * WAD, // exactly at the cap: 100e18 * 7500 / 10000
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: PARAMS,
      recipient: BigInt(victim.address),
    });
    const bProof = await generateProof(b.inputs, "risk_transition");
    await veil.connect(victim).borrow(toInputs(b.publicSignals), bProof.callArgs.pA, bProof.callArgs.pB, bProof.callArgs.pC);
    expect(await veil.borrowOutstanding(id)).to.equal(75n * WAD);

    // one wei above the cap is rejected
    const b2 = await buildRiskTransition({
      oldState: b.newState,
      actionId: ACTION_BORROW,
      amount: 1n,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: PARAMS,
      recipient: BigInt(victim.address),
    });
    const b2Proof = await generateProof(b2.inputs, "risk_transition");
    await expect(veil.connect(victim).borrow(toInputs(b2.publicSignals), b2Proof.callArgs.pA, b2Proof.callArgs.pB, b2Proof.callArgs.pC)).to.be
      .revertedWithCustomError(veil, "BorrowCapExceeded");

    // repayment restores capacity (repay 80e18 incl. interest → outstanding clamps to 0)
    const r = await buildTransition({
      oldState: b.newState,
      actionId: 2n,
      amount: 80n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
    });
    const rProof = await generateProof(r.inputs);
    await veil.connect(victim).repay(toInputs(r.publicSignals), rProof.callArgs.pA, rProof.callArgs.pB, rProof.callArgs.pC);
    expect(await veil.borrowOutstanding(id)).to.equal(0n);

    const b3 = await buildRiskTransition({
      oldState: r.newState,
      actionId: ACTION_BORROW,
      amount: 1n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: PARAMS,
      recipient: BigInt(victim.address),
    });
    const b3Proof = await generateProof(b3.inputs, "risk_transition");
    await veil.connect(victim).borrow(toInputs(b3.publicSignals), b3Proof.callArgs.pA, b3Proof.callArgs.pB, b3Proof.callArgs.pC);

    // withdrawal of 100e18 would leave the 1-wei debt unservable → circuit rejects
    const wAll = await buildRiskTransition({
      oldState: b3.newState,
      actionId: ACTION_WITHDRAW,
      amount: 100n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: PARAMS,
      recipient: BigInt(victim.address),
    });
    await expect(generateProof(wAll.inputs, "risk_transition")).to.be.rejected;

    // solvent withdrawal of 99e18 succeeds (1e18 stays as collateral against the 1-wei debt)
    const w = await buildRiskTransition({
      oldState: b3.newState,
      actionId: ACTION_WITHDRAW,
      amount: 99n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: PARAMS,
      recipient: BigInt(victim.address),
    });
    const wProof = await generateProof(w.inputs, "risk_transition");
    // 99e18 ≤ supported (100e18) and solvent → succeeds
    await veil.connect(victim).withdrawCollateral(toInputs(w.publicSignals), wProof.callArgs.pA, wProof.callArgs.pB, wProof.callArgs.pC);
    expect(await veil.supportedCollateral(id)).to.equal(1n * WAD);
    // For honestly-originated positions hidden collateral == supported
    // collateral, so the UnsupportedCollateral path is unreachable there —
    // Attack A above exercises it against fabricated claims.
  });
});
