"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import { useAccount, useConnect, usePublicClient, useSwitchChain, useWalletClient } from "wagmi";
import type { Address } from "viem";
import { horizenTestnet, explorerTx } from "../lib/chains";
import { ADDRESSES } from "../lib/contracts/addresses";
import { veilLendAbi, tokenAbi, oracleAbi } from "../lib/contracts/abis";
import {
  ACTION_BORROW, ACTION_DEPOSIT, ACTION_WITHDRAW, randomSecret,
  buildLiquidationWitness, buildRiskTransition, buildTransition,
  computeCommitment, isLiquidatable, makeInitialState,
  type PrivateState, type LiquidationParams,
} from "../lib/zk/witness";
import type { CircuitName } from "../lib/zk/snarkjs";
import { deserializeState, serializeState, listPositions, savePosition, getPosition, type StoredPosition } from "../lib/state/store";

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
  const { address, isConnected, chainId } = useAccount();
  const onHorizen = chainId === horizenTestnet.id;
  const publicClient = usePublicClient();
  const { connect, connectors } = useConnect();
  const { switchChain } = useSwitchChain();
  const { data: walletClient } = useWalletClient();

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

  const selectedState: PrivateState | null = useMemo(() => {
    if (!address || !selectedId) return null;
    const stored = getPosition(address, BigInt(selectedId));
    return stored ? deserializeState(stored.state) : null;
  }, [address, selectedId]);

  const readOnChainPosition = useCallback(async (positionId: bigint): Promise<OnChainPosition | null> => {
    if (!publicClient) return null;
    const raw = await publicClient.readContract({
      address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "positions", args: [positionId],
    }) as { collateralAsset: string; debtAsset: string; activeCommitment: string; interestIndex: bigint; sequence: number; status: number };
    const [supported, outstanding] = await Promise.all([
      publicClient.readContract({ address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "supportedCollateral", args: [positionId] }) as Promise<bigint>,
      publicClient.readContract({ address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "borrowOutstanding", args: [positionId] }) as Promise<bigint>,
    ]);
    if (Number(raw.status) === 0) return null;
    return {
      collateralAsset: raw.collateralAsset, debtAsset: raw.debtAsset,
      activeCommitment: raw.activeCommitment, interestIndex: raw.interestIndex,
      sequence: BigInt(raw.sequence), status: Number(raw.status),
      supported: BigInt(supported), outstanding: BigInt(outstanding),
    };
  }, [publicClient]);

  const refreshOnChain = useCallback(async () => {
    if (!address || !selectedId) { setOnChain(null); return; }
    try { setOnChain(await readOnChainPosition(BigInt(selectedId))); } catch { setOnChain(null); }
  }, [address, selectedId, readOnChainPosition]);

  useEffect(() => { void refreshOnChain(); }, [address, selectedId, tx.status, refreshOnChain]);

  const oraclePrices = useCallback(async () => {
    if (!publicClient) throw new Error("no RPC");
    const [col, debt] = (await Promise.all([
      publicClient.readContract({ address: ADDRESSES.mockPriceOracle as Address, abi: oracleAbi, functionName: "getPrice", args: [ADDRESSES.collateralToken as Address] }),
      publicClient.readContract({ address: ADDRESSES.mockPriceOracle as Address, abi: oracleAbi, functionName: "getPrice", args: [ADDRESSES.debtToken as Address] }),
    ])) as [readonly [bigint, bigint], readonly [bigint, bigint]];
    return { collateralPrice: col[0], debtPrice: debt[0] };
  }, [publicClient]);

  const fail = useCallback((err: unknown): never => {
    const raw = err instanceof Error ? err.message : String(err);
    let msg = raw;
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
    setTx({ status: "failed", error: msg, label: raw.slice(0, 140) });
    throw err;
  }, []);

  const proveAndSubmit = useCallback(async (
    fnName: string,
    circuit: CircuitName,
    publicSignals: string[],
    inputs: Record<string, string>,
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
    return { hash, block: Number(rec.blockNumber), gasUsed: rec.gasUsed.toString() };
  }, [publicClient, walletClient]);

  const runAction = useCallback(async (kind: ActionKind, amt: bigint | null) => {
    if (!walletClient || !address || !publicClient) throw new Error("wallet not connected");
    setTx({ status: "preparing" });
    try {
      // ---------- create ----------
      if (kind === "create") {
        const nextId = (await publicClient.readContract({ address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "nextPositionId" })) as bigint;
        const positionId = nextId + 1n;
        const currentIndex = (await publicClient.readContract({ address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "currentDebtIndex", args: [ADDRESSES.debtToken as Address] })) as bigint;
        const st = makeInitialState({ positionId, collateralAsset: BigInt(ADDRESSES.collateralToken), debtAsset: BigInt(ADDRESSES.debtToken), currentIndex });
        const c0 = await computeCommitment(st);
        setTx((t) => ({ ...t, status: "submitting" }));
        setTx((t) => ({ ...t, status: "wallet" }));
        const hash = await walletClient.writeContract({
          address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "createPosition",
          args: [ADDRESSES.collateralToken as Address, ADDRESSES.debtToken as Address, bytes32(c0)],
        });
        setTx((t) => ({ ...t, status: "confirming", txHash: hash }));
        const rec = await publicClient.waitForTransactionReceipt({ hash });
        const on = await readOnChainPosition(positionId);
        if (!on || on.activeCommitment !== bytes32(c0)) throw new Error("created position state mismatch");
        savePosition(address, { positionId: positionId.toString(), state: serializeState(st), createdAt: new Date().toISOString() });
        refreshPositions();
        setSelectedId(positionId.toString());
        setTx({ status: "confirmed", txHash: hash, block: Number(rec.blockNumber), gasUsed: rec.gasUsed.toString(), explorerUrl: explorerTx(hash), proofVerified: false });
        return;
      }

      const selectedIdStr = selectedId;
      if (!selectedIdStr) throw new Error("no position selected — create or import one");
      const positionId = BigInt(selectedIdStr);
      const st = selectedState;
      if (!st) throw new Error("The private state for this position is not in this browser");
      const currentIndex = (await publicClient.readContract({ address: ADDRESSES.veilLend as Address, abi: veilLendAbi, functionName: "currentDebtIndex", args: [ADDRESSES.debtToken as Address] })) as bigint;
      const newSalt = randomSecret();

      // ---------- deposit / repay (state_transition circuit) ----------
      if (kind === "deposit" || kind === "repay") {
        const amount = amt ?? 0n;
        if (amount === 0n) throw new Error("Enter an amount");
        const actionId = kind === "deposit" ? ACTION_DEPOSIT : 2n;
        const t = await buildTransition({ oldState: st, actionId, amount, currentIndex, newSalt });
        const res = await proveAndSubmit(fnFor(kind), "state_transition", t.publicSignals, t.inputs);
        const stored = getPosition(address, positionId);
        if (stored) savePosition(address, { ...stored, state: serializeState(t.newState) });
        setTx({ status: "confirmed", txHash: res.hash, block: res.block, gasUsed: res.gasUsed, explorerUrl: explorerTx(res.hash), proofVerified: true });
        await refreshOnChain(); refreshPositions();
        return;
      }

      // ---------- borrow / withdraw (risk_transition circuit) ----------
      if (kind === "borrow" || kind === "withdraw") {
        const amount = amt ?? 0n;
        if (amount === 0n) throw new Error("Enter an amount");
        const prices = await oraclePrices();
        const actionId = kind === "borrow" ? ACTION_BORROW : ACTION_WITHDRAW;
        const t = await buildRiskTransition({
          oldState: st, actionId, amount, currentIndex, newSalt,
          params: { collateralPrice: prices.collateralPrice, debtPrice: prices.debtPrice, maxLtvBps: 7500n },
          recipient: BigInt(address),
        });
        const res = await proveAndSubmit(fnFor(kind), "risk_transition", t.publicSignals, t.inputs);
        const stored = getPosition(address, positionId);
        if (stored) savePosition(address, { ...stored, state: serializeState(t.newState) });
        setTx({ status: "confirmed", txHash: res.hash, block: res.block, gasUsed: res.gasUsed, explorerUrl: explorerTx(res.hash), proofVerified: true });
        await refreshOnChain(); refreshPositions();
        return;
      }

      // ---------- liquidate (liquidation circuit, self-liquidation) ----------
      if (kind === "liquidate") {
        const prices = await oraclePrices();
        const params: LiquidationParams = { collateralPrice: prices.collateralPrice, debtPrice: prices.debtPrice, liquidationThresholdBps: 8500n };
        if (!isLiquidatable(st, params)) throw new Error("Position is not undercollateralized at current oracle prices");
        const w = await buildLiquidationWitness(st, params, BigInt(address));
        const res = await proveAndSubmit("liquidate", "liquidation", w.publicSignals, w.inputs, { collateralOut: w.amounts.collateralOut, debtOut: w.amounts.debtOut });
        const stored = getPosition(address, positionId);
        if (stored) savePosition(address, { ...stored, state: serializeState({ ...st, collateral: 0n }) });
        setTx({ status: "confirmed", txHash: res.hash, block: res.block, gasUsed: res.gasUsed, explorerUrl: explorerTx(res.hash), proofVerified: true });
        await refreshOnChain(); refreshPositions();
        return;
      }
      throw new Error("unknown action");
    } catch (err) {
      fail(err);
    }
  }, [walletClient, address, publicClient, selectedId, selectedState, proveAndSubmit, fail, oraclePrices, readOnChainPosition, refreshOnChain, refreshPositions]);

  const mintTestTokens = useCallback(async (kind: "vCOL" | "vDBT", amount: bigint) => {
    if (!walletClient || !address) throw new Error("wallet not connected");
    const token = kind === "vCOL" ? ADDRESSES.collateralToken : ADDRESSES.debtToken;
    setTx({ status: "wallet" });
    const hash = await walletClient.writeContract({ address: token as Address, abi: tokenAbi, functionName: "mint", args: [address, amount] });
    setTx((t) => ({ ...t, status: "confirming", txHash: hash }));
    await publicClient!.waitForTransactionReceipt({ hash });
    setTx({ status: "confirmed", txHash: hash, explorerUrl: explorerTx(hash), proofVerified: false });
  }, [walletClient, address, publicClient]);

  const seedLiquidity = useCallback(async (amount: bigint) => {
    if (!walletClient || !address || !publicClient) throw new Error("wallet not connected");
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
      const res = await proveAndSubmit("repay", "state_transition", t.publicSignals, t.inputs);
      setTx({ status: "confirmed", txHash: res.hash, block: res.block, gasUsed: res.gasUsed, explorerUrl: explorerTx(res.hash), proofVerified: true });
    } catch (err) {
      fail(err);
    }
  }, [walletClient, address, publicClient, proveAndSubmit, fail]);

  const isEligible: boolean | null = useMemo(() => {
    if (!selectedState || !onChain || onChain.status !== 1) return null;
    return isLiquidatable(selectedState, { collateralPrice: RISK_PARAMS.collateralPrice, debtPrice: RISK_PARAMS.debtPrice, liquidationThresholdBps: 8500n });
  }, [selectedState, onChain]);

  return {
    address, isConnected, onHorizen,
    connect: () => connect({ connector: connectors[0] }),
    connectorName: connectors[0]?.name ?? "Injected",
    switchChain: () => switchChain({ chainId: horizenTestnet.id }),
    snarkReady, positions, selectedId, setSelectedId, selectedState,
    onChain, refreshOnChain, oraclePrices,
    runAction, mintTestTokens, seedLiquidity, isEligible,
    tx, setTx, RISK_PARAMS,
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

