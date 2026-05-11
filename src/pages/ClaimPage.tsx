import React, { useState, useCallback, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useConnection } from '@solana/wallet-adapter-react';
import { brand } from '../brand.js';
import { StepCard } from '../components/StepCard.tsx';
import { SolanaWalletConnect } from '../components/SolanaWalletConnect.tsx';
import { ArweaveWalletConnect } from '../components/ArweaveWalletConnect.tsx';
import { EthereumWalletConnect } from '../components/EthereumWalletConnect.tsx';
import {
  fetchEscrowState,
  fetchEscrowsByRecipient,
  fetchRawEscrowAccount,
  deserializeEscrowToken,
  lookupArweaveModulus,
  parseArweaveRecipient,
  canonicalMessage,
  canonicalMessagePreview,
  canonicalMessageV2,
  canonicalMessageV2Preview,
  formatMarioToArio,
  buildEd25519SigverifyIx,
  buildClaimAntArweaveAttestedIx,
  buildClaimTokensArweaveAttestedIx,
  buildClaimVaultArweaveAttestedIx,
  buildVaultedTransferIx,
  getNextVaultIdForOwner,
  deriveVaultPdas,
  deriveAtaForOwner,
  ESCROW_PROGRAM_ID,
  ESCROW_ANT_ACCOUNT_SIZE,
  ESCROW_TOKEN_ACCOUNT_SIZE,
  type EscrowAntState,
  type EscrowTokenState,
  type EscrowNetwork,
} from '../services/escrow-client.ts';
import {
  AttestorClient,
  base64UrlToBytes,
  bytesToBase64Url,
  bytesToHexLower,
} from '../services/attestor-client.ts';

interface Props {
  /** ANT mint or escrow PDA, optionally read from `?ant=<mint>` query string. */
  antMint: string;
}

/**
 * Recipient flow — verify the canonical message, sign with the
 * appropriate (Arweave or Ethereum) wallet, submit the claim tx.
 *
 * 1. User enters the ANT mint and their desired Solana destination.
 * 2. The page fetches the EscrowAnt PDA to determine recipient protocol
 *    and nonce, then renders the canonical message preview.
 * 3. The user connects their Arweave or Ethereum wallet and signs the
 *    canonical message.
 * 4. Anyone (fee payer) submits the claim tx with the signature.
 */
export function ClaimPage({ antMint: initialAntMint }: Props) {
  const [antMint, setAntMint] = useState(initialAntMint);
  const [claimant, setClaimant] = useState('');
  const [solPubkey, setSolPubkey] = useState<string | undefined>();

  // Escrow state from on-chain (ANT or token/vault — one will be set)
  const [escrowState, setEscrowState] = useState<EscrowAntState | null>(null);
  const [tokenState, setTokenState] = useState<EscrowTokenState | null>(null);
  const [escrowLoading, setEscrowLoading] = useState(false);
  const [escrowError, setEscrowError] = useState('');

  // Source wallet connection (for signing)
  const [arweaveAddress, setArweaveAddress] = useState<string | undefined>();
  const [ethereumAddress, setEthereumAddress] = useState<string | undefined>();
  const [ethereumProvider, setEthereumProvider] = useState<any>(undefined);

  // Signature state
  const [signature, setSignature] = useState<Uint8Array | null>(null);
  // Arweave modulus captured at sign time. Required to POST to the
  // attestor service alongside the RSA-PSS signature; the Ethereum
  // path leaves this null and verifies on-chain via secp256k1_recover.
  const [arweaveModulus, setArweaveModulus] = useState<Uint8Array | null>(null);
  const [signError, setSignError] = useState('');
  const [signing, setSigning] = useState(false);

  // Recipient discovery
  const [recipientEscrows, setRecipientEscrows] = useState<
    Array<{ antMint: string; state: EscrowAntState }>
  >([]);
  const [recipientDiscoveryLoading, setRecipientDiscoveryLoading] = useState(false);
  const [recipientDiscoveryError, setRecipientDiscoveryError] = useState('');
  const [recipientDiscoveryDone, setRecipientDiscoveryDone] = useState(false);

  // Claim submission state
  const [claimStatus, setClaimStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [claimMessage, setClaimMessage] = useState('');
  const [txSignature, setTxSignature] = useState('');

  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();

  // Determine network from the RPC URL
  const network: EscrowNetwork = (
    connection?.rpcEndpoint?.includes('devnet') ? 'solana-devnet' : 'solana-mainnet'
  );

  // -------------------------------------------------------------------
  // Fetch escrow state when ANT mint changes
  // -------------------------------------------------------------------
  const fetchEscrow = useCallback(async () => {
    if (!antMint || antMint.length < 30) {
      setEscrowState(null);
      setTokenState(null);
      setEscrowError('');
      return;
    }

    setEscrowLoading(true);
    setEscrowError('');
    setEscrowState(null);
    setTokenState(null);
    setSignature(null);

    try {
      // First try as an ANT mint (derive the PDA)
      const state = await fetchEscrowState(connection, antMint);
      if (state) {
        setEscrowState(state);
        return;
      }

      // If not found as ANT, try fetching the address directly as a PDA
      // (for token/vault escrows where the user pastes the PDA address)
      const rawAccount = await fetchRawEscrowAccount(connection, antMint);
      if (rawAccount && rawAccount.size === ESCROW_TOKEN_ACCOUNT_SIZE) {
        const tState = deserializeEscrowToken(rawAccount.data);
        setTokenState(tState);
        return;
      }

      setEscrowError('No active escrow found for this identifier.');
    } catch (e) {
      setEscrowError(
        `Failed to fetch escrow: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setEscrowLoading(false);
    }
  }, [antMint, connection]);

  useEffect(() => {
    if (antMint && antMint.length >= 32) {
      fetchEscrow();
    }
  }, [antMint, fetchEscrow]);

  // -------------------------------------------------------------------
  // Auto-discover escrows addressed to connected source wallet
  // -------------------------------------------------------------------
  useEffect(() => {
    const addr = arweaveAddress;
    if (!addr) return;

    let cancelled = false;
    (async () => {
      setRecipientDiscoveryLoading(true);
      setRecipientDiscoveryError('');
      try {
        const modulus = await lookupArweaveModulus(addr);
        const modulusBytes = parseArweaveRecipient(modulus);
        const results = await fetchEscrowsByRecipient(
          connection,
          'arweave',
          modulusBytes,
        );
        if (!cancelled) {
          setRecipientEscrows(results);
          setRecipientDiscoveryDone(true);
        }
      } catch (e) {
        if (!cancelled) {
          setRecipientDiscoveryError(
            `Could not look up escrows: ${e instanceof Error ? e.message : String(e)}. You can still enter an ANT mint manually above.`,
          );
          setRecipientDiscoveryDone(true);
        }
      } finally {
        if (!cancelled) setRecipientDiscoveryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [arweaveAddress, connection]);

  useEffect(() => {
    const addr = ethereumAddress;
    if (!addr) return;

    let cancelled = false;
    (async () => {
      setRecipientDiscoveryLoading(true);
      setRecipientDiscoveryError('');
      try {
        let hex = addr.trim();
        if (hex.startsWith('0x') || hex.startsWith('0X')) hex = hex.slice(2);
        const addrBytes = new Uint8Array(20);
        for (let i = 0; i < 20; i++) {
          addrBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        const results = await fetchEscrowsByRecipient(
          connection,
          'ethereum',
          addrBytes,
        );
        if (!cancelled) {
          setRecipientEscrows(results);
          setRecipientDiscoveryDone(true);
        }
      } catch (e) {
        if (!cancelled) {
          setRecipientDiscoveryError(
            `Could not look up escrows: ${e instanceof Error ? e.message : String(e)}. You can still enter an ANT mint manually above.`,
          );
          setRecipientDiscoveryDone(true);
        }
      } finally {
        if (!cancelled) setRecipientDiscoveryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ethereumAddress, connection]);

  // Reset discovery when source wallet disconnects
  useEffect(() => {
    if (!arweaveAddress && !ethereumAddress) {
      setRecipientEscrows([]);
      setRecipientDiscoveryDone(false);
      setRecipientDiscoveryError('');
    }
  }, [arweaveAddress, ethereumAddress]);

  // The active escrow (whichever type is loaded)
  const activeProtocol = escrowState?.recipientProtocol ?? tokenState?.recipientProtocol;
  const activeNonce = escrowState?.nonce ?? tokenState?.nonce;

  // -------------------------------------------------------------------
  // Canonical message preview
  // -------------------------------------------------------------------
  const messagePreview = (() => {
    if (!claimant) return null;
    if (escrowState) {
      return canonicalMessagePreview({
        network,
        antMint,
        claimant,
        nonce: escrowState.nonce,
        recipientPubkey: escrowState.recipientPubkey,
      });
    }
    if (tokenState) {
      return canonicalMessageV2Preview({
        network,
        type: tokenState.assetType,
        assetId: tokenState.assetId,
        amount: tokenState.amount,
        claimant,
        nonce: tokenState.nonce,
        recipientPubkey: tokenState.recipientPubkey,
      });
    }
    return null;
  })();

  // -------------------------------------------------------------------
  // Sign canonical message
  // -------------------------------------------------------------------
  const handleArweaveSign = useCallback(async () => {
    if ((!escrowState && !tokenState) || !claimant) return;
    setSigning(true);
    setSignError('');

    try {
      const arweaveWallet = (window as any).arweaveWallet;
      if (!arweaveWallet) throw new Error('Arweave wallet not connected');

      // Fetch the wallet's RSA modulus (JWK "n" field, base64url) BEFORE
      // building the canonical message. The on-chain canonical message
      // includes a `recipient` field derived from
      // `sha256(escrow.recipient_pubkey)`. The off-chain attestor
      // builds the same field from this modulus. Mismatched modulus →
      // divergent canonical → on-chain Ed25519 verify fails. (F-1)
      const modulusB64Url: string = await arweaveWallet.getActivePublicKey();
      if (!modulusB64Url || typeof modulusB64Url !== 'string') {
        throw new Error('Wallet did not return an RSA public key');
      }
      const modulusBytes = parseArweaveRecipient(modulusB64Url);
      if (modulusBytes.length !== 512) {
        throw new Error(
          `Wallet returned a non-4096-bit modulus (${modulusBytes.length * 8} bits). The escrow program only supports RSA-4096 keys.`,
        );
      }

      const messageBytes = escrowState
        ? canonicalMessage({
            network,
            antMint,
            claimant,
            nonce: escrowState.nonce,
            recipientPubkey: modulusBytes,
          })
        : canonicalMessageV2({
            network,
            type: tokenState!.assetType,
            assetId: tokenState!.assetId,
            amount: tokenState!.amount,
            claimant,
            nonce: tokenState!.nonce,
            recipientPubkey: modulusBytes,
          });

      // signMessage return shape varies by wallet:
      // - Wander/ArConnect: Uint8Array (512 bytes)
      // - Some wallets: ArrayBuffer
      // - Some wallets: { signature: Uint8Array }
      const raw = await arweaveWallet.signMessage(messageBytes);
      let sig: Uint8Array;
      if (raw instanceof Uint8Array) {
        sig = raw;
      } else if (raw instanceof ArrayBuffer) {
        sig = new Uint8Array(raw);
      } else if (raw?.signature) {
        sig = new Uint8Array(raw.signature);
      } else {
        throw new Error('Unexpected signMessage return format');
      }
      if (sig.length !== 512) {
        throw new Error(`Expected 512-byte RSA-PSS signature, got ${sig.length} bytes`);
      }
      setSignature(sig);
      setArweaveModulus(modulusBytes);
    } catch (e) {
      setSignError(
        `Arweave signing failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setSigning(false);
    }
  }, [escrowState, tokenState, claimant, antMint, network]);

  const handleEthereumSign = useCallback(async () => {
    if ((!escrowState && !tokenState) || !claimant || !ethereumProvider) return;
    setSigning(true);
    setSignError('');

    try {
      // Ethereum: recipient_pubkey is the 20-byte address stored on-chain.
      const ethRecipient = escrowState?.recipientPubkey
        ?? tokenState?.recipientPubkey
        ?? new Uint8Array(0);
      const messageBytes = escrowState
        ? canonicalMessage({
            network,
            antMint,
            claimant,
            nonce: escrowState.nonce,
            recipientPubkey: ethRecipient,
          })
        : canonicalMessageV2({
            network,
            type: tokenState!.assetType,
            assetId: tokenState!.assetId,
            amount: tokenState!.amount,
            claimant,
            nonce: tokenState!.nonce,
            recipientPubkey: ethRecipient,
          });

      // Use ethers to sign the message via the injected provider.
      // personal_sign applies EIP-191 prefix automatically.
      const { BrowserProvider } = await import('ethers');
      const provider = new BrowserProvider(ethereumProvider);
      const signer = await provider.getSigner();
      const messageString = new TextDecoder().decode(messageBytes);
      const sigHex = await signer.signMessage(messageString);

      // Convert hex signature to 65-byte Uint8Array (r || s || v)
      const sigBytes = hexToBytes(sigHex);
      setSignature(sigBytes);
    } catch (e) {
      setSignError(
        `Ethereum signing failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setSigning(false);
    }
  }, [escrowState, tokenState, claimant, antMint, network, ethereumProvider]);

  // -------------------------------------------------------------------
  // Submit claim transaction
  // -------------------------------------------------------------------
  const handleSubmitClaim = useCallback(async () => {
    if ((!escrowState && !tokenState) || !claimant || !signature || !publicKey) return;

    setClaimStatus('submitting');
    setClaimMessage('Verifying escrow state is still current...');

    try {
      // Lazy-construct the attestor client so the Ethereum-only path
      // doesn't break if VITE_ATTESTOR_URL is unset.
      const attestorUrl = import.meta.env.VITE_ATTESTOR_URL as string | undefined;
      const attestor = attestorUrl
        ? new AttestorClient({
            url: attestorUrl,
            expectNetwork: network,
          })
        : null;

      const needsAttestor =
        (escrowState && escrowState.recipientProtocol === 'arweave') ||
        (tokenState && tokenState.recipientProtocol === 'arweave');
      if (needsAttestor && !attestor) {
        throw new Error(
          'Arweave claims require the attestor service. Set VITE_ATTESTOR_URL in the environment and reload.',
        );
      }
      if (needsAttestor && !arweaveModulus) {
        throw new Error(
          'Sign step did not capture an Arweave RSA modulus. Disconnect, reconnect, and sign again.',
        );
      }

      if (escrowState) {
        // --- ANT escrow claim ---
        const freshState = await fetchEscrowState(connection, antMint);
        if (!freshState) {
          throw new Error('Escrow no longer exists — it may have been cancelled or already claimed.');
        }
        const nonceMatch = freshState.nonce.length === escrowState.nonce.length &&
          freshState.nonce.every((b, i) => b === escrowState.nonce[i]);
        if (!nonceMatch) {
          setSignature(null);
          setArweaveModulus(null);
          throw new Error(
            'The escrow recipient was updated since you signed. ' +
            'Your signature is no longer valid. Please sign again with the new nonce.',
          );
        }

        const { PublicKey, Transaction, SystemProgram } = await import(
          '@solana/web3.js'
        );
        const escrowProgramId = new PublicKey(ESCROW_PROGRAM_ID);
        const antMintPubkey = new PublicKey(antMint);
        const [escrowPda] = PublicKey.findProgramAddressSync(
          [Buffer.from('escrow_ant'), antMintPubkey.toBuffer()],
          escrowProgramId,
        );

        const tx = new Transaction();

        if (escrowState.recipientProtocol === 'arweave') {
          // --- Attested Arweave path: POST to attestor → Ed25519 ix + claim_*_attested ix ---
          setClaimMessage('Requesting Ed25519 attestation from the attestor service...');
          const attestation = await attestor!.attest({
            claimKind: 'ant',
            antMintBase58: antMint,
            claimantBase58: claimant,
            nonceHex: bytesToHexLower(escrowState.nonce),
            rsaModulusBase64Url: bytesToBase64Url(arweaveModulus!),
            rsaSignatureBase64Url: bytesToBase64Url(signature),
            saltLength: 32,
          });

          setClaimMessage('Building claim transaction...');
          const attestorPubkeyBytes = (await import('bs58')).default.decode(
            attestation.attestorPubkeyBase58,
          );
          const attestationSigBytes = base64UrlToBytes(
            attestation.attestationSignatureBase64Url,
          );
          const messageBytes = base64UrlToBytes(
            attestation.canonicalMessageBase64Url,
          );

          const ed25519Ix = await buildEd25519SigverifyIx(
            attestorPubkeyBytes,
            attestationSigBytes,
            messageBytes,
          );
          const claimIx = await buildClaimAntArweaveAttestedIx({
            escrowPda: escrowPda.toBase58(),
            antMint,
            claimant,
            depositor: freshState.depositor,
            payer: publicKey.toBase58(),
            messageNonce: escrowState.nonce,
          });
          tx.add(ed25519Ix);
          tx.add(claimIx);
        } else {
          // --- Ethereum on-chain path (unchanged) ---
          setClaimMessage('Building claim transaction...');
          const { TransactionInstruction } = await import('@solana/web3.js');
          const { sha256 } = await import('@noble/hashes/sha256');
          const claimantPubkey = new PublicKey(claimant);
          const depositorPubkey = new PublicKey(freshState.depositor);
          const mplCoreProgramId = new PublicKey(
            'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
          );
          const discriminator = sha256(
            new TextEncoder().encode('global:claim_ant_ethereum'),
          ).slice(0, 8);
          const data = Buffer.alloc(8 + 32 + 65);
          data.set(discriminator, 0);
          data.set(escrowState.nonce, 8);
          data.set(signature, 8 + 32);

          tx.add(
            new TransactionInstruction({
              programId: escrowProgramId,
              keys: [
                { pubkey: escrowPda, isSigner: false, isWritable: true },
                { pubkey: antMintPubkey, isSigner: false, isWritable: true },
                { pubkey: claimantPubkey, isSigner: false, isWritable: false },
                { pubkey: depositorPubkey, isSigner: false, isWritable: true },
                { pubkey: publicKey, isSigner: true, isWritable: true },
                { pubkey: mplCoreProgramId, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              ],
              data,
            }),
          );
        }

        setClaimMessage('Waiting for wallet approval...');
        const sig = await sendTransaction(tx, connection);

        setClaimMessage('Confirming transaction...');
        await connection.confirmTransaction(sig, 'confirmed');

        setTxSignature(sig);
        setClaimStatus('success');
        setClaimMessage(`Claim confirmed! ANT ${antMint} has been released to ${claimant}.`);
      } else if (tokenState) {
        // --- Token/vault escrow claim ---
        const rawAccount = await fetchRawEscrowAccount(connection, antMint);
        if (!rawAccount || rawAccount.size !== ESCROW_TOKEN_ACCOUNT_SIZE) {
          throw new Error('Escrow no longer exists — it may have been cancelled or already claimed.');
        }
        const freshToken = deserializeEscrowToken(rawAccount.data);
        const nonceMatch = freshToken.nonce.length === tokenState.nonce.length &&
          freshToken.nonce.every((b, i) => b === tokenState.nonce[i]);
        if (!nonceMatch) {
          setSignature(null);
          setArweaveModulus(null);
          throw new Error(
            'The escrow recipient was updated since you signed. ' +
            'Your signature is no longer valid. Please sign again with the new nonce.',
          );
        }

        const { PublicKey, Transaction, SystemProgram, TransactionInstruction } =
          await import('@solana/web3.js');
        const { sha256 } = await import('@noble/hashes/sha256');

        const escrowProgramId = new PublicKey(ESCROW_PROGRAM_ID);
        const claimantPubkey = new PublicKey(claimant);
        const depositorPubkey = new PublicKey(freshToken.depositor);
        const arioMint = new PublicKey(freshToken.arioMint);
        const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

        // Use the PDA address the user pasted as the escrow PDA.
        const escrowPda = new PublicKey(antMint);
        const ataProgramId = new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL');
        const [escrowAta] = PublicKey.findProgramAddressSync(
          [escrowPda.toBuffer(), tokenProgram.toBuffer(), arioMint.toBuffer()],
          ataProgramId,
        );
        const [claimantAta] = PublicKey.findProgramAddressSync(
          [claimantPubkey.toBuffer(), tokenProgram.toBuffer(), arioMint.toBuffer()],
          ataProgramId,
        );
        const [payerAta] = PublicKey.findProgramAddressSync(
          [publicKey.toBuffer(), tokenProgram.toBuffer(), arioMint.toBuffer()],
          ataProgramId,
        );

        const tx = new Transaction();

        if (tokenState.recipientProtocol === 'arweave') {
          // --- Attested Arweave path for token / vault escrows ---
          setClaimMessage('Requesting Ed25519 attestation from the attestor service...');
          const attestation = await attestor!.attest({
            claimKind: tokenState.assetType,
            assetIdHex: bytesToHexLower(tokenState.assetId),
            amount: tokenState.amount.toString(),
            claimantBase58: claimant,
            nonceHex: bytesToHexLower(tokenState.nonce),
            rsaModulusBase64Url: bytesToBase64Url(arweaveModulus!),
            rsaSignatureBase64Url: bytesToBase64Url(signature),
            saltLength: 32,
          });

          setClaimMessage('Building claim transaction...');
          const attestorPubkeyBytes = (await import('bs58')).default.decode(
            attestation.attestorPubkeyBase58,
          );
          const attestationSigBytes = base64UrlToBytes(
            attestation.attestationSignatureBase64Url,
          );
          const messageBytes = base64UrlToBytes(
            attestation.canonicalMessageBase64Url,
          );

          const ed25519Ix = await buildEd25519SigverifyIx(
            attestorPubkeyBytes,
            attestationSigBytes,
            messageBytes,
          );
          tx.add(ed25519Ix);

          if (tokenState.assetType === 'vault') {
            tx.add(
              await buildClaimVaultArweaveAttestedIx({
                escrowPda: escrowPda.toBase58(),
                escrowTokenAccount: escrowAta.toBase58(),
                claimantTokenAccount: claimantAta.toBase58(),
                payerTokenAccount: payerAta.toBase58(),
                claimant,
                depositor: freshToken.depositor,
                payer: publicKey.toBase58(),
                messageNonce: tokenState.nonce,
              }),
            );
            // Active-vault path: the on-chain claim_vault_*_attested
            // releases tokens to payer_token_account, then introspects
            // the tx for a sibling `ario_core::vaulted_transfer` ix
            // that re-locks the same amount for the claimant. We
            // bundle that sibling here. Expired vaults skip this path
            // and just receive liquid tokens at claimant_token_account.
            const nowSeconds = BigInt(Math.floor(Date.now() / 1000));
            const remaining = tokenState.vaultEndTimestamp - nowSeconds;
            if (remaining > 0n) {
              setClaimMessage(
                'Bundling sibling vaulted_transfer (active-vault path)...',
              );
              const nextId = await getNextVaultIdForOwner(connection, claimant);
              const { vaultCounter, vault } = await deriveVaultPdas(
                claimant,
                nextId,
              );
              const vaultAta = await deriveAtaForOwner(
                vault,
                freshToken.arioMint,
              );
              tx.add(
                await buildVaultedTransferIx({
                  recipient: claimant,
                  recipientVaultCounter: vaultCounter,
                  vault,
                  senderTokenAccount: payerAta.toBase58(),
                  vaultTokenAccount: vaultAta,
                  arioMint: freshToken.arioMint,
                  sender: publicKey.toBase58(),
                  amount: tokenState.amount,
                  lockDurationSeconds: remaining,
                  revocable: tokenState.vaultRevocable,
                }),
              );
            }
          } else {
            tx.add(
              await buildClaimTokensArweaveAttestedIx({
                escrowPda: escrowPda.toBase58(),
                escrowTokenAccount: escrowAta.toBase58(),
                claimantTokenAccount: claimantAta.toBase58(),
                claimant,
                depositor: freshToken.depositor,
                payer: publicKey.toBase58(),
                messageNonce: tokenState.nonce,
              }),
            );
          }
        } else {
          // --- Ethereum on-chain path (unchanged) ---
          setClaimMessage('Building claim transaction...');
          const instrName =
            tokenState.assetType === 'vault'
              ? 'claim_vault_ethereum'
              : 'claim_tokens_ethereum';
          const discriminator = sha256(
            new TextEncoder().encode(`global:${instrName}`),
          ).slice(0, 8);
          const data = Buffer.alloc(8 + 32 + 65);
          data.set(discriminator, 0);
          data.set(tokenState.nonce, 8);
          data.set(signature, 8 + 32);

          tx.add(
            new TransactionInstruction({
              programId: escrowProgramId,
              keys: [
                { pubkey: escrowPda, isSigner: false, isWritable: true },
                { pubkey: escrowAta, isSigner: false, isWritable: true },
                { pubkey: claimantAta, isSigner: false, isWritable: true },
                { pubkey: arioMint, isSigner: false, isWritable: false },
                { pubkey: claimantPubkey, isSigner: false, isWritable: false },
                { pubkey: depositorPubkey, isSigner: false, isWritable: true },
                { pubkey: publicKey, isSigner: true, isWritable: true },
                { pubkey: tokenProgram, isSigner: false, isWritable: false },
                { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
              ],
              data,
            }),
          );
        }

        setClaimMessage('Waiting for wallet approval...');
        const sig = await sendTransaction(tx, connection);

        setClaimMessage('Confirming transaction...');
        await connection.confirmTransaction(sig, 'confirmed');

        setTxSignature(sig);
        setClaimStatus('success');
        const amountStr = formatMarioToArio(tokenState.amount);
        setClaimMessage(
          tokenState.assetType === 'vault'
            ? `Claim confirmed! ${amountStr} ARIO vault has been released to ${claimant}.`
            : `Claim confirmed! ${amountStr} ARIO has been released to ${claimant}.`,
        );
      }
    } catch (e) {
      setClaimStatus('error');
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('User rejected') || msg.includes('user rejected')) {
        setClaimMessage('Transaction cancelled by user.');
      } else {
        setClaimMessage(`Claim failed: ${msg}`);
      }
    }
  }, [
    escrowState,
    tokenState,
    claimant,
    signature,
    arweaveModulus,
    publicKey,
    antMint,
    connection,
    sendTransaction,
    network,
  ]);

  const hasSignature = !!signature;
  // Validate claimant is a plausible Solana base58 pubkey (32-44 chars, base58 alphabet)
  const isValidClaimant = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(claimant.trim());
  const hasEscrow = !!escrowState || !!tokenState;
  const canSign = hasEscrow && isValidClaimant && !signing;
  const canClaim = hasSignature && publicKey && claimStatus !== 'submitting';

  return (
    <div style={styles.wrap}>
      <h1 style={styles.h1}>Claim an escrow</h1>
      <p style={styles.lede}>
        A depositor sent you an ANT or ARIO tokens. Connect your Arweave or
        Ethereum wallet to sign the canonical message; the on-chain
        verifier will release the asset to the Solana wallet you specify.
        If someone shared a claim link with you, the identifier is already
        filled in below.
      </p>

      <StepCard n={1} title="Escrow identifier" completed={hasEscrow}>
        <input
          type="text"
          placeholder="ANT mint pubkey or escrow PDA address (base58)"
          value={antMint}
          onChange={(e) => setAntMint(e.target.value)}
          className="input"
          style={styles.input}
        />
        {escrowLoading && (
          <p style={styles.hint}>Loading escrow state...</p>
        )}
        {escrowError && (
          <p style={styles.errorHint}>{escrowError}</p>
        )}
        {escrowState && (
          <div style={styles.escrowCard}>
            <h3 style={styles.escrowCardTitle}>An ANT has been deposited for you</h3>
            <div style={styles.escrowCardRow}>
              <span style={styles.escrowCardLabel}>ANT Mint</span>
              <code style={styles.escrowCardValue}>{escrowState.antMint}</code>
            </div>
            <div style={styles.escrowCardRow}>
              <span style={styles.escrowCardLabel}>Deposited by</span>
              <code style={styles.escrowCardValue}>
                {escrowState.depositor.slice(0, 8)}...{escrowState.depositor.slice(-4)}
              </code>
            </div>
            <div style={styles.escrowCardRow}>
              <span style={styles.escrowCardLabel}>Your identity type</span>
              <span style={styles.escrowCardValue}>
                {escrowState.recipientProtocol === 'arweave'
                  ? 'Arweave (RSA-PSS-4096)'
                  : 'Ethereum (ECDSA secp256k1)'}
              </span>
            </div>
            <p style={styles.escrowCardNote}>
              To claim this ANT, connect the matching wallet below and sign
              the canonical message.
            </p>
          </div>
        )}
        {tokenState && (
          <div style={styles.escrowCard}>
            <h3 style={styles.escrowCardTitle}>
              {tokenState.assetType === 'vault' ? 'A vaulted ARIO deposit' : 'An ARIO token deposit'} has been escrowed for you
            </h3>
            <div style={styles.escrowCardRow}>
              <span style={styles.escrowCardLabel}>Amount</span>
              <span style={styles.escrowCardValue}>{formatMarioToArio(tokenState.amount)} ARIO</span>
            </div>
            <div style={styles.escrowCardRow}>
              <span style={styles.escrowCardLabel}>Type</span>
              <span style={styles.escrowCardValue}>
                {tokenState.assetType === 'vault' ? 'Vault (time-locked)' : 'Token'}
              </span>
            </div>
            {tokenState.assetType === 'vault' && tokenState.vaultEndTimestamp > 0n && (
              <div style={styles.escrowCardRow}>
                <span style={styles.escrowCardLabel}>
                  {Number(tokenState.vaultEndTimestamp) * 1000 > Date.now() ? 'Locked until' : 'Lock expired'}
                </span>
                <span style={styles.escrowCardValue}>
                  {new Date(Number(tokenState.vaultEndTimestamp) * 1000).toLocaleString()}
                  {Number(tokenState.vaultEndTimestamp) * 1000 > Date.now()
                    ? ' — your tokens will be placed in a vault'
                    : ' — you will receive liquid ARIO'}
                </span>
              </div>
            )}
            <div style={styles.escrowCardRow}>
              <span style={styles.escrowCardLabel}>Deposited by</span>
              <code style={styles.escrowCardValue}>
                {tokenState.depositor.slice(0, 8)}...{tokenState.depositor.slice(-4)}
              </code>
            </div>
            <div style={styles.escrowCardRow}>
              <span style={styles.escrowCardLabel}>Your identity type</span>
              <span style={styles.escrowCardValue}>
                {tokenState.recipientProtocol === 'arweave'
                  ? 'Arweave (RSA-PSS-4096)'
                  : 'Ethereum (ECDSA secp256k1)'}
              </span>
            </div>
            <p style={styles.escrowCardNote}>
              To claim this deposit, connect the matching wallet below and sign
              the canonical message.
            </p>
          </div>
        )}
      </StepCard>

      {/* Recipient discovery: shown when a source wallet is connected */}
      {(arweaveAddress || ethereumAddress) && (
        <div style={styles.discoverySection}>
          {recipientDiscoveryLoading && (
            <p style={styles.discoveryLoading}>Checking for escrows addressed to your wallet...</p>
          )}
          {recipientDiscoveryError && (
            <p style={styles.discoveryWarning}>{recipientDiscoveryError}</p>
          )}
          {recipientDiscoveryDone && !recipientDiscoveryError && recipientEscrows.length === 0 && (
            <p style={styles.hint}>
              No escrows found for this wallet. If you have a claim link, paste the ANT mint above.
            </p>
          )}
          {recipientEscrows.length > 0 && (
            <div style={styles.discoveryList}>
              <p style={styles.discoveryTitle}>Escrows addressed to you</p>
              {recipientEscrows.map((e) => (
                <div key={e.antMint} style={styles.discoveryCard}>
                  <div style={styles.discoveryCardRow}>
                    <span style={styles.discoveryCardLabel}>ANT Mint</span>
                    <code style={styles.discoveryCardValue}>
                      {e.antMint.slice(0, 12)}...{e.antMint.slice(-4)}
                    </code>
                  </div>
                  <div style={styles.discoveryCardRow}>
                    <span style={styles.discoveryCardLabel}>Depositor</span>
                    <code style={styles.discoveryCardValue}>
                      {e.state.depositor.slice(0, 8)}...{e.state.depositor.slice(-4)}
                    </code>
                  </div>
                  <button
                    type="button"
                    style={styles.discoveryClaimButton}
                    onClick={() => setAntMint(e.antMint)}
                  >
                    Claim this ANT
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <StepCard n={2} title="Solana destination wallet" completed={isValidClaimant} active={hasEscrow}>
        <input
          type="text"
          placeholder="Solana pubkey that will receive the ANT"
          value={claimant}
          onChange={(e) => {
            setClaimant(e.target.value);
            // Signature is bound to the claimant address — invalidate
            // if the address changes so the user must re-sign.
            if (signature) {
              setSignature(null);
              setArweaveModulus(null);
            }
          }}
          className="input"
          style={styles.input}
        />
        <p style={styles.hint}>
          This is the Solana wallet that will receive the ANT. The address is
          cryptographically bound into the message you sign, so no one can
          redirect it.
        </p>
      </StepCard>

      <StepCard n={3} title="Sign canonical message" completed={!!signature} active={isValidClaimant}>
        {/* Canonical message preview */}
        <pre style={styles.canonicalPreview}>
          {messagePreview
            ? messagePreview
            : hasEscrow
              ? '(enter your Solana destination above to preview the message)'
              : '(fetch escrow state in step 1 to preview)'}
        </pre>
        <p style={styles.hint}>
          Your wallet will sign exactly these bytes. For Ethereum wallets,
          the standard personal_sign prefix is applied automatically.
        </p>

        {/* Source wallet connection */}
        {hasEscrow && (
          <div style={{ marginTop: '16px' }}>
            {activeProtocol === 'arweave' ? (
              <>
                <ArweaveWalletConnect
                  onConnect={(addr) => setArweaveAddress(addr)}
                  onDisconnect={() => {
                    setArweaveAddress(undefined);
                    setSignature(null);
                    setArweaveModulus(null);
                  }}
                  connectedAddress={arweaveAddress}
                />
                {arweaveAddress && !hasSignature && (
                  <button
                    type="button"
                    style={{
                      ...styles.signButton,
                      opacity: canSign ? 1 : 0.6,
                      cursor: canSign ? 'pointer' : 'not-allowed',
                      marginTop: '12px',
                    }}
                    disabled={!canSign}
                    onClick={handleArweaveSign}
                  >
                    {signing ? 'Signing...' : 'Sign with Arweave wallet'}
                  </button>
                )}
              </>
            ) : (
              <>
                <EthereumWalletConnect
                  onConnect={(addr, provider) => {
                    setEthereumAddress(addr);
                    setEthereumProvider(provider);
                  }}
                  onDisconnect={() => {
                    setEthereumAddress(undefined);
                    setEthereumProvider(undefined);
                    setSignature(null);
                  }}
                  connectedAddress={ethereumAddress}
                />
                {ethereumAddress && !hasSignature && (
                  <button
                    type="button"
                    style={{
                      ...styles.signButton,
                      opacity: canSign ? 1 : 0.6,
                      cursor: canSign ? 'pointer' : 'not-allowed',
                      marginTop: '12px',
                    }}
                    disabled={!canSign}
                    onClick={handleEthereumSign}
                  >
                    {signing ? 'Signing...' : 'Sign with Ethereum wallet'}
                  </button>
                )}
              </>
            )}
            {signError && <p style={styles.errorHint}>{signError}</p>}
            {hasSignature && (
              <div style={styles.signatureConfirm}>
                Signature captured ({signature!.length} bytes). Ready to submit.
              </div>
            )}
          </div>
        )}
      </StepCard>

      <StepCard n={4} title="Submit claim" completed={claimStatus === 'success'} active={!!signature}>
        {!hasSignature ? (
          <p style={styles.hint}>
            Complete step 3 (sign the canonical message) to enable the claim button.
          </p>
        ) : (
          <>
            <p style={styles.hint}>
              Connect a Solana wallet to submit the claim transaction.
              Anyone can be the fee payer — the ANT goes to the claimant
              address above regardless.
            </p>
            <div style={{ margin: '12px 0' }}>
              <SolanaWalletConnect
                onConnect={(pubkey) => setSolPubkey(pubkey)}
                onDisconnect={() => setSolPubkey(undefined)}
                connectedPubkey={solPubkey}
              />
            </div>
          </>
        )}

        {claimStatus === 'success' ? (
          <div style={styles.successBox}>
            <p style={styles.successText}>{claimMessage}</p>
            {txSignature && (
              <p style={styles.txLink}>
                <a
                  href={`https://explorer.solana.com/tx/${txSignature}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={styles.link}
                >
                  View on Explorer
                </a>
              </p>
            )}
          </div>
        ) : claimStatus === 'error' ? (
          <div style={styles.errorBox}>
            <p style={styles.errorText}>{claimMessage}</p>
            <button
              type="button"
              style={{ ...styles.submit, opacity: 1 }}
              onClick={handleSubmitClaim}
            >
              Retry Claim
            </button>
          </div>
        ) : hasSignature ? (
          <>
            <button
              type="button"
              className="btn-primary"
              style={{
                ...styles.submit,
                opacity: canClaim ? 1 : 0.6,
                cursor: canClaim ? 'pointer' : 'not-allowed',
              }}
              disabled={!canClaim}
              onClick={handleSubmitClaim}
            >
              {claimStatus === 'submitting' ? 'Submitting claim...' : 'Submit claim'}
            </button>
            {claimStatus === 'submitting' && (
              <p style={styles.statusText}>{claimMessage}</p>
            )}
          </>
        ) : null}
      </StepCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  let h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) h = '0' + h;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    maxWidth: '900px',
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  h1: {
    fontFamily: "'Besley', Georgia, serif",
    fontSize: '40px',
    fontWeight: 800,
    color: brand.black,
    lineHeight: 1.15,
    margin: 0,
  },
  lede: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '17px',
    lineHeight: 1.7,
    color: brand.textSecondary,
    marginTop: '-8px',
  },
  input: {
    width: '100%',
    padding: '11px 14px',
    fontSize: '14px',
    border: `1px solid ${brand.border}`,
    borderRadius: '10px',
    background: brand.white,
    fontFamily: 'monospace',
    outline: 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  },
  hint: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.textTertiary,
    margin: '8px 0 0',
  },
  successHint: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.success,
    margin: '8px 0 0',
  },
  errorHint: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.error,
    margin: '8px 0 0',
  },
  escrowCard: {
    marginTop: '12px',
    padding: '24px',
    background: `radial-gradient(ellipse 140% 120% at top left, rgba(84, 39, 200, 0.03), transparent), rgba(255, 255, 255, 0.85)`,
    border: `1px solid ${brand.border}`,
    borderRadius: '16px',
    boxShadow: '0 1px 3px rgba(35, 35, 45, 0.04)',
  },
  escrowCardTitle: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 700,
    color: brand.black,
    margin: '0 0 16px',
  },
  escrowCardRow: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
    marginBottom: '10px',
  },
  escrowCardLabel: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '11px',
    fontWeight: 700,
    color: brand.textTertiary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  escrowCardValue: {
    fontSize: '13px',
    color: brand.black,
    fontFamily: 'monospace',
    wordBreak: 'break-all' as const,
  },
  escrowCardNote: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    lineHeight: 1.5,
    color: brand.textSecondary,
    margin: '14px 0 0',
    paddingTop: '12px',
    borderTop: `1px solid ${brand.border}`,
  },
  code: {
    fontFamily: 'monospace',
    fontSize: '12px',
    background: 'rgba(84, 39, 200, 0.06)',
    padding: '2px 6px',
    borderRadius: '4px',
    margin: '0 4px',
    color: brand.black,
  },
  canonicalPreview: {
    background: brand.cardSurface,
    border: `1px solid ${brand.border}`,
    borderRadius: '10px',
    padding: '16px',
    fontSize: '12px',
    fontFamily: 'monospace',
    margin: 0,
    whiteSpace: 'pre' as const,
    overflow: 'auto',
  },
  signButton: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    padding: '10px 18px',
    border: 'none',
    borderRadius: '10px',
    background: brand.primary,
    color: brand.white,
    fontSize: '14px',
    fontWeight: 700,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
  signatureConfirm: {
    marginTop: '12px',
    padding: '10px 14px',
    background: brand.successBg,
    border: `1px solid ${brand.success}33`,
    borderRadius: '10px',
    fontSize: '13px',
    color: brand.success,
    fontWeight: 600,
    fontFamily: "'Plus Jakarta Sans', sans-serif",
  },
  submit: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    padding: '12px 24px',
    border: 'none',
    borderRadius: '10px',
    background: brand.primary,
    color: brand.white,
    fontSize: '15px',
    fontWeight: 700,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
  statusText: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.primary,
    marginTop: '8px',
  },
  successBox: {
    padding: '16px',
    background: brand.successBg,
    borderRadius: '10px',
    border: `1px solid ${brand.success}33`,
  },
  successText: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '14px',
    color: brand.success,
    fontWeight: 600,
    margin: 0,
  },
  txLink: {
    fontSize: '13px',
    margin: '8px 0 0',
  },
  errorBox: {
    padding: '14px 16px',
    background: brand.errorBg,
    borderRadius: '10px',
    border: `1px solid ${brand.error}33`,
  },
  errorText: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '14px',
    color: brand.error,
    margin: '0 0 12px',
  },
  link: { color: brand.primary, textDecoration: 'none' },
  discoverySection: {
    marginTop: '-8px',
  },
  discoveryLoading: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.textTertiary,
    margin: '0',
    fontStyle: 'italic' as const,
  },
  discoveryWarning: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.textTertiary,
    margin: '0',
  },
  discoveryList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  },
  discoveryTitle: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '14px',
    fontWeight: 700,
    color: brand.black,
    margin: '0 0 4px',
  },
  discoveryCard: {
    padding: '16px 20px',
    background: `radial-gradient(ellipse 140% 120% at top left, rgba(84, 39, 200, 0.03), transparent), rgba(255, 255, 255, 0.85)`,
    border: `1px solid ${brand.border}`,
    borderRadius: '16px',
    boxShadow: '0 1px 3px rgba(35, 35, 45, 0.04)',
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    flexWrap: 'wrap' as const,
  },
  discoveryCardRow: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
    minWidth: '120px',
  },
  discoveryCardLabel: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '11px',
    fontWeight: 700,
    color: brand.textTertiary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  discoveryCardValue: {
    fontSize: '13px',
    color: brand.black,
    fontFamily: 'monospace',
    wordBreak: 'break-all' as const,
  },
  discoveryClaimButton: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    padding: '8px 16px',
    border: `1px solid ${brand.border}`,
    borderRadius: '10px',
    background: brand.cardSurface,
    color: brand.black,
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    marginLeft: 'auto',
    transition: 'all 0.15s',
  },
};
