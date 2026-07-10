/**
 * Client-side canonical claim-message rebuild + verification (MEDIUM-2).
 *
 * The `/v1/claims/initiate` response hands the wallet the EXACT bytes to sign
 * (`canonicalMessageBytes`). The wallet signs those bytes verbatim — so a
 * malicious or compromised claims server could return a canonical that binds a
 * DIFFERENT Solana `claimant` (redirecting the asset) or a different asset/amount,
 * and the user would sign it blind (wallets show base58 blobs no human parses).
 * Echoing `initiated.claimant === claimant` is NOT sufficient — only the BYTES
 * are signed, not the JSON envelope.
 *
 * Defence: before signing, LOCALLY rebuild the canonical from what the UI is
 * actually showing (the loaded escrow asset) + the connected source identity +
 * the Solana destination the user typed, and BYTE-COMPARE against the server's
 * bytes. Any mismatch → refuse to sign.
 *
 * The format is byte-pinned to the claims service's `@ar.io/attestor-canonical`
 * builders (`packages/canonical/src/canonical.ts`), which are in turn cross-tested
 * against the on-chain Rust. NOTE this is the escrow-claim format WITH the
 * `recipient:` binding line and NO ` v1`/` v2` header suffix — it is deliberately
 * distinct from the SDK's older `canonicalMessage`/`canonicalMessageV2`.
 */

import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha256';
import { bytesToBase64Url } from './claims-api.ts';

const ANT_ESCROW_CLAIM_HEADER = 'ar.io ant-escrow claim';
const ESCROW_CLAIM_HEADER = 'ar.io escrow claim';

/** base64url(sha256(identity bytes)), no padding — the `recipient:` field. */
export function deriveRecipientIdB64Url(recipientPubkey: Uint8Array): string {
  return bytesToBase64Url(sha256(recipientPubkey));
}

function hexLower(bytes: Uint8Array): string {
  let out = '';
  for (const b of bytes) out += b.toString(16).padStart(2, '0');
  return out;
}

function decodeClaimant(claimant: string): Uint8Array {
  let bytes: Uint8Array;
  try {
    bytes = bs58.decode(claimant);
  } catch {
    throw new Error('claimant is not valid base58');
  }
  if (bytes.length !== 32) {
    throw new Error(`claimant must decode to 32 bytes, got ${bytes.length}`);
  }
  return bytes;
}

export type ExpectedAsset =
  | { assetType: 'ant'; antMint: string }
  | { assetType: 'token' | 'vault'; assetId: Uint8Array; amount: bigint };

export interface ExpectedClaimCanonical {
  /** Network string the server bound (echoed from the initiate response). */
  network: string;
  /** base58 Solana destination the user entered. */
  claimant: string;
  /** 32-byte single-use challenge nonce (from the initiate response). */
  nonce: Uint8Array;
  /** Source identity bytes: 512-byte RSA modulus (Arweave) or 20-byte address (Ethereum). */
  recipientPubkey: Uint8Array;
  /** The asset the UI is displaying. */
  asset: ExpectedAsset;
}

/** Rebuild the exact canonical bytes for a claim from local (UI + wallet) state. */
export function rebuildClaimCanonical(input: ExpectedClaimCanonical): Uint8Array {
  const { network, claimant, nonce, recipientPubkey, asset } = input;
  if (nonce.length !== 32) throw new Error(`nonce must be 32 bytes, got ${nonce.length}`);
  if (recipientPubkey.length === 0) throw new Error('recipientPubkey must be non-empty');
  const claimantBytes = decodeClaimant(claimant);
  const recipient = deriveRecipientIdB64Url(recipientPubkey);

  if (asset.assetType === 'ant') {
    const antMint = bs58.decode(asset.antMint);
    if (antMint.length !== 32) throw new Error(`antMint must be 32 bytes, got ${antMint.length}`);
    const lines = [
      ANT_ESCROW_CLAIM_HEADER,
      `network: ${network}`,
      `recipient: ${recipient}`,
      `ant: ${bs58.encode(antMint)}`,
      `claimant: ${bs58.encode(claimantBytes)}`,
      `nonce: ${hexLower(nonce)}`,
    ];
    return new TextEncoder().encode(lines.join('\n'));
  }

  if (asset.assetId.length !== 32) throw new Error(`assetId must be 32 bytes, got ${asset.assetId.length}`);
  if (asset.amount < 0n || asset.amount > 0xffff_ffff_ffff_ffffn) {
    throw new Error(`amount must fit in u64, got ${asset.amount}`);
  }
  const lines = [
    ESCROW_CLAIM_HEADER,
    `network: ${network}`,
    `recipient: ${recipient}`,
    `type: ${asset.assetType}`,
    `asset: ${hexLower(asset.assetId)}`,
    `amount: ${asset.amount.toString()}`,
    `claimant: ${bs58.encode(claimantBytes)}`,
    `nonce: ${hexLower(nonce)}`,
  ];
  return new TextEncoder().encode(lines.join('\n'));
}

export function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

export class CanonicalMismatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CanonicalMismatchError';
  }
}

/**
 * Throw unless the server-provided canonical bytes are byte-identical to a locally
 * rebuilt canonical for the asset+claimant+identity the UI is showing. Call this
 * IMMEDIATELY before `wallet.signMessage(serverBytes)`.
 */
export function assertServerCanonicalMatches(
  serverBytes: Uint8Array,
  expected: ExpectedClaimCanonical,
): void {
  const local = rebuildClaimCanonical(expected);
  if (!bytesEqual(local, serverBytes)) {
    throw new CanonicalMismatchError(
      'The claim server returned a message that does not match this asset and your ' +
        'destination wallet. Refusing to sign — do not proceed and report this. ' +
        `(expected ${local.length} bytes, got ${serverBytes.length})`,
    );
  }
}
