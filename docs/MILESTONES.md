# VeilLend — Current Status & Roadmap

> Current-state document for the VeilLend protocol on Horizen Testnet.

> Companion design spec: [`docs/ARCHITECTURE.md`](ARCHITECTURE.md).

## 1. What is implemented and live

- **Confidential positions** — private collateral/debt/health inside Poseidon commitments; Groth16 proofs generated client-side and verified on-chain (`deposit` / `repay` via `state_transition`, `borrow` / `withdraw` via `risk_transition` with in-circuit post-action solvency).

- **Confidential liquidation** — dedicated circuit proves eligibility over the hidden state and derives settlement in-circuit; permissionless, oracle-freshness-gated, recipient-bound, replay-proof.

- **Independent LiquidityPools per debt asset** (UUPS, ERC4626-style) — explicit principal/interest repayment accounting, realized-interest-only protocol fees (ring-fenced `accruedFees`), bad-debt `writeOffBorrows` from liquidation shortfalls, and `settleOrphanPosition` for positions whose private witness is lost (collateral-first recovery, bad debt only for the unrecoverable residual). Invariant: `pool.totalBorrows == Σ borrowOutstanding`.

- **Security protections** — recipient binding (F5), nullifier replay protection, custody-bound `supportedCollateral`, on-chain LTV cap, oracle freshness gating, reentrancy guards, `Ownable2Step` + UUPS with owner-only authorization.

- **Demo frontend** — browser-side Groth16 proving (Web Worker), guided position wizard, lender PoolPanel, encrypted recovery files, and transaction state handling.

- **Price oracle** — Horizen Testnet uses an owner-gated oracle fed by an isolated Base-Chainlink relay (`relay/base-price-relay.mjs`). The Stork production path (adapter + `pushOracleUpdate`) is deployed and can be activated when Stork testnet publishing starts.

## 2. Live deployment (Horizen Testnet, chainId 2651420)

| Contract | Address |
| --- | --- |
| VeilLend (UUPS proxy) | `0xc1e2cDADBf14717DfEE7ffA23EAf2b21e6004a5B` |
| VeilLend implementation | `0xfb8a61658110e47a1f79c0632061e97bc37b2c3d` |
| vDBT LiquidityPool (UUPS proxy) | `0x21Cf3FFE0FF3ccf422c89A0A55fCE1949C84fB57` |
| USDC LiquidityPool (UUPS proxy) | `0xf406448E519345C9D8bc08B606DaB677Cb12aCC1` |
| LiquidityPool implementation (shared) | `0x3c081adab71c5237ac3b21590dbbc60b26b5967d` |
| Groth16 verifier | `0xbdF87292EAAd22dB17C5ADCA3eAC33Db891ab3f1` |
| Solvency verifier | `0x18C104Dc76A6F4Dad6cC1f2E467D9EbC10162676` |
| RiskTransition verifier | `0xB54B51664215ED17F238D52EDD8d5E549D136b26` |
| Liquidation verifier | `0xe33b96CC86D3c68119312b9B2274F1e734211daa` |
| OwnerMockPriceOracle (testnet, relay-fed) | `0x024CF745c737B74f8BCc84d1C73687853310b715` |
| StorkPriceOracle adapter | `0xa2c0a60B4A360e88cA5f90860A3B75A3DDfED33D` |
| Stork (production path) | `0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62` |
| vCOL (collateral mock) | `0xb5a5b0f1083965B9d92dCd94E5BCdDb868BfcFCE` |
| vDBT | `0xe48a8EC02EB14BB52Fe363D3B2A32e264d3B5D7f` |
| USDC | `0x01c7AEb2A0428b4159c0E333712f40e127aF639E` |

Deployment and upgrade transaction hashes are recorded in the canonical deployment manifests:

- `deployments/horizenTestnet-uups.json`
- `deployments/liquidity-pools-horizenTestnet.json`

## 3. Verification

- **Root protocol suite: 208/208 passing** (`npm test`) — unit, ZK circuit, solvency, risk, supported-collateral, adversarial recipient-binding, liquidation including pool-wired bad-debt lifecycle, replay, seeded fuzz/invariant, upgrade, Stork integration, liquidity-pool economics, orphan settlement, and local E2E lifecycle coverage.

- **Demo suite: 23/23 passing** (`demo/tests/`) — persistence, recovery, signature determinism, and pool math.

- **CI** (`.github/workflows/ci.yml`) — compile, solhint, full suite, offline UUPS storage-layout validation, demo tests, and Next.js build.

## 4. Product Roadmap

### Production Hardening

- External security audit and formal threat model.
- Complete production oracle activation and operational validation.
- Multisig/timelock governance for privileged protocol operations.
- Operational monitoring, alerting, and deployment procedures.

### Mainnet Readiness

- Mainnet deployment after security and operational hardening.
- Production asset configuration and oracle infrastructure.
- Liquidity onboarding and initial market bootstrapping.

### Ecosystem Expansion

- Additional supported assets and lending markets where justified.
- Further protocol integrations and production infrastructure.
- Continued privacy, security, and capital-efficiency improvements.