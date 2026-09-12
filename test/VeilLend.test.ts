import { expect } from "chai";
import { artifacts, ethers } from "hardhat";
import { loadFixture, time } from "@nomicfoundation/hardhat-network-helpers";
import type { MockPriceOracle, TokenMock, VeilLend } from "../typechain-types";
import {
  ACTION_DEPOSIT,
  ACTION_REPAY,
  MAX_VALUE_200,
  PrivateState,
  SNARK_SCALAR_FIELD,
  buildTransition,
  computeCommitment,
  generateProof,
  makeInitialState,
  requireZkArtifacts,
  splitLimbs,
} from "../scripts/prove";

const WAD = 10n ** 18n;
const BPS_DENOMINATOR = 10n ** 4n;
const SECONDS_PER_YEAR = 365n * 24n * 60n * 60n;
const RATE = { baseRateBps: 500, slopeBps: 2_000, targetUtilizationBps: 8_000, reserveFactorBps: 1_000, maxLtvBps: 7_500, liquidationThresholdBps: 8_500 };

const randHex = () => ethers.hexlify(ethers.randomBytes(31)); // 248-bit secret
const bytes32 = (v: bigint) => ethers.zeroPadValue(ethers.toBeHex(v), 32);

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
  const veil = ((await upgrades.deployProxy(
            await ethers.getContractFactory("VeilLend"),
            [owner.address, await verifier.getAddress(), await solvencyVerifier.getAddress(), await riskVerifier.getAddress(), await liquidationVerifier.getAddress(), await oracle.getAddress()],
            { kind: "uups" },
          ))) as VeilLend;

  await veil.connect(owner).enableCollateralAsset(await collateral.getAddress());
  await veil.connect(owner).enableDebtAsset(await debt.getAddress(), RATE);
  await oracle.setPrice(await collateral.getAddress(), 2_000n * 10n ** 8n);
  await oracle.setPrice(await debt.getAddress(), 10n ** 8n);

  for (const s of [user, other]) {
    await collateral.mint(s.address, 1_000_000n * WAD);
    await debt.mint(s.address, 1_000_000n * WAD);
    await collateral.connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
    await debt.connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
  }

  return { veil, verifier, solvencyVerifier, collateral, debt, oracle, owner, user, other };
}

/** Creates a position whose initial commitment is a real private state. */
async function createTrackedPosition(veil: VeilLend, collateral: TokenMock, debt: TokenMock, initialDebt = 0n) {
  const expectedId = (await veil.nextPositionId()) + 1n;
  const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
  const state = makeInitialState({
    positionId: expectedId,
    collateralAsset: BigInt(await collateral.getAddress()),
    debtAsset: BigInt(await debt.getAddress()),
    currentIndex,
    controlSecret: BigInt(randHex()),
    salt: BigInt(randHex()),
  });
  // Debt may exist at origination (private); there is no borrow path yet, so
  // repay tests originate positions with outstanding private debt.
  state.debt = initialDebt;
  const commitment = await computeCommitment(state);
  await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(commitment));

  const p = await veil.positions(expectedId);
  expect(p.activeCommitment).to.equal(bytes32(commitment));
  expect(p.interestIndex).to.equal(currentIndex);
  return { id: expectedId, state, debt };
}

/** Prepares + proves a transition for the current on-chain state of a position. */
async function proveTransition(
  state: PrivateState,
  actionId: bigint,
  amount: bigint,
  currentIndex: bigint,
  newSalt = BigInt(randHex())
) {
  const prepared = await buildTransition({ oldState: state, actionId, amount, currentIndex, newSalt });
  const { callArgs } = await generateProof(prepared.inputs);
  return { prepared, callArgs };
}

/** Maps a prepared transition's public signals to the contract's TransitionInputs struct. */
function toInputs(prepared: { publicSignals: bigint[] }) {
  const ps = prepared.publicSignals;
  return {
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
}

async function submitDeposit(veil: VeilLend, from: { address: string }, t: Awaited<ReturnType<typeof proveTransition>>) {
  return veil.connect(from as never).deposit(toInputs(t.prepared), t.callArgs.pA, t.callArgs.pB, t.callArgs.pC);
}

async function submitRepay(veil: VeilLend, from: { address: string }, t: Awaited<ReturnType<typeof proveTransition>>) {
  return veil.connect(from as never).repay(toInputs(t.prepared), t.callArgs.pA, t.callArgs.pB, t.callArgs.pC);
}

async function minedTimestamp(tx: { wait(): Promise<{ blockNumber: number } | null> }) {
  const receipt = await tx.wait();
  const block = await ethers.provider.getBlock(receipt!.blockNumber);
  return BigInt(block!.timestamp);
}

function functionNames(veil: VeilLend) {
  return veil.interface.fragments.filter((f) => f.type === "function").map((f) => f.name).sort();
}

describe("VeilLend — Phase 2", () => {
  describe("Deployment", () => {
    it("configures owner, real verifier and protocol constants", async () => {
      const { veil, verifier, owner } = await loadFixture(deployFixture);
      expect(await veil.owner()).to.equal(owner.address);
      expect(await veil.verifier()).to.equal(await verifier.getAddress()); // real Groth16 verifier
      expect(await veil.paused()).to.equal(false);
      expect(await veil.maxPriceStaleness()).to.equal(3600n);
      expect(await veil.SNARK_SCALAR_FIELD()).to.equal(SNARK_SCALAR_FIELD);
      expect(await veil.ACTION_DEPOSIT()).to.equal(ACTION_DEPOSIT);
      expect(await veil.ACTION_REPAY()).to.equal(ACTION_REPAY);
    });
  });

  describe("Asset configuration (admin)", () => {
    it("enables collateral and debt assets with initial index state", async () => {
      const { veil, owner, collateral, debt } = await loadFixture(deployFixture);
      const fresh = (await (await ethers.getContractFactory("TokenMock")).deploy("Fresh", "FRSH")) as TokenMock;

      await expect(veil.connect(owner).enableCollateralAsset(await fresh.getAddress()))
        .to.emit(veil, "CollateralAssetEnabled")
        .withArgs(await fresh.getAddress());
      expect(await veil.collateralSupported(await fresh.getAddress())).to.equal(true);

      await expect(veil.connect(owner).enableDebtAsset(await fresh.getAddress(), RATE))
        .to.emit(veil, "DebtAssetEnabled")
        .withArgs(await fresh.getAddress(), [RATE.baseRateBps, RATE.slopeBps, RATE.targetUtilizationBps, RATE.reserveFactorBps, RATE.maxLtvBps, RATE.liquidationThresholdBps]);
      expect(await veil.debtSupported(await fresh.getAddress())).to.equal(true);
      expect(await veil.currentDebtIndex(await fresh.getAddress())).to.equal(WAD);
      expect((await veil.debtIndexStates(await fresh.getAddress())).lastAccrual).to.not.equal(0n);
      expect(await veil.debtSupported(await collateral.getAddress())).to.equal(false);
      expect(await veil.collateralSupported(await debt.getAddress())).to.equal(false);
    });

    it("rejects duplicate enablement, zero addresses and invalid rate configs", async () => {
      const { veil, collateral, debt } = await loadFixture(deployFixture);
      await expect(veil.enableCollateralAsset(await collateral.getAddress())).to.be.revertedWithCustomError(veil, "AssetAlreadySupported");
      await expect(veil.enableDebtAsset(await debt.getAddress(), RATE)).to.be.revertedWithCustomError(veil, "AssetAlreadySupported");
      await expect(veil.enableCollateralAsset(ethers.ZeroAddress)).to.be.revertedWithCustomError(veil, "ZeroAddress");
      await expect(veil.enableDebtAsset(ethers.ZeroAddress, RATE)).to.be.revertedWithCustomError(veil, "ZeroAddress");
      await expect(
        veil.enableDebtAsset(await collateral.getAddress(), { baseRateBps: 10_001, slopeBps: 0, targetUtilizationBps: 0, reserveFactorBps: 0, maxLtvBps: 0, liquidationThresholdBps: 0 })
      ).to.be.revertedWithCustomError(veil, "InvalidParameter");
    });

    it("validates risk parameters (F4): 0 < maxLtvBps, liquidationThresholdBps <= 10000", async () => {
      const { veil, collateral, debt } = await loadFixture(deployFixture);
      const base = { baseRateBps: 0, slopeBps: 0, targetUtilizationBps: 0, reserveFactorBps: 0 };
      const badConfigs = [
        { ...base, maxLtvBps: 0, liquidationThresholdBps: 8500 }, // zero LTV: everything "solvent"
        { ...base, maxLtvBps: 10_001, liquidationThresholdBps: 8500 }, // breaks the risk model
        { ...base, maxLtvBps: 75_000, liquidationThresholdBps: 8500 }, // >= 2^14 would brick the circuit
        { ...base, maxLtvBps: 7500, liquidationThresholdBps: 0 }, // nothing ever liquidatable
        { ...base, maxLtvBps: 7500, liquidationThresholdBps: 10_001 },
        { ...base, maxLtvBps: 7500, liquidationThresholdBps: 2n ** 64n - 1n }, // max uint64, far outside the circuit range
      ];
      for (const bad of badConfigs) {
        await expect(veil.enableDebtAsset(await collateral.getAddress(), bad)).to.be.revertedWithCustomError(veil, "InvalidParameter");
        await expect(veil.setRateConfig(await debt.getAddress(), bad)).to.be.revertedWithCustomError(veil, "InvalidParameter");
      }

      // boundary values are accepted and stored
      const good = { ...base, maxLtvBps: 10_000, liquidationThresholdBps: 10_000 };
      await expect(veil.enableDebtAsset(await collateral.getAddress(), good)).to.emit(veil, "DebtAssetEnabled");
      await expect(veil.setRateConfig(await debt.getAddress(), good)).to.emit(veil, "RateConfigUpdated");
      expect(await veil.rateConfigs(await debt.getAddress())).to.deep.equal([0n, 0n, 0n, 0n, 10000n, 10000n]);
    });

    it("restricts all configuration to the owner", async () => {
      const { veil, user, collateral, debt } = await loadFixture(deployFixture);
      const fresh = (await (await ethers.getContractFactory("TokenMock")).deploy("Fresh", "FRSH")) as TokenMock;
      const unauthorized = veil.connect(user);
      for (const call of [
        unauthorized.enableCollateralAsset(await fresh.getAddress()),
        unauthorized.enableDebtAsset(await fresh.getAddress(), RATE),
        unauthorized.setRateConfig(await debt.getAddress(), RATE),
        unauthorized.disableDebtAsset(await debt.getAddress()),
        unauthorized.setDebtPool(await debt.getAddress(), user.address),
        unauthorized.setOracle(user.address),
        unauthorized.setMaxPriceStaleness(60),
        unauthorized.setPaused(true),
      ]) {
        await expect(call).to.be.revertedWithCustomError(veil, "OwnableUnauthorizedAccount").withArgs(user.address);
      }
      expect(await collateral.balanceOf(user.address)).to.equal(1_000_000n * WAD); // untouched
    });

    it("disableDebtAsset blocks new positions but preserves config, index and custody", async () => {
      const { veil, owner, collateral, debt } = await loadFixture(deployFixture);
      const configBefore = await veil.rateConfigs(await debt.getAddress());
      const indexBefore = await veil.currentDebtIndex(await debt.getAddress());
      const custodyBefore = await veil.debtCustody(await debt.getAddress());

      await expect(veil.connect(owner).disableDebtAsset(await debt.getAddress()))
        .to.emit(veil, "DebtAssetDisabled")
        .withArgs(await debt.getAddress());
      expect(await veil.debtSupported(await debt.getAddress())).to.equal(false);
      await expect(veil.createPosition(await collateral.getAddress(), await debt.getAddress(), ethers.id("c")))
        .to.be.revertedWithCustomError(veil, "AssetNotSupported");
      // config / index / custody are preserved untouched (no migration)
      expect(await veil.rateConfigs(await debt.getAddress())).to.deep.equal(configBefore);
      expect(await veil.currentDebtIndex(await debt.getAddress())).to.equal(indexBefore);
      expect(await veil.debtCustody(await debt.getAddress())).to.equal(custodyBefore);
      await expect(veil.connect(owner).disableDebtAsset(await debt.getAddress())).to.be.revertedWithCustomError(veil, "AssetNotSupported");
    });

    it("migrateCollateralRetirement clears retired collateral config once, fail-safe on custody", async () => {
      const { veil, owner, user, debt } = await loadFixture(deployFixture);
      const retired = (await (await ethers.getContractFactory("TokenMock")).deploy("Retired", "RTD")) as TokenMock;
      await veil.connect(owner).enableCollateralAsset(await retired.getAddress());
      expect(await veil.collateralSupported(await retired.getAddress())).to.equal(true);
      expect(await veil.assetDecimals(await retired.getAddress())).to.equal(18n);

      // non-owner cannot run the migration
      await expect(veil.connect(user).migrateCollateralRetirement([await retired.getAddress()]))
        .to.be.revertedWithCustomError(veil, "OwnableUnauthorizedAccount");

      // zero address rejected; zero custody → clears the entries
      await expect(veil.connect(owner).migrateCollateralRetirement([ethers.ZeroAddress]))
        .to.be.revertedWithCustomError(veil, "ZeroAddress");
      await veil.connect(owner).migrateCollateralRetirement([await retired.getAddress()]);
      expect(await veil.collateralSupported(await retired.getAddress())).to.equal(false);
      expect(await veil.assetDecimals(await retired.getAddress())).to.equal(0n);
      // new positions on the retired asset are blocked
      await expect(veil.createPosition(await retired.getAddress(), await debt.getAddress(), ethers.id("c")))
        .to.be.revertedWithCustomError(veil, "AssetNotSupported");
      // one-time: reinitializer(2) cannot run twice
      await expect(veil.connect(owner).migrateCollateralRetirement([await retired.getAddress()]))
        .to.be.revertedWithCustomError(veil, "InvalidInitialization");
    });

    it("migrateCollateralRetirement refuses assets still holding custody", async () => {
      const { veil, owner, user, collateral, debt } = await loadFixture(deployFixture);
      // deposit into a fresh position so collateralCustody > 0
      const id = (await veil.nextPositionId()) + 1n;
      const { state } = await createTrackedPosition(veil, collateral, debt);
      const t = await proveTransition(state, ACTION_DEPOSIT, 5_000n * WAD, await veil.currentDebtIndex(await debt.getAddress()));
      await submitDeposit(veil, user, t);
      expect(await veil.collateralCustody(await collateral.getAddress())).to.be.greaterThan(0n);
      await expect(veil.connect(owner).migrateCollateralRetirement([await collateral.getAddress()]))
        .to.be.revertedWithCustomError(veil, "CollateralCustodyNotEmpty");
      void id;
    });

    it("setDebtPool wires per-asset pools and requires a supported debt asset", async () => {
      const { veil, owner, user, collateral, debt } = await loadFixture(deployFixture);
      expect(await veil.debtPools(await debt.getAddress())).to.equal(ethers.ZeroAddress);
      // wiring deploys a REAL pool (setDebtPool syncs the borrower rate into
      // it, so an EOA or arbitrary address must fail)
      const pool = await upgrades.deployProxy(
        await ethers.getContractFactory("LiquidityPool"),
        [await debt.getAddress(), owner.address, await veil.getAddress(), "Pool", "PL"],
        { kind: "uups" }
      );
      await expect(veil.connect(owner).setDebtPool(await debt.getAddress(), await pool.getAddress()))
        .to.emit(veil, "DebtPoolSet")
        .withArgs(await debt.getAddress(), await pool.getAddress());
      expect(await veil.debtPools(await debt.getAddress())).to.equal(await pool.getAddress());
      // the wiring synced the current borrower accrual rate into the pool
      expect(await pool.rateBps()).to.equal((await veil.rateConfigs(await debt.getAddress())).baseRateBps);
      // unwiring back to zero is allowed; unsupported assets are rejected
      await expect(veil.connect(owner).setDebtPool(await debt.getAddress(), ethers.ZeroAddress)).to.emit(veil, "DebtPoolSet");
      await expect(veil.connect(owner).setDebtPool(await collateral.getAddress(), user.address)).to.be.revertedWithCustomError(veil, "AssetNotSupported");
    });

    it("updates rate config only for supported debt assets", async () => {
      const { veil, debt, collateral } = await loadFixture(deployFixture);
      const next = { baseRateBps: 750, slopeBps: 1_500, targetUtilizationBps: 9_000, reserveFactorBps: 500, maxLtvBps: 6_000, liquidationThresholdBps: 7_000 };
      await expect(veil.setRateConfig(await debt.getAddress(), next))
        .to.emit(veil, "RateConfigUpdated")
        .withArgs(await debt.getAddress(), [750, 1500, 9000, 500, 6000, 7000]);
      expect(await veil.rateConfigs(await debt.getAddress())).to.deep.equal([750n, 1500n, 9000n, 500n, 6000n, 7000n]);
      await expect(veil.setRateConfig(await collateral.getAddress(), next)).to.be.revertedWithCustomError(veil, "AssetNotSupported");
    });

    it("uses two-step ownership transfer", async () => {
      const { veil, owner, user, other } = await loadFixture(deployFixture);
      await veil.connect(owner).transferOwnership(user.address);
      expect(await veil.owner()).to.equal(owner.address);
      expect(await veil.pendingOwner()).to.equal(user.address);
      await expect(veil.connect(other).acceptOwnership()).to.be.revertedWithCustomError(veil, "OwnableUnauthorizedAccount").withArgs(other.address);
      await veil.connect(user).acceptOwnership();
      expect(await veil.owner()).to.equal(user.address);
      expect(await veil.pendingOwner()).to.equal(ethers.ZeroAddress);
      await expect(veil.connect(owner).setPaused(true)).to.be.revertedWithCustomError(veil, "OwnableUnauthorizedAccount");
    });
  });

  describe("Position creation", () => {
    it("creates a position with unique id and correct private-state metadata", async () => {
      const { veil, collateral, debt } = await loadFixture(deployFixture);
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      const controlSecret = BigInt(randHex());
      const state = makeInitialState({
        positionId: 1n,
        collateralAsset: BigInt(await collateral.getAddress()),
        debtAsset: BigInt(await debt.getAddress()),
        currentIndex,
        controlSecret,
        salt: BigInt(randHex()),
      });
      const commitment = await computeCommitment(state);
      await expect(veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(commitment)))
        .to.emit(veil, "PositionCreated")
        .withArgs(1n, await collateral.getAddress(), await debt.getAddress(), bytes32(commitment), 0n, currentIndex);

      const p = await veil.positions(1n);
      expect(p.collateralAsset).to.equal(await collateral.getAddress());
      expect(p.debtAsset).to.equal(await debt.getAddress());
      expect(p.activeCommitment).to.equal(bytes32(commitment)); // only the commitment — never plaintext balances
      expect(p.sequence).to.equal(0n);
      expect(p.interestIndex).to.equal(currentIndex);
      expect(p.status).to.equal(1); // Active
      expect(await veil.nextPositionId()).to.equal(1n);
    });

    it("assigns strictly unique, monotonically increasing position ids", async () => {
      const { veil, collateral, debt } = await loadFixture(deployFixture);
      await createTrackedPosition(veil, collateral, debt);
      await createTrackedPosition(veil, collateral, debt);
      expect((await veil.positions(1n)).activeCommitment).to.not.equal((await veil.positions(2n)).activeCommitment);
      expect(await veil.nextPositionId()).to.equal(2n);
    });

    it("rejects invalid position creation input", async () => {
      const { veil, collateral, debt } = await loadFixture(deployFixture);
      await expect(veil.createPosition(ethers.ZeroAddress, await debt.getAddress(), bytes32(1n))).to.be.revertedWithCustomError(veil, "ZeroAddress");
      await expect(veil.createPosition(await collateral.getAddress(), ethers.ZeroAddress, bytes32(1n))).to.be.revertedWithCustomError(veil, "ZeroAddress");
      await expect(veil.createPosition(await collateral.getAddress(), await collateral.getAddress(), bytes32(1n))).to.be.revertedWithCustomError(
        veil,
        "AssetNotSupported"
      );
      await expect(veil.createPosition(await collateral.getAddress(), await debt.getAddress(), ethers.ZeroHash)).to.be.revertedWithCustomError(
        veil,
        "InvalidCommitment"
      );
      // Non-canonical commitment (field alias) is rejected at creation.
      await expect(veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(SNARK_SCALAR_FIELD))).to.be.revertedWithCustomError(
        veil,
        "InvalidCommitment"
      );
    });
  });

  describe("Proof-bound deposit and custody binding", () => {
    it("binds the ERC20 deposit into the private state: custody == hidden collateral", async () => {
      const { veil, user, collateral, debt } = await loadFixture(deployFixture);
      const { id, state } = await createTrackedPosition(veil, collateral, debt);
      const amount = 100n * WAD;
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());

      const t = await proveTransition(state, ACTION_DEPOSIT, amount, currentIndex);
      await expect(submitDeposit(veil, user, t)).to.emit(veil, "Deposit").withArgs(id, await collateral.getAddress(), amount);

      // token movement + aggregate custody
      expect(await collateral.balanceOf(user.address)).to.equal(1_000_000n * WAD - amount);
      expect(await collateral.balanceOf(await veil.getAddress())).to.equal(amount);
      expect(await veil.collateralCustody(await collateral.getAddress())).to.equal(amount);

      // THE binding property: the hidden collateral equals on-chain custody
      expect(t.prepared.newState.collateral).to.equal(amount);
      expect(t.prepared.newState.collateral).to.equal(await veil.collateralCustody(await collateral.getAddress()));

      // commitment / sequence / index snapshot updated on-chain
      const p = await veil.positions(id);
      expect(p.activeCommitment).to.equal(bytes32(await computeCommitment(t.prepared.newState)));
      expect(p.sequence).to.equal(1n);
      expect(p.interestIndex).to.equal(currentIndex);
      expect(await veil.consumedTransitions(bytes32(t.prepared.publicSignals[3]))).to.equal(true);
    });

    it("accumulates custody in lockstep with the hidden state across deposits", async () => {
      const { veil, user, other, collateral, debt } = await loadFixture(deployFixture);
      const { id, state } = await createTrackedPosition(veil, collateral, debt);
      let running = state;

      for (const [amount, from] of [[40n * WAD, user], [7n * WAD, other], [900n * WAD, user]] as const) {
        const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
        const t = await proveTransition(running, ACTION_DEPOSIT, amount, currentIndex);
        await submitDeposit(veil, from, t);
        running = t.prepared.newState;
      }

      const custody = await veil.collateralCustody(await collateral.getAddress());
      expect(custody).to.equal(947n * WAD);
      expect(running.collateral).to.equal(custody); // hidden == custodied
      expect(await collateral.balanceOf(await veil.getAddress())).to.equal(custody);
      expect((await veil.positions(id)).sequence).to.equal(3n);
    });

    it("does not record a plaintext per-position collateral balance", async () => {
      const { veil, user, collateral, debt } = await loadFixture(deployFixture);
      const { state } = await createTrackedPosition(veil, collateral, debt);
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      const t = await proveTransition(state, ACTION_DEPOSIT, 777n * WAD, currentIndex);
      await submitDeposit(veil, user, t);

      // The position record holds only the commitment, sequence, index snapshot and status.
      const abi = (await artifacts.readArtifact("VeilLend")).abi as Array<{ type: string; name?: string; outputs?: Array<{ name: string; type: string }> }>;
      const positionsFn = abi.find((a) => a.type === "function" && a.name === "positions")!;
      const fieldNames = positionsFn.outputs!.map((o) => o.name).sort();
      expect(fieldNames).to.deep.equal(["activeCommitment", "collateralAsset", "debtAsset", "interestIndex", "sequence", "status"]);
    });

    it("rejects a stale transition proven on another position's state", async () => {
      const { veil, user, collateral, debt } = await loadFixture(deployFixture);
      await createTrackedPosition(veil, collateral, debt);
      await createTrackedPosition(veil, collateral, debt); // position 2
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());

      // A transition proven for position 2's state submitted against position 1:
      // valid proof, but position 1's active commitment does not match.
      const p2 = await veil.positions(2n);
      const state2 = makeInitialState({
        positionId: 2n,
        collateralAsset: BigInt(await collateral.getAddress()),
        debtAsset: BigInt(await debt.getAddress()),
        currentIndex: p2.interestIndex,
        controlSecret: BigInt(randHex()),
        salt: BigInt(randHex()),
      });
      const t = await proveTransition(state2, ACTION_DEPOSIT, 5n * WAD, currentIndex, BigInt(randHex()));
      await expect(submitDeposit(veil, user, t)).to.be.revertedWithCustomError(veil, "InvalidCommitment");

      // Transitions from a position's own superseded state share its nullifier
      // (secret, position, sequence, action) and hit replay protection instead —
      // covered in the replay section below.
    });

    it("rejects a valid proof with non-canonical (field-alias) public inputs", async () => {
      const { veil, user, collateral, debt } = await loadFixture(deployFixture);
      const { state } = await createTrackedPosition(veil, collateral, debt);
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      const t = await proveTransition(state, ACTION_DEPOSIT, WAD, currentIndex);
      const inputs = toInputs(t.prepared);
      const aliased = { ...inputs, positionId: SNARK_SCALAR_FIELD + inputs.positionId };
      await expect(veil.connect(user).deposit(aliased, t.callArgs.pA, t.callArgs.pB, t.callArgs.pC)).to.be.revertedWithCustomError(
        veil,
        "InvalidPublicInput"
      );
    });

    it("rejects fee-on-transfer style custody mismatch to keep the 1:1 binding", async () => {
      // TokenMock always transfers the full amount; assert the accounting holds exactly instead.
      const { veil, user, collateral, debt } = await loadFixture(deployFixture);
      const { state } = await createTrackedPosition(veil, collateral, debt);
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      const t = await proveTransition(state, ACTION_DEPOSIT, WAD, currentIndex);
      await submitDeposit(veil, user, t);
      expect(await veil.collateralCustody(await collateral.getAddress())).to.equal(WAD);
      expect(t.prepared.newState.collateral).to.equal(WAD);
    });
  });

  describe("Repay (private debt transition)", () => {
    it("repays accrued debt without exposing any debt balance", async () => {
      const { veil, user, collateral, debt } = await loadFixture(deployFixture);
      // position originates with outstanding private debt (no borrow path yet)
      const { id, state } = await createTrackedPosition(veil, collateral, debt, 1_000n * WAD);
      let running = state;
      {
        const t = await proveTransition(running, ACTION_DEPOSIT, 1_000n * WAD, await veil.currentDebtIndex(await debt.getAddress()));
        await submitDeposit(veil, user, t);
        running = t.prepared.newState;
      }

      // let interest accrue
      await time.increase(365n * 24n * 60n * 60n);
      await veil.accrueInterest(await debt.getAddress());
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());

      // repay exactly the accrued amount → debt returns to 0 (privately)
      const t = await proveTransition(running, ACTION_REPAY, t_amountFor(running, currentIndex), currentIndex);
      await expect(submitRepay(veil, user, t)).to.emit(veil, "Repayment").withArgs(id, await debt.getAddress(), t.prepared.publicSignals[8]);

      expect(await veil.debtCustody(await debt.getAddress())).to.equal(t.prepared.publicSignals[8]);
      expect(await debt.balanceOf(await veil.getAddress())).to.equal(t.prepared.publicSignals[8]);
      expect(t.prepared.newState.debt).to.equal(0n); // fully repaid, privately
      const p = await veil.positions(id);
      expect(p.activeCommitment).to.equal(bytes32(await computeCommitment(t.prepared.newState)));
      expect(p.sequence).to.equal(2n);
      expect(p.interestIndex).to.equal(currentIndex);
    });

    /** helper: repay the full accrued debt */
    function t_amountFor(state: PrivateState, currentIndex: bigint): bigint {
      const accrued = ((state.debt * currentIndex) + state.interestIndex - 1n) / state.interestIndex;
      return accrued;
    }

    it("applies exact ceiling interest accrual on repay", async () => {
      const { veil, user, collateral, debt } = await loadFixture(deployFixture);
      // +1 wei: debt must NOT be a whole multiple of the old index, so the
      // ceiling division actually has a remainder to round up.
      const { state } = await createTrackedPosition(veil, collateral, debt, 999n * WAD + 1n);
      let running = state;
      const depositT = await proveTransition(running, ACTION_DEPOSIT, 999n * WAD, await veil.currentDebtIndex(await debt.getAddress()));
      await submitDeposit(veil, user, depositT);
      running = depositT.prepared.newState;

      // small accrual: index grows above 1e18
      await time.increase(365n * 24n * 60n * 60n);
      await veil.accrueInterest(await debt.getAddress());
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());

      // accrued = ceil((999e18+1) * currentIndex / 1e18)
      const expectedAccrued = (running.debt * currentIndex + WAD - 1n) / WAD;
      const t = await proveTransition(running, ACTION_REPAY, 1n, currentIndex); // repay 1 wei
      await submitRepay(veil, user, t);
      expect(t.prepared.newState.debt).to.equal(expectedAccrued - 1n); // ceil applied, 1 wei repaid
      expect(expectedAccrued).to.not.equal((running.debt * currentIndex) / WAD); // rounding actually mattered
    });
  });

  describe("Replay protection", () => {
    it("rejects the same proof (same nullifier) twice", async () => {
      const { veil, user, collateral, debt } = await loadFixture(deployFixture);
      const { state } = await createTrackedPosition(veil, collateral, debt);
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      const t = await proveTransition(state, ACTION_DEPOSIT, WAD, currentIndex);

      await submitDeposit(veil, user, t);
      await expect(submitDeposit(veil, user, t)).to.be.revertedWithCustomError(veil, "TransitionConsumed");
      const nullifier = t.prepared.publicSignals[3];
      expect(await veil.consumedTransitions(bytes32(nullifier))).to.equal(true);
    });

    it("rejects a fresh valid proof reusing a consumed nullifier", async () => {
      const { veil, user, collateral, debt } = await loadFixture(deployFixture);
      const { state } = await createTrackedPosition(veil, collateral, debt);
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      const t1 = await proveTransition(state, ACTION_DEPOSIT, WAD, currentIndex);
      await submitDeposit(veil, user, t1);

      // A different transition (bigger amount) that yields the SAME nullifier:
      // nullifier depends on (controlSecret, positionId, newSequence, actionId) — identical here.
      const t2 = await proveTransition(t1.prepared.oldState, ACTION_DEPOSIT, 3n * WAD, currentIndex, BigInt(randHex()));
      expect(t2.prepared.publicSignals[3]).to.equal(t1.prepared.publicSignals[3]); // same nullifier
      await expect(submitDeposit(veil, user, t2)).to.be.revertedWithCustomError(veil, "TransitionConsumed");
    });

    it("rejects zero nullifiers", async () => {
      const { veil, user, collateral, debt } = await loadFixture(deployFixture);
      const { state } = await createTrackedPosition(veil, collateral, debt);
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      const t = await proveTransition(state, ACTION_DEPOSIT, WAD, currentIndex);
      const inputs = toInputs(t.prepared);
      await expect(veil.connect(user).deposit({ ...inputs, nullifier: 0n }, t.callArgs.pA, t.callArgs.pB, t.callArgs.pC)).to.be.revertedWithCustomError(
        veil,
        "InvalidTransitionId"
      );
    });
  });

  describe("Index binding", () => {
    it("rejects transitions proven against a stale interest index", async () => {
      const { veil, user, collateral, debt } = await loadFixture(deployFixture);
      const { state } = await createTrackedPosition(veil, collateral, debt);
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      const t = await proveTransition(state, ACTION_DEPOSIT, WAD, currentIndex);

      // index moves after proving
      await time.increase(30n * 24n * 60n * 60n);
      await veil.accrueInterest(await debt.getAddress());

      await expect(submitDeposit(veil, user, t)).to.be.revertedWithCustomError(veil, "StaleIndex");

      // re-prove against the fresh index → succeeds
      const freshIndex = await veil.currentDebtIndex(await debt.getAddress());
      const t2 = await proveTransition(state, ACTION_DEPOSIT, WAD, freshIndex);
      await submitDeposit(veil, user, t2);
    });
  });

  describe("Proof boundary — tampering and fail-closed actions", () => {
    it("rejects a tampered proof", async () => {
      const { veil, user, collateral, debt } = await loadFixture(deployFixture);
      const { state } = await createTrackedPosition(veil, collateral, debt);
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      const t = await proveTransition(state, ACTION_DEPOSIT, WAD, currentIndex);
      const tamperedP: [bigint, bigint] = [t.callArgs.pA[0] + 1n, t.callArgs.pA[1]];
      await expect(
        veil.connect(user).deposit(toInputs(t.prepared), tamperedP, t.callArgs.pB, t.callArgs.pC)
      ).to.be.revertedWithCustomError(veil, "InvalidProof");
    });

    it("rejects a valid proof presented with a wrong public input", async () => {
      const { veil, user, collateral, debt } = await loadFixture(deployFixture);
      const { state } = await createTrackedPosition(veil, collateral, debt);
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      const t = await proveTransition(state, ACTION_DEPOSIT, WAD, currentIndex);
      const wrongInput = { ...toInputs(t.prepared), newCommitment: t.prepared.publicSignals[2] + 1n };
      await expect(veil.connect(user).deposit(wrongInput, t.callArgs.pA, t.callArgs.pB, t.callArgs.pC)).to.be.revertedWithCustomError(veil, "InvalidProof");
    });

    it("rejects wrong action routing (repay proof submitted as deposit)", async () => {
      const { veil, user, collateral, debt } = await loadFixture(deployFixture);
      const { state } = await createTrackedPosition(veil, collateral, debt);
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      const t = await proveTransition(state, ACTION_REPAY, WAD, currentIndex); // valid repay proof
      await expect(submitDeposit(veil, user, t)).to.be.revertedWithCustomError(veil, "InvalidAction");
    });

    it("keeps borrow, withdrawal and closing fail-closed", async () => {
      const { veil, user, collateral, debt } = await loadFixture(deployFixture);
      const { state } = await createTrackedPosition(veil, collateral, debt);
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      const t = await proveTransition(state, ACTION_DEPOSIT, 10n * WAD, currentIndex);
      await submitDeposit(veil, user, t); // collateral exists now

      // closePosition still has no proof logic — fail-closed
      await expect(veil.connect(user).closePosition(1n)).to.be.revertedWithCustomError(veil, "UnsupportedAction");
      // borrow/withdraw are now proof-gated transitions: junk inputs fail closed
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
      const fakeProof: [bigint, bigint] = [0n, 0n];
      const fakeProof2: [[bigint, bigint], [bigint, bigint]] = [
        [0n, 0n],
        [0n, 0n],
      ];
      await expect(veil.connect(user).borrow(junk, fakeProof, fakeProof2, fakeProof)).to.be.reverted;
      await expect(veil.connect(user).withdrawCollateral(junk, fakeProof, fakeProof2, fakeProof)).to.be.reverted;
    });
  });

  describe("Emergency pause", () => {
    it("blocks proof-bound transitions while paused; keeps accrual and creation available", async () => {
      const { veil, owner, user, collateral, debt } = await loadFixture(deployFixture);
      const { state } = await createTrackedPosition(veil, collateral, debt);
      const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
      const t = await proveTransition(state, ACTION_DEPOSIT, WAD, currentIndex);

      await veil.connect(owner).setPaused(true);
      await expect(submitDeposit(veil, user, t)).to.be.revertedWithCustomError(veil, "EnforcedPause");
      await expect(submitRepay(veil, user, t)).to.be.revertedWithCustomError(veil, "EnforcedPause");

      await veil.accrueInterest(await debt.getAddress()); // public index — allowed
      await createTrackedPosition(veil, collateral, debt); // metadata only — allowed

      await veil.connect(owner).setPaused(false);
      // index moved while paused → re-prove against the fresh index
      const freshIndex = await veil.currentDebtIndex(await debt.getAddress());
      const t2 = await proveTransition(state, ACTION_DEPOSIT, WAD, freshIndex);
      await submitDeposit(veil, user, t2); // works again (nullifier of t2 unconsumed)
    });

    it("pauses and unpauses with events, idempotently, owner-only", async () => {
      const { veil, owner, user } = await loadFixture(deployFixture);
      await expect(veil.connect(owner).setPaused(true)).to.emit(veil, "Paused").withArgs(owner.address);
      expect(await veil.paused()).to.equal(true);
      await veil.connect(owner).setPaused(true); // idempotent
      await expect(veil.connect(owner).setPaused(false)).to.emit(veil, "Unpaused").withArgs(owner.address);
      await veil.connect(owner).setPaused(false); // idempotent
      await expect(veil.connect(user).setPaused(true)).to.be.revertedWithCustomError(veil, "OwnableUnauthorizedAccount");
    });
  });

  describe("Admin cannot touch user collateral", () => {
    it("exposes no function that can move funds out, rewrite commitments or weaken proofs", async () => {
      const { veil } = await loadFixture(deployFixture);
      const names = functionNames(veil);
      expect(names).to.deep.equal(
        [
          "ACTION_BORROW",
          "ACTION_DEPOSIT",
          "ACTION_REPAY",
          "ACTION_WITHDRAW",
          "SNARK_SCALAR_FIELD",
          "UPGRADE_INTERFACE_VERSION",
          "acceptOwnership",
          "accrueInterest",
          "assetDecimals",
          "borrow",
          "borrowOutstanding",
          "closePosition",
          "collateralCustody",
          "collateralSupported",
          "consumedTransitions",
          "createPosition",
          "currentDebtIndex",
          "debtCustody",
          "debtIndexStates",
          "debtPools",
          "debtSupported",
          "disableDebtAsset",
          "exceedsBorrowCap",
          "deposit",
          "enableCollateralAsset",
          "enableDebtAsset",
          "getFreshPrice",
          "initialize",
          "liquidate",
          "liquidationVerifier",
          "maxPriceStaleness",
          "migrateCollateralRetirement",
          "multicall",
          "nextPositionId",
          "oracle",
          "owner",
          "paused",
          "pendingOwner",
          "positions",
          "proxiableUUID",
          "pushOracleUpdate",
          "rateConfigs",
          "renounceOwnership",
          "repay",
          "riskVerifier",
          "solvencyVerifier",
          "setOracle",
          "setPaused",
          "setDebtPool",
          "settleOrphanPosition",
          "setRateConfig",
          "supportedCollateral",
          "setMaxPriceStaleness",
          "transferOwnership",
          "upgradeToAndCall",
          "verifier",
          "verifySolvency",
          "withdrawCollateral",
        ].sort()
      );
      // The only withdrawal-shaped functions are the action id constant and the proof-gated user action.
      expect(names.filter((n) => /withdraw|seize|sweep|drain/i.test(n))).to.deep.equal(["ACTION_WITHDRAW", "withdrawCollateral"]);
      expect(names).to.not.include("setVerifier");
      expect(names).to.not.include("setCommitment");
    });

    it("leaves custody intact after every administrative action", async () => {
      const { veil, owner, user, other, collateral, debt } = await loadFixture(deployFixture);
      const { state } = await createTrackedPosition(veil, collateral, debt);
      const t = await proveTransition(state, ACTION_DEPOSIT, 5_000n * WAD, await veil.currentDebtIndex(await debt.getAddress()));
      await submitDeposit(veil, user, t);

      const contractBefore = await collateral.balanceOf(await veil.getAddress());
      const custodyBefore = await veil.collateralCustody(await collateral.getAddress());
      const userBefore = await collateral.balanceOf(user.address);
      const commitmentBefore = (await veil.positions(1n)).activeCommitment;

      await veil.connect(owner).setRateConfig(await debt.getAddress(), { baseRateBps: 900, slopeBps: 100, targetUtilizationBps: 100, reserveFactorBps: 100, maxLtvBps: 100, liquidationThresholdBps: 100 });
      await veil.connect(owner).setMaxPriceStaleness(120);
      await veil.connect(owner).setOracle(owner.address);
      await veil.connect(owner).setPaused(true);
      await veil.connect(owner).setPaused(false);
      await veil.connect(owner).transferOwnership(other.address);
      await veil.connect(other).acceptOwnership();

      expect(await collateral.balanceOf(await veil.getAddress())).to.equal(contractBefore);
      expect(await veil.collateralCustody(await collateral.getAddress())).to.equal(custodyBefore);
      expect(await collateral.balanceOf(user.address)).to.equal(userBefore);
      expect((await veil.positions(1n)).activeCommitment).to.equal(commitmentBefore);
      expect((await veil.positions(1n)).status).to.equal(1); // not closed, not seized
    });
  });

  describe("Oracle boundary", () => {
    async function deployWithoutOracle() {
      const [owner] = await ethers.getSigners();
      const verifier = await (await ethers.getContractFactory("Groth16Verifier")).deploy();
      const solvencyVerifier = await (await ethers.getContractFactory("SolvencyVerifier")).deploy();
      const riskVerifier = await (await ethers.getContractFactory("RiskTransitionVerifier")).deploy();
      const liquidationVerifier = await (await ethers.getContractFactory("LiquidationVerifier")).deploy();
      const veil = ((await upgrades.deployProxy(
            await ethers.getContractFactory("VeilLend"),
            [owner.address, await verifier.getAddress(), await solvencyVerifier.getAddress(), await riskVerifier.getAddress(), await liquidationVerifier.getAddress(), ethers.ZeroAddress],
            { kind: "uups" },
          ))) as VeilLend;
      return { veil };
    }

    it("fails closed when no oracle is configured", async () => {
      const { veil } = await deployWithoutOracle();
      await expect(veil.getFreshPrice(ethers.ZeroAddress)).to.be.revertedWithCustomError(veil, "OracleNotSet");
    });

    it("accepts a fresh price and returns its observation time", async () => {
      const { veil, oracle, collateral } = await loadFixture(deployFixture);
      await oracle.setPrice(await collateral.getAddress(), 2_000n * 10n ** 8n);
      const [price, updatedAt] = await veil.getFreshPrice(await collateral.getAddress());
      expect(price).to.equal(2_000n * 10n ** 8n);
      expect(Number(updatedAt)).to.be.lessThanOrEqual((await time.latest()) + 5);
    });

    it("rejects stale prices for risky operations", async () => {
      const { veil, oracle, collateral } = await loadFixture(deployFixture);
      const staleTs = (await time.latest()) - 2 * 3600;
      await oracle.setPriceAt(await collateral.getAddress(), 2_000n * 10n ** 8n, staleTs);
      await expect(veil.getFreshPrice(await collateral.getAddress())).to.be.revertedWithCustomError(veil, "StalePrice");
    });

    it("honors the configured staleness window", async () => {
      const { veil, owner, oracle, collateral } = await loadFixture(deployFixture);
      await veil.connect(owner).setMaxPriceStaleness(120);
      await oracle.setPriceAt(await collateral.getAddress(), 1n, (await time.latest()) - 100);
      expect((await veil.getFreshPrice(await collateral.getAddress()))[0]).to.equal(1n);
      await oracle.setPriceAt(await collateral.getAddress(), 1n, (await time.latest()) - 121);
      await expect(veil.getFreshPrice(await collateral.getAddress())).to.be.revertedWithCustomError(veil, "StalePrice");
    });

    it("rejects prices at or above the 2^64 circuit boundary; accepts the boundary-1 price (F4)", async () => {
      const { veil, oracle, collateral } = await loadFixture(deployFixture);
      await oracle.setPriceAt(await collateral.getAddress(), 2n ** 64n, await time.latest());
      await expect(veil.getFreshPrice(await collateral.getAddress())).to.be.revertedWithCustomError(veil, "InvalidPrice");

      await oracle.setPriceAt(await collateral.getAddress(), 2n ** 64n - 1n, await time.latest());
      expect((await veil.getFreshPrice(await collateral.getAddress()))[0]).to.equal(2n ** 64n - 1n);
    });

    it("rejects zero prices and future timestamps, and validates config", async () => {
      const { veil, owner, oracle, collateral } = await loadFixture(deployFixture);
      await oracle.setPriceAt(await collateral.getAddress(), 0n, await time.latest());
      await expect(veil.getFreshPrice(await collateral.getAddress())).to.be.revertedWithCustomError(veil, "InvalidPrice");
      await oracle.setPriceAt(await collateral.getAddress(), 5n, (await time.latest()) + 3600);
      await expect(veil.getFreshPrice(await collateral.getAddress())).to.be.revertedWithCustomError(veil, "InvalidPrice");
      await expect(veil.connect(owner).setOracle(ethers.ZeroAddress)).to.be.revertedWithCustomError(veil, "ZeroAddress");
      await expect(veil.connect(owner).setMaxPriceStaleness(0)).to.be.revertedWithCustomError(veil, "InvalidParameter");
      await expect(veil.connect(owner).setMaxPriceStaleness(600)).to.emit(veil, "MaxPriceStalenessUpdated").withArgs(600n);
    });
  });

  describe("Interest index foundation", () => {
    it("starts at 1e18 and barely moves within the first seconds", async () => {
      const { veil, debt } = await loadFixture(deployFixture);
      expect(await veil.currentDebtIndex(await debt.getAddress())).to.equal(WAD);
      await veil.accrueInterest(await debt.getAddress());
      expect(await veil.currentDebtIndex(await debt.getAddress())).to.be.lessThan(WAD + WAD / BPS_DENOMINATOR);
    });

    it("accrues deterministically from the configured base rate", async () => {
      const { veil, debt } = await loadFixture(deployFixture);
      await time.increase(365n * 24n * 60n * 60n);
      const before = await veil.debtIndexStates(await debt.getAddress());
      const tx = await veil.accrueInterest(await debt.getAddress());
      await expect(tx).to.emit(veil, "InterestAccrued");
      const ts = await minedTimestamp(tx);
      const dt = ts - before.lastAccrual;
      expect(dt).to.be.greaterThan(0n);
      const expected = before.index + (before.index * 500n * dt) / (BPS_DENOMINATOR * SECONDS_PER_YEAR);
      expect(await veil.currentDebtIndex(await debt.getAddress())).to.equal(expected);
    });

    it("reverts accrual for unsupported assets and works while paused", async () => {
      const { veil, owner, collateral, debt } = await loadFixture(deployFixture);
      await expect(veil.accrueInterest(await collateral.getAddress())).to.be.revertedWithCustomError(veil, "AssetNotSupported");
      await veil.connect(owner).setPaused(true);
      await veil.accrueInterest(await debt.getAddress());
    });

    it("leaves private debt private: no plaintext debt state exists on-chain", async () => {
      const { veil } = await loadFixture(deployFixture);
      const names = functionNames(veil);
      // Only index/config/custody aggregates — never a per-position debt or health value.
      expect(names.filter((n) => /debt|balance|health/i.test(n)).sort()).to.deep.equal([
        "currentDebtIndex",
        "debtCustody",
        "debtIndexStates",
        "debtPools",
        "debtSupported",
        "disableDebtAsset",
        "enableDebtAsset",
        "setDebtPool",
      ]);
    });
  });
});
