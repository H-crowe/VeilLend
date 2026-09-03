# VeilLend Demo

A Web3 demo application for **VeilLend** — private lending on **Horizen
Testnet** (chain ID 2651420). It connects a browser wallet directly to the
already-deployed VeilLend contracts and generates **real Groth16 proofs in
the browser** (snarkjs) for every state transition. No backend, no mocks.

> The demo is for the Horizen Builder Ecosystem Fund S2 reviewers. vCOL/vDBT
> are testnet mock assets; the protocol is unaudited; nothing here is
> production infrastructure.

## 1. What it is
A dark, minimal dashboard over the deployed VeilLend protocol: create a
private position, deposit collateral, borrow, repay, withdraw — each state
transition authorized by a real ZK proof. Collateral, debt and health are
**never displayed as public on-chain values**; the UI marks them PRIVATE and
shows what the chain actually stores: commitments, sequences, nullifier
consumption, and public amounts the protocol requires.

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
Click **Connect Wallet** (MetaMask or any injected wallet). If the wallet is
on the wrong network, use the **Switch to Horizen Testnet** button
(chain ID 2651420, RPC `https://horizen-testnet.rpc.caldera.xyz/http`).

## 4. Testnet assets
vCOL (collateral) and vDBT (debt) are deployed test mocks. Use the
**Testnet assets** panel to mint test amounts to your wallet. Seeding
liquidity mints vDBT and repays it into the protocol reserve so that borrow
liquidity exists (the M1 design funds borrows from repayments).

## 5. Create a position
**Create New Position** — the app computes your initial Poseidon commitment
locally (fresh control secret + salt) and stores the position's private
state in this browser only.

## 6. Deposit
Enter a vCOL amount, press **Deposit**: the app generates a real
`state_transition` Groth16 proof binding the deposit to your hidden state,
submits it, and shows the verified commitment/sequence. On-chain custody
increases 1:1 with your hidden collateral.

## 7. Borrow
Enter a vDBT amount, press **Borrow**: the `risk_transition` proof enforces
the post-borrow solvency rule in zero knowledge and the payout is
**recipient-bound** to your connected address. Borrow liquidity comes from
the repayment-funded reserve (use *Seed liquidity* if it is empty).

## 8. Repay
Enter a vDBT amount (up to your hidden debt), press **Repay**: a real
repayment proof reduces the hidden debt; the app tracks it privately.

## 9. Withdraw
Enter a vCOL amount, press **Withdraw**: the proof shows the hidden
collateral covers the amount and the position stays solvent; custody
decreases 1:1. Funds go to the connected address.

## 10. Liquidation
If the oracle price makes your position undercollateralized
(`collateralValue < debtValue · 85%`), the **Private liquidation** panel
activates: generate the eligibility proof (the hidden collateral/debt are
not revealed) and settle — full collateral released, oracle-parity debt
paid, position Closed. You can force this on testnet by dropping the vCOL
price via the deployed MockPriceOracle (owner action).

## 11. Where the deployed contracts are
Addresses come from `deployments/horizenTestnet.json` and are mirrored in
`lib/contracts/addresses.ts` — VeilLend
`0x9fd6477Dd3b5eDB4e55A7D7F962Af0e8e332a9B9` plus the four Groth16
verifiers, MockPriceOracle, and the two test tokens. Full evidence:
`../docs/testnet-proof-evidence.md` and
`../docs/testnet-liquidation-evidence.md`.

## 12. Important testnet limitations
- **Private state is stored in this browser** (localStorage). Losing it
  means losing access to the position — use *Export* from the console
  (`exportPositions(address)`) to back it up. This is a demo keystore, not
  production wallet integration.
- Per-action amounts are public (the ERC20 layer is not confidential);
  what stays private is the cumulative position state.
- vCOL/vDBT are mocks; the oracle is a mock; the trusted setup is a PoC;
  the protocol is unaudited. Nothing here handles real funds.
- Liquidation has no bonus and writes off residual debt (documented PoC
  design).
