import { expect } from "chai";
import { ethers, upgrades } from "hardhat";
import { loadFixture } from "@nomicfoundation/hardhat-network-helpers";
import type { MockStorkOracle, StorkPriceOracle, TokenMock, TokenMock6, VeilLend } from "../typechain-types";
import {
  ACTION_BORROW,
  ACTION_DEPOSIT,
  ACTION_REPAY,
  ACTION_WITHDRAW,
  buildRiskTransition,
  buildTransition,
  computeCommitment,
  generateProof,
  makeInitialState,
  requireZkArtifacts,
} from "../scripts/prove";

/**
 * LOCAL end-to-end lifecycle tests — the complete user flow for EVERY
 * supported asset combination, plus the negative cases.
 *
 * Supported matrix (the contract supports any enabled collateral × debt):
 *   collateral: vCOL (18) · WETH (18) · USDC (6)
 *   debt:       vDBT (18) · USDC (6)
 *   → 6 pairs, all tested through: create → deposit → borrow → repay →
 *     withdraw, verifying balances, custody, supportedCollateral,
 *     borrowOutstanding, sequence and activeCommitment after every step.
 *
 * Prices flow through the real production oracle path:
 *   VeilLend (UUPS) → StorkPriceOracle adapter → Stork interface (mocked).
 * ZK public inputs use the same 18-dec-NORMALIZED price convention as the
 * contract: normalized = raw(1e8) × 10^(18 − decimals).
 */

const WAD = 10n ** 18n;
const USD6 = 10n ** 6n;

const PRICE = { vCOL: 2n * 10n ** 8n, vDBT: 1n * 10n ** 8n, WETH: 3_000n * 10n ** 8n, USDC: 1n * 10n ** 8n };

const randHex = () => ethers.hexlify(ethers.randomBytes(31));
const bytes32 = (v: bigint) => ethers.zeroPadValue(ethers.toBeHex(v), 32);
const chainSecs = async (): Promise<bigint> => BigInt((await ethers.provider.getBlock("latest")).timestamp);

/** 18-dec-normalized price for an asset: raw 1e8 price × 10^(18 − decimals). */
const norm = (raw1e8: bigint, decimals: number) => raw1e8 * 10n ** BigInt(18 - decimals);

interface PairDef {
  name: string;
  col: "vCOL" | "WETH" | "USDC";
  debt: "vDBT" | "USDC";
  depositAmount: bigint;
  borrowAmount: bigint;
}

const PAIRS: PairDef[] = [
  { name: "vCOL → vDBT (18 → 18)", col: "vCOL", debt: "vDBT", depositAmount: 10n * WAD, borrowAmount: 5n * WAD },
  { name: "vCOL → USDC (18 → 6)", col: "vCOL", debt: "USDC", depositAmount: 10n * WAD, borrowAmount: 10n * USD6 },
  { name: "WETH → vDBT (18 → 18)", col: "WETH", debt: "vDBT", depositAmount: 10n * WAD, borrowAmount: 5n * WAD },
  { name: "WETH → USDC (18 → 6)", col: "WETH", debt: "USDC", depositAmount: 10n * WAD, borrowAmount: 20_000n * USD6 },
  { name: "USDC → vDBT (6 → 18)", col: "USDC", debt: "vDBT", depositAmount: 10_000n * USD6, borrowAmount: 5n * WAD },
  { name: "USDC → USDC (6 → 6)", col: "USDC", debt: "USDC", depositAmount: 10_000n * USD6, borrowAmount: 5_000n * USD6 },
];

async function deployFixture() {
  requireZkArtifacts();
  const [owner, user, liquidator] = await ethers.getSigners();

  const weth = (await (await ethers.getContractFactory("TokenMock")).deploy("Wrapped Ether", "WETH")) as unknown as TokenMock;
  const usdc = (await (await ethers.getContractFactory("TokenMock6")).deploy("USD Coin", "USDC")) as unknown as TokenMock6;
  const vcol = (await (await ethers.getContractFactory("TokenMock")).deploy("Veil Collateral", "vCOL")) as unknown as TokenMock;
  const vdbt = (await (await ethers.getContractFactory("TokenMock")).deploy("Veil Debt", "vDBT")) as unknown as TokenMock6 as unknown as TokenMock;

  const tokens: Record<string, TokenMock | TokenMock6> = { vCOL: vcol, vDBT: vdbt, WETH: weth, USDC: usdc };
  const decimalsOf: Record<string, number> = { vCOL: 18, vDBT: 18, WETH: 18, USDC: 6 };

  const mockStork = (await (await ethers.getContractFactory("MockStorkOracle")).deploy(3600, 1)) as unknown as MockStorkOracle;
  const storkAdapter = (await (await ethers.getContractFactory("StorkPriceOracle")).deploy(await mockStork.getAddress())) as unknown as StorkPriceOracle;

  // feed IDs: official registry IDs for WETH/USDC; local test IDs for the mocks
  const feedIds: Record<string, string> = {
    WETH: "0x59102b37de83bdda9f38ac8254e596f0d9ac61d2035c07936675e87342817160",
    USDC: "0x7416a56f222e196d0487dce8a1a8003936862e7a15092a91898d69fa8bce290c",
    vCOL: ethers.id("vCOLUSD"),
    vDBT: ethers.id("vDBTUSD"),
  };
  for (const sym of Object.keys(feedIds)) {
    await storkAdapter.setFeedId(await (tokens[sym] as TokenMock).getAddress(), feedIds[sym]);
  }
  const pushPrices = async (symbols: string[], ageSecs = 0n) => {
    const ts = (await chainSecs()) - ageSecs;
    for (const sym of symbols) {
      await mockStork.setValue(feedIds[sym], PRICE[sym as keyof typeof PRICE] * 10n ** 10n, ts * 1_000_000_000n);
    }
  };
  await pushPrices(Object.keys(feedIds));

  const verifier = await (await ethers.getContractFactory("Groth16Verifier")).deploy();
  const solvencyVerifier = await (await ethers.getContractFactory("SolvencyVerifier")).deploy();
  const riskVerifier = await (await ethers.getContractFactory("RiskTransitionVerifier")).deploy();
  const liquidationVerifier = await (await ethers.getContractFactory("LiquidationVerifier")).deploy();

  const veil = (await upgrades.deployProxy(
    await ethers.getContractFactory("VeilLend"),
    [owner.address, await verifier.getAddress(), await solvencyVerifier.getAddress(), await riskVerifier.getAddress(), await liquidationVerifier.getAddress(), await storkAdapter.getAddress()],
    { kind: "uups" }
  )) as unknown as VeilLend;

  // enable the full supported matrix
  for (const sym of ["vCOL", "WETH", "USDC"]) await veil.connect(owner).enableCollateralAsset(await (tokens[sym] as TokenMock).getAddress());
  for (const sym of ["vDBT", "USDC"]) {
    await veil.connect(owner).enableDebtAsset(await (tokens[sym] as TokenMock).getAddress(), {
      baseRateBps: 500, slopeBps: 2000, targetUtilizationBps: 8000,
      reserveFactorBps: 1000, maxLtvBps: 7_500, liquidationThresholdBps: 8_500,
    });
  }

  for (const s of [user, liquidator]) {
    for (const sym of Object.keys(tokens)) {
      const t = tokens[sym] as TokenMock;
      await t.mint(s.address, 1_000_000n * (decimalsOf[sym] === 6 ? USD6 : WAD));
      await t.connect(s).approve(await veil.getAddress(), ethers.MaxUint256);
    }
  }
  return { veil, tokens, decimalsOf, feedIds, mockStork, storkAdapter, pushPrices, owner, user, liquidator };
}

function toInputs(p: { publicSignals: bigint[] }) {
  const s = p.publicSignals.map((v) => BigInt(v));
  return {
    positionId: s[0], oldCommitment: s[1], newCommitment: s[2], nullifier: s[3],
    actionId: s[4], newSequence: s[5], currentIndexLo: s[6], currentIndexHi: s[7],
    publicAmount: s[8],
  };
}

/** Funds the borrow reserve for `debtSymbol` via a seeded repay on the same pair. */
async function seedLiquidity(
  veil: VeilLend, pair: PairDef, f: Awaited<ReturnType<typeof deployFixture>>,
  user: { address: string }, amount: bigint
) {
  const { tokens } = f;
  const col = tokens[pair.col] as TokenMock;
  const debt = tokens[pair.debt] as TokenMock;
  const seedId = (await veil.nextPositionId()) + 1n;
  const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
  const state = makeInitialState({
    positionId: seedId, collateralAsset: BigInt(await col.getAddress()),
    debtAsset: BigInt(await debt.getAddress()), currentIndex,
    controlSecret: BigInt(randHex()), salt: BigInt(randHex()),
  });
  state.debt = amount;
  await veil.createPosition(await col.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(state)));
  const t = await buildTransition({ oldState: state, actionId: ACTION_REPAY, amount, currentIndex, newSalt: BigInt(randHex()) });
  const proof = await generateProof(t.inputs);
  await veil.connect(user as never).repay(toInputs(t), proof.callArgs.pA, proof.callArgs.pB, proof.callArgs.pC);
}

describe("LOCAL E2E — full lifecycle for every supported pair", () => {
  for (const pair of PAIRS) {
    it(`${pair.name}: create → deposit → borrow → repay → withdraw`, async () => {
      const f = await loadFixture(deployFixture);
      const { veil, tokens, decimalsOf, user } = f;
      const col = tokens[pair.col] as TokenMock;
      const debt = tokens[pair.debt] as TokenMock;
      const colDec = decimalsOf[pair.col];
      const debtDec = decimalsOf[pair.debt];
      const colAddr = await col.getAddress();
      const debtAddr = await debt.getAddress();

      // ---------- 1. create ----------
      const id = (await veil.nextPositionId()) + 1n;
      const currentIndex0 = await veil.currentDebtIndex(debtAddr);
      let state = makeInitialState({
        positionId: id, collateralAsset: BigInt(colAddr), debtAsset: BigInt(debtAddr),
        currentIndex: currentIndex0, controlSecret: BigInt(randHex()), salt: BigInt(randHex()),
      });
      await veil.createPosition(colAddr, debtAddr, bytes32(await computeCommitment(state)));
      const on0 = await veil.positions(id);
      expect(on0.collateralAsset).to.equal(colAddr);
      expect(on0.debtAsset).to.equal(debtAddr);
      expect(on0.sequence).to.equal(0n);
      expect(on0.status).to.equal(1n);
      expect(on0.activeCommitment).to.equal(bytes32(await computeCommitment(state)));
      expect(await veil.supportedCollateral(id)).to.equal(0n);
      expect(await veil.borrowOutstanding(id)).to.equal(0n);

      // ---------- 2. deposit ----------
      const colBefore = await col.balanceOf(user.address);
      const depT = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: pair.depositAmount, currentIndex: currentIndex0, newSalt: BigInt(randHex()) });
      const depP = await generateProof(depT.inputs);
      await veil.connect(user as never).deposit(toInputs(depT), depP.callArgs.pA, depP.callArgs.pB, depP.callArgs.pC);
      state = depT.newState;
      expect(colBefore - (await col.balanceOf(user.address))).to.equal(pair.depositAmount); // custody received
      expect(await veil.supportedCollateral(id)).to.equal(pair.depositAmount);
      expect((await veil.positions(id)).sequence).to.equal(1n);
      expect((await veil.positions(id)).activeCommitment).to.equal(bytes32(await computeCommitment(state)));

      // ---------- 3. borrow ----------
      const { liquidator } = f;
      await seedLiquidity(veil, pair, f, liquidator, 40_000n * BigInt(debtDec === 6 ? USD6 : WAD));
      await f.pushPrices([pair.col, pair.debt]); // fresh snapshot for the same-tx oracle model
      const debtBefore = await debt.balanceOf(user.address);
      const currentIndexB = await veil.currentDebtIndex(debtAddr);
      const borT = await buildRiskTransition({
        oldState: state, actionId: ACTION_BORROW, amount: pair.borrowAmount,
        currentIndex: currentIndexB, newSalt: BigInt(randHex()),
        params: {
          collateralPrice: norm(PRICE[pair.col], colDec),
          debtPrice: norm(PRICE[pair.debt], debtDec),
          maxLtvBps: 7500n,
        },
        recipient: BigInt(user.address),
      });
      const borP = await generateProof(borT.inputs, "risk_transition");
      await veil.connect(user as never).borrow(toInputs(borT), borP.callArgs.pA, borP.callArgs.pB, borP.callArgs.pC);
      state = borT.newState;
      expect((await debt.balanceOf(user.address)) - debtBefore).to.equal(pair.borrowAmount);
      expect(await veil.borrowOutstanding(id)).to.equal(pair.borrowAmount);
      expect((await veil.positions(id)).sequence).to.equal(2n);
      expect((await veil.positions(id)).activeCommitment).to.equal(bytes32(await computeCommitment(state)));

      // ---------- 4. repay (full principal) ----------
      await f.pushPrices([pair.col, pair.debt]);
      const debtBeforeRepay = await debt.balanceOf(user.address);
      const currentIndexR = await veil.currentDebtIndex(debtAddr);
      const repT = await buildTransition({ oldState: state, actionId: ACTION_REPAY, amount: pair.borrowAmount, currentIndex: currentIndexR, newSalt: BigInt(randHex()) });
      const repP = await generateProof(repT.inputs);
      await veil.connect(user as never).repay(toInputs(repT), repP.callArgs.pA, repP.callArgs.pB, repP.callArgs.pC);
      state = repT.newState;
      expect(debtBeforeRepay - (await debt.balanceOf(user.address))).to.equal(pair.borrowAmount);
      expect(await veil.borrowOutstanding(id)).to.equal(0n);
      expect((await veil.positions(id)).sequence).to.equal(3n);
      expect((await veil.positions(id)).activeCommitment).to.equal(bytes32(await computeCommitment(state)));

      // ---------- 5. withdraw (full collateral) ----------
      const colBeforeW = await col.balanceOf(user.address);
      const currentIndexW = await veil.currentDebtIndex(debtAddr);
      const wdT = await buildRiskTransition({
        oldState: state, actionId: ACTION_WITHDRAW, amount: pair.depositAmount,
        currentIndex: currentIndexW, newSalt: BigInt(randHex()),
        params: {
          collateralPrice: norm(PRICE[pair.col], colDec),
          debtPrice: norm(PRICE[pair.debt], debtDec),
          maxLtvBps: 7500n,
        },
        recipient: BigInt(user.address),
      });
      const wdP = await generateProof(wdT.inputs, "risk_transition");
      await veil.connect(user as never).withdrawCollateral(toInputs(wdT), wdP.callArgs.pA, wdP.callArgs.pB, wdP.callArgs.pC);
      state = wdT.newState;
      expect((await col.balanceOf(user.address)) - colBeforeW).to.equal(pair.depositAmount);
      expect(await veil.supportedCollateral(id)).to.equal(0n);
      expect((await veil.positions(id)).sequence).to.equal(4n);
      expect((await veil.positions(id)).activeCommitment).to.equal(bytes32(await computeCommitment(state)));

      // ---------- 6. final state ----------
      expect(state.collateral).to.equal(0n);
      expect(state.sequence).to.equal(4n);
      expect(await veil.borrowOutstanding(id)).to.equal(0n);
      expect((await veil.positions(id)).status).to.equal(1n); // stays active, empty
    });
  }
});

describe("LOCAL E2E — negative cases and invariants", () => {
  it("unsupported asset is rejected at creation (AssetNotSupported)", async () => {
    const f = await loadFixture(deployFixture);
    const rogue = await (await ethers.getContractFactory("TokenMock")).deploy("Rogue", "ROGUE");
    await expect(f.veil.createPosition(await rogue.getAddress(), await (f.tokens.vDBT as TokenMock).getAddress(), bytes32(1n)))
      .to.be.revertedWithCustomError(f.veil, "AssetNotSupported");
    await expect(f.veil.createPosition(await (f.tokens.vCOL as TokenMock).getAddress(), await rogue.getAddress(), bytes32(1n)))
      .to.be.revertedWithCustomError(f.veil, "AssetNotSupported");
  });

  it("over-borrow reverts with BorrowCapExceeded and leaves NO partial state", async () => {
    const f = await loadFixture(deployFixture);
    const { veil, tokens, user } = f;
    const col = tokens.vCOL as TokenMock;
    const debt = tokens.vDBT as TokenMock;
    const id = (await veil.nextPositionId()) + 1n;
    const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
    const state = makeInitialState({
      positionId: id, collateralAsset: BigInt(await col.getAddress()), debtAsset: BigInt(await debt.getAddress()),
      currentIndex, controlSecret: BigInt(randHex()), salt: BigInt(randHex()),
    });
    await veil.createPosition(await col.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(state)));
    const depT = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 10n * WAD, currentIndex, newSalt: BigInt(randHex()) });
    const depP = await generateProof(depT.inputs);
    await veil.connect(user as never).deposit(toInputs(depT), depP.callArgs.pA, depP.callArgs.pB, depP.callArgs.pC);

    // $20 borrow vs $15 cap (10 vCOL × $2 × 75%)
    const borT = await buildRiskTransition({
      oldState: depT.newState, actionId: ACTION_BORROW, amount: 20n * WAD,
      currentIndex, newSalt: BigInt(randHex()),
      params: { collateralPrice: norm(PRICE.vCOL, 18), debtPrice: norm(PRICE.vDBT, 18), maxLtvBps: 7500n },
      recipient: BigInt(user.address),
    });
    const borP = await generateProof(borT.inputs, "risk_transition");
    const seqBefore = (await veil.positions(id)).sequence;
    const balBefore = await debt.balanceOf(user.address);
    await expect(veil.connect(user as never).borrow(toInputs(borT), borP.callArgs.pA, borP.callArgs.pB, borP.callArgs.pC))
      .to.be.revertedWithCustomError(veil, "BorrowCapExceeded");
    expect((await veil.positions(id)).sequence).to.equal(seqBefore);
    expect(await debt.balanceOf(user.address)).to.equal(balBefore);
    expect(await veil.borrowOutstanding(id)).to.equal(0n);
  });

  it("invalid withdrawal (more than the hidden collateral) cannot be proven", async () => {
    const f = await loadFixture(deployFixture);
    const { veil, tokens, user } = f;
    const col = tokens.vCOL as TokenMock;
    const debt = tokens.vDBT as TokenMock;
    const id = (await veil.nextPositionId()) + 1n;
    const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
    const state = makeInitialState({
      positionId: id, collateralAsset: BigInt(await col.getAddress()), debtAsset: BigInt(await debt.getAddress()),
      currentIndex, controlSecret: BigInt(randHex()), salt: BigInt(randHex()),
    });
    await veil.createPosition(await col.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(state)));
    const depT = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 10n * WAD, currentIndex, newSalt: BigInt(randHex()) });
    const depP = await generateProof(depT.inputs);
    await veil.connect(user as never).deposit(toInputs(depT), depP.callArgs.pA, depP.callArgs.pB, depP.callArgs.pC);
    // witness tries to withdraw 11 while the (hidden) collateral is 10 — the
    // circuit itself refuses to prove it
    // the witness builder refuses to even construct an unprovable withdrawal
    // (circuit constraint: amount ≤ hidden collateral) — nothing reaches the chain
    await expect(buildRiskTransition({
      oldState: depT.newState, actionId: ACTION_WITHDRAW, amount: 11n * WAD,
      currentIndex, newSalt: BigInt(randHex()),
      params: { collateralPrice: norm(PRICE.vCOL, 18), debtPrice: norm(PRICE.vDBT, 18), maxLtvBps: 7500n },
      recipient: BigInt(user.address),
    })).to.be.rejectedWith(/exceeds hidden collateral/i);
    expect(await veil.supportedCollateral(id)).to.equal(10n * WAD);
    expect((await veil.positions(id)).sequence).to.equal(1n);
  });

  it("stale oracle snapshot reverts with StalePrice and leaves no partial state", async () => {
    const f = await loadFixture(deployFixture);
    const { veil, tokens, user } = f;
    const col = tokens.vCOL as TokenMock;
    const debt = tokens.vDBT as TokenMock;
    await seedLiquidity(veil, PAIRS[0], f, (await ethers.getSigners())[2], 40_000n * WAD);
    const id = (await veil.nextPositionId()) + 1n;
    const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
    const state = makeInitialState({
      positionId: id, collateralAsset: BigInt(await col.getAddress()), debtAsset: BigInt(await debt.getAddress()),
      currentIndex, controlSecret: BigInt(randHex()), salt: BigInt(randHex()),
    });
    await veil.createPosition(await col.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(state)));
    const depT = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 10n * WAD, currentIndex, newSalt: BigInt(randHex()) });
    const depP = await generateProof(depT.inputs);
    await veil.connect(user as never).deposit(toInputs(depT), depP.callArgs.pA, depP.callArgs.pB, depP.callArgs.pC);

    await f.pushPrices(["vCOL", "vDBT"], 7200n); // 2h old > 1h freshness
    const borT = await buildRiskTransition({
      oldState: depT.newState, actionId: ACTION_BORROW, amount: 1n * WAD,
      currentIndex, newSalt: BigInt(randHex()),
      params: { collateralPrice: norm(PRICE.vCOL, 18), debtPrice: norm(PRICE.vDBT, 18), maxLtvBps: 7500n },
      recipient: BigInt(user.address),
    });
    const borP = await generateProof(borT.inputs, "risk_transition");
    await expect(veil.connect(user as never).borrow(toInputs(borT), borP.callArgs.pA, borP.callArgs.pB, borP.callArgs.pC))
      .to.be.revertedWithCustomError(veil, "StalePrice");
    expect(await veil.borrowOutstanding(id)).to.equal(0n);
  });

  it("tampered proof reverts with InvalidProof", async () => {
    const f = await loadFixture(deployFixture);
    const { veil, tokens, user } = f;
    const col = tokens.vCOL as TokenMock;
    const debt = tokens.vDBT as TokenMock;
    const id = (await veil.nextPositionId()) + 1n;
    const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
    const state = makeInitialState({
      positionId: id, collateralAsset: BigInt(await col.getAddress()), debtAsset: BigInt(await debt.getAddress()),
      currentIndex, controlSecret: BigInt(randHex()), salt: BigInt(randHex()),
    });
    await veil.createPosition(await col.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(state)));
    const depT = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 1n * WAD, currentIndex, newSalt: BigInt(randHex()) });
    const depP = await generateProof(depT.inputs);
    depP.callArgs.pC[0] = depP.callArgs.pC[0] + 1n; // corrupt the proof
    await expect(veil.connect(user as never).deposit(toInputs(depT), depP.callArgs.pA, depP.callArgs.pB, depP.callArgs.pC))
      .to.be.revertedWithCustomError(veil, "InvalidProof");
  });

  it("wrong-asset witness (pair mismatch) reverts with InvalidProof", async () => {
    const f = await loadFixture(deployFixture);
    const { veil, tokens, user } = f;
    const col = tokens.vCOL as TokenMock;
    const weth = tokens.WETH as TokenMock;
    const debt = tokens.vDBT as TokenMock;
    const id = (await veil.nextPositionId()) + 1n;
    const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
    const correctState = makeInitialState({
      positionId: id, collateralAsset: BigInt(await col.getAddress()), debtAsset: BigInt(await debt.getAddress()),
      currentIndex, controlSecret: BigInt(randHex()), salt: BigInt(randHex()),
    });
    await veil.createPosition(await col.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(correctState)));
    // witness claims WETH collateral while the position's commitment is over vCOL
    const wrongState = { ...correctState, collateralAsset: BigInt(await weth.getAddress()) };
    const depT = await buildTransition({ oldState: wrongState, actionId: ACTION_DEPOSIT, amount: 1n * WAD, currentIndex, newSalt: BigInt(randHex()) });
    const depP = await generateProof(depT.inputs);
    // the on-chain commitment check rejects the mismatched state before the
    // proof even runs
    await expect(veil.connect(user as never).deposit(toInputs(depT), depP.callArgs.pA, depP.callArgs.pB, depP.callArgs.pC))
      .to.be.revertedWithCustomError(veil, "InvalidCommitment");
    expect(await veil.supportedCollateral(id)).to.equal(0n);
  });

  it("replayed borrow proof is rejected and cannot double-spend", async () => {
    const f = await loadFixture(deployFixture);
    const { veil, tokens, user } = f;
    const col = tokens.vCOL as TokenMock;
    const debt = tokens.vDBT as TokenMock;
    await seedLiquidity(veil, PAIRS[0], f, (await ethers.getSigners())[2], 40_000n * WAD);
    const id = (await veil.nextPositionId()) + 1n;
    const currentIndex = await veil.currentDebtIndex(await debt.getAddress());
    const state = makeInitialState({
      positionId: id, collateralAsset: BigInt(await col.getAddress()), debtAsset: BigInt(await debt.getAddress()),
      currentIndex, controlSecret: BigInt(randHex()), salt: BigInt(randHex()),
    });
    await veil.createPosition(await col.getAddress(), await debt.getAddress(), bytes32(await computeCommitment(state)));
    const depT = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 10n * WAD, currentIndex, newSalt: BigInt(randHex()) });
    const depP = await generateProof(depT.inputs);
    await veil.connect(user as never).deposit(toInputs(depT), depP.callArgs.pA, depP.callArgs.pB, depP.callArgs.pC);

    await f.pushPrices(["vCOL", "vDBT"]);
    const borT = await buildRiskTransition({
      oldState: depT.newState, actionId: ACTION_BORROW, amount: 1n * WAD,
      currentIndex, newSalt: BigInt(randHex()),
      params: { collateralPrice: norm(PRICE.vCOL, 18), debtPrice: norm(PRICE.vDBT, 18), maxLtvBps: 7500n },
      recipient: BigInt(user.address),
    });
    const borP = await generateProof(borT.inputs, "risk_transition");
    await veil.connect(user as never).borrow(toInputs(borT), borP.callArgs.pA, borP.callArgs.pB, borP.callArgs.pC);
    const outAfterFirst = await veil.borrowOutstanding(id);
    const seqAfterFirst = (await veil.positions(id)).sequence;
    expect(outAfterFirst).to.equal(1n * WAD);

    // replay: the nullifier was consumed → the same proof cannot re-run
    await expect(veil.connect(user as never).borrow(toInputs(borT), borP.callArgs.pA, borP.callArgs.pB, borP.callArgs.pC))
      .to.be.revertedWithCustomError(veil, "TransitionConsumed");
    expect(await veil.borrowOutstanding(id)).to.equal(outAfterFirst); // no double-spend
    expect((await veil.positions(id)).sequence).to.equal(seqAfterFirst);
  });

  it("deposit to a nonexistent position reverts and leaves nothing behind", async () => {
    const f = await loadFixture(deployFixture);
    const { veil } = f;
    const futureId = (await veil.nextPositionId()) + 999n;
    await expect(veil.deposit(
      { positionId: futureId, oldCommitment: 0n, newCommitment: 0n, nullifier: 0n, actionId: ACTION_DEPOSIT, newSequence: 1n, currentIndexLo: 0n, currentIndexHi: 0n, publicAmount: 1n },
      [0n, 0n], [[0n, 0n], [0n, 0n]], [0n, 0n]
    )).to.be.revertedWithCustomError(veil, "PositionNotFound");
  });
});
