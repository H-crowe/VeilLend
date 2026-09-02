/**
 * On-chain ZK integration test against the deployed VeilLend on Horizen Testnet.
 *
 * Uses ONLY the existing deployment (deployments/horizenTestnet.json) and the
 * existing proving artifacts. Real Groth16 proofs are generated locally and
 * verified by the deployed verifiers on-chain. No mocks, no bypasses.
 *
 * Flow exercised:
 *   createPosition (Poseidon commitment)
 *     → deposit: state_transition Groth16 proof → on-chain verification
 *     → withdraw: risk_transition Groth16 proof (recipient binding) → on-chain verification
 *
 * Public state identifiers (commitments, nullifier) are printed; the control
 * secret / salts / witness are never logged or persisted.
 */
import { ethers } from "hardhat";
import * as fs from "fs";
import * as path from "path";
import type { MockPriceOracle, TokenMock, VeilLend } from "../typechain-types";
import {
  ACTION_BORROW,
  ACTION_DEPOSIT,
  ACTION_WITHDRAW,
  buildRiskTransition,
  buildTransition,
  computeCommitment,
  computeNullifier,
  generateProof,
  makeInitialState,
  requireZkArtifacts,
} from "./prove";

const EXPECTED_CHAIN_ID = 2651420n;
const bytes32 = (v: bigint) => ethers.zeroPadValue(ethers.toBeHex(v), 32);

async function main() {
  requireZkArtifacts();

  // 1. Load the existing deployment
  const bookPath = path.join(__dirname, "..", "deployments", "horizenTestnet.json");
  const book = JSON.parse(fs.readFileSync(bookPath, "utf8"));
  const A = book.addresses;
  console.log("Using deployment from", bookPath);
  console.log("VeilLend:", A.veilLend);

  const network = await ethers.provider.getNetwork();
  if (network.chainId !== EXPECTED_CHAIN_ID) throw new Error(`Wrong network: ${network.chainId}`);
  const [caller] = await ethers.getSigners();
  if (!caller) throw new Error("No signer");

  // 2. Attach to deployed contracts + verify code exists
  const veil = (await ethers.getContractAt("VeilLend", A.veilLend)) as VeilLend;
  const collateral = (await ethers.getContractAt("TokenMock", A.collateralToken)) as TokenMock;
  const debt = (await ethers.getContractAt("TokenMock", A.debtToken)) as TokenMock;
  const oracle = (await ethers.getContractAt("MockPriceOracle", A.mockPriceOracle)) as MockPriceOracle;
  for (const [name, addr] of Object.entries(A)) {
    const code = await ethers.provider.getCode(addr);
    if (code === "0x") throw new Error(`No code at ${name}: ${addr}`);
  }
  console.log("✓ all deployed contracts contain code");

  // wiring sanity (read calls against the deployed contract)
  expectEq(await veil.verifier(), A.stateTransitionVerifier, "state verifier wiring");
  expectEq(await veil.solvencyVerifier(), A.solvencyVerifier, "solvency verifier wiring");
  expectEq(await veil.riskVerifier(), A.riskTransitionVerifier, "risk verifier wiring");
  expectEq(await veil.liquidationVerifier(), A.liquidationVerifier, "liquidation verifier wiring");

  // 3. Prepare test collateral using the deployed TokenMock
  const AMOUNT = 100n * 10n ** 18n;
  await (await collateral.mint(caller.address, AMOUNT)).wait();
  await (await collateral.connect(caller).approve(A.veilLend, ethers.MaxUint256)).wait();

  const custodyBefore = await veil.collateralCustody(A.collateralToken);
  const supportedBefore = 0n; // fresh position below
  const callerTokensBefore = await collateral.balanceOf(caller.address);
  const nextId = (await veil.nextPositionId()) + 1n; // createPosition assigns ++nextPositionId

  // 4. Private state (kept in memory only) → Poseidon commitment
  const currentIndex = await veil.currentDebtIndex(A.debtToken);
  console.log("on-chain debt index:", currentIndex.toString());
  const state = makeInitialState({
    positionId: nextId,
    collateralAsset: BigInt(A.collateralToken),
    debtAsset: BigInt(A.debtToken),
    currentIndex,
    controlSecret: BigInt(ethers.hexlify(ethers.randomBytes(31))),
    salt: BigInt(ethers.hexlify(ethers.randomBytes(31))),
  });
  const c0 = await computeCommitment(state);
  console.log("commitment C0 (initial):", c0.toString());

  const txs: Array<{ label: string; txHash: string; block: string; gasUsed: string }> = [];

  // 5. createPosition on-chain
  {
    const tx = await veil.createPosition(A.collateralToken, A.debtToken, bytes32(c0));
    const r = await tx.wait();
    txs.push({ label: "createPosition", txHash: tx.hash, block: String(r!.blockNumber), gasUsed: r!.gasUsed.toString() });
    const on = await veil.positions(nextId);
    expectEq(on.activeCommitment, bytes32(c0), "C0 stored on-chain");
    expectEq(on.interestIndex, currentIndex, "index snapshot");
  }

  // 6. DEPOSIT — real state_transition Groth16 proof
  const newSalt1 = BigInt(ethers.hexlify(ethers.randomBytes(31)));
  const dep = await buildTransition({ oldState: state, actionId: ACTION_DEPOSIT, amount: AMOUNT, currentIndex, newSalt: newSalt1 });
  const depProof = await generateProof(dep.inputs);
  console.log("REAL deposit proof generated (state_transition circuit) — public signals:", depProof.publicSignals.length);
  {
    const ps = dep.publicSignals;
    const tx = await veil.connect(caller).deposit(
      { positionId: ps[0], oldCommitment: ps[1], newCommitment: ps[2], nullifier: ps[3], actionId: ps[4], newSequence: ps[5], currentIndexLo: ps[6], currentIndexHi: ps[7], publicAmount: ps[8] },
      depProof.callArgs.pA,
      depProof.callArgs.pB,
      depProof.callArgs.pC
    );
    const r = await tx.wait();
    txs.push({ label: "deposit (ZK verified on-chain)", txHash: tx.hash, block: String(r!.blockNumber), gasUsed: r!.gasUsed.toString() });
    console.log("nullifier consumed:", (await veil.consumedTransitions(bytes32(ps[3]))).toString());
  }
  const afterDeposit = dep.newState;
  const c1 = await computeCommitment(afterDeposit);

  // 7. WITHDRAW — real risk_transition Groth16 proof with recipient binding
  const w = await buildRiskTransition({
    oldState: afterDeposit,
    actionId: ACTION_WITHDRAW,
    amount: AMOUNT,
    currentIndex: await veil.currentDebtIndex(A.debtToken),
    newSalt: BigInt(ethers.hexlify(ethers.randomBytes(31))),
    params: { collateralPrice: 2_000n * 10n ** 8n, debtPrice: 10n ** 8n, maxLtvBps: 7500n },
    recipient: BigInt(caller.address),
  });
  const wProof = await generateProof(w.inputs, "risk_transition");
  console.log("REAL withdraw proof generated (risk_transition circuit, recipient-bound) — public signals:", wProof.publicSignals.length);
  {
    const ps = w.publicSignals;
    const tx = await veil.connect(caller).withdrawCollateral(
      { positionId: ps[0], oldCommitment: ps[1], newCommitment: ps[2], nullifier: ps[3], actionId: ps[4], newSequence: ps[5], currentIndexLo: ps[6], currentIndexHi: ps[7], publicAmount: ps[8] },
      wProof.callArgs.pA,
      wProof.callArgs.pB,
      wProof.callArgs.pC
    );
    const r = await tx.wait();
    txs.push({ label: "withdraw (ZK verified on-chain, recipient-bound)", txHash: tx.hash, block: String(r!.blockNumber), gasUsed: r!.gasUsed.toString() });
  }
  const c2 = await computeCommitment(w.newState);

  // 8. Final on-chain state verification (read calls against the deployed contract)
  const pos = await veil.positions(nextId);
  expectEq(pos.activeCommitment, bytes32(c2), "final commitment C2");
  expectEq(pos.sequence, 2n, "sequence advanced to 2");
  const nullifierW = bytes32(await computeNullifier(state, ACTION_WITHDRAW, 2n));
  expectEq(await veil.consumedTransitions(nullifierW), true, "withdraw nullifier consumed");
  expectEq(await veil.consumedTransitions(bytes32(dep.publicSignals[3])), true, "deposit nullifier consumed");

  const custodyAfter = await veil.collateralCustody(A.collateralToken);
  const supportedAfter = await veil.supportedCollateral(nextId);
  const callerTokensAfter = await collateral.balanceOf(caller.address);
  expectEq(custodyAfter, custodyBefore, "aggregate custody returned to pre-test value");
  expectEq(supportedAfter, supportedBefore, "supported collateral returned to 0 after full withdrawal");
  expectEq(callerTokensAfter, callerTokensBefore, "caller token balance restored");

  console.log("\n=== FINAL ON-CHAIN STATE (read from deployed VeilLend) ===");
  console.log("positionId        :", nextId.toString());
  console.log("C0 initial        :", c0.toString());
  console.log("C1 after deposit  :", c1.toString());
  console.log("C2 after withdraw :", c2.toString());
  console.log("on-chain commitment matches C2:", pos.activeCommitment === bytes32(c2));
  console.log("sequence          :", pos.sequence.toString());
  console.log("custody before→after:", custodyBefore.toString(), "→", custodyAfter.toString());
  console.log("supported before→after:", supportedBefore.toString(), "→", supportedAfter.toString());
  console.log("caller vCOL before→after:", callerTokensBefore.toString(), "→", callerTokensAfter.toString());

  console.log("\n=== transactions ===");
  let totalGas = 0n;
  for (const t of txs) {
    totalGas += BigInt(t.gasUsed);
    console.log(`${t.label}: tx=${t.txHash} block=${t.block} gas=${t.gasUsed}`);
  }
  console.log("total gas:", totalGas.toString());

  // persist a public-only report (no secrets)
  const report = {
    network: "horizenTestnet",
    chainId: EXPECTED_CHAIN_ID.toString(),
    contracts: { veilLend: A.veilLend, stateTransitionVerifier: A.stateTransitionVerifier, riskTransitionVerifier: A.riskTransitionVerifier, collateralToken: A.collateralToken, debtToken: A.debtToken },
    positionId: nextId.toString(),
    commitments: { C0: c0.toString(), C1: c1.toString(), C2: c2.toString() },
    transactions: txs,
    onChainChecks: { finalCommitmentMatchesC2: pos.activeCommitment === bytes32(c2), sequence: "2", nullifiersConsumed: 2, custodyConserved: custodyAfter === custodyBefore, supportedRestored: supportedAfter === supportedBefore },
  };
  const out = path.join(__dirname, "..", "deployments", "onchain-proof-test.json");
  fs.mkdirSync(path.dirname(out), { recursive: true });
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + "\n");
  console.log("\npublic report written to", out);
  console.log("ON-CHAIN ZK FLOW: SUCCESS");
}

function expectEq(actual: unknown, expected: unknown, label: string) {
  const a = typeof actual === "bigint" ? actual.toString() : String(actual);
  const e = typeof expected === "bigint" ? expected.toString() : String(expected);
  if (a !== e) throw new Error(`CHECK FAILED: ${label}: ${a} !== ${e}`);
  console.log(`  ✓ ${label}`);
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
