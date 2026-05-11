# Signature Verification Protocol

## Background

The registration app creates attestation data items on Arweave that link
a source wallet (Arweave or Ethereum) to a Solana destination address.
Each attestation includes a cryptographic proof that the user controls
the Solana wallet.

## Decision: Dual Signature Methods

### Problem

Ledger hardware wallets connected through Phantom do not support
`signMessage` on Solana. Phantom's implementation throws error `0x6a81`
("invalid off-chain message header") because it does not properly
implement the V0→Legacy fallback for the Ledger Solana app's off-chain
signing spec. This is a known Phantom limitation with no ETA for a fix.

References:
- https://github.com/orgs/phantom/discussions/139
- https://github.com/phantom/sandbox/issues/14
- https://github.com/LedgerHQ/device-sdk-ts/pull/1291

### Solution

Two signature methods, with automatic fallback:

1. **Method "message"** (default): `signMessage(sourceAddressBytes)` —
   standard Ed25519 signature over the raw source address. Works for all
   software wallets (Phantom, Solflare, Backpack without Ledger).

2. **Method "transaction"** (Ledger fallback): When `signMessage` fails
   with a Ledger error, the app creates a Solana transaction containing a
   Memo instruction with `ar.io-registration:<sourceAddress>`, asks the
   wallet to `signTransaction`, extracts the signature, and does NOT
   submit the transaction on-chain.

The fallback is transparent to the user — they see one signing prompt
on their Ledger device.

## Attestation Tags

Every attestation data item on Arweave includes these tags:

| Tag | Value | Notes |
|-----|-------|-------|
| App-Name | AR-IO-Solana-Registration | Protocol identifier |
| Version | 1 | Schema version |
| Action | Register | Operation type |
| Source-Address | <arweave-or-eth-address> | The source wallet |
| Solana-Pubkey | <base58-solana-address> | The destination wallet |
| Source-Chain | arweave \| ethereum | Which chain the source is on |
| Solana-Signature | <base58-signature> | 64-byte Ed25519 signature |
| Signature-Method | message \| transaction | Which signing method was used |
| Signature-Data | <base64-tx-message> | Only present for "transaction" method |
| Timestamp | <epoch-ms> | When the registration was created |
| Content-Type | text/plain | For gateway rendering |

## Verification Protocol

### Method "message"

```
Input:
  signature = base58_decode(tags["Solana-Signature"])
  message   = utf8_encode(tags["Source-Address"])
  pubkey    = base58_decode(tags["Solana-Pubkey"])

Verify:
  ed25519.verify(signature, message, pubkey) === true
```

The signature is over the raw UTF-8 bytes of the source address.
This is a standard Ed25519 `signMessage` verification.

### Method "transaction"

```
Input:
  signature  = base58_decode(tags["Solana-Signature"])
  tx_message = base64_decode(tags["Signature-Data"])
  pubkey     = base58_decode(tags["Solana-Pubkey"])

Step 1 — Verify the signature over the transaction message:
  ed25519.verify(signature, tx_message, pubkey) === true

Step 2 — Verify the transaction contains the correct source address:
  Deserialize tx_message as a Solana transaction message.
  Find the Memo program instruction (program ID: MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr).
  Decode the memo data as UTF-8.
  Assert it equals: "ar.io-registration:<Source-Address>"

Step 3 — Verify the fee payer matches:
  The first account in the transaction message must equal pubkey.
```

Both methods prove the same thing: the holder of the Solana private key
authorized the link to the source address.

## Security Analysis

### Replay Attack

The signed transaction contains a recent blockhash that expires in ~60
seconds. By the time the attestation is uploaded to Arweave (minutes),
the blockhash is expired and the transaction cannot be submitted
on-chain. Even if intercepted during the brief valid window, the
transaction only executes a harmless Memo instruction with no token
transfers.

### Forgery

Both methods require a valid Ed25519 signature from the Solana private
key. Without the key, an attacker cannot produce a valid signature over
either the raw message or the transaction message.

### Source Address Binding

The source address is embedded in both the signed data (message bytes or
memo instruction) and the attestation tags. Changing the `Source-Address`
tag without re-signing invalidates the proof.

### Attestation Immutability

Attestations are stored on Arweave — immutable and permanent. The
`Signature-Data` field for transaction-method proofs is stored alongside
the signature, ensuring the verification material is always available.

### One Solana Address Per Source

The registration app enforces that each Solana address can only be linked
to one source address. This is checked via GraphQL query before upload
and enforced by the migration verifier (latest attestation per source
address wins, sorted by block height DESC).

## Implementation Notes

- The `signTransaction` fallback requires an RPC call to `getLatestBlockhash`.
  This uses the configured `VITE_SOLANA_RPC_URL` endpoint.
- The Memo program ID `MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr` is the
  standard Solana Memo Program v2.
- Software wallets always use method "message" — the fallback only triggers
  on specific Ledger error codes (`0x6a81`, `ledgerUnknownSignError`).
- The `Signature-Data` tag can be large (~200-300 bytes base64) but is well
  within Arweave's 4096-byte tag size limit.
