import React, { useEffect, useState } from 'react';
import { brand } from '../brand.js';
import { getNetwork } from '../services/solana.ts';
import { getClaimsApiUrl, getClaimsHealth } from '../services/claims-api.ts';

type Status = 'checking' | 'ok' | 'mismatch' | 'unreachable' | 'no-config';

interface State {
  status: Status;
  detail: string;
  expected: string;
  actual?: string;
}

/**
 * Top-of-page strip that surfaces claims-service problems before the user
 * reaches the claim flow. The claims API is the ONLY backend — if it is unset
 * or unreachable, nothing can be looked up or claimed, so we say so up front
 * rather than failing late. A network mismatch (the service bound to a
 * different Solana network than the page) is also surfaced, because the client
 * pins its own network when verifying the canonical and would refuse to sign.
 *
 * Renders nothing in the success path. Single-shot per page load.
 */
export function ClaimsHealthBanner() {
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const expectedNetwork = getNetwork();
      if (!getClaimsApiUrl()) {
        if (!cancelled) {
          setState({
            status: 'no-config',
            detail:
              'The claims service is not configured. Set VITE_CLAIMS_API_URL (or the Claims API URL in the menu) and reload.',
            expected: expectedNetwork,
          });
        }
        return;
      }
      try {
        const health = await getClaimsHealth();
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
        if (health.network && health.network !== expectedNetwork) {
          setState({
            status: 'mismatch',
            detail:
              'The claims service and this page disagree on which Solana network they are bound to. Claims would fail canonical verification. Point them at the same network before claiming.',
            expected: expectedNetwork,
            actual: health.network,
          });
          return;
        }
        setState({ status: 'ok', detail: '', expected: expectedNetwork, actual: health.network });
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

  if (!state || state.status === 'ok' || state.status === 'checking') return null;

  const isError = state.status === 'mismatch' || state.status === 'unreachable';

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
          ? 'Claims service / page network mismatch'
          : state.status === 'unreachable'
            ? 'Claims service unreachable'
            : 'Claims service not configured'}
      </strong>
      <span style={styles.detail}>{state.detail}</span>
      {(state.actual || state.expected) && (
        <span style={styles.tag}>
          page: {state.expected}
          {state.actual ? ` · service: ${state.actual}` : ''}
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
  label: { fontWeight: 700, letterSpacing: '0.2px' },
  detail: { flex: '1 1 360px', lineHeight: 1.5 },
  tag: {
    fontFamily: 'monospace',
    fontSize: '12px',
    background: 'rgba(35, 35, 45, 0.06)',
    padding: '2px 8px',
    borderRadius: '6px',
    color: 'rgba(35, 35, 45, 0.75)',
  },
};
