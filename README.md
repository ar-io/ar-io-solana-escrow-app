# `solana-escrow-app`

Web UI for the AR.IO `ario-ant-escrow` program — trustless multi-protocol
escrow for ANTs, ARIO tokens, and time-locked vaults (Arweave RSA-PSS-4096
/ Ethereum ECDSA secp256k1).

**Forked from** the [AR.IO Solana registration app](https://github.com/ar-io/ar-io-solana-registration-app).
Same wallet plumbing (Phantom, Solflare, Wander, MetaMask,
WalletConnect), Vite build, and visual identity. The migration
registration app sunsets after cutover; this fork repurposes that
codebase as the long-lived multi-protocol ANT-escrow UI.

## Pages

```
/#/                    Landing — explainer + links to flows
/#/deposit             Deposit ANT into escrow
/#/deposit-tokens      Deposit liquid ARIO tokens into escrow
/#/deposit-vault       Deposit a time-locked vault into escrow
/#/claim?ant=…         Recipient flow (verify + sign + claim ANT/tokens/vault)
/#/manage?ant=…        Depositor management (update_recipient + cancel)
/#/lookup?ant=…        Read-only escrow inspector (no wallet needed)
```

The shell, routing, wallet adapters, and signing components are all in
place. The on-chain submit handlers are stubbed ("devnet wiring
pending") until the program ships to devnet (Phase 8 of
`docs/ANT_ESCROW_IMPLEMENTATION_PLAN.md`).

## Dev

```bash
yarn install
yarn dev      # vite, port 5173
yarn build    # tsc + vite build → dist/
```

`yarn dev` reads the RPC URL from `VITE_SOLANA_RPC_URL` (defaults to
mainnet-beta). Point at devnet for testing:

```bash
VITE_SOLANA_RPC_URL=https://api.devnet.solana.com yarn dev
```

### Attestor URL (Arweave claims)

Arweave-recipient claim flows POST the user's RSA-PSS signature to the
off-chain AR.IO attestor service, which re-signs the canonical claim
message with Ed25519. The on-chain program then verifies the cheap
Ed25519 signature via Solana's native sigverify program. Without an
attestor URL, Arweave claims fail at submit time with a clear error.
Ethereum claims do not require the attestor (they verify directly
on-chain via `secp256k1_recover`).

```bash
VITE_ATTESTOR_URL=http://localhost:3030 yarn dev
```

The page calls the attestor's `/health` once before issuing an
attestation and refuses to proceed if `health.network` doesn't match
the network the page was loaded with. See
`migration/attestor/README.md` for the service contract and
`docs/DECISIONS.md` ADR-017 for the architecture rationale.

## Token and Vault Flows

The Deposit Tokens page transfers liquid ARIO tokens from the depositor's
wallet into an escrow-owned token account. The Deposit Vault page escrows a
time-locked vault position from `ario-core` (non-revocable; the importer
rejects revocable deposits — see ADR-021 / BD-105).

**Vault claim behavior:** vaults are claimable **only after their on-chain
`vault_end_timestamp`**, at which point the escrow delivers liquid ARIO
directly to the claimant's ATA. A claim attempted while the vault is still
locked is rejected on-chain with `EscrowError::VaultStillLocked`; the SDK's
`claimVault*` methods pre-flight the same gate and throw a clear
"locked until `<unlock-time>`" error before building the tx. The Claim page
disables the Submit button while the vault is locked and surfaces the
unlock time so the user knows exactly when to return.

The former "claim early, stay locked" re-lock path (a sibling
`ario_core::vaulted_transfer` introspected by the escrow program) was
removed because its introspection had no 1:1 binding between a claim and
the re-lock it credited (lock-bypass / relayer-skim vector; Codex
finding). The contracts repo ships a restoration playbook
([`docs/RESTORE_ACTIVE_VAULT_RELOCK.md`](https://github.com/ar-io/ar-io-solana-contracts/blob/develop/docs/RESTORE_ACTIVE_VAULT_RELOCK.md))
with the direct-CPI design to revive the feature safely if ever needed.
See **ADR-022** / **BD-107** in the contracts repo.

## Components inherited from the registration app

These already do exactly what the escrow app needs — zero changes:

| Component | What it gives us |
|-----------|------------------|
| `SolanaWalletConnect`  | Phantom / Solflare / Wander connect; depositor + claimant tx submission |
| `ArweaveWalletConnect` | Wander / ArConnect; Arweave-recipient claim signing |
| `EthereumWalletConnect`| MetaMask / WalletConnect; Ethereum-recipient claim signing |
| `SourceAddressSigner`  | Multi-protocol signing dispatcher (abstracts per-wallet APIs) |
| `SourceWalletConnect`  | Wallet selection UI |
| `WalletIcons`          | Branding |

## What was stripped

- `useTurboAttestation`, `useAttestationStatus`, `useAOAssetLookup` — Turbo bundler integration is registration-specific.
- `RegistrationProgress`, `ExistingRegistrationCheck`, `CountdownTimer` — registration-window UX.
- `ao-asset-lookup.ts` — AO process lookups (the escrow app reads only Solana state).
- `RegisterPage`, `StatusPage` — replaced by `Deposit / Deposit Tokens / Deposit Vault / Claim / Manage / Lookup`.

## Wiring the SDK call paths (Phase 8 follow-up)

Each page has a stubbed submit button labelled "(devnet wiring pending)".
To wire it up against a deployed devnet program:

1. Bump the `@ar.io/sdk` dep to the version that exports `ANTEscrow`
   from `@ar.io/sdk/solana` (it ships in the same PR as the program).
2. Per page, instantiate the client:
   ```ts
   import { ANTEscrow } from '@ar.io/sdk/solana';
   const escrow = ANTEscrow.init({ rpc, rpcSubscriptions, signer });
   ```
3. Replace the stub `<button disabled>` with the real call:
   ```ts
   await escrow.deposit({
     antMint,
     recipient: { protocol, publicKey },
   });
   ```
4. For the claim page, fetch escrow state first to drive the signing flow:
   ```ts
   const state = await escrow.get(antMint);
   const message = canonicalMessage({
     network: 'solana-mainnet',
     antMint,
     claimant,
     nonce: state.nonce,
   });
   const signature = state.recipientProtocol === 'arweave'
     ? await arweaveWallet.signMessage(message)
     : await ethereumWallet.signMessage(message);
   await escrow.claimArweave({ antMint, claimant, signature, saltLen: 32 });
   ```

## Stack

- React 18 + TypeScript + Vite (same as `solana-registration-app`)
- `@ar.io/sdk` — escrow client + canonical-message helper
- `@solana/kit` — tx pipeline
- `@solana/wallet-adapter-*` — Solana wallet connection
- `arweave-wallet-kit` (via `SourceWalletConnect`) — Arweave wallet
- `ethers` — Ethereum signing & address derivation

License: AGPL-3.0-or-later (matches the rest of the repo).
