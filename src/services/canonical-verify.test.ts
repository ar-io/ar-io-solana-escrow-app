/**
 * MEDIUM-2: the client must reject a server canonical whose bound fields
 * (claimant / asset / amount / recipient identity) diverge from what the UI is
 * showing, BEFORE handing the bytes to the wallet to sign.
 */

import { describe, it, expect } from 'vitest';
import bs58 from 'bs58';
import {
  assertServerCanonicalMatches,
  rebuildClaimCanonical,
  deriveRecipientIdB64Url,
  CanonicalMismatchError,
  type ExpectedClaimCanonical,
} from './canonical-verify.ts';

const NETWORK = 'solana-mainnet';
const VICTIM = bs58.encode(new Uint8Array(32).fill(1)); // the destination the user typed
const ATTACKER = bs58.encode(new Uint8Array(32).fill(2)); // where a malicious server redirects
const NONCE = new Uint8Array(32).fill(0x22);
const ETH_ID = new Uint8Array(20).fill(0x33);
const ANT_MINT = bs58.encode(new Uint8Array(32).fill(5));

function tokenExpectation(over: Partial<ExpectedClaimCanonical> = {}): ExpectedClaimCanonical {
  return {
    network: NETWORK,
    claimant: VICTIM,
    nonce: NONCE,
    recipientPubkey: ETH_ID,
    asset: { assetType: 'token', assetId: new Uint8Array(32).fill(0x11), amount: 123_456_789n },
    ...over,
  };
}

describe('assertServerCanonicalMatches (MEDIUM-2)', () => {
  it('accepts a server canonical that matches local state', () => {
    const server = rebuildClaimCanonical(tokenExpectation());
    expect(() => assertServerCanonicalMatches(server, tokenExpectation())).not.toThrow();
  });

  it('REJECTS a server canonical that swapped the claimant (fund redirect)', () => {
    // Server returns bytes bound to the attacker; UI/user expect the victim dest.
    const tampered = rebuildClaimCanonical(tokenExpectation({ claimant: ATTACKER }));
    expect(() => assertServerCanonicalMatches(tampered, tokenExpectation())).toThrow(
      CanonicalMismatchError,
    );
  });

  it('REJECTS a server canonical that inflated the amount', () => {
    const tampered = rebuildClaimCanonical(
      tokenExpectation({ asset: { assetType: 'token', assetId: new Uint8Array(32).fill(0x11), amount: 999_999_999n } }),
    );
    expect(() => assertServerCanonicalMatches(tampered, tokenExpectation())).toThrow(
      CanonicalMismatchError,
    );
  });

  it('REJECTS a server canonical that changed the asset id', () => {
    const tampered = rebuildClaimCanonical(
      tokenExpectation({ asset: { assetType: 'token', assetId: new Uint8Array(32).fill(0x44), amount: 123_456_789n } }),
    );
    expect(() => assertServerCanonicalMatches(tampered, tokenExpectation())).toThrow(
      CanonicalMismatchError,
    );
  });

  it('REJECTS a server canonical bound to a different recipient identity', () => {
    const tampered = rebuildClaimCanonical(tokenExpectation({ recipientPubkey: new Uint8Array(20).fill(0x99) }));
    expect(() => assertServerCanonicalMatches(tampered, tokenExpectation())).toThrow(
      CanonicalMismatchError,
    );
  });

  it('works for ANT assets too (claimant swap rejected)', () => {
    const expected: ExpectedClaimCanonical = {
      network: NETWORK,
      claimant: VICTIM,
      nonce: NONCE,
      recipientPubkey: ETH_ID,
      asset: { assetType: 'ant', antMint: ANT_MINT },
    };
    const good = rebuildClaimCanonical(expected);
    expect(() => assertServerCanonicalMatches(good, expected)).not.toThrow();
    const evil = rebuildClaimCanonical({ ...expected, claimant: ATTACKER });
    expect(() => assertServerCanonicalMatches(evil, expected)).toThrow(CanonicalMismatchError);
  });
});

// GOLDEN vectors produced by the SERVER's byte-pinned @ar.io/attestor-canonical
// builders (which are cross-tested against the on-chain Rust) for these exact
// inputs. Asserting our client rebuild reproduces them byte-for-byte proves we
// sign the SAME message the server verifies — a drift here would break every
// legitimate claim, so it must be caught in CI.
const GOLDEN_RECIPIENT = 'SFATaLHbxiqxExnUYI0lqsNjoDou2cn_0XUqZG_F2Us'; // b64url(sha256(0x33*20))
const GOLDEN_CLAIMANT = '4vJ9JU1bJJE96FWSJKvHsmmFADCg4gpZQff4P3bkLKi'; // bs58(0x01*32)
const GOLDEN_ANT_MINT = 'LbUiWL3xVV8hTFYBVdbTNrpDo41NKS6o3LHHuDzjfcY'; // bs58(0x05*32)

describe('rebuildClaimCanonical byte-parity with @ar.io/attestor-canonical', () => {
  it('reproduces the server token/escrow canonical byte-for-byte', () => {
    // Guard the derived encodings against local drift.
    expect(deriveRecipientIdB64Url(ETH_ID)).toBe(GOLDEN_RECIPIENT);
    expect(VICTIM).toBe(GOLDEN_CLAIMANT);
    expect(ANT_MINT).toBe(GOLDEN_ANT_MINT);

    const text = new TextDecoder().decode(rebuildClaimCanonical(tokenExpectation()));
    expect(text).toBe(
      [
        'ar.io escrow claim',
        'network: solana-mainnet',
        `recipient: ${GOLDEN_RECIPIENT}`,
        'type: token',
        `asset: ${'11'.repeat(32)}`,
        'amount: 123456789',
        `claimant: ${GOLDEN_CLAIMANT}`,
        `nonce: ${'22'.repeat(32)}`,
      ].join('\n'),
    );
  });

  it('reproduces the server ant-escrow canonical byte-for-byte', () => {
    const text = new TextDecoder().decode(
      rebuildClaimCanonical({
        network: NETWORK,
        claimant: VICTIM,
        nonce: NONCE,
        recipientPubkey: ETH_ID,
        asset: { assetType: 'ant', antMint: ANT_MINT },
      }),
    );
    expect(text).toBe(
      [
        'ar.io ant-escrow claim',
        'network: solana-mainnet',
        `recipient: ${GOLDEN_RECIPIENT}`,
        `ant: ${GOLDEN_ANT_MINT}`,
        `claimant: ${GOLDEN_CLAIMANT}`,
        `nonce: ${'22'.repeat(32)}`,
      ].join('\n'),
    );
    expect(text).not.toContain('type:');
  });
});
