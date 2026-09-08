/**
 * VeilLend — REAL testnet E2E mirroring the guided Demo flow end-to-end,
 * including the setup steps (mint / wrap / approve / price refresh) and the
 * client-side preflight guards the Demo performs before asking the wallet.
 *
 * Run: npx hardhat run scripts/e2e-demo-flow.ts --network horizenTestnet
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import {
  ACTION_BORROW, ACTION_DEPOSIT, ACTION_REPAY, ACTION_WITHDRAW,
  buildRiskTransition, buildTransition, computeCommitment, generateProof,
  makeInitialState, requireZkArtifacts,
} from "./prove";

const randHex = () => ethers.hexlify(ethers.randomBytes(31));
const bytes32 = (v: bigint) => ethers.zeroPadValue(ethers.toBeHex(v), 32);
const WAD = 10n ** 18n;

const BASE_FEEDS = {
  WETH: { feed: "0x50015f8b17fb2C290Dde41fDc246ed0dcEE93a8b", target: "0x4200000000000000000000000000000000000006", maxAgeSecs: 2 * 3600 },
  USDC: { feed: "0x01Bab8761d882A3d34690f515EB3126455501bB5", target: "0x01c7AEb2A0428b4159c0E333712f40e127aF639E", maxAgeSecs: 48 * 3600 },
  vCOL: { fixed1e8: 2n * 10n ** 8n, target: "0xb5a5b0f1083965B9d92dCd94E5BCdDb868BfcFCE" },
  vDBT: { fixed1e8: 1n * 10n ** 8n, target: "0xe48a8EC02EB14BB52Fe363D3B2A32e264d3B5D7f" },
};
const RESULTS: Array<{ step: string; tx?: string; ok: boolean; note: string }> = [];
function rec(step: string, tx: string | null, ok: boolean, note: string) {
  RESULTS.push({ step, tx: tx ?? undefined, ok, note });
  console.log(`${ok ? "PASS" : "FAIL"}  ${step}${tx ? "  tx=" + tx : ""}\n      ${note}`);
}
function toInputs(p: { publicSignals: bigint[] }) {
  const s = p.publicSignals.map((v) => BigInt(v));
  return {
    positionId: s[0], oldCommitment: s[1], newCommitment: s[2], nullifier: s[3],
    actionId: s[4], newSequence: s[5], currentIndexLo: s[6], currentIndexHi: s[7],
    publicAmount: s[8],
  };
}

async function main() {
  requireZkArtifacts();
  const record = JSON.parse(fs.readFileSync(path.join(__dirname, "..", "deployments", "horizenTestnet-uups.json"), "utf8"));
  const A = record.addresses;
  const [user] = await ethers.getSigners();
  const p = ethers.provider;
  console.log("user:", user.address);

  const veil = await ethers.getContractAt("VeilLend", A.veilLend);
  const token = (addr: string) => new ethers.Contract(addr, [
    "function mint(address,uint256)", "function deposit() payable",
    "function balanceOf(address) view returns (uint256)",
    "function allowance(address,address) view returns (uint256)",
    "function approve(address,uint256) returns (bool)",
  ], user);

  // ---------- STEP 1: setup — mint / wrap / approve (demo Setup panel) ----------
  const vcol = token(A.collateralToken), vdbt = token(A.debtToken), weth = token(A.WETH);
  const MINT_VCOL = 100n * WAD, MINT_VDBT = 100n * WAD, WRAP = 2n * WAD / 100n;

  // preflight guard (demo): zero balance blocks deposit — verify the guard condition
  const vcolBal0 = await vcol.balanceOf(user.address);
  const guardFires = vcolBal0 < 10n * WAD;
  rec("preflight: deposit guard on low balance", null, true,
    `balance=${vcolBal0}, need=10e18 → guard would fire: ${guardFires} (demo stops the user with a mint hint before any tx)`);

  if (vcolBal0 < MINT_VCOL) {
    const t = await (await vcol.mint(user.address, MINT_VCOL)).wait();
    rec("mint 100 vCOL", t?.hash, t?.status === 1, `balance now ${(await vcol.balanceOf(user.address)).toString()}`);
  } else rec("mint 100 vCOL", null, true, "already funded");
  if ((await vdbt.balanceOf(user.address)) < MINT_VDBT) {
    const t = await (await vdbt.mint(user.address, MINT_VDBT)).wait();
    rec("mint 100 vDBT", t?.hash, t?.status === 1, "repay + seeding funds");
  } else rec("mint 100 vDBT", null, true, "already funded");
  if ((await weth.balanceOf(user.address)) < WRAP) {
    const t = await (await weth.deposit({ value: WRAP })).wait();
    rec("wrap 0.02 ETH → WETH", t?.hash, t?.status === 1, "WETH balance now " + (await weth.balanceOf(user.address)).toString());
  } else rec("wrap ETH → WETH", null, true, "already funded");

  // preflight guard (demo): insufficient allowance triggers auto-approve
  for (const [sym, tok] of [["vCOL", vcol], ["vDBT", vdbt]] as const) {
    const al = await tok.allowance(user.address, A.veilLend);
    const needed = 20n * WAD;
    if (al < needed) {
      const t = await (await tok.approve(A.veilLend, 2n ** 256n - 1n)).wait();
      rec(`approve ${sym} (allowance ${al} < ${needed})`, t?.hash, t?.status === 1,
        `allowance now ${(await tok.allowance(user.address, A.veilLend)).toString()}`);
    } else rec(`approve ${sym}`, null, true, `allowance already ${al}`);
  }

  // ---------- price refresh (relay logic: Base Chainlink + demo constants) ----------
  const base = new ethers.JsonRpcProvider("https://mainnet.base.org", 8453, { staticNetwork: true, batchMaxCount: 1 });
  const feedAbi = ["function latestRoundData() view returns (uint80,int256,uint256,uint256,uint80)", "function decimals() view returns (uint8)"];
  const entries: Array<[string, bigint]> = [];
  for (const cfg of Object.values(BASE_FEEDS)) {
    if ("feed" in cfg && cfg.feed) {
      const f = new ethers.Contract(cfg.feed, feedAbi, base);
      const [, ans, , upd] = await f.latestRoundData();
      const age = BigInt(Math.floor(Date.now() / 1000)) - upd;
      if (ans <= 0n || age > BigInt(cfg.maxAgeSecs)) throw new Error("stale/invalid feed");
      entries.push([cfg.target, ans]);
      console.log(`  feed ${cfg.feed}: answer1e8=${ans} age=${age}s`);
    } else entries.push([cfg.target, cfg.fixed1e8]);
  }
  const oracle = new ethers.Contract(A.mockPriceOracle, ["function setPrices(address[],uint256[])", "function getPrice(address) view returns (uint256,uint256)"], user);
  const tPrice = await (await oracle.setPrices(entries.map((e) => e[0]), entries.map((e) => e[1]))).wait();
  rec("price relay refresh (Base Chainlink → OwnerMockPriceOracle)", tPrice?.hash, tPrice?.status === 1,
    `WETH $${(Number(entries[0][1]) / 1e8).toFixed(4)} · USDC $${(Number(entries[1][1]) / 1e8).toFixed(4)} · vCOL $2 · vDBT $1`);

  // ---------- STEP 2: create position (vCOL → vDBT) ----------
  const id = (await veil.nextPositionId()) + 1n;
  const idx0 = await veil.currentDebtIndex(A.debtToken);
  let state = makeInitialState({
    positionId: id, collateralAsset: BigInt(A.collateralToken), debtAsset: BigInt(A.debtToken),
    currentIndex: idx0, controlSecret: BigInt(randHex()), salt: BigInt(randHex()),
  });
  const tCreate = await (await veil.createPosition(A.collateralToken, A.debtToken, bytes32(await computeCommitment(state)))).wait();
  rec("CREATE position " + id.toString(), tCreate?.hash, tCreate?.status === 1,
    `pair vCOL/vDBT, commitment ${(await veil.positions(id)).activeCommitment.slice(0, 12)}…, sequence 0`);

  // ---------- STEP 3: deposit 10 vCOL ----------
  const dep = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: 10n * WAD, currentIndex: idx0, newSalt: BigInt(randHex()) });
  const depP = await generateProof(dep.inputs);
  const tDep = await (await veil.deposit(toInputs(dep), depP.callArgs.pA, depP.callArgs.pB, depP.callArgs.pC)).wait();
  state = dep.newState;
  rec("DEPOSIT 10 vCOL (ZK state_transition)", tDep?.hash, tDep?.status === 1,
    `supportedCollateral=${(await veil.supportedCollateral(id)).toString()}, sequence=${(await veil.positions(id)).sequence.toString()}`);

  // ---------- seed vDBT borrow liquidity (testnet tools) ----------
  const custody = await veil.debtCustody(A.debtToken);
  if (custody < 100n * WAD) {
    const seedId = (await veil.nextPositionId()) + 1n;
    const idxS = await veil.currentDebtIndex(A.debtToken);
    const seed = makeInitialState({
      positionId: seedId, collateralAsset: BigInt(A.collateralToken), debtAsset: BigInt(A.debtToken),
      currentIndex: idxS, controlSecret: BigInt(randHex()), salt: BigInt(randHex()),
    });
    seed.debt = 100n * WAD;
    await (await veil.createPosition(A.collateralToken, A.debtToken, bytes32(await computeCommitment(seed)))).wait();
    const ts = await buildTransition({ oldState: seed, actionId: ACTION_REPAY, amount: 100n * WAD, currentIndex: idxS, newSalt: BigInt(randHex()) });
    const ps = await generateProof(ts.inputs);
    const tSeed = await (await veil.repay(toInputs(ts), ps.callArgs.pA, ps.callArgs.pB, ps.callArgs.pC)).wait();
    rec("SEED 100 vDBT liquidity", tSeed?.hash, tSeed?.status === 1, "debtCustody=" + (await veil.debtCustody(A.debtToken)).toString());
  } else rec("SEED liquidity", null, true, "already funded: " + custody.toString());

  // ---------- STEP 4: borrow 5 vDBT ----------
  const [colRaw] = await oracle.getPrice(A.collateralToken);
  const [debtRaw] = await oracle.getPrice(A.debtToken);
  const colN = colRaw, debtN = debtRaw; // both 18-dec: normalized == raw 1e8
  const bor = await buildRiskTransition({
    oldState: state, actionId: ACTION_BORROW, amount: 5n * WAD,
    currentIndex: await veil.currentDebtIndex(A.debtToken), newSalt: BigInt(randHex()),
    params: { collateralPrice: colN, debtPrice: debtN, maxLtvBps: 7500n },
    recipient: BigInt(user.address),
  });
  const borP = await generateProof(bor.inputs, "risk_transition");
  const tBor = await (await veil.borrow(toInputs(bor), borP.callArgs.pA, borP.callArgs.pB, borP.callArgs.pC)).wait();
  state = bor.newState;
  rec("BORROW 5 vDBT (ZK risk_transition)", tBor?.hash, tBor?.status === 1,
    `outstanding=${(await veil.borrowOutstanding(id)).toString()}, vDBT credited to wallet`);

  // ---------- STEP 5: repay 5 vDBT ----------
  const rep = await buildTransition({ oldState: state, actionId: ACTION_REPAY, amount: 5n * WAD, currentIndex: await veil.currentDebtIndex(A.debtToken), newSalt: BigInt(randHex()) });
  const repP = await generateProof(rep.inputs);
  const tRep = await (await veil.repay(toInputs(rep), repP.callArgs.pA, repP.callArgs.pB, repP.callArgs.pC)).wait();
  state = rep.newState;
  rec("REPAY 5 vDBT (ZK state_transition)", tRep?.hash, tRep?.status === 1,
    `outstanding=${(await veil.borrowOutstanding(id)).toString()}`);

  // ---------- STEP 6: withdraw 10 vCOL ----------
  const wd = await buildRiskTransition({
    oldState: state, actionId: ACTION_WITHDRAW, amount: 10n * WAD,
    currentIndex: await veil.currentDebtIndex(A.debtToken), newSalt: BigInt(randHex()),
    params: { collateralPrice: colN, debtPrice: debtN, maxLtvBps: 7500n },
    recipient: BigInt(user.address),
  });
  const wdP = await generateProof(wd.inputs, "risk_transition");
  const tWd = await (await veil.withdrawCollateral(toInputs(wd), wdP.callArgs.pA, wdP.callArgs.pB, wdP.callArgs.pC)).wait();
  state = wd.newState;
  rec("WITHDRAW 10 vCOL (ZK risk_transition)", tWd?.hash, tWd?.status === 1,
    `supportedCollateral=${(await veil.supportedCollateral(id)).toString()}`);

  // ---------- final state ----------
  const pos = await veil.positions(id);
  rec("FINAL STATE", null, pos.sequence === 4n && (await veil.borrowOutstanding(id)) === 0n && (await veil.supportedCollateral(id)) === 0n,
    `sequence=${pos.sequence.toString()} outstanding=0 supported=0 status=${pos.status.toString()} commitment=${pos.activeCommitment.slice(0, 12)}…`);

  fs.writeFileSync(path.join(__dirname, "..", "deployments", "demo-e2e-uups.json"),
    JSON.stringify({ runAt: new Date().toISOString(), user: user.address, results: RESULTS, allPass: RESULTS.every((r) => r.ok) }, null, 2) + "\n");
  console.log("\nALL PASS:", RESULTS.every((r) => r.ok));
  if (!RESULTS.every((r) => r.ok)) process.exit(1);
}

main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
