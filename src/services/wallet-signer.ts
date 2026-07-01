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
  type Address,
  type Transaction,
  type TransactionModifyingSigner,
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
 * Build a kit `TransactionModifyingSigner` from a connected wallet-adapter
 * adapter. Throws a clear error if the wallet can't sign raw transactions
 * via the Wallet Standard (e.g. a legacy, non-standard adapter).
 *
 * This MUST be a *modifying* signer, not a partial one: some wallets rewrite
 * the transaction before signing (Phantom's Lighthouse guard appends
 * assertion instructions), so the returned signature is valid only for the
 * wallet's modified bytes. A partial signer that grafted that signature onto
 * our original message would fail preflight with `SignatureFailure`. We
 * therefore return the wallet's full signed transaction verbatim.
 */
export function createWalletSigner(
  adapter: unknown,
  chain?: SolanaChain,
): TransactionModifyingSigner {
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

  const signer = {
    address: signerAddress,
    async modifyAndSignTransactions(
      transactions: readonly Transaction[],
    ): Promise<readonly Transaction[]> {
      const out: Transaction[] = [];
      for (const tx of transactions) {
        const wireBytes = new Uint8Array(txEncoder.encode(tx));
        const [{ signedTransaction }] = await feature.signTransaction({
          account,
          transaction: wireBytes,
          ...(chain ? { chain } : {}),
        });

        // Return the wallet's full signed transaction — it may differ from
        // what we sent (e.g. Lighthouse guard instructions). Decoding and
        // re-emitting the kit Transaction preserves those modifications so
        // the submitted bytes match the signature.
        const decoded = txDecoder.decode(signedTransaction);
        const sig = decoded.signatures[signerAddress];
        if (!sig || sig.every((b) => b === 0)) {
          throw new Error('Wallet did not return a signature for this transaction.');
        }
        // Wire decoding drops kit's `lifetimeConstraint` annotation, but the
        // blockhash-confirmation strategy (both our sendInstructions and the
        // SDK's sendAndConfirm) reads `lifetimeConstraint.lastValidBlockHeight`
        // post-send. Copy it from the input tx (the wallet preserves our
        // blockhash; it only adds instructions) so confirmation doesn't throw
        // on `undefined` after the tx has already landed.
        const lifetimeConstraint = (
          tx as { lifetimeConstraint?: unknown }
        ).lifetimeConstraint;
        out.push(
          lifetimeConstraint
            ? ({ ...decoded, lifetimeConstraint } as Transaction)
            : decoded,
        );
      }
      return out;
    },
  };

  // kit brands modifying-signer output with compile-time `TransactionWithin
  // SizeLimit`/`TransactionWithLifetime` markers that a freshly decoded
  // transaction can't carry; they're runtime no-ops, so cast through unknown.
  return signer as unknown as TransactionModifyingSigner;
}
