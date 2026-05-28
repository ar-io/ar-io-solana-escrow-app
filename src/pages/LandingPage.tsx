import React from 'react';
import {
  Lock,
  Coins,
  Vault,
  FileSignature,
  Settings,
  Search,
} from 'lucide-react';
import { brand } from '../brand.js';
import { areDepositsEnabled } from '../services/solana.ts';

/** Public landing page — explains what ANT escrow is and routes to flows. */
export function LandingPage() {
  const depositsOn = areDepositsEnabled();

  return (
    <div style={styles.wrap}>
      <h1 className="page-title" style={styles.h1}>ar.io Escrow</h1>
      <p style={styles.lede}>
        Trustless asset escrow on Solana. Lock Arweave Name Tokens, ARIO
        tokens, or time-locked vaults and address them to an Arweave or
        Ethereum recipient. Claims are authorized by a single signature —
        verified entirely on-chain. No off-chain authority, no oracle, no
        foundation signoff.
      </p>

      <div style={styles.grid}>
        <FlowCard
          icon={<Lock size={20} />}
          title="Deposit an ANT"
          desc="Lock one of your ANTs into escrow, addressed to an Arweave or Ethereum recipient. Reversible until claimed."
          href={depositsOn ? '#/deposit' : undefined}
          cta="Deposit ANT →"
          disabled={!depositsOn}
        />
        <FlowCard
          icon={<Coins size={20} />}
          title="Deposit ARIO Tokens"
          desc="Lock ARIO tokens into escrow for an Arweave or Ethereum recipient. They claim by signing a message."
          href={depositsOn ? '#/deposit-tokens' : undefined}
          cta="Deposit tokens →"
          disabled={!depositsOn}
        />
        <FlowCard
          icon={<Vault size={20} />}
          title="Deposit Vaulted ARIO"
          desc="Lock ARIO into a time-locked vault escrow. The recipient receives a vault with the remaining lock duration."
          href={depositsOn ? '#/deposit-vault' : undefined}
          cta="Deposit vault →"
          disabled={!depositsOn}
        />
        <FlowCard
          icon={<FileSignature size={20} />}
          title="Claim"
          desc="A depositor escrowed assets for you? Connect your Arweave or Ethereum wallet, sign the canonical message, and the assets land in your Solana wallet."
          href="#/claim"
          cta="Claim →"
        />
        <FlowCard
          icon={<Settings size={20} />}
          title="Manage"
          desc="Update the recipient on an active escrow, or cancel and pull the assets back to your wallet."
          href="#/manage"
          cta="Manage →"
        />
        <FlowCard
          icon={<Search size={20} />}
          title="Lookup"
          desc="Read-only — no wallet required. Inspect the recipient identity, nonce, and timestamps for any escrow."
          href="#/lookup"
          cta="Lookup →"
        />
      </div>

      {!depositsOn && (
        <p style={styles.depositNote}>
          Deposit flows are disabled by default. Enable them in the menu
          under <strong>Settings → Deposits</strong>.
        </p>
      )}

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

function FlowCard({
  icon,
  title,
  desc,
  href,
  cta,
  disabled,
}: {
  icon: React.ReactNode;
  title: string;
  desc: string;
  href?: string;
  cta: string;
  disabled?: boolean;
}) {
  const Tag = disabled ? 'div' : 'a';
  return (
    <Tag
      {...(disabled ? {} : { href })}
      className={disabled ? undefined : 'step-card'}
      style={{
        ...styles.card,
        ...(disabled ? styles.cardDisabled : {}),
      }}
    >
      <div style={styles.cardIcon}>{icon}</div>
      <h3 style={styles.cardTitle}>{title}</h3>
      <p style={styles.cardDesc}>{desc}</p>
      <span style={{
        ...styles.cardCta,
        ...(disabled ? { color: brand.textTertiary } : {}),
      }}>
        {disabled ? 'Disabled' : cta}
      </span>
    </Tag>
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
  cardDisabled: {
    opacity: 0.5,
    cursor: 'default',
    pointerEvents: 'none' as const,
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
    marginBottom: '14px',
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
  depositNote: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.textTertiary,
    margin: '-8px 0 0',
  },
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
