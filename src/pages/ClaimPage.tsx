import React, {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { address } from '@solana/kit';
import { brand } from '../brand.js';
import { StepCard } from '../components/StepCard.tsx';
import { SolanaWalletConnect } from '../components/SolanaWalletConnect.tsx';
import { ArweaveWalletConnect } from '../components/ArweaveWalletConnect.tsx';
import { EthereumWalletConnect } from '../components/EthereumWalletConnect.tsx';
import {
  fetchEscrowsByRecipient,
  fetchTokenEscrowsByRecipient,
  fetchRawEscrowAccount,
  deserializeEscrowToken,
  lookupArweaveModulus,
  parseArweaveRecipient,
  isArweaveAddress,
  ESCROW_TOKEN_ACCOUNT_SIZE,
  type EscrowNetwork,
} from '../services/escrow-client.ts';
import { getAntEscrow, getEscrowProgramId, getNetwork, makeRpc } from '../services/solana.ts';
import {
  claimEscrowItem,
  makeAttestor,
  itemProtocol,
  itemLabel,
  type ClaimItem,
  type ClaimPhase,
} from '../services/claim-flow.ts';

interface Props {
  /** ANT mint or escrow PDA, optionally read from `?ant=<mint>` query string. */
  antMint: string;
}

type ItemResultPhase = 'queued' | ClaimPhase | 'success' | 'error';
interface ItemResult {
  phase: ItemResultPhase;
  message?: string;
  tx?: string;
}

/**
 * Recipient claim flow (batch).
 *
 * 1. Connect the Arweave/Ethereum wallet the assets were escrowed to — we
 *    discover every escrow addressed to it (or accept a manual identifier).
 * 2. Choose a Solana destination wallet (shared by all claims).
 * 3. Select which assets to claim and run them: each is signed with the
 *    recipient wallet and submitted as its own Solana tx, with per-item
 *    progress. One signature per asset is unavoidable — each escrow's
 *    authorization message is bound to its own asset id and nonce.
 */
export function ClaimPage({ antMint: initialAntMint }: Props) {
  const [antMint, setAntMint] = useState(initialAntMint);
  // Manual identifier entry starts expanded only when a claim link
  // pre-filled an identifier, so any lookup error is visible.
  const [showManual, setShowManual] = useState(!!initialAntMint);
  const [claimant, setClaimant] = useState('');
  const [solPubkey, setSolPubkey] = useState<string | undefined>();

  // Manual single-escrow resolution (feeds an item into the list).
  const [manualItem, setManualItem] = useState<ClaimItem | null>(null);
  const [escrowLoading, setEscrowLoading] = useState(false);
  const [escrowError, setEscrowError] = useState('');

  // Recipient wallet connection (for signing).
  const [arweaveAddress, setArweaveAddress] = useState<string | undefined>();
  const [ethereumAddress, setEthereumAddress] = useState<string | undefined>();
  const [ethereumProvider, setEthereumProvider] = useState<any>(undefined);

  // Recipient discovery.
  const [recipientItems, setRecipientItems] = useState<ClaimItem[]>([]);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState('');
  const [discoveryDone, setDiscoveryDone] = useState(false);

  // Selection + per-item claim results.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, ItemResult>>({});
  const [running, setRunning] = useState(false);

  const { publicKey, wallet } = useWallet();
  const network: EscrowNetwork = getNetwork();

  // Auto-fill the destination with the connected Solana wallet's address,
  // unless the user has typed their own. Re-syncs if they switch wallets.
  const claimantEditedRef = useRef(false);
  useEffect(() => {
    if (!publicKey || claimantEditedRef.current) return;
    setClaimant(publicKey.toBase58());
  }, [publicKey]);

  const connectedProtocol: 'arweave' | 'ethereum' | undefined = arweaveAddress
    ? 'arweave'
    : ethereumAddress
      ? 'ethereum'
      : undefined;

  // -------------------------------------------------------------------
  // Manual identifier resolution
  // -------------------------------------------------------------------
  const fetchEscrow = useCallback(async () => {
    const id = antMint.trim();
    if (!id || id.length < 30) {
      setManualItem(null);
      setEscrowError('');
      return;
    }
    if (isArweaveAddress(id)) {
      setManualItem(null);
      setEscrowError(
        'That looks like an Arweave address. Connect your Arweave wallet above to find the assets escrowed for you — this field is for a Solana ANT mint or escrow account address.',
      );
      return;
    }
    if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(id)) {
      setManualItem(null);
      setEscrowError(
        'That is not a valid Solana ANT mint or escrow address. Connect your wallet above to discover escrows automatically.',
      );
      return;
    }

    setEscrowLoading(true);
    setEscrowError('');
    setManualItem(null);
    try {
      const programId = getEscrowProgramId();
      if (!programId) {
        setEscrowError(
          'No escrow program configured. Set the program ID in the menu (or VITE_ESCROW_PROGRAM_ID) to point at a deployed ario-ant-escrow program.',
        );
        return;
      }
      const { rpc } = makeRpc();

      // Try as an ANT mint first (the SDK derives the PDA + decodes).
      const state = await getAntEscrow({}).get(address(id));
      if (state) {
        setManualItem({ kind: 'ant', id, state });
        return;
      }
      // Otherwise treat the identifier as a token/vault escrow PDA.
      const rawAccount = await fetchRawEscrowAccount(rpc, id, programId);
      if (rawAccount && rawAccount.size === ESCROW_TOKEN_ACCOUNT_SIZE) {
        setManualItem({ kind: 'token', id, state: deserializeEscrowToken(rawAccount.data) });
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
  }, [antMint]);

  useEffect(() => {
    if (antMint && antMint.trim().length >= 32) fetchEscrow();
  }, [antMint, fetchEscrow]);

  // -------------------------------------------------------------------
  // Auto-discover escrows addressed to the connected recipient wallet
  // -------------------------------------------------------------------
  useEffect(() => {
    if (!arweaveAddress) return;
    let cancelled = false;
    (async () => {
      setDiscoveryLoading(true);
      setDiscoveryError('');
      try {
        const programId = getEscrowProgramId();
        if (!programId) throw new Error('No escrow program configured.');
        const { rpc } = makeRpc();
        const modulus = parseArweaveRecipient(await lookupArweaveModulus(arweaveAddress));
        const [ants, tokens] = await Promise.all([
          fetchEscrowsByRecipient(rpc, 'arweave', modulus, programId),
          fetchTokenEscrowsByRecipient(rpc, 'arweave', modulus, programId),
        ]);
        if (!cancelled) {
          setRecipientItems([
            ...ants.map((e): ClaimItem => ({ kind: 'ant', id: e.antMint, state: e.state })),
            ...tokens.map((t): ClaimItem => ({ kind: 'token', id: t.escrowPda, state: t.state })),
          ]);
          setDiscoveryDone(true);
        }
      } catch (e) {
        if (!cancelled) {
          setDiscoveryError(
            `Could not look up escrows: ${e instanceof Error ? e.message : String(e)}. You can still enter an identifier manually.`,
          );
          setDiscoveryDone(true);
        }
      } finally {
        if (!cancelled) setDiscoveryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [arweaveAddress]);

  useEffect(() => {
    if (!ethereumAddress) return;
    let cancelled = false;
    (async () => {
      setDiscoveryLoading(true);
      setDiscoveryError('');
      try {
        let hex = ethereumAddress.trim();
        if (hex.startsWith('0x') || hex.startsWith('0X')) hex = hex.slice(2);
        const addrBytes = new Uint8Array(20);
        for (let i = 0; i < 20; i++) addrBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        const programId = getEscrowProgramId();
        if (!programId) throw new Error('No escrow program configured.');
        const { rpc } = makeRpc();
        const [ants, tokens] = await Promise.all([
          fetchEscrowsByRecipient(rpc, 'ethereum', addrBytes, programId),
          fetchTokenEscrowsByRecipient(rpc, 'ethereum', addrBytes, programId),
        ]);
        if (!cancelled) {
          setRecipientItems([
            ...ants.map((e): ClaimItem => ({ kind: 'ant', id: e.antMint, state: e.state })),
            ...tokens.map((t): ClaimItem => ({ kind: 'token', id: t.escrowPda, state: t.state })),
          ]);
          setDiscoveryDone(true);
        }
      } catch (e) {
        if (!cancelled) {
          setDiscoveryError(
            `Could not look up escrows: ${e instanceof Error ? e.message : String(e)}. You can still enter an identifier manually.`,
          );
          setDiscoveryDone(true);
        }
      } finally {
        if (!cancelled) setDiscoveryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ethereumAddress]);

  // Reset discovery when both recipient wallets disconnect.
  useEffect(() => {
    if (!arweaveAddress && !ethereumAddress) {
      setRecipientItems([]);
      setDiscoveryDone(false);
      setDiscoveryError('');
    }
  }, [arweaveAddress, ethereumAddress]);

  // -------------------------------------------------------------------
  // Unified item list (discovery + manual), deduped by identifier
  // -------------------------------------------------------------------
  const items = useMemo<ClaimItem[]>(() => {
    const map = new Map<string, ClaimItem>();
    for (const it of recipientItems) map.set(it.id, it);
    if (manualItem) map.set(manualItem.id, manualItem);
    return [...map.values()];
  }, [recipientItems, manualItem]);

  // Default-select each item the first time it appears, but only if its
  // protocol matches the connected wallet (so it's actually claimable).
  // Respects later user deselection.
  const seenIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const it of items) {
        if (!seenIds.current.has(it.id)) {
          seenIds.current.add(it.id);
          if (itemProtocol(it) === connectedProtocol) next.add(it.id);
        }
      }
      return next;
    });
  }, [items, connectedProtocol]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const claimableItems = useMemo(
    () => items.filter((it) => itemProtocol(it) === connectedProtocol),
    [items, connectedProtocol],
  );
  const selectedClaimable = useMemo(
    () => claimableItems.filter((it) => selectedIds.has(it.id)),
    [claimableItems, selectedIds],
  );
  const allClaimableSelected =
    claimableItems.length > 0 && selectedClaimable.length === claimableItems.length;

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (claimableItems.every((it) => next.has(it.id))) {
        for (const it of claimableItems) next.delete(it.id);
      } else {
        for (const it of claimableItems) next.add(it.id);
      }
      return next;
    });
  }, [claimableItems]);

  // -------------------------------------------------------------------
  // Run the batch claim
  // -------------------------------------------------------------------
  const isValidClaimant = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(claimant.trim());

  const runBatch = useCallback(async () => {
    if (!publicKey || !isValidClaimant || selectedClaimable.length === 0) return;
    setRunning(true);

    const attestor = makeAttestor(network);
    const claimantTrim = claimant.trim();

    // Seed every selected item as queued.
    setResults((prev) => {
      const next = { ...prev };
      for (const it of selectedClaimable) next[it.id] = { phase: 'queued' };
      return next;
    });

    for (const item of selectedClaimable) {
      try {
        const tx = await claimEscrowItem(item, {
          claimant: claimantTrim,
          network,
          walletAdapter: wallet?.adapter,
          ethereumProvider,
          attestor,
          onPhase: (phase, message) =>
            setResults((prev) => ({ ...prev, [item.id]: { phase, message } })),
        });
        setResults((prev) => ({ ...prev, [item.id]: { phase: 'success', tx } }));
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const friendly =
          msg.includes('User rejected') || msg.includes('user rejected')
            ? 'Cancelled in wallet.'
            : msg;
        setResults((prev) => ({ ...prev, [item.id]: { phase: 'error', message: friendly } }));
      }
    }

    setRunning(false);
  }, [
    publicKey,
    isValidClaimant,
    selectedClaimable,
    connectedProtocol,
    network,
    wallet,
    ethereumProvider,
    claimant,
  ]);

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------
  const hasWallet = !!connectedProtocol;
  const successCount = Object.values(results).filter((r) => r.phase === 'success').length;
  const allClaimed =
    selectedClaimable.length > 0 &&
    selectedClaimable.every((it) => results[it.id]?.phase === 'success');
  const canClaim =
    !!publicKey && isValidClaimant && selectedClaimable.length > 0 && !running;

  return (
    <div style={styles.wrap}>
      <h1 className="page-title" style={styles.h1}>Claim your assets</h1>
      <p style={styles.lede}>
        Someone escrowed ANTs or ARIO tokens for you. Connect the Arweave or
        Ethereum wallet they were sent to, pick the assets to claim, and release
        them to any Solana wallet you choose. Have a claim link? You can also
        enter the identifier manually in step 1.
      </p>

      {/* ---- Step 1: find assets ---- */}
      <StepCard n={1} title="Find your escrowed assets" completed={items.length > 0}>
        <p style={styles.hint}>
          Connect the Arweave or Ethereum wallet your assets were sent to, and
          we'll find everything waiting for you to claim.
        </p>

        <div style={styles.connectStack}>
          {(!connectedProtocol || connectedProtocol === 'arweave') && (
            <ArweaveWalletConnect
              onConnect={(addr) => setArweaveAddress(addr)}
              onDisconnect={() => setArweaveAddress(undefined)}
              connectedAddress={arweaveAddress}
            />
          )}
          {(!connectedProtocol || connectedProtocol === 'ethereum') && (
            <EthereumWalletConnect
              onConnect={(addr, provider) => {
                setEthereumAddress(addr);
                setEthereumProvider(provider);
              }}
              onDisconnect={() => {
                setEthereumAddress(undefined);
                setEthereumProvider(undefined);
              }}
              connectedAddress={ethereumAddress}
            />
          )}
        </div>

        {hasWallet && (
          <div style={styles.discoverySection}>
            {discoveryLoading && (
              <p style={styles.discoveryLoading}>Checking for assets escrowed to your wallet...</p>
            )}
            {discoveryError && <p style={styles.discoveryWarning}>{discoveryError}</p>}
            {discoveryDone && !discoveryError && items.length === 0 && (
              <p style={styles.hint}>
                No assets found escrowed to this wallet. If you have a claim link,
                paste the identifier below.
              </p>
            )}
          </div>
        )}

        {/* Item checklist */}
        {items.length > 0 && (
          <div style={styles.itemList}>
            <div style={styles.itemListHeader}>
              <span style={styles.discoveryTitle}>
                {claimableItems.length} claimable asset{claimableItems.length === 1 ? '' : 's'}
              </span>
              {claimableItems.length > 1 && (
                <button type="button" className="btn-text" onClick={toggleSelectAll}>
                  {allClaimableSelected ? 'Deselect all' : 'Select all'}
                </button>
              )}
            </div>
            {items.map((it) => {
              const claimable = itemProtocol(it) === connectedProtocol;
              const result = results[it.id];
              return (
                <label
                  key={it.id}
                  style={{
                    ...styles.itemCard,
                    opacity: claimable ? 1 : 0.55,
                    cursor: claimable && !running ? 'pointer' : 'default',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(it.id)}
                    disabled={!claimable || running}
                    onChange={() => toggleSelected(it.id)}
                    style={styles.checkbox}
                  />
                  <div style={styles.itemBody}>
                    <span style={styles.itemTitle}>{itemLabel(it)}</span>
                    <code style={styles.itemSub}>
                      {it.kind === 'ant' ? 'ANT' : it.state.assetType === 'vault' ? 'Vault' : 'Tokens'}
                      {' · '}
                      {it.id.slice(0, 10)}…{it.id.slice(-4)}
                      {' · from '}
                      {it.state.depositor.slice(0, 6)}…{it.state.depositor.slice(-4)}
                    </code>
                    {!claimable && (
                      <span style={styles.itemNote}>
                        Connect this asset's {itemProtocol(it)} wallet to claim it.
                      </span>
                    )}
                    {result && <ResultBadge result={result} />}
                  </div>
                </label>
              );
            })}
          </div>
        )}

        {/* Manual fallback */}
        <details
          style={styles.manualDetails}
          open={showManual}
          onToggle={(e) => setShowManual((e.target as HTMLDetailsElement).open)}
        >
          <summary style={styles.manualSummary}>
            Have a claim link or escrow address? Enter it manually
          </summary>
          <input
            type="text"
            placeholder="ANT mint or escrow address"
            value={antMint}
            onChange={(e) => setAntMint(e.target.value)}
            className="input"
            style={{ ...styles.input, marginTop: '12px' }}
          />
          {escrowLoading && <p style={styles.hint}>Loading escrow state...</p>}
          {escrowError && <p style={styles.errorHint}>{escrowError}</p>}
        </details>
      </StepCard>

      {/* ---- Step 2: destination ---- */}
      <StepCard
        n={2}
        title="Solana destination wallet"
        completed={isValidClaimant}
        active={items.length > 0}
      >
        <input
          type="text"
          placeholder="Solana wallet address"
          value={claimant}
          onChange={(e) => {
            // Once the user types, stop auto-syncing from the wallet — unless
            // they clear the field, in which case re-enable auto-fill.
            claimantEditedRef.current = e.target.value.trim().length > 0;
            setClaimant(e.target.value);
          }}
          className="input"
          style={styles.input}
          disabled={running}
        />
        {publicKey && claimant !== publicKey.toBase58() && (
          <button
            type="button"
            className="btn-text"
            style={styles.useWalletBtn}
            disabled={running}
            onClick={() => {
              claimantEditedRef.current = false;
              setClaimant(publicKey.toBase58());
            }}
          >
            Use connected wallet ({publicKey.toBase58().slice(0, 4)}…{publicKey.toBase58().slice(-4)})
          </button>
        )}
        <p style={styles.hint}>
          The Solana wallet that will receive every asset you claim
          {publicKey ? ' — pre-filled from your connected wallet' : ''}. This
          address is locked into each signature — no one can redirect it.
        </p>
      </StepCard>

      {/* ---- Step 3: claim ---- */}
      <StepCard
        n={3}
        title="Claim selected assets"
        completed={allClaimed}
        active={isValidClaimant && selectedClaimable.length > 0}
      >
        {selectedClaimable.length === 0 ? (
          <p style={styles.hint}>Select at least one asset in step 1 to claim.</p>
        ) : allClaimed ? (
          <p style={styles.successHint}>
            All {selectedClaimable.length} selected asset
            {selectedClaimable.length === 1 ? '' : 's'} claimed. See each
            asset's status in step 1.
          </p>
        ) : (
          <>
            <p style={styles.hint}>
              Connect a Solana wallet to pay the network fee and submit the
              claims. You'll approve each asset in your {connectedProtocol} wallet
              ({selectedClaimable.length} signature
              {selectedClaimable.length === 1 ? '' : 's'}) — every asset is
              authorized separately.
            </p>
            <div style={{ margin: '12px 0' }}>
              <SolanaWalletConnect
                onConnect={(pubkey) => setSolPubkey(pubkey)}
                onDisconnect={() => setSolPubkey(undefined)}
                connectedPubkey={solPubkey}
              />
            </div>
            <button
              type="button"
              className="btn-primary"
              style={{
                ...styles.submit,
                opacity: canClaim ? 1 : 0.6,
                cursor: canClaim ? 'pointer' : 'not-allowed',
              }}
              disabled={!canClaim}
              onClick={runBatch}
            >
              {running
                ? 'Claiming…'
                : `Claim ${selectedClaimable.length} asset${selectedClaimable.length === 1 ? '' : 's'}`}
            </button>
            {successCount > 0 && (
              <p style={styles.successHint}>
                {successCount} of {selectedClaimable.length} claimed. Progress is
                shown on each asset in step 1.
              </p>
            )}
          </>
        )}
      </StepCard>
    </div>
  );
}

// ---------------------------------------------------------------------------

function ResultBadge({ result }: { result: ItemResult }) {
  if (result.phase === 'success') {
    return (
      <span style={{ ...styles.badge, ...styles.badgeSuccess }}>
        ✓ Claimed
        {result.tx && (
          <a
            href={`https://explorer.solana.com/tx/${result.tx}`}
            target="_blank"
            rel="noopener noreferrer"
            style={styles.badgeLink}
          >
            View
          </a>
        )}
      </span>
    );
  }
  if (result.phase === 'error') {
    return <span style={{ ...styles.badge, ...styles.badgeError }}>✕ {result.message}</span>;
  }
  const label =
    result.phase === 'queued'
      ? 'Queued…'
      : result.phase === 'signing'
        ? result.message || 'Awaiting signature…'
        : result.message || 'Submitting…';
  return <span style={{ ...styles.badge, ...styles.badgePending }}>{label}</span>;
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { maxWidth: '900px', width: '100%', display: 'flex', flexDirection: 'column', gap: '24px' },
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
  useWalletBtn: {
    marginTop: '8px',
    fontSize: '13px',
    color: brand.primary,
    fontWeight: 600,
    padding: 0,
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
    margin: '10px 0 0',
    fontWeight: 600,
  },
  errorHint: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.error,
    margin: '8px 0 0',
  },
  connectStack: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '12px',
    marginTop: '12px',
  },
  discoverySection: { marginTop: '16px' },
  discoveryLoading: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.textTertiary,
    margin: 0,
    fontStyle: 'italic' as const,
  },
  discoveryWarning: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.textTertiary,
    margin: 0,
  },
  discoveryTitle: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '14px',
    fontWeight: 700,
    color: brand.black,
  },
  itemList: {
    marginTop: '16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  },
  itemListHeader: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    marginBottom: '4px',
  },
  itemCard: {
    display: 'flex',
    alignItems: 'flex-start',
    gap: '12px',
    padding: '14px 16px',
    background: `radial-gradient(ellipse 140% 120% at top left, rgba(84, 39, 200, 0.03), transparent), rgba(255, 255, 255, 0.85)`,
    border: `1px solid ${brand.border}`,
    borderRadius: '16px',
    boxShadow: '0 1px 3px rgba(35, 35, 45, 0.04)',
  },
  checkbox: { width: '17px', height: '17px', marginTop: '2px', flexShrink: 0, accentColor: brand.primary },
  itemBody: { display: 'flex', flexDirection: 'column' as const, gap: '3px', minWidth: 0, flex: 1 },
  itemTitle: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '15px',
    fontWeight: 700,
    color: brand.black,
  },
  itemSub: { fontSize: '12px', color: brand.textTertiary, fontFamily: 'monospace', wordBreak: 'break-all' as const },
  itemNote: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '12px',
    color: brand.textTertiary,
    marginTop: '2px',
  },
  badge: {
    marginTop: '6px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    alignSelf: 'flex-start',
    padding: '4px 10px',
    borderRadius: '12px',
    fontSize: '12px',
    fontWeight: 600,
    fontFamily: "'Plus Jakarta Sans', sans-serif",
  },
  badgePending: { background: brand.cardSurface, color: brand.textSecondary },
  badgeSuccess: { background: brand.successBg, color: brand.success },
  badgeError: { background: brand.errorBg, color: brand.error },
  badgeLink: { color: brand.primary, textDecoration: 'none', fontWeight: 700 },
  manualDetails: { marginTop: '16px', paddingTop: '14px', borderTop: `1px solid ${brand.border}` },
  manualSummary: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    fontWeight: 600,
    color: brand.textSecondary,
    cursor: 'pointer',
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
};
