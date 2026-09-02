# VeilLend — Horizen Testnet Liquidation Proof Evidence

> Evidence for the first real end-to-end **confidential liquidation** on
> Horizen Testnet (chain ID 2651420), executed against the deployed
> contracts — no redeploys, no protocol/circuit changes, real Groth16
> proofs only. Machine-readable record:
> [`deployments/testnet-liquidation-proof-test.json`](../deployments/testnet-liquidation-proof-test.json).

## Demonstrated flow

```text
Create Position (#24, Poseidon commitment C0)
  → Deposit 100 vCOL      (real state_transition ZK proof, verified on-chain)
  → Seed debt liquidity   (50 vDBT repaid into debtCustody via real proof)
  → Borrow 10 vDBT        (real risk_transition ZK proof, recipient-bound)
  → Oracle price drop     (vCOL $2.00 → $0.05 via the deployed MockPriceOracle)
  → Liquidation proof     (liquidation circuit; recipient = Wallet B)
  → Wallet B liquidates   (deployed LiquidationVerifier verifies on-chain)
  → Settlement            (100 vCOL seized 1:1; 5 vDBT paid; position Closed)
```

## Positions & wallets

- **Wallet A** (owner): `0x1725a9Ba5E788Ac73AE7f14a2C976DB462c5F204`
- **Wallet B** (liquidator): `0x1202bBE2e0eEAE5aC3C905Cf451e7107e6c11a30`
- **Liquidated position**: `#24` ( VeilLend `0x9fd6477Dd3b5eDB4e55A7D7F962Af0e8e332a9B9`)

## Transactions (Horizen Testnet, chain ID 2651420)

| Step | Tx hash | Block | Gas |
|---|---|---|---|
| createPosition (#24) | recorded — see evidence JSON `transactions` | recorded | recorded |
| deposit 100 vCOL (ZK verified) | recorded — see evidence JSON `transactions` | recorded | recorded |
| seed liquidity (repay 50 vDBT, ZK verified) | recorded — see evidence JSON `transactions` | recorded | recorded |
| borrow 10 vDBT (ZK verified, recipient-bound) | recorded — see evidence JSON `transactions` | recorded | recorded |
| oracle price drop (vCOL $2.00 → $0.05) | recorded — see evidence JSON `transactions` | recorded | — |
| **LIQUIDATION (ZK verified, recipient-bound)** | `0xbfd6ffe40d7e4d987a9d93d2c8c0a69eea639abc0a654210c3a0da4cc17fc43f` | **26,775,401** | **355,932** |

(The complete per-step tx hash / block / gas list is in the evidence JSON —
every step is a real transaction; the liquidation itself is highlighted
above.)

## Settlement amounts (computed inside the liquidation circuit)

- `collateralOut = 100 vCOL` (entire hidden collateral)
- `debtOut = 5 vDBT` = `min(hidden debt 10, ceil(100·$0.05/$1))` — oracle parity
- **Bad debt written off: 5 vDBT** (`10 − 5`, socialized per the documented
  PoC design — no incentive/bonus, no reserve accounting)

## Post-liquidation on-chain state (verified by read calls)

| Check | Result |
|---|---|
| Position #24 status | **Closed** ✓ |
| `borrowOutstanding(22)` | 0 (written off) ✓ |
| `supportedCollateral(22)` | 0 ✓ |
| collateral custody | decreased by exactly 100e18 ✓ |
| debt custody | increased by exactly 5e18 ✓ |
| Wallet B vCOL | +100e18 (exactly `collateralOut`) ✓ |
| Wallet B vDBT | −5e18 (exactly `debtOut`) ✓ |
| Wallet A | received **nothing** from the liquidation ✓ |
| active commitment | unchanged by liquidation (documented behavior) ✓ |
| replay attempt | reverted (position inactive) ✓ |

## Public vs private data

**Public on-chain:** position id, liquidation event with
`collateralOut`/`debtOut`, custody deltas, oracle prices, threshold, the
fact that eligibility was proven, liquidator/payer addresses.

**Private (never logged or persisted):** control secret, salts, the full
witness, the hidden pre-liquidation snapshot debt beyond the
`debtOut`-derived bound, and the residual written-off debt amount
(`10 − 5 = 5 vDBT` here is known only to the position holder).

## Reproduction

```bash
npx hardhat run scripts/verify-network.ts  --network horizenTestnet
npx hardhat run scripts/liquidation-test.ts --network horizenTestnet
```

The script is self-contained: it funds Wallet B from the deployer wallet
using the deployed test tokens, executes the lifecycle with real proofs,
and writes the public evidence JSON.

## Testnet artifacts to be aware of

Earlier aborted test-script runs left **orphaned, unfunded positions**
(#1, #3, #5, #7, #9, #10, #12, #14 — see the orphaned-positions recovery
audit): empty or deposit-backed but with lost witnesses, so their custody
(~600 vCOL across #3/#5/#7/#10/#12/#14) is permanently locked. These are
test artifacts of script bugs, not protocol issues; five positions
(#16, #18, #20, #22, #24) each completed the full liquidation lifecycle
successfully.
