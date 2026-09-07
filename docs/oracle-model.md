# VeilLend — Oracle Model (Phase 3)

## 1. Scope

Phase 3 uses an intentionally minimal but architecturally correct oracle:
**one price source per asset behind a single interface, with on-chain
freshness enforcement.** No aggregation, no routing, no multi-provider
quorum — those are production concerns deliberately out of scope.

## 2. Interface

```solidity
interface IPriceOracle {
    function getPrice(address asset) external view returns (uint256 price, uint256 updatedAt);
}
```

- `price`: fixed-point, **1e8 scale** (one unit = 1e-8 of a whole token's
  price; the same convention as ChainLink USD feeds). Interpreted inside ZK
  circuits as a field element constrained `< 2^64`.
- `updatedAt`: unix timestamp of the observation.

## 3. Freshness

`VeilLend.getFreshPrice(asset)` fails closed when any of the following hold:

| Condition | Error |
|---|---|
| no oracle configured | `OracleNotSet` |
| `price == 0` | `InvalidPrice` |
| `updatedAt` in the future | `InvalidPrice` |
| `block.timestamp - updatedAt > maxPriceStaleness` (admin-set, default 1h) | `StalePrice` |

Every risky operation (solvency verification, borrow, withdraw, liquidation)
reads prices through `getFreshPrice` and passes them into the Groth16
verifier as public inputs. **Invariant: invalid or stale oracle data cannot
authorize a risky state transition** — the read and the verification happen
in the same transaction, so a proof computed against newer prices reverts
(there is no "price slippage" bypass; the submitter simply re-proves).

## 4. Trust assumptions (explicit)

1. **Single oracle, admin-set.** The owner can change the oracle address
   (`setOracle`) and the staleness window (`setMaxPriceStaleness`). A
   malicious or compromised oracle can lie about prices and thereby
   manipulate solvency/liquidation outcomes for positions whose proofs are
   generated after the manipulation. This is the standard PoC trust model
   and the reason the admin cannot touch custody: price manipulation can
   mis-authorize a transition but never moves funds outside the protocol's
   own rules.
2. **Prices are public inputs.** They are not hidden; only the balances
   they are multiplied with remain private.
3. **Timestamp trust.** `updatedAt` is reported by the oracle itself; the
   contract cannot verify observation time beyond the freshness window.
4. **Decimal normalization.** The protocol applies an 18-dec-normalized
   price convention — `normalized = raw oracle price × 10^(18 − decimals)` —
   so mixed-decimal collateral/debt pairs (e.g. 18 vs 6) compare exact dollar
   values. Asset decimals are recorded (and bounded to 6..18) at asset-enable
   time, and the oracle is still expected to report prices in the documented
   1e8 convention. The full normalization math lives in
   [`solvency-model.md`](solvency-model.md).

## 5. Oracle paths on Testnet (two distinct paths — do not mix)

**Testnet/Demo path (TEMPORARY, NOT production):**

```text
Base Mainnet Chainlink (ETH/USD 0x5001…3a8b, USDC/USD 0x01Ba…1bB5)
        ↓
relay/base-price-relay.mjs (isolated, server-side owner key, no user price input)
        ↓
OwnerMockPriceOracle (owner-gated, 0x024C…b715) on Horizen Testnet
        ↓
VeilLend (via the existing owner-only setOracle)
```

This exists ONLY to make the current Testnet deployment usable while Stork
testnet feeds have no active publisher. It is not production-secure, not a
Stork replacement, and is isolated in `relay/` so it can be deleted without
touching VeilLend. The M1-era `MockPriceOracle` (permissionless `setPrice`)
is orphaned — the protocol no longer points at it.

**Production path (intended):**

```text
Stork signed data  →  Stork on-chain update (pushOracleUpdate, permissionless)
        ↓
VeilLend (StorkPriceOracle adapter: WETH → WETHUSD, USDC → USDCUSD)
```

## 6. Stork integration (deployed; publishing pending)

The **Horizen Stork push oracle** integration is implemented behind the same
freshness/bounds interface: `IPriceOracle` → `StorkPriceOracle` adapter →
official Stork contract interface (`IStork`/`StorkStructs`), with registry
feed IDs for WETHUSD/USDCUSD, per-asset feed registration (owner-only), and a
permissionless same-transaction flow — a publisher-signed snapshot is relayed
through `VeilLend.pushOracleUpdate` and consumed by the user's ZK proof in one
transaction. Local tests cover the full path against the mocked Stork
interface (`test/stork-integration.test.ts`).

The adapter is deployed on Testnet (`0xa2c0…D33D`) and wired to the real
Stork contract with the official feeds (WETH → WETHUSD `0x8afba5f1…82b8`,
USDC → USDCUSD `0x7416a56f…290c`); it becomes the active oracle once Stork
testnet publishing starts (no subscriber relayer operates on Horizen yet —
Stork's data API requires subscriber credentials, issued via
sales@stork.network). Multi-source
aggregation, deviation/heartbeat checks, sequencer/uptime feeds, and
liquidation-grade price safety remain deliberately out of scope.

Multi-source aggregation, deviation/heartbeat checks, sequencer/uptime
feeds, and liquidation-grade price safety are deliberately NOT built in
this phase. The interface boundary (`IPriceOracle` + freshness) is the
seam where a real oracle network plugs in without touching circuits or
position state.
