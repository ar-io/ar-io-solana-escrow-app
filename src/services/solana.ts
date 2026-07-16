/**
 * Minimal Solana wiring for the centralized-claims app.
 *
 * The app no longer reads escrow state from Solana or builds transactions —
 * the `ar-io-claims` service holds custody and dispenses on-chain. The only
 * things we still derive from the RPC URL are:
 *   - the network label bound into the canonical claim message, and
 *   - the endpoint that backs the optional Solana wallet connection used to
 *     auto-fill the claim destination address.
 *
 * There is no `@solana/kit` / `@ar.io/sdk` on-chain client here — those were
 * part of the removed on-chain claim path.
 */

/** Network string bound into the canonical claim message. Must match the
 *  claims service's own NETWORK. */
export type EscrowNetwork = 'solana-mainnet' | 'solana-devnet';

const RPC_KEY = 'escrow-rpc-url';

const MAINNET_RPC = 'https://api.mainnet-beta.solana.com';

/** Resolve the active RPC URL: localStorage override → env → mainnet. */
export function getRpcUrl(): string {
  const saved =
    typeof localStorage !== 'undefined' ? localStorage.getItem(RPC_KEY) : null;
  if (saved) return saved;
  return import.meta.env.VITE_SOLANA_RPC_URL || MAINNET_RPC;
}

/**
 * Network string bound into the canonical claim message.
 *
 * `VITE_ESCROW_NETWORK` is AUTHORITATIVE when set — it must equal the claims
 * service's compile-time NETWORK, which is independent of the cluster the RPC
 * points at. Only when the override is unset do we infer from the RPC URL.
 *
 * This is the value the client PINS when re-verifying the server's canonical
 * before signing (security control G): the rebuild always uses this, never a
 * network echoed by the claims server.
 */
export function getNetwork(rpcUrl: string = getRpcUrl()): EscrowNetwork {
  const override = import.meta.env.VITE_ESCROW_NETWORK as
    | EscrowNetwork
    | undefined;
  if (override === 'solana-mainnet' || override === 'solana-devnet') {
    return override;
  }
  return /mainnet/.test(rpcUrl) ? 'solana-mainnet' : 'solana-devnet';
}
