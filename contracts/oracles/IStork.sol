// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {StorkStructs} from "./StorkStructs.sol";

/// @title IStork
/// @notice Interface for the Stork push oracle on Horizen.
/// @dev Matches the verified `UpgradeableStork` deployment at
///      0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62 on Horizen Testnet.
///      Uses the shared StorkStructs library types for compatibility with
///      the adapter and the test mock.
interface IStork {
    // ---- read functions ----

    /// @notice Returns the stored temporal numeric value for an asset ID.
    /// Reverts with `NotFound()` if the asset ID has never been pushed.
    /// Reverts with `StaleValue()` if the stored value is older than
    /// `validTimePeriodSeconds`.
    function getTemporalNumericValueV1(bytes32 id)
        external
        view
        returns (StorkStructs.TemporalNumericValue memory);

    /// @notice Stork's own freshness window (seconds).
    function validTimePeriodSeconds() external view returns (uint256);

    /// @notice Fee (in wei) required per update batch.
    function singleUpdateFeeInWei() external view returns (uint256);

    /// @notice The Stork publisher public key.
    function storkPublicKey() external view returns (address);

    // ---- write functions ----

    /// @notice Pushes signed Stork updates on-chain. Permissionless —
    /// anyone can relay a validly signed update. The contract verifies
    /// the publisher signature against `storkPublicKey` and checks
    /// freshness against `validTimePeriodSeconds`.
    function updateTemporalNumericValuesV1(
        StorkStructs.TemporalNumericValueInput[] calldata updateData
    ) external payable;

    /// @notice Returns the fee (in wei) required for a batch of updates.
    function getUpdateFeeV1(StorkStructs.TemporalNumericValueInput[] calldata updateData)
        external
        view
        returns (uint256);
}
