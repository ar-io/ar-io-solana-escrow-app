/**
 * Local escrow client for the `ario-ant-escrow` program.
 *
 * Mirrors the shape of `ANTEscrow` from `@ar.io/sdk/solana` but is
 * self-contained so the frontend can build before the SDK package
 * ships escrow exports. Once the SDK version with `ANTEscrow` is
 * published, replace this file with a re-export:
 *
 *   export { ANTEscrow, canonicalMessage } from '@ar.io/sdk/solana';
 *
 * TODO: Replace with `@ar.io/sdk/solana` exports once the SDK ships
 * the escrow client (tracked in the same PR as the program deploy).
 */

import bs58 from 'bs58';
import { sha256 } from '@noble/hashes/sha2';

// ---------------------------------------------------------------------------
// Constants — must stay in sync with the contract
// ---------------------------------------------------------------------------

/**
 * Program ID placeholder — the real program ID will be set once the
 * program is deployed to devnet/mainnet. This is the placeholder from
 * `sdk/src/solana/constants.ts`.
 */
export const ESCROW_PROGRAM_ID = 'ARioEscrowXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

export const ESCROW_PROTOCOL_ARWEAVE = 0;
export const ESCROW_PROTOCOL_ETHEREUM = 1;
export const ESCROW_ARWEAVE_PUBKEY_LEN = 512;
export const ESCROW_ETHEREUM_PUBKEY_LEN = 20;

/** PDA seed constants */
export const ESCROW_ANT_SEED = 'escrow_ant';
export const ESCROW_TOKEN_SEED = 'escrow_token';
export const ESCROW_VAULT_SEED = 'escrow_vault';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export type EscrowProtocol = 'arweave' | 'ethereum';

/** Network bound into the canonical message. */
export type EscrowNetwork = 'solana-mainnet' | 'solana-devnet';

export type EscrowAssetType = 'token' | 'vault';

export interface EscrowAntState {
  version: number;
  bump: number;
  depositor: string;
  antMint: string;
  recipientProtocol: EscrowProtocol;
  recipientPubkey: Uint8Array;
  nonce: Uint8Array; // 32 bytes
  depositSlot: bigint;
}

export interface EscrowTokenState {
  version: number;
  bump: number;
  depositor: string;
  assetType: EscrowAssetType;
  amount: bigint;
  arioMint: string;
  assetId: Uint8Array; // 32 bytes
  recipientProtocol: EscrowProtocol;
  recipientPubkey: Uint8Array;
  nonce: Uint8Array; // 32 bytes
  depositSlot: bigint;
  vaultEndTimestamp: bigint;
  vaultRevocable: boolean;
}

/** Account data size constants for discriminating escrow types */
export const ESCROW_ANT_ACCOUNT_SIZE = 661;
export const ESCROW_TOKEN_ACCOUNT_SIZE = 711;

// ---------------------------------------------------------------------------
// PDA derivation
// ---------------------------------------------------------------------------

/**
 * Derive the EscrowAnt PDA address string for a given ANT mint.
 * Seeds: ["escrow_ant", ant_mint_pubkey_bytes]
 *
 * Uses the wallet-adapter's PublicKey which is available globally
 * through the `@solana/web3.js` transitive dep.
 */
export async function getEscrowAntPDA(
  antMint: string,
  programId: string = ESCROW_PROGRAM_ID,
): Promise<string> {
  // Dynamic import to avoid hard dep — web3.js comes via wallet-adapter
  const { PublicKey } = await import('@solana/web3.js');
  const mintPubkey = new PublicKey(antMint);
  const programPubkey = new PublicKey(programId);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(ESCROW_ANT_SEED), mintPubkey.toBuffer()],
    programPubkey,
  );
  return pda.toBase58();
}

/**
 * Derive the EscrowToken PDA address string.
 * Seeds: ["escrow_token", depositor_bytes, asset_id_bytes]
 */
export async function getEscrowTokenPDA(
  depositor: string,
  assetId: Uint8Array,
  programId: string = ESCROW_PROGRAM_ID,
): Promise<string> {
  const { PublicKey } = await import('@solana/web3.js');
  const depositorPubkey = new PublicKey(depositor);
  const programPubkey = new PublicKey(programId);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(ESCROW_TOKEN_SEED), depositorPubkey.toBuffer(), Buffer.from(assetId)],
    programPubkey,
  );
  return pda.toBase58();
}

/**
 * Derive the EscrowVault PDA address string.
 * Seeds: ["escrow_vault", depositor_bytes, asset_id_bytes]
 */
export async function getEscrowVaultPDA(
  depositor: string,
  assetId: Uint8Array,
  programId: string = ESCROW_PROGRAM_ID,
): Promise<string> {
  const { PublicKey } = await import('@solana/web3.js');
  const depositorPubkey = new PublicKey(depositor);
  const programPubkey = new PublicKey(programId);
  const [pda] = PublicKey.findProgramAddressSync(
    [Buffer.from(ESCROW_VAULT_SEED), depositorPubkey.toBuffer(), Buffer.from(assetId)],
    programPubkey,
  );
  return pda.toBase58();
}

// ---------------------------------------------------------------------------
// Canonical message (v1 — ANT escrow)
// ---------------------------------------------------------------------------

// Header MUST match on-chain `ANT_ESCROW_CLAIM_HEADER` byte-for-byte.
// Note: the on-chain header has no `v1` suffix as of the F-1 / naming
// cleanup pass. If you see this drift again, run the cross-test.
const CANONICAL_HEADER = 'ar.io ant-escrow claim';

export interface CanonicalMessageInput {
  network: EscrowNetwork;
  antMint: string;
  claimant: string;
  nonce: Uint8Array; // 32 bytes
  /** Recipient identity bytes — RSA modulus (512 bytes for Arweave)
   *  or 20-byte address (Ethereum). Hashed into the canonical to
   *  bind the signature to the on-chain `escrow.recipient_pubkey`.
   *  Closes F-1 (see docs/ATTESTOR_SECURITY_REVIEW.md). */
  recipientPubkey: Uint8Array;
}

/**
 * Build the canonical claim message bytes. UTF-8 encoded, no trailing
 * newline. Must be byte-identical to the Rust implementation.
 */
export function canonicalMessage(input: CanonicalMessageInput): Uint8Array {
  if (input.nonce.length !== 32) {
    throw new Error(
      `canonicalMessage: nonce must be 32 bytes, got ${input.nonce.length}`,
    );
  }
  if (input.recipientPubkey.length === 0) {
    throw new Error('canonicalMessage: recipientPubkey must be non-empty');
  }

  const text =
    `${CANONICAL_HEADER}\n` +
    `network: ${input.network}\n` +
    `recipient: ${deriveRecipientIdB64UrlSync(input.recipientPubkey)}\n` +
    `ant: ${input.antMint}\n` +
    `claimant: ${input.claimant}\n` +
    `nonce: ${bytesToHexLower(input.nonce)}`;

  return new TextEncoder().encode(text);
}

/** Match Rust `derive_recipient_id_b64url`: SHA-256 the recipient pubkey
 *  and base64url-encode without padding. Deterministic + sync so we
 *  don't need to thread Promises through the canonical builder. */
function deriveRecipientIdB64UrlSync(recipientPubkeyActive: Uint8Array): string {
  const digest = sha256(recipientPubkeyActive);
  let bin = '';
  for (let i = 0; i < digest.length; i++) bin += String.fromCharCode(digest[i]);
  return btoa(bin)
    .replace(/=+$/g, '')
    .replace(/\+/g, '-')
    .replace(/\//g, '_');
}

/** Format the canonical message as a human-readable string (for preview). */
export function canonicalMessagePreview(input: CanonicalMessageInput): string {
  return new TextDecoder().decode(canonicalMessage(input));
}

// ---------------------------------------------------------------------------
// Canonical message (v2 — token / vault escrow)
// ---------------------------------------------------------------------------

// Header MUST match on-chain `ESCROW_CLAIM_HEADER` byte-for-byte.
const CANONICAL_HEADER_V2 = 'ar.io escrow claim';

export interface CanonicalMessageV2Input {
  network: EscrowNetwork;
  type: EscrowAssetType;
  assetId: Uint8Array; // 32 bytes
  amount: bigint; // mARIO
  claimant: string;
  nonce: Uint8Array; // 32 bytes
  /** See `CanonicalMessageInput.recipientPubkey`. */
  recipientPubkey: Uint8Array;
}

/**
 * Build the v2 canonical claim message bytes. UTF-8 encoded, no trailing
 * newline. Must be byte-identical to the Rust implementation.
 */
export function canonicalMessageV2(input: CanonicalMessageV2Input): Uint8Array {
  if (input.nonce.length !== 32) {
    throw new Error(
      `canonicalMessageV2: nonce must be 32 bytes, got ${input.nonce.length}`,
    );
  }
  if (input.assetId.length !== 32) {
    throw new Error(
      `canonicalMessageV2: assetId must be 32 bytes, got ${input.assetId.length}`,
    );
  }
  if (input.recipientPubkey.length === 0) {
    throw new Error('canonicalMessageV2: recipientPubkey must be non-empty');
  }

  const text =
    `${CANONICAL_HEADER_V2}\n` +
    `network: ${input.network}\n` +
    `recipient: ${deriveRecipientIdB64UrlSync(input.recipientPubkey)}\n` +
    `type: ${input.type}\n` +
    `asset: ${bytesToHexLower(input.assetId)}\n` +
    `amount: ${input.amount.toString()}\n` +
    `claimant: ${input.claimant}\n` +
    `nonce: ${bytesToHexLower(input.nonce)}`;

  return new TextEncoder().encode(text);
}

/** Format the v2 canonical message as a human-readable string (for preview). */
export function canonicalMessageV2Preview(input: CanonicalMessageV2Input): string {
  return new TextDecoder().decode(canonicalMessageV2(input));
}

function bytesToHexLower(bytes: Uint8Array): string {
  let s = '';
  for (let i = 0; i < bytes.length; i++) {
    const b = bytes[i];
    s += (b >>> 4).toString(16);
    s += (b & 0x0f).toString(16);
  }
  return s;
}

// ---------------------------------------------------------------------------
// Borsh deserialization for EscrowAnt account (661 bytes)
// ---------------------------------------------------------------------------

/**
 * Deserialize the on-chain EscrowAnt account from raw bytes.
 *
 * Layout (from `programs/ario-ant-escrow/src/state.rs`):
 *   8 bytes discriminator (Anchor)
 *   1 byte  version
 *   1 byte  bump
 *   32 bytes depositor
 *   32 bytes ant_mint
 *   1 byte  recipient_protocol
 *   2 bytes  recipient_pubkey_len (u16 LE)
 *   512 bytes recipient_pubkey (padded)
 *   32 bytes nonce
 *   8 bytes  deposit_slot (u64 LE)
 */
function deserializeEscrowAnt(data: Uint8Array): EscrowAntState {
  // Skip 8-byte Anchor discriminator
  let offset = 8;

  const version = data[offset++];
  const bump = data[offset++];

  const depositorBytes = data.slice(offset, offset + 32);
  offset += 32;
  const depositor = bs58.encode(depositorBytes);

  const antMintBytes = data.slice(offset, offset + 32);
  offset += 32;
  const antMint = bs58.encode(antMintBytes);

  const protocolByte = data[offset++];
  const recipientProtocol: EscrowProtocol =
    protocolByte === ESCROW_PROTOCOL_ARWEAVE ? 'arweave' : 'ethereum';

  // recipient_pubkey_len: u16 LE — active byte count within the 512-byte blob
  const recipientPubkeyLen = data[offset] | (data[offset + 1] << 8);
  offset += 2;

  // The full padded field is 512 bytes; we take only the active prefix
  const fullRecipientPubkey = data.slice(offset, offset + 512);
  offset += 512;

  const recipientPubkey = new Uint8Array(
    fullRecipientPubkey.subarray(0, recipientPubkeyLen),
  );

  const nonce = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;

  const dv = new DataView(data.buffer, data.byteOffset + offset, 8);
  const depositSlot = dv.getBigUint64(0, true); // little-endian

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

// ---------------------------------------------------------------------------
// Borsh deserialization for EscrowToken account (711 bytes)
// ---------------------------------------------------------------------------

/**
 * Deserialize the on-chain EscrowToken account from raw bytes.
 *
 * Layout:
 *   8 bytes  discriminator (Anchor)
 *   1 byte   version
 *   1 byte   bump
 *   32 bytes depositor
 *   1 byte   asset_type (0 = token, 1 = vault)
 *   8 bytes  amount (u64 LE)
 *   32 bytes ario_mint
 *   32 bytes asset_id
 *   1 byte   recipient_protocol
 *   2 bytes  recipient_pubkey_len (u16 LE)
 *   512 bytes recipient_pubkey (padded)
 *   32 bytes nonce
 *   8 bytes  deposit_slot (u64 LE)
 *   8 bytes  vault_end_timestamp (i64 LE)
 *   1 byte   vault_revocable
 *   32 bytes reserved
 */
export function deserializeEscrowToken(data: Uint8Array): EscrowTokenState {
  // Skip 8-byte Anchor discriminator
  let offset = 8;

  const version = data[offset++];
  const bump = data[offset++];

  const depositorBytes = data.slice(offset, offset + 32);
  offset += 32;
  const depositor = bs58.encode(depositorBytes);

  const assetTypeByte = data[offset++];
  // ASSET_TYPE_TOKEN = 1, ASSET_TYPE_VAULT = 2 (from contract state.rs)
  const assetType: EscrowAssetType = assetTypeByte === 1 ? 'token' : 'vault';

  const amountDv = new DataView(data.buffer, data.byteOffset + offset, 8);
  const amount = amountDv.getBigUint64(0, true);
  offset += 8;

  const arioMintBytes = data.slice(offset, offset + 32);
  offset += 32;
  const arioMint = bs58.encode(arioMintBytes);

  const assetId = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;

  const protocolByte = data[offset++];
  const recipientProtocol: EscrowProtocol =
    protocolByte === ESCROW_PROTOCOL_ARWEAVE ? 'arweave' : 'ethereum';

  const recipientPubkeyLen = data[offset] | (data[offset + 1] << 8);
  offset += 2;

  const fullRecipientPubkey = data.slice(offset, offset + 512);
  offset += 512;

  const recipientPubkey = new Uint8Array(
    fullRecipientPubkey.subarray(0, recipientPubkeyLen),
  );

  const nonce = new Uint8Array(data.slice(offset, offset + 32));
  offset += 32;

  const depositSlotDv = new DataView(data.buffer, data.byteOffset + offset, 8);
  const depositSlot = depositSlotDv.getBigUint64(0, true);
  offset += 8;

  const vaultEndDv = new DataView(data.buffer, data.byteOffset + offset, 8);
  const vaultEndTimestamp = vaultEndDv.getBigInt64(0, true);
  offset += 8;

  const vaultRevocable = data[offset++] !== 0;

  // 32 bytes reserved — skip
  // offset += 32;

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
    vaultEndTimestamp: BigInt(vaultEndTimestamp),
    vaultRevocable,
  };
}

// ---------------------------------------------------------------------------
// RPC discovery: fetch escrows by depositor or recipient
// ---------------------------------------------------------------------------

/** Union of ANT and token/vault escrow results */
export type EscrowResult =
  | { type: 'ant'; antMint: string; state: EscrowAntState }
  | { type: 'token'; assetId: string; state: EscrowTokenState };

/**
 * Fetch all active escrows deposited by a given Solana wallet.
 *
 * Uses `getProgramAccounts` with a `memcmp` filter at offset 10
 * (8-byte discriminator + 1 version + 1 bump = depositor Pubkey field).
 *
 * Returns an array of `{ antMint, state }`. Returns an empty array on
 * RPC errors (some providers restrict `getProgramAccounts`).
 */
export async function fetchEscrowsByDepositor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connection: any,
  depositorPubkey: string,
  programId: string = ESCROW_PROGRAM_ID,
): Promise<Array<{ antMint: string; state: EscrowAntState }>> {
  const { PublicKey } = await import('@solana/web3.js');
  const programPubkey = new PublicKey(programId);
  const depositor = new PublicKey(depositorPubkey);

  const raw = await connection.getProgramAccounts(programPubkey, {
    filters: [
      {
        memcmp: {
          offset: 10, // 8 discriminator + 1 version + 1 bump
          bytes: depositor.toBase58(),
        },
      },
    ],
  });

  // Normalise: `getProgramAccounts` may return the array directly or
  // wrapped in `{ value: [...] }` depending on the web3.js version.
  const accounts: Array<{ pubkey: any; account: { data: any } }> = Array.isArray(raw) ? raw : raw.value;

  const results: Array<{ antMint: string; state: EscrowAntState }> = [];
  for (const { account } of accounts) {
    try {
      const data =
        account.data instanceof Uint8Array
          ? account.data
          : new Uint8Array(account.data);
      // Only deserialize ANT escrows (661 bytes) in this function
      if (data.length === ESCROW_TOKEN_ACCOUNT_SIZE) continue;
      const state = deserializeEscrowAnt(data);
      results.push({ antMint: state.antMint, state });
    } catch {
      // Skip malformed accounts
    }
  }
  return results;
}

/**
 * Fetch all active escrows (ANT + token/vault) deposited by a given
 * Solana wallet. Returns a union array distinguishing the escrow type.
 */
export async function fetchAllEscrowsByDepositor(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connection: any,
  depositorPubkey: string,
  programId: string = ESCROW_PROGRAM_ID,
): Promise<EscrowResult[]> {
  const { PublicKey } = await import('@solana/web3.js');
  const programPubkey = new PublicKey(programId);
  const depositor = new PublicKey(depositorPubkey);

  const raw = await connection.getProgramAccounts(programPubkey, {
    filters: [
      {
        memcmp: {
          offset: 10,
          bytes: depositor.toBase58(),
        },
      },
    ],
  });

  const accounts: Array<{ pubkey: any; account: { data: any } }> = Array.isArray(raw) ? raw : raw.value;

  const results: EscrowResult[] = [];
  for (const { account } of accounts) {
    try {
      const data =
        account.data instanceof Uint8Array
          ? account.data
          : new Uint8Array(account.data);
      if (data.length === ESCROW_TOKEN_ACCOUNT_SIZE) {
        const state = deserializeEscrowToken(data);
        results.push({ type: 'token', assetId: bytesToHexLower(state.assetId), state });
      } else {
        const state = deserializeEscrowAnt(data);
        results.push({ type: 'ant', antMint: state.antMint, state });
      }
    } catch {
      // Skip malformed accounts
    }
  }
  return results;
}

/**
 * Fetch all active escrows addressed to a given recipient identity.
 *
 * Uses `getProgramAccounts` with TWO `memcmp` filters:
 * - offset 74: protocol byte (0 = arweave, 1 = ethereum)
 * - offset 77: first N bytes of the recipient pubkey data
 *   (20 for ethereum, 32 for arweave — enough to uniquely identify)
 *
 * Returns an array of `{ antMint, state }`. Returns an empty array on
 * RPC errors (some providers restrict `getProgramAccounts`).
 */
export async function fetchEscrowsByRecipient(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connection: any,
  recipientProtocol: 'arweave' | 'ethereum',
  recipientBytes: Uint8Array,
  programId: string = ESCROW_PROGRAM_ID,
): Promise<Array<{ antMint: string; state: EscrowAntState }>> {
  const { PublicKey } = await import('@solana/web3.js');
  const programPubkey = new PublicKey(programId);

  const protocolByte = recipientProtocol === 'arweave'
    ? ESCROW_PROTOCOL_ARWEAVE
    : ESCROW_PROTOCOL_ETHEREUM;

  // Number of recipient bytes to match: 20 for ethereum, 32 for arweave
  const matchLen = recipientProtocol === 'ethereum' ? 20 : 32;
  const matchBytes = recipientBytes.slice(0, matchLen);

  const raw = await connection.getProgramAccounts(programPubkey, {
    filters: [
      {
        memcmp: {
          offset: 74, // protocol byte
          bytes: bs58.encode(new Uint8Array([protocolByte])),
        },
      },
      {
        memcmp: {
          offset: 77, // recipient pubkey data (after 2-byte len prefix)
          bytes: bs58.encode(matchBytes),
        },
      },
    ],
  });

  // Normalise: `getProgramAccounts` may return the array directly or
  // wrapped in `{ value: [...] }` depending on the web3.js version.
  const accounts: Array<{ pubkey: any; account: { data: any } }> = Array.isArray(raw) ? raw : raw.value;

  const results: Array<{ antMint: string; state: EscrowAntState }> = [];
  for (const { account } of accounts) {
    try {
      const data =
        account.data instanceof Uint8Array
          ? account.data
          : new Uint8Array(account.data);
      // Only ANT escrows in this function
      if (data.length === ESCROW_TOKEN_ACCOUNT_SIZE) continue;
      const state = deserializeEscrowAnt(data);
      results.push({ antMint: state.antMint, state });
    } catch {
      // Skip malformed accounts
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// RPC read: fetch escrow state
// ---------------------------------------------------------------------------

/**
 * Fetch the on-chain `EscrowAnt` for an ANT mint. Returns `null` if no
 * active escrow exists.
 *
 * `connection` is the `Connection` from `useConnection()` (wallet-adapter).
 */
export async function fetchEscrowState(
  connection: { getAccountInfo: (pubkey: any) => Promise<any> },
  antMint: string,
  programId: string = ESCROW_PROGRAM_ID,
): Promise<EscrowAntState | null> {
  const { PublicKey } = await import('@solana/web3.js');
  const pdaAddress = await getEscrowAntPDA(antMint, programId);
  const pda = new PublicKey(pdaAddress);
  const accountInfo = await connection.getAccountInfo(pda);
  if (!accountInfo || !accountInfo.data) return null;

  // Verify owner matches the escrow program
  if (accountInfo.owner.toBase58() !== programId) return null;

  return deserializeEscrowAnt(new Uint8Array(accountInfo.data));
}

/**
 * Fetch a raw escrow account by PDA address and return the data + size.
 * Used by the claim page to discriminate between ANT and token/vault.
 */
export async function fetchRawEscrowAccount(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connection: any,
  pdaAddress: string,
  programId: string = ESCROW_PROGRAM_ID,
): Promise<{ data: Uint8Array; size: number } | null> {
  const { PublicKey } = await import('@solana/web3.js');
  const pda = new PublicKey(pdaAddress);
  const accountInfo = await connection.getAccountInfo(pda);
  if (!accountInfo || !accountInfo.data) return null;
  if (accountInfo.owner.toBase58() !== programId) return null;
  const data = accountInfo.data instanceof Uint8Array
    ? accountInfo.data
    : new Uint8Array(accountInfo.data);
  return { data, size: data.length };
}

/**
 * Fetch the on-chain `EscrowToken` for a depositor + assetId.
 * Returns `null` if no active escrow exists.
 */
export async function fetchEscrowTokenState(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connection: any,
  depositor: string,
  assetId: Uint8Array,
  programId: string = ESCROW_PROGRAM_ID,
): Promise<EscrowTokenState | null> {
  const { PublicKey } = await import('@solana/web3.js');
  const pdaAddress = await getEscrowTokenPDA(depositor, assetId, programId);
  const pda = new PublicKey(pdaAddress);
  const accountInfo = await connection.getAccountInfo(pda);
  if (!accountInfo || !accountInfo.data) return null;
  if (accountInfo.owner.toBase58() !== programId) return null;

  return deserializeEscrowToken(new Uint8Array(accountInfo.data));
}

/**
 * Format an amount in mARIO to ARIO display string (6 decimal places).
 */
export function formatMarioToArio(mARIO: bigint): string {
  const whole = mARIO / 1_000_000n;
  const frac = mARIO % 1_000_000n;
  const fracStr = frac.toString().padStart(6, '0');
  // Trim trailing zeros but keep at least 2 decimal places
  const trimmed = fracStr.replace(/0+$/, '').padEnd(2, '0');
  return `${whole.toString()}.${trimmed}`;
}

// ---------------------------------------------------------------------------
// Helpers for encoding recipient pubkeys from user input
// ---------------------------------------------------------------------------

/** Arweave GraphQL gateways — primary then fallback. */
const ARWEAVE_GQL_ENDPOINTS = [
  'https://turbo-gateway.com/graphql',
  'https://arweave-search.goldsky.com/graphql',
];

/**
 * Detect whether a string looks like a 43-character Arweave address
 * (base64url: alphanumeric, `-`, `_`).
 */
export function isArweaveAddress(input: string): boolean {
  return /^[A-Za-z0-9_-]{43}$/.test(input.trim());
}

/** Query a single GraphQL endpoint for the owner key. Returns the
 *  base64url modulus string, or throws on any failure. */
async function queryOwnerKey(
  endpoint: string,
  address: string,
): Promise<string> {
  const query = `{ transactions(owners: ["${address}"], first: 1) { edges { node { owner { key } } } } }`;
  const response = await fetch(endpoint, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ query }),
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  const json = await response.json();
  const edges = json?.data?.transactions?.edges;
  if (!edges || edges.length === 0) {
    throw new Error('no_transactions');
  }
  const ownerKey: string | undefined = edges[0]?.node?.owner?.key;
  if (!ownerKey) {
    throw new Error('owner key missing from response');
  }
  return ownerKey;
}

/**
 * Look up an Arweave wallet's RSA public key (the "n" modulus) by querying
 * Arweave GraphQL for a transaction from that owner. Tries the primary
 * gateway first (turbo-gateway.com), falls back to Goldsky on failure.
 *
 * Returns the base64url-encoded RSA modulus string, or throws if no
 * transactions are found on any gateway.
 */
export async function lookupArweaveModulus(address: string): Promise<string> {
  const addr = address.trim();
  let lastError: Error | undefined;

  for (const endpoint of ARWEAVE_GQL_ENDPOINTS) {
    try {
      const modulus = await queryOwnerKey(endpoint, addr);

      // SECURITY: verify the returned modulus actually derives to the
      // expected Arweave address. Without this check, a compromised or
      // MITMed GraphQL endpoint could return an attacker's modulus and
      // the depositor would unknowingly escrow for the wrong recipient.
      // Arweave address = base64url(sha256(base64url_decode(modulus)))
      const modulusBytes = base64urlToBytes(modulus);
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      const hash = new Uint8Array(await (crypto.subtle.digest as any)('SHA-256', modulusBytes));
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
      // "no_transactions" is definitive — the address has no txs on
      // Arweave, so trying another gateway won't help.
      if (lastError.message === 'no_transactions') break;
      // Network/server error or modulus mismatch — try the fallback.
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

/**
 * Parse a JWK "n" field (base64url-encoded RSA-4096 modulus) into
 * a 512-byte Uint8Array for on-chain storage.
 */
export function parseArweaveRecipient(input: string): Uint8Array {
  let nValue = input.trim();

  // If the input looks like JSON (a JWK), extract the "n" field
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

  // Base64url-decode the "n" field to get the raw 512-byte modulus
  const base64 = nValue.replace(/-/g, '+').replace(/_/g, '/');
  const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
  const binary = atob(padded);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    bytes[i] = binary.charCodeAt(i);
  }

  if (bytes.length !== ESCROW_ARWEAVE_PUBKEY_LEN) {
    throw new Error(
      `Arweave RSA modulus must be ${ESCROW_ARWEAVE_PUBKEY_LEN} bytes, got ${bytes.length}. ` +
        'Paste the base64url-encoded RSA public key or an Arweave address.',
    );
  }

  return bytes;
}

/**
 * Parse a 0x-prefixed Ethereum address into a 20-byte Uint8Array.
 */
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

/**
 * Format a recipient pubkey for display. Arweave = base64url of
 * modulus (first 24 chars...); Ethereum = 0x-prefixed hex.
 */
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
  // Arweave: base64url of the modulus (truncated for display)
  const b64 = btoa(String.fromCharCode(...pubkey))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=/g, '');
  return b64.length > 24 ? `${b64.slice(0, 24)}...` : b64;
}

// ---------------------------------------------------------------------------
// Base64url helpers (for Arweave address ↔ modulus verification)
// ---------------------------------------------------------------------------

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
// Attested claim path (Arweave → off-chain attestor → Ed25519 sysvar)
// ---------------------------------------------------------------------------
//
// The on-chain `claim_*_arweave_attested` instructions verify a cheap
// Ed25519 signature via Solana's native sigverify program +
// sysvar::instructions introspection, instead of an on-chain
// RSA-PSS-4096 modexp. The transaction layout is fixed:
//
//   [0] Ed25519Program native sigverify ix (verifies attestor's sig)
//   [1] claim_*_arweave_attested ix       (introspects [0])
//
// See `docs/DECISIONS.md` ADR-017 for the architecture rationale and
// `migration/attestor/README.md` for the off-chain service contract.

/** Solana Ed25519 native sigverify program id. */
export const ED25519_PROGRAM_ID =
  'Ed25519SigVerify111111111111111111111111111';

/** Solana sysvar::instructions account (used for ix introspection). */
export const SYSVAR_INSTRUCTIONS_ID =
  'Sysvar1nstructions1111111111111111111111111';

/** Metaplex Core program id (used for AssetV1 transfers in ANT claims). */
export const MPL_CORE_PROGRAM_ID =
  'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d';

/** SPL Token program id. */
export const SPL_TOKEN_PROGRAM_ID =
  'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA';

/** SPL Associated Token Account program id. */
export const ATA_PROGRAM_ID = 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL';

/**
 * Placeholder ario-core program id. Real id is patched in by
 * `./build-sbf.sh --sync` (or `anchor keys sync`) at deploy time and
 * baked into the deployed program. Mirrors `ARIO_CORE_PROGRAM_ID` from
 * `sdk/src/solana/constants.ts` exactly so client and SDK derive the
 * same PDAs.
 */
export const ARIO_CORE_PROGRAM_ID = 'ARioCoreProgramXXXXXXXXXXXXXXXXXXXXXXXXXXXXX';

export const ARIO_CORE_CONFIG_SEED = 'ario_config';
export const ARIO_CORE_VAULT_SEED = 'vault';
export const ARIO_CORE_VAULT_COUNTER_SEED = 'vault_counter';

/**
 * Build the Solana Ed25519Program native sigverify instruction with
 * pubkey, signature, and message all inline in the ix's own data
 * buffer.
 *
 * On-chain layout reference:
 *   agave/programs/ed25519-program/src/lib.rs
 *
 * The on-chain `claim_*_arweave_attested` introspection requires this
 * ix to be at index `claim_ix - 1` AND requires every
 * `*_instruction_index` field to equal `0xFFFF` (DATA_IN_SAME_IX) so
 * sigs can't point at a sibling ix's data.
 */
export async function buildEd25519SigverifyIx(
  attestorPubkey: Uint8Array,
  signature: Uint8Array,
  message: Uint8Array,
): Promise<import('@solana/web3.js').TransactionInstruction> {
  if (attestorPubkey.length !== 32) {
    throw new Error(
      `attestor pubkey must be 32 bytes, got ${attestorPubkey.length}`,
    );
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

  // Header (16 bytes)
  data[0] = 1; // num_signatures
  data[1] = 0; // padding
  view.setUint16(2, SIG_OFFSET, true);
  view.setUint16(4, SAME_IX, true); // signature_instruction_index
  view.setUint16(6, PK_OFFSET, true);
  view.setUint16(8, SAME_IX, true); // pubkey_instruction_index
  view.setUint16(10, MSG_OFFSET, true);
  view.setUint16(12, message.length, true);
  view.setUint16(14, SAME_IX, true); // message_instruction_index

  data.set(attestorPubkey, PK_OFFSET);
  data.set(signature, SIG_OFFSET);
  data.set(message, MSG_OFFSET);

  const { PublicKey, TransactionInstruction } = await import('@solana/web3.js');
  return new TransactionInstruction({
    programId: new PublicKey(ED25519_PROGRAM_ID),
    keys: [],
    data: Buffer.from(data),
  });
}

async function attestedClaimDiscriminator(name: string): Promise<Uint8Array> {
  const { sha256 } = await import('@noble/hashes/sha256');
  return sha256(new TextEncoder().encode(`global:${name}`)).slice(0, 8);
}

/**
 * Build the `claim_ant_arweave_attested` instruction.
 *
 * Account order (from `instructions/claim_arweave_attested.rs::ClaimAntArweaveAttested`):
 *   0. escrow              (mut, EscrowAnt PDA)
 *   1. ant_asset           (mut, Metaplex Core asset)
 *   2. claimant            (readonly)
 *   3. depositor           (mut, receives close-rent)
 *   4. payer               (signer, mut)
 *   5. mpl_core_program    (readonly)
 *   6. instructions_sysvar (readonly)
 *   7. system_program      (readonly)
 *
 * Data: 8-byte discriminator || 32-byte message_nonce.
 */
export async function buildClaimAntArweaveAttestedIx(args: {
  escrowPda: string;
  antMint: string;
  claimant: string;
  depositor: string;
  payer: string;
  messageNonce: Uint8Array;
  programId?: string;
}): Promise<import('@solana/web3.js').TransactionInstruction> {
  if (args.messageNonce.length !== 32) {
    throw new Error('messageNonce must be 32 bytes');
  }
  const { PublicKey, SystemProgram, TransactionInstruction } = await import(
    '@solana/web3.js'
  );

  const disc = await attestedClaimDiscriminator('claim_ant_arweave_attested');
  const data = Buffer.alloc(8 + 32);
  data.set(disc, 0);
  data.set(args.messageNonce, 8);

  return new TransactionInstruction({
    programId: new PublicKey(args.programId ?? ESCROW_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(args.escrowPda), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.antMint), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.claimant), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(args.depositor), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.payer), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(MPL_CORE_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(SYSVAR_INSTRUCTIONS_ID), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build the `claim_tokens_arweave_attested` instruction.
 *
 * Account order (from `instructions/claim_tokens_arweave_attested.rs`):
 *   0. escrow                 (mut, EscrowToken PDA)
 *   1. escrow_token_account   (mut, source ATA)
 *   2. claimant_token_account (mut, destination ATA)
 *   3. claimant               (readonly)
 *   4. depositor              (mut)
 *   5. payer                  (signer, mut)
 *   6. instructions_sysvar    (readonly)
 *   7. token_program          (readonly)
 *   8. system_program         (readonly)
 */
export async function buildClaimTokensArweaveAttestedIx(args: {
  escrowPda: string;
  escrowTokenAccount: string;
  claimantTokenAccount: string;
  claimant: string;
  depositor: string;
  payer: string;
  messageNonce: Uint8Array;
  programId?: string;
}): Promise<import('@solana/web3.js').TransactionInstruction> {
  if (args.messageNonce.length !== 32) {
    throw new Error('messageNonce must be 32 bytes');
  }
  const { PublicKey, SystemProgram, TransactionInstruction } = await import(
    '@solana/web3.js'
  );

  const disc = await attestedClaimDiscriminator('claim_tokens_arweave_attested');
  const data = Buffer.alloc(8 + 32);
  data.set(disc, 0);
  data.set(args.messageNonce, 8);

  return new TransactionInstruction({
    programId: new PublicKey(args.programId ?? ESCROW_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(args.escrowPda), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.escrowTokenAccount), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.claimantTokenAccount), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.claimant), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(args.depositor), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.payer), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(SYSVAR_INSTRUCTIONS_ID), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(SPL_TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/**
 * Build the `claim_vault_arweave_attested` instruction.
 *
 * Account order (from `instructions/claim_vault_arweave_attested.rs`):
 *   0. escrow                 (mut, EscrowToken PDA via vault seed)
 *   1. escrow_token_account   (mut, source ATA)
 *   2. claimant_token_account (mut, destination for expired path)
 *   3. payer_token_account    (mut, intermediate for active path)
 *   4. claimant               (readonly)
 *   5. depositor              (mut)
 *   6. payer                  (signer, mut)
 *   7. instructions_sysvar    (readonly)
 *   8. token_program          (readonly)
 *   9. system_program         (readonly)
 *
 * For active vaults the caller must ALSO include a sibling
 * `ario_core::vaulted_transfer` ix anywhere in the same tx.
 */
export async function buildClaimVaultArweaveAttestedIx(args: {
  escrowPda: string;
  escrowTokenAccount: string;
  claimantTokenAccount: string;
  payerTokenAccount: string;
  claimant: string;
  depositor: string;
  payer: string;
  messageNonce: Uint8Array;
  programId?: string;
}): Promise<import('@solana/web3.js').TransactionInstruction> {
  if (args.messageNonce.length !== 32) {
    throw new Error('messageNonce must be 32 bytes');
  }
  const { PublicKey, SystemProgram, TransactionInstruction } = await import(
    '@solana/web3.js'
  );

  const disc = await attestedClaimDiscriminator('claim_vault_arweave_attested');
  const data = Buffer.alloc(8 + 32);
  data.set(disc, 0);
  data.set(args.messageNonce, 8);

  return new TransactionInstruction({
    programId: new PublicKey(args.programId ?? ESCROW_PROGRAM_ID),
    keys: [
      { pubkey: new PublicKey(args.escrowPda), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.escrowTokenAccount), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.claimantTokenAccount), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.payerTokenAccount), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.claimant), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(args.depositor), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.payer), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(SYSVAR_INSTRUCTIONS_ID), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(SPL_TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

// ---------------------------------------------------------------------------
// vaulted_transfer (sibling ix for active-vault attested claims)
// ---------------------------------------------------------------------------
//
// Active vault claims (lock not yet expired) require a sibling
// `ario_core::vaulted_transfer` ix in the same tx. The escrow program
// releases tokens to `payer_token_account` and then introspects the tx
// to verify that vaulted_transfer re-locks the same amount for the
// claimant. Layout reference: `programs/ario-core/src/instructions/vault.rs`.

/**
 * Read the recipient's `VaultCounter.next_id`. Defaults to 0 if the
 * counter PDA hasn't been initialised yet (first vault for that owner).
 *
 * Account layout (from `programs/ario-core/src/state/mod.rs::VaultCounter`):
 *   8  bytes Anchor discriminator
 *   32 bytes owner
 *   8  bytes next_id (u64 LE)   ← what we read
 *   1  byte  bump
 */
export async function getNextVaultIdForOwner(
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  connection: any,
  owner: string,
  coreProgramId: string = ARIO_CORE_PROGRAM_ID,
): Promise<bigint> {
  const { PublicKey } = await import('@solana/web3.js');
  const ownerPubkey = new PublicKey(owner);
  const programPubkey = new PublicKey(coreProgramId);
  const [counterPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(ARIO_CORE_VAULT_COUNTER_SEED), ownerPubkey.toBuffer()],
    programPubkey,
  );
  const account = await connection.getAccountInfo(counterPda);
  if (!account) return 0n;
  // discriminator(8) + owner(32) = 40 → next_id at offset 40
  const view = new DataView(
    account.data.buffer,
    account.data.byteOffset,
    account.data.byteLength,
  );
  return view.getBigUint64(40, /*littleEndian*/ true);
}

/**
 * Build the `ario_core::vaulted_transfer` instruction.
 *
 * Account order (from `instructions/vault.rs::VaultedTransfer`):
 *   0. config                    (mut, ArioConfig PDA, seeds=["ario_config"])
 *   1. recipient_vault_counter   (mut, init_if_needed, seeds=["vault_counter", recipient])
 *   2. vault                     (mut, init, seeds=["vault", recipient, next_id_le_bytes])
 *   3. sender_token_account      (mut)
 *   4. vault_token_account       (mut, ATA owned by vault PDA)
 *   5. recipient                 (readonly)
 *   6. sender                    (signer, mut)
 *   7. token_program             (readonly)
 *   8. system_program            (readonly)
 *
 * Data: 8-byte discriminator || u64 LE amount || i64 LE lock_duration_seconds || bool revocable
 */
export async function buildVaultedTransferIx(args: {
  recipient: string;
  recipientVaultCounter: string;
  vault: string;
  senderTokenAccount: string;
  vaultTokenAccount: string;
  arioMint: string;
  sender: string;
  amount: bigint;
  lockDurationSeconds: bigint;
  revocable: boolean;
  coreProgramId?: string;
}): Promise<import('@solana/web3.js').TransactionInstruction> {
  const { PublicKey, SystemProgram, TransactionInstruction } = await import(
    '@solana/web3.js'
  );
  const { sha256 } = await import('@noble/hashes/sha256');

  const programPubkey = new PublicKey(args.coreProgramId ?? ARIO_CORE_PROGRAM_ID);
  const [configPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(ARIO_CORE_CONFIG_SEED)],
    programPubkey,
  );

  // 8-byte discriminator || u64 LE amount || i64 LE lock_duration || u8 revocable
  const discriminator = sha256(
    new TextEncoder().encode('global:vaulted_transfer'),
  ).slice(0, 8);
  const data = Buffer.alloc(8 + 8 + 8 + 1);
  data.set(discriminator, 0);
  data.writeBigUInt64LE(args.amount, 8);
  data.writeBigInt64LE(args.lockDurationSeconds, 16);
  data.writeUInt8(args.revocable ? 1 : 0, 24);

  return new TransactionInstruction({
    programId: programPubkey,
    keys: [
      { pubkey: configPda, isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.recipientVaultCounter), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.vault), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.senderTokenAccount), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.vaultTokenAccount), isSigner: false, isWritable: true },
      { pubkey: new PublicKey(args.recipient), isSigner: false, isWritable: false },
      { pubkey: new PublicKey(args.sender), isSigner: true, isWritable: true },
      { pubkey: new PublicKey(SPL_TOKEN_PROGRAM_ID), isSigner: false, isWritable: false },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

/** Derive `recipient_vault_counter` and `vault` PDAs for the next vault id. */
export async function deriveVaultPdas(
  recipient: string,
  nextId: bigint,
  coreProgramId: string = ARIO_CORE_PROGRAM_ID,
): Promise<{
  vaultCounter: string;
  vault: string;
}> {
  const { PublicKey } = await import('@solana/web3.js');
  const recipientPubkey = new PublicKey(recipient);
  const programPubkey = new PublicKey(coreProgramId);

  const [vaultCounterPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(ARIO_CORE_VAULT_COUNTER_SEED), recipientPubkey.toBuffer()],
    programPubkey,
  );
  const idLeBytes = Buffer.alloc(8);
  idLeBytes.writeBigUInt64LE(nextId, 0);
  const [vaultPda] = PublicKey.findProgramAddressSync(
    [Buffer.from(ARIO_CORE_VAULT_SEED), recipientPubkey.toBuffer(), idLeBytes],
    programPubkey,
  );
  return {
    vaultCounter: vaultCounterPda.toBase58(),
    vault: vaultPda.toBase58(),
  };
}

/** Derive an ATA whose owner may be a PDA (e.g. the vault PDA). */
export async function deriveAtaForOwner(
  owner: string,
  mint: string,
): Promise<string> {
  const { PublicKey } = await import('@solana/web3.js');
  const [ata] = PublicKey.findProgramAddressSync(
    [
      new PublicKey(owner).toBuffer(),
      new PublicKey(SPL_TOKEN_PROGRAM_ID).toBuffer(),
      new PublicKey(mint).toBuffer(),
    ],
    new PublicKey(ATA_PROGRAM_ID),
  );
  return ata.toBase58();
}
