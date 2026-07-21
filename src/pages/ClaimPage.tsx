import React, {
  useState,
  useCallback,
  useEffect,
  useMemo,
  useRef,
} from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { brand } from '../brand.js';
import { StepCard } from '../components/StepCard.tsx';
import { SolanaWalletConnect } from '../components/SolanaWalletConnect.tsx';
import { ArweaveWalletConnect } from '../components/ArweaveWalletConnect.tsx';
import { EthereumWalletConnect } from '../components/EthereumWalletConnect.tsx';
import { getNetwork, explorerTxUrl, type EscrowNetwork } from '../services/solana.ts';
import {
  getClaimable,
  getAsset,
  type ClaimableAssetView,
  type ClaimProtocol,
} from '../services/claims-api.ts';
import {
  claimAsset,
  type ClaimPhase,
  type RecipientIdentity,
} from '../services/claim-service.ts';
import {
  lookupArweaveModulus,
  parseArweaveModulus,
  parseEthereumAddress,
  formatMarioToArio,
  isArweaveAddress,
} from '../services/recipient.ts';

interface Props {
  /** Optional `?asset=<assetKey>` deep-link identifier (ANT mint or 64-hex id). */
  antMint: string;
}

type ItemResultPhase = 'queued' | ClaimPhase | 'success' | 'review' | 'error';
interface ItemResult {
  phase: ItemResultPhase;
  message?: string;
  tx?: string;
}

/** Human label for the protocol a wallet speaks, for display to the user. */
const protocolLabel: Record<ClaimProtocol, string> = {
  arweave: 'Arweave',
  ethereum: 'Ethereum',
};

/** Human label for a claimable asset. */
function assetLabel(a: ClaimableAssetView): string {
  if (a.assetType === 'ant') {
    // The claims API returns no ArNS name for an ANT, only its mint — so we
    // truncate the mint like the sub-label. Showing the real ArNS name would
    // require the claims API to return it.
    const mint = a.antMint ?? a.assetKey;
    return `ANT ${mint.slice(0, 6)}…${mint.slice(-4)}`;
  }
  const amount = a.amount ? formatMarioToArio(BigInt(a.amount)) : '?';
  return a.assetType === 'vault' ? `${amount} ARIO vault` : `${amount} ARIO`;
}
function assetKindLabel(a: ClaimableAssetView): string {
  return a.assetType === 'ant' ? 'ANT' : a.assetType === 'vault' ? 'Vault' : 'ARIO';
}

/**
 * Recipient claim flow (batch) — centralized.
 *
 * 1. Connect the Arweave/Ethereum wallet the assets were addressed to — we ask
 *    the claims service for everything claimable by that identity.
 * 2. Choose a Solana destination wallet (shared by all claims).
 * 3. Claim: each asset is initiated, its server-issued canonical is verified
 *    locally, signed with the recipient wallet, and submitted. One signature per
 *    asset — each canonical binds its own asset id + single-use challenge nonce.
 */
export function ClaimPage({ antMint: initialAssetKey }: Props) {
  const [assetKeyInput, setAssetKeyInput] = useState(initialAssetKey);
  const [showManual, setShowManual] = useState(!!initialAssetKey);

  // Recipient wallet connection (for discovery + signing).
  const [arweaveAddress, setArweaveAddress] = useState<string | undefined>();
  const [ethereumAddress, setEthereumAddress] = useState<string | undefined>();
  const [ethereumProvider, setEthereumProvider] = useState<any>(undefined);

  // The connected wallet's raw identity bytes (recipient pubkey), established
  // ONLY from the connected wallet — never guessed from a deep link.
  const [identity, setIdentity] = useState<RecipientIdentity | null>(null);

  // Destination.
  const [claimant, setClaimant] = useState('');
  const [solPubkey, setSolPubkey] = useState<string | undefined>();

  // Discovery.
  const [assets, setAssets] = useState<ClaimableAssetView[]>([]);
  const [manualAsset, setManualAsset] = useState<ClaimableAssetView | null>(null);
  const [discoveryLoading, setDiscoveryLoading] = useState(false);
  const [discoveryError, setDiscoveryError] = useState('');
  const [discoveryDone, setDiscoveryDone] = useState(false);
  const [manualLoading, setManualLoading] = useState(false);
  const [manualError, setManualError] = useState('');

  // Selection + per-item results.
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [results, setResults] = useState<Record<string, ItemResult>>({});
  const [running, setRunning] = useState(false);

  const { publicKey, wallet } = useWallet();
  const network: EscrowNetwork = getNetwork();

  const connectedProtocol: ClaimProtocol | undefined = arweaveAddress
    ? 'arweave'
    : ethereumAddress
      ? 'ethereum'
      : undefined;

  // Auto-fill the destination with the connected Solana wallet, unless the user
  // typed their own. Re-syncs if they switch wallets.
  const claimantEditedRef = useRef(false);
  useEffect(() => {
    if (!publicKey || claimantEditedRef.current) return;
    setClaimant(publicKey.toBase58());
  }, [publicKey]);

  // -------------------------------------------------------------------
  // Establish identity + discover claimable assets on wallet connect
  // -------------------------------------------------------------------
  useEffect(() => {
    if (!arweaveAddress) return;
    let cancelled = false;
    (async () => {
      setDiscoveryLoading(true);
      setDiscoveryError('');
      setIdentity(null);
      try {
        // The 512-byte RSA modulus is required to rebuild + verify the canonical
        // before signing, so we look it up (and it self-verifies to the address).
        const modulus = parseArweaveModulus(await lookupArweaveModulus(arweaveAddress));
        if (cancelled) return;
        setIdentity({ protocol: 'arweave', pubkey: modulus });
        const res = await getClaimable({ protocol: 'arweave', address: arweaveAddress });
        if (!cancelled) {
          setAssets(res.assets);
          setDiscoveryDone(true);
        }
      } catch (e) {
        if (!cancelled) {
          setDiscoveryError(
            `Could not load your claimable assets: ${e instanceof Error ? e.message : String(e)}`,
          );
          setDiscoveryDone(true);
        }
      } finally {
        if (!cancelled) setDiscoveryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [arweaveAddress]);

  useEffect(() => {
    if (!ethereumAddress) return;
    let cancelled = false;
    (async () => {
      setDiscoveryLoading(true);
      setDiscoveryError('');
      setIdentity(null);
      try {
        setIdentity({ protocol: 'ethereum', pubkey: parseEthereumAddress(ethereumAddress) });
        const res = await getClaimable({ protocol: 'ethereum', address: ethereumAddress });
        if (!cancelled) {
          setAssets(res.assets);
          setDiscoveryDone(true);
        }
      } catch (e) {
        if (!cancelled) {
          setDiscoveryError(
            `Could not load your claimable assets: ${e instanceof Error ? e.message : String(e)}`,
          );
          setDiscoveryDone(true);
        }
      } finally {
        if (!cancelled) setDiscoveryLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [ethereumAddress]);

  // Reset when both recipient wallets disconnect.
  useEffect(() => {
    if (!arweaveAddress && !ethereumAddress) {
      setAssets([]);
      setManualAsset(null);
      setIdentity(null);
      setDiscoveryDone(false);
      setDiscoveryError('');
    }
  }, [arweaveAddress, ethereumAddress]);

  // -------------------------------------------------------------------
  // Manual deep-link resolution (protocol comes from the connected wallet)
  // -------------------------------------------------------------------
  const fetchManualAsset = useCallback(async () => {
    const key = assetKeyInput.trim();
    setManualError('');
    setManualAsset(null);
    if (!key || key.length < 30) return;
    if (isArweaveAddress(key)) {
      setManualError(
        'That looks like an Arweave address. Connect your Arweave wallet above — we find everything addressed to it automatically.',
      );
      return;
    }
    if (!connectedProtocol) {
      setManualError('Connect the wallet the asset was addressed to first, then paste the claim identifier.');
      return;
    }
    setManualLoading(true);
    try {
      const asset = await getAsset(key);
      if (asset) setManualAsset(asset);
      else setManualError('No claimable asset found for this identifier.');
    } catch (e) {
      setManualError(`Lookup failed: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setManualLoading(false);
    }
  }, [assetKeyInput, connectedProtocol]);

  useEffect(() => {
    if (assetKeyInput && assetKeyInput.trim().length >= 32 && connectedProtocol) {
      fetchManualAsset();
    }
  }, [assetKeyInput, connectedProtocol, fetchManualAsset]);

  // -------------------------------------------------------------------
  // Unified item list (discovery + manual), deduped by assetKey
  // -------------------------------------------------------------------
  const items = useMemo<ClaimableAssetView[]>(() => {
    const map = new Map<string, ClaimableAssetView>();
    for (const a of assets) map.set(a.assetKey, a);
    if (manualAsset) map.set(manualAsset.assetKey, manualAsset);
    return [...map.values()];
  }, [assets, manualAsset]);

  // Default-select each item the first time it appears.
  const seenIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const a of items) {
        if (!seenIds.current.has(a.assetKey)) {
          seenIds.current.add(a.assetKey);
          next.add(a.assetKey);
        }
      }
      return next;
    });
  }, [items]);

  const toggleSelected = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const selected = useMemo(
    () => items.filter((a) => selectedIds.has(a.assetKey)),
    [items, selectedIds],
  );
  const allSelected = items.length > 0 && selected.length === items.length;

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (items.every((a) => next.has(a.assetKey))) {
        for (const a of items) next.delete(a.assetKey);
      } else {
        for (const a of items) next.add(a.assetKey);
      }
      return next;
    });
  }, [items]);

  // -------------------------------------------------------------------
  // Run the batch claim
  // -------------------------------------------------------------------
  const isValidClaimant = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(claimant.trim());

  const runBatch = useCallback(async () => {
    if (!identity || !isValidClaimant || selected.length === 0) return;
    setRunning(true);
    const claimantTrim = claimant.trim();

    setResults((prev) => {
      const next = { ...prev };
      for (const a of selected) next[a.assetKey] = { phase: 'queued' };
      return next;
    });

    for (const asset of selected) {
      try {
        const status = await claimAsset({
          asset,
          claimant: claimantTrim,
          identity,
          network,
          ethereumProvider,
          onPhase: (phase, message) =>
            setResults((prev) => ({ ...prev, [asset.assetKey]: { phase, message } })),
        });
        const tx = status.txSignatures[0];
        if (status.status === 'confirmed' || status.status === 'verified' || status.status === 'dispatching') {
          setResults((prev) => ({
            ...prev,
            [asset.assetKey]: {
              phase: 'success',
              tx,
              message: status.status === 'confirmed' ? undefined : 'Settling…',
            },
          }));
        } else if (status.status === 'pending_review') {
          // A still-locked vault isn't "under review" — it's delivered when it
          // unlocks. vaultEndTimestamp is epoch milliseconds (matches the
          // claims service, which compares it against Date.now()).
          const message =
            asset.assetType === 'vault' && asset.vaultEndTimestamp
              ? `Still time-locked — delivered when it unlocks on ${new Date(
                  asset.vaultEndTimestamp,
                ).toLocaleString()}.`
              : 'Submitted for review.';
          setResults((prev) => ({
            ...prev,
            [asset.assetKey]: { phase: 'review', message },
          }));
        } else {
          setResults((prev) => ({
            ...prev,
            [asset.assetKey]: {
              phase: 'error',
              message: status.error ?? `Claim ${status.status}.`,
            },
          }));
        }
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        const friendly =
          msg.includes('User rejected') || msg.includes('user rejected')
            ? 'Cancelled in wallet.'
            : msg;
        setResults((prev) => ({ ...prev, [asset.assetKey]: { phase: 'error', message: friendly } }));
      }
    }

    setRunning(false);
  }, [identity, isValidClaimant, selected, claimant, network, ethereumProvider]);

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------
  const hasWallet = !!connectedProtocol;
  const successCount = Object.values(results).filter(
    (r) => r.phase === 'success' || r.phase === 'review',
  ).length;
  const allClaimed =
    selected.length > 0 &&
    selected.every(
      (a) => results[a.assetKey]?.phase === 'success' || results[a.assetKey]?.phase === 'review',
    );
  const canClaim = !!identity && isValidClaimant && selected.length > 0 && !running;

  return (
    <div style={styles.wrap}>
      <h1 className="page-title" style={styles.h1}>Claim your assets</h1>
      <p style={styles.lede}>
        Someone set aside ANTs or ARIO tokens for you. Connect the Arweave or
        Ethereum wallet they were addressed to, pick the assets to claim, and
        we'll deliver them to any Solana wallet you choose. Have a claim link?
        You can also enter the identifier manually in step 1.
      </p>

      {/* ---- Step 1: find assets ---- */}
      <StepCard n={1} title="Find your assets" completed={items.length > 0}>
        <p style={styles.hint}>
          Connect the Arweave or Ethereum wallet your assets were addressed to,
          and we'll find everything waiting for you to claim.
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
              <p style={styles.discoveryLoading}>Checking for assets addressed to your wallet...</p>
            )}
            {discoveryError && <p style={styles.discoveryError}>{discoveryError}</p>}
            {discoveryDone && !discoveryError && items.length === 0 && (
              <p style={styles.hint}>
                No assets found for this wallet. If you have a claim link, paste
                the identifier below.
              </p>
            )}
          </div>
        )}

        {/* Item checklist */}
        {items.length > 0 && (
          <div style={styles.itemList}>
            <div style={styles.itemListHeader}>
              <span style={styles.discoveryTitle}>
                {items.length} claimable asset{items.length === 1 ? '' : 's'}
              </span>
              {items.length > 1 && (
                <button type="button" className="btn-text" onClick={toggleSelectAll}>
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              )}
            </div>
            {items.map((a) => {
              const result = results[a.assetKey];
              return (
                <label
                  key={a.assetKey}
                  style={{
                    ...styles.itemCard,
                    cursor: !running ? 'pointer' : 'default',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={selectedIds.has(a.assetKey)}
                    disabled={running}
                    onChange={() => toggleSelected(a.assetKey)}
                    style={styles.checkbox}
                  />
                  <div style={styles.itemBody}>
                    <span style={styles.itemTitle}>{assetLabel(a)}</span>
                    <code style={styles.itemSub}>
                      {assetKindLabel(a)}
                      {' · '}
                      {a.assetKey.slice(0, 10)}…{a.assetKey.slice(-4)}
                    </code>
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
            Have a claim link or asset identifier? Enter it manually
          </summary>
          <input
            type="text"
            placeholder="Claim identifier (ANT mint or asset id)"
            value={assetKeyInput}
            onChange={(e) => setAssetKeyInput(e.target.value)}
            className="input"
            style={{ ...styles.input, marginTop: '12px' }}
          />
          {manualLoading && <p style={styles.hint}>Looking up asset...</p>}
          {manualError && <p style={styles.errorHint}>{manualError}</p>}
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
            claimantEditedRef.current = e.target.value.trim().length > 0;
            setClaimant(e.target.value);
          }}
          className="input"
          style={styles.input}
          disabled={running}
        />
        <div style={{ margin: '12px 0' }}>
          <SolanaWalletConnect
            onConnect={(pubkey) => setSolPubkey(pubkey)}
            onDisconnect={() => setSolPubkey(undefined)}
            connectedPubkey={solPubkey}
          />
        </div>
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
          Connecting a Solana wallet is optional; you can also just paste an
          address.
        </p>
      </StepCard>

      {/* ---- Step 3: claim ---- */}
      <StepCard
        n={3}
        title="Claim selected assets"
        completed={allClaimed}
        active={isValidClaimant && selected.length > 0}
      >
        {selected.length === 0 ? (
          <p style={styles.hint}>Select at least one asset in step 1 to claim.</p>
        ) : allClaimed ? (
          <p style={styles.successHint}>
            All {selected.length} selected asset{selected.length === 1 ? '' : 's'} claimed.
            See each asset's status in step 1.
          </p>
        ) : (
          <>
            <p style={styles.hint}>
              You'll approve each asset in your{' '}
              {connectedProtocol ? protocolLabel[connectedProtocol] : ''} wallet
              ({selected.length} signature{selected.length === 1 ? '' : 's'}) — every
              asset is authorized separately. Before each signature we re-verify the
              message binds this exact asset and your destination wallet.
            </p>
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
                : `Claim ${selected.length} asset${selected.length === 1 ? '' : 's'}`}
            </button>
            {successCount > 0 && (
              <p style={styles.successHint}>
                {successCount} of {selected.length} claimed. Progress is shown on each
                asset in step 1.
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
        ✓ {result.message ?? 'Claimed'}
        {result.tx && (
          <a
            href={explorerTxUrl(result.tx)}
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
  if (result.phase === 'review') {
    return <span style={{ ...styles.badge, ...styles.badgePending }}>⏳ {result.message}</span>;
  }
  if (result.phase === 'error') {
    return <span style={{ ...styles.badge, ...styles.badgeError }}>✕ {result.message}</span>;
  }
  const label =
    result.phase === 'queued'
      ? 'Queued…'
      : result.phase === 'initiating'
        ? result.message || 'Preparing…'
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
  discoveryError: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.error,
    margin: 0,
    fontWeight: 600,
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
