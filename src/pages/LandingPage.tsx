import React from 'react';
import { FileSignature, Compass } from 'lucide-react';
import { brand } from '../brand.js';
import { formatMarioToArio } from '../services/escrow-client.ts';
import { useEscrows, type EscrowStats } from '../context/EscrowsContext.tsx';

/** Public landing page — explains what ANT escrow is and routes to flows. */
export function LandingPage() {
  const { stats, loaded, configured } = useEscrows();

  return (
    <div style={styles.wrap}>
      <h1 className="page-title" style={styles.h1}>ar.io Escrow</h1>

      <section style={styles.claimHero}>
        <div style={styles.claimHeroHead}>
          <div style={styles.claimHeroIcon}>
            <FileSignature size={22} />
          </div>
          <h2 style={styles.claimHeroTitle}>Claim your assets</h2>
        </div>
        <p style={styles.claimHeroDesc}>
          Someone escrowed assets for you? Connect your Arweave or Ethereum
          wallet, sign to prove ownership, and the assets land in your Solana
          wallet.
        </p>
        <a href="#/claim" className="btn-primary" style={styles.claimHeroCta}>
          Claim Assets →
        </a>
      </section>

      <p style={styles.lede}>
        Trustless asset escrow on Solana. Lock ar.io Name Tokens (ANTs), ARIO
        tokens, or time-locked vaults and address them to an Arweave or
        Ethereum recipient. Claims are authorized by a single signature —
        verified entirely on-chain. No off-chain authority, no oracle, no
        foundation signoff.
      </p>

      <ExploreCard stats={stats} loaded={loaded} configured={configured} />

      <div style={styles.trustNote}>
        <p style={styles.trustText}>
          All escrow operations are verified fully on-chain — no off-chain
          authority, no oracle. Your assets stay in a program-controlled
          account until released by a valid signature from the designated
          recipient. The depositor can cancel or redirect the escrow at any
          time before a claim is submitted.
        </p>
      </div>

    </div>
  );
}

function ExploreCard({
  stats,
  loaded,
  configured,
}: {
  stats: EscrowStats;
  loaded: boolean;
  configured: boolean;
}) {
  return (
    <a href="#/explore" className="step-card" style={styles.card}>
      <div style={styles.cardHead}>
        <div style={styles.cardIcon}>
          <Compass size={20} />
        </div>
        <h3 style={styles.cardTitle}>Explore escrows</h3>
      </div>
      <p style={styles.cardDesc}>
        Browse every escrow on the program in one table. Search by identifier,
        depositor, or recipient.
      </p>
      {configured && (
        <div style={styles.cardStats}>
          <StatCell label="Escrows" value={loaded ? String(stats.total) : '—'} />
          <StatCell
            label="ARIO escrowed"
            value={loaded ? formatMarioToArio(stats.totalArioMario) : '—'}
          />
          <StatCell
            label="ArNS names escrowed"
            value={loaded ? String(stats.antCount) : '—'}
          />
        </div>
      )}
      <span style={styles.cardCta}>Explore →</span>
    </a>
  );
}

function StatCell({ label, value }: { label: string; value: string }) {
  return (
    <div style={styles.statCell}>
      <span style={styles.statValue}>{value}</span>
      <span style={styles.statLabel}>{label}</span>
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
  claimHero: {
    display: 'flex',
    flexDirection: 'column' as const,
    alignItems: 'flex-start',
    gap: '4px',
    padding: '40px',
    background: `radial-gradient(ellipse 120% 130% at top left, rgba(84, 39, 200, 0.11), transparent 60%), rgba(255, 255, 255, 0.9)`,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    border: `1px solid ${brand.border}`,
    borderRadius: '20px',
    boxShadow: '0 4px 24px rgba(84, 39, 200, 0.07)',
  },
  claimHeroHead: {
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
  },
  claimHeroIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '44px',
    height: '44px',
    borderRadius: '12px',
    background: 'rgba(84, 39, 200, 0.10)',
    color: brand.primary,
    flexShrink: 0,
  },
  claimHeroTitle: {
    fontFamily: "'Besley', Georgia, serif",
    fontSize: '30px',
    fontWeight: 700,
    color: brand.black,
    lineHeight: 1.15,
    margin: 0,
  },
  claimHeroDesc: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '16px',
    lineHeight: 1.6,
    color: brand.textSecondary,
    margin: '10px 0 22px',
    maxWidth: '620px',
  },
  claimHeroCta: {
    display: 'inline-flex',
    alignItems: 'center',
    gap: '8px',
    padding: '14px 28px',
    background: brand.primary,
    color: brand.white,
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 700,
    borderRadius: '16px',
    textDecoration: 'none',
    alignSelf: 'flex-end',
  },
  cardStats: {
    display: 'flex',
    gap: '24px',
    flexWrap: 'wrap' as const,
    margin: '4px 0 18px',
    paddingTop: '18px',
    borderTop: `1px solid ${brand.border}`,
  },
  statCell: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
    flex: '0 1 auto',
  },
  statValue: {
    fontFamily: "'Besley', Georgia, serif",
    fontSize: '26px',
    fontWeight: 700,
    color: brand.black,
    lineHeight: 1.1,
  },
  statLabel: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '11px',
    fontWeight: 600,
    color: brand.textTertiary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  card: {
    display: 'block',
    padding: '28px',
    background: `radial-gradient(ellipse 140% 120% at top left, rgba(84, 39, 200, 0.03), transparent), rgba(255, 255, 255, 0.85)`,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    border: `1px solid ${brand.border}`,
    borderRadius: '16px',
    textDecoration: 'none',
    color: 'inherit',
    transition: 'transform 0.2s ease-out, box-shadow 0.2s, border-color 0.2s',
    boxShadow: '0 1px 3px rgba(35, 35, 45, 0.04)',
  },
  cardHead: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '14px',
  },
  cardIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '36px',
    height: '36px',
    borderRadius: '10px',
    background: `rgba(84, 39, 200, 0.08)`,
    color: brand.primary,
    flexShrink: 0,
  },
  cardTitle: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '18px',
    fontWeight: 700,
    color: brand.black,
    margin: 0,
  },
  cardDesc: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '14px',
    lineHeight: 1.5,
    color: brand.textSecondary,
    margin: '0 0 16px',
  },
  cardCta: { color: brand.primary, fontWeight: 600, fontSize: '14px' },
  trustNote: {
    padding: '24px',
    background: `radial-gradient(ellipse 140% 120% at top left, rgba(84, 39, 200, 0.03), transparent), rgba(255, 255, 255, 0.85)`,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    borderRadius: '16px',
    border: `1px solid ${brand.border}`,
    boxShadow: '0 1px 3px rgba(35, 35, 45, 0.04)',
  },
  trustText: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '14px',
    lineHeight: 1.7,
    color: brand.textSecondary,
    margin: 0,
  },
};
