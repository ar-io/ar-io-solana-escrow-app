import React, { useState, useCallback, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { address } from '@solana/kit';
import { brand } from '../brand.js';
import { StepCard } from '../components/StepCard.tsx';
import { SolanaWalletConnect } from '../components/SolanaWalletConnect.tsx';
import {
  getAntEscrow,
  getTokenEscrow,
  getEscrowProgramId,
  getArioMint,
  makeRpc,
} from '../services/solana.ts';
import {
  fetchEscrowState,
  fetchAllEscrowsByDepositor,
  formatRecipientPubkey,
  formatMarioToArio,
  getAtaForOwner,
  parseArweaveRecipient,
  parseEthereumRecipient,
  type EscrowAntState,
  type EscrowTokenState,
  type EscrowProtocol,
} from '../services/escrow-client.ts';

const NO_PROGRAM_ERROR =
  'No escrow program configured. Set the program ID in the menu (or VITE_ESCROW_PROGRAM_ID) to point at a deployed ario-ant-escrow program.';

/** Stable hex string key for a 32-byte assetId, used to index per-item state. */
function assetIdKey(assetId: Uint8Array): string {
  let out = '';
  for (let i = 0; i < assetId.length; i++) {
    out += assetId[i].toString(16).padStart(2, '0');
  }
  return out;
}

/** Per-escrow update-recipient form shape (used to seed/merge state). */
type UpdateForm = {
  status: 'idle' | 'submitting' | 'success' | 'error';
  message: string;
  sig?: string;
  protocol: EscrowProtocol;
  input: string;
  open: boolean;
};

/** Merge helper that guarantees the protocol/input/open fields exist. */
function defaultUpdateForm(prev?: UpdateForm): UpdateForm {
  return {
    status: prev?.status ?? 'idle',
    message: prev?.message ?? '',
    sig: prev?.sig,
    protocol: prev?.protocol ?? 'arweave',
    input: prev?.input ?? '',
    open: prev?.open ?? false,
  };
}

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
  // Discovery: depositor's active token/vault escrows
  const [tokenEscrows, setTokenEscrows] = useState<
    Array<{ assetId: string; state: EscrowTokenState }>
  >([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState('');
  const [discoveryDone, setDiscoveryDone] = useState(false);

  // Per-token-escrow PDAs (derived after discovery, keyed by assetId hex).
  const [tokenPdas, setTokenPdas] = useState<Record<string, string>>({});

  // Per-token-escrow action state, keyed by assetId hex.
  type ActionState = 'idle' | 'submitting' | 'success' | 'error';
  const [tokenCancel, setTokenCancel] = useState<
    Record<string, { status: ActionState; message: string; sig?: string }>
  >({});
  const [tokenUpdate, setTokenUpdate] = useState<
    Record<
      string,
      {
        status: ActionState;
        message: string;
        sig?: string;
        protocol: EscrowProtocol;
        input: string;
        open: boolean;
      }
    >
  >({});

  // Status for update and cancel
  const [updateStatus, setUpdateStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [updateMessage, setUpdateMessage] = useState('');
  const [cancelStatus, setCancelStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [cancelMessage, setCancelMessage] = useState('');
  const [txSignature, setTxSignature] = useState('');

  const { publicKey, wallet } = useWallet();

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
      const programId = getEscrowProgramId();
      if (!programId) {
        setEscrowError(NO_PROGRAM_ERROR);
        return;
      }
      const { rpc } = makeRpc();
      const escrowPda = await getAntEscrow().getPda(address(antMint));
      const state = await fetchEscrowState(rpc, escrowPda, programId);
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
  }, [antMint]);

  useEffect(() => {
    if (antMint && antMint.length >= 32) {
      fetchEscrow();
    }
  }, [antMint, fetchEscrow]);

  // Auto-discover escrows when wallet connects
  useEffect(() => {
    if (!solPubkey) {
      setDepositorEscrows([]);
      setTokenEscrows([]);
      setTokenPdas({});
      setTokenCancel({});
      setTokenUpdate({});
      setDiscoveryDone(false);
      setDiscoveryError('');
      return;
    }

    let cancelled = false;
    (async () => {
      setDiscoveryLoading(true);
      setDiscoveryError('');
      try {
        const programId = getEscrowProgramId();
        if (!programId) {
          if (!cancelled) {
            setDiscoveryError(NO_PROGRAM_ERROR);
            setDiscoveryDone(true);
          }
          return;
        }
        const { rpc } = makeRpc();
        const all = await fetchAllEscrowsByDepositor(rpc, solPubkey, programId);
        const results = all
          .filter((r) => r.type === 'ant')
          .map((r) => ({ antMint: r.antMint, state: r.state }));
        const tokens = all
          .filter(
            (r): r is { type: 'token'; assetId: string; state: EscrowTokenState } =>
              r.type === 'token',
          )
          .map((r) => ({ assetId: r.assetId, state: r.state }));

        // Derive the escrow PDA for each token/vault escrow for display.
        const te = getTokenEscrow();
        const pdaEntries = await Promise.all(
          tokens.map(async ({ state }) => {
            const key = assetIdKey(state.assetId);
            try {
              const pda =
                state.assetType === 'vault'
                  ? await te.getVaultPda(address(state.depositor), state.assetId)
                  : await te.getTokenPda(address(state.depositor), state.assetId);
              return [key, pda.toString()] as const;
            } catch {
              return [key, ''] as const;
            }
          }),
        );

        if (!cancelled) {
          setDepositorEscrows(results);
          setTokenEscrows(tokens);
          setTokenPdas(Object.fromEntries(pdaEntries));
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
  }, [solPubkey]);

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
      if (!getEscrowProgramId()) {
        throw new Error(NO_PROGRAM_ERROR);
      }

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

      setUpdateMessage('Waiting for wallet approval...');
      const sig = await getAntEscrow({ adapter: wallet?.adapter }).updateRecipient({
        antMint: address(antMint),
        newRecipient: { protocol: newProtocol, publicKey: recipientPubkey },
      });

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
  }, [publicKey, escrowState, newProtocol, newRecipientInput, antMint, wallet, fetchEscrow]);

  // -------------------------------------------------------------------
  // Cancel escrow
  // -------------------------------------------------------------------
  const handleCancel = useCallback(async () => {
    if (!publicKey || !escrowState) return;

    setCancelStatus('submitting');
    setCancelMessage('Preparing cancel transaction...');

    try {
      if (!getEscrowProgramId()) {
        throw new Error(NO_PROGRAM_ERROR);
      }

      setCancelMessage('Waiting for wallet approval...');
      const sig = await getAntEscrow({ adapter: wallet?.adapter }).cancel({
        antMint: address(antMint),
      });

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
  }, [publicKey, escrowState, antMint, wallet]);

  // -------------------------------------------------------------------
  // Token / vault escrow management
  // -------------------------------------------------------------------
  const refreshTokenEscrows = useCallback(async () => {
    if (!solPubkey) return;
    try {
      const programId = getEscrowProgramId();
      if (!programId) return;
      const { rpc } = makeRpc();
      const all = await fetchAllEscrowsByDepositor(rpc, solPubkey, programId);
      const tokens = all
        .filter(
          (r): r is { type: 'token'; assetId: string; state: EscrowTokenState } =>
            r.type === 'token',
        )
        .map((r) => ({ assetId: r.assetId, state: r.state }));
      setTokenEscrows(tokens);
    } catch {
      // Best-effort refresh; leave the existing list in place on failure.
    }
  }, [solPubkey]);

  const handleTokenCancel = useCallback(
    async (state: EscrowTokenState) => {
      const key = assetIdKey(state.assetId);
      if (!publicKey) return;

      setTokenCancel((prev) => ({
        ...prev,
        [key]: { status: 'submitting', message: 'Preparing cancel transaction...' },
      }));

      try {
        if (!getEscrowProgramId()) {
          throw new Error(NO_PROGRAM_ERROR);
        }

        const te = getTokenEscrow({ adapter: wallet?.adapter });
        const arioMint = getArioMint();
        const escrowPda =
          state.assetType === 'vault'
            ? await te.getVaultPda(address(state.depositor), state.assetId)
            : await te.getTokenPda(address(state.depositor), state.assetId);
        const depositorTokenAccount = await getAtaForOwner(
          address(state.depositor),
          arioMint,
        );
        const escrowTokenAccount = await getAtaForOwner(escrowPda, arioMint);

        setTokenCancel((prev) => ({
          ...prev,
          [key]: { status: 'submitting', message: 'Waiting for wallet approval...' },
        }));

        const sig = await te.cancel({
          assetId: state.assetId,
          assetType: state.assetType,
          depositorTokenAccount,
          escrowTokenAccount,
        });

        setTokenCancel((prev) => ({
          ...prev,
          [key]: {
            status: 'success',
            message: `Escrow cancelled. Your ${formatMarioToArio(state.amount)} ARIO has been returned and rent refunded.`,
            sig,
          },
        }));
        refreshTokenEscrows();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const friendly =
          msg.includes('User rejected') || msg.includes('user rejected')
            ? 'Transaction cancelled by user.'
            : `Cancel failed: ${msg}`;
        setTokenCancel((prev) => ({
          ...prev,
          [key]: { status: 'error', message: friendly },
        }));
      }
    },
    [publicKey, wallet, refreshTokenEscrows],
  );

  const handleTokenUpdate = useCallback(
    async (state: EscrowTokenState) => {
      const key = assetIdKey(state.assetId);
      if (!publicKey) return;
      const form = tokenUpdate[key];
      const protocol = form?.protocol ?? 'arweave';
      const input = form?.input ?? '';
      if (!input) return;

      setTokenUpdate((prev) => ({
        ...prev,
        [key]: {
          ...defaultUpdateForm(prev[key]),
          status: 'submitting',
          message: 'Preparing update transaction...',
        },
      }));

      try {
        if (!getEscrowProgramId()) {
          throw new Error(NO_PROGRAM_ERROR);
        }

        let recipientPubkey: Uint8Array;
        try {
          recipientPubkey =
            protocol === 'arweave'
              ? parseArweaveRecipient(input)
              : parseEthereumRecipient(input);
        } catch (e) {
          throw new Error(
            `Invalid ${protocol} recipient: ${e instanceof Error ? e.message : String(e)}`,
          );
        }

        setTokenUpdate((prev) => ({
          ...prev,
          [key]: {
            ...defaultUpdateForm(prev[key]),
            status: 'submitting',
            message: 'Waiting for wallet approval...',
          },
        }));

        const te = getTokenEscrow({ adapter: wallet?.adapter });
        const sig = await te.updateRecipient({
          assetId: state.assetId,
          assetType: state.assetType,
          newRecipient: { protocol, publicKey: recipientPubkey },
        });

        setTokenUpdate((prev) => ({
          ...prev,
          [key]: {
            ...defaultUpdateForm(prev[key]),
            status: 'success',
            message:
              'Recipient updated. Nonce has been rotated — any previous signatures are invalidated.',
            sig,
          },
        }));
        refreshTokenEscrows();
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const friendly =
          msg.includes('User rejected') || msg.includes('user rejected')
            ? 'Transaction cancelled by user.'
            : `Update failed: ${msg}`;
        setTokenUpdate((prev) => ({
          ...prev,
          [key]: { ...defaultUpdateForm(prev[key]), status: 'error', message: friendly },
        }));
      }
    },
    [publicKey, wallet, tokenUpdate, refreshTokenEscrows],
  );

  return (
    <div style={styles.wrap}>
      <h1 className="page-title" style={styles.h1}>Manage an active escrow</h1>
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
                  style={{ ...styles.discoverySelectButton, marginLeft: 'auto' }}
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

      {solPubkey && (
        <StepCard
          n={5}
          title="Your token & vault escrows"
          active={tokenEscrows.length > 0}
        >
          <p style={styles.hint}>
            Liquid ARIO and time-locked vault escrows you deposited. Cancel
            to reclaim the tokens (and refund rent), or re-target the escrow
            at a new Arweave / Ethereum recipient.
          </p>

          {discoveryLoading && (
            <p style={styles.discoveryLoading}>
              Looking up your token & vault escrows...
            </p>
          )}
          {discoveryDone && !discoveryLoading && tokenEscrows.length === 0 && (
            <p style={styles.hint}>
              No token or vault escrows found for this wallet.
            </p>
          )}

          {tokenEscrows.length > 0 && (
            <div style={styles.discoveryList}>
              {tokenEscrows.map(({ state }) => {
                const key = assetIdKey(state.assetId);
                const pda = tokenPdas[key];
                const isOwner = state.depositor === solPubkey;
                const cancel = tokenCancel[key];
                const update = defaultUpdateForm(tokenUpdate[key]);
                const lockEnd =
                  state.assetType === 'vault'
                    ? new Date(Number(state.vaultEndTimestamp) * 1000)
                    : null;
                const cancelStatusItem = cancel?.status ?? 'idle';

                return (
                  <div key={key} style={styles.tokenCard}>
                    <div style={styles.tokenCardHeader}>
                      <span style={styles.tokenTypeBadge}>
                        {state.assetType === 'vault' ? 'Vault' : 'Token'}
                      </span>
                      <span style={styles.tokenAmount}>
                        {formatMarioToArio(state.amount)} ARIO
                      </span>
                    </div>

                    <div style={styles.infoRow}>
                      <span style={styles.infoLabel}>Recipient</span>
                      <code style={styles.infoValue}>
                        {formatRecipientPubkey(
                          state.recipientProtocol,
                          state.recipientPubkey,
                        )}{' '}
                        ({state.recipientProtocol})
                      </code>
                    </div>

                    <div style={styles.infoRow}>
                      <span style={styles.infoLabel}>Escrow PDA</span>
                      <code style={styles.infoValue}>{pda || 'deriving…'}</code>
                    </div>

                    {state.assetType === 'vault' && (
                      <>
                        <div style={styles.infoRow}>
                          <span style={styles.infoLabel}>Lock ends</span>
                          <span style={styles.infoValue}>
                            {lockEnd
                              ? `${lockEnd.toLocaleString()} (unix ${state.vaultEndTimestamp.toString()})`
                              : '—'}
                          </span>
                        </div>
                        <div style={styles.infoRow}>
                          <span style={styles.infoLabel}>Revocable</span>
                          <span style={styles.infoValue}>
                            {state.vaultRevocable ? 'Yes' : 'No'}
                          </span>
                        </div>
                      </>
                    )}

                    {!isOwner && (
                      <p style={styles.warningHint}>
                        Connected wallet does not match this escrow&apos;s
                        depositor.
                      </p>
                    )}

                    {/* Cancel */}
                    {cancelStatusItem === 'success' ? (
                      <div style={styles.successBox}>
                        <p style={styles.successText}>{cancel?.message}</p>
                        {cancel?.sig && (
                          <p style={styles.txLink}>
                            <a
                              href={`https://explorer.solana.com/tx/${cancel.sig}`}
                              target="_blank"
                              rel="noopener noreferrer"
                              style={styles.link}
                            >
                              View on Explorer
                            </a>
                          </p>
                        )}
                      </div>
                    ) : cancelStatusItem === 'error' ? (
                      <div style={styles.errorBox}>
                        <p style={styles.errorText}>{cancel?.message}</p>
                        <button
                          type="button"
                          style={{ ...styles.dangerButton, opacity: 1 }}
                          onClick={() => handleTokenCancel(state)}
                        >
                          Retry Cancel
                        </button>
                      </div>
                    ) : (
                      <div style={styles.tokenActions}>
                        <button
                          type="button"
                          style={{
                            ...styles.dangerButton,
                            opacity: isOwner ? 1 : 0.6,
                            cursor: isOwner ? 'pointer' : 'not-allowed',
                          }}
                          disabled={!isOwner || cancelStatusItem === 'submitting'}
                          onClick={() => handleTokenCancel(state)}
                        >
                          {cancelStatusItem === 'submitting'
                            ? 'Cancelling...'
                            : 'Cancel escrow'}
                        </button>
                        <button
                          type="button"
                          style={styles.discoverySelectButton}
                          onClick={() =>
                            setTokenUpdate((prev) => ({
                              ...prev,
                              [key]: {
                                ...defaultUpdateForm(prev[key]),
                                open: !defaultUpdateForm(prev[key]).open,
                              },
                            }))
                          }
                        >
                          {update.open ? 'Hide update' : 'Update recipient'}
                        </button>
                      </div>
                    )}
                    {cancelStatusItem === 'submitting' && (
                      <p style={styles.statusText}>{cancel?.message}</p>
                    )}

                    {/* Inline update-recipient form */}
                    {update.open && cancelStatusItem !== 'success' && (
                      <div style={styles.updateForm}>
                        <div style={styles.protocolPicker}>
                          <button
                            type="button"
                            style={{
                              ...styles.protocolButton,
                              ...(update.protocol === 'arweave'
                                ? styles.protocolActive
                                : {}),
                            }}
                            onClick={() =>
                              setTokenUpdate((prev) => ({
                                ...prev,
                                [key]: {
                                  ...defaultUpdateForm(prev[key]),
                                  open: true,
                                  protocol: 'arweave',
                                },
                              }))
                            }
                          >
                            Arweave
                          </button>
                          <button
                            type="button"
                            style={{
                              ...styles.protocolButton,
                              ...(update.protocol === 'ethereum'
                                ? styles.protocolActive
                                : {}),
                            }}
                            onClick={() =>
                              setTokenUpdate((prev) => ({
                                ...prev,
                                [key]: {
                                  ...defaultUpdateForm(prev[key]),
                                  open: true,
                                  protocol: 'ethereum',
                                },
                              }))
                            }
                          >
                            Ethereum
                          </button>
                        </div>
                        {update.protocol === 'arweave' ? (
                          <textarea
                            placeholder="Paste an Arweave address or RSA public key"
                            value={update.input}
                            onChange={(e) =>
                              setTokenUpdate((prev) => ({
                                ...prev,
                                [key]: {
                                  ...defaultUpdateForm(prev[key]),
                                  open: true,
                                  input: e.target.value,
                                },
                              }))
                            }
                            className="input"
                            style={styles.textarea}
                            rows={4}
                          />
                        ) : (
                          <input
                            type="text"
                            placeholder="0x... — 20-byte Ethereum address"
                            value={update.input}
                            onChange={(e) =>
                              setTokenUpdate((prev) => ({
                                ...prev,
                                [key]: {
                                  ...defaultUpdateForm(prev[key]),
                                  open: true,
                                  input: e.target.value,
                                },
                              }))
                            }
                            className="input"
                            style={styles.input}
                          />
                        )}

                        {update.status === 'success' ? (
                          <div style={styles.successBox}>
                            <p style={styles.successText}>{update.message}</p>
                            {update.sig && (
                              <p style={styles.txLink}>
                                <a
                                  href={`https://explorer.solana.com/tx/${update.sig}`}
                                  target="_blank"
                                  rel="noopener noreferrer"
                                  style={styles.link}
                                >
                                  View on Explorer
                                </a>
                              </p>
                            )}
                          </div>
                        ) : update.status === 'error' ? (
                          <div style={styles.errorBox}>
                            <p style={styles.errorText}>{update.message}</p>
                            <button
                              type="button"
                              style={{ ...styles.button, opacity: 1 }}
                              onClick={() => handleTokenUpdate(state)}
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
                                opacity: isOwner && update.input ? 1 : 0.6,
                                cursor:
                                  isOwner && update.input
                                    ? 'pointer'
                                    : 'not-allowed',
                                marginTop: '12px',
                              }}
                              disabled={
                                !isOwner ||
                                !update.input ||
                                update.status === 'submitting'
                              }
                              onClick={() => handleTokenUpdate(state)}
                            >
                              {update.status === 'submitting'
                                ? 'Updating...'
                                : 'Update recipient'}
                            </button>
                            {update.status === 'submitting' && (
                              <p style={styles.statusText}>{update.message}</p>
                            )}
                          </>
                        )}
                      </div>
                    )}
                  </div>
                );
              })}
            </div>
          )}
        </StepCard>
      )}
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
  button: {
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
  dangerButton: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    padding: '12px 24px',
    border: `1px solid ${brand.error}`,
    borderRadius: '16px',
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
    borderRadius: '16px',
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
    borderRadius: '16px',
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
    borderRadius: '16px',
    background: brand.cardSurface,
    color: brand.black,
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  tokenCard: {
    padding: '20px 24px',
    background: `radial-gradient(ellipse 140% 120% at top left, rgba(84, 39, 200, 0.03), transparent), rgba(255, 255, 255, 0.85)`,
    border: `1px solid ${brand.border}`,
    borderRadius: '16px',
    boxShadow: '0 1px 3px rgba(35, 35, 45, 0.04)',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
  },
  tokenCardHeader: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '8px',
  },
  tokenTypeBadge: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '11px',
    fontWeight: 700,
    color: brand.white,
    background: brand.primary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    padding: '3px 10px',
    borderRadius: '999px',
  },
  tokenAmount: {
    fontFamily: "'Besley', Georgia, serif",
    fontSize: '20px',
    fontWeight: 700,
    color: brand.black,
  },
  tokenActions: {
    display: 'flex',
    gap: '8px',
    flexWrap: 'wrap' as const,
    marginTop: '12px',
  },
  updateForm: {
    marginTop: '16px',
    paddingTop: '16px',
    borderTop: `1px solid ${brand.border}`,
  },
};
