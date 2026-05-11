import React, { useState, useCallback, useEffect } from "react";
import { brand } from "../brand.js";
import { WanderIcon } from "./WalletIcons.tsx";

interface ArweaveWalletConnectProps {
    onConnect: (address: string) => void;
    onDisconnect: () => void;
    connectedAddress?: string;
}

export function ArweaveWalletConnect({
    onConnect,
    onDisconnect,
    connectedAddress,
}: ArweaveWalletConnectProps) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [isWalletAvailable, setIsWalletAvailable] = useState(false);

    const styles = getStyles();

    // Detect available Arweave wallets
    useEffect(() => {
        const detectWallets = () => {
            setIsWalletAvailable(!!(window as any).arweaveWallet);
        };

        detectWallets();
        
        // Re-detect wallets if window object changes
        const interval = setInterval(detectWallets, 1000);
        return () => clearInterval(interval);
    }, []);

    const executeWithTimeout = async <T,>(
        fn: () => Promise<T>,
        timeoutMs: number = 60000,
    ): Promise<T> => {
        return Promise.race([
            fn(),
            new Promise<T>((_, reject) =>
                setTimeout(
                    () => reject(new Error("Operation timed out")),
                    timeoutMs,
                ),
            ),
        ]);
    };

    const handleConnect = useCallback(async () => {
        if (!isWalletAvailable) {
            setError("No compatible Arweave wallet found. Please install the Wander wallet extension.");
            return;
        }
        
        setError(null);
        setLoading(true);

        try {
            // Connect with required permissions
            await executeWithTimeout(async () => {
                if (!(window as any).arweaveWallet) {
                    throw new Error("Wander wallet extension not found.");
                }
                await (window as any).arweaveWallet.connect([
                    "ACCESS_ADDRESS",
                    "SIGN_TRANSACTION",
                    "ACCESS_PUBLIC_KEY",
                    "DISPATCH",
                    "SIGNATURE", // Required for Turbo SDK file upload signing
                ]);
            });

            const address = await executeWithTimeout(async () => {
                return await (window as any).arweaveWallet.getActiveAddress();
            });

            if (!address) {
                throw new Error("Failed to get Arweave address from wallet.");
            }

            onConnect(address);
        } catch (err) {
            const message =
                err instanceof Error
                    ? err.message
                    : "Failed to connect Arweave wallet";
            setError(message);
        } finally {
            setLoading(false);
        }
    }, [isWalletAvailable, onConnect]);

    const handleDisconnect = useCallback(async () => {
        try {
            if ((window as any).arweaveWallet) {
                await executeWithTimeout(async () => {
                    await (window as any).arweaveWallet.disconnect();
                });
            }
        } catch {
            // Ignore disconnect errors and timeouts
        }
        onDisconnect();
    }, [onDisconnect]);

    if (connectedAddress) {
        return (
            <div style={styles.connected}>
                <div className="connected-dot" style={styles.connectedDot} />
                <div style={styles.connectedInfo}>
                    <span style={styles.connectedLabel}>
                        Arweave Wallet Connected (Wander)
                    </span>
                    <code style={styles.address}>{connectedAddress}</code>
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

    if (!isWalletAvailable) {
        return (
            <div style={styles.wrapper}>
                <div style={styles.noWallet}>
                    <div style={styles.noWalletTitle}>
                        No Arweave wallet detected
                    </div>
                    <p style={styles.noWalletText}>
                        You need the Wander wallet extension to connect your
                        Arweave address.
                    </p>
                    <a
                        href="https://wander.app"
                        target="_blank"
                        rel="noopener noreferrer"
                        className="btn-secondary"
                        style={styles.installLink}
                    >
                        <WanderIcon /> Install Wander
                    </a>
                    <p style={styles.hint}>
                        After installing, refresh this page.
                    </p>
                </div>
            </div>
        );
    }

    return (
        <div style={styles.wrapper}>
            <button
                className="btn-secondary"
                onClick={handleConnect}
                disabled={loading}
            >
                {loading ? "Connecting..." : "Connect Wander Wallet"}
            </button>
            {error && <p style={styles.error}>{error}</p>}
            <p style={styles.hint}>
                Connect your Arweave address using the{" "}
                <a
                    href="https://wander.app"
                    target="_blank"
                    rel="noopener noreferrer"
                    style={styles.link}
                >
                    Wander
                </a>{" "}
                wallet extension.
            </p>
        </div>
    );
}

function getStyles(): Record<string, React.CSSProperties> {
    return {
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
        installLink: {
            textDecoration: "none",
            fontSize: "13px",
            padding: "8px 16px",
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
            alignSelf: "flex-start",
        },
        wrapper: {
            display: "flex",
            flexDirection: "column",
            gap: "10px",
        },
        error: {
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            fontSize: "13px",
            color: brand.error,
            margin: 0,
        },
        hint: {
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            fontSize: "12px",
            color: brand.textTertiary,
            margin: 0,
        },
        link: {
            color: brand.primary,
            textDecoration: "none",
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
