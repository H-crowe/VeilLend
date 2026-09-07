// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title IPriceOracle
/// @notice The price oracle interface consumed by VeilLend. Any oracle
///         implementation (mock, Stork adapter, Chainlink adapter) must
///         implement this interface to be compatible with VeilLend's
///         `setOracle` / `getFreshPrice` pipeline.
interface IPriceOracle {
    /// @notice Returns the current price for an asset and the timestamp
    ///         of the last update (in seconds).
    /// @dev The price is 1e8-scaled (dollars per whole token).
    ///      The caller (VeilLend's `getFreshPrice`) enforces:
    ///      - price > 0
    ///      - price < 2^64 (fits the circuits' RangeCheck)
    ///      - updatedAt ≤ block.timestamp
    ///      - block.timestamp - updatedAt ≤ maxPriceStaleness
    function getPrice(address asset) external view returns (uint256 price, uint256 updatedAt);
}
