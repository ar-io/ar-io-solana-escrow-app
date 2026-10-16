/**
 * Recipient-identity helpers for the centralized-claims flow.
 *
 * Pure JS (fetch + Web Crypto only) — no `@solana/kit`, no `@ar.io/sdk`, no
 * on-chain reads. These recover the recipient's raw identity BYTES from a
 * connected wallet so the client can independently rebuild the canonical claim
 * message and byte-compare it against the server's (security control MEDIUM-2):
 *
 *   - Ethereum: the 20-byte address (from the connected wallet, checksum-safe).
 *   - Arweave:  the 512-byte RSA modulus, looked up from the wallet's address
 *     via Arweave GraphQL and verified to hash back to that address.
 *
 * Plus display-only mARIO formatting.
 */

/** RSA-4096 modulus length in bytes (an Arweave recipient identity). */
export const ARWEAVE_MODULUS_LEN = 512;

/**
 * GraphQL endpoints tried in order, first usable answer wins.
 *
 * `arweave.net` leads because it indexes BUNDLED data items (AO process spawns
 * via aoconnect, for instance) and returns an owner key for them. A wallet whose
 * only footprint is AO activity — which is every wallet that only ever made an
 * ANT — has no L1 transaction, and `turbo-gateway` answers such an owner query
 * with the literal string `<not-found>` in place of the key.
 *
 * `arweave-search.goldsky.com` is deliberately absent: it answers with a 307 to
 * `arweave.net/graphql` carrying no `access-control-allow-origin`, so a browser
 * blocks the redirect. It succeeds under `curl -L`, which makes it look healthy
 * from a terminal while never working for a real user.
 */
const ARWEAVE_GQL_ENDPOINTS = [
  'https://arweave.net/graphql',
  'https://turbo-gateway.com/graphql',
];

/** Thrown when a gateway answered, but not with a usable RSA modulus. */
const UNUSABLE_KEY = 'owner_key_unusable';
/** Thrown when a gateway knows of no transaction for the address. */
const NO_TRANSACTIONS = 'no_transactions';

/**
 * True if `key` could be a base64url RSA-4096 modulus.
 *
 * Gateways signal "I have no key for this owner" with a sentinel rather than a
 * null — `turbo-gateway` uses `<not-found>`. A sentinel is truthy, so it slips
 * past a bare presence check and then explodes inside `atob` as
 * `InvalidCharacterError`, which surfaces to the user as an unreadable failure
 * instead of falling through to a gateway that has the key.
 */
function isPlausibleModulus(key: string): boolean {
  if (!/^[A-Za-z0-9_-]+$/.test(key)) return false;
  try {
    return base64urlToBytes(key).length === ARWEAVE_MODULUS_LEN;
  } catch {
    return false;
  }
}

/** Detect a 43-char base64url Arweave address. */
export function isArweaveAddress(input: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(input.trim());
}

async function queryOwnerKey(endpoint: string, addr: string): Promise<string> {
  const query = `{ transactions(owners: ["${addr}"], first: 1) { edges { node { owner { key } } } } }`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) throw new Error(`${response.status} ${response.statusText}`);
  const json = await response.json();
  const edges = json?.data?.transactions?.edges;
  if (!edges || edges.length === 0) throw new Error(NO_TRANSACTIONS);
  const ownerKey: string | undefined = edges[0]?.node?.owner?.key;
  if (!ownerKey) throw new Error(UNUSABLE_KEY);
  // Validate the SHAPE before trusting it as a modulus, so a sentinel is treated
  // as "this gateway does not have it" and the next gateway gets a turn.
  if (!isPlausibleModulus(ownerKey)) throw new Error(UNUSABLE_KEY);
  return ownerKey;
}

/**
 * Look up an Arweave wallet's RSA public key (the "n" modulus) via Arweave
 * GraphQL. Verifies the returned modulus actually hashes to the requested
 * address (guards against a compromised / MITMed gateway).
 */
export async function lookupArweaveModulus(addrInput: string): Promise<string> {
  const addr = addrInput.trim();
  let lastError: Error | undefined;
  let mismatch: Error | undefined;
  // Every endpoint either had no record of the address or had no usable key for
  // it. That is a different (and recoverable) story from "the gateways broke".
  let allMissing = true;

  for (const endpoint of ARWEAVE_GQL_ENDPOINTS) {
    try {
      const modulus = await queryOwnerKey(endpoint, addr);
      const modulusBytes = base64urlToBytes(modulus);
      const hash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', modulusBytes as BufferSource),
      );
      const derived = bytesToBase64url(hash);
      if (derived !== addr) {
        // Keep asking the others: one dishonest or buggy gateway must not deny
        // the claim, but the mismatch is still reported if nobody gets it right.
        mismatch = new Error(
          `GraphQL returned a modulus that does not match the address. ` +
            `Expected ${addr}, derived ${derived}. The gateway may be compromised.`,
        );
        allMissing = false;
        continue;
      }
      return modulus;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      // A single gateway reporting "nothing here" is NOT authoritative: indexes
      // differ, and a wallet whose only activity is bundled (AO) is absent from
      // some of them entirely. Always let the remaining gateways answer.
      if (lastError.message !== NO_TRANSACTIONS && lastError.message !== UNUSABLE_KEY) {
        allMissing = false;
      }
    }
  }

  if (mismatch) throw mismatch;
  if (allMissing) {
    throw new Error(
      'Could not find a public key for this Arweave address. The address may ' +
        'have no on-chain transactions yet — send one and try again.',
    );
  }
  throw new Error(
    `All Arweave GraphQL gateways failed: ${lastError?.message ?? 'unknown error'}`,
  );
}

/** Parse a JWK "n" field (base64url RSA-4096 modulus) into 512 bytes. */
export function parseArweaveModulus(input: string): Uint8Array {
  let nValue = input.trim();
  if (nValue.startsWith('{')) {
    try {
      const jwk = JSON.parse(nValue);
      if (!jwk.n) throw new Error('JWK missing "n" field');
      nValue = jwk.n;
    } catch (e) {
      throw new Error(
        `Failed to parse JWK: ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }
  const bytes = base64urlToBytes(nValue);
  if (bytes.length !== ARWEAVE_MODULUS_LEN) {
    throw new Error(
      `Arweave RSA modulus must be ${ARWEAVE_MODULUS_LEN} bytes, got ${bytes.length}.`,
    );
  }
  return bytes;
}

/** Parse a 0x-prefixed Ethereum address into 20 bytes. */
export function parseEthereumAddress(input: string): Uint8Array {
  let hex = input.trim();
  if (hex.startsWith('0x') || hex.startsWith('0X')) hex = hex.slice(2);
  if (hex.length !== 40) {
    throw new Error(
      `Ethereum address must be 20 bytes (40 hex chars), got ${hex.length} hex chars`,
    );
  }
  const bytes = new Uint8Array(20);
  for (let i = 0; i < 20; i++) {
    bytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

/** Format mARIO (6 decimals) to a display ARIO string. */
export function formatMarioToArio(mARIO: bigint): string {
  const whole = mARIO / 1_000_000n;
  const frac = mARIO % 1_000_000n;
  const fracStr = frac.toString().padStart(6, '0');
  const trimmed = fracStr.replace(/0+$/, '').padEnd(2, '0');
  return `${whole.toString()}.${trimmed}`;
}

// --- base64url helpers ------------------------------------------------------
function base64urlToBytes(b64url: string): Uint8Array {
  const b64 = b64url.replace(/-/g, '+').replace(/_/g, '/');
  const padded = b64 + '='.repeat((4 - (b64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}
function bytesToBase64url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=/g, '');
}
