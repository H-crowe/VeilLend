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
  verifyLocally,
} from "../scripts/prove";

/**
 * F5 closure — cryptographic recipient binding.
 *
 * Every outbound value-moving action (borrow / withdrawCollateral / liquidate)
 * commits the authorized recipient as a PUBLIC circuit input; the contract
 * derives that input from msg.sender, so a proof is only verifiable when its
 * committed recipient IS the transaction sender. A copied mempool proof
 * submitted by a different wallet fails verification.
 *
 * Tests A–I below map to the F5 requirement list.
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
const RISK_PARAMS = { collateralPrice: 2n * 10n ** 8n, debtPrice: 1n * 10n ** 8n, maxLtvBps: 7500n };
const LIQ_PARAMS = { collateralPrice: 2n * 10n ** 8n, debtPrice: 1n * 10n ** 8n, liquidationThresholdBps: 8500n };

const randHex = () => ethers.hexlify(ethers.randomBytes(31));
const bytes32 = (v: bigint) => ethers.zeroPadValue(ethers.toBeHex(v), 32);

async function deployFixture() {
  requireZkArtifacts();
  const [owner, victim, attacker, liquidator] = await ethers.getSigners();
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
  await oracle.setPrice(await collateral.getAddress(), RISK_PARAMS.collateralPrice);
  await oracle.setPrice(await debt.getAddress(), RISK_PARAMS.debtPrice);

  for (const s of [victim, attacker, liquidator]) {
    await collateral.mint(s.address, 1_000_000n * WAD);
    await debt.mint(s.address, 1_000_000n * WAD);
    await collateral.connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
    await debt.connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
  }
  return { veil, collateral, debt, owner, victim, attacker, liquidator };
}

async function setupVictimPosition(veil: VeilLend, collateral: TokenMock, debt: TokenMock, victim: { address: string }) {
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
  const dep = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 100n * WAD, currentIndex, newSalt: BigInt(randHex()) });
  const depProof = await generateProof(dep.inputs);
  const ps = dep.publicSignals;
  await veil.connect(victim as never).deposit(
    { positionId: ps[0], oldCommitment: ps[1], newCommitment: ps[2], nullifier: ps[3], actionId: ps[4], newSequence: ps[5], currentIndexLo: ps[6], currentIndexHi: ps[7], publicAmount: ps[8] },
    depProof.callArgs.pA,
    depProof.callArgs.pB,
    depProof.callArgs.pC
  );
  return { id, state: dep.newState };
}

async function seedLiquidity(veil: VeilLend, collateral: TokenMock, debt: TokenMock, liquidator: { address: string }) {
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
  state.debt = 50n * WAD;
  await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(state)));
  const rep = await buildTransition({ oldState: state, actionId: 2n, amount: 50n * WAD, currentIndex, newSalt: BigInt(randHex()) });
  const repProof = await generateProof(rep.inputs);
  const ps = rep.publicSignals;
  await veil.connect(liquidator as never).repay(
    { positionId: ps[0], oldCommitment: ps[1], newCommitment: ps[2], nullifier: ps[3], actionId: ps[4], newSequence: ps[5], currentIndexLo: ps[6], currentIndexHi: ps[7], publicAmount: ps[8] },
    repProof.callArgs.pA,
    repProof.callArgs.pB,
    repProof.callArgs.pC
  );
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

describe("F5 — cryptographic recipient binding", () => {
  it("A: owner-generated proof with owner as sender succeeds (withdraw)", async () => {
    const { veil, victim, collateral, debt } = await loadFixture(deployFixture);
    const { id, state } = await setupVictimPosition(veil, collateral, debt, victim);

    const w = await buildRiskTransition({
      oldState: state,
      actionId: ACTION_WITHDRAW,
      amount: 10n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: RISK_PARAMS,
      recipient: BigInt(victim.address), // bound to the actual sender
    });
    const { callArgs } = await generateProof(w.inputs, "risk_transition");
    const balBefore = await collateral.balanceOf(victim.address);
    await veil.connect(victim).withdrawCollateral(toInputs(w.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC);
    expect(await collateral.balanceOf(victim.address)).to.equal(balBefore + 10n * WAD);
    void id;
  });

  it("B: the exact same withdraw proof submitted by the attacker MUST revert", async () => {
    const { veil, victim, attacker, collateral, debt } = await loadFixture(deployFixture);
    const { state } = await setupVictimPosition(veil, collateral, debt, victim);

    // victim generates a proof binding recipient = victim
    const w = await buildRiskTransition({
      oldState: state,
      actionId: ACTION_WITHDRAW,
      amount: 10n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: RISK_PARAMS,
      recipient: BigInt(victim.address),
    });
    const { callArgs } = await generateProof(w.inputs, "risk_transition");

    // attacker copies the exact proof + public signals (memPool theft) — the
    // contract inserts attacker as recipient, so verification fails
    await expect(veil.connect(attacker).withdrawCollateral(toInputs(w.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC)).to.be.revertedWithCustomError(
      veil,
      "InvalidProof"
    );
    expect(await veil.collateralCustody(await collateral.getAddress())).to.equal(100n * WAD);
    void collateral;
  });

  it("C: modifying the recipient after proof generation makes verification fail", async () => {
    const { veil, victim, attacker, collateral, debt } = await loadFixture(deployFixture);
    const { state } = await setupVictimPosition(veil, collateral, debt, victim);

    const w = await buildRiskTransition({
      oldState: state,
      actionId: ACTION_WITHDRAW,
      amount: 10n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: RISK_PARAMS,
      recipient: BigInt(victim.address),
    });
    const { proof, publicSignals } = await generateProof(w.inputs, "risk_transition");
    expect(await verifyLocally(publicSignals, proof, "risk_transition")).to.equal(true);

    // tamper with the committed recipient in the public inputs
    const tampered = [...publicSignals];
    tampered[12] = BigInt(attacker.address).toString();
    expect(await verifyLocally(tampered, proof, "risk_transition")).to.equal(false);

    // on-chain there is no way to present modified recipient data at all: the
    // contract always inserts msg.sender (exercised by test B).
    void collateral;
    void debt;
  });

  it("D: the same attack against borrow MUST revert", async () => {
    const { veil, victim, attacker, collateral, debt, liquidator } = await loadFixture(deployFixture);
    await seedLiquidity(veil, collateral, debt, liquidator);
    const { id, state } = await setupVictimPosition(veil, collateral, debt, victim);

    const b = await buildRiskTransition({
      oldState: state,
      actionId: ACTION_BORROW,
      amount: 10n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: RISK_PARAMS,
      recipient: BigInt(victim.address),
    });
    const { callArgs } = await generateProof(b.inputs, "risk_transition");

    const attackerDebtBefore = await debt.balanceOf(attacker.address);
    await expect(veil.connect(attacker).borrow(toInputs(b.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC)).to.be.revertedWithCustomError(
      veil,
      "InvalidProof"
    );
    expect(await debt.balanceOf(attacker.address)).to.equal(attackerDebtBefore);
    expect(await veil.debtCustody(await debt.getAddress())).to.equal(50n * WAD); // reserve untouched

    // and the victim can still execute their own proof
    await veil.connect(victim).borrow(toInputs(b.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC);
    expect(await veil.borrowOutstanding(id)).to.equal(10n * WAD);
  });

  it("E: the same attack against withdrawCollateral with a poisoned recipient signal reverts", async () => {
    const { veil, victim, attacker, collateral, debt } = await loadFixture(deployFixture);
    const { state } = await setupVictimPosition(veil, collateral, debt, victim);

    // attacker re-generates the victim's witness but swaps the recipient to
    // themselves — the proof no longer matches (the witness commitment to
    // recipient is part of what was proven), and the on-chain derivation
    // from msg.sender makes it fail regardless.
    const w = await buildRiskTransition({
      oldState: state,
      actionId: ACTION_WITHDRAW,
      amount: 10n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: RISK_PARAMS,
      recipient: BigInt(attacker.address), // poisoned recipient
    });
    const { callArgs } = await generateProof(w.inputs, "risk_transition");
    // even submitted by the attacker themselves, the contract binds to
    // msg.sender (= attacker here it would match!) — so submit it from the
    // victim's view: the signals bind attacker while the contract inserts
    // victim → fails. The reverse case is test B.
    await expect(veil.connect(victim).withdrawCollateral(toInputs(w.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC)).to.be.revertedWithCustomError(
      veil,
      "InvalidProof"
    );
    expect(await veil.collateralCustody(await collateral.getAddress())).to.equal(100n * WAD);
  });

  it("F: the same attack against liquidate MUST revert (settlement cannot be redirected)", async () => {
    const { veil, victim, attacker, liquidator, collateral, debt } = await loadFixture(deployFixture);

    // underwater position: hidden debt 300e18 vs collateral 100e18 (val 200 < 255)
    const uid = (await veil.nextPositionId()) + 1n;
    const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
    const uState = makeInitialState({
      positionId: uid,
      collateralAsset: BigInt(await collateral.getAddress()),
      debtAsset: BigInt(await debt.getAddress()),
      currentIndex,
      controlSecret: BigInt(randHex()),
      salt: BigInt(randHex()),
    });
    uState.debt = 300n * WAD;
    await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(uState)));
    const uDep = await buildTransition({ oldState: uState, actionId: ACTION_DEPOSIT, amount: 100n * WAD, currentIndex, newSalt: BigInt(randHex()) });
    const uDepProof = await generateProof(uDep.inputs);
    const ps = uDep.publicSignals;
    await veil.connect(victim as never).deposit(
      { positionId: ps[0], oldCommitment: ps[1], newCommitment: ps[2], nullifier: ps[3], actionId: ps[4], newSequence: ps[5], currentIndexLo: ps[6], currentIndexHi: ps[7], publicAmount: ps[8] },
      uDepProof.callArgs.pA,
      uDepProof.callArgs.pB,
      uDepProof.callArgs.pC
    );
    const uAfter = uDep.newState;

    // liquidator generates the eligibility proof binding themselves as recipient
    const w = await buildLiquidationWitness(uAfter, LIQ_PARAMS, BigInt(liquidator.address));
    const { callArgs } = await generateProof(w.inputs, "liquidation");

    // attacker copies the proof to steal the settlement
    const attackerCollBefore = await collateral.balanceOf(attacker.address);
    await expect(
      veil.connect(attacker).liquidate(uid, w.amounts.collateralOut, w.amounts.debtOut, callArgs.pA, callArgs.pB, callArgs.pC)
    ).to.be.revertedWithCustomError(veil, "InvalidProof");
    expect(await collateral.balanceOf(attacker.address)).to.equal(attackerCollBefore);

    // the authorized liquidator executes successfully
    await veil.connect(liquidator).liquidate(uid, w.amounts.collateralOut, w.amounts.debtOut, callArgs.pA, callArgs.pB, callArgs.pC);
    expect((await veil.positions(uid)).status).to.equal(2); // Closed
  });

  it("G: replay protection still works after recipient binding", async () => {
    const { veil, victim, collateral, debt } = await loadFixture(deployFixture);
    const { state } = await setupVictimPosition(veil, collateral, debt, victim);
    const w = await buildRiskTransition({
      oldState: state,
      actionId: ACTION_WITHDRAW,
      amount: 10n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: RISK_PARAMS,
      recipient: BigInt(victim.address),
    });
    const { callArgs } = await generateProof(w.inputs, "risk_transition");
    await veil.connect(victim).withdrawCollateral(toInputs(w.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC);
    // even the ORIGINAL sender cannot replay the same proof
    await expect(veil.connect(victim).withdrawCollateral(toInputs(w.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC)).to.be.revertedWithCustomError(
      veil,
      "TransitionConsumed"
    );
  });

  it("H: fabricated-collateral protections (F1/F2) remain intact", async () => {
    const { veil, attacker, collateral, debt } = await loadFixture(deployFixture);
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
    state.collateral = 500n * WAD; // fabricated
    await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(state)));

    const w = await buildRiskTransition({
      oldState: state,
      actionId: ACTION_WITHDRAW,
      amount: 100n * WAD,
      currentIndex,
      newSalt: BigInt(randHex()),
      params: RISK_PARAMS,
      recipient: BigInt(attacker.address),
    });
    const { callArgs } = await generateProof(w.inputs, "risk_transition");
    await expect(veil.connect(attacker).withdrawCollateral(toInputs(w.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC)).to.be.revertedWithCustomError(
      veil,
      "UnsupportedCollateral"
    );
  });

  it("I: stale oracle protections remain intact on bound transitions", async () => {
    const { veil, victim, collateral, debt, owner } = await loadFixture(deployFixture);
    const { state } = await setupVictimPosition(veil, collateral, debt, victim);
    const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
    const w = await buildRiskTransition({
      oldState: state,
      actionId: ACTION_WITHDRAW,
      amount: 10n * WAD,
      currentIndex,
      newSalt: BigInt(randHex()),
      params: RISK_PARAMS,
      recipient: BigInt(victim.address),
    });
    const { callArgs } = await generateProof(w.inputs, "risk_transition");
    // prices go stale → risky transition fails closed before proof logic
    await owner.sendTransaction({ to: victim.address, value: 0 }); // mine a block
    await ethers.provider.send("evm_increaseTime", [2 * 3600]);
    await ethers.provider.send("evm_mine", []);
    await expect(veil.connect(victim).withdrawCollateral(toInputs(w.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC)).to.be.revertedWithCustomError(
      veil,
      "StalePrice"
    );
  });
});
