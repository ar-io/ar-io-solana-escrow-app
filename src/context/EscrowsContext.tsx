import React, {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useState,
} from 'react';
import { SolanaARIOReadable } from '@ar.io/sdk/solana';
import {
  fetchAllEscrows,
  formatRecipient,
  type EscrowProtocol,
} from '../services/escrow-client.ts';
import {
  makeRpc,
  getEscrowProgramId,
  getSolanaProgramIds,
} from '../services/solana.ts';

/** One escrow, flattened for table display + client-side search. */
export interface EscrowRow {
  kind: 'ant' | 'token' | 'vault';
  /** The identifier a recipient claims with (ANT mint or escrow PDA). */
  id: string;
  depositor: string;
  recipientProtocol: EscrowProtocol;
  /** Canonical recipient identity — Arweave address or 0x ETH address. */
  recipient: string;
  /** mARIO amount, for token/vault escrows. */
  amountMario?: bigint;
  /** Unix seconds, for vault escrows. */
  vaultEndTimestamp?: bigint;
  /** For ANT escrows: the ArNS name whose record points at this ANT mint
   *  (resolved from the ArNS registry), if any. Populated asynchronously. */
  arnsName?: string;
}

export interface EscrowStats {
  total: number;
  /** ANT escrows == ArNS names escrowed. */
  antCount: number;
  tokenCount: number;
  vaultCount: number;
  /** Sum of all token + vault amounts, in mARIO. */
  totalArioMario: bigint;
}

interface EscrowsContextValue {
  rows: EscrowRow[];
  stats: EscrowStats;
  loading: boolean;
  error: string;
  /** True once at least one successful sync has completed. */
  loaded: boolean;
  /** False when no escrow program is configured (nothing to sync). */
  configured: boolean;
  refresh: () => void;
}

const EMPTY_STATS: EscrowStats = {
  total: 0,
  antCount: 0,
  tokenCount: 0,
  vaultCount: 0,
  totalArioMario: 0n,
};

const EscrowsContext = createContext<EscrowsContextValue | null>(null);

/**
 * Syncs every escrow on the configured program once on mount and exposes the
 * flattened rows + aggregate stats to any consumer (Explore table, home-page
 * stats). RPC/program-id changes trigger a full page reload elsewhere, so a
 * single fetch per mount is sufficient; `refresh()` re-syncs on demand.
 */
export function EscrowsProvider({ children }: { children: React.ReactNode }) {
  const [rows, setRows] = useState<EscrowRow[]>([]);
  const [loading, setLoading] = useState(false);
  const [loaded, setLoaded] = useState(false);
  const [error, setError] = useState('');

  const programId = getEscrowProgramId();
  const configured = !!programId;

  const load = useCallback(async () => {
    if (!programId) {
      setRows([]);
      setError('');
      return;
    }
    setLoading(true);
    setError('');
    try {
      const { rpc } = makeRpc();
      const { ants, tokens } = await fetchAllEscrows(rpc, programId);
      const next: EscrowRow[] = [
        ...ants.map(
          (e): EscrowRow => ({
            kind: 'ant',
            id: e.antMint,
            depositor: e.state.depositor,
            recipientProtocol: e.state.recipientProtocol,
            recipient: formatRecipient(
              e.state.recipientProtocol,
              e.state.recipientPubkey,
            ),
          }),
        ),
        ...tokens.map(
          (t): EscrowRow => ({
            kind: t.state.assetType === 'vault' ? 'vault' : 'token',
            id: t.escrowPda,
            depositor: t.state.depositor,
            recipientProtocol: t.state.recipientProtocol,
            recipient: formatRecipient(
              t.state.recipientProtocol,
              t.state.recipientPubkey,
            ),
            amountMario: t.state.amount,
            vaultEndTimestamp: t.state.vaultEndTimestamp,
          }),
        ),
      ];
      setRows(next);
      setLoaded(true);

      // Enrich ANT rows with their ArNS name (best-effort). We query the
      // ArNS registry for records whose `processId` (the ANT process) is one
      // of the escrowed ANT mints — a reverse lookup the SDK exposes directly.
      // Skipped silently if the cluster's program IDs are unknown (custom RPC)
      // or the ArNS program isn't reachable; the table just shows mints.
      const antMints = ants.map((a) => a.antMint);
      const ids = getSolanaProgramIds();
      if (antMints.length > 0 && ids) {
        try {
          const ario = new SolanaARIOReadable({
            rpc,
            coreProgramId: ids.core,
            garProgramId: ids.gar,
            arnsProgramId: ids.arns,
            antProgramId: ids.ant,
          });
          const records = await ario.getArNSRecordsByAntMints({ mints: antMints });
          const nameByMint = new Map<string, string>();
          for (const rec of records) {
            if (rec.processId) nameByMint.set(String(rec.processId), rec.name);
          }
          if (nameByMint.size > 0) {
            setRows((prev) =>
              prev.map((r) =>
                r.kind === 'ant' && nameByMint.has(r.id)
                  ? { ...r, arnsName: nameByMint.get(r.id) }
                  : r,
              ),
            );
          }
        } catch {
          /* ArNS enrichment is best-effort — leave mints unlabeled */
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, [programId]);

  useEffect(() => {
    load();
  }, [load]);

  const stats = useMemo<EscrowStats>(() => {
    let antCount = 0;
    let tokenCount = 0;
    let vaultCount = 0;
    let totalArioMario = 0n;
    for (const r of rows) {
      if (r.kind === 'ant') {
        antCount += 1;
      } else {
        if (r.kind === 'vault') vaultCount += 1;
        else tokenCount += 1;
        if (r.amountMario) totalArioMario += r.amountMario;
      }
    }
    return { total: rows.length, antCount, tokenCount, vaultCount, totalArioMario };
  }, [rows]);

  const value = useMemo<EscrowsContextValue>(
    () => ({ rows, stats, loading, error, loaded, configured, refresh: load }),
    [rows, stats, loading, error, loaded, configured, load],
  );

  return (
    <EscrowsContext.Provider value={value}>{children}</EscrowsContext.Provider>
  );
}

export function useEscrows(): EscrowsContextValue {
  const ctx = useContext(EscrowsContext);
  if (!ctx) throw new Error('useEscrows must be used within an EscrowsProvider');
  return ctx;
}

export { EMPTY_STATS };
