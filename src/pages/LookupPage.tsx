import React, { useState, useCallback, useEffect } from 'react';
import { address } from '@solana/kit';
import { brand } from '../brand.js';
import { makeRpc, getEscrowProgramId } from '../services/solana.ts';
import {
  fetchEscrowState,
  fetchRawEscrowAccount,
  deserializeEscrowToken,
  formatRecipientPubkey,
  formatMarioToArio,
  getEscrowAntPDA,
  ESCROW_ANT_ACCOUNT_SIZE,
  ESCROW_TOKEN_ACCOUNT_SIZE,
  type EscrowAntState,
  type EscrowTokenState,
} from '../services/escrow-client.ts';

interface Props {
  initialAntMint: string;
}

/**
 * Read-only escrow inspector — no wallet connection required. Useful
 * for support, debugging, and external integrators that want to display
 * escrow state alongside ANT marketplace listings.
 *
 * Reads the EscrowAnt PDA via `fetchEscrowState()`.
 */
type EscrowLookupResult =
  | { kind: 'ant'; state: EscrowAntState }
  | { kind: 'token'; state: EscrowTokenState };

export function LookupPage({ initialAntMint }: Props) {
  const [antMint, setAntMint] = useState(initialAntMint);
  const [lookupResult, setLookupResult] = useState<EscrowLookupResult | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [searched, setSearched] = useState(false);

  const handleLookup = useCallback(async () => {
    if (!antMint || antMint.length < 30) {
      setError('Enter a valid escrow identifier (ANT mint or PDA address, base58).');
      return;
    }

    setLoading(true);
    setError('');
    setLookupResult(null);
    setSearched(true);

    try {
      const programId = getEscrowProgramId();
      if (!programId) {
        setError(
          'No escrow program configured. Set the contract ID in the footer (or VITE_ESCROW_PROGRAM_ID).',
        );
        return;
      }

      const { rpc } = makeRpc();

      // First try as an ANT mint (derive the PDA)
      const [antPda] = await getEscrowAntPDA(
        address(antMint),
        address(programId),
      );
      const antState = await fetchEscrowState(rpc, String(antPda), programId);
      if (antState) {
        setLookupResult({ kind: 'ant', state: antState });
        return;
      }

      // If not found as ANT, try fetching the address directly as a PDA
      // (for token/vault escrows where the user pastes the PDA address)
      const rawAccount = await fetchRawEscrowAccount(rpc, antMint, programId);
      if (rawAccount) {
        if (rawAccount.size === ESCROW_TOKEN_ACCOUNT_SIZE) {
          const tokenState = deserializeEscrowToken(rawAccount.data);
          setLookupResult({ kind: 'token', state: tokenState });
          return;
        }
        if (rawAccount.size === ESCROW_ANT_ACCOUNT_SIZE) {
          // Unlikely path — a direct PDA lookup that is an ANT escrow
          const antPdaState = await fetchEscrowState(rpc, antMint, programId);
          if (antPdaState) {
            setLookupResult({ kind: 'ant', state: antPdaState });
            return;
          }
        }
      }

      setError('No active escrow found for this identifier.');
    } catch (e) {
      setError(
        `Lookup failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setLoading(false);
    }
  }, [antMint]);

  // Auto-fetch if an ANT mint was provided via query string
  useEffect(() => {
    if (initialAntMint && initialAntMint.length >= 32) {
      handleLookup();
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Derive display values based on result kind
  const escrowState = lookupResult?.kind === 'ant' ? lookupResult.state : null;
  const tokenState = lookupResult?.kind === 'token' ? lookupResult.state : null;

  const nonceHex = (() => {
    const nonce = escrowState?.nonce ?? tokenState?.nonce;
    if (!nonce) return '';
    return Array.from(nonce)
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  })();

  return (
    <div style={styles.wrap}>
      <h1 style={styles.h1}>Escrow lookup</h1>
      <p style={styles.lede}>
        Inspect the on-chain state of any active escrow. No wallet
        required.
      </p>

      <div style={styles.searchRow}>
        <input
          type="text"
          placeholder="ANT mint pubkey (base58)"
          value={antMint}
          onChange={(e) => setAntMint(e.target.value)}
          onKeyDown={(e) => { if (e.key === 'Enter') handleLookup(); }}
          className="input"
          style={styles.input}
        />
        <button
          type="button"
          className="btn-primary"
          style={{
            ...styles.lookupButton,
            opacity: loading ? 0.6 : 1,
            cursor: loading ? 'not-allowed' : 'pointer',
          }}
          disabled={loading}
          onClick={handleLookup}
        >
          {loading ? 'Looking up...' : 'Lookup'}
        </button>
      </div>
      <p style={styles.searchNote}>
        No wallet connection required. Anyone can look up escrow state for any ANT.
      </p>

      {error && (
        <div style={styles.errorBox}>
          <p style={styles.errorText}>{error}</p>
        </div>
      )}

      {escrowState && (
        <div style={styles.stateCard}>
          <h3 style={styles.cardTitle}>Active ANT escrow</h3>
          <div style={styles.fieldGrid}>
            <Field label="ANT Mint" value={escrowState.antMint} mono />
            <Field label="Depositor" value={escrowState.depositor} mono />
            <Field
              label="Recipient Protocol"
              value={escrowState.recipientProtocol}
            />
            <Field
              label="Recipient Public Key"
              value={formatRecipientPubkey(
                escrowState.recipientProtocol,
                escrowState.recipientPubkey,
              )}
              mono
            />
            <Field label="Nonce" value={nonceHex} mono />
            <Field
              label="Deposit Slot"
              value={escrowState.depositSlot.toString()}
            />
            <Field
              label="Version"
              value={String(escrowState.version)}
            />
          </div>

          <div style={styles.actions}>
            <a
              href={`#/claim?ant=${escrowState.antMint}`}
              style={styles.actionLink}
            >
              Claim this ANT
            </a>
            <a
              href={`#/manage?ant=${escrowState.antMint}`}
              style={styles.actionLink}
            >
              Manage this escrow
            </a>
          </div>
        </div>
      )}

      {tokenState && (
        <div style={styles.stateCard}>
          <h3 style={styles.cardTitle}>
            Active {tokenState.assetType === 'vault' ? 'vault' : 'token'} escrow
          </h3>
          <div style={styles.fieldGrid}>
            <Field
              label="Asset Type"
              value={tokenState.assetType === 'vault' ? 'Vault (time-locked)' : 'Token'}
            />
            <Field
              label="Amount"
              value={`${formatMarioToArio(tokenState.amount)} ARIO`}
            />
            <Field label="Depositor" value={tokenState.depositor} mono />
            <Field
              label="Asset ID"
              value={Array.from(tokenState.assetId).map(b => b.toString(16).padStart(2, '0')).join('')}
              mono
            />
            <Field
              label="Recipient Protocol"
              value={tokenState.recipientProtocol}
            />
            <Field
              label="Recipient Public Key"
              value={formatRecipientPubkey(
                tokenState.recipientProtocol,
                tokenState.recipientPubkey,
              )}
              mono
            />
            <Field label="Nonce" value={nonceHex} mono />
            <Field
              label="Deposit Slot"
              value={tokenState.depositSlot.toString()}
            />
            {tokenState.assetType === 'vault' && (
              <>
                <Field
                  label="Lock End Date"
                  value={
                    tokenState.vaultEndTimestamp > 0n
                      ? new Date(Number(tokenState.vaultEndTimestamp) * 1000).toLocaleString()
                      : 'N/A'
                  }
                />
                <Field
                  label="Revocable"
                  value={tokenState.vaultRevocable ? 'Yes' : 'No'}
                />
                <Field
                  label="Lock Status"
                  value={
                    tokenState.vaultEndTimestamp > 0n &&
                    Number(tokenState.vaultEndTimestamp) * 1000 > Date.now()
                      ? 'Locked'
                      : 'Expired'
                  }
                />
              </>
            )}
            <Field
              label="Version"
              value={String(tokenState.version)}
            />
          </div>
        </div>
      )}

      {!lookupResult && !error && !loading && searched && (
        <div style={styles.placeholder}>
          No active escrow found for this identifier.
        </div>
      )}

      {!searched && (
        <div style={styles.placeholder}>
          Enter an ANT mint or escrow PDA above to fetch escrow state.
        </div>
      )}

    </div>
  );
}

function Field({
  label,
  value,
  mono,
}: {
  label: string;
  value: string;
  mono?: boolean;
}) {
  return (
    <div style={fieldStyles.row}>
      <span style={fieldStyles.label}>{label}</span>
      <span
        style={{
          ...fieldStyles.value,
          ...(mono ? { fontFamily: 'monospace' } : {}),
        }}
      >
        {value}
      </span>
    </div>
  );
}

const fieldStyles: Record<string, React.CSSProperties> = {
  row: {
    display: 'flex',
    flexDirection: 'column',
    gap: '2px',
  },
  label: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '11px',
    fontWeight: 700,
    color: brand.textTertiary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  value: {
    fontSize: '13px',
    color: brand.black,
    wordBreak: 'break-all' as const,
  },
};

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
  searchRow: {
    display: 'flex',
    gap: '8px',
  },
  searchNote: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.textTertiary,
    margin: '0',
  },
  input: {
    flex: 1,
    padding: '11px 14px',
    fontSize: '14px',
    border: `1px solid ${brand.border}`,
    borderRadius: '10px',
    background: brand.white,
    fontFamily: 'monospace',
    outline: 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  },
  lookupButton: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    padding: '11px 20px',
    border: 'none',
    borderRadius: '10px',
    background: brand.primary,
    color: brand.white,
    fontSize: '14px',
    fontWeight: 700,
    cursor: 'pointer',
    whiteSpace: 'nowrap' as const,
    transition: 'all 0.2s ease',
  },
  stateCard: {
    padding: '28px',
    background: `radial-gradient(ellipse 140% 120% at top left, rgba(84, 39, 200, 0.03), transparent), rgba(255, 255, 255, 0.85)`,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    border: `1px solid ${brand.border}`,
    borderRadius: '16px',
    boxShadow: '0 1px 3px rgba(35, 35, 45, 0.04)',
  },
  cardTitle: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '18px',
    fontWeight: 700,
    color: brand.black,
    margin: '0 0 16px',
  },
  fieldGrid: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
  },
  actions: {
    display: 'flex',
    gap: '16px',
    marginTop: '16px',
    paddingTop: '12px',
    borderTop: `1px solid ${brand.border}`,
  },
  actionLink: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    color: brand.primary,
    textDecoration: 'none',
    fontSize: '14px',
    fontWeight: 600,
  },
  placeholder: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    padding: '24px',
    background: `radial-gradient(ellipse 140% 120% at top left, rgba(84, 39, 200, 0.03), transparent), rgba(255, 255, 255, 0.85)`,
    borderRadius: '16px',
    border: `1px solid ${brand.border}`,
    color: brand.textSecondary,
    fontSize: '13px',
    textAlign: 'center' as const,
    boxShadow: '0 1px 3px rgba(35, 35, 45, 0.04)',
  },
  errorBox: {
    padding: '14px 16px',
    background: brand.errorBg,
    borderRadius: '10px',
    border: `1px solid ${brand.error}33`,
  },
  errorText: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.error,
    margin: 0,
  },
  hint: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.textTertiary,
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
};
