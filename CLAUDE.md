# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Commands

```bash
# Node >= 20.19 is required (a transitive dep, @noble/curves, enforces it).
# Use node 24 here. Install needs --ignore-engines to get past
# @permaweb/aoconnect's npm-only engine guard.
yarn install --ignore-engines
yarn dev      # vite dev server, port 5173
yarn build    # tsc (typecheck, noEmit) && vite build → dist/
yarn preview  # serve the built dist/
yarn deploy   # yarn build && permaweb-deploy --arns-name "$VITE_ARNS_NAME"  (see Deploy below)

# Cross-language canonical-message test (only test in the repo).
# Requires the sibling Rust contract binary to be built first; it is a
# plain node script, NOT a configured test runner (no `yarn test`).
# Skips cleanly if the binary isn't present (it isn't, in this checkout).
node test/canonical-message.test.mjs
```

There is no lint script and no ESLint/Prettier config in the repo. Typechecking happens via `tsc` inside `yarn build`.

### No `@solana/web3.js` in `src/`

On-chain logic uses **`@ar.io/sdk/solana`** (the `4.0.0-solana.*` dist-tag, built on `@solana/kit`). `src/` imports **zero** `@solana/web3.js`. Wallet *connection* still uses `@solana/wallet-adapter-*` (which pulls web3.js in transitively), but transactions are built by the SDK on kit and signed via `src/services/wallet-signer.ts`, which bridges the wallet-adapter wallet to a kit `TransactionSigner` using the Wallet Standard `solana:signTransaction` feature (raw bytes — no web3.js).

### Runtime env vars (read at dev/build time via `import.meta.env`)

- `VITE_SOLANA_RPC_URL` — RPC endpoint; defaults to mainnet-beta. The footer RPC selector overrides this and persists to `localStorage['escrow-rpc-url']` (which takes precedence over the env var on load). Point at devnet for testing: `VITE_SOLANA_RPC_URL=https://api.devnet.solana.com yarn dev`.
- `VITE_ATTESTOR_URL` — off-chain AR.IO attestor service, **required only for Arweave-recipient claims**. Ethereum claims verify on-chain and need no attestor. Without it, Arweave claims fail at submit with a clear error.
- `VITE_ESCROW_PROGRAM_ID` — **the `ario-ant-escrow` program id**. Required for any escrow action: the SDK ships **no** escrow program id for any public cluster (`ario-ant-escrow` isn't deployed to devnet/mainnet — the `sol_big_mod_exp` syscall it needs is inactive on public clusters). The footer "escrow program ID" input overrides this and persists to `localStorage['escrow-program-id']` (takes precedence on load). Point it at your own deployment (localnet/surfpool/private validator). Unset ⇒ deposit/claim/manage are disabled with a clear message; reads/ANT-lookups still work.
- `VITE_ESCROW_NETWORK` (`solana-mainnet`|`solana-devnet`) and `VITE_ARIO_MINT` — optional overrides; both are otherwise inferred from the RPC URL (`src/services/solana.ts`).

## Architecture

Single-page React 18 + TypeScript + Vite app. A web UI for the on-chain `ario-ant-escrow` Solana program: trustless escrow of ANTs, ARIO tokens, and time-locked vaults, claimable by Arweave or Ethereum recipients.

This repo is a public extract of a directory (`migration/solana-escrow-app`) inside a larger AR.IO monorepo; several docs and the test reference sibling paths (`contracts/`, `migration/attestor/`) that exist in that monorepo but not in this standalone checkout.

**Routing** (`src/App.tsx`): hand-rolled hash-based router (`#/route?query`) via the `useHashRoute` hook — no router library. `App.tsx` also owns the global shell, the Solana wallet providers (`ConnectionProvider`/`WalletProvider`/`WalletModalProvider`), and the RPC selector. `src/brand.ts` is the source of truth for brand colors (re-exported from `App.tsx` to break a circular-import TDZ).

**Pages** (`src/pages/`) — one per route:
- `LandingPage` — explainer + links to flows (`/#/`).
- `DepositPage` / `DepositTokensPage` / `DepositVaultPage` — depositor flows (ANT / liquid ARIO / time-locked vault).
- `ClaimPage` — recipient flow: fetch escrow state, build the canonical message, sign with the Arweave/Ethereum wallet, submit.
- `ManagePage` — depositor's `update_recipient` + `cancel`.
- `LookupPage` — read-only escrow inspector (no wallet needed).

**Services** (`src/services/`):
- `solana.ts` — central wiring. Resolves the RPC URL, escrow program id, network, chain, and ARIO mint (localStorage → env → inference), builds the kit `rpc`/`rpcSubscriptions`, and exposes `getAntEscrow({adapter?})` / `getTokenEscrow({adapter?})` factories that construct the SDK escrow clients (read-only without `adapter`, write-capable with it). `getWalletSigner(adapter)` returns the kit signer for hand-assembled txs.
- `escrow-client.ts` — thin layer over `@ar.io/sdk/solana`: **re-exports** `ANTEscrow`/`TokenEscrow`/`canonicalMessage`/`canonicalMessageV2`/PDA helpers/types; keeps app-specific helpers the SDK lacks (recipient parsing, Arweave RSA-modulus lookup, mARIO formatting); keeps raw-account deserialization + `getProgramAccounts` discovery scans (rewritten on the kit RPC); and provides a **web3.js-free** Ed25519 sigverify ix (`buildEd25519SigverifyIx`), an ATA helper (`getAtaForOwner`), a create-ATA-idempotent ix, and `sendInstructions` (kit assemble+sign+send) for the Arweave attested-claim path.
- `wallet-signer.ts` — wallet-adapter → kit `TransactionSigner` bridge via the Wallet Standard `solana:signTransaction` feature (raw bytes; no web3.js).
- `attestor-client.ts` (`AttestorClient`) — transport-only (fetch + bs58) client for the off-chain attestor. `AttestorHealthBanner` (rendered in `App.tsx`) gates usage by checking `/health` and refusing if the attestor's network ≠ the page's network.

**Transaction submission**: pages call the SDK escrow methods (e.g. `getAntEscrow({adapter}).deposit(...)`), which build, sign (via the kit signer bridge), and confirm the tx. **Exception — Arweave claims**: the SDK's `claimArweave` builds only the claim ix and requires the caller to prepend the attestor's Ed25519 sigverify ix, so `ClaimPage` assembles `[sigverifyIx, claimIx]` itself via `sendInstructions`. Ethereum claims (secp256k1, verified on-chain) use the SDK high-level methods directly. **Known gap**: Arweave *vault* claims aren't assemblable (the SDK exposes no vault-claim `*Ix` for sigverify prepending) — `ClaimPage` surfaces a clear error; a fix belongs upstream in `@ar.io/sdk`.

### Multi-protocol claim model (the core domain concept)

A claim is authorized by a signature over a **canonical message** that must be **byte-identical** to the Rust program's `canonical.rs` — this invariant is what `test/canonical-message.test.mjs` guards (run against a compiled Rust binary). Two recipient protocols:

- **Arweave** (RSA-PSS-4096, 512-byte modulus): the wallet signs the canonical message; the signature is POSTed to the **attestor**, which re-signs with Ed25519. The on-chain program verifies the cheap Ed25519 signature via Solana's native sigverify program. Hence the attestor dependency.
- **Ethereum** (ECDSA secp256k1, 20-byte address): verified directly on-chain via `secp256k1_recover`; no attestor.

Two canonical-message versions coexist, both from `@ar.io/sdk/solana`: `canonicalMessage` (v1, ANT escrow — `{network, antMint, claimant, nonce}`) and `canonicalMessageV2` (token/vault — adds `assetType`/`assetId`/`amount`). Different on-chain headers — keep them distinct. NOTE: the pre-migration local `escrow-client.ts` had drifted (extra `recipient:` line, missing `v1` header); the SDK versions match both the contract and the cross-language test. Use the SDK signatures (`assetType`, no `recipientPubkey` field).

**Vault claim** is special: claiming a still-locked vault builds a transaction with both the escrow `claim_vault_*` instruction and a sibling `ario_core::vaulted_transfer` instruction, which the program validates via `sysvar::instructions` introspection. Expired vaults are claimed as plain liquid SPL transfers.

### Build/polyfill notes

- `vite.config.ts` sets `base: "./"` (relative paths, for Arweave subpath hosting) and uses `vite-plugin-node-polyfills` for `buffer`/`crypto`/`stream` etc. — required by the multi-chain wallet/crypto libs.
- `@` is aliased to `src/` in Vite config (currently unused — all source imports use relative paths).
- `import.meta.env.PACKAGE_VERSION` and `BUILD_TIME` are injected from `package.json` / build date.
- Wallet-adapter providers are cast to `any` in `App.tsx` as a React 18/19 type-compat shim.

## Deploy (Arweave + ArNS)

Static `dist/` is deployed to Arweave and bound to an ArNS name with
**`permaweb-deploy`** (`yarn deploy`). The deploy script builds first, so the
build-time `VITE_*` config must be set in the same shell. `base: "./"` in
`vite.config.ts` keeps asset paths relative for Arweave subpath hosting.

```bash
# one-time: ensure node >= 20.19 (use nvm; .nvmrc pins 24)
nvm use

# deploy: build with devnet config + push to Arweave + update the ArNS record
export DEPLOY_KEY=$(base64 -i /path/to/arweave-wallet.json)   # base64 JWK
VITE_ARNS_NAME=<your-arns-name> \
VITE_SOLANA_RPC_URL=https://api.devnet.solana.com \
VITE_ESCROW_PROGRAM_ID=<your-ario-ant-escrow-program-id> \
VITE_ATTESTOR_URL=<your-attestor-url> \
  yarn deploy
```

`permaweb-deploy deploy` uploads `./dist` via Turbo and sets the ArNS `@`
record (override with `--undername staging`). It targets the AR.IO mainnet ARIO
process by default (ArNS lives on mainnet AO). `DEPLOY_KEY` (base64 JWK) is the
wallet; `--wallet`/`--private-key` are alternatives. See `.env.example`.

## Reference docs

- `README.md` — page list and fork context (note the stale stub/`@solana/kit` claims above).
- `docs/SIGNATURE_VERIFICATION.md` — signature-verification details.
- The README/code reference monorepo-only docs: `docs/ANT_ESCROW_IMPLEMENTATION_PLAN.md`, `docs/DECISIONS.md` (ADR-017), `docs/ATTESTOR_SECURITY_REVIEW.md`, `migration/attestor/README.md`.
