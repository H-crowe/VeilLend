import { ethers, upgrades } from "hardhat";

/**
 * OFFLINE UUPS storage-layout validation (no network, no transactions):
 * - VeilLend V1 (as compiled at the deployed commit's ABI surface) → current
 *   implementation with the appended debtPools state.
 * - LiquidityPool V1 → V2 mock (append-only layout proof).
 * Used by CI so layout regressions are caught before any deployment.
 */
async function main() {
  await upgrades.validateUpgrade(
    await ethers.getContractFactory("VeilLend"),
    await ethers.getContractFactory("VeilLendV2Mock"),
    { kind: "uups" }
  );
  console.log("VeilLend V1 → V2 layout: PASS");

  await upgrades.validateUpgrade(
    await ethers.getContractFactory("LiquidityPool"),
    await ethers.getContractFactory("LiquidityPoolV2Mock"),
    { kind: "uups" }
  );
  console.log("LiquidityPool V1 → V2 layout: PASS");
}

main().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});
