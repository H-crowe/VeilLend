import { expect } from "chai";
import {
  ACTION_DEPOSIT,
  ACTION_REPAY,
  MAX_VALUE_200,
  PrivateState,
  buildTransition,
  computeCommitment,
  computeNullifier,
  generateProof,
  makeInitialState,
  requireZkArtifacts,
  verifyLocally,
} from "../scripts/prove";

const WAD = 10n ** 18n;

function sampleState(overrides: Partial<PrivateState> = {}): PrivateState {
  return {
    positionId: 1n,
    collateralAsset: 0xa00000000000000000000000000000000000c01n, // 160-bit address
    debtAsset: 0xa00000000000000000000000000000000000c02n,
    collateral: 0n,
    debt: 0n,
    interestIndex: WAD,
    sequence: 0n,
    controlSecret: 0x11111111111111111111111111111111111111111111111111111111111111n,
    salt: 0x22222222222222222222222222222222222222222222222222222222222222n,
    ...overrides,
  };
}

async function expectWitnessRejected(inputs: Record<string, string>) {
  await expect(generateProof(inputs)).to.be.rejected;
}

describe("VeilLend ZK — circuit level", () => {
  before(() => requireZkArtifacts());

  describe("Commitment design", () => {
    it("is deterministic: same state → same commitment", async () => {
      const s = sampleState();
      expect(await computeCommitment(s)).to.equal(await computeCommitment({ ...s }));
    });

    it("changes when any private value changes", async () => {
      const base = await computeCommitment(sampleState());
      const variants: Array<[string, PrivateState]> = [
        ["positionId", sampleState({ positionId: 2n })],
        ["collateralAsset", sampleState({ collateralAsset: 0xa00000000000000000000000000000000000c03n })],
        ["debtAsset", sampleState({ debtAsset: 0xa00000000000000000000000000000000000c04n })],
        ["collateral", sampleState({ collateral: 1n })],
        ["debt", sampleState({ debt: 1n })],
        ["interestIndex", sampleState({ interestIndex: WAD + 1n })],
        ["sequence", sampleState({ sequence: 1n })],
        ["controlSecret", sampleState({ controlSecret: 0x11111111111111111111111111111111111111111111111111111111111112n })],
        ["salt", sampleState({ salt: 0x22222222222222222222222222222222222222222222222222222222222223n })],
      ];
      for (const [name, v] of variants) {
        expect(await computeCommitment(v), `variant ${name} must hash differently`).to.not.equal(base);
      }
    });

    it("rejects wrong field ordering in the witness", async () => {
      // canonical transition
      const state = sampleState({ collateral: 100n * WAD });
      const t = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: WAD, currentIndex: WAD, newSalt: 7n });

      // swap collateral and debt limbs (wrong field order) while keeping the canonical oldCommitment
      const permuted: Record<string, string> = {
        ...t.inputs,
        oldCollateralLo: t.inputs.oldDebtLo,
        oldCollateralHi: t.inputs.oldDebtHi,
        oldDebtLo: t.inputs.oldCollateralLo,
        oldDebtHi: t.inputs.oldCollateralHi,
      };
      await expectWitnessRejected(permuted);
    });

    it("rejects wrong value encoding (unsplit limbs)", async () => {
      const state = sampleState({ collateral: 100n * WAD });
      const t = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: WAD, currentIndex: WAD, newSalt: 7n });

      // collateral encoded as hi-limb only (value << 120) instead of the canonical lo/hi split
      const wrongEncoding: Record<string, string> = {
        ...t.inputs,
        oldCollateralLo: "0",
        oldCollateralHi: (100n * WAD).toString(),
      };
      await expectWitnessRejected(wrongEncoding);
    });
  });

  describe("Ownership / control secret", () => {
    it("accepts a transition proven with the correct control secret", async () => {
      const state = sampleState();
      const t = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: WAD, currentIndex: WAD, newSalt: 7n });
      const { proof, publicSignals } = await generateProof(t.inputs);
      expect(await verifyLocally(publicSignals, proof)).to.equal(true);
    });

    it("rejects a transition with the wrong control secret", async () => {
      const state = sampleState();
      const t = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: WAD, currentIndex: WAD, newSalt: 7n });
      // same (canonical) commitment, but a different claimed control secret → preimage check fails
      await expectWitnessRejected({ ...t.inputs, controlSecret: "123456789" });
    });
  });

  describe("Nullifier design", () => {
    it("is deterministic and unique per (position, sequence, action)", async () => {
      const s = sampleState();
      const n1 = await computeNullifier(s, ACTION_DEPOSIT, 1n);
      expect(n1).to.equal(await computeNullifier({ ...s }, ACTION_DEPOSIT, 1n));

      expect(await computeNullifier(s, ACTION_REPAY, 1n)).to.not.equal(n1); // different action
      expect(await computeNullifier(s, ACTION_DEPOSIT, 2n)).to.not.equal(n1); // different sequence
      expect(await computeNullifier({ ...s, positionId: 2n }, ACTION_DEPOSIT, 1n)).to.not.equal(n1); // different position
      expect(await computeNullifier({ ...s, controlSecret: 0x3333n }, ACTION_DEPOSIT, 1n)).to.not.equal(n1); // different secret
    });
  });

  describe("State transition proofs", () => {
    it("emits public signals in the exact documented order", async () => {
      const state = sampleState();
      const t = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: WAD, currentIndex: WAD, newSalt: 7n });
      const { publicSignals } = await generateProof(t.inputs);
      expect(publicSignals.map(BigInt)).to.deep.equal(t.publicSignals);
      expect(t.publicSignals[0]).to.equal(state.positionId); // positionId
      expect(t.publicSignals[1]).to.equal(await computeCommitment(state)); // oldCommitment
      expect(t.publicSignals[3]).to.equal(await computeNullifier(state, ACTION_DEPOSIT, 1n)); // nullifier
      expect(t.publicSignals[4]).to.equal(ACTION_DEPOSIT);
      expect(t.publicSignals[5]).to.equal(1n); // newSequence
      expect(t.publicSignals[8]).to.equal(WAD); // publicAmount
    });

    it("proves a valid deposit transition", async () => {
      const state = sampleState();
      const t = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 5n * WAD, currentIndex: WAD, newSalt: 7n });
      expect(t.newState.collateral).to.equal(5n * WAD);
      const { proof, publicSignals } = await generateProof(t.inputs);
      expect(await verifyLocally(publicSignals, proof)).to.equal(true);
    });

    it("proves a valid repay transition", async () => {
      const state = sampleState({ debt: 10n * WAD });
      const t = await buildTransition({ oldState: state, actionId: ACTION_REPAY, amount: 4n * WAD, currentIndex: WAD, newSalt: 7n });
      expect(t.newState.debt).to.equal(6n * WAD);
      const { proof, publicSignals } = await generateProof(t.inputs);
      expect(await verifyLocally(publicSignals, proof)).to.equal(true);
    });

    it("rejects an invalid old commitment / new commitment / wrong sequence in the public inputs", async () => {
      const state = sampleState();
      const t = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: WAD, currentIndex: WAD, newSalt: 7n });
      await expectWitnessRejected({ ...t.inputs, oldCommitment: "1" });
      await expectWitnessRejected({ ...t.inputs, newCommitment: "1" });
      await expectWitnessRejected({ ...t.inputs, newSequence: "5" }); // circuit forces old+1
      await expectWitnessRejected({ ...t.inputs, nullifier: "1" });
    });

    it("rejects an invalid action id", async () => {
      const state = sampleState();
      await expect(
        buildTransition({ oldState: state, actionId: 3n, amount: WAD, currentIndex: WAD, newSalt: 7n })
      ).to.be.rejectedWith(/unsupported actionId/);
      // even if hand-crafted into the witness, the circuit enforces actionId ∈ {1, 2}
      const t = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: WAD, currentIndex: WAD, newSalt: 7n });
      await expectWitnessRejected({ ...t.inputs, actionId: "3" });
    });

    it("rejects a malformed witness (missing field)", async () => {
      const state = sampleState();
      const t = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: WAD, currentIndex: WAD, newSalt: 7n });
      const broken = { ...t.inputs };
      delete broken.controlSecret;
      await expectWitnessRejected(broken);
    });

    it("rejects a tampered proof locally", async () => {
      const state = sampleState();
      const t = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: WAD, currentIndex: WAD, newSalt: 7n });
      const { proof, publicSignals } = await generateProof(t.inputs);
      expect(await verifyLocally(publicSignals, proof)).to.equal(true);

      const tampered: typeof proof = JSON.parse(JSON.stringify(proof));
      tampered.pi_a[0] = (BigInt(proof.pi_a[0]) + 1n).toString();
      expect(await verifyLocally(publicSignals, tampered)).to.equal(false);
    });

    it("rejects wrong public inputs locally", async () => {
      const state = sampleState();
      const t = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: WAD, currentIndex: WAD, newSalt: 7n });
      const { proof, publicSignals } = await generateProof(t.inputs);
      const wrong = [...publicSignals];
      wrong[2] = (BigInt(wrong[2]) + 1n).toString(); // newCommitment
      expect(await verifyLocally(wrong, proof)).to.equal(false);
    });
  });

  describe("Interest accounting in ZK (exact ceiling)", () => {
    // oldDebt = 10e18+1, oldIndex = 1e18, currentIndex = 3e18+1:
    // product = 30000000000000000004000000000000000001 → floor = …004, ceil = …005 (rounding matters)
    const state = () => sampleState({ debt: 10n * WAD + 1n, interestIndex: WAD });
    const NOW = 3n * WAD + 1n;
    const FLOOR = 30000000000000000013n;
    const CEIL = 30000000000000000014n;

    it("applies exact ceiling accrual on repay", async () => {
      const t = await buildTransition({ oldState: state(), actionId: ACTION_REPAY, amount: 1n, currentIndex: NOW, newSalt: 7n });
      expect(t.accruedDebt).to.equal(CEIL); // ceil, not floor
      expect(t.newState.debt).to.equal(CEIL - 1n);
      const { proof, publicSignals } = await generateProof(t.inputs);
      expect(await verifyLocally(publicSignals, proof)).to.equal(true);
    });

    it("rejects an incorrect (floor) accrual", async () => {
      const t = await buildTransition({ oldState: state(), actionId: ACTION_REPAY, amount: 1n, currentIndex: NOW, newSalt: 7n });
      // attacker claims floor accrual instead of ceil
      const fakeNewState = { ...t.oldState, debt: FLOOR - 1n, interestIndex: NOW, sequence: 1n, salt: 7n };
      const forged = { ...t.inputs, newCommitment: (await computeCommitment(fakeNewState)).toString() };
      await expectWitnessRejected(forged);
    });

    it("accepts the boundary case currentIndex == oldIndex (accrued == oldDebt)", async () => {
      const s = sampleState({ debt: 5n * WAD, interestIndex: WAD });
      const t = await buildTransition({ oldState: s, actionId: ACTION_DEPOSIT, amount: 1n, currentIndex: WAD, newSalt: 7n });
      expect(t.accruedDebt).to.equal(5n * WAD);
      const { proof, publicSignals } = await generateProof(t.inputs);
      expect(await verifyLocally(publicSignals, proof)).to.equal(true);
    });

    it("rejects a decreasing interest index", async () => {
      const s = sampleState({ debt: 5n * WAD, interestIndex: 3n * WAD });
      // hand-craft a witness whose new state uses a LOWER index (monotonicity violation)
      const t = await buildTransition({ oldState: s, actionId: ACTION_DEPOSIT, amount: 1n, currentIndex: 3n * WAD, newSalt: 7n });
      const fakeNewState = { ...t.oldState, collateral: s.collateral + 1n, interestIndex: WAD, sequence: 1n, salt: 7n };
      const forged = { ...t.inputs, newCommitment: (await computeCommitment(fakeNewState)).toString() };
      await expectWitnessRejected(forged);
    });

    it("rejects value overflow beyond the 200-bit range", async () => {
      // collateral = 1 + amount = 2^200-1 + 1 → exceeds the 200-bit range → prover refuses
      const s = sampleState({ collateral: 1n });
      await expect(
        buildTransition({ oldState: s, actionId: ACTION_DEPOSIT, amount: MAX_VALUE_200, currentIndex: WAD, newSalt: 7n })
      ).to.be.rejected;
    });
  });
});
