import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { LiquidityPool, MockPriceOracle, TokenMock, VeilLend } from "../typechain-types";
import {
  ACTION_BORROW,
  ACTION_DEPOSIT,
  ACTION_REPAY,
  LiquidationParams,
  RiskParams,
  buildLiquidationWitness,
  buildRiskTransition,
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
  const veil = ((await upgrades.deployProxy(
            await ethers.getContractFactory("VeilLend"),
            [owner.address, await verifier.getAddress(), await solvencyVerifier.getAddress(), await riskVerifier.getAddress(), await liquidationVerifier.getAddress(), await oracle.getAddress()],
            { kind: "uups" },
          ))) as VeilLend;

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
async function wiredPoolFixture() {
  const f = await loadFixture(deployFixture);
  const pool = (await upgrades.deployProxy(
    await ethers.getContractFactory("LiquidityPool"),
    [await f.debt.getAddress(), f.owner.address, await f.veil.getAddress(), "Veil DBT Pool", "vlDBTP"],
    { kind: "uups" },
  )) as LiquidityPool;
  await f.veil.connect(f.owner).setDebtPool(await f.debt.getAddress(), await pool.getAddress());
  await f.debt.mint(f.owner.address, 100n * WAD);
  await f.debt.connect(f.owner).approve(await pool.getAddress(), ethers.MaxUint256);
  await pool.connect(f.owner).deposit(50n * WAD, f.owner.address);
  return { ...f, pool, lender: f.owner };
}


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

  describe("M1-readiness gap tests (audit §9)", () => {
    const RISK: RiskParams = { collateralPrice: PARAMS.collateralPrice, debtPrice: PARAMS.debtPrice, maxLtvBps: 7500n };

    /** Seeds debtCustody by originating + repaying debt on a helper position. */
    async function seedLiquidity(
      veil: VeilLend,
      collateral: TokenMock,
      debt: TokenMock,
      payer: { address: string },
      amount: bigint
    ) {
      const { state } = await setupPosition(veil, collateral, debt, payer, 0n, amount); // originated debt, no collateral
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      const t = await buildTransition({ oldState: state, actionId: 2n, amount, currentIndex, newSalt: BigInt(randHex()) });
      const { callArgs } = await generateProof(t.inputs);
      const ps = t.publicSignals;
      await veil.connect(payer as never).repay(
        { positionId: ps[0], oldCommitment: ps[1], newCommitment: ps[2], nullifier: ps[3], actionId: ps[4], newSequence: ps[5], currentIndexLo: ps[6], currentIndexHi: ps[7], publicAmount: ps[8] },
        callArgs.pA, callArgs.pB, callArgs.pC
      );
    }

    it("1. real borrow → price drop → full liquidation lifecycle with bad debt", async () => {
      const { veil, user, liquidator, collateral, debt, oracle } = await loadFixture(deployFixture);

      // realistic lifecycle: deposit → borrow (real risk_transition proof)
      const { id, state } = await setupPosition(veil, collateral, debt, user, 0n, 0n);
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      const dep = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 100n * WAD, currentIndex, newSalt: BigInt(randHex()) });
      const depProof = await generateProof(dep.inputs);
      const dps = dep.publicSignals;
      await veil.connect(user as never).deposit(
        { positionId: dps[0], oldCommitment: dps[1], newCommitment: dps[2], nullifier: dps[3], actionId: dps[4], newSequence: dps[5], currentIndexLo: dps[6], currentIndexHi: dps[7], publicAmount: dps[8] },
        depProof.callArgs.pA, depProof.callArgs.pB, depProof.callArgs.pC
      );
      const afterDeposit = dep.newState;

      await seedLiquidity(veil, collateral, debt, liquidator, 50n * WAD);
      const BORROW = 10n * WAD;
      const b = await buildRiskTransition({
        oldState: afterDeposit, actionId: ACTION_BORROW, amount: BORROW,
        currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
        newSalt: BigInt(randHex()),
        params: { collateralPrice: PARAMS.collateralPrice, debtPrice: PARAMS.debtPrice, maxLtvBps: 7500n }, recipient: BigInt(user.address),
      });
      const bProof = await generateProof(b.inputs, "risk_transition");
      const bps = b.publicSignals;
      await veil.connect(user as never).borrow(
        { positionId: bps[0], oldCommitment: bps[1], newCommitment: bps[2], nullifier: bps[3], actionId: bps[4], newSequence: bps[5], currentIndexLo: bps[6], currentIndexHi: bps[7], publicAmount: bps[8] },
        bProof.callArgs.pA, bProof.callArgs.pB, bProof.callArgs.pC
      );
      expect(await veil.borrowOutstanding(id)).to.equal(BORROW); // verified before liquidation
      expect(await collateral.balanceOf(user.address)).to.equal(1_000_000n * WAD - 100n * WAD); // 100e18 in custody
      expect(await debt.balanceOf(user.address)).to.equal(1_000_000n * WAD + BORROW); // borrow paid out in vDBT

      // price drop: vCOL $2 → $0.05 → colVal $5 < debtVal $10 · 0.85 → eligible
      await oracle.setPrice(await collateral.getAddress(), 5n * 10n ** 6n);
      const dropped: LiquidationParams = { collateralPrice: 5n * 10n ** 6n, debtPrice: PARAMS.debtPrice, liquidationThresholdBps: PARAMS.liquidationThresholdBps };
      expect(isLiquidatable(b.newState, dropped)).to.equal(true);

      // supportedCollateral before = full deposit; borrowOutstanding before = BORROW
      expect(await veil.supportedCollateral(id)).to.equal(100n * WAD);

      const w = await buildLiquidationWitness(b.newState, dropped, BigInt(liquidator.address));
      expect(w.amounts.debtOut).to.be.lessThan(b.newState.debt); // bad debt: parity (5e18) < hidden debt (10e18)
      const { callArgs } = await generateProof(w.inputs, "liquidation");
      const args = toLiquidationArgs(w.publicSignals);

      const debtCustodyBefore = await veil.debtCustody(await debt.getAddress());
      const liqCollBefore = await collateral.balanceOf(liquidator.address);
      const liqDebtBefore = await debt.balanceOf(liquidator.address);
      await expect(veil.connect(liquidator).liquidate(id, args.collateralOut, args.debtOut, callArgs.pA, callArgs.pB, callArgs.pC))
        .to.emit(veil, "Liquidated")
        .withArgs(id, await collateral.getAddress(), await debt.getAddress(), 100n * WAD, 5n * WAD);

      // final accounting/state
      expect(await collateral.balanceOf(liquidator.address)).to.equal(liqCollBefore + 100n * WAD); // exactly collateralOut
      expect(await debt.balanceOf(liquidator.address)).to.equal(liqDebtBefore - 5n * WAD);
      expect(await veil.debtCustody(await debt.getAddress())).to.equal(debtCustodyBefore + 5n * WAD);
      expect(await veil.collateralCustody(await collateral.getAddress())).to.equal(0n);
      expect(await veil.supportedCollateral(id)).to.equal(0n);
      expect(await veil.borrowOutstanding(id)).to.equal(0n); // written off (bad debt 5e18)
      expect((await veil.positions(id)).status).to.equal(2); // Closed

      // cannot be repeated
      await expect(veil.connect(liquidator).liquidate(id, args.collateralOut, args.debtOut, callArgs.pA, callArgs.pB, callArgs.pC)).to.be.revertedWithCustomError(
        veil,
        "PositionNotActive"
      );
    });

    it("2. stale oracle reverts liquidation with no state changes", async () => {
      const { veil, user, liquidator, collateral, debt, oracle } = await loadFixture(deployFixture);
      const { id, state } = await setupPosition(veil, collateral, debt, user, 100n * WAD, 300n * WAD);
      const w = await buildLiquidationWitness(state, PARAMS, BigInt(liquidator.address));
      const { callArgs } = await generateProof(w.inputs, "liquidation");
      const args = toLiquidationArgs(w.publicSignals);

      // make both oracle observations stale (> 1h staleness window)
      const staleTs = (await time.latest()) - 2 * 3600;
      await oracle.setPriceAt(await collateral.getAddress(), PARAMS.collateralPrice, staleTs);
      await oracle.setPriceAt(await debt.getAddress(), PARAMS.debtPrice, staleTs);

      const custodyBefore = await veil.collateralCustody(await collateral.getAddress());
      const debtCustodyBefore = await veil.debtCustody(await debt.getAddress());
      await expect(veil.connect(liquidator).liquidate(id, args.collateralOut, args.debtOut, callArgs.pA, callArgs.pB, callArgs.pC)).to.be.revertedWithCustomError(
        veil,
        "StalePrice"
      );

      // nothing moved; position still Active
      expect(await veil.collateralCustody(await collateral.getAddress())).to.equal(custodyBefore);
      expect(await veil.debtCustody(await debt.getAddress())).to.equal(debtCustodyBefore);
      expect((await veil.positions(id)).status).to.equal(1);
      expect(await collateral.balanceOf(liquidator.address)).to.equal(1_000_000n * WAD);
      expect(await debt.balanceOf(liquidator.address)).to.equal(1_000_000n * WAD);
    });

    it("3. price change after proof generation invalidates the proof", async () => {
      const { veil, user, liquidator, collateral, debt, oracle } = await loadFixture(deployFixture);
      const { id, state } = await setupPosition(veil, collateral, debt, user, 100n * WAD, 300n * WAD);

      // proof generated at price P = 2e8
      const w = await buildLiquidationWitness(state, PARAMS, BigInt(liquidator.address));
      const { callArgs } = await generateProof(w.inputs, "liquidation");
      const args = toLiquidationArgs(w.publicSignals);

      // oracle moves to a different FRESH price P2 before submission
      await oracle.setPrice(await collateral.getAddress(), 15n * 10n ** 7n); // 1.5e8, fresh timestamp

      const custodyBefore = await veil.collateralCustody(await collateral.getAddress());
      const debtCustodyBefore = await veil.debtCustody(await debt.getAddress());
      await expect(veil.connect(liquidator).liquidate(id, args.collateralOut, args.debtOut, callArgs.pA, callArgs.pB, callArgs.pC)).to.be.revertedWithCustomError(
        veil,
        "InvalidProof"
      );

      expect(await veil.collateralCustody(await collateral.getAddress())).to.equal(custodyBefore);
      expect(await veil.debtCustody(await debt.getAddress())).to.equal(debtCustodyBefore);
      expect((await veil.positions(id)).status).to.equal(1);
    });

    it("4. self-liquidation by the position controller succeeds and is non-extractive", async () => {
      const { veil, user, collateral, debt } = await loadFixture(deployFixture);
      const { id, state } = await setupPosition(veil, collateral, debt, user, 100n * WAD, 300n * WAD);
      const w = await buildLiquidationWitness(state, PARAMS, BigInt(user.address)); // recipient = controller
      const { callArgs } = await generateProof(w.inputs, "liquidation");
      const args = toLiquidationArgs(w.publicSignals);
      expect(args.debtOut).to.equal(200n * WAD); // parity: ceil(100e18·2/1)

      const userCollBefore = await collateral.balanceOf(user.address);
      const userDebtBefore = await debt.balanceOf(user.address);
      await veil.connect(user as never).liquidate(id, args.collateralOut, args.debtOut, callArgs.pA, callArgs.pB, callArgs.pC);

      // settlement at oracle parity: receives 100e18 vCOL (worth 200e18 debt), pays exactly 200e18 vDBT
      expect(await collateral.balanceOf(user.address)).to.equal(userCollBefore + 100n * WAD);
      expect(await debt.balanceOf(user.address)).to.equal(userDebtBefore - 200n * WAD);
      expect(await veil.supportedCollateral(id)).to.equal(0n);
      expect((await veil.positions(id)).status).to.equal(2);

      // closes exactly once
      await expect(veil.connect(user as never).liquidate(id, args.collateralOut, args.debtOut, callArgs.pA, callArgs.pB, callArgs.pC)).to.be.revertedWithCustomError(
        veil,
        "PositionNotActive"
      );
    });

    it("5. liquidationThresholdBps boundaries: 0 and >10000 rejected, 10000 accepted", async () => {
      const { veil, collateral, debt } = await loadFixture(deployFixture);
      const base = { baseRateBps: 500, slopeBps: 1000, targetUtilizationBps: 8000, reserveFactorBps: 1000, maxLtvBps: 7500 };

      for (const liq of [0, 10_001, 2n ** 64n - 1n]) {
        await expect(veil.setRateConfig(await debt.getAddress(), { ...base, liquidationThresholdBps: liq })).to.be.revertedWithCustomError(
          veil,
          "InvalidParameter"
        );
      }
      await expect(veil.setRateConfig(await debt.getAddress(), { ...base, liquidationThresholdBps: 10_000 })).to.emit(veil, "RateConfigUpdated");
      expect((await veil.rateConfigs(await debt.getAddress())).liquidationThresholdBps).to.equal(10_000n);
      void collateral;
    });
  });

  describe("Liquidation × LiquidityPool accounting (wired pool)", () => {
    // Deploys a LiquidityPool, wires it as the debt asset's pool, and funds it
    // with 50 WAD of lender liquidity. Liquidation then borrows from and
    // settles against this pool.
    it("partial liquidation recovers principal, writes off the residual as bad debt, and leaves NO ghost in totalBorrows", async () => {
      const { veil, pool, owner, lender, user, liquidator, collateral, debt, oracle } = await loadFixture(wiredPoolFixture);

      // borrower: deposit 100 vCOL, borrow 10 DBT — funded by the POOL
      const { id, state } = await setupPosition(veil, collateral, debt, user, 0n, 0n);
      const idx0 = await veil.currentDebtIndex(await debt.getAddress());
      const dep = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 100n * WAD, currentIndex: idx0, newSalt: BigInt(randHex()) });
      const depProof = await generateProof(dep.inputs);
      const dps = dep.publicSignals;
      await veil.connect(user as never).deposit(
        { positionId: dps[0], oldCommitment: dps[1], newCommitment: dps[2], nullifier: dps[3], actionId: dps[4], newSequence: dps[5], currentIndexLo: dps[6], currentIndexHi: dps[7], publicAmount: dps[8] },
        depProof.callArgs.pA, depProof.callArgs.pB, depProof.callArgs.pC,
      );

      const BORROW = 10n * WAD;
      const b = await buildRiskTransition({
        oldState: dep.newState, actionId: ACTION_BORROW, amount: BORROW,
        currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
        newSalt: BigInt(randHex()),
        params: { collateralPrice: PARAMS.collateralPrice, debtPrice: PARAMS.debtPrice, maxLtvBps: 7500n }, recipient: BigInt(user.address),
      });
      const bProof = await generateProof(b.inputs, "risk_transition");
      const bps = b.publicSignals;
      await veil.connect(user as never).borrow(
        { positionId: bps[0], oldCommitment: bps[1], newCommitment: bps[2], nullifier: bps[3], actionId: bps[4], newSequence: bps[5], currentIndexLo: bps[6], currentIndexHi: bps[7], publicAmount: bps[8] },
        bProof.callArgs.pA, bProof.callArgs.pB, bProof.callArgs.pC,
      );
      expect(await pool.totalBorrows()).to.equal(10n * WAD); // pool-funded borrow
      expect(await pool.availableLiquidity()).to.equal(40n * WAD); // 50 − 10

      // price drop: vCOL $2 → $0.05 → 100 vCOL parity = 5 DBT < 10 DBT debt
      await oracle.setPrice(await collateral.getAddress(), 5n * 10n ** 6n);
      const dropped: LiquidationParams = { collateralPrice: 5n * 10n ** 6n, debtPrice: PARAMS.debtPrice, liquidationThresholdBps: PARAMS.liquidationThresholdBps };
      const w = await buildLiquidationWitness(b.newState, dropped, BigInt(liquidator.address));
      const { callArgs } = await generateProof(w.inputs, "liquidation");
      const args = toLiquidationArgs(w.publicSignals);

      await expect(veil.connect(liquidator).liquidate(id, args.collateralOut, args.debtOut, callArgs.pA, callArgs.pB, callArgs.pC))
        .to.emit(veil, "Liquidated")
        .withArgs(id, await collateral.getAddress(), await debt.getAddress(), 100n * WAD, 5n * WAD)
        .and.to.emit(pool, "RepaymentReceived")
        .and.to.emit(pool, "BorrowsWrittenOff");

      // pool accounting: principal recovered 5, residual 5 written off — NO ghost
      // tokens: 50 − 10 lent + 5 repaid = 45; borrows: 10 − 5 recovered − 5 written off = 0
      expect(await pool.totalBorrows()).to.equal(0n);
      expect(await pool.totalAssets()).to.equal(45n * WAD);
      expect(await pool.availableLiquidity()).to.equal(45n * WAD);
      expect(await pool.accruedFees()).to.equal(0n); // principal recovery never generates a fee
      // lender share value reflects the realized loss: 50 backing → 45 (5 bad debt)
      expect(await pool.convertToAssets(await pool.balanceOf(lender.address))).to.equal(45n * WAD);

      // position closed and written off in VeilLend
      expect(await veil.borrowOutstanding(id)).to.equal(0n);
      expect((await veil.positions(id)).status).to.equal(2n); // Closed
      // re-liquidation cannot occur
      await expect(veil.connect(liquidator).liquidate(id, args.collateralOut, args.debtOut, callArgs.pA, callArgs.pB, callArgs.pC))
        .to.be.revertedWithCustomError(veil, "PositionNotActive");
      // legacy debtCustody untouched (pool path used)
      expect(await veil.debtCustody(await debt.getAddress())).to.equal(0n);
    });

    it("full repayment after a partial liquidation keeps pool accounting consistent", async () => {
      const { veil, pool, owner, lender, user, liquidator, collateral, debt, oracle } = await loadFixture(wiredPoolFixture);

      const { id, state } = await setupPosition(veil, collateral, debt, user, 0n, 0n);
      const idx0 = await veil.currentDebtIndex(await debt.getAddress());
      const dep = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 100n * WAD, currentIndex: idx0, newSalt: BigInt(randHex()) });
      const depProof = await generateProof(dep.inputs);
      const dps = dep.publicSignals;
      await veil.connect(user as never).deposit(
        { positionId: dps[0], oldCommitment: dps[1], newCommitment: dps[2], nullifier: dps[3], actionId: dps[4], newSequence: dps[5], currentIndexLo: dps[6], currentIndexHi: dps[7], publicAmount: dps[8] },
        depProof.callArgs.pA, depProof.callArgs.pB, depProof.callArgs.pC,
      );

      const BORROW = 10n * WAD;
      const b = await buildRiskTransition({
        oldState: dep.newState, actionId: ACTION_BORROW, amount: BORROW,
        currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
        newSalt: BigInt(randHex()),
        params: { collateralPrice: PARAMS.collateralPrice, debtPrice: PARAMS.debtPrice, maxLtvBps: 7500n }, recipient: BigInt(user.address),
      });
      const bProof = await generateProof(b.inputs, "risk_transition");
      const bps = b.publicSignals;
      await veil.connect(user as never).borrow(
        { positionId: bps[0], oldCommitment: bps[1], newCommitment: bps[2], nullifier: bps[3], actionId: bps[4], newSequence: bps[5], currentIndexLo: bps[6], currentIndexHi: bps[7], publicAmount: bps[8] },
        bProof.callArgs.pA, bProof.callArgs.pB, bProof.callArgs.pC,
      );

      // partial liquidation: parity 5 DBT → bad debt 5 DBT realized
      await oracle.setPrice(await collateral.getAddress(), 5n * 10n ** 6n);
      const dropped: LiquidationParams = { collateralPrice: 5n * 10n ** 6n, debtPrice: PARAMS.debtPrice, liquidationThresholdBps: PARAMS.liquidationThresholdBps };
      const w = await buildLiquidationWitness(b.newState, dropped, BigInt(liquidator.address));
      const { callArgs } = await generateProof(w.inputs, "liquidation");
      const args = toLiquidationArgs(w.publicSignals);
      await veil.connect(liquidator).liquidate(id, args.collateralOut, args.debtOut, callArgs.pA, callArgs.pB, callArgs.pC);
      expect(await pool.totalBorrows()).to.equal(0n); // no ghost

      // a NEW borrower can still borrow the repaid principal from the pool
      const user2 = (await ethers.getSigners())[3];
      await debt.mint(user2.address, 1_000_000n * WAD);
      await collateral.mint(user2.address, 1_000_000n * WAD);
      await collateral.connect(user2).approve(await veil.getAddress(), ethers.MaxUint256);
      await debt.connect(user2).approve(await veil.getAddress(), ethers.MaxUint256);
      const { id: id2, state: state2 } = await setupPosition(veil, collateral, debt, user2, 0n, 0n);
      const idxA = await veil.currentDebtIndex(await debt.getAddress());
      // at the dropped vCOL price, 1000 vCOL is needed to keep the 10 DBT borrow solvent
      const dep2 = await buildTransition({ oldState: state2, actionId: ACTION_DEPOSIT, amount: 1000n * WAD, currentIndex: idxA, newSalt: BigInt(randHex()) });
      const dep2P = await generateProof(dep2.inputs);
      const d2ps = dep2.publicSignals;
      await veil.connect(user2 as never).deposit(
        { positionId: d2ps[0], oldCommitment: d2ps[1], newCommitment: d2ps[2], nullifier: d2ps[3], actionId: d2ps[4], newSequence: d2ps[5], currentIndexLo: d2ps[6], currentIndexHi: d2ps[7], publicAmount: d2ps[8] },
        dep2P.callArgs.pA, dep2P.callArgs.pB, dep2P.callArgs.pC,
      );
      const b2 = await buildRiskTransition({
        oldState: dep2.newState, actionId: ACTION_BORROW, amount: BORROW,
        currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
        newSalt: BigInt(randHex()),
        // live DROPPED prices: the proof must carry the same values the
        // contract derives on-chain at execution time
        params: { collateralPrice: 5n * 10n ** 6n, debtPrice: PARAMS.debtPrice, maxLtvBps: 7500n }, recipient: BigInt(user2.address),
      });
      const b2P = await generateProof(b2.inputs, "risk_transition");
      const b2ps = b2.publicSignals;
      await veil.connect(user2 as never).borrow(
        { positionId: b2ps[0], oldCommitment: b2ps[1], newCommitment: b2ps[2], nullifier: b2ps[3], actionId: b2ps[4], newSequence: b2ps[5], currentIndexLo: b2ps[6], currentIndexHi: b2ps[7], publicAmount: b2ps[8] },
        b2P.callArgs.pA, b2P.callArgs.pB, b2P.callArgs.pC,
      );
      expect(await pool.totalBorrows()).to.equal(10n * WAD); // recycled liquidity lent again
      // full repayment closes the cycle cleanly
      const rep = await buildTransition({ oldState: b2.newState, actionId: ACTION_REPAY, amount: BORROW, currentIndex: await veil.currentDebtIndex(await debt.getAddress()), newSalt: BigInt(randHex()) });
      const repP = await generateProof(rep.inputs);
      const rps = rep.publicSignals;
      await veil.connect(user2 as never).repay(
        { positionId: rps[0], oldCommitment: rps[1], newCommitment: rps[2], nullifier: rps[3], actionId: rps[4], newSequence: rps[5], currentIndexLo: rps[6], currentIndexHi: rps[7], publicAmount: rps[8] },
        repP.callArgs.pA, repP.callArgs.pB, repP.callArgs.pC,
      );
      expect(await pool.totalBorrows()).to.equal(0n);
      expect(await pool.totalAssets()).to.equal(45n * WAD); // unchanged (principal-only cycle)
      expect(await pool.accruedFees()).to.equal(0n);
      expect(await pool.availableLiquidity()).to.equal(45n * WAD);
      void owner; void lender; void debt; void collateral; void time;
    });
  });

  describe("Orphan settlement (settleOrphanPosition, owner-only)", () => {
    it("full settlement: owner pays the pool debt and receives the entire collateral; no bad debt, no fee", async () => {
      const { veil, pool, owner, user, liquidator, collateral, debt, oracle } = await loadFixture(wiredPoolFixture);

      const { id, state } = await setupPosition(veil, collateral, debt, user, 0n, 0n);
      const idx0 = await veil.currentDebtIndex(await debt.getAddress());
      const dep = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 10n * WAD, currentIndex: idx0, newSalt: BigInt(randHex()) });
      const depProof = await generateProof(dep.inputs);
      const dps = dep.publicSignals;
      await veil.connect(user as never).deposit(
        { positionId: dps[0], oldCommitment: dps[1], newCommitment: dps[2], nullifier: dps[3], actionId: dps[4], newSequence: dps[5], currentIndexLo: dps[6], currentIndexHi: dps[7], publicAmount: dps[8] },
        depProof.callArgs.pA, depProof.callArgs.pB, depProof.callArgs.pC,
      );
      const BORROW = 5n * WAD;
      const b = await buildRiskTransition({
        oldState: dep.newState, actionId: ACTION_BORROW, amount: BORROW,
        currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
        newSalt: BigInt(randHex()),
        params: { collateralPrice: PARAMS.collateralPrice, debtPrice: PARAMS.debtPrice, maxLtvBps: 7500n }, recipient: BigInt(user.address),
      });
      const bProof = await generateProof(b.inputs, "risk_transition");
      const bps = b.publicSignals;
      await veil.connect(user as never).borrow(
        { positionId: bps[0], oldCommitment: bps[1], newCommitment: bps[2], nullifier: bps[3], actionId: bps[4], newSequence: bps[5], currentIndexLo: bps[6], currentIndexHi: bps[7], publicAmount: bps[8] },
        bProof.callArgs.pA, bProof.callArgs.pB, bProof.callArgs.pC,
      );
      expect(await veil.borrowOutstanding(id)).to.equal(BORROW);
      expect(await veil.supportedCollateral(id)).to.equal(10n * WAD);

      // owner pays the pool debt (10 DBT — capped by pool.totalBorrows) and
      // receives the full 10 vCOL collateral (parity 20 DBT > debt 10 DBT →
      // the value surplus stays embedded in the recovered collateral)
      await debt.connect(owner).approve(await veil.getAddress(), ethers.MaxUint256);
      const ownerDebtBefore = await debt.balanceOf(owner.address);
      const ownerColBefore = await collateral.balanceOf(owner.address);
      await debt.connect(owner).approve(await veil.getAddress(), ethers.MaxUint256); // settle pulls parity from the owner
      await expect(veil.connect(owner).settleOrphanPosition(id))
        .to.emit(veil, "OrphanPositionSettled")
        .withArgs(id, 10n * WAD, BORROW);
      expect(ownerDebtBefore - (await debt.balanceOf(owner.address))).to.equal(BORROW); // owner PAID the pool debt
      expect((await collateral.balanceOf(owner.address)) - ownerColBefore).to.equal(10n * WAD); // received the collateral

      // accounting: pool borrows cleared, position closed, no fee, no ghost
      expect(await pool.totalBorrows()).to.equal(0n);
      expect(await pool.accruedFees()).to.equal(0n);
      expect(await pool.totalAssets()).to.equal(50n * WAD); // unchanged (principal repaid = internal transfer)
      expect(await veil.borrowOutstanding(id)).to.equal(0n);
      expect(await veil.supportedCollateral(id)).to.equal(0n);
      expect(await veil.collateralCustody(await collateral.getAddress())).to.equal(0n);
      expect((await veil.positions(id)).status).to.equal(2n); // Closed
      // re-settlement rejected: the position is Closed (PositionNotActive fires first)
      await expect(veil.connect(owner).settleOrphanPosition(id)).to.be.revertedWithCustomError(veil, "PositionNotActive");
    });

    it("shortfall branch: collateral below debt realizes exactly the residual as bad debt", async () => {
      const { veil, pool, owner, user, liquidator, collateral, debt, oracle } = await loadFixture(wiredPoolFixture);

      const { id, state } = await setupPosition(veil, collateral, debt, user, 0n, 0n);
      const idx0 = await veil.currentDebtIndex(await debt.getAddress());
      const dep = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 2n * WAD, currentIndex: idx0, newSalt: BigInt(randHex()) });
      const depProof = await generateProof(dep.inputs);
      const dps = dep.publicSignals;
      await veil.connect(user as never).deposit(
        { positionId: dps[0], oldCommitment: dps[1], newCommitment: dps[2], nullifier: dps[3], actionId: dps[4], newSequence: dps[5], currentIndexLo: dps[6], currentIndexHi: dps[7], publicAmount: dps[8] },
        depProof.callArgs.pA, depProof.callArgs.pB, depProof.callArgs.pC,
      );
      const BORROW = 3n * WAD; // 2 vCOL @ $2 = $4 → 75% LTV, allowed
      const b = await buildRiskTransition({
        oldState: dep.newState, actionId: ACTION_BORROW, amount: BORROW,
        currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
        newSalt: BigInt(randHex()),
        params: { collateralPrice: PARAMS.collateralPrice, debtPrice: PARAMS.debtPrice, maxLtvBps: 7500n }, recipient: BigInt(user.address),
      });
      const bProof = await generateProof(b.inputs, "risk_transition");
      const bps = b.publicSignals;
      await veil.connect(user as never).borrow(
        { positionId: bps[0], oldCommitment: bps[1], newCommitment: bps[2], nullifier: bps[3], actionId: bps[4], newSequence: bps[5], currentIndexLo: bps[6], currentIndexHi: bps[7], publicAmount: bps[8] },
        bProof.callArgs.pA, bProof.callArgs.pB, bProof.callArgs.pC,
      );
      expect(await veil.borrowOutstanding(id)).to.equal(BORROW);

      // price drop: vCOL $2 → $0.05 → orphan parity = 2 vCOL × $0.05 = 0.1 DBT
      // < 3 DBT outstanding → shortfall 2.9 DBT realized as bad debt
      await oracle.setPrice(await collateral.getAddress(), 5n * 10n ** 6n);
      const ownerDebtBefore = await debt.balanceOf(owner.address);
      const ownerColBefore = await collateral.balanceOf(owner.address);
      await debt.connect(owner).approve(await veil.getAddress(), ethers.MaxUint256); // settle pulls parity from the owner
      await expect(veil.connect(owner).settleOrphanPosition(id))
        .to.emit(veil, "OrphanPositionSettled")
        .withArgs(id, 2n * WAD, 3n * WAD) // total debt closed (pool-level write-off asserted via totalBorrows)
        .and.to.emit(pool, "RepaymentReceived")
        .and.to.emit(pool, "BorrowsWrittenOff");

      // pool: principal recovered 0.1, residual 2.9 written off — no ghost
      expect(await pool.totalBorrows()).to.equal(0n);
      expect(await pool.totalAssets()).to.equal(471n * 10n ** 17n); // 50 − 3 lent + 0.1 repaid − 2.9 written off = 47.1 DBT
      expect(await pool.accruedFees()).to.equal(0n); // principal recovery never generates a fee
      // position closed, ledger cleared
      expect(await veil.borrowOutstanding(id)).to.equal(0n);
      expect(await veil.supportedCollateral(id)).to.equal(0n);
      expect((await veil.positions(id)).status).to.equal(2n); // Closed
      // owner paid the parity (0.1 DBT) and received the collateral (2 vCOL)
      expect(ownerDebtBefore - (await debt.balanceOf(owner.address))).to.equal(1n * 10n ** 17n);
      expect((await collateral.balanceOf(owner.address)) - ownerColBefore).to.equal(2n * WAD);
      void liquidator; void oracle;
    });

    it("settleOrphanPosition is owner-only", async () => {
      const { veil, user } = await loadFixture(wiredPoolFixture);
      await expect(veil.connect(user).settleOrphanPosition(1n)).to.be.revertedWithCustomError(veil, "OwnableUnauthorizedAccount");
    });
  });
});