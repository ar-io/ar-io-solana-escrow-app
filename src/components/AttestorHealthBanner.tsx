import React, { useEffect, useState } from 'react';
import { useConnection } from '@solana/wallet-adapter-react';
import { brand } from '../brand.js';
import {
  AttestorClient,
  type AttestorHealth,
} from '../services/attestor-client.ts';

type Status = 'checking' | 'ok' | 'mismatch' | 'unreachable' | 'no-config';

interface State {
  status: Status;
  detail: string;
  expected: string;
  actual?: string;
}

/**
 * Top-of-page strip that surfaces attestor configuration problems
 * before the user reaches the claim flow. Three cases worth
 * surfacing globally (the claim flow itself does the same checks
 * just-in-time, but failing late after the user has signed wastes
 * everyone's time):
 *
 * - VITE_ATTESTOR_URL is unset and the page is loaded against a
 *   public cluster (Arweave claims will fail at submit).
 * - Attestor `/health` reports a different `network` than the
 *   currently selected RPC (would silently fail on-chain Ed25519
 *   introspection — explicit mismatch error is much friendlier).
 * - Attestor is unreachable / returns 5xx.
 *
 * Renders nothing in the success path. Single-shot per page load.
 */
export function AttestorHealthBanner() {
  const { connection } = useConnection();
  const [state, setState] = useState<State | null>(null);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      const url = import.meta.env.VITE_ATTESTOR_URL as string | undefined;
      const expectedNetwork = inferNetworkFromRpc(connection?.rpcEndpoint);

      if (!url) {
        // Localnet doesn't strictly need an attestor (devs may be
        // running the on-chain RSA path under solana-program-test);
        // only flag the missing config on real clusters.
        if (
          expectedNetwork === 'solana-mainnet' ||
          expectedNetwork === 'solana-devnet'
        ) {
          if (!cancelled) {
            setState({
              status: 'no-config',
              detail:
                'Arweave claims require an attestor service. Set VITE_ATTESTOR_URL in the environment and reload.',
              expected: expectedNetwork,
            });
          }
        }
        return;
      }

      try {
        const client = new AttestorClient({ url });
        const health: AttestorHealth = await client.health();
        if (cancelled) return;
        if (!health.ok) {
          setState({
            status: 'unreachable',
            detail: 'Attestor reported a non-OK status.',
            expected: expectedNetwork,
            actual: health.network,
          });
          return;
        }
        if (health.network !== expectedNetwork) {
          setState({
            status: 'mismatch',
            detail:
              'The attestor and the page disagree on which Solana network they are bound to. The on-chain Ed25519 verification would fail silently. Use a matching RPC or a matching attestor before issuing a claim.',
            expected: expectedNetwork,
            actual: health.network,
          });
          return;
        }
        // Healthy and matching — show nothing.
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
  }, [connection?.rpcEndpoint]);

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
          ? 'Attestor / RPC network mismatch'
          : state.status === 'unreachable'
            ? 'Attestor unreachable'
            : 'Attestor not configured'}
      </strong>
      <span style={styles.detail}>{state.detail}</span>
      {(state.actual || state.expected) && (
        <span style={styles.tag}>
          page: {state.expected}
          {state.actual ? ` · attestor: ${state.actual}` : ''}
        </span>
      )}
    </div>
  );
}

function inferNetworkFromRpc(endpoint?: string): string {
  if (!endpoint) return 'unknown';
  if (endpoint.includes('devnet')) return 'solana-devnet';
  if (endpoint.includes('localhost') || endpoint.includes('127.0.0.1')) {
    return 'localnet';
  }
  return 'solana-mainnet';
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
