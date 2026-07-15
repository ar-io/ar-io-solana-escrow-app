import React from 'react';
import { FileSignature, ShieldCheck } from 'lucide-react';
import { brand } from '../brand.js';

/** Public landing page — explains the claim flow and routes to it. */
export function LandingPage() {
  return (
    <div style={styles.wrap}>
      <h1 className="page-title" style={styles.h1}>ar.io Claims</h1>

      <section style={styles.claimHero}>
        <div style={styles.claimHeroHead}>
          <div style={styles.claimHeroIcon}>
            <FileSignature size={22} />
          </div>
          <h2 style={styles.claimHeroTitle}>Claim your assets</h2>
        </div>
        <p style={styles.claimHeroDesc}>
          ANTs or ARIO tokens were set aside for you? Connect your Arweave or
          Ethereum wallet, sign once to prove ownership, and the assets land in
          the Solana wallet you choose.
        </p>
        <a href="#/claim" className="btn-primary" style={styles.claimHeroCta}>
          Claim Assets →
        </a>
      </section>

      <p style={styles.lede}>
        A simple, guided claim for ar.io Name Tokens (ANTs), ARIO tokens, and
        time-locked vaults addressed to an Arweave or Ethereum identity. You
        prove ownership with a single wallet signature — no Solana gas, no
        transaction to assemble, no prior Solana wallet required.
      </p>

      <div style={styles.trustNote}>
        <div style={styles.trustHead}>
          <div style={styles.trustIcon}>
            <ShieldCheck size={18} />
          </div>
          <h3 style={styles.trustTitle}>How your signature protects you</h3>
        </div>
        <p style={styles.trustText}>
          The claim service hands your wallet a message that names the exact
          asset and the Solana destination you entered. Before you sign, this app
          independently rebuilds that message from what's on your screen and your
          own wallet identity, and refuses to sign if a single byte differs — so
          no one can redirect your assets to another wallet. Your destination is
          bound into the signature itself.
        </p>
      </div>
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
  trustNote: {
    padding: '24px',
    background: `radial-gradient(ellipse 140% 120% at top left, rgba(84, 39, 200, 0.03), transparent), rgba(255, 255, 255, 0.85)`,
    backdropFilter: 'blur(8px)',
    WebkitBackdropFilter: 'blur(8px)',
    borderRadius: '16px',
    border: `1px solid ${brand.border}`,
    boxShadow: '0 1px 3px rgba(35, 35, 45, 0.04)',
  },
  trustHead: {
    display: 'flex',
    alignItems: 'center',
    gap: '12px',
    marginBottom: '10px',
  },
  trustIcon: {
    display: 'inline-flex',
    alignItems: 'center',
    justifyContent: 'center',
    width: '34px',
    height: '34px',
    borderRadius: '10px',
    background: 'rgba(84, 39, 200, 0.08)',
    color: brand.primary,
    flexShrink: 0,
  },
  trustTitle: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 700,
    color: brand.black,
    margin: 0,
  },
  trustText: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '14px',
    lineHeight: 1.7,
    color: brand.textSecondary,
    margin: 0,
  },
};
