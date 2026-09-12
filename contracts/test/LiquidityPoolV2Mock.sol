// SPDX-License-Identifier: MIT
pragma solidity ^0.8.24;

import {IERC20} from "@openzeppelin/contracts/token/ERC20/IERC20.sol";
import {LiquidityPool} from "../LiquidityPool.sol";

/**
 * @notice Test-only V2 for UUPS upgrade validation of LiquidityPool: appends
 * state only (append-only layout) and exposes a marker so tests can prove the
 * upgraded implementation is live. Never deployed anywhere.
 */
contract LiquidityPoolV2Mock is LiquidityPool {
    uint256 public v2Extra; // appended state — must not shift V1 slots
    event V2Marker(string message);

    /// @notice V2 initializer (reinitializer(2): runs once after the upgrade).
    /// Re-calls the parent initializers with the proxy's CURRENT values so
    /// nothing is changed; this satisfies the upgrades-plugin validator.
    function initialize() public reinitializer(2) {
        __ERC20_init(name(), symbol());
        __ERC4626_init(IERC20(asset()));
        __Ownable_init(owner());
        __Pausable_init();
        __ReentrancyGuard_init();
        __UUPSUpgradeable_init();
    }

    function v2Ping(string calldata message) external {
        v2Extra += 1;
        emit V2Marker(message);
    }
}
