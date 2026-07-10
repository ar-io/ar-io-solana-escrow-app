import React, { useEffect, useState } from 'react';
import { brand } from '../brand.js';
import { getNetwork } from '../services/solana.ts';
import {
  getClaimsApiUrl,
  getClaimsHealth,
  type ClaimsHealth,
} from '../services/claims-api.ts';

type Status = 'checking' | 'ok' | 'mismatch' | 'unreachable' | 'no-config';

interface State {
  status: Status;
  detail: string;
  expected: string;
  actual?: string;
}

/**
 * Top-of-page strip that surfaces claims-service configuration problems
 * before the user reaches the claim flow (repurposed from the on-chain
 * attestor-health banner). Three cases worth surfacing globally:
 *
 * - VITE_CLAIMS_API_URL is unset (every lookup/claim will fail).
 * - The claims service `/health` reports a different `network` than the
 *   page expects (claims would be built against the wrong deployment).
 * - The claims service is unreachable / returns 5xx.
 *
 * Renders nothing in the success path. Single-shot per page load.
 */
export function AttestorHealthBanner() {
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const url = getClaimsApiUrl();
      const expectedNetwork = getNetwork();

      if (!url) {
        if (!cancelled) {
          setState({
            status: 'no-config',
            detail:
              'The claims service is not configured. Set VITE_CLAIMS_API_URL in the environment and reload.',
            expected: expectedNetwork,
          });
        }
        return;
      }

      try {
        const health: ClaimsHealth = await getClaimsHealth();
        if (cancelled) return;
        if (!health.ok) {
          setState({
            status: 'unreachable',
            detail: 'The claims service reported a non-OK status.',
            expected: expectedNetwork,
            actual: health.network,
          });
          return;
        }
        // Only flag a genuine cross-cluster mismatch; a localnet claims
        // service (network "localnet") against a devnet page is fine for dev.
        if (
          health.network &&
          (health.network === 'solana-mainnet' ||
            health.network === 'solana-devnet') &&
          health.network !== expectedNetwork
        ) {
          setState({
            status: 'mismatch',
            detail:
              'The claims service and the page disagree on which Solana network they are bound to. Use a matching claims deployment before issuing a claim.',
            expected: expectedNetwork,
            actual: health.network,
          });
          return;
        }
        setState({
          status: 'ok',
          detail: '',
          expected: expectedNetwork,
          actual: health.network,
        });
      } catch (e) {
        if (cancelled) return;
        setState({
          status: 'unreachable',
          detail: e instanceof Error ? e.message : String(e),
          expected: expectedNetwork,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  if (!state || state.status === 'ok' || state.status === 'checking') {
    return null;
  }

  const isError =
    state.status === 'mismatch' || state.status === 'unreachable';

  return (
    <div
      role="alert"
      style={{
        ...styles.banner,
        background: isError ? brand.errorBg : brand.warningBg,
        borderBottom: `1px solid ${isError ? brand.error : brand.warning}33`,
        color: isError ? brand.error : brand.warning,
      }}
    >
      <strong style={styles.label}>
        {state.status === 'mismatch'
          ? 'Claims service / network mismatch'
          : state.status === 'unreachable'
            ? 'Claims service unreachable'
            : 'Claims service not configured'}
      </strong>
      <span style={styles.detail}>{state.detail}</span>
      {(state.actual || state.expected) && (
        <span style={styles.tag}>
          page: {state.expected}
          {state.actual ? ` · claims: ${state.actual}` : ''}
        </span>
      )}
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
  },
  label: {
    fontWeight: 700,
    letterSpacing: '0.2px',
  },
  detail: {
    flex: '1 1 360px',
    lineHeight: 1.5,
  },
  tag: {
    fontFamily: 'monospace',
    fontSize: '12px',
    background: 'rgba(35, 35, 45, 0.06)',
    padding: '2px 8px',
    borderRadius: '6px',
    color: 'rgba(35, 35, 45, 0.75)',
  },
};
