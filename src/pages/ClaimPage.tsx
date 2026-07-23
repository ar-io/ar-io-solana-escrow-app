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
  getClaim,
  type ClaimableAssetView,
  type ClaimProtocol,
  type ClaimStatusView,
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
  /** A `review` outcome that is a still-time-locked vault (calm, not an error). */
  locked?: boolean;
}

/** Human label for the protocol a wallet speaks, for display to the user. */
const protocolLabel: Record<ClaimProtocol, string> = {
  arweave: 'Arweave',
  ethereum: 'Ethereum',
};

/** Human label for a claimable asset. */
function assetLabel(a: ClaimableAssetView): string {
  if (a.assetType === 'ant') {
    // Prefer the ANT's on-chain ArNS name (e.g. `wolfethyst`) as the title.
    // Falls back to the truncated mint when the name has not been backfilled.
    if (a.name) return a.name;
    const mint = a.antMint ?? a.assetKey;
    return `ANT ${mint.slice(0, 6)}…${mint.slice(-4)}`;
  }
  const amount = a.amount ? formatMarioToArio(BigInt(a.amount)) : '?';
  return a.assetType === 'vault' ? `${amount} ARIO vault` : `${amount} ARIO`;
}
function assetKindLabel(a: ClaimableAssetView): string {
  return a.assetType === 'ant' ? 'ANT' : a.assetType === 'vault' ? 'Vault' : 'ARIO';
}

// ---------------------------------------------------------------------------
// Vault time-lock helpers
//
// `vaultEndTimestamp` is UNIX SECONDS on the wire (the claims service stores
// `vault_end_ts` in seconds and compares it against `Math.floor(Date.now()/1000)`).
// The UI works in milliseconds, so every read multiplies by 1000. A vault whose
// unlock is still in the future is TIME-LOCKED: claiming it does not dispense —
// the service queues it for automatic delivery to the destination at unlock. An
// already-expired vault dispenses immediately as liquid ARIO (handled as a normal
// success).
// ---------------------------------------------------------------------------

/** Vault unlock time in ms, or null for non-vaults / vaults without an end. */
function vaultUnlockMs(a: ClaimableAssetView): number | null {
  return a.assetType === 'vault' && a.vaultEndTimestamp != null
    ? a.vaultEndTimestamp * 1000
    : null;
}

/** True when this is a vault whose unlock time is still in the future. */
function isVaultLocked(a: ClaimableAssetView): boolean {
  const ms = vaultUnlockMs(a);
  return ms != null && ms > Date.now();
}

/** Human-readable unlock date, e.g. "Feb 6, 2027". */
function formatUnlockDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
  });
}

/** Calm, accurate post-claim copy for a still-time-locked vault. */
function lockedVaultMessage(a: ClaimableAssetView, claimant: string): string {
  const ms = vaultUnlockMs(a);
  const dest = claimant
    ? `${claimant.slice(0, 4)}…${claimant.slice(-4)}`
    : 'your Solana wallet';
  const when = ms ? ` on ${formatUnlockDate(ms)}` : '';
  return `Time-locked — the ARIO will be delivered to ${dest} automatically when it unlocks${when}. Nothing more to do.`;
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
        const res = await getClaimable({ protocol: 'arweave', address: arweaveAddress, includeClaimed: true });
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
        const res = await getClaimable({ protocol: 'ethereum', address: ethereumAddress, includeClaimed: true });
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
    // Available first, then claimed history.
    return [...map.values()].sort(
      (x, y) => Number(x.status === 'claimed') - Number(y.status === 'claimed'),
    );
  }, [assets, manualAsset]);

  // Only `available` assets are actionable; `claimed` ones render as history
  // (disabled, non-selectable) so a user can see what they already claimed.
  const availableItems = useMemo(() => items.filter((a) => a.status !== 'claimed'), [items]);
  const claimedItems = useMemo(() => items.filter((a) => a.status === 'claimed'), [items]);

  // Default-select each AVAILABLE item the first time it appears (never claimed).
  const seenIds = useRef<Set<string>>(new Set());
  useEffect(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      for (const a of items) {
        if (!seenIds.current.has(a.assetKey)) {
          seenIds.current.add(a.assetKey);
          if (a.status !== 'claimed') next.add(a.assetKey);
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
    () => availableItems.filter((a) => selectedIds.has(a.assetKey)),
    [availableItems, selectedIds],
  );
  const allSelected = availableItems.length > 0 && selected.length === availableItems.length;

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (availableItems.every((a) => next.has(a.assetKey))) {
        for (const a of availableItems) next.delete(a.assetKey);
      } else {
        for (const a of availableItems) next.add(a.assetKey);
      }
      return next;
    });
  }, [availableItems]);

  // -------------------------------------------------------------------
  // Run the batch claim
  // -------------------------------------------------------------------
  const isValidClaimant = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(claimant.trim());

  // -------------------------------------------------------------------
  // Background confirmation polling (FIX #1)
  // -------------------------------------------------------------------
  // The worker settles on a ~30s cadence, so a freshly-completed claim comes
  // back `verified`/`dispatching` ("Settling…"). Keep polling that claim in the
  // BACKGROUND (bounded) and flip the badge to Confirmed (+ tx View) when it
  // lands — without blocking the UI or the batch loop.
  const pollControllers = useRef<Map<string, { cancelled: boolean }>>(new Map());
  const cancelAllPolls = useCallback(() => {
    for (const c of pollControllers.current.values()) c.cancelled = true;
    pollControllers.current.clear();
  }, []);
  // Cancel every outstanding poll on unmount.
  useEffect(() => () => cancelAllPolls(), [cancelAllPolls]);

  const pollToConfirmation = useCallback((assetKey: string, claimId: string, lockedMessage?: string) => {
    // Supersede any existing poll for this asset.
    const prior = pollControllers.current.get(assetKey);
    if (prior) prior.cancelled = true;
    const ctrl = { cancelled: false };
    pollControllers.current.set(assetKey, ctrl);

    const intervalMs = 5_000;
    const deadline = Date.now() + 4 * 60_000; // give the ~30s worker several cycles
    void (async () => {
      while (!ctrl.cancelled && Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, intervalMs));
        if (ctrl.cancelled) return;
        let s: ClaimStatusView;
        try {
          s = await getClaim(claimId);
        } catch {
          continue; // transient RPC/API blip — keep trying until the deadline
        }
        if (ctrl.cancelled) return;
        const tx = s.txSignatures[0];
        if (s.status === 'confirmed') {
          setResults((prev) => ({ ...prev, [assetKey]: { phase: 'success', tx, message: undefined } }));
          break;
        }
        if (s.status === 'failed' || s.status === 'rejected' || s.status === 'expired') {
          setResults((prev) => ({ ...prev, [assetKey]: { phase: 'error', message: s.error ?? `Claim ${s.status}.` } }));
          break;
        }
        if (s.status === 'needs_operator' || s.status === 'awaiting_manual_vault_delivery') {
          // A still-locked vault lands here — show its calm unlock-date copy
          // rather than a bare "awaiting operator" note.
          setResults((prev) => ({
            ...prev,
            [assetKey]: lockedMessage
              ? { phase: 'review', locked: true, message: lockedMessage }
              : { phase: 'review', message: 'Awaiting operator delivery.' },
          }));
          break;
        }
        // still verified / dispatching -> keep "Settling…" and poll again.
      }
      pollControllers.current.delete(assetKey);
    })();
  }, []);

  const runBatch = useCallback(async () => {
    if (!identity || !isValidClaimant || selected.length === 0) return;
    setRunning(true);
    cancelAllPolls(); // supersede any polls from a previous run
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
        const terminalBad =
          status.status === 'failed' ||
          status.status === 'rejected' ||
          status.status === 'expired';
        if (isVaultLocked(asset) && !terminalBad && status.status !== 'confirmed') {
          // A still-time-locked vault does NOT dispense now: the service queues
          // it for automatic delivery to the destination at unlock. Show the
          // calm locked-vault outcome immediately (the client already knows the
          // unlock time from vaultEndTimestamp — no need to wait on the worker).
          // Still poll as a backstop so that, in the edge case where the service
          // settles it liquid instead, the badge flips to Confirmed.
          const message = lockedVaultMessage(asset, claimantTrim);
          setResults((prev) => ({
            ...prev,
            [asset.assetKey]: { phase: 'review', locked: true, message },
          }));
          pollToConfirmation(asset.assetKey, status.claimId, message);
        } else if (status.status === 'confirmed' || status.status === 'verified' || status.status === 'dispatching') {
          const settling = status.status !== 'confirmed';
          setResults((prev) => ({
            ...prev,
            [asset.assetKey]: {
              phase: 'success',
              tx,
              message: settling ? 'Settling…' : undefined,
            },
          }));
          // Not yet confirmed on-chain — keep polling in the background so the
          // badge updates to Confirmed (+ View) without a manual refresh.
          if (settling) pollToConfirmation(asset.assetKey, status.claimId);
        } else if (status.status === 'pending_review') {
          setResults((prev) => ({
            ...prev,
            [asset.assetKey]: { phase: 'review', message: 'Submitted for review.' },
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
  }, [identity, isValidClaimant, selected, claimant, network, ethereumProvider, cancelAllPolls, pollToConfirmation]);

  // -------------------------------------------------------------------
  // Render
  // -------------------------------------------------------------------
  const hasWallet = !!connectedProtocol;
  const successCount = Object.values(results).filter(
    (r) => r.phase === 'success' || r.phase === 'review',
  ).length;
  // Live per-run progress over the SELECTED batch, surfaced directly in Step 3.
  // "Confirmed" = fully settled on-chain (success, not the interim "Settling…")
  // or a delivered/queued review outcome; "settling" = success awaiting on-chain
  // confirmation (still polling in the background).
  const confirmedCount = selected.filter((a) => {
    const r = results[a.assetKey];
    return !!r && ((r.phase === 'success' && r.message !== 'Settling…') || r.phase === 'review');
  }).length;
  const settlingCount = selected.filter((a) => {
    const r = results[a.assetKey];
    return !!r && r.phase === 'success' && r.message === 'Settling…';
  }).length;
  const allClaimed =
    selected.length > 0 &&
    selected.every(
      (a) => results[a.assetKey]?.phase === 'success' || results[a.assetKey]?.phase === 'review',
    );
  const canClaim = !!identity && isValidClaimant && selected.length > 0 && !running;

  // Disconnect the current recipient wallet and reset the flow back to Step 1 so
  // discovery re-runs for a different wallet. Clearing the identity addresses
  // trips the reset effect above, which clears discovered assets + identity.
  const claimWithAnotherWallet = useCallback(() => {
    cancelAllPolls();
    setArweaveAddress(undefined);
    setEthereumAddress(undefined);
    setEthereumProvider(undefined);
    setResults({});
    setSelectedIds(new Set());
    setManualAsset(null);
    setAssetKeyInput('');
    seenIds.current = new Set();
    window.scrollTo({ top: 0, behavior: 'smooth' });
  }, [cancelAllPolls]);

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
                {availableItems.length} claimable asset{availableItems.length === 1 ? '' : 's'}
                {claimedItems.length > 0 && (
                  <span style={styles.claimedCount}>
                    {' · '}
                    {claimedItems.length} already claimed
                  </span>
                )}
              </span>
              {availableItems.length > 1 && (
                <button type="button" className="btn-text" onClick={toggleSelectAll}>
                  {allSelected ? 'Deselect all' : 'Select all'}
                </button>
              )}
            </div>
            {items.map((a) => {
              const result = results[a.assetKey];
              const claimed = a.status === 'claimed';
              return (
                <label
                  key={a.assetKey}
                  style={{
                    ...styles.itemCard,
                    ...(claimed ? styles.itemCardClaimed : null),
                    cursor: claimed ? 'default' : !running ? 'pointer' : 'default',
                  }}
                >
                  <input
                    type="checkbox"
                    checked={!claimed && selectedIds.has(a.assetKey)}
                    disabled={running || claimed}
                    onChange={() => toggleSelected(a.assetKey)}
                    style={styles.checkbox}
                    aria-label={claimed ? 'Already claimed' : 'Select to claim'}
                  />
                  <div style={{ ...styles.itemBody, ...(claimed ? styles.itemBodyClaimed : null) }}>
                    <span style={styles.itemTitle}>{assetLabel(a)}</span>
                    <code style={styles.itemSub}>
                      {assetKindLabel(a)}
                      {' · '}
                      {a.assetKey.slice(0, 10)}…{a.assetKey.slice(-4)}
                    </code>
                    {!claimed && isVaultLocked(a) && (
                      <span style={{ ...styles.badge, ...styles.badgeLocked }}>
                        🔒 Locked until {formatUnlockDate(vaultUnlockMs(a)!)}
                      </span>
                    )}
                    {claimed ? (
                      <ClaimedBadge tx={a.claimTx} />
                    ) : (
                      result && <ResultBadge result={result} />
                    )}
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
        <p style={{ ...styles.hint, marginTop: 0, marginBottom: '12px' }}>
          This destination is independent of the wallet you prove ownership with —
          you can reuse the same Solana address across your Arweave and Ethereum
          claims.
        </p>
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
          <>
            <p style={styles.successHint}>
              All {selected.length} claimed 🎉
            </p>
            {settlingCount > 0 && (
              <p style={styles.hint}>
                Finishing on-chain settlement for {settlingCount} — your assets are on
                their way.
              </p>
            )}
            <button
              type="button"
              className="btn-secondary"
              style={styles.anotherWallet}
              onClick={claimWithAnotherWallet}
            >
              Claim with another wallet
            </button>
          </>
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
              {running ? (
                <span style={styles.btnBusy}>
                  <Spinner onPrimary /> Claiming…
                </span>
              ) : (
                `Claim ${selected.length} asset${selected.length === 1 ? '' : 's'}`
              )}
            </button>
            {(confirmedCount > 0 || settlingCount > 0) && (
              <p style={styles.successHint}>
                {confirmedCount} of {selected.length} confirmed
                {settlingCount > 0 ? ' — settling the rest…' : ''}
              </p>
            )}
          </>
        )}
      </StepCard>
    </div>
  );
}

// ---------------------------------------------------------------------------

/** Static "Claimed ✓" badge for an already-claimed asset (history), with a tx link. */
function ClaimedBadge({ tx }: { tx: string | null }) {
  return (
    <span style={{ ...styles.badge, ...styles.badgeSuccess }}>
      ✓ Claimed
      {tx && (
        <a
          href={explorerTxUrl(tx)}
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

/** Subtle inline loading spinner (bordered circle in brand.primary). */
function Spinner({ onPrimary }: { onPrimary?: boolean }) {
  return (
    <span
      className={onPrimary ? 'spinner spinner-on-primary' : 'spinner'}
      aria-hidden="true"
    />
  );
}

function ResultBadge({ result }: { result: ItemResult }) {
  if (result.phase === 'success') {
    // A settled-but-not-yet-confirmed claim ("Settling…") is still in flight —
    // render it as a pending state with a spinner rather than a green ✓.
    const settling = result.message === 'Settling…';
    if (settling) {
      return (
        <span style={{ ...styles.badge, ...styles.badgePending }}>
          <Spinner /> {result.message}
        </span>
      );
    }
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
    // A still-time-locked vault is a calm, expected outcome (not an error and
    // not "under review") — render it as a lock note that wraps to full width.
    if (result.locked) {
      return (
        <span style={{ ...styles.badge, ...styles.badgeLocked, ...styles.badgeBlock }}>
          🔒 {result.message}
        </span>
      );
    }
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
  return (
    <span style={{ ...styles.badge, ...styles.badgePending }}>
      <Spinner /> {label}
    </span>
  );
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
  // Claimed history rows read as done: muted surface, no elevation.
  itemCardClaimed: {
    background: brand.cardSurface,
    boxShadow: 'none',
  },
  itemBodyClaimed: { opacity: 0.7 },
  claimedCount: { color: brand.textTertiary, fontWeight: 600 },
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
  // Time-locked vault: calm amber note (distinct from success green / error red).
  badgeLocked: { background: brand.warningBg, color: brand.warning },
  // Let a longer locked-vault result sentence wrap to the card width.
  badgeBlock: {
    display: 'flex',
    whiteSpace: 'normal' as const,
    maxWidth: '100%',
    lineHeight: 1.5,
    textAlign: 'left' as const,
  },
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
    marginTop: '20px',
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
  btnBusy: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '9px',
  },
  anotherWallet: {
    marginTop: '16px',
    alignSelf: 'flex-start',
  },
};
