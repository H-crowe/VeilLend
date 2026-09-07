// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";

/// @notice TESTNET/DEMO ONLY — owner-gated variant of MockPriceOracle.
/// The original MockPriceOracle has an open setPrice(), which is unsafe for a
/// demo where real Base-market prices are relayed: anyone could overwrite
/// them. Here only the owner (the price-relay's deployer account) may set
/// prices. Implements the same IPriceOracle surface (getPrice), so VeilLend
/// can be pointed at it through the existing owner-only `setOracle`.
/// This contract is NOT part of the production oracle design (Stork is).
contract OwnerMockPriceOracle is Ownable {
    mapping(address => uint256) private _prices;
    mapping(address => uint256) private _updatedAt;

    constructor() Ownable(msg.sender) {}

    event PriceSet(address indexed asset, uint256 price, uint256 updatedAt);

    /// @notice Owner-only. The price relay authenticates with the owner key.
    function setPrice(address asset, uint256 price) external onlyOwner {
        _prices[asset] = price;
        _updatedAt[asset] = block.timestamp;
        emit PriceSet(asset, price, block.timestamp);
    }

    function setPriceAt(address asset, uint256 price, uint256 updatedAt_) external onlyOwner {
        _prices[asset] = price;
        _updatedAt[asset] = updatedAt_;
    }

    /// @notice Owner-only batch update (one tx for the whole asset set).
    function setPrices(address[] calldata assets, uint256[] calldata prices) external onlyOwner {
        require(assets.length == prices.length, "length mismatch");
        for (uint256 i = 0; i < assets.length; i++) {
            _prices[assets[i]] = prices[i];
            _updatedAt[assets[i]] = block.timestamp;
            emit PriceSet(assets[i], prices[i], block.timestamp);
        }
    }

    function getPrice(address asset) external view returns (uint256 price, uint256 updatedAt) {
        return (_prices[asset], _updatedAt[asset]);
    }
}
