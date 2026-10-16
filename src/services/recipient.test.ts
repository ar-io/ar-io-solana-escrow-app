/**
 * Arweave modulus lookup — the gateway fallback rules.
 *
 * No network: `fetch` is stubbed, so each test states exactly what a gateway
 * answered and asserts what the lookup does about it. The cases are the real
 * ones observed in production, not invented shapes.
 */

import { describe, it, expect, vi, afterEach } from 'vitest';
import { lookupArweaveModulus, ARWEAVE_MODULUS_LEN } from './recipient';

// --- helpers ---------------------------------------------------------------

function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}

/** A syntactically real RSA-4096 modulus plus the address it hashes to. */
async function makeIdentity(seed: number): Promise<{ modulus: string; address: string }> {
  const bytes = new Uint8Array(ARWEAVE_MODULUS_LEN);
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 7 + seed) & 0xff;
  const modulus = bytesToBase64url(bytes);
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes as BufferSource));
  return { modulus, address: bytesToBase64url(hash) };
}

/** Answer each endpoint from `byEndpoint`; the key may be a sentinel or null. */
function stubGateways(byEndpoint: Record<string, string | null | 'no-edges' | 'http-error'>) {
  const calls: string[] = [];
  vi.stubGlobal('fetch', async (url: string) => {
    calls.push(url);
    const answer = byEndpoint[url];
    if (answer === 'http-error') {
      return { ok: false, status: 502, statusText: 'Bad Gateway' } as unknown as Response;
    }
    const edges =
      answer === 'no-edges' ? [] : [{ node: { owner: { key: answer ?? null } } }];
    return {
      ok: true,
      json: async () => ({ data: { transactions: { edges } } }),
    } as unknown as Response;
  });
  return calls;
}

const ARWEAVE = 'https://arweave.net/graphql';
const TURBO = 'https://turbo-gateway.com/graphql';
const GOLDSKY = 'https://arweave-search.goldsky.com/graphql';

afterEach(() => vi.unstubAllGlobals());

// --- the regression --------------------------------------------------------

describe('lookupArweaveModulus — gateway fallback', () => {
  it("falls through turbo's '<not-found>' sentinel to a gateway that has the key", async () => {
    // The production failure: an AO-only wallet (its only footprint is a bundled
    // aoconnect ANT spawn). turbo answers the owner query with a sentinel STRING,
    // which is truthy, so a bare presence check passes it on to atob and the user
    // gets `InvalidCharacterError` instead of their key.
    const { modulus, address } = await makeIdentity(3);
    stubGateways({ [TURBO]: '<not-found>', [ARWEAVE]: modulus });

    await expect(lookupArweaveModulus(address)).resolves.toBe(modulus);
  });

  it('asks arweave.net first, because it is the one that indexes bundled data items', async () => {
    const { modulus, address } = await makeIdentity(11);
    const calls = stubGateways({ [ARWEAVE]: modulus, [TURBO]: modulus });

    await lookupArweaveModulus(address);
    expect(calls[0]).toBe(ARWEAVE);
  });

  it('never calls goldsky — its 307 carries no CORS header, so browsers block it', async () => {
    const { modulus, address } = await makeIdentity(5);
    const calls = stubGateways({ [ARWEAVE]: modulus, [TURBO]: modulus });

    await lookupArweaveModulus(address);
    expect(calls).not.toContain(GOLDSKY);
  });

  it('one gateway reporting no transactions does not end the search', async () => {
    // Indexes differ. A wallet absent from one gateway is routinely present in
    // another, so "nothing here" from a single endpoint is not authoritative.
    const { modulus, address } = await makeIdentity(17);
    const calls = stubGateways({ [ARWEAVE]: 'no-edges', [TURBO]: modulus });

    await expect(lookupArweaveModulus(address)).resolves.toBe(modulus);
    expect(calls).toHaveLength(2);
  });

  it('an HTTP failure on one gateway still lets the next one answer', async () => {
    const { modulus, address } = await makeIdentity(23);
    stubGateways({ [ARWEAVE]: 'http-error', [TURBO]: modulus });

    await expect(lookupArweaveModulus(address)).resolves.toBe(modulus);
  });
});

describe('lookupArweaveModulus — failure reporting', () => {
  it('a sentinel everywhere reads as "no key found", never as a decode error', async () => {
    const { address } = await makeIdentity(29);
    stubGateways({ [ARWEAVE]: '<not-found>', [TURBO]: '<not-found>' });

    // The whole point: the user must not see `InvalidCharacterError`.
    await expect(lookupArweaveModulus(address)).rejects.toThrow(
      /Could not find a public key for this Arweave address/,
    );
    await expect(lookupArweaveModulus(address)).rejects.not.toThrow(/Invalid character/i);
  });

  it('no transactions anywhere reports the recoverable "send one and try again"', async () => {
    const { address } = await makeIdentity(31);
    stubGateways({ [ARWEAVE]: 'no-edges', [TURBO]: 'no-edges' });

    await expect(lookupArweaveModulus(address)).rejects.toThrow(/send one and try again/);
  });

  it('a modulus that does not hash to the address is reported, not returned', async () => {
    const wrong = await makeIdentity(41);
    const victim = await makeIdentity(42);
    stubGateways({ [ARWEAVE]: wrong.modulus, [TURBO]: wrong.modulus });

    await expect(lookupArweaveModulus(victim.address)).rejects.toThrow(
      /does not match the address/,
    );
  });

  it('a mismatching gateway cannot deny a claim an honest gateway can serve', async () => {
    // Security control MEDIUM-2 must not become a denial-of-service lever: one
    // bad answer is survivable as long as somebody returns the right key.
    const wrong = await makeIdentity(43);
    const real = await makeIdentity(44);
    stubGateways({ [ARWEAVE]: wrong.modulus, [TURBO]: real.modulus });

    await expect(lookupArweaveModulus(real.address)).resolves.toBe(real.modulus);
  });

  it('only gateway breakage reports as gateway breakage', async () => {
    const { address } = await makeIdentity(53);
    stubGateways({ [ARWEAVE]: 'http-error', [TURBO]: 'http-error' });

    await expect(lookupArweaveModulus(address)).rejects.toThrow(
      /All Arweave GraphQL gateways failed/,
    );
  });
});
