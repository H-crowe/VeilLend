/**
 * Deployed Horizen Testnet addresses — source of truth:
 * deployments/horizenTestnet.json (root repository). Do not edit by hand.
 */
export const ADDRESSES = {
  veilLend: "0xeCB439fbE792Bec4E005f1809E6DCF4FB37d4787",
  stateTransitionVerifier: "0x0D96E5a05d11c0839037488332CAd29E6Ef6686C",
  solvencyVerifier: "0xD33ce96e9A6AF2c8f5E7f73d5214eDf0c9eff24F",
  riskTransitionVerifier: "0x65dcBf151d10E63a43b972c41C760E983154Cefb",
  liquidationVerifier: "0x4bf85D6D5f3A730280D707dB0D2d063940A80869",
  mockPriceOracle: "0xDA4CAA96D6fF78Af30A3955b5310BE9258d57Bc2",
  // Stork push oracle (official deployment on Horizen Testnet).
  storkOracle: "0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62",
  // StorkPriceOracle adapter — empty until the Stork-backed deployment
  // lands; when set, price reads and pushOracleUpdate flow through it.
  storkPriceOracle: "",
  collateralToken: "0x281FbbeD6f2DEA61c86191EA92f2B9B9D2D66a3c",
  debtToken: "0xe27c05934Ad4046d72766808b30F0514e978f612",
} as const;

/**
 * Asset registry shown in the demo alongside the active vCOL/vDBT pair.
 * vCOL/vDBT remain the protocol's active collateral/debt tokens (unchanged).
 * WETH and USDC are the Horizen ecosystem assets wired to the Stork oracle
 * (feeds ETHUSD / USDCUSD); positions in them activate with the Stork-backed
 * deployment. ZEN stays disabled — no Stork ZEN/USD feed exists.
 */
export type AssetEntry = {
  symbol: string;
  address: string;
  decimals: number;
  /** Stork feed id (empty when the asset has no Stork feed — e.g. ZEN). */
  storkFeedId: string;
  /** "active" = usable in this deployment; "pending" = wired, awaiting the
   *  Stork-backed deployment; "locked" = disabled by design. */
  status: "active" | "pending" | "locked";
  note: string;
};

export const ASSETS: readonly AssetEntry[] = [
  {
    symbol: "vCOL",
    address: "0x281FbbeD6f2DEA61c86191EA92f2B9B9D2D66a3c",
    decimals: 18,
    storkFeedId: "",
    status: "active",
    note: "Demo collateral (mock, 18 decimals) — active in this deployment",
  },
  {
    symbol: "vDBT",
    address: "0xe27c05934Ad4046d72766808b30F0514e978f612",
    decimals: 18,
    storkFeedId: "",
    status: "active",
    note: "Demo debt token (mock, 18 decimals) — active in this deployment",
  },
  {
    symbol: "WETH",
    address: "0x4200000000000000000000000000000000000006",
    decimals: 18,
    storkFeedId: "0x59102b37de83bdda9f38ac8254e596f0d9ac61d2035c07936675e87342817160", // keccak256("ETHUSD")
    status: "pending",
    note: "Ecosystem collateral via Stork ETHUSD — activates with the Stork-backed deployment",
  },
  {
    symbol: "USDC",
    address: "0x01c7AEb2A0428b4159c0E333712f40e127aF639E",
    decimals: 6,
    storkFeedId: "0x7416a56f222e196d0487dce8a1a8003936862e7a15092a91898d69fa8bce290c", // keccak256("USDCUSD")
    status: "pending",
    note: "Ecosystem debt asset via Stork USDCUSD — activates with the Stork-backed deployment",
  },
  {
    symbol: "ZEN",
    address: "",
    decimals: 8,
    storkFeedId: "",
    status: "locked",
    note: "Disabled — no ZEN/USD Stork feed exists",
  },
] as const;
