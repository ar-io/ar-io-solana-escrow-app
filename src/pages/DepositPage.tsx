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
} from '../services/escrow-client.ts';

/**
 * Depositor flow — lock one of your ANTs into escrow, addressed to an
 * Arweave (RSA-PSS-4096) or Ethereum (ECDSA secp256k1) identity.
 *
 * Builds and submits the `deposit_ant` instruction via the connected
 * Solana wallet. The instruction transfers the ANT (Metaplex Core NFT)
 * into the program's escrow PDA and records the recipient identity.
 */
export function DepositPage() {
  const [protocol, setProtocol] = useState<'arweave' | 'ethereum'>('arweave');
  const [antMint, setAntMint] = useState('');
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

  /**
   * When the Arweave recipient input changes, detect 43-character Arweave
   * addresses and automatically look up their RSA public key via GraphQL.
   */
  const handleArweaveRecipientChange = useCallback(
    async (value: string) => {
      setRecipientInput(value);

      // Reset lookup state when user edits
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
    if (!publicKey || !antMint || !recipientInput) return;

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

      // 2. Derive the escrow PDA
      const { PublicKey, TransactionInstruction, Transaction, SystemProgram } =
        await import('@solana/web3.js');

      const escrowProgramId = new PublicKey(ESCROW_PROGRAM_ID);
      const antMintPubkey = new PublicKey(antMint);
      const mplCoreProgramId = new PublicKey(
        'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
      );

      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('escrow_ant'), antMintPubkey.toBuffer()],
        escrowProgramId,
      );

      // 3. Encode instruction data
      //    Anchor discriminator (8 bytes) + u8 protocol + Vec<u8> pubkey
      //    Discriminator = sha256("global:deposit_ant")[..8]
      const { sha256 } = await import('@noble/hashes/sha256');
      const discriminator = sha256(
        new TextEncoder().encode('global:deposit_ant'),
      ).slice(0, 8);

      const data = Buffer.alloc(8 + 1 + 4 + recipientPubkey.length);
      data.set(discriminator, 0);
      data.writeUInt8(protocol === 'arweave' ? 0 : 1, 8);
      data.writeUInt32LE(recipientPubkey.length, 9);
      data.set(recipientPubkey, 13);

      // 4. Build the instruction
      const ix = new TransactionInstruction({
        programId: escrowProgramId,
        keys: [
          { pubkey: escrowPda, isSigner: false, isWritable: true },
          { pubkey: antMintPubkey, isSigner: false, isWritable: true },
          { pubkey: publicKey, isSigner: true, isWritable: true },
          { pubkey: mplCoreProgramId, isSigner: false, isWritable: false },
          { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
        ],
        data,
      });

      // 5. Send the transaction
      setStatusMessage('Waiting for wallet approval...');
      const tx = new Transaction().add(ix);
      const sig = await sendTransaction(tx, connection);

      setStatusMessage('Confirming transaction...');
      await connection.confirmTransaction(sig, 'confirmed');

      setTxSignature(sig);
      setStatus('success');
      setStatusMessage(`Deposit confirmed! ANT ${antMint} is now in escrow.`);
    } catch (e) {
      setStatus('error');
      const msg = e instanceof Error ? e.message : String(e);
      // Surface user-friendly messages for common cases
      if (msg.includes('User rejected') || msg.includes('user rejected')) {
        setStatusMessage('Transaction cancelled by user.');
      } else {
        setStatusMessage(`Deposit failed: ${msg}`);
      }
    }
  }, [publicKey, antMint, recipientInput, protocol, connection, sendTransaction]);

  const canSubmit =
    solPubkey && antMint.length > 30 && recipientInput.length > 0 && status !== 'submitting';

  return (
    <div style={styles.wrap}>
      <h1 style={styles.h1}>Deposit an ANT</h1>
      <p style={styles.lede}>
        Lock one of your ANTs into the trustless escrow program. The
        recipient — designated below — releases the ANT by signing a
        canonical message that the on-chain verifier checks against their
        Arweave or Ethereum public key.
      </p>

      <StepCard n={1} title="Connect your Solana wallet" completed={!!solPubkey}>
        <SolanaWalletConnect
          onConnect={(pubkey) => setSolPubkey(pubkey)}
          onDisconnect={() => setSolPubkey(undefined)}
          connectedPubkey={solPubkey}
        />
      </StepCard>

      <StepCard n={2} title="Choose an ANT to deposit" completed={antMint.length > 30} active={!!solPubkey}>
        <input
          type="text"
          placeholder="ANT mint pubkey (base58)"
          value={antMint}
          onChange={(e) => setAntMint(e.target.value)}
          className="input"
          style={styles.input}
        />
        <p style={styles.hint}>
          You can find your ANT mint addresses at{' '}
          <a style={styles.link} href="https://arns.app">arns.app</a> under
          your portfolio. Each ANT corresponds to one ArNS name.
        </p>
        <p style={styles.hint}>
          Looks like:{' '}
          <code style={styles.code}>9PnRFwk2Yp7QyU3sQzXwUhJj6tVyM4nN2KqL5fT8RbAW</code>{' '}
          (44 characters)
        </p>
      </StepCard>

      <StepCard n={3} title="Choose recipient identity" completed={recipientInput.length > 0} active={antMint.length > 30}>
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
          Escrow rent is fully refundable when the ANT is claimed or cancelled.
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
              {status === 'submitting' ? 'Depositing...' : 'Deposit ANT'}
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
  code: {
    fontFamily: 'monospace',
    fontSize: '12px',
    background: 'rgba(84, 39, 200, 0.06)',
    padding: '2px 6px',
    borderRadius: '4px',
    color: brand.black,
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
