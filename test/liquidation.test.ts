import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { MockPriceOracle, TokenMock, VeilLend } from "../typechain-types";
import {
  ACTION_DEPOSIT,
  LiquidationParams,
  buildLiquidationWitness,
  buildTransition,
  computeCommitment,
  generateProof,
  isLiquidatable,
  makeInitialState,
  requireZkArtifacts,
  verifyLocally,
} from "../scripts/prove";

/**
 * Phase 3, Milestone 3 — liquidation eligibility proof + confidential settlement.
 *
 * The circuit proves eligibility (collateralValue < debtValue * threshold)
 * over the hidden state and OUTPUTS the settlement amounts (full collateral,
 * parity-capped debt). The contract verifies against on-chain commitment +
 * fresh prices + configured threshold, pulls the settlement debt from the
 * liquidator, transfers the seized collateral out, and closes the position.
 */

const WAD = 10n ** 18n;
const PARAMS: LiquidationParams = { collateralPrice: 2n * 10n ** 8n, debtPrice: 1n * 10n ** 8n, liquidationThresholdBps: 8500n };
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

/** Creates + funds a position with the given private collateral/debt. */
async function setupPosition(
  veil: VeilLend,
  collateral: TokenMock,
  debt: TokenMock,
  user: { address: string },
  hiddenCollateral: bigint,
  hiddenDebt: bigint
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
  state.debt = hiddenDebt;
  await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(state)));
  if (hiddenCollateral > 0n) {
    const newSalt = BigInt(randHex());
    const t = await buildTransition({
      oldState: state,
      actionId: ACTION_DEPOSIT,
      amount: hiddenCollateral,
      currentIndex,
      newSalt,
    });
    const { callArgs } = await generateProof(t.inputs);
    const ps = t.publicSignals;
    await veil.connect(user as never).deposit(
      { positionId: ps[0], oldCommitment: ps[1], newCommitment: ps[2], nullifier: ps[3], actionId: ps[4], newSequence: ps[5], currentIndexLo: ps[6], currentIndexHi: ps[7], publicAmount: ps[8] },
      callArgs.pA,
      callArgs.pB,
      callArgs.pC
    );
    state.collateral = hiddenCollateral;
    state.sequence = 1n;
    state.salt = newSalt;
  }
  return { id, state };
}

function toLiquidationArgs(publicSignals: bigint[]) {
  return {
    collateralOut: publicSignals[0],
    debtOut: publicSignals[1],
    positionId: publicSignals[2],
    positionCommitment: publicSignals[3],
    collateralPrice: publicSignals[4],
    debtPrice: publicSignals[5],
    liquidationThresholdBps: publicSignals[6],
  };
}

describe("Phase 3 M3 — liquidation eligibility + confidential settlement", () => {
  describe("Circuit level", () => {
    before(() => requireZkArtifacts("liquidation"));

    it("proves eligibility and outputs settlement amounts for an underwater position", async () => {
      // col 100e18 (val 200) vs debt 300e18 (val 300 · 0.85 = 255): 200 < 255 ✓ eligible
      const state = makeInitialState({
        positionId: 1n,
        collateralAsset: 0x101n,
        debtAsset: 0x102n,
        currentIndex: WAD,
        controlSecret: BigInt(randHex()),
        salt: BigInt(randHex()),
      });
      state.collateral = 100n * WAD;
      state.debt = 300n * WAD;
      expect(isLiquidatable(state, PARAMS)).to.equal(true);

      const w = await buildLiquidationWitness(state, PARAMS, 0xa11ce00000000000000000000000000000000001n);
      expect(w.amounts).to.deep.equal({ collateralOut: 100n * WAD, debtOut: 200n * WAD }); // parity: 100·2/1
      const { proof, publicSignals } = await generateProof(w.inputs, "liquidation");
      expect(publicSignals.map(BigInt)).to.deep.equal(w.publicSignals); // exact order, outputs first
      expect(await verifyLocally(publicSignals.map(String), proof, "liquidation")).to.equal(true);
    });

    it("rejects a healthy (non-eligible) position", async () => {
      const state = makeInitialState({
        positionId: 1n,
        collateralAsset: 0x101n,
        debtAsset: 0x102n,
        currentIndex: WAD,
        controlSecret: BigInt(randHex()),
        salt: BigInt(randHex()),
      });
      state.collateral = 100n * WAD;
      state.debt = 200n * WAD; // colVal 200 vs threshold 200·0.85 = 170 → 200 < 170 false
      expect(isLiquidatable(state, PARAMS)).to.equal(false);
      const w = await buildLiquidationWitness(state, PARAMS, 0xa11ce00000000000000000000000000000000001n);
      await expect(generateProof(w.inputs, "liquidation")).to.be.rejected;
    });

    it("treats exact-threshold positions as NOT eligible (strict inequality)", async () => {
      // colVal·10000 == debtVal·threshold → not strictly less → unprovable
      const state = makeInitialState({
        positionId: 1n,
        collateralAsset: 0x101n,
        debtAsset: 0x102n,
        currentIndex: WAD,
        controlSecret: BigInt(randHex()),
        salt: BigInt(randHex()),
      });
      state.collateral = 85n * WAD; // val 170·1e8
      state.debt = 200n * WAD; // val 200·1e8; 170·10000 = 200·8500 exactly
      expect(isLiquidatable(state, PARAMS)).to.equal(false);
      const w = await buildLiquidationWitness(state, PARAMS, 0xa11ce00000000000000000000000000000000001n);
      await expect(generateProof(w.inputs, "liquidation")).to.be.rejected;
    });

    it("rejects tampered outputs", async () => {
      const state = makeInitialState({
        positionId: 1n,
        collateralAsset: 0x101n,
        debtAsset: 0x102n,
        currentIndex: WAD,
        controlSecret: BigInt(randHex()),
        salt: BigInt(randHex()),
      });
      state.collateral = 100n * WAD;
      state.debt = 300n * WAD;
      const w = await buildLiquidationWitness(state, PARAMS, 0xa11ce00000000000000000000000000000000001n);
      const { proof, publicSignals } = await generateProof(w.inputs, "liquidation");
      const wrong = [...publicSignals.map(String)];
      wrong[0] = (BigInt(wrong[0]) + 1n).toString(); // inflated collateralOut
      expect(await verifyLocally(wrong, proof, "liquidation")).to.equal(false);
    });
  });

  describe("On-chain settlement", () => {
    it("liquidates an underwater position end-to-end with custody conservation", async () => {
      const { veil, user, liquidator, collateral, debt } = await loadFixture(deployFixture);
      const { id, state } = await setupPosition(veil, collateral, debt, user, 100n * WAD, 300n * WAD);

      const custodyBefore = await veil.collateralCustody(await collateral.getAddress());
      const w = await buildLiquidationWitness(state, PARAMS, BigInt(liquidator.address));
      const { callArgs } = await generateProof(w.inputs, "liquidation");
      const args = toLiquidationArgs(w.publicSignals);

      const liqCollBefore = await collateral.balanceOf(liquidator.address);
      const liqDebtBefore = await debt.balanceOf(liquidator.address);
      await expect(veil.connect(liquidator).liquidate(id, args.collateralOut, args.debtOut, callArgs.pA, callArgs.pB, callArgs.pC))
        .to.emit(veil, "Liquidated")
        .withArgs(id, await collateral.getAddress(), await debt.getAddress(), 100n * WAD, 200n * WAD);

      // settlement balances
      expect(await collateral.balanceOf(liquidator.address)).to.equal(liqCollBefore + 100n * WAD);
      expect(await debt.balanceOf(liquidator.address)).to.equal(liqDebtBefore - 200n * WAD);

      // custody conservation: collateral custody decreased 1:1 with the hidden
      // collateral removal; debt custody gained the settlement payment
      expect(await veil.collateralCustody(await collateral.getAddress())).to.equal(custodyBefore - 100n * WAD);
      expect(await debt.balanceOf(await veil.getAddress())).to.equal(await veil.debtCustody(await debt.getAddress()));

      // position is closed
      expect((await veil.positions(id)).status).to.equal(2); // Closed
    });

    it("is permissionless: any account can submit the proof for settlement", async () => {
      const { veil, user, liquidator, collateral, debt } = await loadFixture(deployFixture);
      const { id, state } = await setupPosition(veil, collateral, debt, user, 100n * WAD, 300n * WAD);
      const w = await buildLiquidationWitness(state, PARAMS, BigInt(liquidator.address));
      const { callArgs } = await generateProof(w.inputs, "liquidation");
      const args = toLiquidationArgs(w.publicSignals);
      // liquidator account executes; the proof holder's identity is irrelevant on-chain
      await veil.connect(liquidator).liquidate(id, args.collateralOut, args.debtOut, callArgs.pA, callArgs.pB, callArgs.pC);
      expect((await veil.positions(id)).status).to.equal(2);
    });

    it("rejects a proof computed against another position's commitment", async () => {
      const { veil, user, liquidator, collateral, debt } = await loadFixture(deployFixture);
      const { id } = await setupPosition(veil, collateral, debt, user, 100n * WAD, 300n * WAD);

      // unrelated underwater state with the same positionId
      const forgedState = makeInitialState({
        positionId: id,
        collateralAsset: BigInt(await collateral.getAddress()),
        debtAsset: BigInt(await debt.getAddress()),
        currentIndex: WAD,
        controlSecret: BigInt(randHex()),
        salt: BigInt(randHex()),
      });
      forgedState.collateral = 100n * WAD;
      forgedState.debt = 300n * WAD;
      const w = await buildLiquidationWitness(forgedState, PARAMS, BigInt(liquidator.address));
      const { callArgs } = await generateProof(w.inputs, "liquidation");
      const args = toLiquidationArgs(w.publicSignals);
      await expect(veil.connect(liquidator).liquidate(id, args.collateralOut, args.debtOut, callArgs.pA, callArgs.pB, callArgs.pC)).to.be
        .revertedWithCustomError(veil, "InvalidProof");
    });

    it("rejects zero settlement amounts and re-liquidation", async () => {
      const { veil, user, liquidator, collateral, debt } = await loadFixture(deployFixture);
      const { id, state } = await setupPosition(veil, collateral, debt, user, 100n * WAD, 300n * WAD);
      const w = await buildLiquidationWitness(state, PARAMS, BigInt(liquidator.address));
      const { callArgs } = await generateProof(w.inputs, "liquidation");
      const args = toLiquidationArgs(w.publicSignals);

      await expect(veil.connect(liquidator).liquidate(id, 0n, args.debtOut, callArgs.pA, callArgs.pB, callArgs.pC)).to.be.revertedWithCustomError(
        veil,
        "InvalidLiquidationAmount"
      );

      await veil.connect(liquidator).liquidate(id, args.collateralOut, args.debtOut, callArgs.pA, callArgs.pB, callArgs.pC);
      await expect(veil.connect(liquidator).liquidate(id, args.collateralOut, args.debtOut, callArgs.pA, callArgs.pB, callArgs.pC)).to.be.revertedWithCustomError(
        veil,
        "PositionNotActive"
      );
    });

    it("blocks liquidation while paused", async () => {
      const { veil, owner, user, liquidator, collateral, debt } = await loadFixture(deployFixture);
      const { id, state } = await setupPosition(veil, collateral, debt, user, 100n * WAD, 300n * WAD);
      const w = await buildLiquidationWitness(state, PARAMS, BigInt(liquidator.address));
      const { callArgs } = await generateProof(w.inputs, "liquidation");
      const args = toLiquidationArgs(w.publicSignals);
      await veil.connect(owner).setPaused(true);
      await expect(veil.connect(liquidator).liquidate(id, args.collateralOut, args.debtOut, callArgs.pA, callArgs.pB, callArgs.pC)).to.be.revertedWithCustomError(
        veil,
        "EnforcedPause"
      );
    });
  });
});
