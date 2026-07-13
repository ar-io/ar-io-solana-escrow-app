import React, { useState, useCallback, useEffect } from 'react';
import { useWallet } from '@solana/wallet-adapter-react';
import { brand } from '../brand.js';
import { StepCard } from '../components/StepCard.tsx';
import { SolanaWalletConnect } from '../components/SolanaWalletConnect.tsx';
import { ArweaveWalletConnect } from '../components/ArweaveWalletConnect.tsx';
import { EthereumWalletConnect } from '../components/EthereumWalletConnect.tsx';
import {
  fetchEscrowState,
  fetchEscrowsByRecipient,
  fetchTokenEscrowsByRecipient,
  fetchRawEscrowAccount,
  deserializeEscrowToken,
  type TokenEscrowByRecipient,
  lookupArweaveModulus,
  parseArweaveRecipient,
  formatMarioToArio,
  ESCROW_TOKEN_ACCOUNT_SIZE,
  type EscrowAntState,
  type EscrowTokenState,
} from '../services/escrow-client.ts';
import {
  getEscrowProgramId,
  getNetwork,
  makeRpc,
} from '../services/solana.ts';
import {
  bytesToHexLower,
} from '../services/attestor-client.ts';
import {
  initiateClaim,
  completeClaim,
  waitForClaim,
  type ClaimProtocol,
} from '../services/claims-api.ts';
import { assertServerCanonicalMatches } from '../services/canonical-verify.ts';

interface Props {
  /** ANT mint or escrow PDA, optionally read from `?ant=<mint>` query string. */
  antMint: string;
}

/**
 * Recipient flow — verify the canonical message, sign with the
 * appropriate (Arweave or Ethereum) wallet, submit the claim tx.
 *
 * 1. User enters the ANT mint and their desired Solana destination.
 * 2. The page fetches the EscrowAnt PDA to determine recipient protocol
 *    and nonce, then renders the canonical message preview.
 * 3. The user connects their Arweave or Ethereum wallet and signs the
 *    canonical message.
 * 4. Anyone (fee payer) submits the claim tx with the signature.
 */
export function ClaimPage({ antMint: initialAntMint }: Props) {
  const [antMint, setAntMint] = useState(initialAntMint);
  const [claimant, setClaimant] = useState('');
  const [solPubkey, setSolPubkey] = useState<string | undefined>();

  // Escrow state from on-chain (ANT or token/vault — one will be set)
  const [escrowState, setEscrowState] = useState<EscrowAntState | null>(null);
  const [tokenState, setTokenState] = useState<EscrowTokenState | null>(null);
  const [escrowLoading, setEscrowLoading] = useState(false);
  const [escrowError, setEscrowError] = useState('');

  // Source wallet connection (for signing)
  const [arweaveAddress, setArweaveAddress] = useState<string | undefined>();
  const [ethereumAddress, setEthereumAddress] = useState<string | undefined>();
  const [ethereumProvider, setEthereumProvider] = useState<any>(undefined);

  // Signature state
  const [signature, setSignature] = useState<Uint8Array | null>(null);
  // Arweave modulus captured at sign time. Required to POST to the
  // attestor service alongside the RSA-PSS signature; the Ethereum
  // path leaves this null and verifies on-chain via secp256k1_recover.
  const [arweaveModulus, setArweaveModulus] = useState<Uint8Array | null>(null);
  const [signError, setSignError] = useState('');
  const [signing, setSigning] = useState(false);
  // Server-issued claim id from POST /v1/claims/initiate — the signature is
  // over the challenge that claim carries, so it is submitted with /complete.
  const [claimId, setClaimId] = useState<string | null>(null);

  // Recipient discovery
  const [recipientEscrows, setRecipientEscrows] = useState<
    Array<{ antMint: string; state: EscrowAntState }>
  >([]);
  const [recipientTokenEscrows, setRecipientTokenEscrows] = useState<
    TokenEscrowByRecipient[]
  >([]);
  const [recipientDiscoveryLoading, setRecipientDiscoveryLoading] = useState(false);
  const [recipientDiscoveryError, setRecipientDiscoveryError] = useState('');
  const [recipientDiscoveryDone, setRecipientDiscoveryDone] = useState(false);

  // Claim submission state
  const [claimStatus, setClaimStatus] = useState<'idle' | 'submitting' | 'success' | 'error'>('idle');
  const [claimMessage, setClaimMessage] = useState('');
  const [txSignature, setTxSignature] = useState('');

  const { publicKey } = useWallet();

  // -------------------------------------------------------------------
  // Fetch escrow state when ANT mint changes
  // -------------------------------------------------------------------
  const fetchEscrow = useCallback(async () => {
    if (!antMint || antMint.length < 30) {
      setEscrowState(null);
      setTokenState(null);
      setEscrowError('');
      return;
    }

    setEscrowLoading(true);
    setEscrowError('');
    setEscrowState(null);
    setTokenState(null);
    setSignature(null);
    setClaimId(null);

    try {
      const programId = getEscrowProgramId();
      if (!programId) {
        setEscrowError(
          'No escrow program configured. Set the program ID in the menu (or VITE_ESCROW_PROGRAM_ID) to point at a deployed ario-ant-escrow program.',
        );
        return;
      }
      const { rpc } = makeRpc();

      // First try as an ANT mint (claims API: GET /v1/assets/:mint).
      const state = await fetchEscrowState(rpc, antMint, programId);
      if (state) {
        setEscrowState(state);
        return;
      }

      // If not found as ANT, try fetching the address directly as a PDA
      // (for token/vault escrows where the user pastes the PDA address).
      const rawAccount = await fetchRawEscrowAccount(rpc, antMint, programId);
      if (rawAccount && rawAccount.size === ESCROW_TOKEN_ACCOUNT_SIZE) {
        const tState = deserializeEscrowToken(rawAccount.data);
        setTokenState(tState);
        return;
      }

      setEscrowError(
        'No claimable asset is loaded yet. Connect your Arweave or Ethereum ' +
          'wallet above to find the assets waiting for you (a claim link needs ' +
          'your wallet to determine how to sign).',
      );
    } catch (e) {
      setEscrowError(
        `Failed to fetch escrow: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setEscrowLoading(false);
    }
  }, [antMint]);

  useEffect(() => {
    if (antMint && antMint.length >= 32) {
      fetchEscrow();
    }
  }, [antMint, fetchEscrow]);

  // -------------------------------------------------------------------
  // Auto-discover escrows addressed to connected source wallet
  // -------------------------------------------------------------------
  useEffect(() => {
    const addr = arweaveAddress;
    if (!addr) return;

    let cancelled = false;
    (async () => {
      setRecipientDiscoveryLoading(true);
      setRecipientDiscoveryError('');
      try {
        const programId = getEscrowProgramId();
        if (!programId) throw new Error('No escrow program configured.');
        const { rpc } = makeRpc();
        const modulus = await lookupArweaveModulus(addr);
        const modulusBytes = parseArweaveRecipient(modulus);
        const [ants, tokens] = await Promise.all([
          fetchEscrowsByRecipient(rpc, 'arweave', modulusBytes, programId),
          fetchTokenEscrowsByRecipient(rpc, 'arweave', modulusBytes, programId),
        ]);
        if (!cancelled) {
          setRecipientEscrows(ants);
          setRecipientTokenEscrows(tokens);
          setRecipientDiscoveryDone(true);
          // A deep-linked identifier that couldn't resolve its protocol before
          // (no wallet connected) is now in the discovery cache — re-resolve it
          // so the correct (AR/ETH) signer is offered.
          if (antMint && antMint.length >= 30 && !escrowState && !tokenState) {
            fetchEscrow();
          }
        }
      } catch (e) {
        if (!cancelled) {
          setRecipientDiscoveryError(
            `Could not look up escrows: ${e instanceof Error ? e.message : String(e)}. You can still enter an ANT mint manually above.`,
          );
          setRecipientDiscoveryDone(true);
        }
      } finally {
        if (!cancelled) setRecipientDiscoveryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [arweaveAddress]);

  useEffect(() => {
    const addr = ethereumAddress;
    if (!addr) return;

    let cancelled = false;
    (async () => {
      setRecipientDiscoveryLoading(true);
      setRecipientDiscoveryError('');
      try {
        let hex = addr.trim();
        if (hex.startsWith('0x') || hex.startsWith('0X')) hex = hex.slice(2);
        const addrBytes = new Uint8Array(20);
        for (let i = 0; i < 20; i++) {
          addrBytes[i] = parseInt(hex.slice(i * 2, i * 2 + 2), 16);
        }
        const programId = getEscrowProgramId();
        if (!programId) throw new Error('No escrow program configured.');
        const { rpc } = makeRpc();
        const [ants, tokens] = await Promise.all([
          fetchEscrowsByRecipient(rpc, 'ethereum', addrBytes, programId),
          fetchTokenEscrowsByRecipient(rpc, 'ethereum', addrBytes, programId),
        ]);
        if (!cancelled) {
          setRecipientEscrows(ants);
          setRecipientTokenEscrows(tokens);
          setRecipientDiscoveryDone(true);
          // A deep-linked identifier that couldn't resolve its protocol before
          // (no wallet connected) is now in the discovery cache — re-resolve it
          // so the correct (AR/ETH) signer is offered.
          if (antMint && antMint.length >= 30 && !escrowState && !tokenState) {
            fetchEscrow();
          }
        }
      } catch (e) {
        if (!cancelled) {
          setRecipientDiscoveryError(
            `Could not look up escrows: ${e instanceof Error ? e.message : String(e)}. You can still enter an ANT mint manually above.`,
          );
          setRecipientDiscoveryDone(true);
        }
      } finally {
        if (!cancelled) setRecipientDiscoveryLoading(false);
      }
    })();
    return () => { cancelled = true; };
  }, [ethereumAddress]);

  // Reset discovery when source wallet disconnects
  useEffect(() => {
    if (!arweaveAddress && !ethereumAddress) {
      setRecipientEscrows([]);
      setRecipientTokenEscrows([]);
      setRecipientDiscoveryDone(false);
      setRecipientDiscoveryError('');
    }
  }, [arweaveAddress, ethereumAddress]);

  // The active escrow (whichever type is loaded)
  const activeProtocol = escrowState?.recipientProtocol ?? tokenState?.recipientProtocol;
  const activeNonce = escrowState?.nonce ?? tokenState?.nonce;

  // -------------------------------------------------------------------
  // Sign canonical message
  // -------------------------------------------------------------------
  const handleArweaveSign = useCallback(async () => {
    if ((!escrowState && !tokenState) || !claimant) return;
    setSigning(true);
    setSignError('');

    try {
      const arweaveWallet = (window as any).arweaveWallet;
      if (!arweaveWallet) throw new Error('Arweave wallet not connected');

      // Fetch the wallet's RSA modulus (JWK "n" field, base64url) BEFORE
      // building the canonical message. The on-chain canonical message
      // includes a `recipient` field derived from
      // `sha256(escrow.recipient_pubkey)`. The off-chain attestor
      // builds the same field from this modulus. Mismatched modulus →
      // divergent canonical → on-chain Ed25519 verify fails. (F-1)
      const modulusB64Url: string = await arweaveWallet.getActivePublicKey();
      if (!modulusB64Url || typeof modulusB64Url !== 'string') {
        throw new Error('Wallet did not return an RSA public key');
      }
      const modulusBytes = parseArweaveRecipient(modulusB64Url);
      if (modulusBytes.length !== 512) {
        throw new Error(
          'Your Arweave wallet uses an unsupported key type. Only RSA-4096 keys are supported.',
        );
      }

      // Initiate the claim: the server mints a single-use challenge nonce and
      // returns the EXACT canonical bytes to sign (built from ledger state).
      // The wallet signs THOSE bytes — the client no longer builds them.
      const assetKey = escrowState
        ? String(escrowState.antMint)
        : bytesToHexLower(tokenState!.assetId);
      // Fresh idempotency key per sign attempt: each retry is a NEW claim +
      // challenge, so a prior rejected/expired attempt never locks out a later
      // valid signature (a deterministic key would replay the terminal claim).
      const initiated = await initiateClaim({
        assetKey,
        claimant,
        idempotencyKey: crypto.randomUUID(),
      });
      const messageBytes = initiated.canonicalMessageBytes;

      // MEDIUM-2: byte-compare the server canonical against a locally rebuilt one
      // before signing. This is NOT independent asset/amount verification — the
      // asset/amount shown come from the server's published signed ledger, not an
      // on-chain read here, so those fields still rest on server trust + that
      // ledger. What the byte-compare DOES guarantee is redirect protection: the
      // canonical is byte-bound to the CLIENT's own network + this wallet's modulus
      // + the destination the user typed, so a malicious server cannot silently
      // rebind the claim to a claimant/recipient the user does not control or see.
      assertServerCanonicalMatches(messageBytes, {
        network: getNetwork(),
        claimant,
        nonce: hexToBytes(initiated.nonceHex),
        recipientPubkey: modulusBytes,
        asset: escrowState
          ? { assetType: 'ant', antMint: String(escrowState.antMint) }
          : {
              assetType: tokenState!.assetType,
              assetId: tokenState!.assetId,
              amount: tokenState!.amount,
            },
      });

      // signMessage return shape varies by wallet:
      // - Wander/ArConnect: Uint8Array (512 bytes)
      // - Some wallets: ArrayBuffer
      // - Some wallets: { signature: Uint8Array }
      const raw = await arweaveWallet.signMessage(messageBytes);
      let sig: Uint8Array;
      if (raw instanceof Uint8Array) {
        sig = raw;
      } else if (raw instanceof ArrayBuffer) {
        sig = new Uint8Array(raw);
      } else if (raw?.signature) {
        sig = new Uint8Array(raw.signature);
      } else {
        throw new Error('Unexpected signMessage return format');
      }
      if (sig.length !== 512) {
        throw new Error('Invalid signature from wallet. Please try again.');
      }
      setSignature(sig);
      setArweaveModulus(modulusBytes);
      setClaimId(initiated.claimId);
    } catch (e) {
      setSignError(
        `Arweave signing failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setSigning(false);
    }
  }, [escrowState, tokenState, claimant, antMint]);

  const handleEthereumSign = useCallback(async () => {
    if ((!escrowState && !tokenState) || !claimant || !ethereumProvider) return;
    setSigning(true);
    setSignError('');

    try {
      // Initiate the claim → sign the server-built canonical bytes.
      const assetKey = escrowState
        ? String(escrowState.antMint)
        : bytesToHexLower(tokenState!.assetId);
      // Fresh idempotency key per sign attempt: each retry is a NEW claim +
      // challenge, so a prior rejected/expired attempt never locks out a later
      // valid signature (a deterministic key would replay the terminal claim).
      const initiated = await initiateClaim({
        assetKey,
        claimant,
        idempotencyKey: crypto.randomUUID(),
      });
      const messageBytes = initiated.canonicalMessageBytes;

      // MEDIUM-2: byte-compare the server canonical against a locally rebuilt one
      // before signing. This does NOT independently verify asset/amount — those
      // come from the server's published signed ledger, not an on-chain read here,
      // so they still rest on server trust + that ledger. The real guarantee is
      // redirect protection: the canonical is byte-bound to the CLIENT's own network
      // + the connected Ethereum address (20 bytes) + the destination the user
      // typed, so a malicious server cannot silently rebind the claim to a
      // claimant/recipient the user does not control or see.
      if (!ethereumAddress) {
        throw new Error('Ethereum wallet address unavailable; reconnect and try again.');
      }
      const ethRecipientBytes = hexToBytes(ethereumAddress.trim());
      if (ethRecipientBytes.length !== 20) {
        throw new Error('Connected Ethereum address is not 20 bytes.');
      }
      assertServerCanonicalMatches(messageBytes, {
        network: getNetwork(),
        claimant,
        nonce: hexToBytes(initiated.nonceHex),
        recipientPubkey: ethRecipientBytes,
        asset: escrowState
          ? { assetType: 'ant', antMint: String(escrowState.antMint) }
          : {
              assetType: tokenState!.assetType,
              assetId: tokenState!.assetId,
              amount: tokenState!.amount,
            },
      });

      // Use ethers to sign the message via the injected provider.
      // personal_sign applies EIP-191 prefix automatically.
      const { BrowserProvider } = await import('ethers');
      const provider = new BrowserProvider(ethereumProvider);
      const signer = await provider.getSigner();
      const messageString = new TextDecoder().decode(messageBytes);
      const sigHex = await signer.signMessage(messageString);

      // Convert hex signature to 65-byte Uint8Array (r || s || v)
      const sigBytes = hexToBytes(sigHex);
      setSignature(sigBytes);
      setClaimId(initiated.claimId);
    } catch (e) {
      setSignError(
        `Ethereum signing failed: ${e instanceof Error ? e.message : String(e)}`,
      );
    } finally {
      setSigning(false);
    }
  }, [escrowState, tokenState, claimant, antMint, ethereumProvider, ethereumAddress]);

  // -------------------------------------------------------------------
  // Submit claim transaction
  // -------------------------------------------------------------------
  const handleSubmitClaim = useCallback(async () => {
    if ((!escrowState && !tokenState) || !claimant || !signature || !publicKey) return;

    if (!claimId) {
      setClaimStatus('error');
      setClaimMessage('No active claim reference — please sign again.');
      return;
    }

    setClaimStatus('submitting');
    setClaimMessage('Submitting your signed claim...');

    const successMessage = (): string => {
      if (escrowState) {
        return `Claim confirmed! ANT ${antMint} has been released to ${claimant}.`;
      }
      const amountStr = formatMarioToArio(tokenState!.amount);
      return tokenState!.assetType === 'vault'
        ? `Claim confirmed! ${amountStr} ARIO vault has been released to ${claimant}.`
        : `Claim confirmed! ${amountStr} ARIO has been released to ${claimant}.`;
    };

    try {
      const protocol: ClaimProtocol =
        (escrowState?.recipientProtocol ?? tokenState?.recipientProtocol) ===
        'ethereum'
          ? 'ethereum'
          : 'arweave';

      if (protocol === 'arweave' && !arweaveModulus) {
        throw new Error(
          'Sign step did not capture an Arweave RSA modulus. Disconnect, reconnect, and sign again.',
        );
      }

      // Submit the signed proof. The claims service re-verifies the RSA-PSS /
      // secp256k1 signature against the frozen recipient identity + challenge,
      // and (on success) queues the on-chain delivery — no wallet tx needed.
      const completed = await completeClaim({
        claimId,
        protocol,
        signature,
        modulus: protocol === 'arweave' ? arweaveModulus! : undefined,
        saltLength: 32,
      });

      setClaimMessage(
        completed.status === 'pending_review'
          ? 'Your claim is verified and awaiting a quick operator review...'
          : 'Claim verified — waiting for delivery to your Solana wallet...',
      );

      // Poll for on-chain settlement (an off-chain dispatch worker delivers).
      const finalStatus = await waitForClaim(claimId, {
        timeoutMs: 30_000,
        intervalMs: 2_000,
      });

      if (finalStatus.status === 'confirmed') {
        if (finalStatus.txSignatures[0]) setTxSignature(finalStatus.txSignatures[0]);
        setClaimStatus('success');
        setClaimMessage(successMessage());
      } else if (
        finalStatus.status === 'rejected' ||
        finalStatus.status === 'failed'
      ) {
        setClaimStatus('error');
        setClaimMessage(
          `Claim ${finalStatus.status}: ${finalStatus.error ?? 'please contact support'}.`,
        );
      } else {
        // verified / pending_review / dispatching — accepted; delivery pending.
        setClaimStatus('success');
        setClaimMessage(
          completed.status === 'pending_review'
            ? 'Your claim was verified and is awaiting operator review. Your assets will be delivered to your Solana wallet shortly.'
            : 'Your claim was verified. Your assets are being delivered to your Solana wallet and will arrive shortly.',
        );
      }
    } catch (e) {
      setClaimStatus('error');
      const msg = e instanceof Error ? e.message : String(e);
      if (msg.includes('User rejected') || msg.includes('user rejected')) {
        setClaimMessage('Transaction cancelled by user.');
      } else {
        setClaimMessage(`Claim failed: ${msg}`);
      }
    }
  }, [
    escrowState,
    tokenState,
    claimant,
    signature,
    arweaveModulus,
    publicKey,
    claimId,
    antMint,
  ]);

  const hasSignature = !!signature;
  // Validate claimant is a plausible Solana base58 pubkey (32-44 chars, base58 alphabet)
  const isValidClaimant = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(claimant.trim());
  const hasEscrow = !!escrowState || !!tokenState;
  const canSign = hasEscrow && isValidClaimant && !signing;
  const canClaim = hasSignature && publicKey && claimStatus !== 'submitting';

  return (
    <div style={styles.wrap}>
      <h1 className="page-title" style={styles.h1}>Claim your assets</h1>
      <p style={styles.lede}>
        Someone escrowed an ANT or ARIO tokens for you. Sign with your
        Arweave or Ethereum wallet to release the assets to the Solana
        wallet you specify. If you received a claim link, the identifier
        is already filled in below.
      </p>

      {/* Identity-first lookup: connect your source wallet to find the
          assets waiting for you (claims API GET /v1/claimable). The paste-an
          -identifier path in step 1 still works for direct claim links. */}
      {!hasEscrow && (
        <div style={styles.discoverySection}>
          <p style={styles.hint} data-testid="find-assets-hint">
            Connect your Arweave or Ethereum wallet to find the assets waiting
            for you — or paste a claim identifier below.
          </p>
          <div style={{ display: 'flex', gap: '12px', flexWrap: 'wrap', marginTop: '10px' }}>
            <ArweaveWalletConnect
              onConnect={(addr) => setArweaveAddress(addr)}
              onDisconnect={() => {
                setArweaveAddress(undefined);
                setSignature(null);
                setArweaveModulus(null);
                setClaimId(null);
              }}
              connectedAddress={arweaveAddress}
            />
            <EthereumWalletConnect
              onConnect={(addr, provider) => {
                setEthereumAddress(addr);
                setEthereumProvider(provider);
              }}
              onDisconnect={() => {
                setEthereumAddress(undefined);
                setEthereumProvider(undefined);
                setSignature(null);
                setClaimId(null);
              }}
              connectedAddress={ethereumAddress}
            />
          </div>
        </div>
      )}

      <StepCard n={1} title="Escrow identifier" completed={hasEscrow}>
        <input
          type="text"
          placeholder="ANT mint or escrow address"
          value={antMint}
          onChange={(e) => setAntMint(e.target.value)}
          className="input"
          style={styles.input}
        />
        {escrowLoading && (
          <p style={styles.hint}>Loading escrow state...</p>
        )}
        {escrowError && (
          <p style={styles.errorHint}>{escrowError}</p>
        )}
        {escrowState && (
          <div style={styles.escrowCard}>
            <h3 style={styles.escrowCardTitle}>An ANT has been deposited for you</h3>
            <div style={styles.escrowCardRow}>
              <span style={styles.escrowCardLabel}>ANT Mint</span>
              <code style={styles.escrowCardValue}>{escrowState.antMint}</code>
            </div>
            <div style={styles.escrowCardRow}>
              <span style={styles.escrowCardLabel}>Your identity type</span>
              <span style={styles.escrowCardValue}>
                {escrowState.recipientProtocol === 'arweave'
                  ? 'Arweave'
                  : 'Ethereum'}
              </span>
            </div>
            <p style={styles.escrowCardNote}>
              To claim this ANT, connect the matching wallet below and
              sign the authorization message.
            </p>
          </div>
        )}
        {tokenState && (
          <div style={styles.escrowCard}>
            <h3 style={styles.escrowCardTitle}>
              {tokenState.assetType === 'vault' ? 'A vaulted ARIO deposit' : 'An ARIO token deposit'} has been escrowed for you
            </h3>
            <div style={styles.escrowCardRow}>
              <span style={styles.escrowCardLabel}>Amount</span>
              <span style={styles.escrowCardValue}>{formatMarioToArio(tokenState.amount)} ARIO</span>
            </div>
            <div style={styles.escrowCardRow}>
              <span style={styles.escrowCardLabel}>Type</span>
              <span style={styles.escrowCardValue}>
                {tokenState.assetType === 'vault' ? 'Vault (time-locked)' : 'Token'}
              </span>
            </div>
            {tokenState.assetType === 'vault' && tokenState.vaultEndTimestamp > 0n && (
              <div style={styles.escrowCardRow}>
                <span style={styles.escrowCardLabel}>
                  {Number(tokenState.vaultEndTimestamp) * 1000 > Date.now() ? 'Locked until' : 'Lock expired'}
                </span>
                <span style={styles.escrowCardValue}>
                  {new Date(Number(tokenState.vaultEndTimestamp) * 1000).toLocaleString()}
                  {Number(tokenState.vaultEndTimestamp) * 1000 > Date.now()
                    ? ' — your tokens will be placed in a vault'
                    : ' — you will receive liquid ARIO'}
                </span>
              </div>
            )}
            <div style={styles.escrowCardRow}>
              <span style={styles.escrowCardLabel}>Your identity type</span>
              <span style={styles.escrowCardValue}>
                {tokenState.recipientProtocol === 'arweave'
                  ? 'Arweave'
                  : 'Ethereum'}
              </span>
            </div>
            <p style={styles.escrowCardNote}>
              To claim this deposit, connect the matching wallet below
              and sign the authorization message.
            </p>
          </div>
        )}
      </StepCard>

      {/* Recipient discovery: shown when a source wallet is connected */}
      {(arweaveAddress || ethereumAddress) && (
        <div style={styles.discoverySection}>
          {recipientDiscoveryLoading && (
            <p style={styles.discoveryLoading}>Checking for escrows addressed to your wallet...</p>
          )}
          {recipientDiscoveryError && (
            <p style={styles.discoveryWarning}>{recipientDiscoveryError}</p>
          )}
          {recipientDiscoveryDone && !recipientDiscoveryError &&
            recipientEscrows.length === 0 && recipientTokenEscrows.length === 0 && (
            <p style={styles.hint}>
              No escrows found for this wallet. If you have a claim link, paste the ANT mint or escrow address above.
            </p>
          )}
          {(recipientEscrows.length > 0 || recipientTokenEscrows.length > 0) && (
            <div style={styles.discoveryList}>
              <p style={styles.discoveryTitle}>Escrows addressed to you</p>
              {recipientEscrows.map((e) => (
                <div key={e.antMint} style={styles.discoveryCard}>
                  <div style={styles.discoveryCardRow}>
                    <span style={styles.discoveryCardLabel}>ANT Mint</span>
                    <code style={styles.discoveryCardValue}>
                      {e.antMint.slice(0, 12)}...{e.antMint.slice(-4)}
                    </code>
                  </div>
                  <button
                    type="button"
                    style={styles.discoveryClaimButton}
                    onClick={() => setAntMint(e.antMint)}
                  >
                    Claim this ANT
                  </button>
                </div>
              ))}
              {recipientTokenEscrows.map((e) => (
                <div key={e.escrowPda} style={styles.discoveryCard}>
                  <div style={styles.discoveryCardRow}>
                    <span style={styles.discoveryCardLabel}>
                      {e.state.assetType === 'vault' ? 'Vault' : 'Tokens'}
                    </span>
                    <code style={styles.discoveryCardValue}>
                      {formatMarioToArio(e.state.amount)} ARIO
                    </code>
                  </div>
                  <div style={styles.discoveryCardRow}>
                    <span style={styles.discoveryCardLabel}>Escrow</span>
                    <code style={styles.discoveryCardValue}>
                      {e.escrowPda.slice(0, 12)}...{e.escrowPda.slice(-4)}
                    </code>
                  </div>
                  <button
                    type="button"
                    style={styles.discoveryClaimButton}
                    onClick={() => setAntMint(e.escrowPda)}
                  >
                    Claim {e.state.assetType === 'vault' ? 'this vault' : 'these tokens'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </div>
      )}

      <StepCard n={2} title="Solana destination wallet" completed={isValidClaimant} active={hasEscrow}>
        <input
          type="text"
          placeholder="Solana wallet address"
          value={claimant}
          onChange={(e) => {
            setClaimant(e.target.value);
            // Signature is bound to the claimant address — invalidate
            // if the address changes so the user must re-sign.
            if (signature) {
              setSignature(null);
              setArweaveModulus(null);
              setClaimId(null);
            }
          }}
          className="input"
          style={styles.input}
        />
        <p style={styles.hint}>
          The Solana wallet that will receive your assets. This address is
          locked into your signature — no one can redirect it.
        </p>
      </StepCard>

      <StepCard n={3} title="Sign authorization" completed={!!signature} active={isValidClaimant}>
        {/* Accurate description of what will be signed. The exact bytes are
            built by the claims service at sign time and shown by your wallet
            for approval — we don't render a client-side preview that could
            diverge from the message you actually sign. */}
        <div style={styles.signInfo}>
          <p style={styles.signInfoText}>
            You'll sign a one-time authorization proving you control your
            {activeProtocol === 'ethereum' ? ' Ethereum' : ' Arweave'} identity.
            It binds this claim to your Solana destination
            {isValidClaimant ? (
              <> (<code style={styles.code}>{claimant.slice(0, 4)}…{claimant.slice(-4)}</code>)</>
            ) : (
              <> (enter it in step 2 above)</>
            )}{' '}
            so no one else can redirect your assets.
          </p>
          <p style={styles.hint}>
            Your wallet will display the exact message to approve before you sign.
          </p>
        </div>

        {/* Source wallet connection */}
        {hasEscrow && (
          <div style={{ marginTop: '16px' }}>
            {activeProtocol === 'arweave' ? (
              <>
                <ArweaveWalletConnect
                  onConnect={(addr) => setArweaveAddress(addr)}
                  onDisconnect={() => {
                    setArweaveAddress(undefined);
                    setSignature(null);
                    setArweaveModulus(null);
                    setClaimId(null);
                  }}
                  connectedAddress={arweaveAddress}
                />
                {arweaveAddress && !hasSignature && (
                  <button
                    type="button"
                    style={{
                      ...styles.signButton,
                      opacity: canSign ? 1 : 0.6,
                      cursor: canSign ? 'pointer' : 'not-allowed',
                      marginTop: '12px',
                    }}
                    disabled={!canSign}
                    onClick={handleArweaveSign}
                  >
                    {signing ? 'Signing...' : 'Sign with Arweave wallet'}
                  </button>
                )}
              </>
            ) : (
              <>
                <EthereumWalletConnect
                  onConnect={(addr, provider) => {
                    setEthereumAddress(addr);
                    setEthereumProvider(provider);
                  }}
                  onDisconnect={() => {
                    setEthereumAddress(undefined);
                    setEthereumProvider(undefined);
                    setSignature(null);
                    setClaimId(null);
                  }}
                  connectedAddress={ethereumAddress}
                />
                {ethereumAddress && !hasSignature && (
                  <button
                    type="button"
                    style={{
                      ...styles.signButton,
                      opacity: canSign ? 1 : 0.6,
                      cursor: canSign ? 'pointer' : 'not-allowed',
                      marginTop: '12px',
                    }}
                    disabled={!canSign}
                    onClick={handleEthereumSign}
                  >
                    {signing ? 'Signing...' : 'Sign with Ethereum wallet'}
                  </button>
                )}
              </>
            )}
            {signError && <p style={styles.errorHint}>{signError}</p>}
            {hasSignature && (
              <div style={styles.signatureConfirm}>
                Signature captured. Ready to submit.
              </div>
            )}
          </div>
        )}
      </StepCard>

      <StepCard n={4} title="Submit claim" completed={claimStatus === 'success'} active={!!signature}>
        {!hasSignature ? (
          <p style={styles.hint}>
            Complete step 3 to enable the claim button.
          </p>
        ) : (
          <>
            <p style={styles.hint}>
              Connect a Solana wallet to submit the claim transaction.
              Anyone can be the fee payer — the ANT goes to the claimant
              address above regardless.
            </p>
            <div style={{ margin: '12px 0' }}>
              <SolanaWalletConnect
                onConnect={(pubkey) => setSolPubkey(pubkey)}
                onDisconnect={() => setSolPubkey(undefined)}
                connectedPubkey={solPubkey}
              />
            </div>
          </>
        )}

        {claimStatus === 'success' ? (
          <div style={styles.successBox}>
            <p style={styles.successText}>{claimMessage}</p>
            {txSignature && (
              <p style={styles.txLink}>
                <a
                  href={`https://explorer.solana.com/tx/${txSignature}`}
                  target="_blank"
                  rel="noopener noreferrer"
                  style={styles.link}
                >
                  View on Explorer
                </a>
              </p>
            )}
          </div>
        ) : claimStatus === 'error' ? (
          <div style={styles.errorBox}>
            <p style={styles.errorText}>{claimMessage}</p>
            <button
              type="button"
              style={{ ...styles.submit, opacity: 1 }}
              onClick={handleSubmitClaim}
            >
              Retry Claim
            </button>
          </div>
        ) : hasSignature ? (
          <>
            <button
              type="button"
              className="btn-primary"
              style={{
                ...styles.submit,
                opacity: canClaim ? 1 : 0.6,
                cursor: canClaim ? 'pointer' : 'not-allowed',
              }}
              disabled={!canClaim}
              onClick={handleSubmitClaim}
            >
              {claimStatus === 'submitting' ? 'Submitting claim...' : 'Submit claim'}
            </button>
            {claimStatus === 'submitting' && (
              <p style={styles.statusText}>{claimMessage}</p>
            )}
          </>
        ) : null}
      </StepCard>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hexToBytes(hex: string): Uint8Array {
  let h = hex.startsWith('0x') ? hex.slice(2) : hex;
  if (h.length % 2 !== 0) h = '0' + h;
  const bytes = new Uint8Array(h.length / 2);
  for (let i = 0; i < bytes.length; i++) {
    bytes[i] = parseInt(h.slice(i * 2, i * 2 + 2), 16);
  }
  return bytes;
}

const styles: Record<string, React.CSSProperties> = {
  wrap: {
    maxWidth: '900px',
    width: '100%',
    display: 'flex',
    flexDirection: 'column',
    gap: '24px',
  },
  h1: {
    fontFamily: "'Besley', Georgia, serif",
    fontSize: '40px',
    fontWeight: 700,
    color: brand.black,
    lineHeight: 1.15,
    margin: 0,
  },
  lede: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '17px',
    lineHeight: 1.7,
    color: brand.textSecondary,
    marginTop: '-8px',
  },
  input: {
    width: '100%',
    padding: '11px 14px',
    fontSize: '14px',
    border: `1px solid ${brand.border}`,
    borderRadius: '16px',
    background: brand.white,
    fontFamily: 'monospace',
    outline: 'none',
    transition: 'border-color 0.15s, box-shadow 0.15s',
  },
  hint: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.textTertiary,
    margin: '8px 0 0',
  },
  successHint: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.success,
    margin: '8px 0 0',
  },
  errorHint: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.error,
    margin: '8px 0 0',
  },
  escrowCard: {
    marginTop: '12px',
    padding: '24px',
    background: `radial-gradient(ellipse 140% 120% at top left, rgba(84, 39, 200, 0.03), transparent), rgba(255, 255, 255, 0.85)`,
    border: `1px solid ${brand.border}`,
    borderRadius: '16px',
    boxShadow: '0 1px 3px rgba(35, 35, 45, 0.04)',
  },
  escrowCardTitle: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '16px',
    fontWeight: 700,
    color: brand.black,
    margin: '0 0 16px',
  },
  escrowCardRow: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
    marginBottom: '10px',
  },
  escrowCardLabel: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '11px',
    fontWeight: 700,
    color: brand.textTertiary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  escrowCardValue: {
    fontSize: '13px',
    color: brand.black,
    fontFamily: 'monospace',
    wordBreak: 'break-all' as const,
  },
  escrowCardNote: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    lineHeight: 1.5,
    color: brand.textSecondary,
    margin: '14px 0 0',
    paddingTop: '12px',
    borderTop: `1px solid ${brand.border}`,
  },
  code: {
    fontFamily: 'monospace',
    fontSize: '12px',
    background: 'rgba(84, 39, 200, 0.06)',
    padding: '2px 6px',
    borderRadius: '4px',
    margin: '0 4px',
    color: brand.black,
  },
  signInfo: {
    background: brand.cardSurface,
    border: `1px solid ${brand.border}`,
    borderRadius: '16px',
    padding: '16px',
  },
  signInfoText: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '14px',
    lineHeight: 1.6,
    color: brand.textSecondary,
    margin: 0,
  },
  signButton: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    padding: '10px 18px',
    border: 'none',
    borderRadius: '16px',
    background: brand.primary,
    color: brand.white,
    fontSize: '14px',
    fontWeight: 700,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
  signatureConfirm: {
    marginTop: '12px',
    padding: '10px 14px',
    background: brand.successBg,
    border: `1px solid ${brand.success}33`,
    borderRadius: '16px',
    fontSize: '13px',
    color: brand.success,
    fontWeight: 600,
    fontFamily: "'Plus Jakarta Sans', sans-serif",
  },
  submit: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    padding: '12px 24px',
    border: 'none',
    borderRadius: '16px',
    background: brand.primary,
    color: brand.white,
    fontSize: '15px',
    fontWeight: 700,
    cursor: 'pointer',
    transition: 'all 0.2s ease',
  },
  statusText: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.primary,
    marginTop: '8px',
  },
  successBox: {
    padding: '16px',
    background: brand.successBg,
    borderRadius: '16px',
    border: `1px solid ${brand.success}33`,
  },
  successText: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '14px',
    color: brand.success,
    fontWeight: 600,
    margin: 0,
  },
  txLink: {
    fontSize: '13px',
    margin: '8px 0 0',
  },
  errorBox: {
    padding: '14px 16px',
    background: brand.errorBg,
    borderRadius: '16px',
    border: `1px solid ${brand.error}33`,
  },
  errorText: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '14px',
    color: brand.error,
    margin: '0 0 12px',
  },
  link: { color: brand.primary, textDecoration: 'none' },
  discoverySection: {
    marginTop: '-8px',
  },
  discoveryLoading: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.textTertiary,
    margin: '0',
    fontStyle: 'italic' as const,
  },
  discoveryWarning: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    color: brand.textTertiary,
    margin: '0',
  },
  discoveryList: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '8px',
  },
  discoveryTitle: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '14px',
    fontWeight: 700,
    color: brand.black,
    margin: '0 0 4px',
  },
  discoveryCard: {
    padding: '16px 20px',
    background: `radial-gradient(ellipse 140% 120% at top left, rgba(84, 39, 200, 0.03), transparent), rgba(255, 255, 255, 0.85)`,
    border: `1px solid ${brand.border}`,
    borderRadius: '16px',
    boxShadow: '0 1px 3px rgba(35, 35, 45, 0.04)',
    display: 'flex',
    alignItems: 'center',
    gap: '16px',
    flexWrap: 'wrap' as const,
  },
  discoveryCardRow: {
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '2px',
    minWidth: '120px',
  },
  discoveryCardLabel: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '11px',
    fontWeight: 700,
    color: brand.textTertiary,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.5px',
  },
  discoveryCardValue: {
    fontSize: '13px',
    color: brand.black,
    fontFamily: 'monospace',
    wordBreak: 'break-all' as const,
  },
  discoveryClaimButton: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    padding: '8px 16px',
    border: `1px solid ${brand.border}`,
    borderRadius: '16px',
    background: brand.cardSurface,
    color: brand.black,
    fontSize: '13px',
    fontWeight: 600,
    cursor: 'pointer',
    marginLeft: 'auto',
    transition: 'all 0.15s',
  },
};
