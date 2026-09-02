// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @notice Deterministic single-source price oracle used only by the test
/// suite. Prices are set explicitly so freshness behavior can be exercised.
contract MockPriceOracle {
    mapping(address => uint256) private _prices;
    mapping(address => uint256) private _updatedAt;

    function setPrice(address asset, uint256 price) external {
        _prices[asset] = price;
        _updatedAt[asset] = block.timestamp;
    }

    function setPriceAt(address asset, uint256 price, uint256 updatedAt_) external {
        _prices[asset] = price;
        _updatedAt[asset] = updatedAt_;
    }

    function getPrice(address asset) external view returns (uint256 price, uint256 updatedAt) {
        return (_prices[asset], _updatedAt[asset]);
    }
}
