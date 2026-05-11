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
  ESCROW_VAULT_SEED,
} from '../services/escrow-client.ts';

/**
 * Deposit ARIO tokens into a time-locked vault escrow, addressed to an
 * Arweave or Ethereum identity. The recipient receives a vault with the
 * remaining lock duration when they claim.
 */
export function DepositVaultPage() {
  const [protocol, setProtocol] = useState<'arweave' | 'ethereum'>('arweave');
  const [amountInput, setAmountInput] = useState('');
  const [lockDaysInput, setLockDaysInput] = useState('');
  const [revocable, setRevocable] = useState(false);
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

  // Parse lock duration
  const lockDays = parseInt(lockDaysInput, 10);
  const validLockDays = !isNaN(lockDays) && lockDays >= 14;
  const lockDurationSeconds = validLockDays ? BigInt(lockDays) * 86400n : null;
  const lockEndDate = validLockDays
    ? new Date(Date.now() + lockDays * 86400 * 1000)
    : null;

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
    if (!publicKey || !parsedMario || !recipientInput || !lockDurationSeconds) return;

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

      // Generate a unique asset_id for this deposit.
      const nonce = crypto.randomUUID ? crypto.randomUUID() : String(Date.now());
      const assetIdInput = `vault-escrow:${publicKey.toBase58()}:${nonce}`;
      const assetId = sha256(new TextEncoder().encode(assetIdInput));

      // Derive the escrow PDA: ["escrow_vault", depositor, asset_id]
      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from(ESCROW_VAULT_SEED), publicKey.toBuffer(), Buffer.from(assetId)],
        escrowProgramId,
      );

      // ARIO mint address (mainnet)
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
      // Discriminator = sha256("global:deposit_vault")[..8]
      const discriminator = sha256(
        new TextEncoder().encode('global:deposit_vault'),
      ).slice(0, 8);

      // Data: discriminator(8) + asset_id(32) + amount(8) + lock_duration_seconds(8) + revocable(1) + protocol(1) + pubkey_len(4) + pubkey(N)
      const data = Buffer.alloc(8 + 32 + 8 + 8 + 1 + 1 + 4 + recipientPubkey.length);
      let offset = 0;
      data.set(discriminator, offset); offset += 8;
      data.set(assetId, offset); offset += 32;
      // Write amount as u64 LE
      const amountBuf = Buffer.alloc(8);
      amountBuf.writeBigUInt64LE(parsedMario);
      data.set(amountBuf, offset); offset += 8;
      // Write lock duration as i64 LE
      const lockBuf = Buffer.alloc(8);
      lockBuf.writeBigInt64LE(lockDurationSeconds);
      data.set(lockBuf, offset); offset += 8;
      // Revocable flag
      data.writeUInt8(revocable ? 1 : 0, offset); offset += 1;
      // Protocol
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
        `Deposit confirmed! ${amountInput} ARIO locked in vault escrow for ${lockDays} days.`,
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
  }, [publicKey, parsedMario, recipientInput, protocol, amountInput, lockDays, lockDurationSeconds, revocable, connection, sendTransaction]);

  const canSubmit =
    solPubkey && parsedMario && validLockDays && recipientInput.length > 0 && status !== 'submitting';

  return (
    <div style={styles.wrap}>
      <h1 style={styles.h1}>Deposit Vaulted ARIO</h1>
      <p style={styles.lede}>
        Lock ARIO into a time-locked vault escrow. The recipient receives
        a vault with the remaining lock duration when they claim. If
        revocable, you can reclaim the tokens before the lock expires.
      </p>

      <StepCard n={1} title="Connect your Solana wallet" completed={!!solPubkey}>
        <SolanaWalletConnect
          onConnect={(pubkey) => setSolPubkey(pubkey)}
          onDisconnect={() => setSolPubkey(undefined)}
          connectedPubkey={solPubkey}
        />
      </StepCard>

      <StepCard n={2} title="Enter amount and lock duration" completed={!!parsedMario && validLockDays} active={!!solPubkey}>
        <div style={styles.fieldGroup}>
          <label style={styles.fieldLabel}>ARIO Amount</label>
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
        </div>

        <div style={{ ...styles.fieldGroup, marginTop: '16px' }}>
          <label style={styles.fieldLabel}>Lock Duration (days)</label>
          <input
            type="number"
            placeholder="Minimum 14 days"
            value={lockDaysInput}
            onChange={(e) => setLockDaysInput(e.target.value)}
            className="input"
            style={styles.input}
            min="14"
            step="1"
          />
          {lockEndDate && (
            <p style={styles.conversion}>
              Locked until {lockEndDate.toLocaleDateString()} {lockEndDate.toLocaleTimeString()}
            </p>
          )}
          {lockDaysInput && !validLockDays && (
            <p style={styles.errorHint}>Minimum lock duration is 14 days.</p>
          )}
        </div>

        <div style={{ ...styles.fieldGroup, marginTop: '16px' }}>
          <label style={styles.toggleRow}>
            <input
              type="checkbox"
              checked={revocable}
              onChange={(e) => setRevocable(e.target.checked)}
              style={styles.checkbox}
            />
            <span style={styles.toggleLabel}>Revocable</span>
          </label>
          <p style={styles.hint}>
            {revocable
              ? 'You can reclaim the tokens before the lock expires. The recipient should be aware that the deposit may be revoked.'
              : 'Once deposited, the tokens cannot be reclaimed until the lock expires. The recipient is guaranteed to receive them.'}
          </p>
        </div>
      </StepCard>

      <StepCard n={3} title="Choose recipient identity" completed={recipientInput.length > 0} active={!!parsedMario && validLockDays}>
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
              {status === 'submitting' ? 'Depositing...' : 'Deposit Vault'}
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
  fieldGroup: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  fieldLabel: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    fontWeight: 600,
    color: brand.black,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.8px',
  },
  hint: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.textTertiary,
    margin: '8px 0 0',
  },
  errorHint: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.error,
    margin: '4px 0 0',
  },
  conversion: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.primary,
    fontWeight: 600,
    margin: '4px 0 0',
  },
  toggleRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    cursor: 'pointer',
  },
  checkbox: {
    width: '16px',
    height: '16px',
    accentColor: brand.primary,
    cursor: 'pointer',
  },
  toggleLabel: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '14px',
    fontWeight: 600,
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
