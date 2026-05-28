import React, { useMemo, useState, useEffect } from 'react';
import {
  ConnectionProvider as _ConnectionProvider,
  WalletProvider as _WalletProvider,
} from '@solana/wallet-adapter-react';
import { WalletModalProvider as _WalletModalProvider } from '@solana/wallet-adapter-react-ui';

import { LandingPage } from './pages/LandingPage.tsx';
import { DepositPage } from './pages/DepositPage.tsx';
import { DepositTokensPage } from './pages/DepositTokensPage.tsx';
import { DepositVaultPage } from './pages/DepositVaultPage.tsx';
import { ClaimPage } from './pages/ClaimPage.tsx';
import { ManagePage } from './pages/ManagePage.tsx';
import { LookupPage } from './pages/LookupPage.tsx';
import { AttestorHealthBanner } from './components/AttestorHealthBanner.tsx';
import { ProgramConfigBanner } from './components/ProgramConfigBanner.tsx';
import {
  getEscrowProgramId,
  setEscrowProgramId,
  getArioMintOverride,
  setArioMint,
  areDepositsEnabled,
} from './services/solana.ts';

import '@solana/wallet-adapter-react-ui/styles.css';

// React 18/19 type compatibility shim for wallet-adapter
/* eslint-disable @typescript-eslint/no-explicit-any */
const ConnectionProvider = _ConnectionProvider as any;
const WalletProvider = _WalletProvider as any;
const WalletModalProvider = _WalletModalProvider as any;

// Import + re-export: brand is used in this file's styles AND by pages
// that previously imported from App.tsx. Source of truth is brand.ts
// (breaks the circular-import TDZ that crashed LandingPage).
import { brand } from './brand.js';
export { brand };

function ArioLogo() {
  return (
    <svg width="120" height="35" viewBox="0 0 1296 381" fill="none" xmlns="http://www.w3.org/2000/svg" aria-label="AR.IO">
      <path d="M1035.01 60.5C924.55 60.5 835.01 150.04 835.01 260.5V320.5H895.01V280.5C895.01 263.93 908.44 250.5 925.01 250.5C933.29 250.5 940.79 253.86 946.22 259.29C951.65 264.72 955.01 272.22 955.01 280.5V320.5H1015.01V300.5C1015.01 256.32 1050.83 220.5 1095.01 220.5C1139.19 220.5 1175.01 256.32 1175.01 300.5V320.5H1235.01V260.5C1235.01 150.04 1145.47 60.5 1035.01 60.5ZM925.01 220.5C908.44 220.5 895.01 207.07 895.01 190.5C895.01 173.93 908.44 160.5 925.01 160.5C941.58 160.5 955.01 173.93 955.01 190.5C955.01 207.07 941.58 220.5 925.01 220.5Z" fill="#23232D"/>
      <path d="M237.05 95.77C217.12 85.59 194.33 80.5 168.67 80.5C129.24 80.5 101.43 90.82 85.2298 111.47C75.0498 124.66 69.3198 141.5 68.0298 162.01H127.17C128.6 152.98 131.47 145.81 135.77 140.51C141.79 133.34 152.04 129.76 166.52 129.76C179.42 129.76 189.21 131.59 195.88 135.25C202.54 138.9 205.88 145.54 205.88 155.14C205.88 163.03 201.5 168.83 192.76 172.56C187.89 174.71 179.78 176.51 168.46 177.94L147.6 180.52C123.94 183.53 106.02 188.55 93.8398 195.57C71.6198 208.47 60.5098 229.33 60.5098 258.15C60.5098 280.37 67.4298 297.54 81.2598 309.65C95.0898 321.76 112.62 327.82 133.84 327.82C150.47 327.82 165.38 324.02 178.57 316.42C189.61 309.97 199.35 302.16 207.82 292.98V320.51H266.96V153.42C266.96 125.18 256.99 105.97 237.07 95.79L237.05 95.77ZM205.66 229.32C205.23 249.82 199.46 263.94 188.35 271.68C177.24 279.42 165.09 283.29 151.9 283.29C143.58 283.29 136.56 280.92 130.83 276.19C124.95 271.6 122.01 264.08 122.01 253.61C122.01 241.86 126.74 233.18 136.2 227.59C141.79 224.29 151.04 221.5 163.94 219.2L177.7 216.62C184.58 215.33 189.99 213.93 193.93 212.43C197.87 210.93 201.78 208.96 205.65 206.52V229.31L205.66 229.32Z" fill="#23232D"/>
      <path d="M405.44 142.65C380.78 142.65 364.22 150.68 355.76 166.74C351.03 175.77 348.66 189.68 348.66 208.46V320.5H286.94V86.09H345.43V126.95C354.89 111.33 363.14 100.64 370.16 94.91C381.63 85.31 396.54 80.5 414.89 80.5C416.04 80.5 417 80.54 417.79 80.61C418.58 80.68 420.33 80.79 423.06 80.93V143.72C419.19 143.29 415.75 143 412.74 142.86C409.73 142.72 407.29 142.64 405.43 142.64L405.44 142.65Z" fill="#23232D"/>
      <path d="M535.02 159.49H472.87V320.5H535.02V159.49Z" fill="#23232D"/>
      <path d="M504.49 80.5H503.41C485.714 80.5 471.37 94.8448 471.37 112.54C471.37 130.235 485.714 144.58 503.41 144.58H504.49C522.185 144.58 536.53 130.235 536.53 112.54C536.53 94.8448 522.185 80.5 504.49 80.5Z" fill="#23232D"/>
      <path d="M764.83 117.42C784.61 142.03 794.51 171.12 794.51 204.69C794.51 238.26 784.62 268.03 764.83 292.28C745.05 316.54 715.01 328.66 674.73 328.66C634.45 328.66 604.41 316.53 584.63 292.28C564.85 268.03 554.95 238.83 554.95 204.69C554.95 170.55 564.84 142.03 584.63 117.42C604.41 92.81 634.45 80.5 674.73 80.5C715.01 80.5 745.05 92.81 764.83 117.42ZM674.51 131.93C656.59 131.93 642.79 138.22 633.11 150.82C623.44 163.41 618.6 181.37 618.6 204.7C618.6 228.03 623.44 246.03 633.11 258.69C642.79 271.35 656.58 277.68 674.51 277.68C692.44 277.68 706.19 271.35 715.8 258.69C725.4 246.03 730.21 228.04 730.21 204.7C730.21 181.36 725.4 163.41 715.8 150.82C706.19 138.23 692.43 131.93 674.51 131.93Z" fill="#23232D"/>
      <path d="M423.07 320.51C439.638 320.51 453.07 307.079 453.07 290.51C453.07 273.941 439.638 260.51 423.07 260.51C406.501 260.51 393.07 273.941 393.07 290.51C393.07 307.079 406.501 320.51 423.07 320.51Z" fill="#23232D"/>
    </svg>
  );
}

function MenuIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="4" y1="6" x2="20" y2="6" />
      <line x1="4" y1="12" x2="20" y2="12" />
      <line x1="4" y1="18" x2="20" y2="18" />
    </svg>
  );
}

function CloseIcon() {
  return (
    <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round">
      <line x1="6" y1="6" x2="18" y2="18" />
      <line x1="6" y1="18" x2="18" y2="6" />
    </svg>
  );
}

/** Hash-based routing — same lightweight approach as the registration app. */
function useHashRoute(): { route: string; query: URLSearchParams } {
  const [hash, setHash] = useState(window.location.hash || '#/');

  useEffect(() => {
    const onHashChange = () => setHash(window.location.hash || '#/');
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  // hash format: "#/<route>?<query>" or "#/"
  const stripped = hash.replace(/^#\//, '');
  const [path, qs = ''] = stripped.split('?');
  return {
    route: path || 'home',
    query: new URLSearchParams(qs),
  };
}

function Router({ route, query, depositsOn }: { route: string; query: URLSearchParams; depositsOn: boolean }) {
  switch (route) {
    case 'deposit':
      return depositsOn ? <DepositPage /> : <LandingPage />;
    case 'deposit-tokens':
      return depositsOn ? <DepositTokensPage /> : <LandingPage />;
    case 'deposit-vault':
      return depositsOn ? <DepositVaultPage /> : <LandingPage />;
    case 'claim':
      return <ClaimPage antMint={query.get('ant') ?? ''} />;
    case 'manage':
      return <ManagePage antMint={query.get('ant') ?? ''} />;
    case 'lookup':
      return <LookupPage initialAntMint={query.get('ant') ?? ''} />;
    case 'home':
    case '':
    default:
      return <LandingPage />;
  }
}

const RPC_PRESETS: Record<string, string> = {
  mainnet: 'https://api.mainnet-beta.solana.com',
  devnet: 'https://api.devnet.solana.com',
  localnet: 'http://127.0.0.1:8899',
};

function getInitialRpc(): string {
  const saved = localStorage.getItem('escrow-rpc-url');
  if (saved) return saved;
  return import.meta.env.VITE_SOLANA_RPC_URL || RPC_PRESETS.mainnet;
}

function getPresetName(url: string): string {
  for (const [name, preset] of Object.entries(RPC_PRESETS)) {
    if (url === preset) return name;
  }
  return 'custom';
}

export function App() {
  const [rpcUrl, setRpcUrl] = useState(getInitialRpc);
  const [showCustom, setShowCustom] = useState(
    () => getPresetName(getInitialRpc()) === 'custom',
  );
  const endpoint = useMemo(() => rpcUrl, [rpcUrl]);
  const wallets = useMemo(() => [], []);
  const { route, query } = useHashRoute();

  const [programId, setProgramId] = useState(() => getEscrowProgramId() ?? '');
  const [arioMint, setArioMintState] = useState(() => getArioMintOverride());
  const depositsOn = areDepositsEnabled();
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    if (!menuOpen) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') setMenuOpen(false);
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [menuOpen]);

  const handleProgramIdChange = (value: string) => {
    const trimmed = value.trim();
    setProgramId(trimmed);
    setEscrowProgramId(trimmed);
    window.location.reload();
  };

  const handleArioMintChange = (value: string) => {
    const trimmed = value.trim();
    setArioMintState(trimmed);
    setArioMint(trimmed);
    window.location.reload();
  };

  const handleRpcChange = (value: string) => {
    if (value === 'custom') {
      setShowCustom(true);
      return;
    }
    setShowCustom(false);
    setRpcUrl(value);
    localStorage.setItem('escrow-rpc-url', value);
    window.location.reload();
  };

  const handleCustomRpc = (url: string) => {
    setRpcUrl(url);
    localStorage.setItem('escrow-rpc-url', url);
    window.location.reload();
  };

  return (
    <ConnectionProvider endpoint={endpoint}>
      <WalletProvider wallets={wallets}>
        <WalletModalProvider>
          <div style={styles.container}>
            <ProgramConfigBanner />
            <AttestorHealthBanner />
            <header className="app-header" style={styles.header}>
              <a href="#/" style={styles.logoLink}>
                <ArioLogo />
                <span style={styles.badge}>Escrow</span>
              </a>
              <div style={styles.menuWrapper}>
                <button
                  className="menu-button"
                  onClick={() => setMenuOpen(!menuOpen)}
                  style={styles.menuButton}
                  aria-label={menuOpen ? 'Close menu' : 'Open menu'}
                >
                  {menuOpen ? <CloseIcon /> : <MenuIcon />}
                </button>
                {menuOpen && (
                  <>
                    <div
                      style={styles.menuBackdrop}
                      onClick={() => setMenuOpen(false)}
                    />
                    <div className="menu-panel" style={styles.menuPanel}>
                      <nav style={styles.menuNav}>
                        {([
                          ...(depositsOn ? [
                            ['#/deposit', 'deposit', 'Deposit ANT'],
                            ['#/deposit-tokens', 'deposit-tokens', 'Deposit Tokens'],
                            ['#/deposit-vault', 'deposit-vault', 'Deposit Vault'],
                          ] as const : []),
                          ['#/claim', 'claim', 'Claim'],
                          ['#/manage', 'manage', 'Manage'],
                          ['#/lookup', 'lookup', 'Lookup'],
                        ] as const).map(([href, target, label]) => (
                          <a
                            key={target}
                            href={href}
                            className={`menu-nav-link ${route === target ? 'menu-nav-link--active' : ''}`}
                            onClick={() => setMenuOpen(false)}
                          >
                            {label}
                          </a>
                        ))}
                      </nav>
                      <div style={styles.menuDivider} />
                      <div style={styles.menuSection}>
                        <span style={styles.menuSectionLabel}>Settings</span>
                        <label style={styles.menuLabel}>RPC Endpoint</label>
                        <select
                          value={showCustom ? 'custom' : rpcUrl}
                          onChange={(e) => handleRpcChange(e.target.value)}
                          style={styles.menuSelect}
                        >
                          {Object.entries(RPC_PRESETS).map(([name, url]) => (
                            <option key={name} value={url}>
                              {name}
                            </option>
                          ))}
                          <option value="custom">custom</option>
                        </select>
                        {showCustom && (
                          <input
                            type="text"
                            defaultValue={rpcUrl}
                            placeholder="https://..."
                            onKeyDown={(e) => {
                              if (e.key === 'Enter')
                                handleCustomRpc(
                                  (e.target as HTMLInputElement).value,
                                );
                            }}
                            onBlur={(e) => handleCustomRpc(e.target.value)}
                            style={styles.menuInput}
                          />
                        )}
                        <label style={styles.menuLabel}>
                          Escrow Program ID
                        </label>
                        <input
                          type="text"
                          defaultValue={programId}
                          placeholder="Required for escrow actions"
                          title={
                            'Escrow program ID. Required — the SDK ships no ' +
                            'program ID for public clusters. Press Enter to apply (reloads).'
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter')
                              handleProgramIdChange(
                                (e.target as HTMLInputElement).value,
                              );
                          }}
                          onBlur={(e) => {
                            if (e.target.value.trim() !== programId)
                              handleProgramIdChange(e.target.value);
                          }}
                          style={{
                            ...styles.menuInput,
                            borderColor: programId
                              ? brand.border
                              : brand.warning,
                          }}
                        />
                        <label style={styles.menuLabel}>ARIO Mint</label>
                        <input
                          type="text"
                          defaultValue={arioMint}
                          placeholder="Auto-detected"
                          title={
                            'ARIO SPL mint override. Leave blank for network ' +
                            'default. Press Enter to apply (reloads).'
                          }
                          onKeyDown={(e) => {
                            if (e.key === 'Enter')
                              handleArioMintChange(
                                (e.target as HTMLInputElement).value,
                              );
                          }}
                          onBlur={(e) => {
                            if (e.target.value.trim() !== arioMint)
                              handleArioMintChange(e.target.value);
                          }}
                          style={styles.menuInput}
                        />
                      </div>
                      <div style={styles.menuDivider} />
                      <div style={styles.menuLinks}>
                        <a
                          href="https://docs.ar.io"
                          target="_blank"
                          rel="noopener noreferrer"
                          className="menu-ext-link"
                        >
                          Docs
                        </a>
                      </div>
                    </div>
                  </>
                )}
              </div>
            </header>
            <main className="app-main" style={styles.main}>
              <Router route={route} query={query} depositsOn={depositsOn} />
            </main>
            <footer style={styles.footer}>
              <a
                href="https://ar.io"
                target="_blank"
                rel="noopener noreferrer"
                style={styles.footerLink}
              >
                ar.io
              </a>
              <span style={styles.footerDot}>&middot;</span>
              <span style={styles.footerVersion}>
                v{import.meta.env.PACKAGE_VERSION}
              </span>
            </footer>
          </div>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

const styles: Record<string, React.CSSProperties> = {
  container: {
    minHeight: '100vh',
    display: 'flex',
    flexDirection: 'column',
    background: `
      radial-gradient(ellipse 70% 50% at 10% 100%, rgba(84, 39, 200, 0.08), transparent 70%),
      linear-gradient(180deg, ${brand.white} 0%, rgba(223, 214, 247, 0.25) 25%, rgba(223, 214, 247, 0.5) 100%)
    `,
  },
  header: {
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'space-between',
    padding: '16px 40px',
    borderBottom: `1px solid ${brand.border}`,
    background: 'rgba(255,255,255,0.8)',
    backdropFilter: 'blur(16px)',
    WebkitBackdropFilter: 'blur(16px)',
    position: 'sticky' as const,
    top: 0,
    zIndex: 50,
  },
  logoLink: {
    display: 'flex',
    alignItems: 'center',
    gap: '14px',
    textDecoration: 'none',
    color: 'inherit',
  },
  badge: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '11px',
    fontWeight: 700,
    color: '#FFFFFF',
    background: brand.black,
    padding: '4px 10px',
    borderRadius: '6px',
    textTransform: 'uppercase' as const,
    letterSpacing: '0.8px',
    display: 'inline-flex',
    alignItems: 'center',
    gap: '6px',
  },
  main: {
    flex: 1,
    display: 'flex',
    justifyContent: 'center',
    padding: '32px 24px',
  },
  /* ── Menu ── */
  menuWrapper: {
    position: 'relative' as const,
  },
  menuButton: {
    background: 'none',
    border: `1px solid ${brand.border}`,
    borderRadius: '8px',
    padding: '6px 8px',
    cursor: 'pointer',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    color: brand.textSecondary,
    transition: 'border-color 0.15s, color 0.15s',
  },
  menuBackdrop: {
    position: 'fixed' as const,
    top: 0,
    right: 0,
    bottom: 0,
    left: 0,
    zIndex: 90,
  },
  menuPanel: {
    position: 'absolute' as const,
    top: 'calc(100% + 8px)',
    right: 0,
    width: '300px',
    maxWidth: 'calc(100vw - 32px)',
    maxHeight: 'calc(100vh - 80px)',
    overflowY: 'auto' as const,
    background: '#FFFFFF',
    border: `1px solid ${brand.border}`,
    borderRadius: '12px',
    boxShadow: '0 8px 30px rgba(35, 35, 45, 0.12)',
    zIndex: 100,
  },
  menuNav: {
    display: 'flex',
    flexDirection: 'column' as const,
    padding: '8px',
  },
  menuDivider: {
    height: '1px',
    background: brand.border,
    margin: '4px 16px',
  },
  menuSection: {
    padding: '8px 16px',
    display: 'flex',
    flexDirection: 'column' as const,
    gap: '6px',
  },
  menuSectionLabel: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '11px',
    fontWeight: 700,
    textTransform: 'uppercase' as const,
    letterSpacing: '0.8px',
    color: brand.textTertiary,
  },
  menuLabel: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '12px',
    fontWeight: 600,
    color: brand.textSecondary,
  },
  menuSelect: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '13px',
    padding: '6px 10px',
    border: `1px solid ${brand.border}`,
    borderRadius: '8px',
    background: '#FFFFFF',
    color: brand.black,
    cursor: 'pointer',
    outline: 'none',
  },
  menuInput: {
    fontFamily: 'monospace',
    fontSize: '12px',
    padding: '6px 10px',
    border: `1px solid ${brand.border}`,
    borderRadius: '8px',
    color: brand.textSecondary,
    outline: 'none',
    width: '100%',
    boxSizing: 'border-box' as const,
  },
  menuLinks: {
    display: 'flex',
    gap: '16px',
    padding: '8px 16px 12px',
  },
  /* ── Footer ── */
  footer: {
    display: 'flex',
    justifyContent: 'center',
    alignItems: 'center',
    gap: '12px',
    padding: '16px 20px',
    fontSize: '13px',
    fontWeight: 600,
    color: brand.textTertiary,
    borderTop: `1px solid ${brand.border}`,
  },
  footerLink: {
    color: brand.textSecondary,
    textDecoration: 'none',
    transition: 'color 0.15s',
  },
  footerDot: {
    color: brand.textTertiary,
  },
  footerVersion: {
    fontFamily: "'Plus Jakarta Sans', sans-serif",
    fontSize: '12px',
    color: brand.textTertiary,
  },
};
