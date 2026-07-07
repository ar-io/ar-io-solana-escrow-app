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
export {
  ANTEscrow,
  TokenEscrow,
  canonicalMessage,
  canonicalMessageV2,
  bytesToHexLower,
  deriveRecipientId,
  getEscrowAntPDA,
  getEscrowTokenPDA,
  getEscrowVaultPDA,
} from '@ar.io/sdk/solana';
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
  deriveRecipientId as _deriveRecipientId,
  type CanonicalMessageInput,
  type CanonicalMessageV2Input,
  type EscrowProtocol,
  type EscrowAntState,
  type EscrowTokenState,
  type EscrowAssetType,
} from '@ar.io/sdk/solana';

// Codama-generated account decoders + discriminators for the deployed
// `ario-ant-escrow` program. Used for raw `getProgramAccounts` discovery
// (the SDK only fetches single accounts by PDA). Decoding via the generated
// codec — instead of hand-rolled byte offsets — keeps this in lockstep with
// the on-chain layout: the v1→v3 schema-version expansion silently shifted
// every field after `version` by 2 bytes and broke the old offset math.
import {
  getEscrowAntDecoder,
  getEscrowTokenDecoder,
  ESCROW_ANT_DISCRIMINATOR,
  ESCROW_TOKEN_DISCRIMINATOR,
  CLAIM_VAULT_ETHEREUM_DISCRIMINATOR,
  CLAIM_VAULT_ARWEAVE_ATTESTED_DISCRIMINATOR,
} from '@ar.io/solana-contracts/ant-escrow';

// --- protocol constants (mirror the contract) ------------------------------
export const ESCROW_PROTOCOL_ARWEAVE = 0;
export const ESCROW_PROTOCOL_ETHEREUM = 1;
export const ESCROW_ARWEAVE_PUBKEY_LEN = 512;
export const ESCROW_ETHEREUM_PUBKEY_LEN = 20;

/** EscrowToken `asset_type` enum byte (mirrors the contract). */
export const ESCROW_ASSET_TYPE_TOKEN = 1;
export const ESCROW_ASSET_TYPE_VAULT = 2;

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

// ---------------------------------------------------------------------------
// ADR-027 vault claims — re-lock via direct CPI into ario-core
// ---------------------------------------------------------------------------
//
// Still-locked vault claims re-lock into a native ario-core vault
// (preserving the original unlock time) when the remaining lock is at
// least ario-core's `min_vault_duration`; shorter remainders (and expired
// vaults) deliver liquid. A still-locked claim must carry six trailing
// optional accounts; the escrow program routes `payer == claimant`
// through `create_vault` internally, so the account set is identical
// either way. The SDK's `TokenEscrow` claim methods predate ADR-027
// (they pre-flight the removed `VaultStillLocked` gate and omit the
// re-lock accounts), so the app builds these two instructions itself.

/** Solana `sysvar::instructions` id (Ed25519 attestation introspection). */
const INSTRUCTIONS_SYSVAR_ID = 'Sysvar1nstructions1111111111111111111111111';

const ARIO_CONFIG_SEED = 'ario_config';
const VAULT_COUNTER_SEED = 'vault_counter';
const VAULT_SEED = 'vault';

/** Byte offset of `min_vault_duration: i64` inside `ArioConfig`:
 *  disc(8) + authority(32) + mint(32) + arns_program(32) + treasury(32)
 *  + total_supply(8) + protocol_balance(8) + circulating_supply(8)
 *  + locked_supply(8) = 168. Fixed-offset read is safe here: the field
 *  sits before every append-only extension point (ADR-020). */
const ARIO_CONFIG_MIN_VAULT_DURATION_OFFSET = 168;

/** Byte offset of `next_id: u64` inside `VaultCounter`: disc(8) + owner(32). */
const VAULT_COUNTER_NEXT_ID_OFFSET = 40;

/** The six trailing optional accounts a still-locked vault claim carries. */
export interface VaultRelockAccounts {
  payerTokenAccount: Address;
  arioCoreConfig: Address;
  recipientVaultCounter: Address;
  vault: Address;
  vaultTokenAccount: Address;
  arioCoreProgram: Address;
}

/** ario-core `ArioConfig` PDA. */
export async function getArioConfigPda(coreProgram: Address): Promise<Address> {
  const [pda] = await getProgramDerivedAddress({
    programAddress: coreProgram,
    seeds: [new TextEncoder().encode(ARIO_CONFIG_SEED)],
  });
  return pda;
}

/** Live `min_vault_duration` (seconds) from ario-core's config, or null when
 *  the config account doesn't exist on this cluster. */
export async function fetchMinVaultDuration(
  rpc: SolanaRpc,
  coreProgram: Address,
): Promise<bigint | null> {
  const configPda = await getArioConfigPda(coreProgram);
  const { value } = await rpc
    .getAccountInfo(configPda, { encoding: 'base64' })
    .send();
  if (!value) return null;
  const data = Uint8Array.from(atob(value.data[0]), (c) => c.charCodeAt(0));
  const view = new DataView(data.buffer, data.byteOffset);
  return view.getBigInt64(ARIO_CONFIG_MIN_VAULT_DURATION_OFFSET, true);
}

/** The claimant's next vault id (0 when the counter doesn't exist yet). */
export async function fetchNextVaultId(
  rpc: SolanaRpc,
  coreProgram: Address,
  owner: Address,
): Promise<bigint> {
  const enc = getAddressEncoder();
  const [counterPda] = await getProgramDerivedAddress({
    programAddress: coreProgram,
    seeds: [new TextEncoder().encode(VAULT_COUNTER_SEED), enc.encode(owner)],
  });
  const { value } = await rpc
    .getAccountInfo(counterPda, { encoding: 'base64' })
    .send();
  if (!value) return 0n;
  const data = Uint8Array.from(atob(value.data[0]), (c) => c.charCodeAt(0));
  const view = new DataView(data.buffer, data.byteOffset);
  return view.getBigUint64(VAULT_COUNTER_NEXT_ID_OFFSET, true);
}

/** Derive the claimant's `VaultCounter` PDA and the `Vault` PDA for `vaultId`. */
export async function deriveVaultPdas(
  coreProgram: Address,
  claimant: Address,
  vaultId: bigint,
): Promise<{ counter: Address; vault: Address }> {
  const enc = getAddressEncoder();
  const [counter] = await getProgramDerivedAddress({
    programAddress: coreProgram,
    seeds: [new TextEncoder().encode(VAULT_COUNTER_SEED), enc.encode(claimant)],
  });
  const idBytes = new Uint8Array(8);
  new DataView(idBytes.buffer).setBigUint64(0, vaultId, true);
  const [vault] = await getProgramDerivedAddress({
    programAddress: coreProgram,
    seeds: [new TextEncoder().encode(VAULT_SEED), enc.encode(claimant), idBytes],
  });
  return { counter, vault };
}

interface ClaimVaultBaseAccounts {
  escrow: Address;
  escrowTokenAccount: Address;
  claimantTokenAccount: Address;
  claimant: Address;
  depositor: Address;
  payer: Address;
}

function claimVaultAccountMetas(
  base: ClaimVaultBaseAccounts,
  withInstructionsSysvar: boolean,
  relock?: VaultRelockAccounts,
) {
  const metas = [
    { address: base.escrow, role: AccountRole.WRITABLE },
    { address: base.escrowTokenAccount, role: AccountRole.WRITABLE },
    { address: base.claimantTokenAccount, role: AccountRole.WRITABLE },
    { address: base.claimant, role: AccountRole.READONLY },
    { address: base.depositor, role: AccountRole.WRITABLE },
    { address: base.payer, role: AccountRole.WRITABLE_SIGNER },
    ...(withInstructionsSysvar
      ? [{ address: address(INSTRUCTIONS_SYSVAR_ID), role: AccountRole.READONLY }]
      : []),
    { address: address(SPL_TOKEN_PROGRAM_ID), role: AccountRole.READONLY },
    { address: address(SYSTEM_PROGRAM_ID), role: AccountRole.READONLY },
  ];
  if (relock) {
    metas.push(
      { address: relock.payerTokenAccount, role: AccountRole.WRITABLE },
      { address: relock.arioCoreConfig, role: AccountRole.WRITABLE },
      { address: relock.recipientVaultCounter, role: AccountRole.WRITABLE },
      { address: relock.vault, role: AccountRole.WRITABLE },
      { address: relock.vaultTokenAccount, role: AccountRole.WRITABLE },
      { address: relock.arioCoreProgram, role: AccountRole.READONLY },
    );
  }
  return metas;
}

/** `claim_vault_ethereum` instruction (args: message_nonce, signature).
 *  Pass `relock` whenever the vault is still locked. */
export function buildClaimVaultEthereumIx(
  programId: Address,
  accounts: ClaimVaultBaseAccounts,
  messageNonce: Uint8Array,
  signature: Uint8Array,
  relock?: VaultRelockAccounts,
): Instruction {
  if (messageNonce.length !== 32) throw new Error('nonce must be 32 bytes');
  if (signature.length !== 65) throw new Error('signature must be 65 bytes');
  const data = new Uint8Array(8 + 32 + 65);
  data.set(CLAIM_VAULT_ETHEREUM_DISCRIMINATOR as Uint8Array, 0);
  data.set(messageNonce, 8);
  data.set(signature, 40);
  return {
    programAddress: programId,
    accounts: claimVaultAccountMetas(accounts, false, relock),
    data,
  };
}

/** `claim_vault_arweave_attested` instruction (args: message_nonce). The
 *  Ed25519 attestation sigverify ix MUST immediately precede this one.
 *  Pass `relock` whenever the vault is still locked. */
export function buildClaimVaultArweaveAttestedIx(
  programId: Address,
  accounts: ClaimVaultBaseAccounts,
  messageNonce: Uint8Array,
  relock?: VaultRelockAccounts,
): Instruction {
  if (messageNonce.length !== 32) throw new Error('nonce must be 32 bytes');
  const data = new Uint8Array(8 + 32);
  data.set(CLAIM_VAULT_ARWEAVE_ATTESTED_DISCRIMINATOR as Uint8Array, 0);
  data.set(messageNonce, 8);
  return {
    programAddress: programId,
    accounts: claimVaultAccountMetas(accounts, true, relock),
    data,
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

/** Canonical recipient identity for display: the checksummed-ish 0x address
 *  for Ethereum, or the base64url Arweave address (sha256 of the RSA modulus)
 *  for Arweave — the same value bound into the on-chain claim message. */
export function formatRecipient(
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
  return _deriveRecipientId(pubkey);
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
  const raw = getEscrowAntDecoder().decode(data);
  if (
    raw.recipientProtocol !== ESCROW_PROTOCOL_ARWEAVE &&
    raw.recipientProtocol !== ESCROW_PROTOCOL_ETHEREUM
  ) {
    throw new Error(`EscrowAnt: unknown protocol byte ${raw.recipientProtocol}`);
  }
  const recipientProtocol: EscrowProtocol =
    raw.recipientProtocol === ESCROW_PROTOCOL_ARWEAVE ? 'arweave' : 'ethereum';
  const expectedLen =
    recipientProtocol === 'arweave'
      ? ESCROW_ARWEAVE_PUBKEY_LEN
      : ESCROW_ETHEREUM_PUBKEY_LEN;
  return {
    version: raw.version,
    bump: raw.bump,
    depositor: raw.depositor,
    antMint: raw.antMint,
    recipientProtocol,
    // Trim the zero-padded blob to its active length (512 / 20).
    recipientPubkey: new Uint8Array(raw.recipientPubkey.subarray(0, expectedLen)),
    nonce: new Uint8Array(raw.nonce),
    depositSlot: raw.depositSlot,
  };
}

export function deserializeEscrowToken(data: Uint8Array): EscrowTokenState {
  const raw = getEscrowTokenDecoder().decode(data);
  if (
    raw.recipientProtocol !== ESCROW_PROTOCOL_ARWEAVE &&
    raw.recipientProtocol !== ESCROW_PROTOCOL_ETHEREUM
  ) {
    throw new Error(
      `EscrowToken: unknown protocol byte ${raw.recipientProtocol}`,
    );
  }
  const recipientProtocol: EscrowProtocol =
    raw.recipientProtocol === ESCROW_PROTOCOL_ARWEAVE ? 'arweave' : 'ethereum';
  const expectedLen =
    recipientProtocol === 'arweave'
      ? ESCROW_ARWEAVE_PUBKEY_LEN
      : ESCROW_ETHEREUM_PUBKEY_LEN;
  const assetType: EscrowAssetType =
    raw.assetType === ESCROW_ASSET_TYPE_VAULT ? 'vault' : 'token';
  return {
    version: raw.version,
    bump: raw.bump,
    depositor: raw.depositor,
    assetType,
    amount: raw.amount,
    arioMint: raw.arioMint,
    assetId: new Uint8Array(raw.assetId),
    recipientProtocol,
    recipientPubkey: new Uint8Array(raw.recipientPubkey.subarray(0, expectedLen)),
    nonce: new Uint8Array(raw.nonce),
    depositSlot: raw.depositSlot,
    vaultEndTimestamp: raw.vaultEndTimestamp,
    vaultRevocable: raw.vaultRevocable,
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

/** Fetch a single escrow account's raw bytes by PDA, owner-checked. */
export async function fetchRawEscrowAccount(
  rpc: SolanaRpc,
  pdaAddress: string,
  programId: string,
): Promise<{ data: Uint8Array; size: number } | null> {
  const { value } = await rpc
    .getAccountInfo(address(pdaAddress), { encoding: 'base64' })
    .send();
  if (!value || value.owner !== programId) return null;
  const data = decodeAccountData(value.data);
  return { data, size: data.length };
}

/** Fetch the ANT escrow state for a mint, or null. */
export async function fetchEscrowState(
  rpc: SolanaRpc,
  pdaAddress: string,
  programId: string,
): Promise<EscrowAntState | null> {
  const raw = await fetchRawEscrowAccount(rpc, pdaAddress, programId);
  if (!raw || raw.size === ESCROW_TOKEN_ACCOUNT_SIZE) return null;
  return deserializeEscrowAnt(raw.data);
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

// Account-type discriminator (first 8 bytes) as a base58 memcmp filter at
// offset 0. Filtering by discriminator — rather than by a downstream field
// offset — is immune to schema-layout shifts (the v1→v3 version expansion is
// exactly what broke the old depositor@10 / recipient@77 filters). The
// matching recipient/depositor field is then compared client-side on the
// decoded state, which the generated codec keeps correct across versions.
const ANT_DISCRIMINATOR_B58 = bs58.encode(
  new Uint8Array(ESCROW_ANT_DISCRIMINATOR),
);
const TOKEN_DISCRIMINATOR_B58 = bs58.encode(
  new Uint8Array(ESCROW_TOKEN_DISCRIMINATOR),
);

function bytesEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) return false;
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
  return true;
}

/** All ANT escrows deposited by a wallet. */
export async function fetchEscrowsByDepositor(
  rpc: SolanaRpc,
  depositorPubkey: string,
  programId: string,
): Promise<Array<{ antMint: string; state: EscrowAntState }>> {
  const accounts = await scanProgram(rpc, programId, [
    { offset: 0, bytes: ANT_DISCRIMINATOR_B58 },
  ]);
  const results: Array<{ antMint: string; state: EscrowAntState }> = [];
  for (const { data } of accounts) {
    try {
      const state = deserializeEscrowAnt(data);
      if (state.depositor === depositorPubkey) {
        results.push({ antMint: state.antMint, state });
      }
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
  const [ants, tokens] = await Promise.all([
    scanProgram(rpc, programId, [{ offset: 0, bytes: ANT_DISCRIMINATOR_B58 }]),
    scanProgram(rpc, programId, [{ offset: 0, bytes: TOKEN_DISCRIMINATOR_B58 }]),
  ]);
  const results: EscrowResult[] = [];
  for (const { data } of ants) {
    try {
      const state = deserializeEscrowAnt(data);
      if (state.depositor === depositorPubkey) {
        results.push({ type: 'ant', antMint: state.antMint, state });
      }
    } catch {
      /* skip malformed */
    }
  }
  for (const { data } of tokens) {
    try {
      const state = deserializeEscrowToken(data);
      if (state.depositor === depositorPubkey) {
        results.push({
          type: 'token',
          assetId: bytesToHexLowerLocal(state.assetId),
          state,
        });
      }
    } catch {
      /* skip malformed */
    }
  }
  return results;
}

/** Every escrow on the program, split by kind. Used by the Explore page +
 *  home-page stats — a full `getProgramAccounts` scan per discriminator. */
export interface AllEscrows {
  ants: Array<{ antMint: string; state: EscrowAntState }>;
  tokens: TokenEscrowByRecipient[];
}

export async function fetchAllEscrows(
  rpc: SolanaRpc,
  programId: string,
): Promise<AllEscrows> {
  const [antAccts, tokenAccts] = await Promise.all([
    scanProgram(rpc, programId, [{ offset: 0, bytes: ANT_DISCRIMINATOR_B58 }]),
    scanProgram(rpc, programId, [{ offset: 0, bytes: TOKEN_DISCRIMINATOR_B58 }]),
  ]);
  const ants: AllEscrows['ants'] = [];
  for (const { data } of antAccts) {
    try {
      const state = deserializeEscrowAnt(data);
      ants.push({ antMint: state.antMint, state });
    } catch {
      /* skip malformed */
    }
  }
  const tokens: TokenEscrowByRecipient[] = [];
  for (const { pubkey, data } of tokenAccts) {
    try {
      tokens.push({ escrowPda: pubkey, state: deserializeEscrowToken(data) });
    } catch {
      /* skip malformed */
    }
  }
  return { ants, tokens };
}

/** All ANT escrows addressed to a recipient identity. */
export async function fetchEscrowsByRecipient(
  rpc: SolanaRpc,
  recipientProtocol: 'arweave' | 'ethereum',
  recipientBytes: Uint8Array,
  programId: string,
): Promise<Array<{ antMint: string; state: EscrowAntState }>> {
  const accounts = await scanProgram(rpc, programId, [
    { offset: 0, bytes: ANT_DISCRIMINATOR_B58 },
  ]);
  const results: Array<{ antMint: string; state: EscrowAntState }> = [];
  for (const { data } of accounts) {
    try {
      const state = deserializeEscrowAnt(data);
      if (
        state.recipientProtocol === recipientProtocol &&
        bytesEqual(state.recipientPubkey, recipientBytes)
      ) {
        results.push({ antMint: state.antMint, state });
      }
    } catch {
      /* skip malformed */
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
 * `fetchEscrowsByRecipient`, scanning by the EscrowToken discriminator and
 * matching the recipient on the decoded state.
 */
export async function fetchTokenEscrowsByRecipient(
  rpc: SolanaRpc,
  recipientProtocol: 'arweave' | 'ethereum',
  recipientBytes: Uint8Array,
  programId: string,
): Promise<TokenEscrowByRecipient[]> {
  const accounts = await scanProgram(rpc, programId, [
    { offset: 0, bytes: TOKEN_DISCRIMINATOR_B58 },
  ]);
  const results: TokenEscrowByRecipient[] = [];
  for (const { pubkey, data } of accounts) {
    try {
      const state = deserializeEscrowToken(data);
      if (
        state.recipientProtocol === recipientProtocol &&
        bytesEqual(state.recipientPubkey, recipientBytes)
      ) {
        results.push({ escrowPda: pubkey, state });
      }
    } catch {
      /* skip malformed */
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
  // The signer (wallet-signer.ts) preserves kit's `lifetimeConstraint` on the
  // returned tx, so the blockhash-confirmation strategy below can read
  // `lastValidBlockHeight`.
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
