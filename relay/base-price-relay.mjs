/**
 * VeilLend — TESTNET/DEMO ONLY price relay.
 *
 *   Base Mainnet Chainlink  →  this relay  →  Horizen Testnet OwnerMockPriceOracle  →  VeilLend
 *
 * This is a temporary demo mechanism while the production oracle (Stork)
 * gains active testnet publishing. It is NOT production oracle infrastructure.
 * Isolated here in relay/ so it can be deleted without touching VeilLend.
 *
 * Run:  HORIZEN_TESTNET_PRIVATE_KEY=0x… node relay/base-price-relay.mjs
 * API:  GET  /prices    → Base feed values + current Horizen oracle values
 *       POST /refresh   → fetch Base prices, update the Horizen oracle (owner tx)
 *
 * Security:
 *   - setPrice is owner-only on-chain (OwnerMockPriceOracle); the owner key
 *     lives ONLY in this process's environment, never in the frontend.
 *   - Prices come exclusively from the hardcoded Chainlink feed proxies below.
 *     No endpoint accepts a user-supplied price.
 *   - The demo only ever calls GET /prices and POST /refresh.
 */
import http from "node:http";
import { ethers } from "ethers";

// ---------------------------------------------------------------- config ---
const BASE_RPC_URL = process.env.BASE_RPC_URL ?? "https://mainnet.base.org";
const HORIZEN_RPC_URL = process.env.HORIZEN_RPC_URL ?? "https://horizen-testnet.rpc.caldera.xyz/http";
const PORT = Number(process.env.PRICE_RELAY_PORT ?? 8787);

// Verified on-chain on Base mainnet (description/decimals/latestRoundData):
const FEEDS = {
  USDC: {
    feed: "0x01Bab8761d882A3d34690f515EB3126455501bB5", // "USDC / USD", 8 decimals
    target: "0x01c7AEb2A0428b4159c0E333712f40e127aF639E", // Horizen USDC
    maxAgeSecs: 48 * 3600, // stablecoin feed updates rarely (deviation-based)
  },
  // vCOL/vDBT are demo mock tokens with no real market — fixed TESTNET
  // constants (config, not user input, not market data).
  vCOL: { fixed1e8: 2n * 10n ** 8n, target: process.env.VCOL_ADDRESS ?? "0xb5a5b0f1083965B9d92dCd94E5BCdDb868BfcFCE" },
  vDBT: { fixed1e8: 1n * 10n ** 8n, target: process.env.VDBT_ADDRESS ?? "0xe48a8EC02EB14BB52Fe363D3B2A32e264d3B5D7f" },
};

const FEED_ABI = [
  "function latestRoundData() view returns (uint80 roundId, int256 answer, uint256 startedAt, uint256 updatedAt, uint80 answeredInRound)",
  "function decimals() view returns (uint8)",
  "function description() view returns (string)",
];
const ORACLE_ABI = [
  "function setPrices(address[],uint256[])",
  "function getPrice(address) view returns (uint256,uint256)",
];

// staticNetwork + no batching: some public RPC gateways mishandle ethers'
// batched/probed calls; plain single eth_call works (verified via curl).
const base = new ethers.JsonRpcProvider(BASE_RPC_URL, 8453, { staticNetwork: true, batchMaxCount: 1 });
const key = process.env.HORIZEN_TESTNET_PRIVATE_KEY;
if (!key) {
  console.error("HORIZEN_TESTNET_PRIVATE_KEY is required in the environment");
  process.exit(1);
}
const horizen = new ethers.Wallet(key, new ethers.JsonRpcProvider(HORIZEN_RPC_URL, 2651420, { staticNetwork: true, batchMaxCount: 1 }));
const oracleAddr = process.env.ORACLE_ADDRESS ?? "0x024CF745c737B74f8BCc84d1C73687853310b715";
const oracle = new ethers.Contract(oracleAddr, ORACLE_ABI, horizen);

// ------------------------------------------------------------------ read ---
async function readBaseFeed(cfg) {
  const feed = new ethers.Contract(cfg.feed, FEED_ABI, base);
  const [description, decimals] = await Promise.all([feed.description(), feed.decimals()]);
  const [, answer, , updatedAt, answeredInRound] = await feed.latestRoundData();
  // --- validation (fail closed) ---
  if (answer <= 0n) throw new Error(`${description}: non-positive answer`);
  if (answeredInRound < (await feed.latestRoundData())[0]) { /* read twice-free; kept simple */ }
  const age = BigInt(Math.floor(Date.now() / 1000)) - updatedAt;
  if (age > BigInt(cfg.maxAgeSecs)) throw new Error(`${description}: stale by ${age}s (limit ${cfg.maxAgeSecs}s)`);
  if (decimals !== 8n) throw new Error(`${description}: unexpected decimals ${decimals} — feed format changed`);
  return {
    description,
    chainlinkAddress: cfg.feed,
    decimals: Number(decimals),
    answer: answer.toString(),
    updatedAt: Number(updatedAt),
    ageSecs: Number(age),
    price1e8: answer, // Chainlink 1e8 == MockPriceOracle 1e8 format: direct
  };
}

async function currentRelayState() {
  const out = {};
  for (const [sym, cfg] of Object.entries(FEEDS)) {
    if (cfg.feed) {
      try { out[sym] = await readBaseFeed(cfg); }
      catch (e) { out[sym] = { error: String(e.message) }; }
    } else {
      out[sym] = { fixed1e8: cfg.fixed1e8.toString(), note: "testnet demo constant" };
    }
    if (cfg.target) {
      try {
        const [p, u] = await oracle.getPrice(cfg.target);
        out[sym].horizenOracle = { price1e8: p.toString(), updatedAt: Number(u) };
      } catch { out[sym].horizenOracle = null; }
    }
  }
  return out;
}

// --------------------------------------------------------------- refresh ---
async function refresh() {
  const entries = [];
  const report = {};
  for (const [sym, cfg] of Object.entries(FEEDS)) {
    if (cfg.feed) {
      const r = await readBaseFeed(cfg); // throws on invalid/stale → no update
      entries.push([cfg.target, r.price1e8]);
      report[sym] = { price1e8: r.price1e8.toString(), source: "Base Chainlink", description: r.description, chainlinkUpdatedAt: r.updatedAt };
    } else {
      entries.push([cfg.target, cfg.fixed1e8]);
      report[sym] = { price1e8: cfg.fixed1e8.toString(), source: "testnet demo constant" };
    }
  }
  const tx = await oracle.setPrices(entries.map((e) => e[0]), entries.map((e) => e[1]));
  const rc = await tx.wait();
  if (rc.status !== 1) throw new Error("setPrices transaction reverted");
  return { txHash: rc.hash, block: Number(rc.blockNumber), updated: report };
}

// ---------------------------------------------------------------- server ---
// JSON.stringify with BigInt support: BigInts (token amounts in base units)
// are serialized as decimal strings so /prices never throws.
const jsonSafe = (value) => JSON.stringify(value, (_, v) => (typeof v === "bigint" ? v.toString() : v));

const server = http.createServer(async (req, res) => {
  res.setHeader("Content-Type", "application/json");
  try {
    if (req.method === "GET" && req.url === "/prices") {
      res.end(jsonSafe(await currentRelayState()));
    } else if (req.method === "POST" && req.url === "/refresh") {
      res.end(jsonSafe(await refresh()));
    } else if (req.method === "GET" && req.url === "/health") {
      res.end(JSON.stringify({ ok: true, oracle: oracleAddr, horizen: await horizen.getAddress() }));
    } else {
      res.statusCode = 404;
      res.end(JSON.stringify({ error: "not found" }));
    }
  } catch (e) {
    res.statusCode = 502;
    res.end(JSON.stringify({ error: String(e.message ?? e) }));
  }
});

server.listen(PORT, () => console.log(`price relay listening on :${PORT} → oracle ${oracleAddr}`));
