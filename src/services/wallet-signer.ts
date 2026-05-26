/**
 * Bridge a `@solana/wallet-adapter` wallet into a `@solana/kit`
 * `TransactionSigner`, so the `@ar.io/sdk/solana` escrow clients (which
 * build + send transactions on kit) can be driven by the user's connected
 * Phantom / Solflare / Wander wallet.
 *
 * This is deliberately web3.js-free. Rather than convert kit transactions
 * to a web3.js `VersionedTransaction` and call the adapter's
 * `signTransaction` (the classic approach), we reach the wallet's
 * **Wallet Standard** `solana:signTransaction` feature, which signs raw
 * transaction bytes. `App.tsx` registers `wallets={[]}`, so every
 * connected wallet is an auto-detected Wallet Standard wallet and exposes
 * this feature.
 *
 * Flow per transaction:
 *   kit Transaction --encode--> wire bytes --wallet--> signed wire bytes
 *   --decode--> signatures dict --> kit SignatureDictionary
 */
import {
  address,
  getTransactionEncoder,
  getTransactionDecoder,
  signatureBytes,
  type Address,
  type SignatureDictionary,
  type Transaction,
  type TransactionPartialSigner,
} from '@solana/kit';

/** Wallet Standard chain identifier passed to the signing feature. */
export type SolanaChain = `solana:${string}`;

/**
 * Minimal shape of a wallet-adapter `Adapter` for a Wallet Standard
 * wallet. We only reach the bits we need; the wallet-adapter types keep
 * the standard internals loosely typed, hence the structural interface.
 */
interface StandardishAdapter {
  name?: string;
  standard?: boolean;
  publicKey?: { toBase58(): string } | null;
  // The underlying Wallet Standard wallet (present when `standard === true`).
  wallet?: {
    accounts: ReadonlyArray<{ address: string }>;
    features: Record<string, unknown>;
  };
}

const SIGN_TRANSACTION_FEATURE = 'solana:signTransaction';

type SignTransactionFeature = {
  signTransaction: (
    ...inputs: ReadonlyArray<{
      account: { address: string };
      transaction: Uint8Array;
      chain?: SolanaChain;
    }>
  ) => Promise<ReadonlyArray<{ signedTransaction: Uint8Array }>>;
};

/** True when the adapter is a Wallet Standard wallet exposing raw-bytes signing. */
export function canBridgeAdapter(adapter: unknown): boolean {
  const a = adapter as StandardishAdapter | null;
  return Boolean(
    a &&
      a.standard === true &&
      a.wallet &&
      a.wallet.features[SIGN_TRANSACTION_FEATURE],
  );
}

/**
 * Build a kit `TransactionPartialSigner` from a connected wallet-adapter
 * adapter. Throws a clear error if the wallet can't sign raw transactions
 * via the Wallet Standard (e.g. a legacy, non-standard adapter).
 */
export function createWalletSigner(
  adapter: unknown,
  chain?: SolanaChain,
): TransactionPartialSigner {
  const a = adapter as StandardishAdapter | null;

  if (!a?.publicKey) {
    throw new Error('Wallet is not connected.');
  }
  const pubkeyBase58 = a.publicKey.toBase58();

  if (!canBridgeAdapter(a)) {
    throw new Error(
      `Wallet "${a.name ?? 'unknown'}" does not support Wallet Standard ` +
        `transaction signing. Use a wallet like Phantom, Solflare, or Wander.`,
    );
  }

  const standardWallet = a.wallet!;
  const account = standardWallet.accounts.find(
    (acc) => acc.address === pubkeyBase58,
  );
  if (!account) {
    throw new Error(
      'Connected wallet account not found among Wallet Standard accounts.',
    );
  }

  const feature = standardWallet.features[
    SIGN_TRANSACTION_FEATURE
  ] as SignTransactionFeature;

  const signerAddress = address(pubkeyBase58) as Address;
  const txEncoder = getTransactionEncoder();
  const txDecoder = getTransactionDecoder();

  return {
    address: signerAddress,
    async signTransactions(
      transactions: readonly Transaction[],
    ): Promise<readonly SignatureDictionary[]> {
      const out: SignatureDictionary[] = [];
      for (const tx of transactions) {
        const wireBytes = new Uint8Array(txEncoder.encode(tx));
        const [{ signedTransaction }] = await feature.signTransaction({
          account,
          transaction: wireBytes,
          ...(chain ? { chain } : {}),
        });

        const decoded = txDecoder.decode(signedTransaction);
        const sig = decoded.signatures[signerAddress];
        if (!sig || sig.every((b) => b === 0)) {
          throw new Error('Wallet did not return a signature for this transaction.');
        }
        out.push(Object.freeze({ [signerAddress]: signatureBytes(sig) }));
      }
      return out;
    },
  };
}
