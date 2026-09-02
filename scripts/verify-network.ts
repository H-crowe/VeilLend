/**
 * Read-only pre-deployment check for the Horizen Testnet.
 * Verifies: chainId, deployer account from .env, balance, RPC connectivity.
 * Makes NO state changes. Usage:
 *   npx hardhat run scripts/verify-network.ts --network horizenTestnet
 */
import { ethers } from "hardhat";

const EXPECTED_CHAIN_ID = 2651420n;

async function main() {
  const network = await ethers.provider.getNetwork();
  console.log("connected chainId :", network.chainId.toString());
  if (network.chainId !== EXPECTED_CHAIN_ID) throw new Error(`Wrong network: ${network.chainId}, expected ${EXPECTED_CHAIN_ID}`);

  const [deployer] = await ethers.getSigners();
  if (!deployer) throw new Error("No signer — is HORIZEN_TESTNET_PRIVATE_KEY set in .env?");
  console.log("deployer          :", deployer.address);

  const balance = await ethers.provider.getBalance(deployer.address);
  console.log("balance           :", (Number(balance) / 1e18).toFixed(6), "ETH");
  console.log("block number      :", (await ethers.provider.getBlockNumber()).toString());
  console.log("NETWORK VERIFICATION OK");
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
