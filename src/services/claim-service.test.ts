/**
 * End-to-end (headless) test of the centralized claim flow's security controls,
 * driving the REAL claims-api client with a mocked `fetch` standing in for the
 * `ar-io-claims` server:
 *
 *   - a genuine server canonical is accepted and is byte-identical to the
 *     locally rebuilt one (legit claims still sign);
 *   - a tampered server canonical (attacker claimant) is REJECTED client-side,
 *     BEFORE any signing;
 *   - the client pins its OWN network (rejects a server that signed a different
 *     one), and
 *   - each attempt uses a FRESH random idempotency key.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import bs58 from 'bs58';
import { setClaimsApiUrlOverride, bytesToHex } from './claims-api.ts';
import {
  rebuildClaimCanonical,
  CanonicalMismatchError,
  type ExpectedClaimCanonical,
} from './canonical-verify.ts';
import {
  prepareClaimSignature,
  expectedAssetFromView,
  type RecipientIdentity,
} from './claim-service.ts';
import type { ClaimableAssetView } from './claims-api.ts';

const CLIENT_NETWORK = 'solana-mainnet' as const;
const VICTIM = bs58.encode(new Uint8Array(32).fill(1)); // the destination the user typed
const ATTACKER = bs58.encode(new Uint8Array(32).fill(2)); // where a malicious server redirects
const CHALLENGE_NONCE = new Uint8Array(32).fill(0x22);
const ETH_ID = new Uint8Array(20).fill(0x33);

const IDENTITY: RecipientIdentity = { protocol: 'ethereum', pubkey: ETH_ID };
const ASSET: ClaimableAssetView = {
  assetKey: '11'.repeat(32), // 32-byte asset id, hex — a token escrow
  assetType: 'token',
  antMint: null,
  name: null,
  amount: '123456789',
  vaultEndTimestamp: null,
  nonceHex: '00'.repeat(32),
  status: 'available',
  claimStatus: null,
  claimTx: null,
};

/** What the server signs. Vary claimant/network to simulate a hostile server. */
interface ServerCanonicalOpts {
  claimant?: string;
  network?: string;
}
function serverCanonicalHex(opts: ServerCanonicalOpts = {}): string {
  const expected: ExpectedClaimCanonical = {
    network: opts.network ?? CLIENT_NETWORK,
    claimant: opts.claimant ?? VICTIM,
    nonce: CHALLENGE_NONCE,
    recipientPubkey: ETH_ID,
    asset: expectedAssetFromView(ASSET),
  };
  return bytesToHex(rebuildClaimCanonical(expected));
}

const seenIdempotencyKeys: string[] = [];

/** Install a fetch mock that answers POST /v1/claims/initiate. */
function mockInitiate(opts: ServerCanonicalOpts = {}) {
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string, init?: RequestInit) => {
      if (!url.endsWith('/v1/claims/initiate')) {
        throw new Error(`unexpected fetch to ${url}`);
      }
      const body = JSON.parse(String(init?.body ?? '{}'));
      seenIdempotencyKeys.push(body.idempotencyKey);
      const canonicalHex = serverCanonicalHex(opts);
      const payload = {
        claimId: 'claim-abc',
        status: 'claiming',
        assetKey: body.assetKey,
        claimant: body.claimant,
        protocol: 'ethereum',
        recipientId: 'r',
        // A hostile server may LIE here — the client must not trust it.
        network: opts.network ?? CLIENT_NETWORK,
        nonceHex: bytesToHex(CHALLENGE_NONCE),
        canonicalMessageHex: canonicalHex,
        canonicalMessageBase64: '',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      };
      return new Response(JSON.stringify(payload), {
        status: 201,
        headers: { 'content-type': 'application/json' },
      });
    }),
  );
}

describe('prepareClaimSignature — centralized claim security controls', () => {
  beforeEach(() => {
    setClaimsApiUrlOverride('http://claims.test');
    seenIdempotencyKeys.length = 0;
  });
  afterEach(() => {
    setClaimsApiUrlOverride(undefined);
    vi.unstubAllGlobals();
  });

  it('accepts a genuine server canonical and returns byte-identical bytes to sign', async () => {
    mockInitiate();
    const prepared = await prepareClaimSignature({
      asset: ASSET,
      claimant: VICTIM,
      identity: IDENTITY,
      network: CLIENT_NETWORK,
    });
    // The bytes handed to the wallet are exactly what the client independently
    // rebuilt — so a legit claim signs the right message.
    const local = rebuildClaimCanonical({
      network: CLIENT_NETWORK,
      claimant: VICTIM,
      nonce: CHALLENGE_NONCE,
      recipientPubkey: ETH_ID,
      asset: expectedAssetFromView(ASSET),
    });
    expect(Array.from(prepared.canonicalBytes)).toEqual(Array.from(local));
    expect(prepared.claimId).toBe('claim-abc');
  });

  it('REJECTS a server that redirects the claimant, before signing', async () => {
    // Server binds the ATTACKER as claimant; the user asked for VICTIM.
    mockInitiate({ claimant: ATTACKER });
    await expect(
      prepareClaimSignature({
        asset: ASSET,
        claimant: VICTIM,
        identity: IDENTITY,
        network: CLIENT_NETWORK,
      }),
    ).rejects.toBeInstanceOf(CanonicalMismatchError);
  });

  it('PINS the client network (rejects a server that signed a different one)', async () => {
    // Server signs devnet bytes (and even lies about it in JSON); client is mainnet.
    mockInitiate({ network: 'solana-devnet' });
    await expect(
      prepareClaimSignature({
        asset: ASSET,
        claimant: VICTIM,
        identity: IDENTITY,
        network: CLIENT_NETWORK,
      }),
    ).rejects.toBeInstanceOf(CanonicalMismatchError);
  });

  it('uses a FRESH random idempotency key per attempt', async () => {
    mockInitiate();
    await prepareClaimSignature({ asset: ASSET, claimant: VICTIM, identity: IDENTITY, network: CLIENT_NETWORK });
    await prepareClaimSignature({ asset: ASSET, claimant: VICTIM, identity: IDENTITY, network: CLIENT_NETWORK });
    expect(seenIdempotencyKeys).toHaveLength(2);
    expect(seenIdempotencyKeys[0]).not.toBe(seenIdempotencyKeys[1]);
    // UUID v4 shape — not a deterministic `${assetKey}:${claimant}`.
    for (const k of seenIdempotencyKeys) {
      expect(k).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i);
    }
  });
});
