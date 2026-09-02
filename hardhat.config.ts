import type { HardhatUserConfig } from "hardhat/config";
import "@nomicfoundation/hardhat-toolbox";
import dotenv from "dotenv";

dotenv.config();

// VeilLend targets standard EVM bytecode. "paris" keeps the output free of
// newer-opcode assumptions (PUSH0 / transient storage) so the contracts remain
// deployable across EVM-compatible Horizen environments without recompilation.
const config: HardhatUserConfig = {
  solidity: {
    version: "0.8.28",
    settings: {
      optimizer: {
        enabled: true,
        runs: 200,
      },
      evmVersion: "paris",
    },
  },
  mocha: {
    // Groth16 proving in tests is CPU-heavy (multi-second per proof).
    timeout: 600_000,
  },
  networks: {
    horizenTestnet: {
      // Horizen Testnet (Caldera-hosted) — source of truth for the M1
      // integration: chainId 2651420, native gas token ETH.
      url: "https://horizen-testnet.rpc.caldera.xyz/http",
      chainId: 2651420,
      accounts: process.env.HORIZEN_TESTNET_PRIVATE_KEY ? [process.env.HORIZEN_TESTNET_PRIVATE_KEY] : [],
    },
  },
};

export default config;
