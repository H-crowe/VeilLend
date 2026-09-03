import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { MockPriceOracle, TokenMock, VeilLend } from "../typechain-types";
import {
  ACTION_BORROW,
  ACTION_DEPOSIT,
  ACTION_WITHDRAW,
  RiskParams,
  buildRiskTransition,
  buildTransition,
  computeCommitment,
  generateProof,
  makeInitialState,
  requireZkArtifacts,
  verifyLocally,
  type PreparedTransition,
} from "../scripts/prove";

/**
 * Regression tests for the risk_transition action gate fix.
 *
 * The deployed-before-fix circuit enforced `amount <= oldCollateral` for
 * BORROWS (the gate read `(1 - isWithdraw) * (1 - amtLeCol.out) === 0`,
 * which fires when isWithdraw === 0). The corrected gate
 * `isWithdraw * (1 - amtLeCol.out) === 0` restricts that rule to WITHDRAW,
 * leaving borrows governed by the post-action solvency check (LTV) alone.
 *
 * These tests pin the corrected semantics at the circuit level and keep the
 * protocol-level caps (BorrowCapExceeded, replay, recipient binding) intact.
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

// Solvency boundary for colPrice 2e8 / debtPrice 1e8 / LTV 7500 with
// collateral C: C * 2 * 10000 >= D * 1e8 * 7500  =>  D <= C * 8/3.
function solvencyLimit(collateral: bigint): bigint {
  return (collateral * PARAMS.collateralPrice * 10000n) / (PARAMS.debtPrice * PARAMS.maxLtvBps);
}

async function deployFixture() {
  requireZkArtifacts();
  const [owner, user, liquidator] = await ethers.getSigners();
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

  for (const s of [user, liquidator]) {
    await collateral.mint(s.address, 1_000_000n * WAD);
    await debt.mint(s.address, 1_000_000n * WAD);
    await collateral.connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
    await debt.connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
  }
  return { veil, collateral, debt, oracle, owner, user, liquidator };
}

async function depositedPosition(
  veil: VeilLend,
  collateral: TokenMock,
  debt: TokenMock,
  user: { address: string },
  depositAmount: bigint
): Promise<{ id: bigint; state: ReturnType<typeof makeInitialState> }> {
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
  const depT = await buildTransition({
    oldState: state,
    actionId: ACTION_DEPOSIT,
    amount: depositAmount,
    currentIndex,
    newSalt: BigInt(randHex()),
  });
  const depProof = await generateProof(depT.inputs);
  await veil.connect(user as never).deposit(
    {
      positionId: depT.publicSignals[0],
      oldCommitment: depT.publicSignals[1],
      newCommitment: depT.publicSignals[2],
      nullifier: depT.publicSignals[3],
      actionId: depT.publicSignals[4],
      newSequence: depT.publicSignals[5],
      currentIndexLo: depT.publicSignals[6],
      currentIndexHi: depT.publicSignals[7],
      publicAmount: depT.publicSignals[8],
    },
    depProof.callArgs.pA,
    depProof.callArgs.pB,
    depProof.callArgs.pC
  );
  return { id, state: depT.newState };
}

async function borrowWitness(
  veil: VeilLend,
  debt: TokenMock,
  state: ReturnType<typeof makeInitialState>,
  amount: bigint,
  recipient: bigint
): Promise<PreparedTransition> {
  return buildRiskTransition({
    oldState: state,
    actionId: ACTION_BORROW,
    amount,
    currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
    newSalt: BigInt(randHex()),
    params: PARAMS,
    recipient,
  });
}

describe("risk_transition action gate — borrow/withdraw semantics (circuit fix)", () => {
  it("1. borrow below hidden collateral still proves (unchanged path)", async () => {
    const { veil, user, collateral, debt } = await loadFixture(deployFixture);
    const { state } = await depositedPosition(veil, collateral, debt, user, 10n * WAD);
    const t = await borrowWitness(veil, debt, state, 5n * WAD, BigInt(user.address));
    const { proof, publicSignals } = await generateProof(t.inputs, "risk_transition");
    expect(await verifyLocally(publicSignals, proof, "risk_transition")).to.equal(true);
    expect(publicSignals.length).to.equal(13);
  });

  it("2. borrow ABOVE raw collateral but within LTV + solvency now proves (the fix)", async () => {
    const { veil, user, collateral, debt } = await loadFixture(deployFixture);
    const { state } = await depositedPosition(veil, collateral, debt, user, 10n * WAD);
    // 15e18 > 10e18 collateral; solvency limit is 26.67e18 → provable.
    expect(15n * WAD).to.be.greaterThan(10n * WAD);
    expect(15n * WAD).to.be.lessThan(solvencyLimit(10n * WAD));
    const t = await borrowWitness(veil, debt, state, 15n * WAD, BigInt(user.address));
    const { proof, publicSignals } = await generateProof(t.inputs, "risk_transition");
    expect(await verifyLocally(publicSignals, proof, "risk_transition")).to.equal(true);
  });

  it("3. borrow exceeding the LTV solvency limit stays unprovable", async () => {
    const { veil, user, collateral, debt } = await loadFixture(deployFixture);
    const { state } = await depositedPosition(veil, collateral, debt, user, 10n * WAD);
    const t = await borrowWitness(veil, debt, state, 267n * WAD, BigInt(user.address));
    expect(267n * WAD).to.be.greaterThan(solvencyLimit(10n * WAD));
    await expect(generateProof(t.inputs, "risk_transition")).to.be.rejected;
  });

  it("4. the solvency boundary is exact: floor(limit) proves, limit+1 does not", async () => {
    const { veil, user, collateral, debt } = await loadFixture(deployFixture);
    const { state } = await depositedPosition(veil, collateral, debt, user, 10n * WAD);
    const limit = solvencyLimit(10n * WAD); // 266666666666666666666
    const okT = await borrowWitness(veil, debt, state, limit, BigInt(user.address));
    const okProof = await generateProof(okT.inputs, "risk_transition");
    expect(await verifyLocally(okProof.publicSignals, okProof.proof, "risk_transition")).to.equal(true);

    const overT = await borrowWitness(veil, debt, state, limit + 1n, BigInt(user.address));
    await expect(generateProof(overT.inputs, "risk_transition")).to.be.rejected;
  });

  it("5. withdraw above hidden collateral is rejected by the corrected gate", async () => {
    const { veil, user, collateral, debt } = await loadFixture(deployFixture);
    const { state } = await depositedPosition(veil, collateral, debt, user, 10n * WAD);
    // Build a VALID boundary witness (amount == collateral), then raise the
    // amount directly in the circuit inputs: the corrected gate must fail
    // witness generation (isWithdraw == 1 with amount > oldCollateral).
    const t = await buildRiskTransition({
      oldState: state,
      actionId: ACTION_WITHDRAW,
      amount: 10n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: PARAMS,
      recipient: BigInt(user.address),
    });
    const tamperedInputs = { ...t.inputs, amount: (11n * WAD).toString() };
    await expect(generateProof(tamperedInputs, "risk_transition")).to.be.rejected;
  });

  it("6. withdraw of the FULL hidden collateral proves (boundary included)", async () => {
    const { veil, user, collateral, debt } = await loadFixture(deployFixture);
    const { state } = await depositedPosition(veil, collateral, debt, user, 10n * WAD);
    const t = await buildRiskTransition({
      oldState: state,
      actionId: ACTION_WITHDRAW,
      amount: 10n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: PARAMS,
      recipient: BigInt(user.address),
    });
    const { proof, publicSignals } = await generateProof(t.inputs, "risk_transition");
    expect(await verifyLocally(publicSignals, proof, "risk_transition")).to.equal(true);
    expect(t.newState.collateral).to.equal(0n);
  });

  it("7. recipient binding survives the gate fix (tamper breaks the proof)", async () => {
    const { veil, user, collateral, debt } = await loadFixture(deployFixture);
    const { state } = await depositedPosition(veil, collateral, debt, user, 10n * WAD);
    const t = await borrowWitness(veil, debt, state, 5n * WAD, BigInt(user.address));
    const { proof, publicSignals } = await generateProof(t.inputs, "risk_transition");
    expect(await verifyLocally(publicSignals, proof, "risk_transition")).to.equal(true);
    const tampered = [...publicSignals];
    tampered[12] = BigInt(ethers.getAddress(ethers.hexlify(ethers.randomBytes(20)))).toString();
    expect(await verifyLocally(tampered, proof, "risk_transition")).to.equal(false);
  });

  it("8. sequence/nullifier/replay protection intact after the fix", async () => {
    const { veil, user, liquidator, collateral, debt } = await loadFixture(deployFixture);
    // seed liquidity
    const seedId = (await veil.nextPositionId()) + 1n;
    const seedState = makeInitialState({
      positionId: seedId,
      collateralAsset: BigInt(await collateral.getAddress()),
      debtAsset: BigInt(await debt.getAddress()),
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      controlSecret: BigInt(randHex()),
      salt: BigInt(randHex()),
    });
    seedState.debt = 6n * WAD;
    await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(seedState)));
    const repT = await buildTransition({
      oldState: seedState,
      actionId: 2n,
      amount: 6n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
    });
    const repProof = await generateProof(repT.inputs);
    await veil.connect(liquidator as never).repay(
      {
        positionId: repT.publicSignals[0],
        oldCommitment: repT.publicSignals[1],
        newCommitment: repT.publicSignals[2],
        nullifier: repT.publicSignals[3],
        actionId: repT.publicSignals[4],
        newSequence: repT.publicSignals[5],
        currentIndexLo: repT.publicSignals[6],
        currentIndexHi: repT.publicSignals[7],
        publicAmount: repT.publicSignals[8],
      },
      repProof.callArgs.pA,
      repProof.callArgs.pB,
      repProof.callArgs.pC
    );

    const { id, state } = await depositedPosition(veil, collateral, debt, user, 10n * WAD);
    // sequence advances by exactly one per action
    const b1 = await borrowWitness(veil, debt, state, 5n * WAD, BigInt(user.address));
    expect(b1.newState.sequence).to.equal(state.sequence + 1n);

    const toInputs = (p: { publicSignals: string[] }) => ({
      positionId: p.publicSignals[0],
      oldCommitment: p.publicSignals[1],
      newCommitment: p.publicSignals[2],
      nullifier: p.publicSignals[3],
      actionId: p.publicSignals[4],
      newSequence: p.publicSignals[5],
      currentIndexLo: p.publicSignals[6],
      currentIndexHi: p.publicSignals[7],
      publicAmount: p.publicSignals[8],
    });
    const p1 = await generateProof(b1.inputs, "risk_transition");
    await veil.connect(user as never).borrow(toInputs(b1), p1.callArgs.pA, p1.callArgs.pB, p1.callArgs.pC);
    // replaying the same proof must fail closed
    await expect(
      veil.connect(user as never).borrow(toInputs(b1), p1.callArgs.pA, p1.callArgs.pB, p1.callArgs.pC)
    ).to.be.revertedWithCustomError(veil, "TransitionConsumed");
    expect(await veil.borrowOutstanding(id)).to.equal(5n * WAD);
  });

  it("on-chain borrow cap stays enforced: proof-valid borrow above supported*75% reverts with BorrowCapExceeded", async () => {
    const { veil, user, liquidator, collateral, debt } = await loadFixture(deployFixture);
    const seedId = (await veil.nextPositionId()) + 1n;
    const seedState = makeInitialState({
      positionId: seedId,
      collateralAsset: BigInt(await collateral.getAddress()),
      debtAsset: BigInt(await debt.getAddress()),
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      controlSecret: BigInt(randHex()),
      salt: BigInt(randHex()),
    });
    seedState.debt = 80n * WAD;
    await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(seedState)));
    const repT = await buildTransition({
      oldState: seedState,
      actionId: 2n,
      amount: 80n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
    });
    const repProof = await generateProof(repT.inputs);
    await veil.connect(liquidator as never).repay(
      {
        positionId: repT.publicSignals[0],
        oldCommitment: repT.publicSignals[1],
        newCommitment: repT.publicSignals[2],
        nullifier: repT.publicSignals[3],
        actionId: repT.publicSignals[4],
        newSequence: repT.publicSignals[5],
        currentIndexLo: repT.publicSignals[6],
        currentIndexHi: repT.publicSignals[7],
        publicAmount: repT.publicSignals[8],
      },
      repProof.callArgs.pA,
      repProof.callArgs.pB,
      repProof.callArgs.pC
    );

    const { state } = await depositedPosition(veil, collateral, debt, user, 100n * WAD);
    // 80e18: provable in-circuit (solvency limit 266.67e18), above the
    // on-chain cap of supported * 75% = 75e18.
    const b = await borrowWitness(veil, debt, state, 80n * WAD, BigInt(user.address));
    const { callArgs, publicSignals } = await generateProof(b.inputs, "risk_transition");
    const inputs = {
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
    await expect(
      veil.connect(user as never).borrow(inputs, callArgs.pA, callArgs.pB, callArgs.pC)
    ).to.be.revertedWithCustomError(veil, "BorrowCapExceeded");
  });
});
