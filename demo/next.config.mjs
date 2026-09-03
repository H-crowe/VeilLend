/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  webpack: (config) => {
    // snarkjs is loaded as a browser UMD bundle from /public — exclude from bundling
    config.externals = config.externals || [];
    config.resolve.fallback = { ...config.resolve.fallback, fs: false, path: false, crypto: false };
    // The demo only uses the injected connector. wagmi's connector barrel
    // pulls the Coinbase SDK chain which requires optional deps we do not
    // ship — stub them out.
    config.resolve.alias = {
      ...config.resolve.alias,
      "@x402/evm": false,
      "@coinbase/cdp-sdk": false,
      "@walletconnect/universal-provider": false,
      "@walletconnect/ethereum-provider": false,
    };
    return config;
  },
};

export default nextConfig;
