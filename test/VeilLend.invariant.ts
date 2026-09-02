import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { MockPriceOracle, TokenMock, VeilLend } from "../typechain-types";
import {
  ACTION_DEPOSIT,
  ACTION_REPAY,
  PrivateState,
  SNARK_SCALAR_FIELD,
  buildTransition,
  computeCommitment,
  ACTION_BORROW,
  ACTION_WITHDRAW,
  buildLiquidationWitness,
  buildRiskTransition,
  generateProof,
  makeInitialState,
  requireZkArtifacts,
} from "../scripts/prove";

/**
 * Fuzz / invariant coverage (Phase 2).
 *
 * Focus areas: with REAL proofs now flowing, the harness asserts the
 * Phase 2 security invariants under randomized action sequences:
 *  - deposit binding: on-chain collateral custody == sum of hidden
 *    collateral across all positions (and == contract token balance)
 *  - debt custody == sum of repaid amounts
 *  - sequence integrity: advances by exactly 1, only via verified proofs
 *  - commitment integrity: changes only via verified transitions
 *  - replay protection: consumed nullifiers can never be reused
 *  - pause policy and admin restrictions unchanged from Phase 1
 */

const WAD = 10n ** 18n;
const DAY = 24n * 60n * 60n;

function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return function () {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

type Rng = () => number;
const randInt = (rng: Rng, max: number) => Math.floor(rng() * max);
const pick = <T>(rng: Rng, arr: T[]): T => arr[randInt(rng, arr.length)];
const randSecret = () => BigInt(ethers.hexlify(ethers.randomBytes(31)));
const bytes32 = (v: bigint) => ethers.zeroPadValue(ethers.toBeHex(v), 32);

async function deployFuzzFixture() {
  requireZkArtifacts();
  const [owner, user, other] = await ethers.getSigners();
  const tokenFactory = await ethers.getContractFactory("TokenMock");
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

  const collateralA = (await tokenFactory.deploy("Collateral A", "COLA")) as TokenMock;
  const collateralB = (await tokenFactory.deploy("Collateral B", "COLB")) as TokenMock;
  const debtA = (await tokenFactory.deploy("Debt A", "DBTA")) as TokenMock;
  const debtB = (await tokenFactory.deploy("Debt B", "DBTB")) as TokenMock;

  await veil.connect(owner).enableCollateralAsset(await collateralA.getAddress());
  await veil.connect(owner).enableCollateralAsset(await collateralB.getAddress());
  await veil.connect(owner).enableDebtAsset(await debtA.getAddress(), { baseRateBps: 500, slopeBps: 2000, targetUtilizationBps: 8000, reserveFactorBps: 1000, maxLtvBps: 7500, liquidationThresholdBps: 8500 });
  await veil.connect(owner).enableDebtAsset(await debtB.getAddress(), { baseRateBps: 1200, slopeBps: 1000, targetUtilizationBps: 9000, reserveFactorBps: 500, maxLtvBps: 7000, liquidationThresholdBps: 8000 });

  const tokens = [collateralA, collateralB, debtA, debtB];
  for (const t of tokens) {
    for (const s of [user, other]) {
      await t.mint(s.address, 100_000_000n * WAD);
      await t.connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
    }
  }

  return { veil, owner, user, other, collateralA, collateralB, debtA, debtB };
}

interface Tracked {
  id: bigint;
  collateralAsset: TokenMock;
  debtAsset: TokenMock;
  state: PrivateState;
  commitment: string;
}

/** Maps prepared public signals to the contract's TransitionInputs struct. */
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

describe("VeilLend — fuzz & invariants (Phase 2)", () => {
  it("holds Phase 2 invariants (deposit binding, sequence, replay, custody) across randomized actions", async () => {
    const seed = 1337;
    const rng = mulberry32(seed);
    const { veil, owner, user, other, collateralA, collateralB, debtA, debtB } = await loadFixture(deployFuzzFixture);

    const collaterals = [collateralA, collateralB];
    const debts = [debtA, debtB];
    const actors = [user, other];
    const tracked: Tracked[] = [];
    const repaidByPosition = new Map<bigint, bigint>(); // positionId → cumulative repaid
    const borrowedByPosition = new Map<bigint, bigint>(); // positionId → outstanding borrow (public ledger)
    let paused = false;

    const invariants = async () => {
      // position registry consistency
      expect(await veil.nextPositionId()).to.equal(BigInt(tracked.length));
      for (const t of tracked) {
        const p = await veil.positions(t.id);
        expect(p.collateralAsset).to.equal(await t.collateralAsset.getAddress());
        expect(p.debtAsset).to.equal(await t.debtAsset.getAddress());
        expect(p.activeCommitment).to.equal(t.commitment); // commitment changes only via verified proofs
        expect(p.sequence).to.equal(t.state.sequence); // advances by exactly 1 per verified transition
        expect(p.status).to.equal(1); // nothing closes or seizes positions in Phase 2
        expect(p.interestIndex).to.equal(t.state.interestIndex);
      }

      // deposit binding: custody == Σ hidden collateral (per asset) == token balance
      for (const c of collaterals) {
        const addr = await c.getAddress();
        const hidden = tracked.filter((t) => t.state.collateralAsset === BigInt(addr)).reduce((sum, t) => sum + t.state.collateral, 0n);
        const custody = await veil.collateralCustody(addr);
        expect(custody, `custody != hidden collateral for ${addr}`).to.equal(hidden);
        expect(await c.balanceOf(await veil.getAddress())).to.equal(custody);
      }

      // debt custody == Σ repaid amounts (per asset)
      for (const d of debts) {
        const addr = await d.getAddress();
        const repaid = tracked.filter((t) => t.state.debtAsset === BigInt(addr)).reduce((sum, t) => sum + (repaidByPosition.get(t.id) ?? 0n), 0n);
        const custody = await veil.debtCustody(addr);
        expect(custody, `debt custody drift for ${addr}`).to.equal(repaid);
        expect(await d.balanceOf(await veil.getAddress())).to.equal(custody);
      }

      // supported-collateral ledger: per-asset Σ supported == collateralCustody
      // (exact conservation of the custody boundary), and each position's
      // outstanding borrow ≤ supported * maxLtvBps / 10000
      const supportedByAsset = new Map<string, bigint>();
      for (const t of tracked) {
        const supported = await veil.supportedCollateral(t.id);
        const addr = await t.collateralAsset.getAddress();
        supportedByAsset.set(addr, (supportedByAsset.get(addr) ?? 0n) + supported);
        const maxLtvBps = (await veil.rateConfigs(await t.debtAsset.getAddress())).maxLtvBps;
        expect(await veil.borrowOutstanding(t.id)).to.be.lessThanOrEqual((supported * maxLtvBps) / 10000n);
      }
      for (const c of collaterals) {
        const addr = await c.getAddress();
        expect(supportedByAsset.get(addr) ?? 0n, `Σ supported != custody for ${addr}`).to.equal(await veil.collateralCustody(addr));
      }

      expect(await veil.paused()).to.equal(paused);
      expect(await veil.verifier()).to.not.equal(ethers.ZeroAddress);
    };

    for (let step = 0; step < 45; step++) {
      const roll = randInt(rng, 100);

      if (roll < 15) {
        await time.increase(BigInt(randInt(rng, 60)) * DAY + 1n);
      } else if (roll < 35) {
        // create a position with a real initial commitment
        const collateral = pick(rng, collaterals);
        const debt = pick(rng, debts);
        const id = BigInt(tracked.length + 1);
        const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
        const state = makeInitialState({
          positionId: id,
          collateralAsset: BigInt(await collateral.getAddress()),
          debtAsset: BigInt(await debt.getAddress()),
          currentIndex,
          controlSecret: randSecret(),
          salt: randSecret(),
        });
        const commitment = await computeCommitment(state);
        await veil.connect(pick(rng, actors)).createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(commitment));
        tracked.push({ id, collateralAsset: collateral, debtAsset: debt, state, commitment: bytes32(commitment) });
      } else if (roll < 62 && tracked.length > 0 && !paused) {
        // proof-bound deposit transition (must be unpaused)
        const t = pick(rng, tracked);
        const amount = 10n ** BigInt(randInt(rng, 19)) + 1n;
        const currentIndex = await veil.currentDebtIndex(await t.debtAsset.getAddress());
        const prepared = await buildTransition({ oldState: t.state, actionId: ACTION_DEPOSIT, amount, currentIndex, newSalt: randSecret() });
        const { callArgs } = await generateProof(prepared.inputs);
        await veil.connect(pick(rng, actors)).deposit(toInputs(prepared.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC);
        t.state = prepared.newState;
        t.commitment = bytes32(prepared.publicSignals[2]);
      } else if (roll < 72 && tracked.length > 0 && !paused) {
        // proof-bound repay transition (must be unpaused; over-repayment is clamped by design)
        const t = pick(rng, tracked);
        const amount = 10n ** BigInt(randInt(rng, 15)) + 1n;
        const currentIndex = await veil.currentDebtIndex(await t.debtAsset.getAddress());
        const prepared = await buildTransition({ oldState: t.state, actionId: ACTION_REPAY, amount, currentIndex, newSalt: randSecret() });
        const { callArgs } = await generateProof(prepared.inputs);
        await veil.connect(pick(rng, actors)).repay(toInputs(prepared.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC);
        repaidByPosition.set(t.id, (repaidByPosition.get(t.id) ?? 0n) + amount);
        const prevOut = borrowedByPosition.get(t.id) ?? 0n;
        borrowedByPosition.set(t.id, amount >= prevOut ? 0n : prevOut - amount);
        t.state = prepared.newState;
        t.commitment = bytes32(prepared.publicSignals[2]);
      } else if (roll < 80 && tracked.length > 0 && !paused) {
        // proof-bound borrow transition, sized within the on-chain
        // supported-collateral cap (supported * maxLtvBps / 10000 − outstanding)
        const t = pick(rng, tracked);
        const debtAsset = t.debtAsset;
        const supported = await veil.supportedCollateral(t.id);
        const outstanding = await veil.borrowOutstanding(t.id);
        const maxLtvBps = (await veil.rateConfigs(await debtAsset.getAddress())).maxLtvBps;
        const capacity = (supported * maxLtvBps) / 10000n - outstanding;
        if (capacity > 0n) {
          const submitter = pick(rng, actors);
          const amount = 1n + BigInt(randInt(rng, 10 ** 6)) * (capacity / (10n ** 6n + 1n) > 0n ? capacity / (10n ** 6n + 1n) : 1n);
          const sized = amount > capacity ? capacity : amount;
          const currentIndex = await veil.currentDebtIndex(await debtAsset.getAddress());
          const prepared = await buildRiskTransition({ oldState: t.state, actionId: ACTION_BORROW, amount: sized, currentIndex, newSalt: randSecret(), params: { collateralPrice: 2n * 10n ** 8n, debtPrice: 10n ** 8n, maxLtvBps }, recipient: BigInt(submitter.address) });
          const { callArgs } = await generateProof(prepared.inputs, "risk_transition");
          await veil.connect(submitter).borrow(toInputs(prepared.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC);
          t.state = prepared.newState;
          t.commitment = bytes32(prepared.publicSignals[2]);
          borrowedByPosition.set(t.id, (borrowedByPosition.get(t.id) ?? 0n) + sized);
        }
      } else if (roll < 84) {
        paused = !paused;
        await veil.connect(owner).setPaused(paused);
      } else if (tracked.length > 0 && !paused) {
        // invalid attempt: stale oldCommitment with a REAL proof → must fail, nothing changes
          const t = pick(rng, tracked);
          const staleState = { ...t.state, sequence: t.state.sequence + 5n };
          const prepared = await buildTransition({
            oldState: staleState,
            actionId: ACTION_DEPOSIT,
            amount: 1n,
            currentIndex: await veil.currentDebtIndex(await t.debtAsset.getAddress()),
            newSalt: randSecret(),
          });
          const { callArgs } = await generateProof(prepared.inputs);
          await expect(veil.connect(user).deposit(toInputs(prepared.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC)).to.be.revertedWithCustomError(
            veil,
            "InvalidCommitment"
          );
      }

      await invariants();
    }

    await invariants();
  });

  it("never consumes a nullifier for a failed transition and rejects replayed proofs", async () => {
    const rng = mulberry32(424242);
    const { veil, user, collateralA, debtA } = await loadFixture(deployFuzzFixture);

    const currentIndex = await veil.currentDebtIndex(await debtA.getAddress());
    let state = makeInitialState({
      positionId: 1n,
      collateralAsset: BigInt(await collateralA.getAddress()),
      debtAsset: BigInt(await debtA.getAddress()),
      currentIndex,
      controlSecret: randSecret(),
      salt: randSecret(),
    });
    await veil.createPosition(await collateralA.getAddress(), await debtA.getAddress(), bytes32(await computeCommitment(state)));

    for (let i = 0; i < 10; i++) {
      const prepared = await buildTransition({
        oldState: state,
        actionId: ACTION_DEPOSIT,
        amount: 10n ** BigInt(randInt(rng, 15)) + 1n,
        currentIndex,
        newSalt: randSecret(),
      });
      const { callArgs } = await generateProof(prepared.inputs);
      const nullifier = bytes32(prepared.publicSignals[3]);

      // deposit-1 and deposit-2 from the same old state share a nullifier: only the first succeeds
      await veil.connect(user).deposit(toInputs(prepared.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC);
      expect(await veil.consumedTransitions(nullifier)).to.equal(true);
      await expect(veil.connect(user).deposit(toInputs(prepared.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC)).to.be.revertedWithCustomError(
        veil,
        "TransitionConsumed"
      );

      // a DIFFERENT valid transition from the same stale old state shares the
      // nullifier (secret, position, sequence, action) → replay protection fires
      const other = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 42n, currentIndex, newSalt: randSecret() });
      const { callArgs: ca2 } = await generateProof(other.inputs);
      await expect(veil.connect(user).deposit(toInputs(other.publicSignals), ca2.pA, ca2.pB, ca2.pC)).to.be.revertedWithCustomError(
        veil,
        "TransitionConsumed"
      );
      expect((await veil.positions(1n)).sequence).to.equal(state.sequence + 1n); // exactly one advance per iteration

      // advance the working state so the next iteration derives a fresh nullifier
      state = prepared.newState;
    }
  });

  it("admin operations never move user funds or mutate positions (Phase 2 surface)", async () => {
    const rng = mulberry32(555);
    const { veil, owner, other, user, collateralA, debtA } = await loadFixture(deployFuzzFixture);

    const currentIndex = await veil.currentDebtIndex(await debtA.getAddress());
    const state = makeInitialState({
      positionId: 1n,
      collateralAsset: BigInt(await collateralA.getAddress()),
      debtAsset: BigInt(await debtA.getAddress()),
      currentIndex,
      controlSecret: randSecret(),
      salt: randSecret(),
    });
    await veil.createPosition(await collateralA.getAddress(), await debtA.getAddress(), bytes32(await computeCommitment(state)));
    const prepared = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 1000n * WAD, currentIndex, newSalt: randSecret() });
    const { callArgs } = await generateProof(prepared.inputs);
    await veil.connect(user).deposit(toInputs(prepared.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC);

    const contractBalance = await collateralA.balanceOf(await veil.getAddress());
    const custody = await veil.collateralCustody(await collateralA.getAddress());
    const userBalance = await collateralA.balanceOf(user.address);
    const posBefore = await veil.positions(1n);

    for (let i = 0; i < 15; i++) {
      if (rng() < 0.5) {
        await veil.connect(owner).setRateConfig(await debtA.getAddress(), {
          baseRateBps: randInt(rng, 10_001),
          slopeBps: randInt(rng, 10_001),
          targetUtilizationBps: randInt(rng, 10_001),
          reserveFactorBps: randInt(rng, 10_001),
          maxLtvBps: 7500,
          liquidationThresholdBps: 8500,
        });
      } else {
        await expect(veil.connect(other).setOracle(other.address)).to.be.revertedWithCustomError(veil, "OwnableUnauthorizedAccount");
      }
      expect(await collateralA.balanceOf(await veil.getAddress())).to.equal(contractBalance);
      expect(await veil.collateralCustody(await collateralA.getAddress())).to.equal(custody);
      expect(await collateralA.balanceOf(user.address)).to.equal(userBalance);
      expect((await veil.positions(1n)).activeCommitment).to.equal(posBefore.activeCommitment);
      expect((await veil.positions(1n)).status).to.equal(posBefore.status);
    }
    void SNARK_SCALAR_FIELD;
  });

  describe("Phase 3 invariants", () => {
    it("risky actions (borrow/withdraw/liquidate) can never execute without a valid proof", async () => {
      const { veil, user, collateralA, debtA } = await loadFixture(deployFuzzFixture);
      const junk = {
        positionId: 1n,
        oldCommitment: 0n,
        newCommitment: 0n,
        nullifier: 0n,
        actionId: 3n,
        newSequence: 1n,
        currentIndexLo: 0n,
        currentIndexHi: 0n,
        publicAmount: 1n,
      };
      const p: [bigint, bigint] = [0n, 0n];
      const q: [[bigint, bigint], [bigint, bigint]] = [
        [0n, 0n],
        [0n, 0n],
      ];
      for (let i = 0; i < 10; i++) {
        await expect(veil.connect(user).borrow(junk, p, q, p)).to.be.reverted;
        await expect(veil.connect(user).withdrawCollateral(junk, p, q, p)).to.be.reverted;
        await expect(veil.connect(user).liquidate(1n, 1n, 1n, p, q, p)).to.be.reverted;
      }
      void collateralA;
      void debtA;
    });

    it("unsafe private transitions are unprovable (witness level)", async () => {
      const { veil, user, collateralA, debtA } = await loadFixture(deployFuzzFixture);
      const currentIndex = await veil.currentDebtIndex(await debtA.getAddress());
      const state = makeInitialState({
        positionId: 1n,
        collateralAsset: BigInt(await collateralA.getAddress()),
        debtAsset: BigInt(await debtA.getAddress()),
        currentIndex,
        controlSecret: randSecret(),
        salt: randSecret(),
      });
      state.debt = 100n * WAD; // position originates with hidden debt
      await veil.createPosition(await collateralA.getAddress(), await debtA.getAddress(), bytes32(await computeCommitment(state)));
      const dep = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 100n * WAD, currentIndex, newSalt: randSecret() });
      const { callArgs } = await generateProof(dep.inputs);
      await veil.connect(user).deposit(toInputs(dep.publicSignals), callArgs.pA, callArgs.pB, callArgs.pC);
      // hidden: collateral 100e18 (val 200), debt 100e18 (val 100, required 75) → solvent

      // borrow that would over-leverage: debt 367e18 → required 275 > 200
      const bad = await buildRiskTransition({
        oldState: dep.newState,
        actionId: ACTION_BORROW,
        amount: 267n * WAD,
        currentIndex,
        newSalt: randSecret(),
        params: { collateralPrice: 2n * 10n ** 8n, debtPrice: 10n ** 8n, maxLtvBps: 7500n },
        recipient: BigInt(user.address),
      });
      await expect(generateProof(bad.inputs, "risk_transition")).to.be.rejected;

      // withdraw that would leave the position unsafe: collateral 1e18 (val 2) < required 75
      const badW = await buildRiskTransition({
        oldState: dep.newState,
        actionId: ACTION_WITHDRAW,
        amount: 99n * WAD,
        currentIndex,
        newSalt: randSecret(),
        params: { collateralPrice: 2n * 10n ** 8n, debtPrice: 10n ** 8n, maxLtvBps: 7500n },
        recipient: BigInt(user.address),
      });
      await expect(generateProof(badW.inputs, "risk_transition")).to.be.rejected;

      // healthy position cannot be liquidated (eligibility unprovable):
      // colVal*10000 (2e32) is NOT < debtVal*8500 (8.5e31)
      const liq = await buildLiquidationWitness(
        dep.newState,
        {
          collateralPrice: 2n * 10n ** 8n,
          debtPrice: 10n ** 8n,
          liquidationThresholdBps: 8500n,
        },
        BigInt(user.address)
      );
      await expect(generateProof(liq.inputs, "liquidation")).to.be.rejected;
    });

    it("a proof for commitment A never authorizes a transition for commitment B", async () => {
      const { veil, user, collateralA, debtA } = await loadFixture(deployFuzzFixture);
      const currentIndex = await veil.currentDebtIndex(await debtA.getAddress());
      const colAddr = BigInt(await collateralA.getAddress());
      const debtAddr = BigInt(await debtA.getAddress());
      const mk = (id: bigint) =>
        makeInitialState({
          positionId: id,
          collateralAsset: colAddr,
          debtAsset: debtAddr,
          currentIndex,
          controlSecret: randSecret(),
          salt: randSecret(),
        });
      const s1 = mk(1n);
      const s2 = mk(2n);
      await veil.createPosition(await collateralA.getAddress(), await debtA.getAddress(), bytes32(await computeCommitment(s1)));
      await veil.createPosition(await collateralA.getAddress(), await debtA.getAddress(), bytes32(await computeCommitment(s2)));

      // deposit transition proven for position 1's state, presented as position 2:
      // the commitment binding makes this impossible to pass.
      const t = await buildTransition({ oldState: s1, actionId: ACTION_DEPOSIT, amount: WAD, currentIndex, newSalt: randSecret() });
      const { callArgs } = await generateProof(t.inputs);
      const ps = t.publicSignals;
      await expect(
        veil.connect(user).deposit(
          { positionId: 2n, oldCommitment: ps[1], newCommitment: ps[2], nullifier: ps[3], actionId: ps[4], newSequence: ps[5], currentIndexLo: ps[6], currentIndexHi: ps[7], publicAmount: ps[8] },
          callArgs.pA,
          callArgs.pB,
          callArgs.pC
        )
      ).to.be.revertedWithCustomError(veil, "InvalidCommitment");
      expect((await veil.positions(2n)).sequence).to.equal(0n); // untouched
      expect((await veil.positions(2n)).activeCommitment).to.equal(bytes32(await computeCommitment(s2)));
    });
  });
});
