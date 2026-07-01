import React, { useMemo, useState } from 'react';
import { Search, RefreshCw, Lock, Coins, Vault } from 'lucide-react';
import { brand } from '../brand.js';
import { formatMarioToArio } from '../services/escrow-client.ts';
import { useEscrows, type EscrowRow } from '../context/EscrowsContext.tsx';

/** Read-only explorer of every escrow on the program. Table + client-side
 *  search over the pre-synced set from EscrowsContext. */
export function ExplorePage() {
  const { rows, stats, loading, error, loaded, configured, refresh } = useEscrows();
  const [query, setQuery] = useState('');
  const [kindFilter, setKindFilter] = useState<'all' | 'ant' | 'token' | 'vault'>('all');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (kindFilter !== 'all' && r.kind !== kindFilter) return false;
      if (!q) return true;
      return (
        r.id.toLowerCase().includes(q) ||
        r.depositor.toLowerCase().includes(q) ||
        r.recipient.toLowerCase().includes(q) ||
        r.kind.includes(q) ||
        r.recipientProtocol.includes(q) ||
        (r.arnsName?.toLowerCase().includes(q) ?? false)
      );
    });
  }, [rows, query, kindFilter]);

  return (
    <div style={styles.wrap}>
      <h1 className="page-title" style={styles.h1}>Explore escrows</h1>
      <p style={styles.lede}>
        Every active escrow on the program — ar.io Name Tokens, ARIO tokens, and
        time-locked vaults. Search by identifier, depositor, or recipient.
      </p>

      {/* Stat strip */}
      <div style={styles.statStrip}>
        <Stat label="Total escrows" value={loaded ? String(stats.total) : '—'} />
        <Stat
          label="ARIO escrowed"
          value={loaded ? formatMarioToArio(stats.totalArioMario) : '—'}
        />
        <Stat label="ArNS names escrowed" value={loaded ? String(stats.antCount) : '—'} />
      </div>

      {/* Controls */}
      <div style={styles.controls}>
        <div style={styles.searchWrap}>
          <Search size={16} style={styles.searchIcon} />
          <input
            type="text"
            placeholder="Search identifier, depositor, or recipient…"
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            className="input"
            style={styles.search}
          />
        </div>
        <div style={styles.filterGroup}>
          {(['all', 'ant', 'token', 'vault'] as const).map((k) => (
            <button
              key={k}
              type="button"
              onClick={() => setKindFilter(k)}
              style={{
                ...styles.filterBtn,
                ...(kindFilter === k ? styles.filterBtnActive : {}),
              }}
            >
              {k === 'all' ? 'All' : k === 'ant' ? 'ANTs' : k === 'token' ? 'Tokens' : 'Vaults'}
            </button>
          ))}
        </div>
        <button
          type="button"
          onClick={refresh}
          disabled={loading || !configured}
          style={styles.refreshBtn}
          title="Re-sync from chain"
        >
          <RefreshCw size={15} style={loading ? styles.spinning : undefined} />
        </button>
      </div>

      {/* Body */}
      {!configured ? (
        <div style={styles.empty}>
          No escrow program configured. Set the program ID in the menu to explore
          escrows.
        </div>
      ) : error ? (
        <div style={styles.errorBox}>Could not load escrows: {error}</div>
      ) : loading && !loaded ? (
        <div style={styles.empty}>Syncing escrows from chain…</div>
      ) : filtered.length === 0 ? (
        <div style={styles.empty}>
          {rows.length === 0
            ? 'No escrows found on this program.'
            : 'No escrows match your search.'}
        </div>
      ) : (
        <div style={styles.tableWrap}>
          <table style={styles.table}>
            <thead>
              <tr>
                <th style={styles.th}>Type</th>
                <th style={styles.th}>Name / ID</th>
                <th style={styles.th}>Amount</th>
                <th style={styles.th}>Recipient</th>
                <th style={styles.th}>Depositor</th>
                <th style={styles.th} />
              </tr>
            </thead>
            <tbody>
              {filtered.map((r) => (
                <Row key={`${r.kind}:${r.id}`} row={r} />
              ))}
            </tbody>
          </table>
          <p style={styles.count}>
            Showing {filtered.length} of {rows.length} escrow
            {rows.length === 1 ? '' : 's'}
          </p>
        </div>
      )}
    </div>
  );
}

function Row({ row }: { row: EscrowRow }) {
  const icon =
    row.kind === 'ant' ? (
      <Lock size={14} />
    ) : row.kind === 'vault' ? (
      <Vault size={14} />
    ) : (
      <Coins size={14} />
    );
  const typeLabel = row.kind === 'ant' ? 'ANT' : row.kind === 'vault' ? 'Vault' : 'Token';
  return (
    <tr className="explore-row" style={styles.tr}>
      <td style={styles.td}>
        <span style={styles.typeBadge}>
          {icon} {typeLabel}
        </span>
      </td>
      <td style={styles.td}>
        {row.arnsName ? (
          <div style={styles.idCell}>
            <span style={styles.arnsName}>{row.arnsName}</span>
            <code style={styles.monoSub} title={row.id}>
              {row.id.slice(0, 8)}…{row.id.slice(-6)}
            </code>
          </div>
        ) : (
          <code style={styles.mono} title={row.id}>
            {row.id.slice(0, 10)}…{row.id.slice(-6)}
          </code>
        )}
      </td>
      <td style={styles.td}>
        {row.amountMario !== undefined ? (
          <span style={styles.amount}>{formatMarioToArio(row.amountMario)} ARIO</span>
        ) : (
          <span style={styles.muted}>—</span>
        )}
      </td>
      <td style={styles.td}>
        <div style={styles.recipientCell}>
          <span style={styles.protoTag}>
            {row.recipientProtocol === 'arweave' ? 'Arweave' : 'Ethereum'}
          </span>
          <code style={styles.mono} title={row.recipient}>
            {row.recipient.slice(0, 8)}…{row.recipient.slice(-6)}
          </code>
        </div>
      </td>
      <td style={styles.td}>
        <code style={styles.mono} title={row.depositor}>
          {row.depositor.slice(0, 6)}…{row.depositor.slice(-4)}
        </code>
      </td>
      <td style={{ ...styles.td, textAlign: 'right' as const }}>
        <a href={`#/lookup?ant=${row.id}`} style={styles.link}>
          Inspect →
        </a>
      </td>
    </tr>
  );
}

function Stat({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.stat}>
      <span style={styles.statValue}>{value}</span>
      <span style={styles.statLabel}>{label}</span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  wrap: { maxWidth: '1000px', width: '100%', display: 'flex', flexDirection: 'column', gap: '24px' },
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
  statStrip: { display: 'flex', gap: '16px', flexWrap: 'wrap' as const },
  stat: {
    flex: '1 1 180px',
    padding: '18px 20px',
    background: `radial-gradient(ellipse 140% 120% at top left, rgba(84, 39, 200, 0.04), transparent), rgba(255, 255, 255, 0.85)`,
    border: `1px solid ${brand.border}`,
    borderRadius: '16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '4px',
    boxShadow: '0 1px 3px rgba(35, 35, 45, 0.04)',
  },
  statValue: {
    fontFamily: "'Besley', Georgia, serif",
    fontSize: '26px',
    fontWeight: 700,
    color: brand.black,
  },
  statLabel: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '12px',
    fontWeight: 600,
    color: brand.textTertiary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  controls: { display: 'flex', gap: '12px', alignItems: 'center', flexWrap: 'wrap' as const },
  searchWrap: { position: 'relative' as const, flex: '1 1 280px' },
  searchIcon: {
    position: 'absolute' as const,
    left: '14px',
    top: '50%',
    transform: 'translateY(-50%)',
    color: brand.textTertiary,
    pointerEvents: 'none' as const,
  },
  search: { width: '100%', paddingLeft: '40px', fontFamily: "'Plus Jakarta Sans', sans-serif" },
  filterGroup: { display: 'flex', gap: '4px' },
  filterBtn: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    fontWeight: 600,
    padding: '8px 14px',
    border: `1px solid ${brand.border}`,
    borderRadius: '12px',
    background: brand.white,
    color: brand.textSecondary,
    cursor: 'pointer',
    transition: 'all 0.15s',
  },
  filterBtnActive: { background: brand.primary, color: brand.white, borderColor: brand.primary },
  refreshBtn: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    padding: '9px',
    border: `1px solid ${brand.border}`,
    borderRadius: '12px',
    background: brand.white,
    color: brand.textSecondary,
    cursor: 'pointer',
  },
  spinning: { animation: 'spin 1s linear infinite' },
  tableWrap: {
    background: 'rgba(255, 255, 255, 0.85)',
    border: `1px solid ${brand.border}`,
    borderRadius: '16px',
    overflow: 'hidden',
    boxShadow: '0 1px 3px rgba(35, 35, 45, 0.04)',
  },
  table: { width: '100%', borderCollapse: 'collapse' as const, fontFamily: "'Plus Jakarta Sans', sans-serif" },
  th: {
    textAlign: 'left' as const,
    fontSize: '11px',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
    color: brand.textTertiary,
    padding: '14px 16px',
    borderBottom: `1px solid ${brand.border}`,
    background: brand.cardSurface,
  },
  tr: { borderBottom: `1px solid ${brand.border}` },
  td: { padding: '14px 16px', fontSize: '13px', color: brand.black, verticalAlign: 'middle' as const },
  typeBadge: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
    fontSize: '12px',
    fontWeight: 700,
    color: brand.primary,
  },
  mono: { fontFamily: 'monospace', fontSize: '12px', color: brand.black },
  idCell: { display: 'flex', flexDirection: 'column' as const, gap: '2px' },
  arnsName: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '14px',
    fontWeight: 700,
    color: brand.black,
  },
  monoSub: { fontFamily: 'monospace', fontSize: '11px', color: brand.textTertiary },
  amount: { fontWeight: 700, color: brand.black },
  muted: { color: brand.textTertiary },
  recipientCell: { display: 'flex', flexDirection: 'column' as const, gap: '2px' },
  protoTag: {
    fontSize: '10px',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.4px',
    color: brand.textTertiary,
  },
  link: { color: brand.primary, textDecoration: 'none', fontWeight: 600, fontSize: '13px', whiteSpace: 'nowrap' as const },
  count: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '12px',
    color: brand.textTertiary,
    margin: 0,
    padding: '12px 16px',
    borderTop: `1px solid ${brand.border}`,
  },
  empty: {
    padding: '40px 24px',
    textAlign: 'center' as const,
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '14px',
    color: brand.textTertiary,
    background: 'rgba(255, 255, 255, 0.6)',
    border: `1px solid ${brand.border}`,
    borderRadius: '16px',
  },
  errorBox: {
    padding: '16px 20px',
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '14px',
    color: brand.error,
    background: brand.errorBg,
    border: `1px solid ${brand.error}33`,
    borderRadius: '16px',
  },
};
