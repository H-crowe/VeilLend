/**
 * Deterministic-signature assumption test (isolated — no recovery code).
 *
 * Verifies: same EVM account + same canonical EIP-191 challenge, signed from
 * INDEPENDENT OS processes (simulating different sessions/pages) yields
 * IDENTICAL signature bytes. Also negative-controls: a different challenge
 * must produce different bytes, and the signature must recover to the
 * signing address.
 *
 * Uses viem's local-account signer (demo's signing stack — @noble/curves,
 * RFC6979 deterministic k). The real injected-wallet check is the browser
 * sig-test page; this file proves the software-key class deterministically.
 *
 * Run: npm test -- (or node --import tsx --test tests/signature-determinism.test.mts)
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { createRequire } from "node:module";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const require = createRequire(import.meta.url);
const { signMessage } = await import("viem/accounts");
const { verifyMessage } = await import("viem");

// The wallet used by the demo's automated flows (same account as the
// testnet deployer). The PRIVATE KEY is read from the root .env — never printed.
const ROOT_ENV = path.join(__dirname, "..", "..", ".env");
const envLine = require("fs").readFileSync(ROOT_ENV, "utf8").split(/\r?\n/).find((l: string) => l.startsWith("HORIZEN_TESTNET_PRIVATE_KEY="));
if (!envLine) throw new Error("no HORIZEN_TESTNET_PRIVATE_KEY in root .env");
const PK = envLine.split("=")[1].trim() as `0x${string}`;
const ADDRESS = (() => {
  // derive public address without printing the key
  const { privateKeyToAccount } = require("viem/accounts");
  return privateKeyToAccount(PK).address.toLowerCase();
})();

// Canonical EIP-191 challenge — exactly the format of the recovery design draft
function challenge(recoveryIdHex: string): string {
  return [
    "VeilLend Recovery V1",
    "This signature encrypts your private lending state backup.",
    `Wallet: ${ADDRESS}`,
    `Recovery ID: ${recoveryIdHex}`,
    "Chain ID: 2651420",
    "",
    "Only sign in the VeilLend demo app.",
  ].join("\n");
}

const RID = "a".repeat(64); // fixed recovery id for the determinism check

test("same account + same challenge, 4 independent signing sessions -> identical bytes", async () => {
  const sessions: string[] = [];

  // session 1..3: fully independent child processes (fresh module graph each)
  const child = path.join(__dirname, "sig-child.mts");
  for (let i = 0; i < 3; i++) {
    const out = execFileSync(process.execPath, ["--import", "tsx", child, ADDRESS, RID], { encoding: "utf8", env: { ...process.env, VL_TEST_PK: PK } });
    sessions.push(out.trim());
  }
  // session 4: signed in THIS process (a different module instance)
  sessions.push(await signMessage({ message: challenge(RID), privateKey: PK }));

  assert.equal(sessions.length, 4);
  assert.equal(new Set(sessions).size, 1, "signatures differed across sessions");
  assert.equal(sessions[0].length, 132, "65-byte signature expected as 0x + 132 hex");
  console.log("    signature digest (sha256 truncated):", sessions[0].slice(0, 20) + "…");
  // recovery binds the signature to the signing address
  assert.equal((await verifyMessage({ address: ADDRESS, message: challenge(RID), signature: sessions[0] as `0x${string}` })), true);
});

test("different challenge (different Recovery ID) -> different bytes", async () => {
  const a = await signMessage({ message: challenge(RID), privateKey: PK });
  const b = await signMessage({ message: challenge("b".repeat(64)), privateKey: PK });
  assert.notEqual(a, b);
});

test("different wallet -> different bytes for the same challenge", async () => {
  const { generatePrivateKey } = await import("viem/accounts");
  const other = await signMessage({ message: challenge(RID), privateKey: generatePrivateKey() });
  const mine = await signMessage({ message: challenge(RID), privateKey: PK });
  assert.notEqual(other, mine);
  // and the other wallet's signature does NOT verify against our address
  assert.equal(await verifyMessage({ address: ADDRESS, message: challenge(RID), signature: other as `0x${string}` }), false);
});
