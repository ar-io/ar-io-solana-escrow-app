/**
 * HTTP client for the centralized `ar-io-claims` service.
 *
 * This is the single backend the app talks to. It replaces the removed
 * on-chain Solana RPC + attestor round-trips: the same claim rules are now
 * enforced server-side, and a valid recipient-key signature over the
 * server-issued canonical IS the authorization to dispense (no client-built
 * Solana transaction).
 *
 * Endpoints (attestor SPEC.md, M3):
 *   GET  /v1/claimable?protocol=&address=  | ?recipientId=  — lookup by identity
 *   GET  /v1/assets/:assetKey                               — single asset
 *   POST /v1/claims/initiate                                — issue challenge + canonical
 *   POST /v1/claims/complete                                — verify proof + consume
 *   GET  /v1/claims/:claimId                                — claim status
 *   GET  /health                                            — service health
 *
 * Deliberately self-contained (fetch only, no other service imports) so it is
 * importable in isolation and drivable from a headless test.
 */

// ---------------------------------------------------------------------------
// Base URL resolution
// ---------------------------------------------------------------------------

const CLAIMS_URL_KEY = 'claims-api-url';
let urlOverride: string | undefined;

/** Test/harness hook: force the base URL (bypasses env + localStorage). */
export function setClaimsApiUrlOverride(url: string | undefined): void {
  urlOverride = url;
}

/** Read `VITE_CLAIMS_API_URL` (literal access so Vite statically inlines it)
 *  without throwing under plain Node, where `import.meta.env` is undefined. */
function viteClaimsApiUrl(): string | undefined {
  try {
    return (import.meta as unknown as { env?: { VITE_CLAIMS_API_URL?: string } })
      .env?.VITE_CLAIMS_API_URL;
  } catch {
    return undefined;
  }
}

/**
 * Resolve the claims API base URL (no trailing slash). Order:
 * test override → localStorage → `VITE_CLAIMS_API_URL` → undefined.
 * Returns `undefined` when unconfigured (the app then surfaces the
 * claims-service-not-configured banner).
 */
export function getClaimsApiUrl(): string | undefined {
  const raw =
    urlOverride ??
    (typeof localStorage !== 'undefined'
      ? localStorage.getItem(CLAIMS_URL_KEY) ?? undefined
      : undefined) ??
    viteClaimsApiUrl();
  return raw ? raw.replace(/\/+$/, '') : undefined;
}

export function setClaimsApiUrl(url: string): void {
  if (typeof localStorage === 'undefined') return;
  if (url) localStorage.setItem(CLAIMS_URL_KEY, url);
  else localStorage.removeItem(CLAIMS_URL_KEY);
}

function requireUrl(): string {
  const url = getClaimsApiUrl();
  if (!url) {
    throw new ClaimsApiError(
      0,
      'CLAIMS_API_NOT_CONFIGURED',
      'Claims service not configured. Set VITE_CLAIMS_API_URL (or the URL in the menu) and reload.',
    );
  }
  return url;
}

// ---------------------------------------------------------------------------
// Error type
// ---------------------------------------------------------------------------

export class ClaimsApiError extends Error {
  constructor(
    public readonly status: number,
    public readonly code: string,
    message: string,
  ) {
    super(message);
    this.name = 'ClaimsApiError';
  }
}

// ---------------------------------------------------------------------------
// Wire types (attestor SPEC.md M3 shapes)
// ---------------------------------------------------------------------------

export type ClaimProtocol = 'arweave' | 'ethereum';
export type ClaimAssetType = 'ant' | 'token' | 'vault';

export interface ClaimableAssetView {
  assetKey: string;
  assetType: ClaimAssetType;
  /** base58 ANT mint for `ant` assets; null otherwise. Equals `assetKey`. */
  antMint: string | null;
  /** ANT's on-chain ArNS name (MPL Core `name`); null for token/vault or un-backfilled ANTs. Display-only. */
  name: string | null;
  /** mARIO decimal string for token/vault; null for ANTs. */
  amount: string | null;
  vaultEndTimestamp: number | null;
  nonceHex: string;
  /** Asset lifecycle: `available` (self-serve) or `claimed` (history, when includeClaimed). */
  status: string;
  /** For a `claimed` asset: the winning claim's status (e.g. `confirmed`); null otherwise. */
  claimStatus: string | null;
  /** For a `claimed` asset: the on-chain dispatch tx signature (for an explorer link); null otherwise. */
  claimTx: string | null;
}

export interface ClaimableResult {
  recipientId: string;
  protocol: ClaimProtocol;
  sourceAddress: string;
  assets: ClaimableAssetView[];
}

export interface InitiateResult {
  claimId: string;
  status: string;
  assetKey: string;
  claimant: string;
  protocol: ClaimProtocol;
  recipientId: string;
  network: string;
  /** Single-use challenge nonce bound into the signature (64-hex). */
  nonceHex: string;
  canonicalMessageHex: string;
  canonicalMessageBase64: string;
  expiresAt: string;
  /** The exact canonical bytes to sign (decoded from canonicalMessageHex). */
  canonicalMessageBytes: Uint8Array;
}

export interface CompleteResult {
  claimId: string;
  status: 'verified' | 'pending_review';
  assetKey: string;
  claimant: string;
  settlement: string | null;
  idempotentReplay: boolean;
}

export interface ClaimStatusView {
  claimId: string;
  assetKey: string;
  claimant: string;
  protocol: ClaimProtocol | null;
  status: string;
  settlement: string | null;
  txSignatures: string[];
  error: string | null;
  createdAt: string;
  verifiedAt: string | null;
  confirmedAt: string | null;
}

export interface ClaimsHealth {
  ok: boolean;
  service?: string;
  network?: string;
}

// ---------------------------------------------------------------------------
// Transport
// ---------------------------------------------------------------------------

const DEFAULT_TIMEOUT_MS = 15_000;

async function request<T>(
  path: string,
  init: RequestInit = {},
  timeoutMs = DEFAULT_TIMEOUT_MS,
): Promise<T> {
  const url = `${requireUrl()}${path}`;
  const ac = new AbortController();
  const timer = setTimeout(() => ac.abort(), timeoutMs);
  let res: Response;
  try {
    res = await fetch(url, {
      ...init,
      headers: {
        Accept: 'application/json',
        ...(init.body ? { 'Content-Type': 'application/json' } : {}),
        ...(init.headers ?? {}),
      },
      signal: ac.signal,
    });
  } catch (e) {
    if ((e as Error)?.name === 'AbortError') {
      throw new ClaimsApiError(
        0,
        'TIMEOUT',
        `claims request to ${url} timed out after ${timeoutMs}ms`,
      );
    }
    throw new ClaimsApiError(
      0,
      'NETWORK',
      `claims request to ${url} failed: ${(e as Error).message}`,
    );
  } finally {
    clearTimeout(timer);
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  if (!res.ok) {
    const body = json as { error?: string; message?: string } | undefined;
    throw new ClaimsApiError(
      res.status,
      body?.error ?? 'HTTP_ERROR',
      body?.message ?? `claims API returned ${res.status}`,
    );
  }
  return json as T;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export async function getClaimsHealth(): Promise<ClaimsHealth> {
  return request<ClaimsHealth>('/health');
}

/**
 * Look up all claimable assets for an identity. Provide `recipientId` OR
 * `protocol`+`address`. A recipient with nothing claimable resolves to an
 * empty `assets` list rather than throwing, so the discovery UI shows the
 * "no assets found" state gracefully.
 */
export async function getClaimable(params: {
  recipientId?: string;
  protocol?: string;
  address?: string;
  /** Also return the recipient's already-`claimed` assets as history. */
  includeClaimed?: boolean;
}): Promise<ClaimableResult> {
  const q = new URLSearchParams();
  if (params.recipientId) q.set('recipientId', params.recipientId);
  if (params.protocol) q.set('protocol', params.protocol);
  if (params.address) q.set('address', params.address);
  if (params.includeClaimed) q.set('includeClaimed', '1');
  try {
    return await request<ClaimableResult>(`/v1/claimable?${q.toString()}`);
  } catch (e) {
    // 404 RECIPIENT_NOT_FOUND == "this wallet has nothing to claim" — a normal
    // empty result for discovery, not an error.
    if (e instanceof ClaimsApiError && e.status === 404) {
      return {
        recipientId: params.recipientId ?? '',
        protocol: (params.protocol as ClaimProtocol) ?? 'arweave',
        sourceAddress: params.address ?? '',
        assets: [],
      };
    }
    throw e;
  }
}

/** Fetch a single asset by key. Returns `null` when absent / hidden (404). */
export async function getAsset(
  assetKey: string,
): Promise<ClaimableAssetView | null> {
  try {
    return await request<ClaimableAssetView>(
      `/v1/assets/${encodeURIComponent(assetKey)}`,
    );
  } catch (e) {
    if (e instanceof ClaimsApiError && e.status === 404) return null;
    throw e;
  }
}

/**
 * Start a claim: the server mints a single-use challenge nonce, persists a
 * `claiming` claim bound to (asset, claimant, nonce), and returns the EXACT
 * canonical bytes to sign (server-built from ledger state — never
 * client-supplied). The wallet must sign `canonicalMessageBytes` — but ONLY
 * after the client independently rebuilds + byte-verifies them (see
 * `claim-service.ts`).
 */
export async function initiateClaim(params: {
  assetKey: string;
  claimant: string;
  idempotencyKey?: string;
}): Promise<InitiateResult> {
  const res = await request<Omit<InitiateResult, 'canonicalMessageBytes'>>(
    '/v1/claims/initiate',
    { method: 'POST', body: JSON.stringify(params) },
  );
  return { ...res, canonicalMessageBytes: hexToBytes(res.canonicalMessageHex) };
}

/**
 * Submit the signed proof for a claim. Encodes the wallet signature into the
 * protocol-specific proof shape the API expects.
 *
 * @param signature RSA-PSS (512B) for Arweave, or r||s||v (65B) for Ethereum.
 * @param modulus   Arweave RSA modulus (512B). Optional — the server already
 *                  holds the frozen recipient key; sent for completeness.
 */
export async function completeClaim(params: {
  claimId: string;
  protocol: ClaimProtocol;
  signature: Uint8Array;
  modulus?: Uint8Array;
  saltLength?: 0 | 32;
  nonceHex?: string;
}): Promise<CompleteResult> {
  const proof =
    params.protocol === 'arweave'
      ? {
          protocol: 'arweave' as const,
          rsaSignatureBase64Url: bytesToBase64Url(params.signature),
          ...(params.modulus
            ? { rsaModulusBase64Url: bytesToBase64Url(params.modulus) }
            : {}),
          saltLength: params.saltLength ?? 32,
        }
      : {
          protocol: 'ethereum' as const,
          signatureHex: '0x' + bytesToHex(params.signature),
        };

  return request<CompleteResult>('/v1/claims/complete', {
    method: 'POST',
    body: JSON.stringify({
      claimId: params.claimId,
      ...(params.nonceHex ? { nonceHex: params.nonceHex } : {}),
      proof,
    }),
  });
}

export async function getClaim(claimId: string): Promise<ClaimStatusView> {
  return request<ClaimStatusView>(`/v1/claims/${encodeURIComponent(claimId)}`);
}

/** Statuses that need no further polling. */
const TERMINAL_STATUSES = new Set([
  'confirmed',
  'rejected',
  'failed',
  'expired',
]);

/**
 * Poll `GET /v1/claims/:id` until the claim reaches a terminal state
 * (`confirmed`/`rejected`/`failed`/`expired`) or the timeout elapses. Returns
 * the last observed status. `verified` / `pending_review` / `dispatching` are
 * non-terminal (an on-chain dispatch worker moves them to `confirmed`); the
 * caller decides how to present a still-pending success.
 */
export async function waitForClaim(
  claimId: string,
  opts: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<ClaimStatusView> {
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const intervalMs = opts.intervalMs ?? 1_500;
  const deadline = Date.now() + timeoutMs;
  let last = await getClaim(claimId);
  while (!TERMINAL_STATUSES.has(last.status) && Date.now() < deadline) {
    await sleep(intervalMs);
    last = await getClaim(claimId);
  }
  return last;
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

// ---------------------------------------------------------------------------
// Encoding helpers (Web-Crypto/Node compatible; no DOM-only APIs beyond btoa)
// ---------------------------------------------------------------------------

export function bytesToHex(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] >>> 4).toString(16);
    s += (bytes[i] & 0x0f).toString(16);
  }
  return s;
}

export function hexToBytes(hex: string): Uint8Array {
  let h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) h = '0' + h;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}
