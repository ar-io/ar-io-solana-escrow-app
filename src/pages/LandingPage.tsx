import React from 'react';
import { brand } from '../brand.js';

/** Public landing page — explains what ANT escrow is and routes to flows. */
export function LandingPage() {
  return (
    <div style={styles.wrap}>
      <h1 style={styles.h1}>Trustless ANT escrow on Solana</h1>
      <p style={styles.lede}>
        Lock an Arweave Name Token in custody, addressed to an Arweave or
        Ethereum identity. The recipient claims the ANT by signing a short
        message — no off-chain authority, no oracle, no foundation
        signoff. The signature is verified entirely on-chain.
      </p>

      <div style={styles.grid}>
        <FlowCard
          title="Deposit an ANT"
          desc="Lock one of your ANTs into escrow, addressed to an Arweave or Ethereum recipient. Reversible until claimed."
          href="#/deposit"
          cta="Start a deposit"
        />
        <FlowCard
          title="Claim an ANT"
          desc="A depositor sent you an ANT? Connect your Arweave or Ethereum wallet, sign the canonical message, and the ANT lands in your Solana wallet."
          href="#/claim"
          cta="Claim →"
        />
        <FlowCard
          title="Manage your escrow"
          desc="Update the recipient on an active escrow, or cancel and pull the ANT back to your wallet."
          href="#/manage"
          cta="Manage →"
        />
        <FlowCard
          title="Lookup any escrow"
          desc="Read-only — no wallet required. Inspect the recipient identity, nonce, and timestamps for any ANT mint."
          href="#/lookup"
          cta="Lookup →"
        />
        <FlowCard
          title="Deposit ARIO Tokens"
          desc="Lock ARIO tokens into escrow for an Arweave or Ethereum recipient. They claim by signing a message."
          href="#/deposit-tokens"
          cta="Deposit tokens →"
        />
        <FlowCard
          title="Deposit Vaulted ARIO"
          desc="Lock ARIO into a time-locked vault escrow. The recipient receives a vault with the remaining lock duration."
          href="#/deposit-vault"
          cta="Deposit vault →"
        />
      </div>

      <div style={styles.trustNote}>
        <p style={styles.trustText}>
          All escrow operations are verified fully on-chain — no off-chain
          authority, no oracle. Your ANT stays in a program-controlled account
          until released by a valid signature from the designated recipient.
          The depositor can cancel or redirect the escrow at any time before
          a claim is submitted.
        </p>
      </div>

      <p style={styles.foot}>
        Spec: <a style={styles.link} href="https://github.com/ar-io/solana-ar-io/blob/main/docs/ANT_ESCROW_DESIGN.md">ANT_ESCROW_DESIGN.md</a> •{' '}
        Decision record: <a style={styles.link} href="https://github.com/ar-io/solana-ar-io/blob/main/docs/DECISIONS.md">ADR-014</a>
      </p>
    </div>
  );
}

function FlowCard({
  title,
  desc,
  href,
  cta,
}: {
  title: string;
  desc: string;
  href: string;
  cta: string;
}) {
  return (
    <a href={href} className="step-card" style={styles.card}>
      <h3 style={styles.cardTitle}>{title}</h3>
      <p style={styles.cardDesc}>{desc}</p>
      <span style={styles.cardCta}>{cta}</span>
    </a>
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
    maxWidth: '640px',
  },
  grid: {
    display: 'grid',
    gridTemplateColumns: 'repeat(auto-fit, minmax(280px, 1fr))',
    gap: '24px',
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
  cardTitle: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '18px',
    fontWeight: 700,
    color: brand.black,
    margin: '0 0 8px',
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
  foot: {
    fontSize: '13px',
    color: brand.textSecondary,
    fontFamily: "'Plus Jakarta Sans', sans-serif",
  },
  link: { color: brand.primary, textDecoration: 'none' },
};
