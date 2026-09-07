# VeilLend Demo

A Web3 demo application for **VeilLend** — private lending on **Horizen
Testnet** (chain ID 2651420). It connects a browser wallet directly to the
deployed VeilLend contracts and generates **real Groth16 proofs in the
browser** (snarkjs) for every state transition. No backend, no mocks.

> The demo is for the Horizen Builder Ecosystem Fund S2 reviewers. vCOL/vDBT
> are testnet mock assets; the protocol is unaudited; nothing here is
> production infrastructure.

## 1. What it is
A dark, minimal dashboard over the deployed VeilLend protocol: create a
private position, deposit collateral, borrow, repay, withdraw — each state
transition authorized by a real ZK proof. Collateral, debt and health are
**never displayed as public on-chain values**; the UI marks them private and
shows what the chain actually stores: commitments, sequences, nullifier
consumption, and public amounts the protocol requires.

A progress strip tracks the primary flow:
**Connect → Create → Deposit → Borrow → Repay → Withdraw**.

Developer/test tools (minting, liquidity seeding, price relay) are visually
separated in a distinct **"Developer tools — Testnet only"** section and are
not part of the user flow.

## 2. Install & run locally

```bash
cd demo
npm install
npm run dev      # http://localhost:3000
```

Production build (Vercel-compatible):

```bash
npm run build && npm start
```

The ZK proving artifacts (`.wasm` / `.zkey`) and the snarkjs browser bundle
are already included under `public/` — no extra setup.

## 3. Connect Horizen Testnet
Click **Connect Wallet** (MetaMask or any injected wallet) — a
**Disconnect** button sits next to the connected address. If the wallet is
on the wrong network, use the **Switch to Horizen Testnet** button
(chain ID 2651420, RPC `https://horizen-testnet.rpc.caldera.xyz/http`).

## 4. Assets

The demo shows an asset registry with every asset's role, decimals, wallet
balance, and status:

| Asset | Role | Decimals | Stork production feed | Status |
|---|---|---|---|---|
| vCOL | collateral (demo mock) | 18 | — (demo constant) | Active |
| vDBT | debt (demo mock) | 18 | — (demo constant) | Active |
| WETH | collateral (ecosystem asset `0x4200…0006`) | 18 | **WETHUSD** | Active (testnet-priced via the demo relay) |
| USDC | debt (ecosystem asset `0x01c7…639E`) | 6 | **USDCUSD** | Active (testnet-priced via the demo relay) |
| ZEN | — | — | none | 🔒 Locked — no ZEN/USD Stork feed |

USDT is not supported. ZEN is never selectable.

The **collateral/debt pair is chosen once, at position creation**, and stays
fixed for that position's life; the position card then always shows the
position's own pair.

## 5. Price source (Testnet / Demo ONLY)

The **"Testnet / Demo Price Source — Base Chainlink → Mock Oracle"** panel
shows the current WETH/USD and USDC/USD prices and their last update time.

```text
Base Mainnet Chainlink (ETH/USD, USDC/USD)
        ↓  isolated relay (relay/base-price-relay.mjs, server-side)
OwnerMockPriceOracle (owner-gated) on Horizen Testnet
        ↓
VeilLend
```

- **Refresh Prices** asks the relay to fetch the latest Base Chainlink prices
  and update the testnet oracle in one owner-signed transaction. The relay
  runs separately (`node relay/base-price-relay.mjs`) and holds the owner key
  in its own environment.
- **Users never enter, choose, or submit a price** — there is no price input
  anywhere in the UI.
- This is **TESTNET/DEMO ONLY**: not production oracle infrastructure, not
  production-secure, and not a Stork replacement. See
  `../docs/oracle-model.md` §5 for the two-path model.

## 6. Create a position
Choose the **collateral asset** (vCOL, WETH, USDC) and **debt asset**
(vDBT, USDC) in the "Create a position" panel, then press **Create New
Position** — the app computes your initial Poseidon commitment locally
(fresh control secret + salt) and stores the position's private state in
this browser only. WETH/USDC positions on the current deployment are priced
by the Testnet/Demo relay (§5).

## 7. Deposit
Enter the collateral amount and press **Deposit {asset}**: the app generates
a real `state_transition` Groth16 proof binding the deposit to your hidden
state, submits it, and shows the verified commitment/sequence. On-chain
custody increases 1:1 with your hidden collateral. The input shows your
wallet balance for the selected asset (with a **max** shortcut) and handles
asset decimals correctly.

## 8. Borrow
Enter the debt amount and press **Borrow {asset}**: the `risk_transition`
proof enforces the post-borrow solvency rule in zero knowledge (value-based,
decimal-aware: up to 75% LTV of the deposit's oracle value) and the payout is
**recipient-bound** to your connected address. Borrow liquidity comes from
the repayment-funded reserve (use *Seed liquidity* in the developer tools if
it is empty).

## 9. Repay
Enter the debt amount, press **Repay {asset}**: a real repayment proof
reduces the hidden debt; the app tracks it privately.

## 10. Withdraw
Enter the collateral amount, press **Withdraw {asset}**: the proof shows the
hidden collateral covers the amount and the position stays solvent; custody
decreases 1:1. Funds go to the connected address.

## 11. Liquidation
If the oracle prices make the position undercollateralized
(`collateralValue < debtValue · 85%`), the **Self-liquidation (private)**
panel activates: generate the eligibility proof (the hidden collateral/debt
are not revealed) and settle — collateral released, debt settled, position
Closed. The eligibility check uses the current oracle prices.

## 12. Where the deployed contracts are

The demo's addresses mirror the **CURRENT UUPS deployment**
(`deployments/horizenTestnet-uups.json`) in `lib/contracts/addresses.ts`:

| Contract | Address |
|---|---|
| **VeilLend (UUPS/ERC-1967 proxy)** | `0xc1e2cDADBf14717DfEE7ffA23EAf2b21e6004a5B` |
| VeilLend implementation | `0x353EcfaFa07a60f1Ed473ed4cE3F1c2624fF7aa5` |
| Groth16Verifier (state_transition) | `0xbdF87292EAAd22dB17C5ADCA3eAC33Db891ab3f1` |
| SolvencyVerifier | `0x18C104Dc76A6F4Dad6cC1f2E467D9EbC10162676` |
| RiskTransitionVerifier | `0xB54B51664215ED17F238D52EDD8d5E549D136b26` |
| LiquidationVerifier | `0xe33b96CC86D3c68119312b9B2274F1e734211daa` |
| OwnerMockPriceOracle (Testnet/Demo oracle) | `0x024CF745c737B74f8BCc84d1C73687853310b715` |
| StorkPriceOracle adapter (production path, deployed) | `0xa2c0a60B4A360e88cA5f90860A3B75A3DDfED33D` → Stork `0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62` |
| vCOL / vDBT (test mocks) | `0xb5a5b0f1083965B9d92dCd94E5BCdDb868BfcFCE` / `0xe48a8EC02EB14BB52Fe363D3B2A32e264d3B5D7f` |
| WETH / USDC | `0x4200000000000000000000000000000000000006` / `0x01c7AEb2A0428b4159c0E333712f40e127aF639E` |

The older M1 deployment (`0xeCB439fbE792Bec4E005f1809E6DCF4FB37d4787`,
record: `deployments/horizenTestnet.json`) is **historical and immutable** —
it was never upgraded and is a separate contract.

**Oracle paths:** the demo currently reads prices from the owner-gated
OwnerMockPriceOracle fed by the Testnet/Demo relay (§5). **Stork is the
intended production oracle integration**: the StorkPriceOracle adapter is
already deployed and configured with the official WETHUSD/USDCUSD feeds, and
the protocol supports permissionless same-transaction signed-snapshot updates
(`pushOracleUpdate`). Using Stork as the live price path in this environment
requires publisher-signed observations (Stork subscriber credentials/relay
access — not yet available on Horizen testnet), after which the demo's price
source can be switched by pointing `storkPriceOracle` in
`lib/contracts/addresses.ts` at the adapter.

## 13. Recovery prototype (frozen milestone)
`/recovery-test` demonstrates encrypted private-state backup/recovery: the
state is encrypted with a random AES-256-GCM data key wrapped by a key
derived from a deterministic domain-separated wallet signature (EIP-191 +
HKDF-SHA256), stored OUTSIDE localStorage (downloaded ciphertext file), and
recovery re-derives the key, decrypts, recomputes the Poseidon commitment
and matches it against the on-chain active commitment before restoring
anything. `/sigtest` is the diagnostic page that gated the deterministic
signature assumption. Recovery grants no on-chain permissions. Details:
`lib/recovery/README.md`.

## 14. Important testnet limitations
- **Private state is stored in this browser** (localStorage). Losing it
  means losing access to the position — use *Export* from the console
  (`exportPositions(address)`) to back it up. This is a demo keystore, not
  production wallet integration.
- Per-action amounts are public (the ERC20 layer is not confidential);
  what stays private is the cumulative position state.
- vCOL/vDBT are mocks; the current testnet price source is the Base
  Chainlink relay into an owner-gated demo oracle (**Testnet/Demo only**);
  the trusted setup is a PoC; the protocol is unaudited. Nothing here
  handles real funds.
- Liquidation has no bonus and writes off residual debt (documented PoC
  design).
