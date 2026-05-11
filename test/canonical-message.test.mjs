/**
 * Cross-test: verify the frontend's canonicalMessage() produces
 * byte-identical output to the Rust program's canonical.rs.
 *
 * Run:
 *   cd migration/solana-escrow-app
 *   node test/canonical-message.test.mjs
 *
 * Requires the Rust binary to be built first:
 *   cd contracts && cargo build --example canonical -p ario-ant-escrow
 */
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { strict as assert } from 'node:assert';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '../../..');
const RUST_BIN = resolve(REPO_ROOT, 'contracts/target/debug/examples/canonical');

// Inline the canonical message logic (same as escrow-client.ts)
function canonicalMessage(network, antMint, claimant, nonce) {
  const nonceHex = Array.from(nonce, b => b.toString(16).padStart(2, '0')).join('');
  const text =
    `ar.io ant-escrow claim v1\n` +
    `network: ${network}\n` +
    `ant: ${antMint}\n` +
    `claimant: ${claimant}\n` +
    `nonce: ${nonceHex}`;
  return new TextEncoder().encode(text);
}

function bytesToHex(bytes) {
  return Array.from(bytes, b => b.toString(16).padStart(2, '0')).join('');
}

const VECTORS = [
  {
    label: 'design doc example',
    antMint: '9PnRFwk2Yp7QyU3sQzXwUhJj6tVyM4nN2KqL5fT8RbAW',
    claimant: 'Hk6RfBp4FpvF2hYBmJ9kqyL5dE3xR8wPzN7sV6cTqL2A',
    nonce: new Uint8Array([
      0xa3, 0xf1, 0xc8, 0xd9, 0x2e, 0x0b, 0x4f, 0x7a,
      0x8e, 0x1d, 0x6c, 0x5b, 0x4a, 0x39, 0x20, 0x81,
      0x7f, 0x6e, 0x5d, 0x4c, 0x3b, 0x2a, 0x19, 0x18,
      0x87, 0x76, 0x65, 0x54, 0x43, 0x32, 0x21, 0x10,
    ]),
  },
  {
    label: 'all-zero nonce',
    antMint: '11111111111111111111111111111112',
    claimant: '11111111111111111111111111111112',
    nonce: new Uint8Array(32),
  },
  {
    label: 'all-ff nonce',
    antMint: 'TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA',
    claimant: 'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
    nonce: new Uint8Array(32).fill(0xff),
  },
];

if (!existsSync(RUST_BIN)) {
  console.log(`[skip] Rust binary not found at ${RUST_BIN}`);
  console.log('  Build with: cd contracts && cargo build --example canonical -p ario-ant-escrow');
  process.exit(0);
}

let passed = 0;
for (const v of VECTORS) {
  const nonceHex = bytesToHex(v.nonce);
  const tsOut = canonicalMessage('solana-mainnet', v.antMint, v.claimant, v.nonce);
  const rustOut = new Uint8Array(execFileSync(RUST_BIN, [v.antMint, v.claimant, nonceHex], { maxBuffer: 4096 }));

  assert.deepEqual(tsOut, rustOut, `FAIL: "${v.label}" — frontend != Rust`);
  passed++;
  console.log(`  ✓ ${v.label}`);
}

console.log(`\n${passed}/${VECTORS.length} cross-language vectors passed`);
