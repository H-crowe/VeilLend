/**
 * VeilLend risk-transition circuit fix — REAL E2E on Horizen Testnet.
 *
 * Exercises the corrected risk_transition circuit end-to-end against the NEW
 * deployment, with witnesses built by the same math the demo uses and proofs
 * generated from the same regenerated artifacts the demo serves
 * (artifacts-zk == demo/public/zk, byte-identical copies).
 *
 * Resumable: every step saves its prepared post-transition state BEFORE
 * submitting ("…-pending" checkpoint) and reconciles on-chain state after,
 * so a crash never loses witness material and never re-submits a mined tx.
 *
 * Run: npx hardhat run scripts/e2e-riskfix.ts --network horizenTestnet
 */
import { ethers } from "hardhat";
import fs from "fs";
import path from "path";
import type { MockPriceOracle, TokenMock, VeilLend } from "../typechain-types";
import {
  ACTION_BORROW,
  ACTION_DEPOSIT,
  ACTION_WITHDRAW,
  buildLiquidationWitness,
  buildRiskTransition,
  buildTransition,
  computeCommitment,
  generateProof,
  isLiquidatable,
  makeInitialState,
  type PrivateState,
} from "../scripts/prove";

const WAD = 10n ** 18n;
const STATE_FILE = path.join(__dirname, "..", ".e2e-riskfix-state.json");

const randHex = () => ethers.hexlify(ethers.randomBytes(31));
const bytes32 = (v: bigint) => ethers.zeroPadValue(ethers.toBeHex(v), 32);
const wei = (b: bigint | string | number) => (typeof b === "bigint" ? b : BigInt(b)).toString();

function load(): Record<string, any> {
  return fs.existsSync(STATE_FILE) ? JSON.parse(fs.readFileSync(STATE_FILE, "utf8")) : {};
}
function save(v: Record<string, any>) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(v, (_k, x) => (typeof x === "bigint" ? x.toString() : x)), "utf8");
}
function patch(step: string, extra: Record<string, unknown> = {}) {
  save({ ...load(), step, ...extra });
}
function rev(raw: any): PrivateState | undefined {
  return raw ? (Object.fromEntries(Object.entries(raw).map(([k, v]) => [k, BigInt(v as string)])) as unknown as PrivateState) : undefined;
}

async function main() {
  const book = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "horizenTestnet.json"), "utf8"));
  const [signer] = await ethers.getSigners();
  const me = signer.address;
  const veil = (await ethers.getContractAt("VeilLend", book.addresses.veilLend, signer)) as VeilLend;
  const collateral = (await ethers.getContractAt("TokenMock", book.addresses.collateralToken, signer)) as unknown as TokenMock & { connect(a: never): TokenMock };
  const debt = (await ethers.getContractAt("TokenMock", book.addresses.debtToken, signer)) as unknown as TokenMock & { connect(a: never): TokenMock };
  const oracle = (await ethers.getContractAt("MockPriceOracle", book.addresses.mockPriceOracle, signer)) as unknown as MockPriceOracle & { setPrice(a: string, p: bigint): Promise<ethers.ContractTransactionResponse> };
  console.log("wallet:", me, "ETH:", ethers.formatEther(await ethers.provider.getBalance(me)));
  console.log("VeilLend (NEW):", book.addresses.veilLend, "| riskVerifier (NEW):", book.addresses.riskTransitionVerifier);

  const debtAddress = await debt.getAddress();
  const currentIndex = async () => await veil.currentDebtIndex(debtAddress);
  const prices = async () => ({
    collateralPrice: (await oracle.getPrice(await collateral.getAddress()))[0] as bigint,
    debtPrice: (await oracle.getPrice(debtAddress))[0] as bigint,
  });
  const riskParams = async () => ({ ...(await prices()), maxLtvBps: (await veil.rateConfigs(debtAddress)).maxLtvBps });

  async function wait(tx: ethers.ContractTransactionResponse, label: string) {
    const rec = await tx.wait();
    if (rec?.status !== 1) throw new Error(`${label} REVERTED: ${tx.hash}`);
    console.log(`  ${label}: OK  tx ${tx.hash} (block ${rec.blockNumber})`);
  }

  function toInputs(p: { publicSignals: bigint[] }) {
    const s = p.publicSignals.map((v) => BigInt(v));
    return {
      positionId: s[0], oldCommitment: s[1], newCommitment: s[2], nullifier: s[3],
      actionId: s[4], newSequence: s[5], currentIndexLo: s[6], currentIndexHi: s[7],
      publicAmount: s[8],
    };
  }

  async function submit(
    veilInstance: VeilLend,
    fn: "deposit" | "repay" | "borrow" | "withdrawCollateral",
    prepared: { inputs: Record<string, string>; publicSignals: bigint[]; newState: PrivateState },
    circuit: "state_transition" | "risk_transition",
    label: string,
    checkpointKey: string
  ) {
    patch(`${checkpointKey}-pending`, { [`${checkpointKey}State`]: serialize(prepared.newState) });
    const { callArgs } = await generateProof(prepared.inputs, circuit);
    await wait(await (veilInstance.connect(signer as never) as any)[fn](toInputs(prepared), callArgs.pA, callArgs.pB, callArgs.pC), label);
  }
  function serialize(st: PrivateState) {
    return Object.fromEntries(Object.entries(st).map(([k, v]) => [k, v.toString()]));
  }
  const toI = (t: { publicSignals: bigint[] }) => toInputs(t);

  const s = load();
  let step: string = s.step ?? "start";
  let seed = rev(s.seedState);
  let main = rev(s.mainState);
  let pos2 = rev(s.pos2State);
  let seedId: bigint | undefined = s.seedId ? BigInt(s.seedId) : undefined;
  let mainId: bigint | undefined = s.mainId ? BigInt(s.mainId) : undefined;
  let pid2: bigint | undefined = s.pid2 ? BigInt(s.pid2) : undefined;

  // ---------- 1. seed borrowable liquidity ----------
  const SEED = 30n * WAD;
  if (step === "start") {
    seedId = (await veil.nextPositionId()) + 1n;
    seed = makeInitialState({
      positionId: seedId, collateralAsset: BigInt(await collateral.getAddress()), debtAsset: BigInt(debtAddress),
      currentIndex: await currentIndex(), controlSecret: BigInt(randHex()), salt: BigInt(randHex()),
    });
    seed.debt = SEED;
    await wait(await veil.connect(signer).createPosition(await collateral.getAddress(), debtAddress, bytes32(await computeCommitment(seed))), `create seed #${seedId}`);
    patch("seed-created", { seedId: seedId.toString(), seedState: serialize(seed) });
    step = "seed-created";
  }
  if (step === "seed-created") {
    const custody = await veil.debtCustody(debtAddress);
    if (custody < SEED) {
      if ((await (debt as any).balanceOf(me)) < SEED) await wait(await (debt as any).mint(me, SEED), "mint 30 vDBT");
      await wait(await (debt as any).approve(await veil.getAddress(), ethers.MaxUint256), "approve vDBT");
      const prepared = await buildTransition({ oldState: seed!, actionId: 2n, amount: SEED, currentIndex: await currentIndex(), newSalt: BigInt(randHex()) });
      await submit(veil, "repay", prepared, "state_transition", "repay (seed liquidity)", "seed");
      seed = prepared.newState;
    } else console.log("  seed liquidity already funded (custody ok)");
    if ((await veil.debtCustody(debtAddress)) < SEED) throw new Error("liquidity seeding failed");
    console.log("  reconciled: debtCustody >= 30 vDBT");
    patch("seeded", { seedState: serialize(seed!) });
    step = "seeded";
  }

  // ---------- 2. main position: create ----------
  if (step === "seeded") {
    mainId = (await veil.nextPositionId()) + 1n;
    main = makeInitialState({
      positionId: mainId, collateralAsset: BigInt(await collateral.getAddress()), debtAsset: BigInt(debtAddress),
      currentIndex: await currentIndex(), controlSecret: BigInt(randHex()), salt: BigInt(randHex()),
    });
    await wait(await veil.connect(signer).createPosition(await collateral.getAddress(), debtAddress, bytes32(await computeCommitment(main))), `create main #${mainId}`);
    patch("main-created", { mainId: mainId.toString(), mainState: serialize(main) });
    step = "main-created";
  }

  // ---------- 3. deposit 10 vCOL ----------
  const DEPOSIT = 10n * WAD;
  if (step === "main-created" || step === "deposit-pending") {
    const seq = (await veil.positions(mainId!)).sequence;
    if (seq === 0n) {
      if ((await (collateral as any).balanceOf(me)) < DEPOSIT) await wait(await (collateral as any).mint(me, DEPOSIT), "mint 10 vCOL");
      await wait(await (collateral as any).approve(await veil.getAddress(), ethers.MaxUint256), "approve vCOL");
      const prepared = await buildTransition({ oldState: main!, actionId: ACTION_DEPOSIT, amount: DEPOSIT, currentIndex: await currentIndex(), newSalt: BigInt(randHex()) });
      await submit(veil, "deposit", prepared, "state_transition", "deposit (ZK)", "deposit");
      main = prepared.newState;
    } else {
      main = rev(s.depositState) ?? main!;
      console.log("  deposit already mined — adopting checkpointed post-deposit state");
    }
    const pos = await veil.positions(mainId!);
    if (pos.sequence !== 1n) throw new Error("deposit reconciliation failed: sequence != 1");
    if ((await veil.supportedCollateral(mainId!)) !== DEPOSIT) throw new Error("deposit reconciliation failed: supported != 10 vCOL");
    console.log("  reconciled: seq=1, supportedCollateral=10 vCOL");
    patch("deposited", { mainState: serialize(main!) });
    step = "deposited";
  }

  // ---------- 4. refresh mock oracle (testnet-only owner op; 1h freshness) ----------
  if (step === "deposited") {
    await wait(await oracle.setPrice(await collateral.getAddress(), PARAMS_COL_PRICE), "oracle setPrice vCOL (fresh)");
    await wait(await oracle.setPrice(debtAddress, PARAMS_DBT_PRICE), "oracle setPrice vDBT (fresh)");
    patch("oracle-fresh");
    step = "oracle-fresh";
  }

  // ---------- 5. borrow at the on-chain cap: 7.5 vDBT against 10 vCOL ----------
  const BORROW = (7500n * WAD) / 10000n;
  if (step === "oracle-fresh" || step === "borrow-pending") {
    if ((await veil.borrowOutstanding(mainId!)) === 0n) {
      const prepared = await buildRiskTransition({
        oldState: main!, actionId: ACTION_BORROW, amount: BORROW, currentIndex: await currentIndex(),
        newSalt: BigInt(randHex()), params: await riskParams(), recipient: BigInt(me),
      });
      await submit(veil, "borrow", prepared, "risk_transition", "borrow (ZK)", "borrow");
      main = prepared.newState;
    } else {
      main = rev(s.borrowState) ?? main!;
      console.log("  borrow already mined — adopting checkpointed post-borrow state");
    }
    const pos = await veil.positions(mainId!);
    if (pos.sequence !== 2n) throw new Error("borrow reconciliation failed: sequence != 2");
    if ((await veil.borrowOutstanding(mainId!)) !== BORROW) throw new Error("borrow reconciliation failed: outstanding");
    console.log(`  reconciled: seq=2, borrowOutstanding=${wei(BORROW)} vDBT`);
    patch("borrowed", { mainState: serialize(main!) });
    step = "borrowed";
  }

  // ---------- 6. repay (ZK) ----------
  if (step === "borrowed" || step === "repay-pending") {
    const outstanding = await veil.borrowOutstanding(mainId!);
    if (outstanding !== 0n) {
      if ((await (debt as any).balanceOf(me)) < outstanding) await wait(await (debt as any).mint(me, outstanding), "mint repay vDBT");
      const prepared = await buildTransition({ oldState: main!, actionId: 2n, amount: outstanding, currentIndex: await currentIndex(), newSalt: BigInt(randHex()) });
      await submit(veil, "repay", prepared, "state_transition", "repay (ZK)", "repay");
      main = prepared.newState;
    } else {
      main = rev(s.repayState) ?? main!;
      console.log("  repay already mined — adopting checkpointed post-repay state");
    }
    const pos = await veil.positions(mainId!);
    if (pos.sequence !== 3n) throw new Error("repay reconciliation failed: sequence != 3");
    if ((await veil.borrowOutstanding(mainId!)) !== 0n) throw new Error("repay reconciliation failed: outstanding != 0");
    console.log("  reconciled: seq=3, borrowOutstanding=0");
    patch("repaid", { mainState: serialize(main!) });
    step = "repaid";
  }

  // ---------- 7. withdraw full collateral (ZK) ----------
  if (step === "repaid" || step === "withdraw-pending") {
    const supported = await veil.supportedCollateral(mainId!);
    if (supported !== 0n) {
      const prepared = await buildRiskTransition({
        oldState: main!, actionId: ACTION_WITHDRAW, amount: supported, currentIndex: await currentIndex(),
        newSalt: BigInt(randHex()), params: await riskParams(), recipient: BigInt(me),
      });
      await submit(veil, "withdrawCollateral", prepared, "risk_transition", "withdraw (ZK)", "withdraw");
      main = prepared.newState;
    } else {
      main = rev(s.withdrawState) ?? main!;
      console.log("  withdraw already mined — adopting checkpointed post-withdraw state");
    }
    const pos = await veil.positions(mainId!);
    if (pos.sequence !== 4n) throw new Error("withdraw reconciliation failed: sequence != 4");
    if ((await veil.supportedCollateral(mainId!)) !== 0n) throw new Error("withdraw reconciliation failed: supported != 0");
    console.log("  reconciled: seq=4, supportedCollateral=0 (full withdrawal)");
    patch("withdrew", { mainState: serialize(main!) });
    step = "withdrew";
  }

  // ---------- 8. liquidation regression on a second position ----------
  if (step === "withdrew") {
    pid2 = (await veil.nextPositionId()) + 1n;
    pos2 = makeInitialState({
      positionId: pid2, collateralAsset: BigInt(await collateral.getAddress()), debtAsset: BigInt(debtAddress),
      currentIndex: await currentIndex(), controlSecret: BigInt(randHex()), salt: BigInt(randHex()),
    });
    await wait(await veil.connect(signer).createPosition(await collateral.getAddress(), debtAddress, bytes32(await computeCommitment(pos2))), `create liq-position #${pid2}`);
    patch("liq-created", { pid2: pid2.toString(), pos2State: serialize(pos2) });
    step = "liq-created";
  }
  const DEP2 = 8n * WAD;
  if (step === "liq-created" || step === "liqDeposit-pending") {
    if ((await veil.positions(pid2!)).sequence === 0n) {
      if ((await (collateral as any).balanceOf(me)) < DEP2) await wait(await (collateral as any).mint(me, DEP2), "mint 8 vCOL");
      await wait(await (collateral as any).approve(await veil.getAddress(), ethers.MaxUint256), "approve vCOL (liq pos)");
      const prepared = await buildTransition({ oldState: pos2!, actionId: ACTION_DEPOSIT, amount: DEP2, currentIndex: await currentIndex(), newSalt: BigInt(randHex()) });
      await submit(veil, "deposit", prepared, "state_transition", "liq-position deposit (ZK)", "liqDeposit");
      pos2 = prepared.newState;
    } else {
      pos2 = rev(s.liqDepositState) ?? pos2!;
      console.log("  liq deposit already mined — adopting checkpointed state");
    }
    if ((await veil.positions(pid2!)).sequence !== 1n) throw new Error("liq deposit reconciliation failed");
    patch("liq-deposited", { pos2State: serialize(pos2!) });
    step = "liq-deposited";
  }
  const B2 = (6000n * WAD) / 10000n; // exactly the on-chain cap: 8 vCOL * 75%
  if (step === "liq-deposited" || step === "liqBorrow-pending") {
    if ((await veil.borrowOutstanding(pid2!)) === 0n) {
      if ((await (debt as any).balanceOf(me)) < B2) await wait(await (debt as any).mint(me, B2), "mint borrow vDBT");
      const prepared = await buildRiskTransition({
        oldState: pos2!, actionId: ACTION_BORROW, amount: B2, currentIndex: await currentIndex(),
        newSalt: BigInt(randHex()), params: await riskParams(), recipient: BigInt(me),
      });
      await submit(veil, "borrow", prepared, "risk_transition", "liq-position borrow (ZK)", "liqBorrow");
      pos2 = prepared.newState;
    } else {
      pos2 = rev(s.liqBorrowState) ?? pos2!;
      console.log("  liq borrow already mined — adopting checkpointed state");
    }
    if ((await veil.positions(pid2!)).sequence !== 2n) throw new Error("liq borrow reconciliation failed");
    patch("liq-borrowed", { pos2State: serialize(pos2!) });
    step = "liq-borrowed";
  }
  if (step === "liq-borrowed") {
    // Drop vCOL to 0.5 so the position becomes undercollateralized vs the 85%
    // liquidation threshold (mock testnet oracle, owner op — testnet only).
    await wait(await oracle.setPrice(await collateral.getAddress(), 5n * 10n ** 7n), "oracle setPrice vCOL = 0.5");
    await wait(await oracle.setPrice(debtAddress, (await prices()).debtPrice), "oracle setPrice vDBT (fresh)");
    patch("liq-priced");
    step = "liq-priced";
  }
  if (["liq-priced", "liqTopup-pending", "liq-proof-pending"].includes(step)) {
    // Top the borrow up to the full cap (8 vCOL * 75% = 6 vDBT total). The
    // top-up must be proven at the NORMAL price (restore 2.0 first): after
    // the drop to 0.5 the solvency limit (~5.33 vDBT) would sit below the
    // cap. The price drop to 0.5 happens afterwards, before liquidation.
    const cap = (DEP2 * 7500n) / 10000n;
    const outstanding = await veil.borrowOutstanding(pid2!);
    if (outstanding < cap) {
      await wait(await oracle.setPrice(await collateral.getAddress(), PARAMS_COL_PRICE), "oracle restore vCOL = 2.0 (for provable top-up)");
      await wait(await oracle.setPrice(debtAddress, (await prices()).debtPrice), "oracle setPrice vDBT (fresh)");
      if ((await (debt as any).balanceOf(me)) < cap - outstanding) await wait(await (debt as any).mint(me, cap - outstanding), "mint top-up vDBT");
      const prepared = await buildRiskTransition({
        oldState: pos2!, actionId: ACTION_BORROW, amount: cap - outstanding, currentIndex: await currentIndex(),
        newSalt: BigInt(randHex()), params: await riskParams(), recipient: BigInt(me),
      });
      await submit(veil, "borrow", prepared, "risk_transition", "liq-position top-up borrow (ZK)", "liqTopup");
      pos2 = prepared.newState;
      patch("liq-priced", { pos2State: serialize(pos2!) });
    }
    if ((await veil.positions(pid2!)).status === 1n) {
      await wait(await oracle.setPrice(await collateral.getAddress(), 5n * 10n ** 7n), "oracle setPrice vCOL = 0.5 (pre-liquidation)");
      await wait(await oracle.setPrice(debtAddress, (await prices()).debtPrice), "oracle setPrice vDBT (fresh)");
      const params = { ...(await prices()), liquidationThresholdBps: 8500n };
      if (!isLiquidatable(pos2!, params)) throw new Error("position unexpectedly not liquidatable");
      const wl = await buildLiquidationWitness(pos2!, params, BigInt(me));
      patch("liq-proof-pending");
      const { callArgs } = await generateProof(wl.inputs, "liquidation");
      await wait(await veil.connect(signer).liquidate(pid2!, wl.amounts.collateralOut, wl.amounts.debtOut, callArgs.pA, callArgs.pB, callArgs.pC), "liquidate (ZK)");
    } else console.log("  liquidation already mined (status != Active)");
    if ((await veil.positions(pid2!)).status !== 2n) throw new Error("liquidation reconciliation failed: status != Closed");
    console.log("  liquidation verified: position Closed (LiquidationVerifier unchanged — no regression)");
    patch("done");
    step = "done";
  }

  // ---------- final on-chain summary ----------
  console.log("\n--- final on-chain summary (NEW contract " + await veil.getAddress() + ") ---");
  for (const [label, id] of [["seed", seedId!], ["main", mainId!], ["liq", pid2!]] as const) {
    const pos = await veil.positions(id);
    console.log(`#${id} ${label}: status=${pos.status} seq=${pos.sequence} supported=${wei(await veil.supportedCollateral(id))} outstanding=${wei(await veil.borrowOutstanding(id))}`);
  }
  console.log("debtCustody:", wei(await veil.debtCustody(debtAddress)), "vDBT | collateralCustody:", wei(await veil.collateralCustody(await collateral.getAddress())), "vCOL");
  if (step === "done") fs.rmSync(STATE_FILE, { force: true });
  console.log("\nE2E COMPLETE: create → deposit → borrow → repay → withdraw (+ liquidation regression) verified on the FIXED protocol");
}

const PARAMS_COL_PRICE = 2_000n * 10n ** 8n;
const PARAMS_DBT_PRICE = 10n ** 8n;

main().then(() => process.exit(0)).catch((e) => { console.error("E2E FAIL:", String(e.message || e).slice(0, 600)); process.exit(1); });
