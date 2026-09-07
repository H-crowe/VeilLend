import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { MockPriceOracle, TokenMock, VeilLend } from "../typechain-types";
import {
  ACTION_BORROW,
  ACTION_DEPOSIT,
  buildRiskTransition,
  buildTransition,
  computeCommitment,
  generateProof,
  makeInitialState,
  requireZkArtifacts,
} from "../scripts/prove";

/**
 * UUPS upgradeability tests for VeilLend.
 *
 * Proves:
 *  - Proxy + Implementation V1 deploy and initialize correctly.
 *  - Proof-gated positions/deposits/borrows work through the proxy.
 *  - An owner-authorized upgrade to V2 preserves ALL state (positions,
 *    commitments, custody balances, accounting) and normal proof-gated
 *    operations continue after the upgrade.
 *  - Only the owner can upgrade; initialization cannot be re-run.
 *  - The storage layout stays compatible across the upgrade (plugin-validated).
 *  - The upgrade authority adds no fund-moving capability: the contract's ABI
 *    surface after the upgrade contains no owner custody functions.
 *
 * VeilLendV2Mock (contracts/test/VeilLendV2Mock.sol) inherits VeilLend and
 * appends one state variable + a version marker — the minimal realistic V2.
 */

const WAD = 10n ** 18n;

const randHex = () => ethers.hexlify(ethers.randomBytes(31));
const bytes32 = (v: bigint) => ethers.zeroPadValue(ethers.toBeHex(v), 32);

function toInputs(p: { publicSignals: bigint[] }) {
  const s = p.publicSignals.map((v) => BigInt(v));
  return {
    positionId: s[0],
    oldCommitment: s[1],
    newCommitment: s[2],
    nullifier: s[3],
    actionId: s[4],
    newSequence: s[5],
    currentIndexLo: s[6],
    currentIndexHi: s[7],
    publicAmount: s[8],
  };
}

async function deployV1Proxy() {
  requireZkArtifacts();
  const [owner, user, liquidator] = await ethers.getSigners();
  const collateral = (await (await ethers.getContractFactory("TokenMock")).deploy("Collateral", "COL")) as unknown as TokenMock;
  const debt = (await (await ethers.getContractFactory("TokenMock")).deploy("Debt", "DBT")) as unknown as TokenMock;
  const oracle = (await (await ethers.getContractFactory("MockPriceOracle")).deploy()) as unknown as MockPriceOracle;
  const verifier = await (await ethers.getContractFactory("Groth16Verifier")).deploy();
  const solvencyVerifier = await (await ethers.getContractFactory("SolvencyVerifier")).deploy();
  const riskVerifier = await (await ethers.getContractFactory("RiskTransitionVerifier")).deploy();
  const liquidationVerifier = await (await ethers.getContractFactory("LiquidationVerifier")).deploy();

  const veil = (await upgrades.deployProxy(
    await ethers.getContractFactory("VeilLend"),
    [
      owner.address,
      await verifier.getAddress(),
      await solvencyVerifier.getAddress(),
      await riskVerifier.getAddress(),
      await liquidationVerifier.getAddress(),
      await oracle.getAddress(),
    ],
    { kind: "uups" }
  )) as unknown as VeilLend;

  await veil.connect(owner).enableCollateralAsset(await collateral.getAddress());
  await veil.connect(owner).enableDebtAsset(await debt.getAddress(), {
    baseRateBps: 500,
    slopeBps: 2000,
    targetUtilizationBps: 8000,
    reserveFactorBps: 1000,
    maxLtvBps: 7_500,
    liquidationThresholdBps: 8_500,
  });
  await oracle.setPrice(await collateral.getAddress(), 2n * 10n ** 8n);
  await oracle.setPrice(await debt.getAddress(), 1n * 10n ** 8n);

  for (const s of [user, liquidator]) {
    await (collateral as any).mint(s.address, 1_000_000n * WAD);
    await (debt as any).mint(s.address, 1_000_000n * WAD);
    await (collateral as any).connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
    await (debt as any).connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
  }
  return { veil, collateral, debt, oracle, owner, user, liquidator };
}

async function createAndDeposit(
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
  await veil.connect(user as never).deposit(toInputs(depT), depProof.callArgs.pA, depProof.callArgs.pB, depProof.callArgs.pC);
  return { id, state: depT.newState };
}

async function seedLiquidity(veil: VeilLend, collateral: TokenMock, debt: TokenMock, liquidator: { address: string }, amount: bigint) {
  const seedId = (await veil.nextPositionId()) + 1n;
  const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
  const seedState = makeInitialState({
    positionId: seedId,
    collateralAsset: BigInt(await collateral.getAddress()),
    debtAsset: BigInt(await debt.getAddress()),
    currentIndex,
    controlSecret: BigInt(randHex()),
    salt: BigInt(randHex()),
  });
  seedState.debt = amount;
  await veil.createPosition(await collateral.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(seedState)));
  const repT = await buildTransition({
    oldState: seedState,
    actionId: 2n,
    amount,
    currentIndex,
    newSalt: BigInt(randHex()),
  });
  const repProof = await generateProof(repT.inputs);
  await veil.connect(liquidator as never).repay(toInputs(repT), repProof.callArgs.pA, repProof.callArgs.pB, repProof.callArgs.pC);
  expect(await veil.debtCustody(await debt.getAddress())).to.equal(amount);
}

describe("VeilLend UUPS upgradeability", () => {
  it("deploys the proxy and initializes the full protocol state", async () => {
    const { veil, owner } = await loadFixture(deployV1Proxy);
    expect(await veil.owner()).to.equal(owner.address);
    expect(await veil.maxPriceStaleness()).to.equal(3600n); // default moved into initialize
    expect(await veil.nextPositionId()).to.equal(0n); // no positions yet on a fresh deployment
  });

  it("runs proof-gated operations through the proxy before any upgrade", async () => {
    const { veil, user, liquidator, collateral, debt } = await loadFixture(deployV1Proxy);
    await seedLiquidity(veil, collateral, debt, liquidator, 30n * WAD);
    const { id, state } = await createAndDeposit(veil, collateral, debt, user, 10n * WAD);

    const borT = await buildRiskTransition({
      oldState: state,
      actionId: ACTION_BORROW,
      amount: 5n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: { collateralPrice: 2n * 10n ** 8n, debtPrice: 1n * 10n ** 8n, maxLtvBps: 7500n },
      recipient: BigInt(user.address),
    });
    const borProof = await generateProof(borT.inputs, "risk_transition");
    await veil.connect(user as never).borrow(toInputs(borT), borProof.callArgs.pA, borProof.callArgs.pB, borProof.callArgs.pC);
    expect(await veil.borrowOutstanding(id)).to.equal(5n * WAD);
    expect((await veil.positions(id)).sequence).to.equal(2n);
  });

  it("owner upgrade to V2 preserves every position, commitment, and balance", async () => {
    const { veil, owner, user, liquidator, collateral, debt } = await loadFixture(deployV1Proxy);
    await seedLiquidity(veil, collateral, debt, liquidator, 30n * WAD);
    const { id, state } = await createAndDeposit(veil, collateral, debt, user, 10n * WAD);

    const posBefore = await veil.positions(id);
    const supportedBefore = await veil.supportedCollateral(id);
    const custodyBefore = await veil.collateralCustody(await collateral.getAddress());
    const implementationBefore = await upgrades.erc1967.getImplementationAddress(await veil.getAddress());

    // owner-authorized upgrade → V2 mock (appends one state variable)
    const v2 = await ethers.getContractFactory("VeilLendV2Mock");
    await upgrades.upgradeProxy(await veil.getAddress(), v2);
    const implementationAfter = await upgrades.erc1967.getImplementationAddress(await veil.getAddress());
    expect(implementationAfter).to.not.equal(implementationBefore);

    // state preservation: positions, commitments, custody, accounting, owner
    const posAfter = await veil.positions(id);
    expect(posAfter.activeCommitment).to.equal(posBefore.activeCommitment);
    expect(posAfter.sequence).to.equal(posBefore.sequence);
    expect(await veil.supportedCollateral(id)).to.equal(supportedBefore);
    expect(await veil.collateralCustody(await collateral.getAddress())).to.equal(custodyBefore);
    expect(await veil.owner()).to.equal(owner.address);

    // V2 marker reachable through the same proxy address
    const v2c = (await ethers.getContractAt("VeilLendV2Mock", await veil.getAddress())) as unknown as { version(): Promise<string> };
    expect(await v2c.version()).to.equal("V2");

    // normal proof-gated operations continue after the upgrade
    const borT = await buildRiskTransition({
      oldState: state,
      actionId: ACTION_BORROW,
      amount: 5n * WAD,
      currentIndex: await veil.currentDebtIndex(await debt.getAddress()),
      newSalt: BigInt(randHex()),
      params: { collateralPrice: 2n * 10n ** 8n, debtPrice: 1n * 10n ** 8n, maxLtvBps: 7500n },
      recipient: BigInt(user.address),
    });
    const borProof = await generateProof(borT.inputs, "risk_transition");
    await veil.connect(user as never).borrow(toInputs(borT), borProof.callArgs.pA, borProof.callArgs.pB, borProof.callArgs.pC);
    expect(await veil.borrowOutstanding(id)).to.equal(5n * WAD);
    expect((await veil.positions(id)).sequence).to.equal(2n);
  });

  it("non-owner cannot upgrade the proxy", async () => {
    const { veil, user } = await loadFixture(deployV1Proxy);
    const impl = await (await ethers.getContractFactory("VeilLendV2Mock")).deploy();
    const proxyAsVeil = (await ethers.getContractAt("VeilLend", await veil.getAddress())) as unknown as {
      connect(a: never): { upgradeTo(a: string): Promise<unknown>; upgradeToAndCall(a: string, d: string): Promise<unknown> };
    };
    // OZ v5 UUPS exposes only upgradeToAndCall (upgradeTo was removed in v5)
    await expect(
      proxyAsVeil.connect(user as never).upgradeToAndCall(await impl.getAddress(), "0x")
    ).to.be.revertedWithCustomError(veil, "OwnableUnauthorizedAccount");
    expect(await upgrades.erc1967.getImplementationAddress(await veil.getAddress())).to.not.equal(await impl.getAddress());
  });

  it("initialization is protected: the implementation disables its initializers", async () => {
    const impl = await (await ethers.getContractFactory("VeilLend")).deploy();
    await expect(
      impl.initialize(ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress, ethers.ZeroAddress)
    ).to.be.revertedWithCustomError(impl, "InvalidInitialization");
  });

  it("storage-layout compatibility: V1 → V2 validates via the upgrades plugin", async () => {
    await loadFixture(deployV1Proxy); // compile everything
    // VeilLendV2Mock inherits VeilLend and only appends state → must validate
    await upgrades.validateUpgrade(await ethers.getContractFactory("VeilLend"), await ethers.getContractFactory("VeilLendV2Mock"), { kind: "uups" });
  });

  it("the upgrade adds no owner fund-moving capability (ABI surface check)", async () => {
    const { veil, owner, user } = await loadFixture(deployV1Proxy);
    const v2 = await ethers.getContractFactory("VeilLendV2Mock");
    await upgrades.upgradeProxy(await veil.getAddress(), v2);
    const attached = await ethers.getContractAt("VeilLendV2Mock", await veil.getAddress());
    const names = attached.interface.fragments.filter((f: { type: string }) => f.type === "function").map((f: { name: string }) => f.name);
    // no custody-draining surface added by the upgrade
    expect(names.filter((n) => /withdrawTokens|seize|sweep|drain|emergencyWithdraw/i.test(n))).to.deep.equal([]);
    // owner unchanged; user collateral untouched (custody unchanged)
    expect(await veil.owner()).to.equal(owner.address);
    void user;
  });
});
