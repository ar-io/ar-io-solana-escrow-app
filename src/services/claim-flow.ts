/**
 * Single-escrow claim pipeline — sign the canonical message with the
 * recipient wallet, then submit the Solana claim transaction.
 *
 * Extracted from `ClaimPage` so the page can run it over a *selection* of
 * escrows (batch claiming). Each escrow has its own canonical message (bound
 * to its asset id / nonce), so every asset needs its own recipient signature
 * — there's no way to authorize several with one signature. This module
 * claims exactly one; the page loops it and tracks per-item progress.
 */
import bs58 from 'bs58';
import { address } from '@solana/kit';
import {
  fetchRawEscrowAccount,
  deserializeEscrowToken,
  canonicalMessage,
  canonicalMessageV2,
  formatMarioToArio,
  buildEd25519SigverifyIx,
  buildCreateAtaIdempotentIx,
  buildClaimVaultEthereumIx,
  buildClaimVaultArweaveAttestedIx,
  fetchMinVaultDuration,
  fetchNextVaultId,
  deriveVaultPdas,
  getArioConfigPda,
  getAtaForOwner,
  sendInstructions,
  ESCROW_TOKEN_ACCOUNT_SIZE,
  type EscrowAntState,
  type EscrowTokenState,
  type EscrowNetwork,
  type VaultRelockAccounts,
} from './escrow-client.ts';
import {
  getAntEscrow,
  getTokenEscrow,
  getWalletSigner,
  getEscrowProgramId,
  getCoreProgramId,
  makeRpc,
} from './solana.ts';
import {
  AttestorClient,
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHexLower,
  type AttestationResponse,
} from './attestor-client.ts';

/** A claimable escrow, keyed by the identifier a recipient uses to claim it
 *  (ANT mint for ANT escrows; escrow PDA for token/vault escrows). */
export type ClaimItem =
  | { kind: 'ant'; id: string; state: EscrowAntState }
  | { kind: 'token'; id: string; state: EscrowTokenState };

/** Recipient protocol of an item. */
export function itemProtocol(item: ClaimItem): 'arweave' | 'ethereum' {
  return item.state.recipientProtocol;
}

/** Human label for an item (used in lists + result summaries). */
export function itemLabel(item: ClaimItem): string {
  if (item.kind === 'ant') return `ANT ${item.id}`;
  const amount = formatMarioToArio(item.state.amount);
  return item.state.assetType === 'vault'
    ? `${amount} ARIO vault`
    : `${amount} ARIO`;
}

export type ClaimPhase = 'signing' | 'submitting';

export interface ClaimContext {
  claimant: string;
  network: EscrowNetwork;
  /** Solana wallet adapter that pays fees + signs the claim tx. */
  walletAdapter: unknown;
  /** Injected EIP-1193 provider, required for Ethereum-recipient items. */
  ethereumProvider?: unknown;
  /** Attestor client, required for Arweave-recipient items. */
  attestor: AttestorClient | null;
  onPhase?: (phase: ClaimPhase, message: string) => void;
}

/**
 * Build + sign the canonical claim message for one escrow with the
 * recipient wallet (Arweave RSA-PSS or Ethereum ECDSA).
 */
async function signClaimMessage(
  item: ClaimItem,
  ctx: ClaimContext,
): Promise<Uint8Array> {
  const messageBytes =
    item.kind === 'ant'
      ? canonicalMessage({
          network: ctx.network,
          antMint: address(item.id),
          claimant: address(ctx.claimant),
          recipient: item.state.recipientPubkey,
          nonce: item.state.nonce,
        })
      : canonicalMessageV2({
          network: ctx.network,
          assetType: item.state.assetType,
          assetId: item.state.assetId,
          amount: item.state.amount,
          claimant: address(ctx.claimant),
          recipient: item.state.recipientPubkey,
          nonce: item.state.nonce,
        });

  if (item.state.recipientProtocol === 'arweave') {
    const arweaveWallet = (window as any).arweaveWallet;
    if (!arweaveWallet) throw new Error('Arweave wallet not connected.');
    // Use `signature()` — a STANDARD single-hash RSA-PSS over the raw
    // message — NOT `signMessage()`. `signMessage()` hashes the message and
    // PSS-signs the digest, so PSS hashes it a second time (double-hash);
    // the attestor and the on-chain sol_big_mod_exp verifier both do
    // single-hash RSA-PSS over the message, so a `signMessage()` signature
    // fails with RSA_SIGNATURE_INVALID. `saltLength: 32` matches the
    // attestor payload + the contract. Requires the wallet's `SIGNATURE`
    // permission (requested at connect time).
    if (typeof arweaveWallet.signature !== 'function') {
      throw new Error(
        'Your Arweave wallet does not expose the signature() API needed for escrow claims. Reconnect Wander and grant the SIGNATURE permission.',
      );
    }
    const raw = await arweaveWallet.signature(messageBytes, {
      name: 'RSA-PSS',
      saltLength: 32,
    });
    const sig =
      raw instanceof Uint8Array
        ? raw
        : raw instanceof ArrayBuffer
          ? new Uint8Array(raw)
          : raw?.signature
            ? new Uint8Array(raw.signature)
            : null;
    if (!sig) throw new Error('Unexpected signature() return format.');
    if (sig.length !== 512) {
      throw new Error('Invalid signature from wallet. Please try again.');
    }
    return sig;
  }

  // Ethereum: ethers personal_sign applies the EIP-191 prefix; the on-chain
  // code re-applies it.
  if (!ctx.ethereumProvider) throw new Error('Ethereum wallet not connected.');
  const { BrowserProvider } = await import('ethers');
  const provider = new BrowserProvider(ctx.ethereumProvider as any);
  const signer = await provider.getSigner();
  const sigHex = await signer.signMessage(new TextDecoder().decode(messageBytes));
  return hexToBytes(sigHex);
}

/** Submit an ANT-escrow claim tx; returns the confirmed signature. */
async function submitAntClaim(
  state: EscrowAntState,
  id: string,
  signature: Uint8Array,
  ctx: ClaimContext,
): Promise<string> {
  const freshState = await getAntEscrow({}).get(address(id));
  if (!freshState) {
    throw new Error(
      'Escrow no longer exists — it may have been cancelled or already claimed.',
    );
  }
  assertNonceUnchanged(freshState.nonce, state.nonce);

  if (state.recipientProtocol === 'ethereum') {
    ctx.onPhase?.('submitting', 'Waiting for wallet approval...');
    return getAntEscrow({ adapter: ctx.walletAdapter }).claimEthereum({
      antMint: address(id),
      claimant: address(ctx.claimant),
      signature,
    });
  }

  // Attested Arweave path: attestor Ed25519 sigverify ix + claim ix.
  ctx.onPhase?.('submitting', 'Requesting attestation...');
  const attestation = await ctx.attestor!.attest({
    claimKind: 'ant',
    antMintBase58: id,
    claimantBase58: ctx.claimant,
    nonceHex: bytesToHexLower(state.nonce),
    // The escrow's on-chain recipient pubkey IS the recipient's RSA modulus.
    rsaModulusBase64Url: bytesToBase64Url(state.recipientPubkey),
    rsaSignatureBase64Url: bytesToBase64Url(signature),
    saltLength: 32,
  });
  logAttestedMessage(
    attestation,
    canonicalMessage({
      network: ctx.network,
      antMint: address(id),
      claimant: address(ctx.claimant),
      recipient: state.recipientPubkey,
      nonce: state.nonce,
    }),
  );
  const ed25519Ix = buildEd25519SigverifyIx(
    bs58.decode(attestation.attestorPubkeyBase58),
    base64UrlToBytes(attestation.attestationSignatureBase64Url),
    base64UrlToBytes(attestation.canonicalMessageBase64Url),
  );
  const claimIx = await getAntEscrow({ adapter: ctx.walletAdapter }).claimArweaveIx({
    antMint: address(id),
    claimant: address(ctx.claimant),
    depositor: freshState.depositor,
    messageNonce: state.nonce,
  });
  ctx.onPhase?.('submitting', 'Waiting for wallet approval...');
  const { rpc, rpcSubscriptions } = makeRpc();
  return sendInstructions(
    rpc,
    rpcSubscriptions,
    getWalletSigner(ctx.walletAdapter),
    [ed25519Ix, claimIx],
  );
}

/** Submit a token/vault-escrow claim tx; returns the confirmed signature. */
async function submitTokenClaim(
  state: EscrowTokenState,
  id: string,
  signature: Uint8Array,
  ctx: ClaimContext,
): Promise<string> {
  const programId = getEscrowProgramId()!;
  const { rpc, rpcSubscriptions } = makeRpc();
  const rawAccount = await fetchRawEscrowAccount(rpc, id, programId);
  if (!rawAccount || rawAccount.size !== ESCROW_TOKEN_ACCOUNT_SIZE) {
    throw new Error(
      'Escrow no longer exists — it may have been cancelled or already claimed.',
    );
  }
  const freshToken = deserializeEscrowToken(rawAccount.data);
  assertNonceUnchanged(freshToken.nonce, state.nonce);

  const arioMint = freshToken.arioMint;
  const claimantAddr = address(ctx.claimant);
  const escrowPda = address(id);
  const claimantTokenAccount = await getAtaForOwner(claimantAddr, arioMint);
  const escrowTokenAccount = await getAtaForOwner(escrowPda, arioMint);
  const te = getTokenEscrow({ adapter: ctx.walletAdapter });

  // Vault escrows take the ADR-027 path (hand-assembled: the SDK's vault
  // claim methods predate the restored active re-lock and still pre-flight
  // the removed VaultStillLocked gate).
  if (state.assetType === 'vault') {
    return submitVaultClaim(freshToken, ctx, {
      rpc,
      rpcSubscriptions,
      programId: address(programId),
      arioMint,
      escrowPda,
      claimantAddr,
      claimantTokenAccount,
      escrowTokenAccount,
      signature,
    });
  }

  if (state.recipientProtocol === 'ethereum') {
    ctx.onPhase?.('submitting', 'Waiting for wallet approval...');
    return te.claimTokensEthereum({
      depositor: freshToken.depositor,
      assetId: freshToken.assetId,
      claimant: claimantAddr,
      claimantTokenAccount,
      escrowTokenAccount,
      signature,
    });
  }

  // Attested Arweave path.
  ctx.onPhase?.('submitting', 'Requesting attestation...');
  const attestation = await ctx.attestor!.attest({
    claimKind: state.assetType,
    assetIdHex: bytesToHexLower(state.assetId),
    amount: state.amount.toString(),
    claimantBase58: ctx.claimant,
    nonceHex: bytesToHexLower(state.nonce),
    // The escrow's on-chain recipient pubkey IS the recipient's RSA modulus.
    rsaModulusBase64Url: bytesToBase64Url(state.recipientPubkey),
    rsaSignatureBase64Url: bytesToBase64Url(signature),
    saltLength: 32,
  });
  logAttestedMessage(
    attestation,
    canonicalMessageV2({
      network: ctx.network,
      assetType: state.assetType,
      assetId: state.assetId,
      amount: state.amount,
      claimant: address(ctx.claimant),
      recipient: state.recipientPubkey,
      nonce: state.nonce,
    }),
  );
  const ed25519Ix = buildEd25519SigverifyIx(
    bs58.decode(attestation.attestorPubkeyBase58),
    base64UrlToBytes(attestation.attestationSignatureBase64Url),
    base64UrlToBytes(attestation.canonicalMessageBase64Url),
  );
  const signer = getWalletSigner(ctx.walletAdapter);
  const createAtaIx = buildCreateAtaIdempotentIx(
    signer.address,
    claimantTokenAccount,
    claimantAddr,
    arioMint,
  );
  const claimIx = await te.claimTokensArweaveIx({
    depositor: freshToken.depositor,
    assetId: freshToken.assetId,
    claimant: claimantAddr,
    claimantTokenAccount,
    escrowTokenAccount,
    messageNonce: state.nonce,
  });
  ctx.onPhase?.('submitting', 'Waiting for wallet approval...');
  // ORDER MATTERS: the on-chain introspection (verify/attested.rs) requires
  // the Ed25519 sigverify ix at exactly `claim_index - 1`. The create-ATA ix
  // must therefore come BEFORE the sigverify ix, not between it and the claim
  // — otherwise the claim's preceding ix is the ATA create and the program
  // fails with MissingAttestationInstruction (6021).
  return sendInstructions(rpc, rpcSubscriptions, signer, [
    createAtaIx,
    ed25519Ix,
    claimIx,
  ]);
}

/**
 * Submit a vault-escrow claim (ADR-027).
 *
 * Still-locked vaults re-lock into a native ario-core vault owned by the
 * claimant, unlocking at the escrow's original end time — the claim ix
 * carries six trailing re-lock accounts and the new vault's ATA is
 * pre-created in the same tx. Vaults within `min_vault_duration` of expiry
 * (and expired vaults) deliver liquid tokens instead. The connected wallet
 * pays and is usually the claimant; the escrow program handles
 * `payer == claimant` internally (`create_vault` branch), so the account
 * set is the same either way.
 */
async function submitVaultClaim(
  freshToken: EscrowTokenState,
  ctx: ClaimContext,
  tx: {
    rpc: ReturnType<typeof makeRpc>['rpc'];
    rpcSubscriptions: ReturnType<typeof makeRpc>['rpcSubscriptions'];
    programId: ReturnType<typeof address>;
    arioMint: ReturnType<typeof address>;
    escrowPda: ReturnType<typeof address>;
    claimantAddr: ReturnType<typeof address>;
    claimantTokenAccount: ReturnType<typeof address>;
    escrowTokenAccount: ReturnType<typeof address>;
    signature: Uint8Array;
  },
): Promise<string> {
  const signer = getWalletSigner(ctx.walletAdapter);
  const nowSec = BigInt(Math.floor(Date.now() / 1000));
  const remaining = freshToken.vaultEndTimestamp - nowSec;

  const setupIxs = [
    buildCreateAtaIdempotentIx(
      signer.address,
      tx.claimantTokenAccount,
      tx.claimantAddr,
      tx.arioMint,
    ),
  ];

  // Still locked → the claim must carry the re-lock account set. Whether it
  // actually re-locks or delivers liquid is decided on-chain against the
  // live `min_vault_duration`; we mirror that check here only to know
  // whether the new vault's token account must be pre-created.
  let relock: VaultRelockAccounts | undefined;
  if (remaining > 0n) {
    const coreProgram = getCoreProgramId();
    if (!coreProgram) {
      throw new Error(
        'Still-locked vault claims need the ario-core program id for this ' +
          'cluster — set VITE_ARIO_CORE_PROGRAM_ID (or the runtime override).',
      );
    }
    const minDuration = await fetchMinVaultDuration(tx.rpc, coreProgram);
    if (minDuration === null) {
      throw new Error(
        'ario-core is not initialized on this cluster — cannot claim a ' +
          'still-locked vault (the re-lock reads its config).',
      );
    }
    const nextId = await fetchNextVaultId(tx.rpc, coreProgram, tx.claimantAddr);
    const { counter, vault } = await deriveVaultPdas(
      coreProgram,
      tx.claimantAddr,
      nextId,
    );
    const vaultTokenAccount = await getAtaForOwner(vault, tx.arioMint);
    const payerTokenAccount = await getAtaForOwner(signer.address, tx.arioMint);
    relock = {
      payerTokenAccount,
      arioCoreConfig: await getArioConfigPda(coreProgram),
      recipientVaultCounter: counter,
      vault,
      vaultTokenAccount,
      arioCoreProgram: coreProgram,
    };
    if (remaining >= minDuration) {
      // Re-lock branch: the new vault's token account (and the payer's
      // pass-through account) must exist before the CPI runs.
      setupIxs.push(
        buildCreateAtaIdempotentIx(signer.address, vaultTokenAccount, vault, tx.arioMint),
      );
      if (payerTokenAccount !== tx.claimantTokenAccount) {
        setupIxs.push(
          buildCreateAtaIdempotentIx(
            signer.address,
            payerTokenAccount,
            signer.address,
            tx.arioMint,
          ),
        );
      }
      const unlockIso = new Date(
        Number(freshToken.vaultEndTimestamp) * 1000,
      ).toLocaleString();
      ctx.onPhase?.(
        'submitting',
        `Vault still locked — claiming into a native vault unlocking ${unlockIso}...`,
      );
    }
  }

  const base = {
    escrow: tx.escrowPda,
    escrowTokenAccount: tx.escrowTokenAccount,
    claimantTokenAccount: tx.claimantTokenAccount,
    claimant: tx.claimantAddr,
    depositor: address(freshToken.depositor),
    payer: signer.address,
  };

  if (freshToken.recipientProtocol === 'ethereum') {
    const claimIx = buildClaimVaultEthereumIx(
      tx.programId,
      base,
      freshToken.nonce,
      tx.signature,
      relock,
    );
    ctx.onPhase?.('submitting', 'Waiting for wallet approval...');
    return sendInstructions(tx.rpc, tx.rpcSubscriptions, signer, [
      ...setupIxs,
      claimIx,
    ]);
  }

  // Attested Arweave path.
  ctx.onPhase?.('submitting', 'Requesting attestation...');
  const attestation = await ctx.attestor!.attest({
    claimKind: 'vault',
    assetIdHex: bytesToHexLower(freshToken.assetId),
    amount: freshToken.amount.toString(),
    claimantBase58: ctx.claimant,
    nonceHex: bytesToHexLower(freshToken.nonce),
    // The escrow's on-chain recipient pubkey IS the recipient's RSA modulus.
    rsaModulusBase64Url: bytesToBase64Url(freshToken.recipientPubkey),
    rsaSignatureBase64Url: bytesToBase64Url(tx.signature),
    saltLength: 32,
  });
  logAttestedMessage(
    attestation,
    canonicalMessageV2({
      network: ctx.network,
      assetType: 'vault',
      assetId: freshToken.assetId,
      amount: freshToken.amount,
      claimant: tx.claimantAddr,
      recipient: freshToken.recipientPubkey,
      nonce: freshToken.nonce,
    }),
  );
  const ed25519Ix = buildEd25519SigverifyIx(
    bs58.decode(attestation.attestorPubkeyBase58),
    base64UrlToBytes(attestation.attestationSignatureBase64Url),
    base64UrlToBytes(attestation.canonicalMessageBase64Url),
  );
  const claimIx = buildClaimVaultArweaveAttestedIx(
    tx.programId,
    base,
    freshToken.nonce,
    relock,
  );
  ctx.onPhase?.('submitting', 'Waiting for wallet approval...');
  // ORDER MATTERS: the Ed25519 sigverify ix must sit at exactly
  // `claim_index - 1`; all setup ixs come before it.
  return sendInstructions(tx.rpc, tx.rpcSubscriptions, signer, [
    ...setupIxs,
    ed25519Ix,
    claimIx,
  ]);
}

/**
 * Claim one escrow end-to-end: validate prerequisites, sign with the
 * recipient wallet, then submit the Solana claim tx. Resolves with the
 * confirmed tx signature, or throws with a user-facing message.
 */
export async function claimEscrowItem(
  item: ClaimItem,
  ctx: ClaimContext,
): Promise<string> {
  if (item.state.recipientProtocol === 'arweave' && !ctx.attestor) {
    throw new Error(
      'Arweave claims require the attestor service. Set VITE_ATTESTOR_URL and reload.',
    );
  }

  ctx.onPhase?.('signing', 'Waiting for signature...');
  const signature = await signClaimMessage(item, ctx);

  return item.kind === 'ant'
    ? submitAntClaim(item.state, item.id, signature, ctx)
    : submitTokenClaim(item.state, item.id, signature, ctx);
}

/** Build the attestor client from env, or null if unconfigured. */
export function makeAttestor(network: EscrowNetwork): AttestorClient | null {
  const url = import.meta.env.VITE_ATTESTOR_URL as string | undefined;
  return url ? new AttestorClient({ url, expectNetwork: network }) : null;
}

// ---------------------------------------------------------------------------

/**
 * Dev-only diagnostic: print the exact canonical message the attestor
 * Ed25519-signed (the on-chain `claim_*_attested` ix compares THIS, byte for
 * byte, against the message the program rebuilds — an `AttestationMessageMismatch`
 * / 6024 means they differ). Compares it to the message we built locally with
 * the page's network so a divergent `network:` line (e.g. the attestor signing
 * `solana-mainnet` while reporting `solana-devnet` on /health, or the page on a
 * different cluster than the program) is obvious in the console.
 */
function logAttestedMessage(
  attestation: AttestationResponse,
  expected: Uint8Array,
): void {
  if (!import.meta.env.DEV) return;
  const dec = new TextDecoder();
  const attestorMsg = dec.decode(
    base64UrlToBytes(attestation.canonicalMessageBase64Url),
  );
  const expectedMsg = dec.decode(expected);
  console.info('[attestor] message it signed:\n' + attestorMsg);
  if (attestorMsg !== expectedMsg) {
    console.warn(
      '[attestor] MISMATCH — message the program/wallet expect (page network):\n' +
        expectedMsg,
    );
  }
}

function assertNonceUnchanged(fresh: Uint8Array, signed: Uint8Array): void {
  const same =
    fresh.length === signed.length && fresh.every((b, i) => b === signed[i]);
  if (!same) {
    throw new Error(
      'The escrow recipient was updated since you signed — your signature is no longer valid. Please claim again.',
    );
  }
}

function hexToBytes(hex: string): Uint8Array {
  let h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) h = '0' + h;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}
