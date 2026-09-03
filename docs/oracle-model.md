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
4. **No decimals handling.** The protocol assumes the oracle reports prices
   in the documented 1e8 convention for each asset; a mismatched feed would
   produce economically wrong (but still internally consistent) results.
   Feed validation is production work.

## 5. Production gap (documented, not implemented)

Production direction for the Horizen deployment: integrate the
**Horizen Stork oracle** behind the same freshness/bounds interface — the
current `MockPriceOracle` is testnet/demo infrastructure only.

Multi-source aggregation, deviation/heartbeat checks, sequencer/uptime
feeds, and liquidation-grade price safety are deliberately NOT built in
this phase. The interface boundary (`IPriceOracle` + freshness) is the
seam where a real oracle network plugs in without touching circuits or
position state.
