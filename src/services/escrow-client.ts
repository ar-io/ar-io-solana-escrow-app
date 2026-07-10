/**
 * Escrow client for the `ario-ant-escrow` program.
 *
 * The on-chain logic now lives in `@ar.io/sdk/solana` (built on
 * `@solana/kit`); this module is a thin layer over it:
 *
 *  - Re-exports the SDK escrow clients, canonical-message builders, PDA
 *    helpers, and types so pages have a single import site.
 *  - Keeps app-specific helpers the SDK doesn't provide: recipient
 *    parsing/formatting, Arweave RSA-modulus lookup, mARIO formatting.
 *  - Keeps raw-account deserialization + `getProgramAccounts` discovery
 *    scans (the SDK exposes single-account `get()` but no bulk listing),
 *    rewritten on the kit RPC — no `@solana/web3.js`.
 *  - Provides a web3.js-free Ed25519 sigverify instruction and a tx
 *    assembler for the Arweave attested-claim path, which the SDK
 *    intentionally leaves to the caller (see `claimArweaveIx` docs).
 *
 * Program id is configured at runtime — see `./solana.ts`
 * (`getEscrowProgramId`). The SDK ships no escrow program id for any
 * public cluster, so the app must be pointed at a deployment.
 */
import bs58 from 'bs58';
import {
  address,
  AccountRole,
  appendTransactionMessageInstructions,
  createTransactionMessage,
  getAddressEncoder,
  getBase58Decoder,
  getProgramDerivedAddress,
  pipe,
  sendAndConfirmTransactionFactory,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Instruction,
  type TransactionSigner,
} from '@solana/kit';

import type { SolanaRpc, SolanaRpcSubscriptions } from './solana.ts';

// --- SDK re-exports (single import site for pages) -------------------------
// NOTE: `getEscrowAntPDA` is re-defined locally below (the centralized claims
// API keys ANTs by mint, not by an on-chain PDA), so it is intentionally NOT
// re-exported from the SDK here.
export {
  ANTEscrow,
  TokenEscrow,
  canonicalMessage,
  canonicalMessageV2,
  bytesToHexLower,
  getEscrowTokenPDA,
  getEscrowVaultPDA,
} from '@ar.io/sdk/solana';

// --- centralized claims API (F2 service-layer swap) ------------------------
// The discovery/fetch functions below now resolve against the ar-io-claims
// service instead of Solana RPC. Same signatures, same return shapes — the
// pages are unchanged. See `./claims-api.ts` and CENTRALIZED_CLAIM_PIVOT_PLAN.md §5.
import {
  getClaimable as apiGetClaimable,
  deriveRecipientId as apiDeriveRecipientId,
  type ClaimableAssetView,
  type ClaimableResult,
} from './claims-api.ts';
export type {
  EscrowProtocol,
  EscrowAntState,
  EscrowTokenState,
  EscrowAssetType,
  EscrowNetwork,
  CanonicalMessageInput,
  CanonicalMessageV2Input,
} from '@ar.io/sdk/solana';

import {
  canonicalMessage as _canonicalMessage,
  canonicalMessageV2 as _canonicalMessageV2,
  type CanonicalMessageInput,
  type CanonicalMessageV2Input,
  type EscrowProtocol,
  type EscrowAntState,
  type EscrowTokenState,
  type EscrowAssetType,
} from '@ar.io/sdk/solana';

// --- protocol constants (mirror the contract) ------------------------------
export const ESCROW_PROTOCOL_ARWEAVE = 0;
export const ESCROW_PROTOCOL_ETHEREUM = 1;
export const ESCROW_ARWEAVE_PUBKEY_LEN = 512;
export const ESCROW_ETHEREUM_PUBKEY_LEN = 20;

export const ESCROW_ANT_SEED = 'escrow_ant';
export const ESCROW_TOKEN_SEED = 'escrow_token';
export const ESCROW_VAULT_SEED = 'escrow_vault';

/** Account data sizes — used to discriminate ANT vs token/vault escrows. */
export const ESCROW_ANT_ACCOUNT_SIZE = 661;
export const ESCROW_TOKEN_ACCOUNT_SIZE = 711;

/** Solana Ed25519 native sigverify program id. */
export const ED25519_PROGRAM_ID = 'Ed25519SigVerify111111111111111111111111111';

/** Classic SPL Token + Associated Token Account program ids. */
const SPL_TOKEN_PROGRAM_ID = 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';
const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

const SYSTEM_PROGRAM_ID = '11111111111111111111111111111111';

/** Derive the canonical associated token account for `owner` + `mint`
 *  (classic SPL Token program). Kit-native, dependency-free. */
export async function getAtaForOwner(
  owner: Address,
  mint: Address,
): Promise<Address> {
  const enc = getAddressEncoder();
  const [ata] = await getProgramDerivedAddress({
    programAddress: address(ATA_PROGRAM_ID),
    seeds: [
      enc.encode(owner),
      enc.encode(address(SPL_TOKEN_PROGRAM_ID)),
      enc.encode(mint),
    ],
  });
  return ata;
}

/**
 * Build an Associated-Token-Account `CreateIdempotent` instruction
 * (kit-native). Used to ensure a claimant's ATA exists before an Arweave
 * token claim — the SDK's high-level claim auto-creates it, but the
 * lower-level `*Ix` builders we assemble by hand for the attestor path
 * do not.
 */
export function buildCreateAtaIdempotentIx(
  payer: Address,
  ata: Address,
  owner: Address,
  mint: Address,
): Instruction {
  return {
    programAddress: address(ATA_PROGRAM_ID),
    accounts: [
      { address: payer, role: AccountRole.WRITABLE_SIGNER },
      { address: ata, role: AccountRole.WRITABLE },
      { address: owner, role: AccountRole.READONLY },
      { address: mint, role: AccountRole.READONLY },
      { address: address(SYSTEM_PROGRAM_ID), role: AccountRole.READONLY },
      { address: address(SPL_TOKEN_PROGRAM_ID), role: AccountRole.READONLY },
    ],
    data: new Uint8Array([1]), // 1 = CreateIdempotent
  };
}

// --- canonical-message preview wrappers ------------------------------------
export function canonicalMessagePreview(input: CanonicalMessageInput): string {
  return new TextDecoder().decode(_canonicalMessage(input));
}
export function canonicalMessageV2Preview(
  input: CanonicalMessageV2Input,
): string {
  return new TextDecoder().decode(_canonicalMessageV2(input));
}

// ---------------------------------------------------------------------------
// Recipient parsing / formatting (app-specific; pure JS, no web3.js)
// ---------------------------------------------------------------------------

const ARWEAVE_GQL_ENDPOINTS = [
  'https://turbo-gateway.com/graphql',
  'https://arweave-search.goldsky.com/graphql',
];

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
  if (!edges || edges.length === 0) throw new Error('no_transactions');
  const ownerKey: string | undefined = edges[0]?.node?.owner?.key;
  if (!ownerKey) throw new Error('owner key missing from response');
  return ownerKey;
}

/**
 * Look up an Arweave wallet's RSA public key (the "n" modulus) via
 * Arweave GraphQL. Verifies the returned modulus actually hashes to the
 * requested address (guards against a compromised/MITMed gateway).
 */
export async function lookupArweaveModulus(addrInput: string): Promise<string> {
  const addr = addrInput.trim();
  let lastError: Error | undefined;

  for (const endpoint of ARWEAVE_GQL_ENDPOINTS) {
    try {
      const modulus = await queryOwnerKey(endpoint, addr);
      const modulusBytes = base64urlToBytes(modulus);
      const hash = new Uint8Array(
        await crypto.subtle.digest('SHA-256', modulusBytes as BufferSource),
      );
      const derived = bytesToBase64url(hash);
      if (derived !== addr) {
        throw new Error(
          `GraphQL returned a modulus that does not match the address. ` +
            `Expected ${addr}, derived ${derived}. The gateway may be compromised.`,
        );
      }
      return modulus;
    } catch (e) {
      lastError = e instanceof Error ? e : new Error(String(e));
      if (lastError.message === 'no_transactions') break;
    }
  }

  if (lastError?.message === 'no_transactions') {
    throw new Error(
      'Could not find public key for this Arweave address. ' +
        'The address may not have any on-chain transactions. ' +
        'Try pasting the RSA public key directly instead.',
    );
  }
  throw new Error(
    `All Arweave GraphQL gateways failed: ${lastError?.message ?? 'unknown error'}`,
  );
}

/** Parse a JWK "n" field (base64url RSA-4096 modulus) into 512 bytes. */
export function parseArweaveRecipient(input: string): Uint8Array {
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
  if (bytes.length !== ESCROW_ARWEAVE_PUBKEY_LEN) {
    throw new Error(
      `Arweave RSA modulus must be ${ESCROW_ARWEAVE_PUBKEY_LEN} bytes, got ${bytes.length}. ` +
        'Paste the base64url-encoded RSA public key or an Arweave address.',
    );
  }
  return bytes;
}

/** Parse a 0x-prefixed Ethereum address into 20 bytes. */
export function parseEthereumRecipient(input: string): Uint8Array {
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

/** Format a recipient pubkey for display. */
export function formatRecipientPubkey(
  protocol: EscrowProtocol,
  pubkey: Uint8Array,
): string {
  if (protocol === 'ethereum') {
    return (
      '0x' +
      Array.from(pubkey)
        .map((b) => b.toString(16).padStart(2, '0'))
        .join('')
    );
  }
  const b64 = bytesToBase64url(pubkey);
  return b64.length > 24 ? `${b64.slice(0, 24)}...` : b64;
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

// ---------------------------------------------------------------------------
// Raw-account deserialization (mirrors the contract state.rs layout)
// ---------------------------------------------------------------------------

function deserializeEscrowAnt(data: Uint8Array): EscrowAntState {
  let offset = 8; // skip Anchor discriminator
  const version = data[offset++];
  const bump = data[offset++];
  const depositor = bs58.encode(data.slice(offset, offset + 32)) as Address;
  offset += 32;
  const antMint = bs58.encode(data.slice(offset, offset + 32)) as Address;
  offset += 32;
  const recipientProtocol: EscrowProtocol =
    data[offset++] === ESCROW_PROTOCOL_ARWEAVE ? 'arweave' : 'ethereum';
  const recipientPubkeyLen = data[offset] | (data[offset + 1] << 8);
  offset += 2;
  const recipientPubkey = new Uint8Array(
    data.slice(offset, offset + 512).subarray(0, recipientPubkeyLen),
  );
  offset += 512;
  const nonce = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;
  const depositSlot = new DataView(
    data.buffer,
    data.byteOffset + offset,
    8,
  ).getBigUint64(0, true);
  return {
    version,
    bump,
    depositor,
    antMint,
    recipientProtocol,
    recipientPubkey,
    nonce,
    depositSlot,
  };
}

export function deserializeEscrowToken(data: Uint8Array): EscrowTokenState {
  let offset = 8;
  const version = data[offset++];
  const bump = data[offset++];
  const depositor = bs58.encode(data.slice(offset, offset + 32)) as Address;
  offset += 32;
  const assetType: EscrowAssetType = data[offset++] === 1 ? 'token' : 'vault';
  const amount = new DataView(
    data.buffer,
    data.byteOffset + offset,
    8,
  ).getBigUint64(0, true);
  offset += 8;
  const arioMint = bs58.encode(data.slice(offset, offset + 32)) as Address;
  offset += 32;
  const assetId = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;
  const recipientProtocol: EscrowProtocol =
    data[offset++] === ESCROW_PROTOCOL_ARWEAVE ? 'arweave' : 'ethereum';
  const recipientPubkeyLen = data[offset] | (data[offset + 1] << 8);
  offset += 2;
  const recipientPubkey = new Uint8Array(
    data.slice(offset, offset + 512).subarray(0, recipientPubkeyLen),
  );
  offset += 512;
  const nonce = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;
  const depositSlot = new DataView(
    data.buffer,
    data.byteOffset + offset,
    8,
  ).getBigUint64(0, true);
  offset += 8;
  const vaultEndTimestamp = new DataView(
    data.buffer,
    data.byteOffset + offset,
    8,
  ).getBigInt64(0, true);
  offset += 8;
  const vaultRevocable = data[offset++] !== 0;
  return {
    version,
    bump,
    depositor,
    assetType,
    amount,
    arioMint,
    assetId,
    recipientProtocol,
    recipientPubkey,
    nonce,
    depositSlot,
    vaultEndTimestamp,
    vaultRevocable,
  };
}

// ---------------------------------------------------------------------------
// Discovery scans on the kit RPC (the SDK has no bulk listing)
// ---------------------------------------------------------------------------

/** Union of ANT and token/vault escrow results. */
export type EscrowResult =
  | { type: 'ant'; antMint: string; state: EscrowAntState }
  | { type: 'token'; assetId: string; state: EscrowTokenState };

/** Decode a kit account `data` field ([base64, 'base64']) to bytes. */
function decodeAccountData(data: unknown): Uint8Array {
  if (Array.isArray(data) && typeof data[0] === 'string') {
    const binary = atob(data[0]);
    const out = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) out[i] = binary.charCodeAt(i);
    return out;
  }
  return new Uint8Array();
}

/**
 * Fetch a single escrow account by identifier, as raw `state.rs`-layout
 * bytes so the existing deserializers keep working. Backed by the claims
 * API (`GET /v1/assets/:key`, enriched from any prior `/v1/claimable`
 * discovery) — `rpc`/`programId` are accepted for signature compatibility
 * and ignored.
 */
export async function fetchRawEscrowAccount(
  _rpc: SolanaRpc,
  key: string,
  _programId: string,
): Promise<{ data: Uint8Array; size: number } | null> {
  const resolved = await resolveAsset(key);
  if (!resolved) return null;
  const data =
    resolved.kind === 'ant'
      ? serializeEscrowAntState(resolved.antState)
      : serializeEscrowTokenState(resolved.tokenState);
  return { data, size: data.length };
}

/** Fetch the ANT escrow state for an ANT mint, or null. Claims-API backed. */
export async function fetchEscrowState(
  _rpc: SolanaRpc,
  key: string,
  _programId: string,
): Promise<EscrowAntState | null> {
  const resolved = await resolveAsset(key);
  return resolved && resolved.kind === 'ant' ? resolved.antState : null;
}

// ---------------------------------------------------------------------------
// Claims-API asset resolution + synthesis
//
// The pages consume `EscrowAntState` / `EscrowTokenState` (and raw
// `state.rs` bytes). The centralized API returns higher-level asset views
// with no recipient bytes or protocol on the single-asset endpoint, so we
// enrich from discovery (`/v1/claimable`, which DOES carry protocol +
// recipient bytes) and cache the result. A directly-pasted identifier with
// no prior discovery resolves best-effort (protocol defaults to arweave;
// recipient bytes empty) — the primary UX connects a wallet first, which
// populates the cache with the correct protocol.
// ---------------------------------------------------------------------------

/** Mainnet ARIO SPL mint — display-only placeholder for synthesized token
 *  state (the centralized claim path no longer touches SPL token accounts). */
const MAINNET_ARIO_MINT = 'ARiotkVQiLCdng5y3Grf8XLfXJiAR4Dqfsrfcbq5Zo3';
/** Display-only placeholder depositor (assets are held by the AR.IO
 *  authority in the centralized model; the API does not expose a depositor). */
const PLACEHOLDER_DEPOSITOR = '11111111111111111111111111111111';

type ResolvedAsset =
  | { kind: 'ant'; antState: EscrowAntState }
  | { kind: 'token'; tokenState: EscrowTokenState };

const assetCache = new Map<string, ResolvedAsset>();

function hexToBytesLocal(hex: string): Uint8Array {
  let h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) h = '0' + h;
  const out = new Uint8Array(h.length / 2);
  for (let i = 0; i < out.length; i++) {
    out[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return out;
}

/** If `key` is a base58 string decoding to 32 bytes, return its 64-hex form
 *  (the token/vault assetKey shape the API uses); else undefined. */
function base58KeyToHex(key: string): string | undefined {
  try {
    const bytes = bs58.decode(key);
    if (bytes.length !== 32) return undefined;
    return bytesToHexLowerLocal(bytes);
  } catch {
    return undefined;
  }
}

function synthAntState(
  view: ClaimableAssetView,
  protocol: EscrowProtocol,
  recipientBytes: Uint8Array,
): EscrowAntState {
  return {
    version: 1,
    bump: 255,
    depositor: address(PLACEHOLDER_DEPOSITOR),
    antMint: address(view.antMint ?? view.assetKey),
    recipientProtocol: protocol,
    recipientPubkey: recipientBytes,
    nonce: hexToBytesLocal(view.nonceHex),
    depositSlot: 0n,
  };
}

function synthTokenState(
  view: ClaimableAssetView,
  protocol: EscrowProtocol,
  recipientBytes: Uint8Array,
): EscrowTokenState {
  return {
    version: 1,
    bump: 255,
    depositor: address(PLACEHOLDER_DEPOSITOR),
    assetType: view.assetType === 'vault' ? 'vault' : 'token',
    amount: view.amount ? BigInt(view.amount) : 0n,
    arioMint: address(MAINNET_ARIO_MINT),
    assetId: hexToBytesLocal(view.assetKey),
    recipientProtocol: protocol,
    recipientPubkey: recipientBytes,
    nonce: hexToBytesLocal(view.nonceHex),
    depositSlot: 0n,
    vaultEndTimestamp: view.vaultEndTimestamp ? BigInt(view.vaultEndTimestamp) : 0n,
    vaultRevocable: false,
  };
}

/** Build + cache a `ResolvedAsset` from an API view, under every alias the
 *  pages might carry (ANT: mint base58; token/vault: 64-hex AND base58(id)). */
function cacheResolved(
  view: ClaimableAssetView,
  protocol: EscrowProtocol,
  recipientBytes: Uint8Array,
): ResolvedAsset {
  if (view.assetType === 'ant') {
    const antState = synthAntState(view, protocol, recipientBytes);
    const entry: ResolvedAsset = { kind: 'ant', antState };
    assetCache.set(String(antState.antMint), entry);
    assetCache.set(view.assetKey, entry);
    return entry;
  }
  const tokenState = synthTokenState(view, protocol, recipientBytes);
  const entry: ResolvedAsset = { kind: 'token', tokenState };
  assetCache.set(view.assetKey, entry); // 64-hex
  assetCache.set(bs58.encode(tokenState.assetId), entry); // base58(assetId)
  return entry;
}

/**
 * Resolve a page identifier to escrow state from the discovery cache only.
 *
 * A cache hit means the asset was discovered via `GET /v1/claimable` (which
 * carries the true protocol + recipient bytes). On a miss — a deep-linked or
 * pasted identifier we have not discovered — we return `null` rather than
 * fabricating a protocol from `GET /v1/assets` (that endpoint omits protocol,
 * and guessing "arweave" would strand an Ethereum recipient on the wrong
 * signer). `null` routes the claim UI to connect a wallet, which resolves the
 * asset with its real protocol via `/v1/claimable`. (Pivot plan §5.)
 */
async function resolveAsset(key: string): Promise<ResolvedAsset | null> {
  const cached = assetCache.get(key);
  if (cached) return cached;
  const hexKey = base58KeyToHex(key);
  if (hexKey) {
    const viaHex = assetCache.get(hexKey);
    if (viaHex) return viaHex;
  }
  return null;
}

/** In-flight de-dupe for the two claimable calls the claim page fires in
 *  parallel (ANT + token/vault) for one connected wallet. */
const claimableInflight = new Map<string, Promise<ClaimableResult>>();

async function claimableForRecipient(
  recipientBytes: Uint8Array,
): Promise<ClaimableResult> {
  const recipientId = await apiDeriveRecipientId(recipientBytes);
  let inflight = claimableInflight.get(recipientId);
  if (!inflight) {
    inflight = apiGetClaimable({ recipientId }).finally(() => {
      // Clear shortly after so a later refresh re-fetches.
      setTimeout(() => claimableInflight.delete(recipientId), 3_000);
    });
    claimableInflight.set(recipientId, inflight);
  }
  return inflight;
}

/**
 * Identity-agnostic derivation of the "PDA" address for an ANT mint. In the
 * centralized model ANTs are keyed by mint, not by an on-chain PDA, so this
 * is the identity (kept for `LookupPage` signature compatibility).
 */
export async function getEscrowAntPDA(
  antMint: Address,
  _programId: Address,
): Promise<[Address, number]> {
  return [antMint, 255];
}

// ---------------------------------------------------------------------------
// state.rs re-serialization (inverse of the deserializers above) — lets the
// synthesized API state flow through the pages' existing raw-bytes decoders.
// ---------------------------------------------------------------------------

function serializeEscrowAntState(s: EscrowAntState): Uint8Array {
  const data = new Uint8Array(ESCROW_ANT_ACCOUNT_SIZE);
  const view = new DataView(data.buffer);
  let o = 8; // discriminator (zeroed)
  data[o++] = s.version & 0xff;
  data[o++] = s.bump & 0xff;
  data.set(bs58.decode(String(s.depositor)), o); o += 32;
  data.set(bs58.decode(String(s.antMint)), o); o += 32;
  data[o++] = s.recipientProtocol === 'arweave' ? ESCROW_PROTOCOL_ARWEAVE : ESCROW_PROTOCOL_ETHEREUM;
  view.setUint16(o, s.recipientPubkey.length, true); o += 2;
  data.set(s.recipientPubkey.slice(0, 512), o); o += 512;
  data.set(s.nonce.slice(0, 32), o); o += 32;
  view.setBigUint64(o, s.depositSlot, true);
  return data;
}

function serializeEscrowTokenState(s: EscrowTokenState): Uint8Array {
  const data = new Uint8Array(ESCROW_TOKEN_ACCOUNT_SIZE);
  const view = new DataView(data.buffer);
  let o = 8; // discriminator (zeroed)
  data[o++] = s.version & 0xff;
  data[o++] = s.bump & 0xff;
  data.set(bs58.decode(String(s.depositor)), o); o += 32;
  data[o++] = s.assetType === 'token' ? 1 : 0;
  view.setBigUint64(o, s.amount, true); o += 8;
  data.set(bs58.decode(String(s.arioMint)), o); o += 32;
  data.set(s.assetId.slice(0, 32), o); o += 32;
  data[o++] = s.recipientProtocol === 'arweave' ? ESCROW_PROTOCOL_ARWEAVE : ESCROW_PROTOCOL_ETHEREUM;
  view.setUint16(o, s.recipientPubkey.length, true); o += 2;
  data.set(s.recipientPubkey.slice(0, 512), o); o += 512;
  data.set(s.nonce.slice(0, 32), o); o += 32;
  view.setBigUint64(o, s.depositSlot, true); o += 8;
  view.setBigInt64(o, s.vaultEndTimestamp, true); o += 8;
  data[o++] = s.vaultRevocable ? 1 : 0;
  return data;
}

async function scanProgram(
  rpc: SolanaRpc,
  programId: string,
  memcmps: Array<{ offset: number; bytes: string }>,
): Promise<Array<{ pubkey: string; data: Uint8Array }>> {
  const filters = memcmps.map((m) => ({
    memcmp: {
      offset: BigInt(m.offset),
      bytes: m.bytes,
      encoding: 'base58' as const,
    },
  }));
  try {
    // kit's getProgramAccounts overloads are strict on filter/encoding
    // combos; the runtime shape is `{ pubkey, account: { data: [b64,'base64'] } }[]`.
    const getProgramAccounts = rpc.getProgramAccounts as unknown as (
      program: Address,
      config: unknown,
    ) => { send: () => Promise<unknown> };
    const response = await getProgramAccounts(address(programId), {
      encoding: 'base64',
      filters,
    }).send();
    const list = (
      Array.isArray(response) ? response : ((response as any)?.value ?? [])
    ) as Array<{ pubkey: string; account: { data: unknown } }>;
    return list.map((a) => ({
      pubkey: String(a.pubkey),
      data: decodeAccountData(a.account.data),
    }));
  } catch {
    // Some RPC providers restrict getProgramAccounts.
    return [];
  }
}

/** All ANT escrows deposited by a wallet (memcmp on depositor at offset 10). */
export async function fetchEscrowsByDepositor(
  rpc: SolanaRpc,
  depositorPubkey: string,
  programId: string,
): Promise<Array<{ antMint: string; state: EscrowAntState }>> {
  const accounts = await scanProgram(rpc, programId, [
    { offset: 10, bytes: depositorPubkey },
  ]);
  const results: Array<{ antMint: string; state: EscrowAntState }> = [];
  for (const { data } of accounts) {
    if (data.length === ESCROW_TOKEN_ACCOUNT_SIZE) continue;
    try {
      const state = deserializeEscrowAnt(data);
      results.push({ antMint: state.antMint, state });
    } catch {
      /* skip malformed */
    }
  }
  return results;
}

/** All escrows (ANT + token/vault) deposited by a wallet. */
export async function fetchAllEscrowsByDepositor(
  rpc: SolanaRpc,
  depositorPubkey: string,
  programId: string,
): Promise<EscrowResult[]> {
  const accounts = await scanProgram(rpc, programId, [
    { offset: 10, bytes: depositorPubkey },
  ]);
  const results: EscrowResult[] = [];
  for (const { data } of accounts) {
    try {
      if (data.length === ESCROW_TOKEN_ACCOUNT_SIZE) {
        const state = deserializeEscrowToken(data);
        results.push({ type: 'token', assetId: bytesToHexLowerLocal(state.assetId), state });
      } else {
        const state = deserializeEscrowAnt(data);
        results.push({ type: 'ant', antMint: state.antMint, state });
      }
    } catch {
      /* skip malformed */
    }
  }
  return results;
}

/** All ANT escrows addressed to a recipient identity (claims-API backed:
 *  `GET /v1/claimable` by recipientId = b64url(sha256(recipientBytes))). */
export async function fetchEscrowsByRecipient(
  _rpc: SolanaRpc,
  recipientProtocol: 'arweave' | 'ethereum',
  recipientBytes: Uint8Array,
  _programId: string,
): Promise<Array<{ antMint: string; state: EscrowAntState }>> {
  const result = await claimableForRecipient(recipientBytes);
  const results: Array<{ antMint: string; state: EscrowAntState }> = [];
  for (const view of result.assets) {
    if (view.assetType !== 'ant') continue;
    const entry = cacheResolved(view, recipientProtocol, recipientBytes);
    if (entry.kind === 'ant') {
      results.push({ antMint: String(entry.antState.antMint), state: entry.antState });
    }
  }
  return results;
}

/** A token/vault escrow addressed to a recipient, with its on-chain PDA
 *  (the identifier a recipient uses to claim — token/vault aren't keyed by
 *  a public mint the way ANT escrows are). */
export interface TokenEscrowByRecipient {
  escrowPda: string;
  state: EscrowTokenState;
}

/**
 * All token/vault escrows addressed to a recipient identity. Mirrors
 * `fetchEscrowsByRecipient` but for the 711-byte EscrowToken layout:
 * protocol byte at offset 115, recipient pubkey at offset 118.
 */
export async function fetchTokenEscrowsByRecipient(
  _rpc: SolanaRpc,
  recipientProtocol: 'arweave' | 'ethereum',
  recipientBytes: Uint8Array,
  _programId: string,
): Promise<TokenEscrowByRecipient[]> {
  const result = await claimableForRecipient(recipientBytes);
  const results: TokenEscrowByRecipient[] = [];
  for (const view of result.assets) {
    if (view.assetType === 'ant') continue;
    const entry = cacheResolved(view, recipientProtocol, recipientBytes);
    if (entry.kind === 'token') {
      // The claim identifier the page carries for token/vault is base58(assetId)
      // (a valid Solana Address the pages can wrap in `address()`); the service
      // maps it back to the 64-hex API assetKey.
      results.push({
        escrowPda: bs58.encode(entry.tokenState.assetId),
        state: entry.tokenState,
      });
    }
  }
  return results;
}

// local copy to avoid importing the SDK's bytesToHexLower into the module twice
function bytesToHexLowerLocal(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    s += (bytes[i] >>> 4).toString(16);
    s += (bytes[i] & 0x0f).toString(16);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Arweave attested-claim path (web3.js-free)
// ---------------------------------------------------------------------------

/**
 * Build the Solana Ed25519 native sigverify instruction as a kit
 * `Instruction`, with pubkey/signature/message inline in its own data
 * (every `*_instruction_index` = 0xFFFF / DATA_IN_SAME_IX). The on-chain
 * `claim_*_arweave_attested` introspection requires this ix immediately
 * before the claim ix.
 */
export function buildEd25519SigverifyIx(
  attestorPubkey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Instruction {
  if (attestorPubkey.length !== 32) {
    throw new Error(`attestor pubkey must be 32 bytes, got ${attestorPubkey.length}`);
  }
  if (signature.length !== 64) {
    throw new Error(`signature must be 64 bytes, got ${signature.length}`);
  }
  const HEADER_LEN = 16;
  const PK_OFFSET = HEADER_LEN;
  const SIG_OFFSET = PK_OFFSET + 32;
  const MSG_OFFSET = SIG_OFFSET + 64;
  const SAME_IX = 0xffff;

  const data = new Uint8Array(HEADER_LEN + 32 + 64 + message.length);
  const view = new DataView(data.buffer);
  data[0] = 1; // num_signatures
  data[1] = 0; // padding
  view.setUint16(2, SIG_OFFSET, true);
  view.setUint16(4, SAME_IX, true);
  view.setUint16(6, PK_OFFSET, true);
  view.setUint16(8, SAME_IX, true);
  view.setUint16(10, MSG_OFFSET, true);
  view.setUint16(12, message.length, true);
  view.setUint16(14, SAME_IX, true);
  data.set(attestorPubkey, PK_OFFSET);
  data.set(signature, SIG_OFFSET);
  data.set(message, MSG_OFFSET);

  return {
    programAddress: address(ED25519_PROGRAM_ID),
    accounts: [],
    data,
  };
}

/**
 * Assemble `[ed25519SigverifyIx, claimIx]` into a single transaction,
 * sign it with the connected wallet (`signer`), and submit + confirm via
 * kit. Returns the transaction signature (base58).
 *
 * Used for Arweave attested claims: the SDK's `*ArweaveIx` builders
 * return just the claim ix and require the sibling sigverify ix to be
 * prepended by the caller.
 */
export async function sendInstructions(
  rpc: SolanaRpc,
  rpcSubscriptions: SolanaRpcSubscriptions,
  signer: TransactionSigner,
  instructions: Instruction[],
): Promise<string> {
  const { value: latestBlockhash } = await rpc.getLatestBlockhash().send();
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayerSigner(signer, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash(latestBlockhash, m),
    (m) => appendTransactionMessageInstructions(instructions, m),
  );
  const signed = await signTransactionMessageWithSigners(message);
  const sendAndConfirm = sendAndConfirmTransactionFactory({
    rpc,
    rpcSubscriptions,
  });
  await sendAndConfirm(signed as Parameters<typeof sendAndConfirm>[0], {
    commitment: 'confirmed',
  });
  const sigBytes = signed.signatures[signer.address];
  return getBase58Decoder().decode(sigBytes!);
}
