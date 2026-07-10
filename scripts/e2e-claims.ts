/**
 * Headless end-to-end driver for the centralized claims flow.
 *
 * Exercises the REAL frontend service layer (`src/services/claims-api.ts`)
 * against a running ar-io-claims service, for the six UAT scenarios
 * (AR-token, AR-ANT, ETH-token, ETH-ANT, vault-active, vault-expired). For
 * each it runs the exact sequence the ClaimPage drives:
 *
 *   lookup (GET /v1/claimable)  →  initiate (POST /v1/claims/initiate)
 *     →  sign the server-built canonical with the recipient key
 *     →  complete (POST /v1/claims/complete)  →  status (GET /v1/claims/:id)
 *
 * The wallet signing mirrors the browser exactly: RSA-PSS/SHA-256 salt-32
 * for Arweave (node crypto, same as a Wander/ArConnect `signMessage`), and
 * ethers `Wallet.signMessage` for Ethereum (the same library + EIP-191 path
 * `ClaimPage.handleEthereumSign` uses). A browser wallet can't be driven in
 * CI, so this proves the same code path with keys we control.
 *
 * Run (fixture seeded separately into the claims DB):
 *   CLAIMS_API_URL=http://127.0.0.1:3040 FIXTURE=/path/fixture.json \
 *     <tsx> scripts/e2e-claims.ts
 */
import { readFileSync } from 'node:fs';
import { createPrivateKey, sign as nodeSign, constants, randomBytes } from 'node:crypto';
import { Wallet } from 'ethers';
import bs58 from 'bs58';

import {
  setClaimsApiUrlOverride,
  getClaimable,
  initiateClaim,
  completeClaim,
  getClaim,
  type ClaimProtocol,
  type CompleteResult,
} from '../src/services/claims-api.ts';

interface Fixture {
  ar: {
    recipientId: string;
    sourceAddress: string;
    modulusB64Url: string;
    privatePem: string;
    assets: {
      ant: string;
      token: string;
      vaultActive: string;
      vaultExpired: string;
      // dedicated available assets for the fix-#1 lockout regressions
      lockout?: string;
      expiry?: string;
    };
  };
  eth: {
    recipientId: string;
    sourceAddress: string;
    privHex: string;
    assets: { ant: string; token: string };
  };
}

const API = process.env.CLAIMS_API_URL ?? 'http://127.0.0.1:3040';
const FIXTURE = process.env.FIXTURE!;
setClaimsApiUrlOverride(API);

const fx: Fixture = JSON.parse(readFileSync(FIXTURE, 'utf8'));
const b64urlToBytes = (s: string): Uint8Array => {
  const pad = s.replace(/-/g, '+').replace(/_/g, '/') + '==='.slice(0, (4 - (s.length % 4)) % 4);
  return new Uint8Array(Buffer.from(pad, 'base64'));
};
const modulusBytes = b64urlToBytes(fx.ar.modulusB64Url);
const arKey = createPrivateKey(fx.ar.privatePem);
const ethWallet = new Wallet('0x' + fx.eth.privHex);
const randomClaimant = () => bs58.encode(randomBytes(32));

function signArweave(canonical: Uint8Array): Uint8Array {
  return new Uint8Array(
    nodeSign('sha256', Buffer.from(canonical), {
      key: arKey,
      padding: constants.RSA_PKCS1_PSS_PADDING,
      saltLength: 32,
    }),
  );
}
async function signEthereum(canonical: Uint8Array): Promise<Uint8Array> {
  const messageString = new TextDecoder().decode(canonical);
  const sigHex = await ethWallet.signMessage(messageString);
  return new Uint8Array(Buffer.from(sigHex.slice(2), 'hex'));
}

interface Scenario {
  name: string;
  protocol: ClaimProtocol;
  recipientId: string;
  assetKey: string;
  expectType: 'ant' | 'token' | 'vault';
}

const scenarios: Scenario[] = [
  { name: 'AR-token', protocol: 'arweave', recipientId: fx.ar.recipientId, assetKey: fx.ar.assets.token, expectType: 'token' },
  { name: 'AR-ANT', protocol: 'arweave', recipientId: fx.ar.recipientId, assetKey: fx.ar.assets.ant, expectType: 'ant' },
  { name: 'vault-active', protocol: 'arweave', recipientId: fx.ar.recipientId, assetKey: fx.ar.assets.vaultActive, expectType: 'vault' },
  { name: 'vault-expired', protocol: 'arweave', recipientId: fx.ar.recipientId, assetKey: fx.ar.assets.vaultExpired, expectType: 'vault' },
  { name: 'ETH-token', protocol: 'ethereum', recipientId: fx.eth.recipientId, assetKey: fx.eth.assets.token, expectType: 'token' },
  { name: 'ETH-ANT', protocol: 'ethereum', recipientId: fx.eth.recipientId, assetKey: fx.eth.assets.ant, expectType: 'ant' },
];

async function run(s: Scenario): Promise<void> {
  // 1. lookup by identity (GET /v1/claimable)
  const claimable = await getClaimable({ recipientId: s.recipientId });
  const found = claimable.assets.find((a) => a.assetKey === s.assetKey);
  if (!found) throw new Error(`lookup: asset ${s.assetKey} not in /v1/claimable`);
  if (found.assetType !== s.expectType) {
    throw new Error(`lookup: expected ${s.expectType}, got ${found.assetType}`);
  }

  // 2. initiate (server builds the canonical + challenge)
  const claimant = randomClaimant();
  const initiated = await initiateClaim({ assetKey: s.assetKey, claimant });
  if (initiated.protocol !== s.protocol) {
    throw new Error(`initiate: protocol ${initiated.protocol} != ${s.protocol}`);
  }
  const canonicalText = new TextDecoder().decode(initiated.canonicalMessageBytes);
  if (!canonicalText.includes(`claimant: ${claimant}`)) {
    throw new Error('initiate: canonical does not bind the claimant');
  }

  // 3. sign the server-built canonical with the recipient key
  const signature =
    s.protocol === 'arweave'
      ? signArweave(initiated.canonicalMessageBytes)
      : await signEthereum(initiated.canonicalMessageBytes);

  // 4. complete (POST /v1/claims/complete) with the proof
  const completed = await completeClaim({
    claimId: initiated.claimId,
    protocol: s.protocol,
    signature,
    modulus: s.protocol === 'arweave' ? modulusBytes : undefined,
    saltLength: 32,
  });
  if (completed.status !== 'verified') {
    throw new Error(`complete: expected verified, got ${completed.status}`);
  }

  // 5. status (GET /v1/claims/:id)
  const status = await getClaim(initiated.claimId);
  if (!['verified', 'dispatching', 'confirmed'].includes(status.status)) {
    throw new Error(`status: unexpected ${status.status}`);
  }

  // idempotent replay of the same proof must return the same result.
  const replay = await completeClaim({
    claimId: initiated.claimId,
    protocol: s.protocol,
    signature,
    modulus: s.protocol === 'arweave' ? modulusBytes : undefined,
    saltLength: 32,
  });
  if (!replay.idempotentReplay) {
    throw new Error('complete replay: expected idempotentReplay=true');
  }

  console.log(
    `  PASS ${s.name.padEnd(13)} type=${found.assetType} amount=${found.amount ?? '-'} ` +
      `settlement=${completed.settlement ?? '-'} claim=${initiated.claimId.slice(0, 8)} status=${status.status}`,
  );
}

/** Sign the server canonical for an AR-token asset with the AR key. */
async function initiateSignComplete(assetKey: string): Promise<CompleteResult> {
  const init = await initiateClaim({ assetKey, claimant: randomClaimant(), idempotencyKey: crypto.randomUUID() });
  const sig = signArweave(init.canonicalMessageBytes);
  return completeClaim({ claimId: init.claimId, protocol: 'arweave', signature: sig, modulus: modulusBytes, saltLength: 32 });
}

/** fix #1(a): a rejected attempt must not lock out a later VALID signature. */
async function lockoutAfterRejection(assetKey: string): Promise<boolean> {
  // fresh claim #1: garbage sig -> rejected (asset stays available)
  const bad = await initiateClaim({ assetKey, claimant: randomClaimant(), idempotencyKey: crypto.randomUUID() });
  let rejected = false;
  try {
    await completeClaim({ claimId: bad.claimId, protocol: 'arweave', signature: randomBytes(512), modulus: modulusBytes, saltLength: 32 });
  } catch {
    rejected = true;
  }
  // fresh claim #2 (new idempotency key) with a VALID sig -> must succeed
  const ok = await initiateSignComplete(assetKey);
  return rejected && ok.status === 'verified';
}

/** fix #1(b): an EXPIRED challenge must not lock out a later fresh sign.
 *  Requires the service's CLAIM_CHALLENGE_TTL_MS < EXPIRY_WAIT_MS. */
async function lockoutAfterExpiry(assetKey: string, waitMs: number): Promise<boolean> {
  const first = await initiateClaim({ assetKey, claimant: randomClaimant(), idempotencyKey: crypto.randomUUID() });
  const sig = signArweave(first.canonicalMessageBytes);
  await new Promise((r) => setTimeout(r, waitMs)); // let the challenge expire
  let expired = false;
  try {
    await completeClaim({ claimId: first.claimId, protocol: 'arweave', signature: sig, modulus: modulusBytes, saltLength: 32 });
  } catch (e) {
    expired = (e as Error).message.toLowerCase().includes('expire') || (e as any).code === 'CHALLENGE_EXPIRED';
  }
  // fresh sign (new claim + challenge) must succeed
  const ok = await initiateSignComplete(assetKey);
  return expired && ok.status === 'verified';
}

async function main(): Promise<void> {
  console.log(`Driving 6 UAT scenarios against ${API}\n`);
  let failed = 0;

  // fix #1 regressions (no stuck state after a terminal failure).
  if (fx.ar.assets.lockout) {
    const ok = await lockoutAfterRejection(fx.ar.assets.lockout);
    console.log(`  ${ok ? 'PASS' : 'FAIL'} lockout-after-rejection (bad sig -> then a valid sig SUCCEEDS)`);
    if (!ok) failed++;
  }
  if (fx.ar.assets.expiry && process.env.EXPIRY_WAIT_MS) {
    const ok = await lockoutAfterExpiry(fx.ar.assets.expiry, Number(process.env.EXPIRY_WAIT_MS));
    console.log(`  ${ok ? 'PASS' : 'FAIL'} lockout-after-expiry (challenge expires -> a fresh sign SUCCEEDS)`);
    if (!ok) failed++;
  }

  // negative check FIRST (a rejected claim leaves the asset available, so the
  // ETH-token scenario below still claims it): a garbage proof must be rejected.
  try {
    const init = await initiateClaim({ assetKey: fx.eth.assets.token, claimant: randomClaimant() });
    let rejected = false;
    try {
      await completeClaim({ claimId: init.claimId, protocol: 'ethereum', signature: randomBytes(65) });
    } catch {
      rejected = true;
    }
    console.log(`  ${rejected ? 'PASS' : 'FAIL'} bad-proof-rejected (garbage signature -> ${rejected ? 'rejected, asset stays available' : 'ACCEPTED!'})`);
    if (!rejected) failed++;
  } catch (e) {
    console.error(`  negative-check error: ${(e as Error).message}`);
    failed++;
  }

  for (const s of scenarios) {
    try {
      await run(s);
    } catch (e) {
      failed++;
      console.error(`  FAIL ${s.name}: ${(e as Error).message}`);
    }
  }

  console.log(`\n${failed === 0 ? 'ALL PASS' : `${failed} FAILED`}`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
