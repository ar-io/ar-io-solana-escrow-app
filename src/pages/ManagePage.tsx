import React, { useState, useCallback, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { useConnection } from '@solana/wallet-adapter-react';
import { brand } from '../brand.js';
import { StepCard } from '../components/StepCard.tsx';
import { SolanaWalletConnect } from '../components/SolanaWalletConnect.tsx';
import {
  fetchEscrowState,
  fetchEscrowsByDepositor,
  formatRecipientPubkey,
  parseArweaveRecipient,
  parseEthereumRecipient,
  ESCROW_PROGRAM_ID,
  type EscrowAntState,
  type EscrowProtocol,
} from '../services/escrow-client.ts';

interface Props {
  antMint: string;
}

/**
 * Depositor management — change the recipient on an active escrow, or
 * cancel and pull the ANT back to your wallet. Only callable by the
 * original depositor; the program enforces this via `has_one = depositor`.
 */
export function ManagePage({ antMint: initialAntMint }: Props) {
  const [antMint, setAntMint] = useState(initialAntMint);
  const [solPubkey, setSolPubkey] = useState<string | undefined>();

  // Escrow state
  const [escrowState, setEscrowState] = useState<EscrowAntState | null>(null);
  const [escrowLoading, setEscrowLoading] = useState(false);
  const [escrowError, setEscrowError] = useState('');

  // Update recipient form
  const [newProtocol, setNewProtocol] = useState<EscrowProtocol>('arweave');
  const [newRecipientInput, setNewRecipientInput] = useState('');

  // Discovery: depositor's active escrows
  const [depositorEscrows, setDepositorEscrows] = useState<
    Array<{ antMint: string; state: EscrowAntState }>
  >([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState('');
  const [discoveryDone, setDiscoveryDone] = useState(false);

  // Status for update and cancel
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [updateMessage, setUpdateMessage] = useState('');
  const [cancelStatus, setCancelStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [cancelMessage, setCancelMessage] = useState('');
  const [txSignature, setTxSignature] = useState('');

  const { publicKey, sendTransaction } = useWallet();
  const { connection } = useConnection();

  // -------------------------------------------------------------------
  // Fetch escrow state
  // -------------------------------------------------------------------
  const fetchEscrow = useCallback(async () => {
    if (!antMint || antMint.length < 30) {
      setEscrowState(null);
      setEscrowError('');
      return;
    }

    setEscrowLoading(true);
    setEscrowError('');
    setEscrowState(null);

    try {
      const state = await fetchEscrowState(connection, antMint);
      if (!state) {
        setEscrowError('No active escrow found for this ANT mint.');
      } else {
        setEscrowState(state);
      }
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

  // Auto-discover escrows when wallet connects
  useEffect(() => {
    if (!solPubkey) {
      setDepositorEscrows([]);
      setDiscoveryDone(false);
      setDiscoveryError('');
      return;
    }

    let cancelled = false;
    (async () => {
      setDiscoveryLoading(true);
      setDiscoveryError('');
      try {
        const results = await fetchEscrowsByDepositor(connection, solPubkey);
        if (!cancelled) {
          setDepositorEscrows(results);
          setDiscoveryDone(true);
        }
      } catch (e) {
        if (!cancelled) {
          setDiscoveryError(
            `Could not look up escrows: ${e instanceof Error ? e.message : String(e)}. You can still enter an ANT mint manually below.`,
          );
          setDiscoveryDone(true);
        }
      } finally {
        if (!cancelled) setDiscoveryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [solPubkey, connection]);

  // Check if connected wallet is the depositor
  const isDepositor =
    escrowState && solPubkey && escrowState.depositor === solPubkey;

  // -------------------------------------------------------------------
  // Update recipient
  // -------------------------------------------------------------------
  const handleUpdateRecipient = useCallback(async () => {
    if (!publicKey || !escrowState || !newRecipientInput) return;

    setUpdateStatus('submitting');
    setUpdateMessage('Preparing update transaction...');

    try {
      // Parse the new recipient
      let recipientPubkey: Uint8Array;
      try {
        recipientPubkey =
          newProtocol === 'arweave'
            ? parseArweaveRecipient(newRecipientInput)
            : parseEthereumRecipient(newRecipientInput);
      } catch (e) {
        throw new Error(
          `Invalid ${newProtocol} recipient: ${e instanceof Error ? e.message : String(e)}`,
        );
      }

      const { PublicKey, TransactionInstruction, Transaction } =
        await import('@solana/web3.js');
      const { sha256 } = await import('@noble/hashes/sha256');

      const escrowProgramId = new PublicKey(ESCROW_PROGRAM_ID);
      const antMintPubkey = new PublicKey(antMint);

      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('escrow_ant'), antMintPubkey.toBuffer()],
        escrowProgramId,
      );

      // Discriminator for update_recipient
      const discriminator = sha256(
        new TextEncoder().encode('global:update_recipient'),
      ).slice(0, 8);

      // Data: discriminator + u8 protocol + Vec<u8> pubkey
      const data = Buffer.alloc(8 + 1 + 4 + recipientPubkey.length);
      data.set(discriminator, 0);
      data.writeUInt8(newProtocol === 'arweave' ? 0 : 1, 8);
      data.writeUInt32LE(recipientPubkey.length, 9);
      data.set(recipientPubkey, 13);

      const ix = new TransactionInstruction({
        programId: escrowProgramId,
        keys: [
          { pubkey: escrowPda, isSigner: false, isWritable: true },
          { pubkey: publicKey, isSigner: true, isWritable: false },
        ],
        data,
      });

      setUpdateMessage('Waiting for wallet approval...');
      const tx = new Transaction().add(ix);
      const sig = await sendTransaction(tx, connection);

      setUpdateMessage('Confirming transaction...');
      await connection.confirmTransaction(sig, 'confirmed');

      setTxSignature(sig);
      setUpdateStatus('success');
      setUpdateMessage('Recipient updated. Nonce has been rotated — any previous signatures are invalidated.');

      // Refresh escrow state
      fetchEscrow();
    } catch (e) {
      setUpdateStatus('error');
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('User rejected') || msg.includes('user rejected')) {
        setUpdateMessage('Transaction cancelled by user.');
      } else {
        setUpdateMessage(`Update failed: ${msg}`);
      }
    }
  }, [publicKey, escrowState, newProtocol, newRecipientInput, antMint, connection, sendTransaction, fetchEscrow]);

  // -------------------------------------------------------------------
  // Cancel escrow
  // -------------------------------------------------------------------
  const handleCancel = useCallback(async () => {
    if (!publicKey || !escrowState) return;

    setCancelStatus('submitting');
    setCancelMessage('Preparing cancel transaction...');

    try {
      const { PublicKey, TransactionInstruction, Transaction, SystemProgram } =
        await import('@solana/web3.js');
      const { sha256 } = await import('@noble/hashes/sha256');

      const escrowProgramId = new PublicKey(ESCROW_PROGRAM_ID);
      const antMintPubkey = new PublicKey(antMint);
      const mplCoreProgramId = new PublicKey(
        'CoREENxT6tW1HoK8ypY1SxRMZTcVPm7R94rH4PZNhX7d',
      );

      const [escrowPda] = PublicKey.findProgramAddressSync(
        [Buffer.from('escrow_ant'), antMintPubkey.toBuffer()],
        escrowProgramId,
      );

      const discriminator = sha256(
        new TextEncoder().encode('global:cancel_deposit'),
      ).slice(0, 8);

      const data = Buffer.alloc(8);
      data.set(discriminator, 0);

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

      setCancelMessage('Waiting for wallet approval...');
      const tx = new Transaction().add(ix);
      const sig = await sendTransaction(tx, connection);

      setCancelMessage('Confirming transaction...');
      await connection.confirmTransaction(sig, 'confirmed');

      setTxSignature(sig);
      setCancelStatus('success');
      setCancelMessage('Escrow cancelled. Your ANT has been returned and rent refunded.');
    } catch (e) {
      setCancelStatus('error');
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('User rejected') || msg.includes('user rejected')) {
        setCancelMessage('Transaction cancelled by user.');
      } else {
        setCancelMessage(`Cancel failed: ${msg}`);
      }
    }
  }, [publicKey, escrowState, antMint, connection, sendTransaction]);

  return (
    <div style={styles.wrap}>
      <h1 style={styles.h1}>Manage an active escrow</h1>
      <p style={styles.lede}>
        Update the recipient identity or cancel the escrow and reclaim
        your ANT. Only the original depositor wallet can perform these
        actions.
      </p>

      <StepCard n={1} title="Connect your Solana wallet" completed={!!solPubkey}>
        <SolanaWalletConnect
          onConnect={(pubkey) => setSolPubkey(pubkey)}
          onDisconnect={() => setSolPubkey(undefined)}
          connectedPubkey={solPubkey}
        />
        <p style={styles.hint}>
          Must be the same Solana wallet you used when depositing the ANT.
        </p>

        {/* Discovery: active escrows for this depositor */}
        {solPubkey && discoveryLoading && (
          <p style={styles.discoveryLoading}>Looking up your active escrows...</p>
        )}
        {solPubkey && discoveryError && (
          <p style={styles.discoveryWarning}>{discoveryError}</p>
        )}
        {solPubkey && discoveryDone && !discoveryError && depositorEscrows.length === 0 && (
          <p style={styles.hint}>No active escrows found for this wallet.</p>
        )}
        {solPubkey && depositorEscrows.length > 0 && (
          <div style={styles.discoveryList}>
            <p style={styles.discoveryTitle}>Your active escrows</p>
            {depositorEscrows.map((e) => (
              <div key={e.antMint} style={styles.discoveryCard}>
                <div style={styles.discoveryCardRow}>
                  <span style={styles.discoveryCardLabel}>ANT Mint</span>
                  <code style={styles.discoveryCardValue}>
                    {e.antMint.slice(0, 12)}...{e.antMint.slice(-4)}
                  </code>
                </div>
                <div style={styles.discoveryCardRow}>
                  <span style={styles.discoveryCardLabel}>Recipient</span>
                  <span style={styles.discoveryCardValue}>
                    {e.state.recipientProtocol === 'arweave' ? 'Arweave' : 'Ethereum'}
                  </span>
                </div>
                <button
                  type="button"
                  style={styles.discoverySelectButton}
                  onClick={() => setAntMint(e.antMint)}
                >
                  Select
                </button>
              </div>
            ))}
          </div>
        )}
      </StepCard>

      <StepCard n={2} title="ANT mint" completed={!!escrowState} active={!!solPubkey}>
        <input
          type="text"
          placeholder="ANT mint pubkey (base58)"
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
          <div style={styles.escrowInfo}>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>Depositor:</span>
              <code style={styles.infoValue}>{escrowState.depositor}</code>
            </div>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>Protocol:</span>
              <span style={styles.infoValue}>{escrowState.recipientProtocol}</span>
            </div>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>Recipient:</span>
              <code style={styles.infoValue}>
                {formatRecipientPubkey(escrowState.recipientProtocol, escrowState.recipientPubkey)}
              </code>
            </div>
            <div style={styles.infoRow}>
              <span style={styles.infoLabel}>Deposit slot:</span>
              <span style={styles.infoValue}>{escrowState.depositSlot.toString()}</span>
            </div>
            {solPubkey && !isDepositor && (
              <p style={styles.warningHint}>
                Connected wallet does not match the depositor. Only the
                depositor can update or cancel this escrow.
              </p>
            )}
          </div>
        )}
      </StepCard>

      <StepCard n={3} title="Update recipient" active={!!escrowState}>
        <p style={styles.hint}>
          Re-targets the escrow at a new Arweave or Ethereum identity.
          Rotates the on-chain nonce, invalidating any in-flight
          signatures bound to the previous recipient.
        </p>
        <div style={styles.protocolPicker}>
          <button
            type="button"
            style={{
              ...styles.protocolButton,
              ...(newProtocol === 'arweave' ? styles.protocolActive : {}),
            }}
            onClick={() => setNewProtocol('arweave')}
          >
            Arweave
          </button>
          <button
            type="button"
            style={{
              ...styles.protocolButton,
              ...(newProtocol === 'ethereum' ? styles.protocolActive : {}),
            }}
            onClick={() => setNewProtocol('ethereum')}
          >
            Ethereum
          </button>
        </div>
        {newProtocol === 'arweave' ? (
          <textarea
            placeholder="Paste an Arweave address or RSA public key"
            value={newRecipientInput}
            onChange={(e) => setNewRecipientInput(e.target.value)}
            className="input"
            style={styles.textarea}
            rows={4}
          />
        ) : (
          <input
            type="text"
            placeholder="0x... — 20-byte Ethereum address"
            value={newRecipientInput}
            onChange={(e) => setNewRecipientInput(e.target.value)}
            className="input"
            style={styles.input}
          />
        )}

        {updateStatus === 'success' ? (
          <div style={styles.successBox}>
            <p style={styles.successText}>{updateMessage}</p>
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
        ) : updateStatus === 'error' ? (
          <div style={styles.errorBox}>
            <p style={styles.errorText}>{updateMessage}</p>
            <button
              type="button"
              style={{ ...styles.button, opacity: 1 }}
              onClick={handleUpdateRecipient}
            >
              Retry Update
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              className="btn-primary"
              style={{
                ...styles.button,
                opacity: isDepositor && newRecipientInput ? 1 : 0.6,
                cursor: isDepositor && newRecipientInput ? 'pointer' : 'not-allowed',
                marginTop: '12px',
              }}
              disabled={!isDepositor || !newRecipientInput || updateStatus === 'submitting'}
              onClick={handleUpdateRecipient}
            >
              {updateStatus === 'submitting' ? 'Updating...' : 'Update recipient'}
            </button>
            {updateStatus === 'submitting' && (
              <p style={styles.statusText}>{updateMessage}</p>
            )}
          </>
        )}
      </StepCard>

      <StepCard n={4} title="Cancel escrow" active={!!escrowState}>
        <p style={styles.hint}>
          Returns the ANT to your wallet and refunds the rent (~0.046 SOL).
          If you need to guarantee the recipient can't claim while you're
          cancelling, cancel first and then re-deposit with a new recipient.
        </p>

        {cancelStatus === 'success' ? (
          <div style={styles.successBox}>
            <p style={styles.successText}>{cancelMessage}</p>
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
        ) : cancelStatus === 'error' ? (
          <div style={styles.errorBox}>
            <p style={styles.errorText}>{cancelMessage}</p>
            <button
              type="button"
              style={{ ...styles.dangerButton, opacity: 1 }}
              onClick={handleCancel}
            >
              Retry Cancel
            </button>
          </div>
        ) : (
          <>
            <button
              type="button"
              style={{
                ...styles.dangerButton,
                opacity: isDepositor ? 1 : 0.6,
                cursor: isDepositor ? 'pointer' : 'not-allowed',
              }}
              disabled={!isDepositor || cancelStatus === 'submitting'}
              onClick={handleCancel}
            >
              {cancelStatus === 'submitting' ? 'Cancelling...' : 'Cancel escrow'}
            </button>
            {cancelStatus === 'submitting' && (
              <p style={styles.statusText}>{cancelMessage}</p>
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
    margin: '8px 0 12px',
  },
  errorHint: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.error,
    margin: '8px 0 0',
  },
  warningHint: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.error,
    margin: '8px 0 0',
    fontWeight: 600,
  },
  code: {
    fontFamily: 'monospace',
    fontSize: '12px',
    background: 'rgba(84, 39, 200, 0.06)',
    padding: '2px 6px',
    borderRadius: '4px',
    color: brand.black,
  },
  escrowInfo: {
    marginTop: '12px',
    padding: '20px 24px',
    background: `radial-gradient(ellipse 140% 120% at top left, rgba(84, 39, 200, 0.03), transparent), rgba(255, 255, 255, 0.85)`,
    borderRadius: '16px',
    border: `1px solid ${brand.border}`,
    boxShadow: '0 1px 3px rgba(35, 35, 45, 0.04)',
  },
  infoRow: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
    marginBottom: '8px',
  },
  infoLabel: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '11px',
    fontWeight: 700,
    color: brand.textTertiary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  infoValue: {
    fontSize: '13px',
    color: brand.black,
    fontFamily: 'monospace',
    wordBreak: 'break-all' as const,
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
  button: {
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
  dangerButton: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    padding: '12px 24px',
    border: `1px solid ${brand.error}`,
    borderRadius: '10px',
    background: brand.white,
    color: brand.error,
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
    marginTop: '12px',
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
    marginTop: '12px',
  },
  errorText: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '14px',
    color: brand.error,
    margin: '0 0 12px',
  },
  discoveryLoading: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.textTertiary,
    margin: '12px 0 0',
    fontStyle: 'italic' as const,
  },
  discoveryWarning: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.textTertiary,
    margin: '12px 0 0',
  },
  discoveryList: {
    marginTop: '16px',
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
  discoverySelectButton: {
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
