import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { MockPriceOracle, TokenMock, VeilLend } from "../typechain-types";
import {
  ACTION_DEPOSIT,
  PrivateState,
  SolvencyParams,
  buildSolvencyWitness,
  buildTransition,
  computeCommitment,
  generateProof,
  isSolvent,
  makeInitialState,
  requireZkArtifacts,
  verifyLocally,
} from "../scripts/prove";

/**
 * Phase 3, Milestone 1 — ZK solvency / health proof.
 *
 * Circuit-level: the proof holds for solvent positions, fails for insolvent
 * ones and for any tampered public input, and binds to the position
 * commitment exactly like the state-transition circuit.
 * On-chain: `VeilLend.verifySolvency` derives ALL public inputs on-chain
 * (commitment, fresh oracle prices, configured LTV) — a caller supplies only
 * the proof, so proofs cannot be replayed against other positions, stale
 * states or manipulated prices.
 */

const WAD = 10n ** 18n;
const PRICE_SCALE = 10n ** 8n; // fixed-point: prices in 1e8 units
const PARAMS: SolvencyParams = { collateralPrice: 2n * PRICE_SCALE, debtPrice: 1n * PRICE_SCALE, maxLtvBps: 7500n };
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

function sampleState(overrides: Partial<PrivateState> = {}): PrivateState {
  return {
    positionId: 1n,
    collateralAsset: 0xa00000000000000000000000000000000000c01n,
    debtAsset: 0xa00000000000000000000000000000000000c02n,
    collateral: 100n * WAD,
    debt: 0n,
    interestIndex: WAD,
    sequence: 0n,
    controlSecret: BigInt(randHex()),
    salt: BigInt(randHex()),
    ...overrides,
  };
}

async function deployFixture() {
  requireZkArtifacts();
  const [owner, user, other] = await ethers.getSigners();
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

  for (const s of [user, other]) {
    await collateral.mint(s.address, 1_000_000n * WAD);
    await debt.mint(s.address, 1_000_000n * WAD);
    await collateral.connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
    await debt.connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
  }
  return { veil, solvencyVerifier, collateral, debt, oracle, owner, user, other };
}

async function proveSolvency(state: PrivateState, params: SolvencyParams = PARAMS) {
  const witness = await buildSolvencyWitness(state, params);
  const { proof, publicSignals, callArgs } = await generateProof(witness.inputs, "solvency");
  return { witness, proof, publicSignals, callArgs };
}

describe("Phase 3 M1 — ZK solvency proof", () => {
  describe("Circuit level", () => {
    before(() => requireZkArtifacts("solvency"));

    it("proves a solvent position without revealing amounts", async () => {
      const state = sampleState({ collateral: 100n * WAD, debt: 100n * WAD }); // colVal 200 vs required 75
      expect(isSolvent(state, PARAMS)).to.equal(true);
      const { proof, publicSignals } = await proveSolvency(state);
      expect(await verifyLocally(publicSignals.map(String), proof, "solvency")).to.equal(true);
      // public signals contain no amounts
      expect(publicSignals).to.deep.equal([
        state.positionId,
        await computeCommitment(state),
        PARAMS.collateralPrice,
        PARAMS.debtPrice,
        PARAMS.maxLtvBps,
      ]);
    });

    it("rejects an insolvent position (witness cannot be generated)", async () => {
      const state = sampleState({ collateral: 100n * WAD, debt: 300n * WAD }); // required 225 > colVal 200
      expect(isSolvent(state, PARAMS)).to.equal(false);
      const w = await buildSolvencyWitness(state, PARAMS);
      await expect(generateProof(w.inputs, "solvency")).to.be.rejected;
    });

    it("accepts the exact LTV boundary (cross-multiplied equality)", async () => {
      // collateral 100, price 2 → colVal·10000 = 200·10000
      // debt D, price 1, ltv 7500 → boundary at D·7500 = 2_000_000 → D = 266.666…e18
      const D = (200n * 10000n * WAD + 7500n * WAD - 1n) / (7500n * WAD) * WAD; // floor to WAD: 266e18
      const state = sampleState({ collateral: 100n * WAD, debt: (200n * 10000n * WAD) / 7500n }); // exact equality
      expect(isSolvent(state, PARAMS)).to.equal(true);
      const { proof, publicSignals } = await proveSolvency(state);
      expect(await verifyLocally(publicSignals.map(String), proof, "solvency")).to.equal(true);

      const above = sampleState({ collateral: 100n * WAD, debt: (200n * 10000n * WAD) / 7500n + 1n });
      expect(isSolvent(above, PARAMS)).to.equal(false);
      const w = await buildSolvencyWitness(above, PARAMS);
      await expect(generateProof(w.inputs, "solvency")).to.be.rejected;
      void D;
    });

    it("treats zero-debt positions as always solvent", async () => {
      const state = sampleState({ collateral: 0n, debt: 0n });
      const { proof, publicSignals } = await proveSolvency(state);
      expect(await verifyLocally(publicSignals.map(String), proof, "solvency")).to.equal(true);
      const tiny = sampleState({ collateral: 1n, debt: 0n });
      const r = await proveSolvency(tiny);
      expect(await verifyLocally(r.publicSignals.map(String), r.proof, "solvency")).to.equal(true);
    });

    it("rejects tampered public inputs (commitment, prices, ltv, positionId)", async () => {
      const state = sampleState();
      const w = await buildSolvencyWitness(state, PARAMS);
      const { proof, publicSignals } = await generateProof(w.inputs, "solvency");
      expect(await verifyLocally(publicSignals.map(String), proof, "solvency")).to.equal(true);

      for (const idx of [0, 1, 2, 3, 4]) {
        const wrong = [...publicSignals.map(String)];
        wrong[idx] = (BigInt(wrong[idx]) + 1n).toString();
        expect(await verifyLocally(wrong, proof, "solvency"), `tampered signal ${idx} must fail`).to.equal(false);
      }
    });

    it("rejects values beyond the fixed-point ranges (overflow guards)", async () => {
      // collateral ≥ 2^128 breaks the range check → no witness
      const huge = sampleState({ collateral: 2n ** 128n, debt: 0n });
      const w = await buildSolvencyWitness(huge, PARAMS);
      await expect(generateProof(w.inputs, "solvency")).to.be.rejected;
      // price ≥ 2^64 likewise
      const badPrice = { ...PARAMS, collateralPrice: 2n ** 64n };
      const w2 = await buildSolvencyWitness(sampleState(), badPrice);
      await expect(generateProof(w2.inputs, "solvency")).to.be.rejected;
    });
  });

  describe("On-chain verification", () => {
    it("accepts a valid solvency proof for a funded position", async () => {
      const { veil, user, collateral, debt } = await loadFixture(deployFixture);
      // create + deposit 100e18 (proof-bound), then prove solvency on-chain
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      const state = makeInitialState({
        positionId: 1n,
        collateralAsset: BigInt(await collateral.getAddress()),
        debtAsset: BigInt(await debt.getAddress()),
        currentIndex,
        controlSecret: BigInt(randHex()),
        salt: BigInt(randHex()),
      });
      await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(state)));
      const t = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 100n * WAD, currentIndex, newSalt: BigInt(randHex()) });
      const { callArgs } = await generateProof(t.inputs);
      await veil.connect(user).deposit(
        {
          positionId: t.publicSignals[0],
          oldCommitment: t.publicSignals[1],
          newCommitment: t.publicSignals[2],
          nullifier: t.publicSignals[3],
          actionId: t.publicSignals[4],
          newSequence: t.publicSignals[5],
          currentIndexLo: t.publicSignals[6],
          currentIndexHi: t.publicSignals[7],
          publicAmount: t.publicSignals[8],
        },
        callArgs.pA,
        callArgs.pB,
        callArgs.pC
      );

      // the on-chain state (new commitment) is solvent
      const s = await proveSolvency(t.newState);
      await expect(veil.verifySolvency(1n, s.callArgs.pA, s.callArgs.pB, s.callArgs.pC)).to.not.be.reverted;
    });

    it("rejects a solvency proof proven against another position's commitment", async () => {
      const { veil, collateral, debt } = await loadFixture(deployFixture);
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      // position 1 on-chain; proof computed for an unrelated state
      const state1 = makeInitialState({
        positionId: 1n,
        collateralAsset: BigInt(await collateral.getAddress()),
        debtAsset: BigInt(await debt.getAddress()),
        currentIndex,
        controlSecret: BigInt(randHex()),
        salt: BigInt(randHex()),
      });
      await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(state1)));

      const other = sampleState({ positionId: 1n, collateral: 500n * WAD }); // different secret/salt → different commitment
      const s = await proveSolvency(other);
      await expect(veil.verifySolvency(1n, s.callArgs.pA, s.callArgs.pB, s.callArgs.pC)).to.be.revertedWithCustomError(veil, "InvalidProof");
    });

    it("rejects when oracle data is stale (risky checks fail closed)", async () => {
      const { veil, oracle, collateral, debt } = await loadFixture(deployFixture);
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      const state = makeInitialState({
        positionId: 1n,
        collateralAsset: BigInt(await collateral.getAddress()),
        debtAsset: BigInt(await debt.getAddress()),
        currentIndex,
        controlSecret: BigInt(randHex()),
        salt: BigInt(randHex()),
      });
      await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(state)));

      const s = await proveSolvency(state);
      await time.increase(2 * 3600); // staleness limit is 1h
      await expect(veil.verifySolvency(1n, s.callArgs.pA, s.callArgs.pB, s.callArgs.pC)).to.be.revertedWithCustomError(veil, "StalePrice");
    });

    it("rejects a tampered proof", async () => {
      const { veil, collateral, debt } = await loadFixture(deployFixture);
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      const state = makeInitialState({
        positionId: 1n,
        collateralAsset: BigInt(await collateral.getAddress()),
        debtAsset: BigInt(await debt.getAddress()),
        currentIndex,
        controlSecret: BigInt(randHex()),
        salt: BigInt(randHex()),
      });
      await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(state)));
      const s = await proveSolvency(state);
      const tamperedP: [bigint, bigint] = [s.callArgs.pA[0] + 1n, s.callArgs.pA[1]];
      await expect(veil.verifySolvency(1n, tamperedP, s.callArgs.pB, s.callArgs.pC)).to.be.revertedWithCustomError(veil, "InvalidProof");
    });

    it("rejects unknown positions", async () => {
      const { veil, collateral, debt } = await loadFixture(deployFixture);
      const state = sampleState();
      const s = await proveSolvency(state);
      await expect(veil.verifySolvency(99n, s.callArgs.pA, s.callArgs.pB, s.callArgs.pC)).to.be.revertedWithCustomError(veil, "PositionNotFound");
      void collateral;
    });
  });
});
