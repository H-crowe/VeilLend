import { defineChain } from "viem";

/** Horizen Testnet — the target network for the VeilLend demo. */
export const horizenTestnet = defineChain({
  id: 2651420,
  name: "Horizen Testnet",
  nativeCurrency: { name: "ETH", symbol: "ETH", decimals: 18 },
  rpcUrls: { default: { http: ["https://horizen-testnet.rpc.caldera.xyz/http"] } },
  blockExplorers: {
    default: { name: "Horizen Testnet Explorer", url: "https://explorer-testnet.horizen.io" },
  },
  testnet: true,
});

export const explorerTx = (hash: string) => `${horizenTestnet.blockExplorers.default.url}/tx/${hash}`;
export const explorerAddress = (addr: string) => `${horizenTestnet.blockExplorers.default.url}/address/${addr}`;
