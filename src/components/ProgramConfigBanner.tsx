import React from 'react';
import { brand } from '../brand.js';
import { getEscrowProgramId } from '../services/solana.ts';

/**
 * Top-of-page strip shown when no escrow program ID is configured. The
 * SDK ships no escrow program id for any public cluster, so without one
 * every deposit/claim/manage action fails at submit. Surfacing it up
 * front (instead of failing late) tells the user to set the contract ID
 * in the footer. Read-only flows (lookup, ANT reads) still work.
 *
 * Renders nothing once a program id is set.
 */
export function ProgramConfigBanner() {
  if (getEscrowProgramId()) return null;

  return (
    <div role="alert" style={styles.banner}>
      <strong style={styles.label}>Escrow program not configured</strong>
      <span style={styles.detail}>
        Set the <em>escrow program ID</em> in the footer (or
        {' '}<code style={styles.code}>VITE_ESCROW_PROGRAM_ID</code>) to enable
        deposits, claims, and management. The SDK ships no escrow program for
        public clusters — point this at your deployment. Lookups still work.
      </span>
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  banner: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    padding: '10px 24px',
    display: 'flex',
    flexWrap: 'wrap',
    alignItems: 'center',
    gap: '12px',
    background: brand.warningBg,
    borderBottom: `1px solid ${brand.warning}33`,
    color: brand.warning,
  },
  label: { fontWeight: 700, letterSpacing: '0.2px' },
  detail: { opacity: 0.95 },
  code: {
    fontFamily: 'monospace',
    fontSize: '12px',
    background: 'rgba(0,0,0,0.05)',
    padding: '1px 5px',
    borderRadius: '4px',
  },
};
