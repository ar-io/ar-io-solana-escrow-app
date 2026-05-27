import React, { useState, useCallback } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { address } from '@solana/kit';
import { sha256 } from '@noble/hashes/sha256';
import { brand } from '../brand.js';
import { StepCard } from '../components/StepCard.tsx';
import { SolanaWalletConnect } from '../components/SolanaWalletConnect.tsx';
import {
  parseArweaveRecipient,
  parseEthereumRecipient,
  isArweaveAddress,
  lookupArweaveModulus,
  getAtaForOwner,
  bytesToHexLower,
} from '../services/escrow-client.ts';
import { getTokenEscrow, getEscrowProgramId, getArioMint } from '../services/solana.ts';

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
  const [escrowPda, setEscrowPda] = useState('');
  const [assetIdHex, setAssetIdHex] = useState('');
  const [arweaveLookup, setArweaveLookup] = useState<
    'idle' | 'loading' | 'success' | 'error'
  >('idle');
  const [arweaveLookupMessage, setArweaveLookupMessage] = useState('');

  const { publicKey, wallet } = useWallet();

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
      if (!getEscrowProgramId()) {
        throw new Error(
          'No escrow program configured. Set the program ID in the menu (or VITE_ESCROW_PROGRAM_ID) to point at a deployed ario-ant-escrow program.',
        );
      }

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

      // Generate a unique asset_id for this deposit. Uses crypto.randomUUID
      // for uniqueness. The batch script uses deterministic hashes instead.
      const assetId = sha256(
        new TextEncoder().encode(
          `token-escrow:${publicKey.toBase58()}:${crypto.randomUUID?.() ?? Date.now()}`,
        ),
      );

      const arioMint = getArioMint();
      const depositorTokenAccount = await getAtaForOwner(
        address(publicKey.toBase58()),
        arioMint,
      );

      // 2. Build + submit the deposit via the SDK (kit). The escrow client
      //    derives the PDA + escrow ATA, prepends ATA creation, and confirms.
      setStatusMessage('Waiting for wallet approval...');
      const escrow = getTokenEscrow({ adapter: wallet?.adapter });
      const sig = await escrow.depositTokens({
        assetId,
        amount: parsedMario,
        arioMint,
        depositorTokenAccount,
        recipient: { protocol, publicKey: recipientPubkey },
      });

      setTxSignature(sig);

      // Token escrows are keyed by their on-chain PDA (derived from the
      // depositor + a random assetId), NOT discoverable by mint. The
      // recipient needs this PDA to claim, so surface it here.
      const escrowPda = await getTokenEscrow().getTokenPda(
        address(publicKey.toBase58()),
        assetId,
      );
      setEscrowPda(String(escrowPda));
      setAssetIdHex(bytesToHexLower(assetId));

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
  }, [publicKey, parsedMario, recipientInput, protocol, amountInput, wallet]);

  const canSubmit =
    solPubkey && parsedMario && parsedMario > 0n && recipientInput.length > 0 && status !== 'submitting';

  return (
    <div style={styles.wrap}>
      <h1 className="page-title" style={styles.h1}>Deposit ARIO Tokens</h1>
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
            {escrowPda && (
              <div style={styles.pdaBox}>
                <p style={styles.pdaHeading}>Escrow address (share with recipient)</p>
                <p style={styles.pdaNote}>
                  Send this escrow address to the recipient — they'll need it
                  to claim. Token/vault escrows aren't discoverable by mint.
                </p>
                <div style={styles.pdaRow}>
                  <code style={styles.pdaCode}>{escrowPda}</code>
                  <button
                    type="button"
                    style={styles.copyButton}
                    onClick={() => navigator.clipboard?.writeText(escrowPda)}
                  >
                    Copy
                  </button>
                </div>
                {assetIdHex && (
                  <>
                    <p style={{ ...styles.pdaHeading, marginTop: '12px' }}>Asset ID</p>
                    <code style={styles.pdaCode}>{assetIdHex}</code>
                  </>
                )}
              </div>
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
    fontWeight: 700,
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
    borderRadius: '16px',
    background: brand.white,
    fontFamily: 'monospace',
    outline: 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  },
  textarea: {
    width: '100%',
    padding: '11px 14px',
    fontSize: '14px',
    border: `1px solid ${brand.border}`,
    borderRadius: '16px',
    background: brand.white,
    fontFamily: 'monospace',
    resize: 'vertical' as const,
    boxSizing: 'border-box' as const,
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
    flexWrap: 'wrap' as const,
  },
  protocolButton: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    padding: '10px 16px',
    border: `1px solid ${brand.border}`,
    borderRadius: '16px',
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
    borderRadius: '16px',
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
    borderRadius: '16px',
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
  pdaBox: {
    marginTop: '14px',
    paddingTop: '14px',
    borderTop: `1px solid ${brand.success}33`,
  },
  pdaHeading: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '12px',
    fontWeight: 700,
    color: brand.black,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.8px',
    margin: '0 0 4px',
  },
  pdaNote: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.textSecondary,
    margin: '0 0 8px',
  },
  pdaRow: {
    display: 'flex',
    alignItems: 'center',
    gap: '8px',
    flexWrap: 'wrap' as const,
  },
  pdaCode: {
    fontFamily: 'monospace',
    fontSize: '13px',
    color: brand.black,
    background: brand.white,
    border: `1px solid ${brand.border}`,
    borderRadius: '8px',
    padding: '8px 10px',
    wordBreak: 'break-all' as const,
    flex: 1,
    minWidth: 0,
  },
  copyButton: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    padding: '8px 14px',
    border: `1px solid ${brand.border}`,
    borderRadius: '8px',
    background: brand.white,
    color: brand.black,
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
  },
  errorBox: {
    padding: '14px 16px',
    background: brand.errorBg,
    borderRadius: '16px',
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
