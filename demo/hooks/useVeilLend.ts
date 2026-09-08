"use client";

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import { getWalletClient as getWagmiWalletClient } from "@wagmi/core";
import { decodeAbiParameters, encodeFunctionData, getAddress, type Address } from "viem";
import { horizenTestnet, explorerTx } from "../lib/chains";
import { ADDRESSES, ASSETS } from "../lib/contracts/addresses";
import { veilLendAbi, tokenAbi, oracleAbi } from "../lib/contracts/abis";
import {
  ACTION_BORROW, ACTION_DEPOSIT, ACTION_WITHDRAW, ceilDiv, randomSecret,
  buildLiquidationWitness, buildRiskTransition, buildTransition,
  computeCommitment, isLiquidatable, makeInitialState,
  type PrivateState, type LiquidationParams,
} from "../lib/zk/witness";
import type { CircuitName } from "../lib/zk/snarkjs";
import { assertReceiptSuccess } from "../lib/tx/receipt";
import { deserializeState, serializeState, listPositions, savePosition, getPosition, saveLastSelected, getLastSelected, type StoredPosition } from "../lib/state/store";
import { wagmiConfig } from "../app/providers";

const WAD = 10n ** 18n;
const PRICE_SCALE = 10n ** 8n;
const BPS = 10000n;
const RISK_PARAMS = { collateralPrice: 2n * PRICE_SCALE, debtPrice: 1n * PRICE_SCALE, maxLtvBps: 7500n };

export type ActionKind = "create" | "deposit" | "borrow" | "repay" | "withdraw" | "liquidate";

export interface TxState {
  status: "idle" | "preparing" | "proving" | "submitting" | "wallet" | "confirming" | "confirmed" | "failed";
  label?: string;
  txHash?: string;
  block?: number;
  gasUsed?: string;
  explorerUrl?: string;
  error?: string;
  proofVerified?: boolean;
  /** Set when the transaction itself succeeded but a post-confirmation UI
   *  state refresh failed. The transaction result is never downgraded. */
  softWarning?: string;
}

export interface RelayedPrice {
  symbol: string;
  price1e8: string;
  source: string;
  chainlinkUpdatedAt?: number;
  horizenUpdatedAt?: number;
}

export interface OnChainPosition {
  collateralAsset: string;
  debtAsset: string;
  activeCommitment: string;
  interestIndex: bigint;
  sequence: bigint;
  status: number;
  supported: bigint;
  outstanding: bigint;
}

/** TransitionInputs struct expected by the deployed contract (9 public fields). */
function toTransitionInputs(ps: string[]) {
  const p = ps.map((v) => BigInt(v));
  return {
    positionId: p[0], oldCommitment: p[1], newCommitment: p[2], nullifier: p[3],
    actionId: p[4], newSequence: p[5], currentIndexLo: p[6], currentIndexHi: p[7], publicAmount: p[8],
  };
}

export function useVeilLend() {
  const { address, isConnected, chainId, connector: connectedConnector } = useAccount();
  const onHorizen = chainId === horizenTestnet.id;
  const publicClient = usePublicClient();
  const { connect, connectors } = useConnect();
  const { switchChain } = useSwitchChain();
  const { data: walletClientData } = useWalletClient();

  const [snarkReady, setSnarkReady] = useState(false);
  const [positions, setPositions] = useState<StoredPosition[]>([]);
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [onChain, setOnChain] = useState<OnChainPosition | null>(null);
  const [tx, setTx] = useState<TxState>({ status: "idle" });

  useEffect(() => {
    const t = setInterval(() => setSnarkReady(!!(window as unknown as { snarkjs?: unknown }).snarkjs), 300);
    const stop = setTimeout(() => clearInterval(t), 10000);
    return () => { clearInterval(t); clearTimeout(stop); };
  }, []);

  const refreshPositions = useCallback(() => {
    if (!address) { setPositions([]); return; }
    setPositions(listPositions(address));
  }, [address]);

  useEffect(() => { refreshPositions(); }, [address, refreshPositions]);

  /**
   * Persisted selection: which position the user last had open. Survives
   * browser refreshes (the raw selection is otherwise transient React state
   * and the UI would render as a fresh session). `null` clears the entry.
   */
  const selectPosition = useCallback((id: string | null) => {
    setSelectedId(id);
    if (address) saveLastSelected(address, id);
  }, [address]);

  // Restore the saved selection once per wallet, only when that position
  // still exists in the freshly loaded list; never overrides an existing
  // selection and never auto-picks a position that was not selected before.
  const restoredSelectionFor = useRef<string | null>(null);
  useEffect(() => {
    if (!address) { restoredSelectionFor.current = null; return; }
    if (restoredSelectionFor.current === address) return;
    if (positions.length === 0) return; // not loaded yet (or no positions)
    restoredSelectionFor.current = address;
    if (selectedId !== null) return;
    const saved = getLastSelected(address);
    if (saved && positions.some((p) => p.positionId === saved)) setSelectedId(saved);
  }, [address, positions, selectedId]);

  // Bumped after every SUCCESSFUL transition save so the selectedState memo
  // re-reads localStorage in the same session (selectedId does not change on
  // deposit/repay/borrow/withdraw, so the memo would otherwise keep serving
  // the pre-transition state for the rest of the session).
  const [stateVersion, setStateVersion] = useState(0);

  const selectedState: PrivateState | null = useMemo(() => {
    if (!address || !selectedId) return null;
    const stored = getPosition(address, BigInt(selectedId));
    return stored ? deserializeState(stored.state) : null;
  }, [address, selectedId, stateVersion]);

  const readOnChainPosition = useCallback(async (positionId: bigint): Promise<OnChainPosition | null> => {
    if (!publicClient) return null;
    // viem's readContract returns a positional ARRAY for multi-output ABIs
    // (positions returns a 6-tuple), so decode by position with a named-field
    // fallback. Reading named properties on the array is what previously
    // produced `BigInt(undefined)`.
    const raw = await publicClient.readContract({
      address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "positions", args: [positionId],
    }) as unknown;
    const f: unknown[] = Array.isArray(raw)
      ? raw
      : Object.values((raw ?? {}) as Record<string, unknown>);
    const [collateralAsset, debtAsset, activeCommitment, interestIndex, sequence, status] = f as [string, string, string, bigint, bigint | number, bigint | number];
    const [supported, outstanding] = await Promise.all([
      publicClient.readContract({ address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "supportedCollateral", args: [positionId] }) as Promise<bigint>,
      publicClient.readContract({ address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "borrowOutstanding", args: [positionId] }) as Promise<bigint>,
    ]);
    if (Number(status) === 0) return null;
    return {
      collateralAsset, debtAsset,
      activeCommitment, interestIndex: BigInt(interestIndex),
      sequence: BigInt(sequence), status: Number(status),
      supported: BigInt(supported), outstanding: BigInt(outstanding),
    };
  }, [publicClient]);

  const refreshOnChain = useCallback(async () => {
    if (!address || !selectedId) { setOnChain(null); return; }
    try { setOnChain(await readOnChainPosition(BigInt(selectedId))); } catch { setOnChain(null); }
  }, [address, selectedId, readOnChainPosition]);

  /**
   * Post-confirmation state refresh. Runs only after the transaction has
   * already been marked `confirmed`; any failure here is surfaced as a soft
   * warning and must never flip the result back to `failed`.
   */
  const refreshAfterSuccess = useCallback(async () => {
    try {
      await refreshOnChain();
      refreshPositions();
    } catch {
      setTx((t) => t.status === "confirmed"
        ? { ...t, softWarning: "Transaction confirmed on-chain. A background UI refresh failed — this does not affect the transaction or your saved state." }
        : t);
    }
  }, [refreshOnChain, refreshPositions]);

  useEffect(() => { void refreshOnChain(); }, [address, selectedId, tx.status, refreshOnChain]);

  /**
   * Wallet balances for the ASSETS registry (vCOL/vDBT/WETH/USDC; ZEN has no
   * address). Read-only display alongside the active pair — WETH/USDC feed
   * in via Stork once the Stork-backed deployment activates them.
   */
  const [assetBalances, setAssetBalances] = useState<Record<string, bigint>>({});
  const refreshAssetBalances = useCallback(async () => {
    if (!publicClient || !address) { setAssetBalances({}); return; }
    const entries = await Promise.all(ASSETS.filter((a) => a.address !== "").map(async (a) => {
      try {
        const bal = (await publicClient.readContract({
          address: a.address as Address, abi: tokenAbi,
          functionName: "balanceOf", args: [address],
        })) as bigint;
        return [a.symbol, bal] as const;
      } catch {
        return [a.symbol, 0n] as const; // contract absent/none there — show 0
      }
    }));
    setAssetBalances(Object.fromEntries(entries));
  }, [publicClient, address]);
  useEffect(() => { void refreshAssetBalances(); }, [refreshAssetBalances, tx.status]);

  const oraclePrices = useCallback(async (collateralAddr?: string, debtAddr?: string) => {
    if (!publicClient) throw new Error("no RPC");
    // IPriceOracle is the single source of truth (IPriceOracle.getPrice):
    // the StorkPriceOracle adapter when configured (production path), or the
    // owner-gated demo oracle fed by the Testnet/Demo Base Chainlink relay
    // (current active testnet source).
    const oracleAddr = (ADDRESSES.storkPriceOracle || ADDRESSES.mockPriceOracle) as Address;
    const colAsset = (collateralAddr ?? ADDRESSES.collateralToken) as Address;
    const debtAsset = (debtAddr ?? ADDRESSES.debtToken) as Address;
    const [col, debt] = (await Promise.all([
      publicClient.readContract({ address: oracleAddr, abi: oracleAbi, functionName: "getPrice", args: [colAsset] }),
      publicClient.readContract({ address: oracleAddr, abi: oracleAbi, functionName: "getPrice", args: [debtAsset] }),
    ])) as [readonly [bigint, bigint], readonly [bigint, bigint]];
    return { collateralPrice: col[0], debtPrice: debt[0] };
  }, [publicClient]);

  /**
   * Resilient wallet-client access. wagmi can transiently report
   * `walletClient === undefined` (e.g. right after a failed tx reconnects
   * the connector) even though a connector IS connected — in that case we
   * re-acquire the client from the connected connector instead of throwing.
   */
  const getWallet = useCallback(async () => {
    if (walletClientData) return walletClientData;
    if (connectedConnector) {
      try {
        // canonical wagmi action: re-acquire the wallet client through the
        // connected connector (handles transient undefined after failures)
        return await getWagmiWalletClient(wagmiConfig, { chainId: horizenTestnet.id, connector: connectedConnector });
      } catch { /* fall through */ }
    }
    throw new Error("wallet not connected");
  }, [walletClientData, connectedConnector]);

  /** ERC20 allowance(user -> VeilLend) per asset symbol. Part of the guided
   *  setup step: actions that pull tokens are blocked until approved. */
  const [allowances, setAllowances] = useState<Record<string, bigint>>({});
  const refreshAllowances = useCallback(async () => {
    if (!publicClient || !address) { setAllowances({}); return; }
    const entries = await Promise.all(ASSETS.filter((a) => a.address !== "").map(async (a) => {
      try {
        const al = (await publicClient.readContract({
          address: a.address as Address, abi: tokenAbi,
          functionName: "allowance", args: [address, ADDRESSES.veilLend as Address],
        })) as bigint;
        return [a.symbol, al] as const;
      } catch { return [a.symbol, 0n] as const; }
    }));
    setAllowances(Object.fromEntries(entries));
  }, [publicClient, address]);
  useEffect(() => { void refreshAllowances(); }, [refreshAllowances, tx.status]);

  /**
   * Approve VeilLend to spend `amount` of `assetAddr` (MaxUint256). Sends the
   * approve transaction only when the current allowance is insufficient.
   * Returns the approve tx hash when an approval was sent, else null.
   */
  const ensureAllowance = useCallback(async (assetAddr: string, amount: bigint): Promise<string | null> => {
    if (!isConnected || !address) throw new Error("wallet not connected");
    const walletClient = await getWallet();
    const current = (await publicClient!.readContract({ address: assetAddr as Address, abi: tokenAbi, functionName: "allowance", args: [address, ADDRESSES.veilLend as Address] })) as bigint;
    if (current >= amount) return null;
    setTx({ status: "wallet" });
    const hash = await walletClient.writeContract({ address: assetAddr as Address, abi: tokenAbi, functionName: "approve", args: [ADDRESSES.veilLend as Address, 2n ** 256n - 1n] });
    setTx((t) => ({ ...t, status: "confirming", txHash: hash }));
    const rec = await publicClient!.waitForTransactionReceipt({ hash });
    assertReceiptSuccess(rec.status, hash);
    await refreshAllowances();
    return hash;
  }, [getWallet, isConnected, address, publicClient, refreshAllowances]);

  /** Mint any mock testnet asset. WETH is wrapped from chain ETH instead. */
  const mintAsset = useCallback(async (symbol: string, amount: bigint) => {
    if (!isConnected || !address) throw new Error("wallet not connected");
    const walletClient = await getWallet();
    const entry = ASSETS.find((a) => a.symbol === symbol);
    if (!entry || entry.address === "") throw new Error("unknown asset " + symbol);
    setTx({ status: "wallet" });
    let hash: `0x${string}`;
    if (symbol === "WETH") {
      hash = await walletClient.writeContract({ address: entry.address as Address, abi: tokenAbi, functionName: "deposit", args: [], value: amount });
    } else {
      hash = await walletClient.writeContract({ address: entry.address as Address, abi: tokenAbi, functionName: "mint", args: [address, amount] });
    }
    setTx((t) => ({ ...t, status: "confirming", txHash: hash }));
    const rec = await publicClient!.waitForTransactionReceipt({ hash });
    assertReceiptSuccess(rec.status, hash);
    setTx({ status: "confirmed", txHash: hash, explorerUrl: explorerTx(hash), proofVerified: false });
    await refreshAssetBalances();
  }, [getWallet, isConnected, address, publicClient, refreshAssetBalances]);


  /**
   * Risk actions (borrow/withdraw/liquidate) read prices with an on-chain
   * freshness check — a stale mock-oracle price makes them revert with
   * StalePrice. Detect it here first so the user gets an actionable message
   * instead of a reverted transaction.
   */
  const ensureFreshPrices = useCallback(async (collateralAddr?: string, debtAddr?: string) => {
    if (!publicClient) throw new Error("no RPC");
    const oracleAddr = (ADDRESSES.storkPriceOracle || ADDRESSES.mockPriceOracle) as Address;
    const colAsset = (collateralAddr ?? ADDRESSES.collateralToken) as Address;
    const debtAsset = (debtAddr ?? ADDRESSES.debtToken) as Address;
    const [block, staleness, col, debt] = (await Promise.all([
      publicClient.getBlock(),
      publicClient.readContract({ address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "maxPriceStaleness" }) as Promise<bigint>,
      publicClient.readContract({ address: oracleAddr, abi: oracleAbi, functionName: "getPrice", args: [colAsset] }) as Promise<readonly [bigint, bigint]>,
      publicClient.readContract({ address: oracleAddr, abi: oracleAbi, functionName: "getPrice", args: [debtAsset] }) as Promise<readonly [bigint, bigint]>,
    ]));
    const limit = Number(staleness);
    const stale = (u: bigint) => Number(block.timestamp) - Number(u) > limit;
    if (stale(col[1]) || stale(debt[1])) {
      throw new Error(ADDRESSES.storkPriceOracle
        ? "Oracle prices are stale — use 'Push fresh oracle prices' to relay a Stork update, then retry."
        : "Oracle prices are stale — use the 'Refresh Prices' action (Testnet/Demo Base Chainlink relay), then retry.");
    }
  }, [publicClient]);

  /**
   * TESTNET/DEMO ONLY price source: the isolated Base-Chainlink relay
   * (relay/base-price-relay.mjs) reads real Chainlink ETH/USD and USDC/USD
   * on Base mainnet and updates the owner-gated OwnerMockPriceOracle with
   * the deployer key (server-side only). The demo never touches a private
   * key and never submits a price — it only asks the relay to refresh and
   * displays the result.
   *
   * Production oracle path (Stork): the deployed StorkPriceOracle adapter +
   * pushOracleUpdate remain intact; switch ADDRESSES.storkPriceOracle when
   * Stork testnet publishing goes live.
   */
  const priceRelayUrl = process.env.NEXT_PUBLIC_PRICE_RELAY_URL ?? "http://localhost:8787";

  const fetchRelayPrices = useCallback(async (): Promise<RelayedPrice[]> => {
    const res = await fetch(`${priceRelayUrl}/prices`);
    if (!res.ok) throw new Error(`price relay unreachable (${res.status}) — start it with: node relay/base-price-relay.mjs`);
    const body = (await res.json()) as Record<string, { price1e8?: string; chainlinkUpdatedAt?: number; horizenOracle?: { updatedAt?: number } | null; source?: string }>;
    return ["WETH", "USDC"].map((sym) => ({
      symbol: sym,
      price1e8: body[sym]?.price1e8 ?? "0",
      source: body[sym]?.source ?? "",
      chainlinkUpdatedAt: body[sym]?.chainlinkUpdatedAt,
      horizenUpdatedAt: body[sym]?.horizenOracle?.updatedAt,
    }));
  }, [priceRelayUrl]);

  const [relayedPrices, setRelayedPrices] = useState<RelayedPrice[]>([]);
  // Surfaced so the Price panel can explain "…" instead of silently failing
  // when the isolated relay service (relay/base-price-relay.mjs) isn't running.
  const [relayUnreachable, setRelayUnreachable] = useState(false);

  const refreshOraclePrices = useCallback(async () => {
    if (!isConnected || !address) throw new Error("wallet not connected");
    setTx({ status: "preparing" });
    try {
      const res = await fetch(`${priceRelayUrl}/refresh`, { method: "POST" });
      const body = (await res.json()) as { txHash?: string; error?: string };
      if (!res.ok || !body.txHash) throw new Error(body.error ?? `price relay refresh failed (${res.status})`);
      setTx({ status: "confirmed", txHash: body.txHash, explorerUrl: explorerTx(body.txHash), proofVerified: false });
      setRelayUnreachable(false);
      setRelayedPrices(await fetchRelayPrices().catch(() => []));
    } catch (e) {
      // The relay is down or errored — never leave the tx spinner stuck on
      // "preparing"; surface a user-friendly failure instead (operator-facing
      // runbook details stay out of the UI).
      setTx({
        status: "failed",
        error: `Prices unavailable — the testnet price relay is currently offline, so prices could not be refreshed (${e instanceof Error ? e.message : String(e)})`,
      });
    }
  }, [isConnected, address, priceRelayUrl, fetchRelayPrices]);

  useEffect(() => {
    void fetchRelayPrices()
      .then((p) => { setRelayedPrices(p); setRelayUnreachable(false); })
      .catch(() => setRelayUnreachable(true));
  }, [fetchRelayPrices, tx.status]);

  const fail = useCallback((rawErr: unknown): never => {
    const raw = rawErr instanceof Error ? rawErr.message : String(rawErr);
    let msg = raw;
    // Decode revert data carried by provider/wallet errors (viem/ethers wrap
    // it in err.data / err.info.error.data depending on the layer).
    const eAny = rawErr as { data?: string; info?: { error?: { data?: string } } };
    const revertData = eAny?.data ?? eAny?.info?.error?.data;
    if (typeof revertData === "string" && revertData.startsWith("0x") && revertData.length >= 10) {
      const sel = revertData.slice(0, 10);
      const args = "0x" + revertData.slice(10);
      try {
        const dec = decodeAbiParameters([{ type: "address" }, { type: "uint256" }, { type: "uint256" }], args as `0x${string}`);
        if (sel === "0xfb8f41b2") msg = "Token approval missing — approve the token first (allowance " + dec[1].toString() + " < needed " + dec[2].toString() + "). Use the Approve button in Setup.";
        if (sel === "0xe450d38c") msg = "Token balance too low (have " + dec[1].toString() + ", needed " + dec[2].toString() + "). Mint or top up the asset in Setup first.";
      } catch { /* not this error shape */ }
    }
    if (/Chain.*mismatch|chainId|wrong network/i.test(raw)) msg = "Wrong network — switch to Horizen Testnet";
    else if (/User rejected|denied/i.test(raw)) msg = "Transaction rejected in wallet";
    else if (/insufficient funds|exceeds balance|insufficient balance/i.test(raw)) msg = "Insufficient testnet balance";
    else if (/PositionNotActive|PositionNotFound/i.test(raw)) msg = "Position is not active";
    else if (/UnsupportedCollateral/i.test(raw)) msg = "Amount exceeds the position's supported collateral";
    else if (/BorrowCapExceeded/i.test(raw)) msg = "Borrow exceeds the position's supported borrow cap";
    else if (/InsufficientLiquidity/i.test(raw)) msg = "Insufficient protocol liquidity for this borrow";
    else if (/StalePrice|StaleIndex/i.test(raw)) msg = "Oracle data is stale — try again";
    else if (/InvalidProof|Assert Failed|witness/i.test(raw)) msg = "Proof generation or verification failed";
    else if (/TransitionConsumed/i.test(raw)) msg = "Replay detected — this proof was already used";
    else if (/UnsupportedAction/i.test(raw)) msg = "This action is not available yet";
    // A transaction that already reached `confirmed` must never be displayed
    // as failed — a late post-confirmation error is a UI refresh problem,
    // not an on-chain failure.
    setTx((t) => {
      if (t.status === "confirmed") {
        return { ...t, softWarning: "Transaction confirmed on-chain. A background UI refresh failed — this does not affect the transaction or your saved state." };
      }
      return { status: "failed", error: msg, label: raw.slice(0, 140) };
    });
    throw rawErr;
  }, []);

  const proveAndSubmit = useCallback(async (
    fnName: string,
    circuit: CircuitName,
    publicSignals: string[],
    inputs: Record<string, string>,
    walletClient: NonNullable<typeof walletClientData>,
    extraArgs?: { collateralOut: bigint; debtOut: bigint }
  ) => {
    setTx((t) => ({ ...t, status: "proving" }));
    const { generateProof } = await import("../lib/zk/snarkjs");
    const proof = await generateProof(inputs, circuit);
    setTx((t) => ({ ...t, status: "submitting", proofVerified: true }));
    setTx((t) => ({ ...t, status: "wallet" }));
    if (!walletClient) throw new Error("wallet not connected");
    const args = toTransitionInputs(publicSignals);
    const callArgs: unknown[] = extraArgs
      ? [extraArgs.collateralOut, extraArgs.debtOut, proof.callArgs.pA, proof.callArgs.pB, proof.callArgs.pC]
      : [args, proof.callArgs.pA, proof.callArgs.pB, proof.callArgs.pC];
    const hash = await walletClient.writeContract({
      address: ADDRESSES.veilLend as Address, abi: veilLendAbi,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      functionName: fnName as any,
      args: callArgs as never,
    });
    setTx((t) => ({ ...t, status: "confirming", txHash: hash }));
    const rec = await publicClient!.waitForTransactionReceipt({ hash });
    // viem resolves with the receipt even for MINED-AND-REVERTED transactions.
    // Fail closed here: the callers below persist the new private state only
    // after this guard passes, so a reverted transaction can never advance
    // the local witness state past the on-chain commitment chain.
    assertReceiptSuccess(rec.status, hash);
    return { hash, block: Number(rec.blockNumber), gasUsed: rec.gasUsed.toString() };
  }, [publicClient]);

  const runAction = useCallback(async (kind: ActionKind, amt: bigint | null, pair?: { collateral: string; debt: string }) => {
    if (!isConnected || !address || !publicClient) throw new Error("wallet not connected");
    const walletClient = await getWallet();
    // Asset pair for this action. `create` uses the UI-selected pair; all
    // other actions derive the pair from the position's own private state
    // (assets are fixed at position creation), so a WETH/USDC position uses
    // WETH/USDC prices and indices regardless of the dropdowns.
    const collateralAddr = kind === "create" && pair ? pair.collateral : (selectedState ? getAddress("0x" + selectedState.collateralAsset.toString(16).padStart(40, "0")) : ADDRESSES.collateralToken);
    const debtAddr = kind === "create" && pair ? pair.debt : (selectedState ? getAddress("0x" + selectedState.debtAsset.toString(16).padStart(40, "0")) : ADDRESSES.debtToken);
    setTx({ status: "preparing" });
    try {
      // ---------- create ----------
      if (kind === "create") {
        const nextId = (await publicClient.readContract({ address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "nextPositionId" })) as bigint;
        const positionId = nextId + 1n;
        const currentIndex = (await publicClient.readContract({ address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "currentDebtIndex", args: [debtAddr as Address] })) as bigint;
        const st = makeInitialState({ positionId, collateralAsset: BigInt(collateralAddr), debtAsset: BigInt(debtAddr), currentIndex });
        const c0 = await computeCommitment(st);
        setTx((t) => ({ ...t, status: "submitting" }));
        setTx((t) => ({ ...t, status: "wallet" }));
        const hash = await walletClient.writeContract({
          address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "createPosition",
          args: [collateralAddr as Address, debtAddr as Address, bytes32(c0)],
        });
        setTx((t) => ({ ...t, status: "confirming", txHash: hash }));
        const rec = await publicClient.waitForTransactionReceipt({ hash });
        // Persist the private state BEFORE any post-confirmation read: the
        // control secret exists only here until saved, and losing it would
        // permanently orphan the on-chain position.
        savePosition(address, { positionId: positionId.toString(), state: serializeState(st), createdAt: new Date().toISOString() });
        refreshPositions();
        selectPosition(positionId.toString());
        // Verification of the created position is best-effort: a failure here
        // is a UI refresh problem, never a transaction failure.
        try {
          const on = await readOnChainPosition(positionId);
          if (!on || on.activeCommitment !== bytes32(c0)) {
            setTx({ status: "confirmed", txHash: hash, block: Number(rec.blockNumber), gasUsed: rec.gasUsed.toString(), explorerUrl: explorerTx(hash), proofVerified: false, softWarning: "Position created and private state saved. Could not verify the on-chain position state — reload to refresh." });
            return;
          }
        } catch {
          setTx({ status: "confirmed", txHash: hash, block: Number(rec.blockNumber), gasUsed: rec.gasUsed.toString(), explorerUrl: explorerTx(hash), proofVerified: false, softWarning: "Position created and private state saved. Could not read the on-chain position state — reload to refresh." });
          return;
        }
        setTx({ status: "confirmed", txHash: hash, block: Number(rec.blockNumber), gasUsed: rec.gasUsed.toString(), explorerUrl: explorerTx(hash), proofVerified: false });
        return;
      }

      const selectedIdStr = selectedId;
      if (!selectedIdStr) throw new Error("no position selected — create or import one");
      const positionId = BigInt(selectedIdStr);
      const st = selectedState;
      if (!st) throw new Error("The private state for this position is not in this browser");
      const currentIndex = (await publicClient.readContract({ address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "currentDebtIndex", args: [debtAddr as Address] })) as bigint;
      const newSalt = randomSecret();

      // ---------- deposit / repay (state_transition circuit) ----------
      if (kind === "deposit" || kind === "repay") {
        const amount = amt ?? 0n;
        if (amount === 0n) throw new Error("Enter an amount");
        // Token prerequisites: the pulled token is the position's collateral
        // (deposit) or debt (repay) asset — fixed at position creation.
        const pullToken = kind === "deposit" ? collateralAddr : debtAddr;
        const pullSymbol = ASSETS.find((a) => a.address.toLowerCase() === pullToken.toLowerCase())?.symbol ?? "asset";
        if (kind === "repay") {
          const onPos = await readOnChainPosition(positionId);
          const outstanding = onPos ? onPos.outstanding : 0n;
          if (st.debt === 0n && outstanding === 0n) throw new Error("This position has no debt to repay");
        }
        const bal = (await publicClient.readContract({ address: pullToken as Address, abi: tokenAbi, functionName: "balanceOf", args: [address] })) as bigint;
        if (bal < amount) throw new Error(pullSymbol + " balance too low: you hold " + bal + " and this " + kind + " needs " + amount + ". Mint or top up the asset in the Setup step first.");
        await ensureAllowance(pullToken, amount);
        const actionId = kind === "deposit" ? ACTION_DEPOSIT : 2n;
        const t = await buildTransition({ oldState: st, actionId, amount, currentIndex, newSalt });
        const res = await proveAndSubmit(fnFor(kind), "state_transition", t.publicSignals, t.inputs, walletClient);
        const stored = getPosition(address, positionId);
        if (stored) savePosition(address, { ...stored, state: serializeState(t.newState) });
        setStateVersion((v) => v + 1); // in-memory selectedState now reflects the new state
        setTx({ status: "confirmed", txHash: res.hash, block: res.block, gasUsed: res.gasUsed, explorerUrl: explorerTx(res.hash), proofVerified: true });
        await refreshAfterSuccess();
        return;
      }

      // ---------- borrow / withdraw (risk_transition circuit) ----------
      if (kind === "borrow" || kind === "withdraw") {
        const amount = amt ?? 0n;
        if (amount === 0n) throw new Error("Enter an amount");
        await ensureFreshPrices(collateralAddr, debtAddr);
        const prices = await oraclePrices(collateralAddr, debtAddr);
        // Pre-flight the post-action solvency rule the deployed circuit
        // enforces, so an unprovable action fails with a precise message
        // before any proving or wallet interaction. (The withdraw-only
        // amount cap lives in the circuit itself; borrows are governed by
        // LTV here and by the contract's supported-collateral cap on-chain.)
        const accruedPre = ceilDiv(st.debt * currentIndex, st.interestIndex);
        const newDebtPre = kind === "borrow" ? accruedPre + amount : accruedPre;
        const newColPre = kind === "withdraw" ? st.collateral - amount : st.collateral;
        if (kind === "withdraw" && amount > st.collateral) {
          throw new Error("Withdraw amount exceeds this position's hidden collateral");
        }
        if (newColPre * prices.collateralPrice * 10000n < newDebtPre * prices.debtPrice * 7500n) {
          throw new Error("This action would leave the position undercollateralized at current oracle prices (max LTV 75%) — reduce the amount");
        }
        const actionId = kind === "borrow" ? ACTION_BORROW : ACTION_WITHDRAW;
        const t = await buildRiskTransition({
          oldState: st, actionId, amount, currentIndex, newSalt,
          params: { collateralPrice: prices.collateralPrice, debtPrice: prices.debtPrice, maxLtvBps: 7500n },
          recipient: BigInt(address),
        });
        const res = await proveAndSubmit(fnFor(kind), "risk_transition", t.publicSignals, t.inputs, walletClient);
        const stored = getPosition(address, positionId);
        if (stored) savePosition(address, { ...stored, state: serializeState(t.newState) });
        setStateVersion((v) => v + 1); // in-memory selectedState now reflects the new state
        setTx({ status: "confirmed", txHash: res.hash, block: res.block, gasUsed: res.gasUsed, explorerUrl: explorerTx(res.hash), proofVerified: true });
        await refreshAfterSuccess();
        return;
      }

      // ---------- liquidate (liquidation circuit, self-liquidation) ----------
      if (kind === "liquidate") {
        await ensureFreshPrices(collateralAddr, debtAddr);
        const prices = await oraclePrices(collateralAddr, debtAddr);
        const params: LiquidationParams = { collateralPrice: prices.collateralPrice, debtPrice: prices.debtPrice, liquidationThresholdBps: 8500n };
        if (!isLiquidatable(st, params)) throw new Error("Position is not undercollateralized at current oracle prices");
        const w = await buildLiquidationWitness(st, params, BigInt(address));
        const res = await proveAndSubmit("liquidate", "liquidation", w.publicSignals, w.inputs, walletClient, { collateralOut: w.amounts.collateralOut, debtOut: w.amounts.debtOut });
        const stored = getPosition(address, positionId);
        if (stored) savePosition(address, { ...stored, state: serializeState({ ...st, collateral: 0n }) });
        setStateVersion((v) => v + 1); // in-memory selectedState now reflects the new state
        setTx({ status: "confirmed", txHash: res.hash, block: res.block, gasUsed: res.gasUsed, explorerUrl: explorerTx(res.hash), proofVerified: true });
        await refreshAfterSuccess();
        return;
      }
      throw new Error("unknown action");
    } catch (err) {
      fail(err);
    }
  }, [getWallet, address, publicClient, selectedId, selectedState, proveAndSubmit, fail, oraclePrices, ensureFreshPrices, readOnChainPosition, refreshOnChain, refreshPositions, refreshAfterSuccess, selectPosition]);

  const mintTestTokens = useCallback(async (kind: "vCOL" | "vDBT", amount: bigint) => {
    if (!isConnected || !address) throw new Error("wallet not connected");
    const walletClient = await getWallet();
    const token = kind === "vCOL" ? ADDRESSES.collateralToken : ADDRESSES.debtToken;
    setTx({ status: "wallet" });
    const hash = await walletClient.writeContract({ address: token as Address, abi: tokenAbi, functionName: "mint", args: [address, amount] });
    setTx((t) => ({ ...t, status: "confirming", txHash: hash }));
    await publicClient!.waitForTransactionReceipt({ hash });
    setTx({ status: "confirmed", txHash: hash, explorerUrl: explorerTx(hash), proofVerified: false });
  }, [getWallet, address, publicClient]);

  const seedLiquidity = useCallback(async (amount: bigint) => {
    if (!isConnected || !address || !publicClient) throw new Error("wallet not connected");
    const walletClient = await getWallet();
    setTx({ status: "preparing" });
    try {
      // vDBT for the repay must be available
      const bal = await publicClient.readContract({ address: ADDRESSES.debtToken as Address, abi: tokenAbi, functionName: "balanceOf", args: [address] }) as bigint;
      if (bal < amount) await walletClient.writeContract({ address: ADDRESSES.debtToken as Address, abi: tokenAbi, functionName: "mint", args: [address, amount] });
      const allowance = (await publicClient.readContract({ address: ADDRESSES.debtToken as Address, abi: tokenAbi, functionName: "allowance", args: [address, ADDRESSES.veilLend] })) as bigint;
      if (allowance < amount) {
        await walletClient.writeContract({ address: ADDRESSES.debtToken as Address, abi: tokenAbi, functionName: "approve", args: [ADDRESSES.veilLend as Address, 2n ** 256n - 1n] });
      }
      const seedId = (await publicClient.readContract({ address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "nextPositionId" })) as bigint;
      const seedIdNum = seedId + 1n;
      const currentIndex = (await publicClient.readContract({ address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "currentDebtIndex", args: [ADDRESSES.debtToken as Address] })) as bigint;
      const seedState: PrivateState = {
        positionId: seedIdNum, collateralAsset: BigInt(ADDRESSES.collateralToken), debtAsset: BigInt(ADDRESSES.debtToken),
        collateral: 0n, debt: amount, interestIndex: currentIndex, sequence: 0n,
        controlSecret: randomSecret(), salt: randomSecret(),
      };
      await walletClient.writeContract({ address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "createPosition", args: [ADDRESSES.collateralToken as Address, ADDRESSES.debtToken as Address, bytes32(await computeCommitment(seedState))] });
      const t = await buildTransition({ oldState: seedState, actionId: 2n, amount, currentIndex, newSalt: randomSecret() });
      const res = await proveAndSubmit("repay", "state_transition", t.publicSignals, t.inputs, walletClient);
      setTx({ status: "confirmed", txHash: res.hash, block: res.block, gasUsed: res.gasUsed, explorerUrl: explorerTx(res.hash), proofVerified: true });
    } catch (err) {
      fail(err);
    }
  }, [getWallet, address, publicClient, proveAndSubmit, fail]);

  const isEligible: boolean | null = useMemo(() => {
    if (!selectedState || !onChain || onChain.status !== 1) return null;
    return isLiquidatable(selectedState, { collateralPrice: RISK_PARAMS.collateralPrice, debtPrice: RISK_PARAMS.debtPrice, liquidationThresholdBps: 8500n });
  }, [selectedState, onChain]);

  return {
    address, isConnected, onHorizen,
    connect: () => connect({ connector: connectors[0] }),
    getWallet,
    connectorName: connectors[0]?.name ?? "Injected",
    switchChain: () => switchChain({ chainId: horizenTestnet.id }),
    snarkReady, positions, selectedId, setSelectedId: selectPosition, selectedState, refreshPositions,
    onChain, refreshOnChain, oraclePrices, relayUnreachable,
    runAction, mintTestTokens, seedLiquidity, isEligible,
    tx, setTx, RISK_PARAMS, ASSETS, assetBalances, refreshAssetBalances, allowances, refreshAllowances, ensureAllowance, mintAsset, relayedPrices, refreshOraclePrices,
  };
}

function fnFor(kind: ActionKind): string {
  switch (kind) {
    case "deposit": return "deposit";
    case "repay": return "repay";
    case "borrow": return "borrow";
    case "withdraw": return "withdrawCollateral";
    case "liquidate": return "liquidate";
    case "create": return "createPosition";
  }
}

function bytes32(v: bigint) {
  return "0x" + v.toString(16).padStart(64, "0");
}

