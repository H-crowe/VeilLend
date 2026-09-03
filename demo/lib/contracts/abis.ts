/** Minimal ABIs for the deployed VeilLend stack (Horizen Testnet). */

export const veilLendAbi = [
  "function createPosition(address collateralAsset, address debtAsset, bytes32 initialCommitment) returns (uint256 positionId)",
  "function deposit((uint256 positionId, uint256 oldCommitment, uint256 newCommitment, uint256 nullifier, uint256 actionId, uint256 newSequence, uint256 currentIndexLo, uint256 currentIndexHi, uint256 publicAmount) t, uint[2] pA, uint[2][2] pB, uint[2] pC)",
  "function borrow((uint256 positionId, uint256 oldCommitment, uint256 newCommitment, uint256 nullifier, uint256 actionId, uint256 newSequence, uint256 currentIndexLo, uint256 currentIndexHi, uint256 publicAmount) t, uint[2] pA, uint[2][2] pB, uint[2] pC)",
  "function repay((uint256 positionId, uint256 oldCommitment, uint256 newCommitment, uint256 nullifier, uint256 actionId, uint256 newSequence, uint256 currentIndexLo, uint256 currentIndexHi, uint256 publicAmount) t, uint[2] pA, uint[2][2] pB, uint[2] pC)",
  "function withdrawCollateral((uint256 positionId, uint256 oldCommitment, uint256 newCommitment, uint256 nullifier, uint256 actionId, uint256 newSequence, uint256 currentIndexLo, uint256 currentIndexHi, uint256 publicAmount) t, uint[2] pA, uint[2][2] pB, uint[2] pC)",
  "function liquidate(uint256 positionId, uint256 collateralOut, uint256 debtOut, uint[2] pA, uint[2][2] pB, uint[2] pC)",
  "function positions(uint256) view returns (address collateralAsset, address debtAsset, bytes32 activeCommitment, uint256 interestIndex, uint64 sequence, uint8 status)",
  "function currentDebtIndex(address) view returns (uint256)",
  "function collateralCustody(address) view returns (uint256)",
  "function debtCustody(address) view returns (uint256)",
  "function supportedCollateral(uint256) view returns (uint256)",
  "function borrowOutstanding(uint256) view returns (uint256)",
  "function nextPositionId() view returns (uint256)",
  "function getFreshPrice(address) view returns (uint256 price, uint256 updatedAt)",
  "function paused() view returns (bool)",
] as const;

export const tokenAbi = [
  "function mint(address to, uint256 amount)",
  "function approve(address spender, uint256 amount) returns (bool)",
  "function balanceOf(address) view returns (uint256)",
  "function allowance(address owner, address spender) view returns (uint256)",
] as const;

export const oracleAbi = [
  "function getPrice(address asset) view returns (uint256 price, uint256 updatedAt)",
  "function setPrice(address asset, uint256 price)",
] as const;
