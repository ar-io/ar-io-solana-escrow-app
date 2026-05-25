/**
 * HTTP client for the AR.IO escrow attestor service.
 *
 * The `@ar.io/sdk/solana` package does not (yet) ship an attestor HTTP
 * client, so this stays app-side. It is transport-only (fetch + bs58)
 * and carries no `@solana/web3.js` dependency. If the SDK later exports
 * an `EscrowAttestorClient`, this can be replaced by it.
 *
 * The attestor verifies Arweave RSA-PSS signatures off-chain and
 * re-signs the canonical claim message with Ed25519. The on-chain
 * `claim_*_arweave_attested` instructions then verify the cheap
 * Ed25519 signature via Solana's native sigverify program (~720 CU)
 * instead of the impossibly expensive RSA-PSS-4096 modexp.
 *
 * See `migration/attestor/README.md` for the service contract,
 * `docs/DECISIONS.md` ADR-017 for the architecture rationale.
 */

import bs58 from 'bs58';

export type AttestationClaimKind = 'ant' | 'token' | 'vault';

interface AttestationCommon {
  claimantBase58: string;
  /** 64-char lowercase hex encoding of the 32-byte nonce. */
  nonceHex: string;
  rsaModulusBase64Url: string;
  rsaSignatureBase64Url: string;
  saltLength: 0 | 32;
}

export interface AntAttestationRequest extends AttestationCommon {
  claimKind: 'ant';
  antMintBase58: string;
}

export interface EscrowAttestationRequest extends AttestationCommon {
  claimKind: 'token' | 'vault';
  /** 64-char hex encoding of the 32-byte deposit identifier. */
  assetIdHex: string;
  /** u64 amount as decimal string (avoids JS Number precision loss). */
  amount: string;
}

export type AttestationRequest =
  | AntAttestationRequest
  | EscrowAttestationRequest;

export interface AttestationResponse {
  /** 32-byte Ed25519 pubkey, base58. Must match the program's
   *  compiled-in `ATTESTOR_PUBKEY` constant. */
  attestorPubkeyBase58: string;
  /** 64-byte Ed25519 signature over the canonical message, base64url. */
  attestationSignatureBase64Url: string;
  /** The exact bytes the attestor signed, base64url. */
  canonicalMessageBase64Url: string;
}

export interface AttestorHealth {
  ok: boolean;
  network: string;
  attestorPubkeyBase58: string;
}

export interface AttestorClientConfig {
  /** Base URL of the attestor service (no trailing slash). */
  url: string;
  /**
   * Network the page expects the attestor to be configured for. If
   * set, the first `attest()` call fetches `/health` and rejects if
   * the attestor's `network` doesn't match. Catches the easy-to-miss
   * misconfiguration where on-chain program, attestor, and the SDK
   * caller disagree on which network the canonical message is bound
   * to (the on-chain Ed25519 introspection would silently fail to
   * verify in that case).
   */
  expectNetwork?: string;
  /** Optional request timeout (ms). Defaults to 10 000. */
  timeoutMs?: number;
}

export class AttestorClient {
  private readonly url: string;
  private readonly expectNetwork?: string;
  private readonly timeoutMs: number;
  private networkVerified?: true;

  constructor(config: AttestorClientConfig) {
    this.url = config.url.replace(/\/+$/, '');
    this.expectNetwork = config.expectNetwork;
    this.timeoutMs = config.timeoutMs ?? 10_000;
  }

  async health(): Promise<AttestorHealth> {
    const res = await this.fetchWithTimeout(`${this.url}/health`, {
      method: 'GET',
      headers: { Accept: 'application/json' },
    });
    if (!res.ok) {
      throw new Error(
        `attestor /health returned ${res.status}: ${await safeText(res)}`,
      );
    }
    const json = await res.json();
    if (
      typeof json?.ok !== 'boolean' ||
      typeof json?.network !== 'string' ||
      typeof json?.attestorPubkeyBase58 !== 'string'
    ) {
      throw new Error('attestor /health returned malformed response');
    }
    return json as AttestorHealth;
  }

  /** Verify `health.network === expectNetwork`. Memoised so it only
   *  runs once per client. Throws on mismatch. */
  async verifyNetwork(): Promise<void> {
    if (!this.expectNetwork) return;
    if (this.networkVerified) return;
    const health = await this.health();
    if (health.network !== this.expectNetwork) {
      throw new Error(
        `attestor is configured for network "${health.network}", but the page expects "${this.expectNetwork}". The attestor and the on-chain program must agree on the network — refusing to send claims to avoid silent on-chain verification failure.`,
      );
    }
    this.networkVerified = true;
  }

  async attest(req: AttestationRequest): Promise<AttestationResponse> {
    await this.verifyNetwork();

    const res = await this.fetchWithTimeout(`${this.url}/attest`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      body: JSON.stringify(req),
    });

    if (!res.ok) {
      const body = await safeJson(res);
      const code = body?.error ?? 'UNKNOWN';
      const message = body?.message ?? (await safeText(res));
      throw new Error(
        `attestor /attest returned ${res.status} ${code}: ${message}`,
      );
    }

    const json = await res.json();
    return validateAttestationResponse(json);
  }

  private async fetchWithTimeout(
    url: string,
    init: RequestInit,
  ): Promise<Response> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), this.timeoutMs);
    try {
      return await fetch(url, { ...init, signal: ac.signal });
    } catch (e) {
      if ((e as Error)?.name === 'AbortError') {
        throw new Error(
          `attestor request to ${url} timed out after ${this.timeoutMs}ms`,
        );
      }
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }
}

function safeJson(res: Response): Promise<any> {
  return res.json().catch(() => undefined);
}

function safeText(res: Response): Promise<string> {
  return res.text().catch(() => '');
}

function validateAttestationResponse(json: unknown): AttestationResponse {
  if (
    !json ||
    typeof json !== 'object' ||
    typeof (json as any).attestorPubkeyBase58 !== 'string' ||
    typeof (json as any).attestationSignatureBase64Url !== 'string' ||
    typeof (json as any).canonicalMessageBase64Url !== 'string'
  ) {
    throw new Error(
      'attestor returned malformed response (missing fields or wrong types)',
    );
  }
  const r = json as AttestationResponse;

  // Pubkey must decode to exactly 32 bytes (Ed25519 public key).
  let pubkeyBytes: Uint8Array;
  try {
    pubkeyBytes = bs58.decode(r.attestorPubkeyBase58);
  } catch {
    throw new Error('attestor returned non-base58 attestorPubkeyBase58');
  }
  if (pubkeyBytes.length !== 32) {
    throw new Error(
      `attestor returned pubkey of length ${pubkeyBytes.length}, expected 32`,
    );
  }

  // Signature must decode to exactly 64 bytes (Ed25519 signature).
  let sigBytes: Uint8Array;
  try {
    sigBytes = base64UrlToBytes(r.attestationSignatureBase64Url);
  } catch {
    throw new Error('attestor returned non-base64url attestationSignature');
  }
  if (sigBytes.length !== 64) {
    throw new Error(
      `attestor returned signature of length ${sigBytes.length}, expected 64`,
    );
  }

  // Message must decode to a non-empty buffer.
  let messageBytes: Uint8Array;
  try {
    messageBytes = base64UrlToBytes(r.canonicalMessageBase64Url);
  } catch {
    throw new Error('attestor returned non-base64url canonicalMessage');
  }
  if (messageBytes.length === 0) {
    throw new Error('attestor returned empty canonicalMessage');
  }

  return r;
}

// ---------------------------------------------------------------------------
// Encoding helpers (kept local so this file is self-contained)
// ---------------------------------------------------------------------------

export function bytesToBase64Url(bytes: Uint8Array): string {
  let binary = '';
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  const b64 = btoa(binary);
  return b64.replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

export function base64UrlToBytes(s: string): Uint8Array {
  const padded =
    s.replace(/-/g, '+').replace(/_/g, '/') +
    '==='.slice(0, (4 - (s.length % 4)) % 4);
  const binary = atob(padded);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
  return out;
}

export function bytesToHexLower(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    s += (b >>> 4).toString(16);
    s += (b & 0x0f).toString(16);
  }
  return s;
}
