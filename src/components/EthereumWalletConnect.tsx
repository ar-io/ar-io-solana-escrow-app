import React, { useState, useCallback, useEffect } from "react";
import { brand } from "../brand.js";
import { MetaMaskIcon, CoinbaseIcon } from "./WalletIcons.tsx";

interface EthereumProvider {
    id: string;
    name: string;
    icon?: string;
    provider: any;
}

interface EthereumWalletConnectProps {
    onConnect: (address: string, provider?: any) => void;
    onDisconnect: () => void;
    connectedAddress?: string;
}

export function EthereumWalletConnect({
    onConnect,
    onDisconnect,
    connectedAddress,
}: EthereumWalletConnectProps) {
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [providers, setProviders] = useState<EthereumProvider[]>([]);
    const [selectedProvider, setSelectedProvider] =
        useState<EthereumProvider | null>(null);
    const [showProviderSelection, setShowProviderSelection] = useState(false);
    const [manuallyDisconnected, setManuallyDisconnected] = useState(false);

    const styles = getStyles();

    // Detect available Ethereum wallet providers
    useEffect(() => {
        const detectProviders = () => {
            if (!(window as any).ethereum) {
                return;
            }

            const ethereum = (window as any).ethereum;
            const detectedProviders: EthereumProvider[] = [];

            if (ethereum.providers && Array.isArray(ethereum.providers)) {
                // Multiple providers detected
                ethereum.providers.forEach((provider: any, index: number) => {
                    if (
                        provider.isMetaMask &&
                        !provider.isPhantom &&
                        !provider.isSolana
                    ) {
                        detectedProviders.push({
                            id: "metamask",
                            name: "MetaMask",
                            provider: provider,
                        });
                    } else if (provider.isCoinbaseWallet) {
                        detectedProviders.push({
                            id: "coinbase",
                            name: "Coinbase Wallet",
                            provider: provider,
                        });
                    } else if (provider.isTrustWallet) {
                        detectedProviders.push({
                            id: "trust",
                            name: "Trust Wallet",
                            provider: provider,
                        });
                    } else if (
                        !provider.isPhantom &&
                        !provider.isSolana &&
                        !provider.solana
                    ) {
                        // Generic Ethereum provider
                        detectedProviders.push({
                            id: `ethereum-${index}`,
                            name: `Ethereum Wallet ${index + 1}`,
                            provider: provider,
                        });
                    }
                });
            } else {
                // Single provider
                if (
                    ethereum.isMetaMask &&
                    !ethereum.isPhantom &&
                    !ethereum.isSolana
                ) {
                    detectedProviders.push({
                        id: "metamask",
                        name: "MetaMask",
                        provider: ethereum,
                    });
                } else if (ethereum.isCoinbaseWallet) {
                    detectedProviders.push({
                        id: "coinbase",
                        name: "Coinbase Wallet",
                        provider: ethereum,
                    });
                } else if (ethereum.isTrustWallet) {
                    detectedProviders.push({
                        id: "trust",
                        name: "Trust Wallet",
                        provider: ethereum,
                    });
                } else if (
                    !ethereum.isPhantom &&
                    !ethereum.isSolana &&
                    !ethereum.solana
                ) {
                    detectedProviders.push({
                        id: "ethereum-generic",
                        name: "Ethereum Wallet",
                        provider: ethereum,
                    });
                }
            }

            setProviders(detectedProviders);

            // Auto-select if only one provider and user hasn't disconnected, but don't auto-connect
            if (
                detectedProviders.length === 1 &&
                !manuallyDisconnected &&
                !selectedProvider
            ) {
                setSelectedProvider(detectedProviders[0]);
            }
        };

        detectProviders();

        // Re-detect providers if ethereum object changes
        const interval = setInterval(detectProviders, 1000);
        return () => clearInterval(interval);
    }, [manuallyDisconnected, selectedProvider]);

    const handleConnect = useCallback(async () => {
        setManuallyDisconnected(false);

        if (providers.length === 0) {
            setError("No compatible Ethereum wallet found.");
            return;
        }

        // Always show provider selection if no provider is selected yet
        if (!selectedProvider) {
            setShowProviderSelection(true);
            return;
        }

        const providerToUse = selectedProvider;

        setError(null);
        setLoading(true);

        try {
            const accounts = await providerToUse.provider.request({
                method: "eth_requestAccounts",
            });

            if (!accounts || accounts.length === 0) {
                throw new Error("No Ethereum accounts found.");
            }

            // Normalize to EIP-55 checksum format
            const { getAddress } = await import("ethers");
            const address = getAddress(accounts[0]);

            onConnect(address, providerToUse.provider);
        } catch (err) {
            const message =
                err instanceof Error
                    ? err.message
                    : "Failed to connect Ethereum wallet";
            setError(message);
        } finally {
            setLoading(false);
        }
    }, [providers, selectedProvider, onConnect]);

    const handleProviderSelect = useCallback((provider: EthereumProvider) => {
        setSelectedProvider(provider);
        setShowProviderSelection(false);
        setError(null);
    }, []);

    // Removed auto-connect behavior to prevent unwanted reconnections
    // Users must explicitly click connect button

    const handleDisconnect = useCallback(() => {
        setManuallyDisconnected(true);
        setSelectedProvider(null);
        setShowProviderSelection(false);
        onDisconnect();
    }, [onDisconnect]);

    // Show provider selection modal
    if (showProviderSelection) {
        return (
            <div style={styles.wrapper}>
                <div
                    style={styles.modalOverlay}
                    onClick={() => setShowProviderSelection(false)}
                >
                    <div
                        style={styles.modal}
                        onClick={(e) => e.stopPropagation()}
                    >
                        <h3 style={styles.modalTitle}>
                            Select Ethereum Wallet
                        </h3>
                        <p style={styles.modalDescription}>
                            Multiple Ethereum wallets detected. Please choose
                            which one you'd like to use:
                        </p>
                        <div style={styles.providerList}>
                            {providers.map((provider) => (
                                <button
                                    key={provider.id}
                                    onClick={() =>
                                        handleProviderSelect(provider)
                                    }
                                    style={styles.providerButton}
                                    className="provider-button"
                                >
                                    <div style={styles.providerInfo}>
                                        <span style={styles.providerName}>
                                            {provider.name}
                                        </span>
                                    </div>
                                </button>
                            ))}
                        </div>
                        <button
                            onClick={() => setShowProviderSelection(false)}
                            style={styles.cancelButton}
                            className="btn-text"
                        >
                            Cancel
                        </button>
                    </div>
                </div>
            </div>
        );
    }

    if (connectedAddress) {
        return (
            <div style={styles.connected}>
                <div className="connected-dot" style={styles.connectedDot} />
                <div style={styles.connectedInfo}>
                    <span style={styles.connectedLabel}>
                        Ethereum Wallet Connected
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

    if (providers.length === 0) {
        return (
            <div style={styles.wrapper}>
                <div style={styles.noWallet}>
                    <div style={styles.noWalletTitle}>
                        No Ethereum wallet detected
                    </div>
                    <p style={styles.noWalletText}>
                        You need an Ethereum wallet extension to connect your
                        Ethereum address.
                    </p>
                    <div style={styles.walletLinks}>
                        <a
                            href="https://metamask.io/download/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn-secondary"
                            style={styles.installLink}
                        >
                            <MetaMaskIcon /> MetaMask
                        </a>
                        <a
                            href="https://www.coinbase.com/wallet/downloads"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="btn-secondary"
                            style={styles.installLink}
                        >
                            <CoinbaseIcon /> Coinbase Wallet
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
            <button
                className="btn-secondary"
                onClick={handleConnect}
                disabled={loading}
            >
                {loading
                    ? "Connecting..."
                    : providers.length === 1
                      ? "Connect Ethereum Wallet"
                      : selectedProvider
                        ? `Connect ${selectedProvider.name}`
                        : "Choose Ethereum Wallet"}
            </button>
            {error && <p style={styles.error}>{error}</p>}
            <p style={styles.hint}>
                {providers.length === 1
                    ? `Requires ${providers[0].name}.`
                    : selectedProvider
                      ? `Using ${selectedProvider.name}. Click to change.`
                      : "Multiple wallets detected. Click to choose."}
            </p>
            {providers.length > 1 && selectedProvider && (
                <button
                    onClick={() => setShowProviderSelection(true)}
                    style={styles.changeProviderButton}
                    className="btn-text"
                >
                    Change Wallet ({providers.length} available)
                </button>
            )}
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
        walletLinks: {
            display: "flex",
            gap: "8px",
            flexWrap: "wrap",
        },
        installLink: {
            textDecoration: "none",
            fontSize: "13px",
            padding: "8px 16px",
            display: "inline-flex",
            alignItems: "center",
            gap: "8px",
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
        changeProviderButton: {
            fontSize: "12px",
            color: brand.primary,
            padding: "4px 0",
        },
        modalOverlay: {
            position: "fixed" as const,
            top: 0,
            left: 0,
            right: 0,
            bottom: 0,
            backgroundColor: "rgba(0, 0, 0, 0.5)",
            display: "flex",
            alignItems: "center",
            justifyContent: "center",
            zIndex: 1000,
        },
        modal: {
            background: brand.white,
            borderRadius: "16px",
            padding: "24px",
            minWidth: "320px",
            maxWidth: "90vw",
            border: `1px solid ${brand.border}`,
            boxShadow: "0 8px 32px rgba(0, 0, 0, 0.15)",
        },
        modalTitle: {
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            fontSize: "18px",
            fontWeight: 600,
            color: brand.black,
            margin: "0 0 8px 0",
        },
        modalDescription: {
            fontFamily: "'Plus Jakarta Sans', sans-serif",
            fontSize: "14px",
            color: brand.textSecondary,
            margin: "0 0 20px 0",
            lineHeight: 1.4,
        },
        providerList: {
            display: "flex",
            flexDirection: "column",
            gap: "8px",
            marginBottom: "20px",
        },
        providerButton: {
            display: "flex",
            alignItems: "center",
            padding: "12px 16px",
            border: `1px solid ${brand.border}`,
            borderRadius: "16px",
            backgroundColor: brand.white,
            cursor: "pointer",
            transition: "all 0.2s ease",
            fontFamily: "'Plus Jakarta Sans', sans-serif",
        },
        providerInfo: {
            display: "flex",
            alignItems: "center",
            gap: "12px",
        },
        providerName: {
            fontSize: "14px",
            fontWeight: 500,
            color: brand.black,
        },
        cancelButton: {
            width: "100%",
            textAlign: "center" as const,
            color: brand.textSecondary,
        },
    };
}
