# VeilLend — Horizen Testnet ZK Proof Evidence (Milestone 1)

> Evidence package for the VeilLend Milestone 1 submission. This document
> states **only what was actually demonstrated on-chain**, distinguishes it
> from what is *not* yet proven, and gives exact reproduction steps. No
> claims beyond the recorded evidence are made.

---

## 1. Summary of the demonstrated result

On Horizen Testnet (chain ID **2651420**), against the deployed VeilLend
protocol and its snarkjs-generated Groth16 verifier contracts, the full
private-state lifecycle was executed with **real zero-knowledge proofs**:

```text
private state (holder-only witness)
  → Poseidon commitment C0
  → createPosition            (C0 becomes the on-chain authoritative state)
  → Groth16 deposit proof     (state_transition circuit, 9 public signals)
  → on-chain verification     (deployed Groth16Verifier)
  → state transition          (C0 → C1, hidden collateral +100e18 vCOL)
  → Groth16 withdraw proof    (risk_transition circuit, 13 public signals,
                               recipient-bound)
  → on-chain verification     (deployed RiskTransitionVerifier)
  → state transition          (C1 → C2, hidden collateral −100e18 vCOL)
```

Every step was a real transaction on Horizen Testnet. The proofs are real
Groth16 proofs generated from the repository's circuits and proving keys —
no mocks, no signatures, no hash-only shortcuts, no bypasses.

## 2. Deployed contracts (Horizen Testnet, chain ID 2651420)

| Contract | Address | Role |
|---|---|---|
| **VeilLend** | `0x9fd6477Dd3b5eDB4e55A7D7F962Af0e8e332a9B9` | protocol (positions, custody, transitions) |
| Groth16Verifier | `0x0D96E5a05d11c0839037488332CAd29E6Ef6686C` | state-transition proofs (deposit/repay) |
| SolvencyVerifier | `0xD33ce96e9A6AF2c8f5E7f73d5214eDf0c9eff24F` | solvency proofs |
| RiskTransitionVerifier | `0x533Fd1381b7a3aAc107c07983bf82f6681D98b4a` | borrow/withdraw proofs (recipient-bound) |
| LiquidationVerifier | `0x4bf85D6D5f3A730280D707dB0D2d063940A80869` | liquidation eligibility proofs |
| TokenMock (vCOL) | `0x281FbbeD6f2DEA61c86191EA92f2B9B9D2D66a3c` | **test-only** collateral token |
| TokenMock (vDBT) | `0xe27c05934Ad4046d72766808b30F0514e978f612` | **test-only** debt token |
| MockPriceOracle | `0xDA4CAA96D6fF78Af30A3955b5310BE9258d57Bc2` | **test-only** price oracle |

Deployer: `0x1725a9Ba5E788Ac73AE7f14a2C976DB462c5F204` (dedicated testnet
development wallet; key stored only in the gitignored `.env`).
Full deployment record incl. deployment tx hashes/blocks/gas:
[`deployments/horizenTestnet.json`](../deployments/horizenTestnet.json).
Machine-readable evidence of the proof test:
[`deployments/onchain-proof-test.json`](../deployments/onchain-proof-test.json).

## 3. The on-chain proof test (Position #2)

| Step | Tx hash | Block | Gas |
|---|---|---|---|
| `createPosition` (stores C0) | `0x17796ffbd9671b027e98b8295b8d8f6fe3dee7b0e1ef4be8803358b21ae3acbc` | 26,721,799 | 148,938 |
| `deposit` — **real ZK proof verified on-chain** | `0x5e50000ad35435fe947d94e5d56272b0dfbbbb2fc2789a24454a9186df57d4c8` | 26,721,810 | 410,361 |
| `withdrawCollateral` — **real ZK proof verified on-chain** | `0xc0a429d678c8e53520ef9f9141195aee407dd31bbd6720b0a21943d5e921e4b8` | 26,721,815 | 387,547 |

### Commitment chain (public identifiers — commitments are public by design)

```text
C0 = 9498478820913575246157620662779099336911672124961233694062922867225704157547
C1 = 8932868119535140476080033462695729124242989530078434323614105386508226739808
C2 = 19777129796821667301691296523388428648547402301289360294863945356651295504709
```

### State verified by read calls against the deployed contract after the test

| Check | Result |
|---|---|
| `positions(2).activeCommitment == C2` | ✓ (recomputed locally from the holder's witness) |
| `positions(2).sequence` | `2` (0 → 1 → 2, exactly +1 per verified transition) |
| deposit nullifier `consumedTransitions` | ✓ true |
| withdraw nullifier `consumedTransitions` | ✓ true |
| aggregate `collateralCustody` | 0 → 100e18 → 0 (conserved) |
| `supportedCollateral(2)` | 0 → 100e18 → 0 (1:1 with hidden state) |
| caller's vCOL balance | restored exactly (100e18 in, 100e18 out) |

### What each step proved

- **Deposit:** the Groth16 proof proved knowledge of the private state
  preimage of C0, the control secret, sequence+1, and that the hidden
  collateral grows by exactly the publicly transferred 100e18 — the
  cryptographic binding between the ERC20 movement and the hidden state
  (the F1/F2 supported-collateral model's foundation), verified on-chain by
  the deployed verifier.
- **Withdraw:** the proof additionally enforced the post-action solvency
  inequality over the hidden balances and committed the **recipient** as a
  public signal; the contract derived that signal from `msg.sender`
  (recipient binding, F5). Payout moved 1:1 with the hidden-state decrease.
- **Nullifiers:** both transitions' nullifiers were consumed on-chain;
  replaying either proof reverts (`TransitionConsumed`), as verified by the
  local adversarial suite and enforced by the contract code.

## 4. Local regression status

- **106/106 tests passing** (unit, circuit-level, solvency, risk,
  liquidation, supported-collateral, recipient-binding adversarial A–I,
  seeded fuzz/invariant harness) — re-run after the on-chain test.
- Clean Solidity build (19 files, zero warnings, `evmVersion: paris`).

## 5. Reproduction steps

Prerequisites: Node 18+, the circom 2.2.x binary at `tools/circom.exe` (or
on `PATH`), and `HORIZEN_TESTNET_PRIVATE_KEY` funded with testnet ETH in
`.env` (see `.env.example`).

```bash
npm install
npm run zk:build   # compile circuits → pot14 → zkeys → regenerate contracts/zk verifiers
npm run build      # hardhat compile
npm test           # 106 tests (local; CPU-heavy: ~4 min)

npx hardhat run scripts/verify-network.ts --network horizenTestnet   # read-only precheck
npx hardhat run scripts/proof-test.ts   --network horizenTestnet   # the on-chain ZK proof test
```

`scripts/proof-test.ts` attaches **only** to the addresses in
`deployments/horizenTestnet.json` (no redeployment), mints test collateral
from the deployed TokenMock, and executes the create → deposit → withdraw
lifecycle with real proofs, verifying all final state via read calls. It
prints and persists public identifiers only — the control secret, salts and
witness values exist in process memory and are never logged or written.

To regenerate everything from scratch (including the trusted setup):
`npm run clean && rm -rf artifacts-zk && npm run zk:build`.

## 6. What is PROVEN vs NOT proven

**Proven on Horizen Testnet (this milestone):**
- Real Groth16 proving over the repository's Circom circuits works.
- The deployed snarkjs-generated verifiers verify real proofs on-chain.
- Proof-bound deposit and withdraw state transitions (commitment chain,
  sequence integrity, nullifier replay protection, recipient binding,
  custody/supported-collateral accounting) work on the live network.

**Proven locally only (not yet exercised on the live deployment):**
- Repay / borrow / liquidation flows (fully tested in the 106-test local
  suite against the same bytecode; borrow additionally needs seeded
  debt-custody liquidity on-chain).
- Solvency-proof verification endpoint (`verifySolvency`) and the F1–F5
  adversarial attacks (all covered by local tests).

**Not proven / not implemented (no claims made):**
- Production oracle (the deployed oracle is an explicit placeholder).
- Real assets (deployed tokens are explicit test mocks).
- Mainnet anything; audits; production trusted setup.
- Full transaction privacy — per-action amounts are public by design
  (position privacy only). See `architecture.md` §10.
- Liquidation economics (incentives/bad-debt accounting), decentralized
  witness availability, zkVerify integration — future work.

## 7. Testnet-only components

`TokenMock` ×2, `MockPriceOracle`, and the deterministic single-contribution
PoC trusted setup (pot14) are testnet/development components. The
`VeilLend` protocol contract and the four Groth16 verifiers are the real
artifacts (unaudited, testnet-deployed).

## 8. Known limitations

See `architecture.md` §13 and `docs/phase3.md`. Highlights: single-oracle
trust model; admin-set risk parameters; socialized bad debt at liquidation;
witness-holder-only proof generation; PoC trusted setup; per-action amounts
public; contracts not source-verified on the explorer yet.

## 9. Note on Position #1 (testnet artifact — documented, not cleaned)

Position #1 (`0x0e29cb61…`, sequence 0, no collateral, no nullifiers) is an
**empty, unfunded artifact** of a since-fixed off-by-one bug in the test
script's position-id computation during the first proof-test run. It holds
no value, its control secret was never persisted (so nothing can ever be
deposited into it — one-way loss for anyone who tries), every exit path is
capped by its zero supported-collateral ledger, and it has no effect on
deposits, withdrawals, borrowing, liquidation, commitment transitions, or
position-id allocation. It is not part of the successful proof flow
(that is Position #2). Left on-chain untouched by design (no cleanup
transactions).
