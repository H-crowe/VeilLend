// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {VeilLend} from "../VeilLend.sol";

/// @notice Minimal realistic V2 for the upgrade test: inherits the full V1
/// storage and logic, appends one state variable and a version marker.
/// NO fund-moving functions are added — the upgrade authority is exercised
/// purely to prove state preservation.
contract VeilLendV2Mock is VeilLend {
    uint256 public upgradedAt;

    /// @notice V2 initializer (reinitializer(2): runs once after the upgrade).
    function initialize() public reinitializer(2) {
        __Ownable_init(msg.sender);
        __Ownable2Step_init();
        __Pausable_init();
        __ReentrancyGuard_init();
        upgradedAt = block.timestamp;
    }

    function version() external pure returns (string memory) {
        return "V2";
    }
}
