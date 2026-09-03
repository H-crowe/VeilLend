// Child signing process — prints ONLY the signature (the key comes via argv
// from the parent test and is never printed).
import { signMessage } from "viem/accounts";

const [address, recoveryId] = process.argv.slice(2);
const pk = process.env.VL_TEST_PK ?? process.argv[3];
const challenge = [
  "VeilLend Recovery V1",
  "This signature encrypts your private lending state backup.",
  `Wallet: ${address}`,
  `Recovery ID: ${recoveryId}`,
  "Chain ID: 2651420",
  "",
  "Only sign in the VeilLend demo app.",
].join("\n");

process.stdout.write(await signMessage({ message: challenge, privateKey: pk as `0x${string}` }));
