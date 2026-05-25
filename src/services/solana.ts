/**
 * Central Solana wiring for the escrow app.
 *
 * Owns: RPC/WS endpoints, the configurable escrow program id, network +
 * chain derivation, and factory functions that produce the
 * `@ar.io/sdk/solana` escrow clients (read-only, or write-capable when a
 * connected wallet adapter is supplied).
 *
 * All on-chain work goes through `@ar.io/sdk/solana` (built on
 * `@solana/kit`). No `@solana/web3.js` here or anywhere in `src/`.
 */
import {
  createSolanaRpc,
  createSolanaRpcSubscriptions,
  address,
  type Address,
} from '@solana/kit';
import {
  ANTEscrow,
  TokenEscrow,
  DEVNET_PROGRAM_IDS,
  DEVNET_ARIO_MINT,
  type EscrowNetwork,
} from '@ar.io/sdk/solana';
import { createWalletSigner, type SolanaChain } from './wallet-signer.ts';

export type { SolanaRpc, SolanaRpcSubscriptions } from '@ar.io/sdk/solana';

const RPC_KEY = 'escrow-rpc-url';
const PROGRAM_KEY = 'escrow-program-id';
const ARIO_MINT_KEY = 'escrow-ario-mint';

const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

/** Resolve the active RPC URL: localStorage override → env → mainnet. */
export function getRpcUrl(): string {
  const saved =
    typeof localStorage !== 'undefined' ? localStorage.getItem(RPC_KEY) : null;
  if (saved) return saved;
  return import.meta.env.VITE_SOLANA_RPC_URL || MAINNET_RPC;
}

/** Derive the WebSocket subscriptions URL from the HTTP RPC URL. */
export function getWsUrl(rpcUrl: string = getRpcUrl()): string {
  return rpcUrl.replace(/^http(s?):\/\//, (_m, s) => (s ? 'wss://' : 'ws://'));
}

/**
 * The escrow program id the app talks to. Required: the SDK ships no
 * working escrow program id for any public cluster (`ario-ant-escrow` is
 * not deployed on devnet/mainnet), so the user must point the app at
 * their own deployment via the footer switcher or `VITE_ESCROW_PROGRAM_ID`.
 * Returns `undefined` when unset (escrow actions are then disabled).
 */
export function getEscrowProgramId(): string | undefined {
  const saved =
    typeof localStorage !== 'undefined'
      ? localStorage.getItem(PROGRAM_KEY)
      : null;
  return saved || import.meta.env.VITE_ESCROW_PROGRAM_ID || undefined;
}

export function setEscrowProgramId(id: string): void {
  if (id) localStorage.setItem(PROGRAM_KEY, id);
  else localStorage.removeItem(PROGRAM_KEY);
}

/** Network string bound into the canonical claim message. Overridable via
 *  `VITE_ESCROW_NETWORK`; otherwise inferred from the RPC URL. */
export function getNetwork(rpcUrl: string = getRpcUrl()): EscrowNetwork {
  const override = import.meta.env.VITE_ESCROW_NETWORK as
    | EscrowNetwork
    | undefined;
  if (override === 'solana-mainnet' || override === 'solana-devnet') {
    return override;
  }
  return /mainnet/.test(rpcUrl) ? 'solana-mainnet' : 'solana-devnet';
}

/** Wallet Standard chain identifier for the active network. */
export function getChain(rpcUrl: string = getRpcUrl()): SolanaChain {
  if (/mainnet/.test(rpcUrl)) return 'solana:mainnet';
  if (/testnet/.test(rpcUrl)) return 'solana:testnet';
  return 'solana:devnet';
}

/** Mainnet ARIO SPL mint. */
const MAINNET_ARIO_MINT = 'ARiotkVQiLCdng5y3Grf8XLfXJiAR4Dqfsrfcbq5Zo3';

/** The ARIO SPL mint for the active network. Resolution order:
 *  localStorage override → `VITE_ARIO_MINT` → inferred from the RPC URL.
 *  The runtime override matters for custom clusters (localnet/surfpool)
 *  whose ARIO mint differs from the public devnet/mainnet mints. */
export function getArioMint(rpcUrl: string = getRpcUrl()): Address {
  const saved =
    typeof localStorage !== 'undefined'
      ? localStorage.getItem(ARIO_MINT_KEY)
      : null;
  if (saved) return address(saved);
  const override = import.meta.env.VITE_ARIO_MINT as string | undefined;
  if (override) return address(override);
  return /mainnet/.test(rpcUrl) ? address(MAINNET_ARIO_MINT) : DEVNET_ARIO_MINT;
}

/** The configured ARIO mint override, or '' if none (for UI display). */
export function getArioMintOverride(): string {
  const saved =
    typeof localStorage !== 'undefined'
      ? localStorage.getItem(ARIO_MINT_KEY)
      : null;
  return saved || (import.meta.env.VITE_ARIO_MINT as string | undefined) || '';
}

export function setArioMint(mint: string): void {
  if (mint) localStorage.setItem(ARIO_MINT_KEY, mint);
  else localStorage.removeItem(ARIO_MINT_KEY);
}

/** ario-core program id for the active network (needed for vault claims). */
function coreProgramId(rpcUrl: string = getRpcUrl()): Address | undefined {
  return /mainnet/.test(rpcUrl) ? undefined : DEVNET_PROGRAM_IDS.core;
}

export function makeRpc(rpcUrl: string = getRpcUrl()) {
  return {
    rpc: createSolanaRpc(rpcUrl),
    rpcSubscriptions: createSolanaRpcSubscriptions(getWsUrl(rpcUrl)),
  };
}

interface ClientOpts {
  /** Connected wallet-adapter `Adapter` (from `useWallet().wallet?.adapter`).
   *  Omit for read-only clients. */
  adapter?: unknown;
}

function baseConfig(opts: ClientOpts) {
  const rpcUrl = getRpcUrl();
  const { rpc, rpcSubscriptions } = makeRpc(rpcUrl);
  const programId = getEscrowProgramId();
  const signer = opts.adapter
    ? createWalletSigner(opts.adapter, getChain(rpcUrl))
    : undefined;
  return {
    rpc,
    rpcSubscriptions,
    ...(signer ? { signer } : {}),
    ...(programId ? { programId: address(programId) } : {}),
    ...(coreProgramId(rpcUrl) ? { coreProgram: coreProgramId(rpcUrl) } : {}),
  };
}

/** Build the kit transaction signer for a connected wallet adapter.
 *  Used when assembling multi-instruction txs by hand (Arweave claims). */
export function getWalletSigner(adapter: unknown) {
  return createWalletSigner(adapter, getChain());
}

/** ANT-escrow client. Pass `{ adapter }` for write operations. */
export function getAntEscrow(opts: ClientOpts = {}): ANTEscrow {
  return new ANTEscrow(baseConfig(opts));
}

/** Token/vault-escrow client. Pass `{ adapter }` for write operations. */
export function getTokenEscrow(opts: ClientOpts = {}): TokenEscrow {
  return new TokenEscrow(baseConfig(opts));
}
