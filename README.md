# VeilLend

> **Confidential borrow-lend protocol on Horizen.**
> Privacy-first: positions are represented as Poseidon commitments and every
> state change is authorized by a real Groth16 zero-knowledge proof verified
> on-chain.

## The problem

Traditional DeFi lending exposes everything that matters financially:

- **collateral** — what you have posted, per position and in aggregate
- **debt** — what you owe, live
- **health / risk information** — how close you are to liquidation
- **liquidation state** — who is being liquidated, and for how much

This is a genuine privacy problem, not a cosmetic one: positions can be
front-run and copy-traded, borrowers can be targeted or de-anonymized,
liquidation bots stack on public health data, and wallets carrying
meaningful debt become markers of financial stress. Financial activity on a
public ledger should not be a public credit file.

## The solution

VeilLend keeps each position's cumulative financial state inside a
**Poseidon commitment** (`BN254`, domain-separated, versioned) and authorizes
every state change with a **real Groth16 zero-knowledge proof** verified by
on-chain Solidity verifiers. The protocol can verify exactly the conditions
it needs — solvency, eligibility, sequence freshness, correct state
transitions — without ever learning the user's collateral, debt, interest
accrued, or health factor. Proofs are generated **client-side in the
browser** (snarkjs); the chain stores commitments and verifies proofs, never
plaintext balances.

## Core properties

- **Private collateral** — hidden inside the commitment; on-chain custody is
  aggregate only.
- **Private debt** — hidden balances compound against a public interest
  index inside the ZK circuit.
- **Private health / risk state** — solvency and liquidation eligibility are
  *proven*, never published.
- **Confidential liquidation** — eligibility and settlement amounts are
  computed in-circuit; no borrower values are revealed.
- **Non-custodial architecture** — a position is controlled by its
  **control secret** (part of the commitment preimage and of every
  nullifier). There is no admin withdrawal path, no upgrade key, no custody
  backdoor.

## How it works

```text
Private State (collateral, debt, index snapshot, control secret, salt)
      │  Poseidon (BN254, domain-separated, versioned)
      ▼
Commitment  ←———— the ONLY authoritative on-chain financial state
      │
      ▼
Groth16 proof (browser-side): "I know the preimage of the active commitment,
      I hold the control secret, the transition follows the protocol rules,
      and (for risky actions) the position remains solvent / is eligible"
      │
      ▼
On-chain verification → new commitment   (sequence +1, nullifier consumed)
```

- **Deposit / repay** — proof-bound `state_transition` (actionId 1/2); the
  ERC20 amount is cryptographically bound into the hidden state and on-chain
  custody stays 1:1 with the sum of hidden collateral.
- **Borrow / withdraw** — proof-bound `risk_transition` (actionId 3/4); the
  circuit enforces **post-action solvency**
  (`collateral·price·10000 ≥ debt·price·maxLtvBps`, cross-multiplied,
  integer-exact) over the hidden balances — an unsafe action is *unprovable*,
  not merely rejected.
- **Interest** — a public, WAD-scaled per-asset debt index (see below).
- **Oracle freshness** — risky actions read prices through an on-chain
  freshness gate; stale/absent prices revert.

## Borrow / withdraw security model (as implemented)

- Borrow/withdraw authorization is bound to the **private position state**
  via the commitment preimage and to the **positionId** as a public signal —
  a proof for one position cannot authorize another.
- **Recipient binding (F5):** outbound-value circuits commit the payout
  recipient as a public input **derived on-chain from `msg.sender`**; proofs
  generated for wallet A verify only from wallet A (mempool proof theft is
  unusable).
- **Sequence / nullifier replay protection:** sequences advance by exactly
  one; Poseidon nullifiers are consumed only after verification and are
  unique per (position, sequence, action).
- The contract maintains **`supportedCollateral[positionId]`** — increased
  only by actual token deposits pulled 1:1 (fee-on-transfer would break the
  binding and is rejected), decreased by withdrawals/liquidation.
- The contract maintains **`borrowOutstanding[positionId]`** — the public
  cumulative borrow ledger.
- **On-chain raw-unit LTV cap:** `outstanding + amount ≤
  supportedCollateral · maxLtvBps / 10000` (`BorrowCapExceeded`) — fabricated
  hidden collateral cannot back borrows.
- The **ZK solvency check** is price-scaled: `newCollateral · collateralPrice
  · 10000 ≥ newDebt · debtPrice · maxLtvBps` with prices read fresh on-chain
  inside the transaction (the caller cannot choose them).
- **Withdrawals** are constrained by the corrected private-state transition
  (the circuit's `amount ≤ hidden collateral` gate applies to withdraw) plus
  on-chain `supportedCollateral` and custody accounting.

## Confidential liquidation

A position can be liquidated **without revealing the borrower's collateral,
debt, or health factor**:

- a dedicated Groth16 circuit proves **undercollateralization**
  (`collateral·price·10000 < debt·price·liquidationThresholdBps`, strict)
  over the hidden state bound to the position commitment;
- **settlement outputs are computed in-circuit**: `collateralOut = hidden
  collateral`, `debtOut = min(hidden debt, oracle-parity value of that
  collateral)`;
- the settlement **recipient is `msg.sender`** (derived on-chain — F5), and
  the liquidator pays the parity debt into the protocol reserve;
- **oracle freshness** and **nullifier/sequence** protections apply; the
  seizure is capped by `supportedCollateral`;
- liquidation is **permissionless** — anyone may liquidate any position
  subject to the protocol rules (in the demo the controller self-liquidates).
- **Known limitation:** any residual outstanding debt is wiped when the
  position closes — remaining bad debt is socialized/reserve-absorbed
  (documented PoC design, see below).

## Interest-rate model (as implemented)

- Per-asset `RateConfig` (baseRateBps, slopeBps, targetUtilizationBps,
  reserveFactorBps, maxLtvBps, liquidationThresholdBps), validated on
  enable/config change to stay inside the circuits' provable ranges.
- A public **WAD-scaled debt index** per asset (`debtIndexStates`), starting
  at 1e18 and non-decreasing.
- **Time-based accrual** of the index (`accrueInterest`, permissionless) and
  **exact ceiling debt calculation inside the ZK circuit**:
  `accrued = ceil(oldDebt × currentIndex / oldIndex)`, with stale-index
  rejection on-chain.
- Accrual is **lazy/permissionless**: the index advances when
  `accrueInterest` is called (keeper-style; no internal accrual in the
  action paths).
- **Honest note:** the stored utilization/slope/target/reserve configuration
  is currently **dormant** — the active accrual formula is base-rate only.
  Utilization-derived rates are designed for (the aggregates are public) but
  not implemented.

## Oracle

- **Testnet (current):** an owner-managed `MockPriceOracle` with an on-chain
  freshness gate (`maxPriceStaleness`, 1h default) and price bounds — used
  for development and E2E demonstration. It is **not production
  infrastructure**.
- **Production direction:** integration with the **Horizen Stork oracle** is
  the planned replacement (same freshness/bounds interface).

## Horizen Testnet deployment (chain ID 2651420)

Current (repaired) deployment — after the risk-transition circuit gate fix,
a new `RiskTransitionVerifier` and a new `VeilLend` were deployed, reusing
the unchanged state-transition/solvency/liquidation verifiers, tokens and
oracle:

| Contract | Address |
|---|---|
| **VeilLend** | [`0xeCB439fbE792Bec4E005f1809E6DCF4FB37d4787`](https://explorer-testnet.horizen.io/address/0xeCB439fbE792Bec4E005f1809E6DCF4FB37d4787) |
| RiskTransitionVerifier (fixed gate) | [`0x65dcBf151d10E63a43b972c41C760E983154Cefb`](https://explorer-testnet.horizen.io/address/0x65dcBf151d10E63a43b972c41C760E983154Cefb) |
| Groth16Verifier (state transitions) | `0x0D96E5a05d11c0839037488332CAd29E6Ef6686C` |
| SolvencyVerifier | `0xD33ce96e9A6AF2c8f5E7f73d5214eDf0c9eff24F` |
| LiquidationVerifier | `0x4bf85D6D5f3A730280D707dB0D2d063940A80869` |
| MockPriceOracle (test-only) | `0xDA4CAA96D6fF78Af30A3955b5310BE9258d57Bc2` |
| vCOL / vDBT (test tokens) | `0x281FbbeD6f2DEA61c86191EA92f2B9B9D2D66a3c` / `0xe27c05934Ad4046d72766808b30F0514e978f612` |

- Network: Horizen Testnet — chain ID **2651420**, RPC
  `https://horizen-testnet.rpc.caldera.xyz/http`, explorer
  `https://explorer-testnet.horizen.io/`, hub/faucet
  `https://hub-testnet.horizen.io/`.
- Full machine-readable record (incl. the superseded first deployment
  `0x9fd6477Dd3b5eDB4e55A7D7F962Af0e8e332a9B9` and its
  `0x533Fd1381b7a3aAc107c07983bf82f6681D98b4a` risk verifier):
  [deployments/horizenTestnet.json](deployments/horizenTestnet.json).

## Verification evidence (existing — not re-run for this document)

- **Root protocol suite: 120 passing** — unit, ZK, solvency, interest
  accounting, risk transitions, supported-collateral/adversarial,
  recipient-binding, liquidation, replay, fuzz/invariant.
- **Demo tests: 13/13 passing** (persistence, recovery prototype,
  signature-determinism gate).
- **Successful Horizen Testnet E2E flows with real Groth16 proofs:** create →
  deposit → borrow → repay → withdraw (full lifecycle, commitment chain
  advancing on-chain), **confidential liquidation** (eligibility proof +
  in-circuit settlement, position Closed), and the **recovery prototype**
  flow (backup → wipe → recover → commitment equality). The earlier
  milestone evidence (first deployment) is preserved in
  [docs/testnet-proof-evidence.md](docs/testnet-proof-evidence.md) and
  [docs/testnet-liquidation-evidence.md](docs/testnet-liquidation-evidence.md);
  the repaired-deployment lifecycle is recorded in
  [deployments/horizenTestnet.json](deployments/horizenTestnet.json).

## Demo (browser application)

[`demo/`](demo/) is a working Next.js + wagmi/viem frontend for the deployed
testnet contracts — no backend, no mocks in the proving path: connect wallet
→ create position → deposit → **oracle refresh when required** → borrow →
repay → withdraw, each with **browser-side witness + Groth16 proof
generation** verified on-chain, plus the **confidential liquidation**
demonstration (owner can move the mock price to trigger it) and the
**recovery prototype** pages (`/recovery-test`, `/sigtest`). Details and the
manual walkthrough: [demo/README.md](demo/README.md).

- **vCOL** is the test/demo **collateral** asset and **vDBT** the test/demo
  **debt** asset — both are mock tokens for testnet only, not production
  assets.

## Repository

```text
circuits/veillend_lib.circom        # shared commitment/nullifier/arithmetic templates
circuits/state_transition.circom    # deposit / repay circuit
circuits/solvency.circom            # private health proof
circuits/risk_transition.circom     # borrow / withdraw with in-circuit solvency
circuits/liquidation.circom         # eligibility + settlement outputs
contracts/VeilLend.sol              # protocol + 4 Groth16 verifier integrations
contracts/zk/                       # snarkjs-generated verifiers
scripts/prove.ts                    # prover library + circuit build + local demo
scripts/deploy.ts                   # Horizen Testnet deployment (full stack + config)
scripts/deploy-riskfix.ts           # repaired-deployment script (new risk verifier + VeilLend)
scripts/e2e-riskfix.ts              # resumable lifecycle E2E (create→deposit→borrow→repay→withdraw→liquidate)
scripts/proof-test.ts               # on-chain ZK proof integration test
test/                               # unit / ZK / solvency / risk / risk-gate / liquidation / adversarial / fuzz
demo/                               # browser demo (Next.js + wagmi/viem, in-browser Groth16)
deployments/                        # address book + deployment/E2E logs
docs/                               # models + testnet evidence
architecture.md                     # design reference (read this first)
```

## Quickstart

```bash
npm install

# ZK toolchain: circom 2.2.x binary at tools/circom.exe or on PATH
npm run zk:build    # compile circuits → pot14 → zkeys → regenerate Solidity verifiers
npm run build       # hardhat compile
npm test            # 120 tests — unit/ZK/solvency/risk/liquidation/adversarial/fuzz
npm run prove       # local end-to-end demo: witness → commitment → proof → verify

# browser demo
cd demo && npm install && npm run dev   # http://localhost:3000 (13/13 demo tests: npm test)

# on-chain (requires funded HORIZEN_TESTNET_PRIVATE_KEY in .env — see .env.example)
npx hardhat run scripts/verify-network.ts --network horizenTestnet  # read-only precheck
npx hardhat run scripts/proof-test.ts   --network horizenTestnet    # the on-chain ZK proof test
```

Requires Node 18+. Groth16 proving in tests is CPU-heavy (mocha timeout
raised accordingly).

## Built vs. future

**Already built and demonstrated:** private state with Poseidon commitments;
Groth16 proofs generated in the browser and verified on-chain; private
solvency verification; private state transitions (deposit/repay); borrow and
withdraw with in-circuit post-action solvency; confidential liquidation;
replay/nullifier protection; recipient binding; oracle freshness checks;
public interest index mechanics; testnet deployment; working frontend/demo;
encrypted private-state recovery prototype (client-side only).

**Future / production milestones:** external security audit; production
oracle integration (Horizen Stork); broader collateral support; production
economics (utilization-based rates, incentives); liquidity integrations;
Horizen ecosystem integration; mainnet deployment; real user/liquidity
growth; production monitoring and operational hardening.

## Honest scope & limitations

- **Position privacy, not transaction privacy**: per-action token amounts
  are public (the ERC20 layer is not confidential); what stays hidden is the
  cumulative position state — collateral, debt, accrued interest, health.
- **Unaudited.** A production deployment requires further security/audit
  work.
- **Immutable deployment:** verifier addresses are fixed in the constructor;
  any future circuit change requires a redeployment (this already happened
  once for the borrow-gate fix — see the deployment section).
- **The testnet oracle is mock/owner-managed** with an administrative
  staleness upper-bound (`setMaxPriceStaleness` has no technical ceiling) —
  production uses Stork.
- **Private-state recovery is a client-side prototype** (encrypted backup +
  wallet-derived key): it is not an on-chain recovery mechanism and grants
  no on-chain permissions.
- **Liquidation socializes remaining bad debt** (residual outstanding is
  wiped at close; no bonus/penalty economics yet).
- Test-only assets (vCOL/vDBT), PoC single-contribution trusted setup (a real
  ceremony is required for production), nothing on mainnet.
- Interest accrual is lazy/permissionless (keeper-style `accrueInterest`
  call); the utilization-based rate terms are stored but dormant.

## Security posture

Non-custodial aggregates only; no admin withdrawal path (ABI-enforced);
immutable verifier addresses; fail-closed unimplemented actions; emergency
pause without custody backdoor; non-reentrant value paths with paired
accounting and token movement; range checks on every circuit input and
on-chain canonical-signal rejection. Findings from internal security
reviews — unsupported-commitment extraction (F1–F3), parameter/oracle range
gaps (F4), mempool proof theft (F5), and the inverted borrow action gate in
`risk_transition` (fixed and redeployed) — are fixed and covered by
adversarial regression tests (`test/supported-collateral.test.ts`,
`test/recipient-binding.test.ts`, `test/risk-gate.test.ts`; findings
documented in `docs/phase3.md`).

## License

MIT (protocol contracts); the snarkjs-generated verifiers inherit snarkjs
licensing (GPL-3.0) as marked in their headers.
