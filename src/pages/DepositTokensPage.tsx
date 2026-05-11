import React, { useState, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useConnection } from '@solana/wallet-adapter-react';
import { brand } from '../brand.js';
import { StepCard } from '../components/StepCard.tsx';
import { SolanaWalletConnect } from '../components/SolanaWalletConnect.tsx';
import {
  parseArweaveRecipient,
  parseEthereumRecipient,
  isArweaveAddress,
  lookupArweaveModulus,
  ESCROW_PROGRAM_ID,
  ESCROW_TOKEN_SEED,
} from '../services/escrow-client.ts';

/**
 * Deposit ARIO tokens into escrow, addressed to an Arweave or Ethereum
 * identity. The recipient claims the tokens by signing a canonical
 * message that the on-chain verifier checks.
 */
export function DepositTokensPage() {
  const [protocol, setProtocol] = useState<'arweave' | 'ethereum'>('arweave');
  const [amountInput, setAmountInput] = useState('');
  const [recipientInput, setRecipientInput] = useState('');
  const [solPubkey, setSolPubkey] = useState<string | undefined>();
  const [status, setStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [statusMessage, setStatusMessage] = useState('');
  const [txSignature, setTxSignature] = useState('');
  const [arweaveLookup, setArweaveLookup] = useState<
    'idle' | 'loading' | 'success' | 'error'
  >('idle');
  const [arweaveLookupMessage, setArweaveLookupMessage] = useState('');

  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();

  // Parse amount: user enters ARIO, we convert to mARIO (6 decimals)
  const parsedMario = (() => {
    const val = parseFloat(amountInput);
    if (isNaN(val) || val <= 0) return null;
    return BigInt(Math.round(val * 1_000_000));
  })();

  const handleArweaveRecipientChange = useCallback(
    async (value: string) => {
      setRecipientInput(value);
      if (arweaveLookup !== 'idle') {
        setArweaveLookup('idle');
        setArweaveLookupMessage('');
      }
      const trimmed = value.trim();
      if (isArweaveAddress(trimmed)) {
        setArweaveLookup('loading');
        setArweaveLookupMessage('Looking up public key...');
        try {
          const modulus = await lookupArweaveModulus(trimmed);
          setRecipientInput(modulus);
          setArweaveLookup('success');
          setArweaveLookupMessage(
            'Resolved Arweave address \u2192 RSA public key (512 bytes)',
          );
        } catch (e) {
          setArweaveLookup('error');
          setArweaveLookupMessage(
            e instanceof Error ? e.message : String(e),
          );
        }
      }
    },
    [arweaveLookup],
  );

  const handleDeposit = useCallback(async () => {
    if (!publicKey || !parsedMario || !recipientInput) return;

    setStatus('submitting');
    setStatusMessage('Preparing deposit transaction...');

    try {
      // 1. Parse the recipient public key from user input
      let recipientPubkey: Uint8Array;
      try {
        recipientPubkey =
          protocol === 'arweave'
            ? parseArweaveRecipient(recipientInput)
            : parseEthereumRecipient(recipientInput);
      } catch (e) {
        throw new Error(
          `Invalid ${protocol} recipient: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const { PublicKey, TransactionInstruction, Transaction, SystemProgram } =
        await import('@solana/web3.js');
      const { sha256 } = await import('@noble/hashes/sha256');

      const escrowProgramId = new PublicKey(ESCROW_PROGRAM_ID);

      // Generate a unique asset_id for this deposit. Uses crypto.randomUUID
      // for uniqueness. The batch script uses deterministic hashes instead.
      const nonce = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
      const assetIdInput = `token-escrow:${publicKey.toBase58()}:${nonce}`;
      const assetId = sha256(new TextEncoder().encode(assetIdInput));

      // Derive the escrow PDA: ["escrow_token", depositor, asset_id]
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from(ESCROW_TOKEN_SEED), publicKey.toBuffer(), Buffer.from(assetId)],
        escrowProgramId,
      );

      // ARIO mint address (mainnet)
      // TODO: make configurable for devnet
      const arioMint = new PublicKey('ARiotkVQiLCdng5y3Grf8XLfXJiAR4Dqfsrfcbq5Zo3');

      // Token program
      const tokenProgram = new PublicKey('TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA');

      // Derive depositor ATA
      const [depositorAta] = PublicKey.findProgramAddressSync(
        [publicKey.toBuffer(), tokenProgram.toBuffer(), arioMint.toBuffer()],
        new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
      );

      // Derive escrow ATA
      const [escrowAta] = PublicKey.findProgramAddressSync(
        [escrowPda.toBuffer(), tokenProgram.toBuffer(), arioMint.toBuffer()],
        new PublicKey('ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL'),
      );

      // 2. Encode instruction data
      // Discriminator = sha256("global:deposit_tokens")[..8]
      const discriminator = sha256(
        new TextEncoder().encode('global:deposit_tokens'),
      ).slice(0, 8);

      // Data: discriminator(8) + asset_id(32) + amount(8) + protocol(1) + pubkey_len(4) + pubkey(N)
      const data = Buffer.alloc(8 + 32 + 8 + 1 + 4 + recipientPubkey.length);
      let offset = 0;
      data.set(discriminator, offset); offset += 8;
      data.set(assetId, offset); offset += 32;
      // Write amount as u64 LE
      const amountBuf = Buffer.alloc(8);
      amountBuf.writeBigUInt64LE(parsedMario);
      data.set(amountBuf, offset); offset += 8;
      data.writeUInt8(protocol === 'arweave' ? 0 : 1, offset); offset += 1;
      data.writeUInt32LE(recipientPubkey.length, offset); offset += 4;
      data.set(recipientPubkey, offset);

      // 3. Build the instruction
      const ix = new TransactionInstruction({
        programId: escrowProgramId,
        keys: [
          { pubkey: escrowPda, isSigner: false, isWritable: true },
          { pubkey: depositorAta, isSigner: false, isWritable: true },
          { pubkey: escrowAta, isSigner: false, isWritable: true },
          { pubkey: arioMint, isSigner: false, isWritable: false },
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: tokenProgram, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      });

      // 4. Send the transaction
      setStatusMessage('Waiting for wallet approval...');
      const tx = new Transaction().add(ix);
      const sig = await sendTransaction(tx, connection);

      setStatusMessage('Confirming transaction...');
      await connection.confirmTransaction(sig, 'confirmed');

      setTxSignature(sig);
      setStatus('success');
      setStatusMessage(
        `Deposit confirmed! ${amountInput} ARIO is now in escrow.`,
      );
    } catch (e) {
      setStatus('error');
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('User rejected') || msg.includes('user rejected')) {
        setStatusMessage('Transaction cancelled by user.');
      } else {
        setStatusMessage(`Deposit failed: ${msg}`);
      }
    }
  }, [publicKey, parsedMario, recipientInput, protocol, amountInput, connection, sendTransaction]);

  const canSubmit =
    solPubkey && parsedMario && parsedMario > 0n && recipientInput.length > 0 && status !== 'submitting';

  return (
    <div style={styles.wrap}>
      <h1 style={styles.h1}>Deposit ARIO Tokens</h1>
      <p style={styles.lede}>
        Lock ARIO tokens into the trustless escrow program. The recipient
        — designated below — releases the tokens by signing a canonical
        message that the on-chain verifier checks against their Arweave
        or Ethereum public key.
      </p>

      <StepCard n={1} title="Connect your Solana wallet" completed={!!solPubkey}>
        <SolanaWalletConnect
          onConnect={(pubkey) => setSolPubkey(pubkey)}
          onDisconnect={() => setSolPubkey(undefined)}
          connectedPubkey={solPubkey}
        />
      </StepCard>

      <StepCard n={2} title="Enter ARIO amount" completed={!!parsedMario} active={!!solPubkey}>
        <input
          type="number"
          placeholder="Amount in ARIO"
          value={amountInput}
          onChange={(e) => setAmountInput(e.target.value)}
          className="input"
          style={styles.input}
          min="0"
          step="any"
        />
        {parsedMario !== null && (
          <p style={styles.conversion}>
            {amountInput} ARIO = {parsedMario.toString()} mARIO
          </p>
        )}
        <p style={styles.hint}>
          1 ARIO = 1,000,000 mARIO. Enter the amount in ARIO; the
          conversion to mARIO (on-chain units) is shown above.
        </p>
      </StepCard>

      <StepCard n={3} title="Choose recipient identity" completed={recipientInput.length > 0} active={!!parsedMario}>
        <div style={styles.protocolPicker}>
          <button
            type="button"
            style={{
              ...styles.protocolButton,
              ...(protocol === 'arweave' ? styles.protocolActive : {}),
            }}
            onClick={() => setProtocol('arweave')}
          >
            Arweave (RSA-PSS-4096)
          </button>
          <button
            type="button"
            style={{
              ...styles.protocolButton,
              ...(protocol === 'ethereum' ? styles.protocolActive : {}),
            }}
            onClick={() => setProtocol('ethereum')}
          >
            Ethereum (ECDSA)
          </button>
        </div>

        {protocol === 'arweave' ? (
          <>
            <textarea
              placeholder="Paste an Arweave address or RSA public key"
              value={recipientInput}
              onChange={(e) => handleArweaveRecipientChange(e.target.value)}
              className="input"
              style={styles.textarea}
              rows={3}
              disabled={arweaveLookup === 'loading'}
            />
            {arweaveLookup === 'loading' && (
              <p style={styles.lookupLoading}>{arweaveLookupMessage}</p>
            )}
            {arweaveLookup === 'success' && (
              <p style={styles.lookupSuccess}>{arweaveLookupMessage}</p>
            )}
            {arweaveLookup === 'error' && (
              <p style={styles.lookupError}>{arweaveLookupMessage}</p>
            )}
            <p style={styles.hint}>
              Paste a 43-character Arweave address and the public key will
              be looked up automatically.
            </p>
          </>
        ) : (
          <input
            type="text"
            placeholder="0x... — 20-byte Ethereum address"
            value={recipientInput}
            onChange={(e) => setRecipientInput(e.target.value)}
            className="input"
            style={styles.input}
          />
        )}
      </StepCard>

      <StepCard n={4} title="Confirm and sign" completed={status === 'success'} active={recipientInput.length > 0}>
        <p style={styles.confirmLine}>
          Escrow rent is fully refundable when claimed or cancelled.
        </p>

        {status === 'success' ? (
          <div style={styles.successBox}>
            <p style={styles.successText}>{statusMessage}</p>
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
        ) : status === 'error' ? (
          <div style={styles.errorBox}>
            <p style={styles.errorText}>{statusMessage}</p>
            <button
              type="button"
              style={{ ...styles.submit, opacity: 1 }}
              onClick={handleDeposit}
            >
              Retry Deposit
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="btn-primary"
              style={{
                ...styles.submit,
                opacity: canSubmit ? 1 : 0.6,
                cursor: canSubmit ? 'pointer' : 'not-allowed',
              }}
              disabled={!canSubmit}
              onClick={handleDeposit}
            >
              {status === 'submitting' ? 'Depositing...' : 'Deposit Tokens'}
            </button>
            {status === 'submitting' && (
              <p style={styles.statusText}>{statusMessage}</p>
            )}
          </>
        )}
      </StepCard>
    </div>
  );
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
  textarea: {
    width: '100%',
    padding: '11px 14px',
    fontSize: '13px',
    border: `1px solid ${brand.border}`,
    borderRadius: '10px',
    background: brand.white,
    fontFamily: 'monospace',
    resize: 'vertical' as const,
    outline: 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  },
  hint: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.textTertiary,
    margin: '8px 0 0',
  },
  conversion: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.primary,
    fontWeight: 600,
    margin: '8px 0 0',
  },
  protocolPicker: {
    display: 'flex',
    gap: '8px',
    marginBottom: '12px',
  },
  protocolButton: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    padding: '10px 16px',
    border: `1px solid ${brand.border}`,
    borderRadius: '10px',
    background: brand.white,
    color: brand.black,
    fontSize: '14px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  protocolActive: {
    background: brand.primary,
    color: brand.white,
    borderColor: brand.primary,
  },
  confirmLine: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.textSecondary,
    marginBottom: '16px',
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
  link: { color: brand.primary, textDecoration: 'none' },
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
  lookupLoading: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.primary,
    margin: '6px 0 0',
    fontStyle: 'italic' as const,
  },
  lookupSuccess: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.success,
    margin: '6px 0 0',
    fontWeight: 600,
  },
  lookupError: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.error,
    margin: '6px 0 0',
  },
};
