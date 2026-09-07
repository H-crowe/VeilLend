// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

/// @title StorkStructs
/// @notice Data structures used by the Stork protocol.
/// @dev Matches the verified `UpgradeableStork` deployment on
///      Horizen Testnet (0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62).
library StorkStructs {
    /// @notice Stored temporal numeric value (per asset ID).
    struct TemporalNumericValue {
        /// @dev Nanosecond-precision timestamp of the latest publisher update.
        uint64 timestampNs;
        /// @dev Quantized value (18-dec signed integer).
        int192 quantizedValue;
    }

    /// @notice Input structure for pushing a signed Stork update on-chain.
    struct TemporalNumericValueInput {
        TemporalNumericValue temporalNumericValue;
        bytes32 id;
        bytes32 publisherMerkleRoot;
        bytes32 valueComputeAlgHash;
        bytes32 r;
        bytes32 s;
        uint8 v;
    }

    /// @notice Publisher signature structure (used internally by Stork).
    struct PublisherSignature {
        address pubKey;
        string assetPairId;
        uint64 timestamp;
        uint256 quantizedValue;
        bytes32 r;
        bytes32 s;
        uint8 v;
    }
}
