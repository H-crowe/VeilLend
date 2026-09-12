/**
 * Deployed Horizen Testnet addresses — CURRENT UUPS/Stork deployment.
 * Source of truth: deployments/horizenTestnet-uups.json (root repository).
 * The legacy M1 deployment (deployments/horizenTestnet.json) is historical.
 */
export const ADDRESSES = {
  veilLend: "0xc1e2cDADBf14717DfEE7ffA23EAf2b21e6004a5B",
  stateTransitionVerifier: "0xbdF87292EAAd22dB17C5ADCA3eAC33Db891ab3f1",
  solvencyVerifier: "0x18C104Dc76A6F4Dad6cC1f2E467D9EbC10162676",
  riskTransitionVerifier: "0xB54B51664215ED17F238D52EDD8d5E549D136b26",
  liquidationVerifier: "0xe33b96CC86D3c68119312b9B2274F1e734211daa",
  // Active demo oracle: OwnerMockPriceOracle (owner-gated), fed by the
  // isolated Base-Chainlink price relay (relay/base-price-relay.mjs).
  // TESTNET/DEMO ONLY — not production oracle infrastructure.
  mockPriceOracle: "0x024CF745c737B74f8BCc84d1C73687853310b715",
  // Stork production path (intended, kept intact): adapter wired to the real
  // Stork push oracle with the USDCUSD feed. Not yet price-active on
  // testnet (no publisher relaying) — set storkPriceOracle above to switch
  // the demo price source to Stork once Stork testnet publishing starts.
  storkPriceOracle: "",
  storkOracle: "0xacC0a0cF13571d30B4b8637996F5D6D774d4fd62",
  collateralToken: "0xb5a5b0f1083965B9d92dCd94E5BCdDb868BfcFCE", // vCOL
  debtToken: "0xe48a8EC02EB14BB52Fe363D3B2A32e264d3B5D7f", // vDBT
} as const;

/**
 * Per-debt-asset LiquidityPool (UUPS) addresses. Each supported debt asset
 * has its own independent pool (lender shares, economics, reserves).
 * Addresses from deployments/liquidity-pools-horizenTestnet.json (deployed,
 * wired via setDebtPool, and verified on the explorer).
 */
export const POOLS: Record<string, string> = {
  vDBT: "0x21Cf3FFE0FF3ccf422c89A0A55fCE1949C84fB57",
  USDC: "0xf406448E519345C9D8bc08B606DaB677Cb12aCC1",
} as const;

/**
 * Asset registry shown in the demo alongside the active vCOL/vDBT pair.
 * vCOL/vDBT remain the protocol's active collateral/debt tokens (unchanged).
 * MVP: vCOL collateral · vDBT/USDC debt (active, priced by the temporary
 * Testnet/Demo Base Chainlink relay; Stork USDCUSD is the production feed).
 * ZEN stays disabled — no Stork ZEN/USD feed exists.
 */
export type AssetEntry = {
  symbol: string;
  address: string;
  decimals: number;
  /** Stork feed id (empty when the asset has no Stork feed — e.g. ZEN). */
  storkFeedId: string;
  /** "active" = usable in this deployment; "pending" = wired, awaiting
   *  Stork testnet publishing; "locked" = disabled by design.
   *  (Currently all four lending assets are active; "pending" is reserved
   *  for the Stork-production price path switch.) */
  status: "active" | "pending" | "locked";
  note: string;
};

export const ASSETS: readonly AssetEntry[] = [
  {
    symbol: "vCOL",
    address: "0xb5a5b0f1083965B9d92dCd94E5BCdDb868BfcFCE",
    decimals: 18,
    storkFeedId: "",
    status: "active",
    note: "Demo collateral (mock, 18 decimals) — active in this deployment",
  },
  {
    symbol: "vDBT",
    address: "0xe48a8EC02EB14BB52Fe363D3B2A32e264d3B5D7f",
    decimals: 18,
    storkFeedId: "",
    status: "active",
    note: "Demo debt token (mock, 18 decimals) — active in this deployment",
  },
  {
    symbol: "USDC",
    address: "0x01c7AEb2A0428b4159c0E333712f40e127aF639E",
    decimals: 6,
    storkFeedId: "0x7416a56f222e196d0487dce8a1a8003936862e7a15092a91898d69fa8bce290c", // keccak256("USDCUSD")
    status: "active",
    note: "Ecosystem debt asset (6 decimals) — priced by the Testnet/Demo Base Chainlink relay; Stork USDCUSD is the production feed",
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
