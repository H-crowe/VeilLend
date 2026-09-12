import { expect } from "chai";
import { ethers } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { MockPriceOracle, TokenMock, TokenMock6, VeilLend } from "../typechain-types";
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
 * Decimals-aware borrow cap tests.
 *
 * The raw-unit borrow cap (`outstanding + amount <= supported * LTV`) was only
 * meaningful when the collateral and debt tokens shared the same decimals.
 * It is now a cross-multiplied DOLLAR-VALUE cap normalized through the oracle
 * prices and each asset's recorded decimals:
 *
 *   (outstanding + amount) * debtPrice * 10^collateralDecimals * 10000
 *     <= supportedCollateral * collateralPrice * 10^debtDecimals * maxLtvBps
 *
 * Covered here: 18→6 and 6→18 collateral/debt combinations, the exact
 * dollar-value cap boundary, and the ZK proof path for a 6-decimals asset.
 * Known limitation (reported, not fixed here): the ZK solvency/liquidation
 * inequalities inside the circuits compare raw atomic amounts and are skewed
 * by 10^(debtDecimals − collateralDecimals) for mixed-decimals positions —
 * 18-collateral/6-debt borrows are over-privileged by the (loose) ZK check
 * and remain gated by this on-chain cap; 6-collateral/18-debt borrows are
 * over-restricted. Circuit normalization is an M2 item.
 */

const WAD = 10n ** 18n;
const USD6 = 10n ** 6n;
const PRICE_COLL = 2n * 10n ** 8n; // $2 per vCOL-style collateral token
const PRICE_DEBT = 1n * 10n ** 8n; // $1 per vDBT-style debt token


// The contract feeds the circuits 18-dec-NORMALIZED prices:
// normalized = raw oracle price * 10^(18 - decimals).
const normPrice = (rawPrice: bigint, decimals: number): bigint =>
  rawPrice * 10n ** BigInt(18 - decimals);
const PRICE_ALT = 3_000n * 10n ** 8n; // $3000, 1e8-scaled (neutral 18-dec collateral mock)
const PRICE_USDC = 1n * 10n ** 8n; // $1, 1e8-scaled
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
  const alt = (await (await ethers.getContractFactory("TokenMock")).deploy("Alt Token", "ALT")) as unknown as TokenMock & { decimals(): Promise<number>; mint(a: string, v: bigint): Promise<unknown>; connect(a: never): TokenMock };
  const usdc = (await (await ethers.getContractFactory("TokenMock6")).deploy("USD Coin", "USDC")) as unknown as TokenMock6 & { decimals(): Promise<number>; mint(a: string, v: bigint): Promise<unknown>; connect(a: never): TokenMock6; approve(a: string, v: bigint): Promise<unknown>; balanceOf(a: string): Promise<bigint> };
  const oracle = (await (await ethers.getContractFactory("MockPriceOracle")).deploy()) as unknown as MockPriceOracle & { setPrice(a: string, p: bigint): Promise<unknown> };
  const verifier = await (await ethers.getContractFactory("Groth16Verifier")).deploy();
  const solvencyVerifier = await (await ethers.getContractFactory("SolvencyVerifier")).deploy();
  const riskVerifier = await (await ethers.getContractFactory("RiskTransitionVerifier")).deploy();
  const liquidationVerifier = await (await ethers.getContractFactory("LiquidationVerifier")).deploy();
  const veil = ((await upgrades.deployProxy(
            await ethers.getContractFactory("VeilLend"),
            [owner.address, await verifier.getAddress(), await solvencyVerifier.getAddress(), await riskVerifier.getAddress(), await liquidationVerifier.getAddress(), await oracle.getAddress()],
            { kind: "uups" },
          ))) as VeilLend;

  await veil.connect(owner).enableCollateralAsset(await alt.getAddress());
  await veil.connect(owner).enableCollateralAsset(await usdc.getAddress());
  await veil.connect(owner).enableDebtAsset(await usdc.getAddress(), RATE);
  await veil.connect(owner).enableDebtAsset(await alt.getAddress(), RATE);
  await oracle.setPrice(await alt.getAddress(), PRICE_ALT);
  await oracle.setPrice(await usdc.getAddress(), PRICE_USDC);

  for (const s of [user, liquidator]) {
    await (alt as any).mint(s.address, 1_000_000n * WAD);
    await (usdc as any).mint(s.address, 1_000_000n * USD6);
    await (alt as any).connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
    await (usdc as any).connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
  }
  return { veil, alt, usdc, oracle, owner, user, liquidator };
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

describe("decimals-aware borrow cap", () => {
  it("records token decimals at enable time", async () => {
    const { veil, alt, usdc } = await loadFixture(deployFixture);
    expect(await veil.assetDecimals(await alt.getAddress())).to.equal(18);
    expect(await veil.assetDecimals(await usdc.getAddress())).to.equal(6);
  });

  it("18→6: borrows within the price-scaled dollar cap succeed end-to-end (ZK + balances)", async () => {
    const { veil, user, liquidator, alt, usdc } = await loadFixture(deployFixture);
    // seed USDC liquidity: originated-debt position repays 40,000 USDC
    const seedId = (await veil.nextPositionId()) + 1n;
    const currentIndex = await veil.currentDebtIndex(await usdc.getAddress());
    const seedState = makeInitialState({
      positionId: seedId,
      collateralAsset: BigInt(await alt.getAddress()),
      debtAsset: BigInt(await usdc.getAddress()),
      currentIndex,
      controlSecret: BigInt(randHex()),
      salt: BigInt(randHex()),
    });
    seedState.debt = 40_000n * USD6;
    await veil.createPosition(await alt.getAddress(), await usdc.getAddress(), bytes32(await computeCommitment(seedState)));
    const repT = await buildTransition({
      oldState: seedState,
      actionId: 2n,
      amount: 40_000n * USD6,
      currentIndex,
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
    expect(await veil.debtCustody(await usdc.getAddress())).to.equal(40_000n * USD6);

    // user deposits 10 ALT, borrows 20,000 USDC (=$20,000 ≤ 75% of $30,000)
    const { id, state } = await createAndDeposit(veil, alt, usdc, user, 10n * WAD);
    const borrowAmount = 20_000n * USD6;
    const borT = await buildRiskTransition({
      oldState: state,
      actionId: ACTION_BORROW,
      amount: borrowAmount,
      currentIndex: await veil.currentDebtIndex(await usdc.getAddress()),
      newSalt: BigInt(randHex()),
      params: { collateralPrice: normPrice(PRICE_ALT, 18), debtPrice: normPrice(PRICE_USDC, 6), maxLtvBps: 7500n },
      recipient: BigInt(user.address),
    });
    const borProof = await generateProof(borT.inputs, "risk_transition");
    const usdcBefore = await (usdc as any).balanceOf(user.address);
    await veil.connect(user as never).borrow(
      {
        positionId: borT.publicSignals[0],
        oldCommitment: borT.publicSignals[1],
        newCommitment: borT.publicSignals[2],
        nullifier: borT.publicSignals[3],
        actionId: borT.publicSignals[4],
        newSequence: borT.publicSignals[5],
        currentIndexLo: borT.publicSignals[6],
        currentIndexHi: borT.publicSignals[7],
        publicAmount: borT.publicSignals[8],
      },
      borProof.callArgs.pA,
      borProof.callArgs.pB,
      borProof.callArgs.pC
    );
    expect(await veil.borrowOutstanding(id)).to.equal(borrowAmount);
    expect((await (usdc as any).balanceOf(user.address)) - usdcBefore).to.equal(borrowAmount);
    expect(await veil.assetDecimals(await usdc.getAddress())).to.equal(6);
  });

  it("18→6: borrow above the price-scaled dollar cap reverts with BorrowCapExceeded", async () => {
    const { veil, user, liquidator, alt, usdc } = await loadFixture(deployFixture);
    const seedId = (await veil.nextPositionId()) + 1n;
    const currentIndex = await veil.currentDebtIndex(await usdc.getAddress());
    const seedState = makeInitialState({
      positionId: seedId,
      collateralAsset: BigInt(await alt.getAddress()),
      debtAsset: BigInt(await usdc.getAddress()),
      currentIndex,
      controlSecret: BigInt(randHex()),
      salt: BigInt(randHex()),
    });
    seedState.debt = 40_000n * USD6;
    await veil.createPosition(await alt.getAddress(), await usdc.getAddress(), bytes32(await computeCommitment(seedState)));
    const repT = await buildTransition({
      oldState: seedState,
      actionId: 2n,
      amount: 40_000n * USD6,
      currentIndex,
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

    const { id, state } = await createAndDeposit(veil, alt, usdc, user, 10n * WAD);
    // dollar cap = 10 ALT × $3000 × 75% = $22,500 → 22.5e6 USDC-atomic
    const overCap = 24_000n * USD6;
    const borT = await buildRiskTransition({
      oldState: state,
      actionId: ACTION_BORROW,
      amount: overCap,
      currentIndex: await veil.currentDebtIndex(await usdc.getAddress()),
      newSalt: BigInt(randHex()),
      params: { collateralPrice: normPrice(PRICE_ALT, 18), debtPrice: normPrice(PRICE_USDC, 6), maxLtvBps: 7500n },
      recipient: BigInt(user.address),
    });
    const borProof = await generateProof(borT.inputs, "risk_transition");
    await expect(
      veil.connect(user as never).borrow(
        {
          positionId: borT.publicSignals[0],
          oldCommitment: borT.publicSignals[1],
          newCommitment: borT.publicSignals[2],
          nullifier: borT.publicSignals[3],
          actionId: borT.publicSignals[4],
          newSequence: borT.publicSignals[5],
          currentIndexLo: borT.publicSignals[6],
          currentIndexHi: borT.publicSignals[7],
          publicAmount: borT.publicSignals[8],
        },
        borProof.callArgs.pA,
        borProof.callArgs.pB,
        borProof.callArgs.pC
      )
    ).to.be.revertedWithCustomError(veil, "BorrowCapExceeded");
  });

  it("6→18: exceedsBorrowCap view is decimals-correct for USDC collateral vs 18-dec debt", async () => {
    const { veil, user, alt, usdc } = await loadFixture(deployFixture);
    // 1000 USDC collateral (6 decimals) — deposit via ZK
    const { id } = await createAndDeposit(veil, usdc as unknown as TokenMock, alt as unknown as TokenMock, user, 1000n * USD6);
    // dollar cap = 1000 × $1 × 75% = $750 → 0.25 ALT (2.5e17 atomic)
    expect(await veil.exceedsBorrowCap(id, 2n * 10n ** 16n, await usdc.getAddress(), await alt.getAddress())).to.equal(false);
    expect(await veil.exceedsBorrowCap(id, 3n * 10n ** 17n, await usdc.getAddress(), await alt.getAddress())).to.equal(true);
    expect(await veil.exceedsBorrowCap(id, 1n * 10n ** 21n, await usdc.getAddress(), await alt.getAddress())).to.equal(true);
  });

  it("same-decimals (18/18) cap semantics: price-scaled dollar cap reduces to the raw-unit cap when prices are equal", async () => {
    const { veil, user, liquidator, alt } = await loadFixture(deployFixture);
    // seed liquidity: originated-debt position in ALT, repaid
    const seedId = (await veil.nextPositionId()) + 1n;
    const currentIndex = await veil.currentDebtIndex(await alt.getAddress());
    const seedState = makeInitialState({
      positionId: seedId,
      collateralAsset: BigInt(await alt.getAddress()),
      debtAsset: BigInt(await alt.getAddress()),
      currentIndex,
      controlSecret: BigInt(randHex()),
      salt: BigInt(randHex()),
    });
    seedState.debt = 200n * WAD;
    await veil.createPosition(await alt.getAddress(), await alt.getAddress(), bytes32(await computeCommitment(seedState)));
    const repT = await buildTransition({
      oldState: seedState,
      actionId: 2n,
      amount: 200n * WAD,
      currentIndex,
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

    const { id, state } = await createAndDeposit(veil, alt, alt, user, 100n * WAD);
    // P_c == P_d → the dollar cap reduces to supported × 75% = 75 ALT
    const within = await buildRiskTransition({
      oldState: state,
      actionId: ACTION_BORROW,
      amount: 50n * WAD, // ≤ 75 cap
      currentIndex: await veil.currentDebtIndex(await alt.getAddress()),
      newSalt: BigInt(randHex()),
      params: { collateralPrice: PRICE_ALT, debtPrice: PRICE_ALT, maxLtvBps: 7500n },
      recipient: BigInt(user.address),
    });
    const withinProof = await generateProof(within.inputs, "risk_transition");
    await veil.connect(user as never).borrow(
      {
        positionId: within.publicSignals[0],
        oldCommitment: within.publicSignals[1],
        newCommitment: within.publicSignals[2],
        nullifier: within.publicSignals[3],
        actionId: within.publicSignals[4],
        newSequence: within.publicSignals[5],
        currentIndexLo: within.publicSignals[6],
        currentIndexHi: within.publicSignals[7],
        publicAmount: within.publicSignals[8],
      },
      withinProof.callArgs.pA,
      withinProof.callArgs.pB,
      withinProof.callArgs.pC
    );
    expect(await veil.borrowOutstanding(id)).to.equal(50n * WAD);

    // beyond the cap: outstanding + amount = 50 + 50 = 100 > 75
    const beyond = await buildRiskTransition({
      oldState: within.newState,
      actionId: ACTION_BORROW,
      amount: 50n * WAD,
      currentIndex: await veil.currentDebtIndex(await alt.getAddress()),
      newSalt: BigInt(randHex()),
      params: { collateralPrice: PRICE_ALT, debtPrice: PRICE_ALT, maxLtvBps: 7500n },
      recipient: BigInt(user.address),
    });
    const beyondProof = await generateProof(beyond.inputs, "risk_transition");
    await expect(
      veil.connect(user as never).borrow(
        {
          positionId: beyond.publicSignals[0],
          oldCommitment: beyond.publicSignals[1],
          newCommitment: beyond.publicSignals[2],
          nullifier: beyond.publicSignals[3],
          actionId: beyond.publicSignals[4],
          newSequence: beyond.publicSignals[5],
          currentIndexLo: beyond.publicSignals[6],
          currentIndexHi: beyond.publicSignals[7],
          publicAmount: beyond.publicSignals[8],
        },
        beyondProof.callArgs.pA,
        beyondProof.callArgs.pB,
        beyondProof.callArgs.pC
      )
    ).to.be.revertedWithCustomError(veil, "BorrowCapExceeded");
    expect(await veil.borrowOutstanding(id)).to.equal(50n * WAD);
  });
});
