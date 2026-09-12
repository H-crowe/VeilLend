/**
 * Exact ABIs from the Hardhat compilation artifacts of the DEPLOYED
 * contracts (deployments/horizenTestnet.json) — not hand-minimized.
 * Files generated from artifacts/ during the demo build-out.
 */
import { Abi } from "viem";
import veilLendAbiJson from "./veilLend.abi.json";
import tokenAbiJson from "./token.abi.json";
import oracleAbiJson from "./oracle.abi.json";
import poolAbiJson from "./pool.abi.json";

export const veilLendAbi = veilLendAbiJson as Abi;
export const tokenAbi = tokenAbiJson as Abi;
export const oracleAbi = oracleAbiJson as Abi;
export const poolAbi = poolAbiJson as Abi;
