# VeilLend

> **Privacy-first confidential borrow-lend protocol for the Horizen ecosystem.**

In conventional lending protocols, every position is public: collateral,
debt, and health factor are visible to anyone. VeilLend keeps a position's
cumulative financial state inside a **Poseidon commitment** and authorizes
every state change with a **real Groth16 zero-knowledge proof** verified
on-chain. Observers see that a transaction happened and which amounts moved
at the token layer — but never the resulting position: its total collateral,
total debt, accrued interest, or health.

**Status: Milestone 1 delivered.** The core private-lending primitive is
implemented, covered by 106/106 local tests, **deployed on Horizen Testnet
(chain ID 2651420), and demonstrated end-to-end with real on-chain ZK proof
verification** — see
[docs/testnet-proof-evidence.md](docs/testnet-proof-evidence.md).

Built for the **Horizen Builder Ecosystem Fund / Genesis Program**.

---

## What VeilLend does

```text
Private State (collateral, debt, index snapshot, control secret, salt)
      │  Poseidon (BN254, domain-separated, versioned)
      ▼
Commitment  ←———— the ONLY authoritative on-chain financial state
      │
      ▼
Groth16 proof:  "I know the preimage of the active commitment,
                 I hold the control secret, the transition follows
                 the protocol rules, and (for risky actions) the
                 position remains solvent / is eligible"
      │
      ▼
On-chain verification → new commitment   (sequence +1, nullifier consumed)
```

- **Deposit / repay** — proof-bound transitions; the ERC20 amount is
  cryptographically bound into the hidden state, and on-chain custody stays
  1:1 with the sum of hidden collateral.
- **Borrow / withdraw** — the circuit enforces the **post-action solvency**
  inequality (`collateral·price·10000 ≥ debt·price·LTV`) over the hidden
  balances, so an unsafe action is *unprovable*, not merely rejected.
- **Liquidation** — a separate eligibility proof
  (`collateralValue < debtValue·threshold`) plus confidential settlement
  with in-circuit-computed amounts.
- **Recipient binding** — outbound-value proofs commit the payout recipient
  as a public input derived on-chain from `msg.sender`; copied mempool
  proofs are unusable.
- **Replay protection** — Poseidon nullifiers, consumed only after
  verification; sequences advance by exactly one.

## M1 — Horizen Testnet Proof

**Milestone 1 is delivered with on-chain evidence:** the full private-lending
lifecycle — commitment → real Groth16 deposit proof → borrow → oracle price
drop → real liquidation proof → confidential settlement — was executed
against the deployed VeilLend contracts on Horizen Testnet (chain ID
2651420), with every state transition verified by the deployed verifiers.
Addresses, transaction hashes, the commitment chain, and exact reproduction
steps: **[docs/M1-evidence.md](docs/M1-evidence.md)**.

## Architecture & documentation

| Document | Contents |
|---|---|
| [architecture.md](architecture.md) | design reference: encoding, commitment/nullifier constructions, signal orders, invariants, privacy boundary |
| [docs/solvency-model.md](docs/solvency-model.md) | solvency math, fixed-point precision, borrow/withdraw authorization |
| [docs/oracle-model.md](docs/oracle-model.md) | oracle boundary, freshness, trust assumptions |
| [docs/liquidation-model.md](docs/liquidation-model.md) | liquidation eligibility, settlement, who-knows-what |
| [docs/phase3.md](docs/phase3.md) | phase-3 engineering report (incl. security-review findings F1–F5) |
| [docs/testnet-proof-evidence.md](docs/testnet-proof-evidence.md) | **on-chain evidence: addresses, tx hashes, commitment chain, reproduction steps** |

## Horizen Testnet deployment (chain ID 2651420)

| Contract | Address |
|---|---|
| **VeilLend** | `0x9fd6477Dd3b5eDB4e55A7D7F962Af0e8e332a9B9` |
| Groth16Verifier (state transitions) | `0x0D96E5a05d11c0839037488332CAd29E6Ef6686C` |
| SolvencyVerifier | `0xD33ce96e9A6AF2c8f5E7f73d5214eDf0c9eff24F` |
| RiskTransitionVerifier | `0x533Fd1381b7a3aAc107c07983bf82f6681D98b4a` |
| LiquidationVerifier | `0x4bf85D6D5f3A730280D707dB0D2d063940A80869` |

Test-only auxiliaries (TokenMock ×2, MockPriceOracle) are recorded in
[deployments/horizenTestnet.json](deployments/horizenTestnet.json).

**Demonstrated on-chain:** private state → commitment → real deposit proof →
on-chain verification → state transition → real recipient-bound withdraw
proof → verification → new commitment (C0→C1→C2, sequence 0→1→2, nullifiers
consumed, custody conserved). Tx hashes, blocks, gas, and exact reproduction
steps: [docs/testnet-proof-evidence.md](docs/testnet-proof-evidence.md).

## Repository

```text
circuits/veillend_lib.circom        # shared commitment/nullifier/arithmetic templates
circuits/state_transition.circom    # deposit / repay circuit
circuits/solvency.circom            # private health proof
circuits/risk_transition.circom     # borrow / withdraw with in-circuit solvency
circuits/liquidation.circom         # eligibility + settlement outputs
contracts/VeilLend.sol              # protocol + 4 Groth16 verifier integrations
contracts/zk/                       # snarkjs-generated verifiers
scripts/prove.ts                    # prover library + circuit build + demo
scripts/deploy.ts                   # Horizen Testnet deployment (full stack + config)
scripts/proof-test.ts               # on-chain ZK proof integration test
test/                               # unit / ZK / solvency / risk / liquidation / adversarial / fuzz
docs/                               # models + testnet evidence
architecture.md                     # design reference (read this first)
```

## Quickstart

```bash
npm install

# ZK toolchain: circom 2.2.x binary at tools/circom.exe or on PATH
npm run zk:build    # compile circuits → pot14 → zkeys → regenerate Solidity verifiers
npm run build       # hardhat compile
npm test            # 106 tests — unit/ZK/solvency/risk/liquidation/adversarial/fuzz (~4 min)
npm run prove       # local end-to-end demo: witness → commitment → proof → verify

# on-chain (requires funded HORIZEN_TESTNET_PRIVATE_KEY in .env — see .env.example)
npx hardhat run scripts/verify-network.ts --network horizenTestnet  # read-only precheck
npx hardhat run scripts/proof-test.ts   --network horizenTestnet    # the on-chain ZK proof test
```

Requires Node 18+. Groth16 proving in tests is CPU-heavy (mocha timeout
raised accordingly).

## Honest scope & limitations

- **Position privacy, not transaction privacy**: per-action token amounts
  are public (the ERC20 layer is not confidential); what stays hidden is the
  cumulative position state — collateral, debt, interest, health.
- Testnet deployment only; **test-only** oracle and assets; nothing
  mainnet; unaudited; PoC single-contribution trusted setup (a real
  ceremony is required before any production use).
- Not yet built: liquidation incentives/bad-debt accounting, decentralized
  witness availability for liquidation, supply side beyond repayments,
  zkVerify integration, frontend.

## Security posture

Non-custodial aggregates only; no admin withdrawal path (ABI-enforced);
immutable verifier addresses; fail-closed unimplemented actions; emergency
pause without custody backdoor. Five findings from an internal security
review — unsupported-commitment extraction (F1–F3), parameter/oracle range
gaps (F4), mempool proof theft (F5) — are fixed and covered by adversarial
regression tests (`test/supported-collateral.test.ts`,
`test/recipient-binding.test.ts`; findings documented in `docs/phase3.md`).

## License

MIT (protocol contracts); the snarkjs-generated verifiers inherit snarkjs
licensing (GPL-3.0) as marked in their headers.
