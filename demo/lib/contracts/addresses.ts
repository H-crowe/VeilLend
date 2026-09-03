/**
 * Deployed Horizen Testnet addresses — source of truth:
 * deployments/horizenTestnet.json (root repository). Do not edit by hand.
 */
export const ADDRESSES = {
  veilLend: "0x9fd6477Dd3b5eDB4e55A7D7F962Af0e8e332a9B9",
  stateTransitionVerifier: "0x0D96E5a05d11c0839037488332CAd29E6Ef6686C",
  solvencyVerifier: "0xD33ce96e9A6AF2c8f5E7f73d5214eDf0c9eff24F",
  riskTransitionVerifier: "0x533Fd1381b7a3aAc107c07983bf82f6681D98b4a",
  liquidationVerifier: "0x4bf85D6D5f3A730280D707dB0D2d063940A80869",
  mockPriceOracle: "0xDA4CAA96D6fF78Af30A3955b5310BE9258d57Bc2",
  collateralToken: "0x281FbbeD6f2DEA61c86191EA92f2B9B9D2D66a3c",
  debtToken: "0xe27c05934Ad4046d72766808b30F0514e978f612",
} as const;
