"use client";

import { WagmiProvider, createConfig, http } from "wagmi";
import { injected } from "wagmi/connectors";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { ReactNode } from "react";
import { horizenTestnet } from "../lib/chains";

export const wagmiConfig = createConfig({
  chains: [horizenTestnet],
  connectors: [injected({ shimDisconnect: true })],
  transports: { [horizenTestnet.id]: http("https://horizen-testnet.rpc.caldera.xyz/http") },
  // Required for Next.js App Router: during the hydration render wagmi must
  // return the server snapshot (disconnected) rather than connector state
  // restored from localStorage, otherwise the hydration render cannot match
  // the server HTML.
  ssr: true,
});

const queryClient = new QueryClient();

export function Providers({ children }: { children: ReactNode }) {
  return (
    <WagmiProvider config={wagmiConfig}>
      <QueryClientProvider client={queryClient}>{children}</QueryClientProvider>
    </WagmiProvider>
  );
}
