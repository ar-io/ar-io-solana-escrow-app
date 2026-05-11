import React, { useEffect } from "react";
import { useWallet } from "@solana/wallet-adapter-react";
import { useWalletModal } from "@solana/wallet-adapter-react-ui";
import { brand } from "../brand.js";
import { PhantomIcon, SolflareIcon, BackpackIcon } from "./WalletIcons.tsx";

export interface SolanaWalletConnectProps {
    onConnect: (pubkey: string) => void;
    onDisconnect: () => void;
    connectedPubkey?: string;
}

export function SolanaWalletConnect({
    onConnect,
    onDisconnect,
    connectedPubkey,
}: SolanaWalletConnectProps) {
    const { publicKey, connected, wallet, wallets, connect, disconnect } =
        useWallet();
    const { setVisible } = useWalletModal();

    const styles = getStyles();

    // Auto-connect once a wallet is selected from the modal
    useEffect(() => {
        if (wallet && !connected && !connectedPubkey) {
            connect().catch(() => {
                // User rejected or wallet error — ignore
            });
        }
    }, [wallet, connected, connectedPubkey, connect]);

    // Notify parent once connected — single effect handles both fresh
    // connections and already-connected wallets
    useEffect(() => {
        if (connected && publicKey && !connectedPubkey) {
            onConnect(publicKey.toBase58());
        }
    }, [connected, publicKey, connectedPubkey, onConnect]);

    const handleDisconnect = async () => {
        try {
            await disconnect();
        } catch {
            // Ignore disconnect errors
        }
        onDisconnect();
    };

    if (connectedPubkey) {
        return (
            <div style={styles.connected}>
                <div className="connected-dot" style={styles.connectedDot} />
                <div style={styles.connectedInfo}>
                    <span style={styles.connectedLabel}>
                        Solana Wallet Connected
                    </span>
                    <code style={styles.address}>{connectedPubkey}</code>
                </div>
                <button
                    className="btn-text"
                    onClick={handleDisconnect}
                    style={{ marginLeft: "auto" }}
                >
                    Change wallet
                </button>
            </div>
        );
    }

    const hasWallets = wallets.length > 0;

    if (!hasWallets) {
        return (
            <div style={styles.wrapper}>
                <div style={styles.noWallet}>
                    <div style={styles.noWalletTitle}>
                        No Solana wallet detected
                    </div>
                    <p style={styles.noWalletText}>
                        You need a Solana wallet to interact with the escrow
                        program — depositing ANTs, submitting claims, or
                        paying transaction fees.
                    </p>
                    <div style={styles.walletLinks}>
                        <a
                            href="https://phantom.app"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn-secondary"
                            style={styles.walletLink}
                        >
                            <PhantomIcon /> Phantom
                        </a>
                        <a
                            href="https://solflare.com"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn-secondary"
                            style={styles.walletLink}
                        >
                            <SolflareIcon /> Solflare
                        </a>
                        <a
                            href="https://backpack.app"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn-secondary"
                            style={styles.walletLink}
                        >
                            <BackpackIcon /> Backpack
                        </a>
                    </div>
                    <p style={styles.hint}>
                        After installing, refresh this page.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div style={styles.wrapper}>
            <button className="btn-secondary" onClick={() => setVisible(true)}>
                Select Solana Wallet
            </button>
            <p style={styles.hint}>
                Choose from available Solana wallets (Phantom, Solflare, etc.)
                to interact with the ANT escrow program.
            </p>
        </div>
    );
}

function getStyles(): Record<string, React.CSSProperties> {
    return {
        wrapper: {
            display: "flex",
            flexDirection: "column",
            gap: "10px",
        },
        hint: {
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            fontSize: "12px",
            color: brand.textTertiary,
            margin: 0,
        },
        noWallet: {
            padding: "16px",
            background: brand.cardSurface,
            borderRadius: "12px",
            border: `1px solid ${brand.border}`,
            display: "flex",
            flexDirection: "column",
            gap: "8px",
        },
        noWalletTitle: {
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            fontSize: "14px",
            fontWeight: 700,
            color: brand.black,
        },
        noWalletText: {
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            fontSize: "13px",
            color: brand.textSecondary,
            lineHeight: 1.5,
            margin: 0,
        },
        walletLinks: {
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
        },
        walletLink: {
            textDecoration: "none",
            fontSize: "13px",
            padding: "8px 16px",
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
        },
        connected: {
            display: "flex",
            alignItems: "center",
            gap: "10px",
        },
        connectedDot: {
            width: "8px",
            height: "8px",
            borderRadius: "50%",
            background: brand.success,
            flexShrink: 0,
        },
        connectedInfo: {
            display: "flex",
            flexDirection: "column",
            gap: "2px",
        },
        connectedLabel: {
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            fontSize: "13px",
            fontWeight: 600,
            color: brand.success,
        },
        address: {
            fontFamily: "monospace",
            fontSize: "12px",
            color: brand.textSecondary,
            wordBreak: "break-all" as const,
        },
    };
}
