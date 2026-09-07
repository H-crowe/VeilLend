// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IStork} from "../oracles/IStork.sol";

/// @title MockStorkOracle
/// @notice Test mock for the Stork push oracle. Mimics the exact interface
///         of the real `UpgradeableStork` contract so local tests exercise
///         the same code path as the testnet deployment.
///         Does NOT verify signatures (that's Stork's internal logic) —
///         instead, tests can directly set values and timestamps to control
///         freshness and staleness scenarios.
contract MockStorkOracle {
    // ---- State (matches Stork's storage layout for the fields we read) ----

    mapping(bytes32 => uint64) public lastTimestampNs;
    mapping(bytes32 => int192) public lastQuantizedValue;

    uint256 public validTimePeriodSeconds;
    uint256 public singleUpdateFeeInWei;
    address public storkPublicKey;

    // ------------------------------------------------------------------
    // Constructor
    // ------------------------------------------------------------------

    constructor(uint256 _validTimePeriodSeconds, uint256 _singleUpdateFeeInWei) {
        validTimePeriodSeconds = _validTimePeriodSeconds;
        singleUpdateFeeInWei = _singleUpdateFeeInWei;
    }

    // ------------------------------------------------------------------
    // Write (test control)
    // ------------------------------------------------------------------

    /// @notice Directly sets a value + timestamp (test helper).
    function setValue(bytes32 id, int192 quantizedValue, uint64 timestampNs) external {
        lastQuantizedValue[id] = quantizedValue;
        lastTimestampNs[id] = timestampNs;
    }

    // ------------------------------------------------------------------
    // IStork-compatible read (matches real Stork's interface)
    // ------------------------------------------------------------------

    struct TemporalNumericValue {
        uint64 timestampNs;
        int192 quantizedValue;
    }

    function getTemporalNumericValueV1(bytes32 id)
        external
        view
        returns (TemporalNumericValue memory)
    {
        uint64 ts = lastTimestampNs[id];
        int192 val = lastQuantizedValue[id];
        if (val == 0 && ts == 0) revert NotFound_();
        return TemporalNumericValue({timestampNs: ts, quantizedValue: val});
    }

    error NotFound_();

    // Stork's error selectors (for matching revert data in tests)
    // StaleValue() = 0x24c4fe43
    // NotFound() = 0xc5723b51
}
