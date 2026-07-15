/**
 * Centralized claim orchestration — the one code path a claim takes.
 *
 * For each asset:
 *   1. initiate  → server mints a single-use challenge + returns the exact
 *      canonical bytes to sign (built from ledger state, never client input).
 *   2. VERIFY    → the client independently rebuilds the canonical from the
 *      displayed asset + the connected wallet's own identity + the typed Solana
 *      claimant, PINNING its own network, and byte-compares against the server's
 *      bytes. Mismatch → refuse to sign (MEDIUM-2 / control G).
 *   3. sign      → the recipient's Arweave (RSA-PSS) or Ethereum (ECDSA) wallet
 *      signs the verified bytes.
 *   4. complete  → submit the proof; the server verifies + dispenses on-chain.
 *   5. poll      → follow the claim to a terminal state.
 *
 * The on-chain escrow claim path (Solana RPC, attestor, tx assembly) was
 * removed — this is the only backend.
 */
import {
  initiateClaim,
  completeClaim,
  waitForClaim,
  hexToBytes,
  type ClaimProtocol,
  type ClaimableAssetView,
  type ClaimStatusView,
} from './claims-api.ts';
import {
  assertServerCanonicalMatches,
  type ExpectedAsset,
  type ExpectedClaimCanonical,
} from './canonical-verify.ts';
import type { EscrowNetwork } from './solana.ts';

/** The connected recipient wallet's identity, in the raw bytes the canonical
 *  `recipient:` field hashes: 20-byte ETH address or 512-byte Arweave modulus. */
export interface RecipientIdentity {
  protocol: ClaimProtocol;
  /** 20 bytes (ethereum) or 512 bytes (arweave RSA modulus). */
  pubkey: Uint8Array;
}

export type ClaimPhase = 'initiating' | 'verifying' | 'signing' | 'submitting';

export interface SignParams {
  /** Injected EIP-1193 provider, required for Ethereum-recipient items. */
  ethereumProvider?: unknown;
}

/** Map a claimable asset view to the fields the canonical rebuild binds. */
export function expectedAssetFromView(view: ClaimableAssetView): ExpectedAsset {
  if (view.assetType === 'ant') {
    const antMint = view.antMint ?? view.assetKey;
    return { assetType: 'ant', antMint };
  }
  // token / vault: assetKey IS the 32-byte asset id in hex; amount is mARIO.
  if (view.amount === null || view.amount === undefined) {
    throw new Error(`${view.assetType} asset ${view.assetKey} is missing an amount`);
  }
  return {
    assetType: view.assetType,
    assetId: hexToBytes(view.assetKey),
    amount: BigInt(view.amount),
  };
}

export interface PreparedClaim {
  claimId: string;
  /** The verified canonical bytes to hand the wallet. */
  canonicalBytes: Uint8Array;
  /** The single-use challenge nonce (echoed back on complete). */
  nonceHex: string;
}

/**
 * Initiate a claim and verify the returned canonical BEFORE signing.
 *
 * Security controls enforced here:
 *   - MEDIUM-2: rebuild the canonical locally and byte-compare (throws
 *     `CanonicalMismatchError` on any divergence).
 *   - G (network pin): the rebuild uses the client's own `network`, never the
 *     `network` echoed by the server.
 *   - Fresh idempotency key per attempt (`crypto.randomUUID()`), so a failed
 *     sign never locks the asset behind a stale deterministic key.
 */
export async function prepareClaimSignature(params: {
  asset: ClaimableAssetView;
  claimant: string;
  identity: RecipientIdentity;
  network: EscrowNetwork;
}): Promise<PreparedClaim> {
  const { asset, claimant, identity, network } = params;

  const initiated = await initiateClaim({
    assetKey: asset.assetKey,
    claimant,
    // Fresh per attempt — NOT `${assetKey}:${claimant}` (that deterministic key
    // would 409-lock the asset after any failed attempt).
    idempotencyKey: crypto.randomUUID(),
  });

  const expected: ExpectedClaimCanonical = {
    // PIN the client's network — do not trust `initiated.network`.
    network,
    claimant,
    nonce: hexToBytes(initiated.nonceHex),
    recipientPubkey: identity.pubkey,
    asset: expectedAssetFromView(asset),
  };
  // Throws CanonicalMismatchError unless byte-identical.
  assertServerCanonicalMatches(initiated.canonicalMessageBytes, expected);

  return {
    claimId: initiated.claimId,
    canonicalBytes: initiated.canonicalMessageBytes,
    nonceHex: initiated.nonceHex,
  };
}

/**
 * Sign already-verified canonical bytes with the recipient wallet.
 *
 * Arweave uses `signature()` — a STANDARD single-hash RSA-PSS over the raw
 * message — NOT `signMessage()` (which digests first, double-hashing under
 * PSS). `saltLength: 32` matches the claims service + the contract. Requires
 * the wallet's SIGNATURE permission (requested at connect time).
 */
export async function signCanonical(
  canonicalBytes: Uint8Array,
  identity: RecipientIdentity,
  opts: SignParams = {},
): Promise<Uint8Array> {
  if (identity.protocol === 'arweave') {
    const arweaveWallet = (window as any).arweaveWallet;
    if (!arweaveWallet || typeof arweaveWallet.signature !== 'function') {
      throw new Error(
        'Your Arweave wallet does not expose the signature() API needed for ' +
          'claims. Reconnect Wander and grant the SIGNATURE permission.',
      );
    }
    const raw = await arweaveWallet.signature(canonicalBytes, {
      name: 'RSA-PSS',
      saltLength: 32,
    });
    const sig =
      raw instanceof Uint8Array
        ? raw
        : raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : raw?.signature
            ? new Uint8Array(raw.signature)
            : null;
    if (!sig) throw new Error('Unexpected signature() return format.');
    if (sig.length !== 512) {
      throw new Error('Invalid RSA signature length from wallet. Please try again.');
    }
    return sig;
  }

  // Ethereum: personal_sign applies the EIP-191 prefix; the service re-applies it.
  if (!opts.ethereumProvider) throw new Error('Ethereum wallet not connected.');
  const { BrowserProvider } = await import('ethers');
  const provider = new BrowserProvider(opts.ethereumProvider as any);
  const signer = await provider.getSigner();
  const sigHex = await signer.signMessage(new TextDecoder().decode(canonicalBytes));
  return hexToBytes(sigHex);
}

/** Submit a signed proof and follow the claim to a terminal (or verified) state. */
export async function submitSignedClaim(params: {
  claimId: string;
  identity: RecipientIdentity;
  signature: Uint8Array;
  nonceHex: string;
}): Promise<ClaimStatusView> {
  const { claimId, identity, signature, nonceHex } = params;
  await completeClaim({
    claimId,
    protocol: identity.protocol,
    signature,
    ...(identity.protocol === 'arweave' ? { modulus: identity.pubkey } : {}),
    nonceHex,
  });
  // A 202 means the proof verified + the asset was consumed; the dispatch
  // worker settles on-chain. Poll to a terminal status for the tx signature.
  return waitForClaim(claimId);
}

/**
 * Full single-asset claim: initiate → verify → sign → complete → poll.
 * `onPhase` drives per-item UI progress. Throws with a user-facing message
 * (including `CanonicalMismatchError` when the server's canonical is rejected).
 */
export async function claimAsset(params: {
  asset: ClaimableAssetView;
  claimant: string;
  identity: RecipientIdentity;
  network: EscrowNetwork;
  ethereumProvider?: unknown;
  onPhase?: (phase: ClaimPhase, message: string) => void;
}): Promise<ClaimStatusView> {
  const { asset, claimant, identity, network, ethereumProvider, onPhase } = params;

  onPhase?.('initiating', 'Requesting a claim challenge...');
  const prepared = await prepareClaimSignature({ asset, claimant, identity, network });

  onPhase?.('signing', 'Waiting for your signature...');
  const signature = await signCanonical(prepared.canonicalBytes, identity, {
    ethereumProvider,
  });

  onPhase?.('submitting', 'Submitting your claim...');
  return submitSignedClaim({
    claimId: prepared.claimId,
    identity,
    signature,
    nonceHex: prepared.nonceHex,
  });
}
