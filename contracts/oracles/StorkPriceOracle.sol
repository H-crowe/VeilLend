// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20Metadata} from "@openzeppelin/contracts/token/ERC20/extensions/IERC20Metadata.sol";
import {Ownable} from "@openzeppelin/contracts/access/Ownable.sol";
import {IPriceOracle} from "./IPriceOracle.sol";
import {IStork} from "./IStork.sol";
import {StorkStructs} from "./StorkStructs.sol";

/**
 * @title StorkPriceOracle
 * @notice IPriceOracle adapter that wraps the Stork push oracle on Horizen.
 *         Maps VeilLend asset addresses to Stork feed IDs and rescales
 *         Stork's 18-dec quantized values to VeilLend's 1e8 convention.
 *
 *         Feed IDs are set by the owner at asset-add time (not hardcoded),
 *         keeping the adapter asset-agnostic.
 *
 *         The Stork push oracle's `updateTemporalNumericValuesV1` is
 *         permissionless (anyone can relay a validly signed update), so the
 *         demo/frontend pushes fresh updates in the same transaction as the
 *         consuming operation (via Multicall on VeilLend), eliminating the
 *         need for a separate "Refresh Oracle" transaction.
 *
 *         This adapter is NOT upgradeable — it is a simple, immutable-style
 *         wrapper. If Stork's contract changes, a new adapter is deployed
 *         and VeilLend's `setOracle` is called (owner-only).
 */
contract StorkPriceOracle is IPriceOracle, Ownable {
    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    /// @notice The Stork push oracle contract.
    IStork public immutable storkOracle;

    /// @notice Maps VeilLend asset address → Stork feed ID (bytes32).
    mapping(address => bytes32) public feedIds;

    /// @notice Maps VeilLend asset address → token decimals (recorded at
    ///         feed-registration time for precise rescaling).
    mapping(address => uint8) public assetDecimals;

    // ------------------------------------------------------------------
    // Errors
    // ------------------------------------------------------------------

    error FeedNotSet(address asset);
    error InvalidStorkPrice(int192 quantizedValue);

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    /// @param storkOracle_ The Stork push oracle contract address.
    constructor(address storkOracle_) Ownable(msg.sender) {
        require(storkOracle_ != address(0), "StorkPriceOracle: zero stork oracle");
        storkOracle = IStork(storkOracle_);
    }

    // ------------------------------------------------------------------
    // IPriceOracle
    // ------------------------------------------------------------------

    /// @notice Returns the Stork-pushed price for an asset, rescaled to
    ///         VeilLend's 1e8 convention, along with the update timestamp
    ///         (in seconds) for freshness checking.
    /// @dev Reverts with `FeedNotSet` if no Stork feed is registered for
    ///      the asset, or with `InvalidStorkPrice` if the Stork value is
    ///      non-positive. The caller (VeilLend's `getFreshPrice`) enforces
    ///      the freshness window and price bounds.
    function getPrice(address asset) external view returns (uint256 price, uint256 updatedAt) {
        bytes32 feedId = feedIds[asset];
        if (feedId == bytes32(0)) revert FeedNotSet(asset);

        StorkStructs.TemporalNumericValue memory tv =
            IStork(address(storkOracle)).getTemporalNumericValueV1(feedId);
        uint64 timestampNs = tv.timestampNs;
        int192 quantizedValue = tv.quantizedValue;

        if (quantizedValue <= 0) revert InvalidStorkPrice(quantizedValue);

        // Rescale Stork's 18-dec quantized value → VeilLend's 1e8 convention.
        // quantizedValue = dollars * 1e18 → price = dollars * 1e8 → price = qv / 1e10.
        price = uint256(uint192(quantizedValue)) / 1e10;
        updatedAt = uint256(timestampNs) / 1e9; // ns → seconds
    }

    // ------------------------------------------------------------------
    // Stork update push (same-tx pattern)
    // ------------------------------------------------------------------

    /// @notice Pushes signed Stork updates to the Stork contract.
    ///         Permissionless — anyone can relay a validly signed update.
    ///         The msg.value covers the Stork update fee (`getUpdateFeeV1`).
    ///         Called by the frontend in the SAME transaction as the consuming
    ///         operation (borrow/withdraw/liquidate) via Multicall on VeilLend.
    function pushStorkUpdate(StorkStructs.TemporalNumericValueInput[] calldata updates) external payable {
        IStork(address(storkOracle)).updateTemporalNumericValuesV1{value: msg.value}(updates);
    }

    /// @notice Returns the Stork update fee for a batch of updates.
    function getStorkUpdateFee(StorkStructs.TemporalNumericValueInput[] calldata updates)
        external
        view
        returns (uint256)
    {
        return IStork(address(storkOracle)).getUpdateFeeV1(updates);
    }




    // ------------------------------------------------------------------
    // Feed management (owner-only)
    // ------------------------------------------------------------------

    /// @notice Maps a VeilLend asset to its Stork feed ID and records the
    ///         asset's decimals for precise rescaling.
    function setFeedId(address asset, bytes32 feedId) external onlyOwner {
        require(feedId != bytes32(0), "StorkPriceOracle: zero feed ID");
        uint8 d = IERC20Metadata(asset).decimals();
        require(d >= 6 && d <= 18, "StorkPriceOracle: decimals out of 6..18 range");
        feedIds[asset] = feedId;
        assetDecimals[asset] = d;
        emit FeedIdSet(asset, feedId, d);
    }

    // ------------------------------------------------------------------
    // Events
    // ------------------------------------------------------------------

    event FeedIdSet(address indexed asset, bytes32 indexed feedId, uint8 decimals);
}
