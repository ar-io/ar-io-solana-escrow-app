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
  MAINNET_PROGRAM_IDS,
  DEVNET_ARIO_MINT,
  type EscrowNetwork,
} from '@ar.io/sdk/solana';
import { createWalletSigner, type SolanaChain } from './wallet-signer.ts';

export type { SolanaRpc, SolanaRpcSubscriptions } from '@ar.io/sdk/solana';

const RPC_KEY = 'escrow-rpc-url';
const PROGRAM_KEY = 'escrow-program-id';
const ARIO_MINT_KEY = 'escrow-ario-mint';
const CORE_PROGRAM_KEY = 'escrow-core-program-id';

const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

/** Resolve the active RPC URL: localStorage override → env → mainnet. */
export function getRpcUrl(): string {
  const saved =
    typeof localStorage !== 'undefined' ? localStorage.getItem(RPC_KEY) : null;
  if (saved) return saved;
  return import.meta.env.VITE_SOLANA_RPC_URL || MAINNET_RPC;
}

/** Derive the WebSocket subscriptions URL from the HTTP RPC URL.
 *
 *  `VITE_SOLANA_WS_URL` overrides when set. Otherwise: swap the scheme,
 *  and when the RPC URL carries an explicit port (local validators —
 *  surfpool / solana-test-validator), bump it by 1 per the Solana
 *  convention (RPC 8899 → WS 8900). Hosted endpoints without an explicit
 *  port serve WS on the same URL and are unaffected. */
export function getWsUrl(rpcUrl: string = getRpcUrl()): string {
  const override = import.meta.env.VITE_SOLANA_WS_URL as string | undefined;
  if (override) return override;
  const ws = rpcUrl.replace(/^http(s?):\/\//, (_m, s) => (s ? 'wss://' : 'ws://'));
  try {
    const u = new URL(ws);
    if (u.port) {
      u.port = String(Number(u.port) + 1);
      return u.toString().replace(/\/$/, '');
    }
  } catch {
    /* fall through to the plain scheme swap */
  }
  return ws;
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

/**
 * The AR.IO program-id set (core/gar/arns/ant/antEscrow) for the active
 * cluster, so we can reach sibling programs like ArNS. Keyed off the RPC
 * URL's cluster — the program deployments are a property of the *cluster*,
 * not the escrow app's network label. Returns undefined for custom/localnet
 * endpoints where we don't know the deployed IDs (callers should degrade
 * gracefully, e.g. skip ArNS-name enrichment). Prefer these when the
 * configured escrow program id matches the cluster's `antEscrow`.
 */
export function getSolanaProgramIds(
  rpcUrl: string = getRpcUrl(),
): Record<'core' | 'gar' | 'arns' | 'ant' | 'antEscrow', Address> | undefined {
  if (/devnet/.test(rpcUrl)) return DEVNET_PROGRAM_IDS;
  if (/mainnet/.test(rpcUrl)) return MAINNET_PROGRAM_IDS;
  return undefined;
}

/** Network string bound into the canonical claim message.
 *
 * `VITE_ESCROW_NETWORK` is AUTHORITATIVE when set. This string must equal the
 * deployed program's compile-time `NETWORK` constant — which is independent of
 * the cluster the RPC points at. A program built with `network-mainnet` but
 * deployed to devnet expects `solana-mainnet` in the canonical message, so you
 * set `VITE_ESCROW_NETWORK=solana-mainnet` even while the RPC is devnet. Only
 * when the override is unset do we infer from the RPC URL. */
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

/** ario-core program id for the active network (needed for vault claims —
 *  the ADR-027 re-lock CPIs into ario-core). Resolution: localStorage
 *  override → `VITE_ARIO_CORE_PROGRAM_ID` → devnet default for non-mainnet
 *  RPCs. Custom clusters (localnet/surfpool) must set the override, since
 *  their ario-core deployment differs from the public devnet one. */
export function getCoreProgramId(rpcUrl: string = getRpcUrl()): Address | undefined {
  const saved =
    typeof localStorage !== 'undefined'
      ? localStorage.getItem(CORE_PROGRAM_KEY)
      : null;
  if (saved) return address(saved);
  const override = import.meta.env.VITE_ARIO_CORE_PROGRAM_ID as string | undefined;
  if (override) return address(override);
  return /mainnet/.test(rpcUrl) ? undefined : DEVNET_PROGRAM_IDS.core;
}

export function setCoreProgramId(id: string): void {
  if (id) localStorage.setItem(CORE_PROGRAM_KEY, id);
  else localStorage.removeItem(CORE_PROGRAM_KEY);
}

function coreProgramId(rpcUrl: string = getRpcUrl()): Address | undefined {
  return getCoreProgramId(rpcUrl);
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

// ---------------------------------------------------------------------------
// Deposits feature gate (build-time env var, default off)
// ---------------------------------------------------------------------------

/** Deposit flows are only available when explicitly enabled at build time. */
export function areDepositsEnabled(): boolean {
  return import.meta.env.VITE_DEPOSITS_ENABLED === 'true';
}
