import React, { useState, useRef, useEffect, useCallback } from 'react';
import {
  View,
  Text,
  TextInput,
  TouchableOpacity,
  StyleSheet,
  Alert,
  ScrollView,
  Keyboard,
  ActivityIndicator,
  Platform,
  Linking,
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import * as Network from 'expo-network';
import { useConnectionStore } from '../store/connection';
import { disconnectWithQueueGuard } from '../store/disconnectWithQueueGuard';
import { useConnectionLifecycleStore } from '../store/connection-lifecycle';
import { setPendingPairingId, setPendingPairingIdentityKey } from '../store/message-handler';
import { Icon } from '../components/Icon';
import { ICON_TRIANGLE_DOWN, ICON_TRIANGLE_RIGHT, ICON_BULLET } from '../constants/icons';
import { COLORS } from '../constants/colors';
import { validatePort, scanSubnet, deriveSubnet24 } from '../utils/lan-scanner';
import type { DiscoveredServer } from '../utils/lan-scanner';

const DEFAULT_PORT = 8765;

// Troubleshooting guide linked from the LAN-scan empty state (#6561). Points at
// the docs on `main` so it stays valid without an app release.
const LAN_TROUBLESHOOTING_URL =
  'https://github.com/blamechris/chroxy/blob/main/docs/troubleshooting/lan-discovery.md';


type ParseResult =
  | { ok: true; wsUrl: string; token: string; pairingId?: undefined; identityKey?: string }
  | { ok: true; wsUrl: string; token?: undefined; pairingId: string; identityKey?: string }
  | { ok: false; reason: 'not_chroxy' | 'missing_token' | 'invalid_url' };

export function parseChroxyUrl(raw: string): ParseResult {
  try {
    const trimmed = raw.trim();
    if (trimmed.startsWith('chroxy://')) {
      const parsed = new URL(trimmed.replace('chroxy://', 'https://'));
      // #5298 — the chroxy:// scheme drops ws/wss, so infer it from the port.
      // A LAN daemon's pairing/QR URL always has an explicit port and serves
      // plain ws:// (no TLS); a tunnel URL has no port and is wss:// on 443.
      // So: port present ⇒ ws (LAN), port absent ⇒ wss (tunnel). `parsed.host`
      // already carries the port (and brackets, for IPv6). Mirrors the
      // dashboard's parsePairingUrl scheme inference.
      const scheme = parsed.port ? 'ws' : 'wss';
      const wsUrl = `${scheme}://${parsed.host}`;

      // #5536 — the daemon's pinned E2E identity public key (base64 Ed25519),
      // conveyed over the trusted pairing channel as `idk=`. Captured here and
      // pinned on first connect; absent for older daemons / encryption-off.
      const identityKey = parsed.searchParams.get('idk') ?? undefined;

      // New pairing flow: chroxy://host?pair=PAIRING_ID
      const pairingId = parsed.searchParams.get('pair');
      if (pairingId) return { ok: true, wsUrl, pairingId, ...(identityKey ? { identityKey } : {}) };

      // Legacy flow: chroxy://host?token=TOKEN
      const token = parsed.searchParams.get('token');
      if (token) return { ok: true, wsUrl, token, ...(identityKey ? { identityKey } : {}) };

      return { ok: false, reason: 'missing_token' };
    }
    // A directly-entered ws:// or wss:// URL keeps its own scheme — the
    // override for the rare port-bearing wss (custom proxy) case.
    if (trimmed.startsWith('ws://') || trimmed.startsWith('wss://')) {
      return { ok: true, wsUrl: trimmed, token: '' };
    }
  } catch {
    return { ok: false, reason: 'invalid_url' };
  }
  return { ok: false, reason: 'not_chroxy' };
}

const QR_ERROR_MESSAGES: Record<string, { title: string; message: string }> = {
  not_chroxy: {
    title: 'Not a Chroxy QR Code',
    message: 'This QR code is not from Chroxy. Scan the QR code shown by "npx chroxy start" on your computer.',
  },
  missing_token: {
    title: 'Missing Auth Token',
    message: 'This Chroxy QR code is missing the authentication token. Try restarting the server with "npx chroxy start".',
  },
  invalid_url: {
    title: 'Invalid QR Code',
    message: 'Could not parse this QR code. Make sure you\'re scanning the full QR code clearly.',
  },
};

function formatUrl(url: string): string {
  // Show a friendly version: "192.168.1.5:8765" or "abc.trycloudflare.com"
  return url.replace(/^wss?:\/\//, '');
}

export function ConnectScreen() {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [showToken, setShowToken] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [autoConnecting, setAutoConnecting] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const insets = useSafeAreaInsets();
  const scanLock = useRef(false);
  const scrollRef = useRef<ScrollView>(null);

  const [scanning, setScanning] = useState(false);
  const [scanCompleted, setScanCompleted] = useState(false);
  const [scanError, setScanError] = useState(false);
  // Set when the scan couldn't start because the phone isn't on Wi-Fi (or has no
  // usable LAN IP) — distinct from a completed scan that simply found nothing, so
  // the empty state can give the right advice.
  const [scanNoWifi, setScanNoWifi] = useState(false);
  // The /24 prefix we actually swept (e.g. "10.0.0"), surfaced in the UI so a
  // subnet mismatch between phone and daemon is visible (#6561).
  const [scannedSubnet, setScannedSubnet] = useState<string | null>(null);
  const [discoveredServers, setDiscoveredServers] = useState<DiscoveredServer[]>([]);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanPort, setScanPort] = useState(String(DEFAULT_PORT));
  const scanAbortRef = useRef<AbortController | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useConnectionStore((state) => state.connect);
  const connectionPhase = useConnectionLifecycleStore((state) => state.connectionPhase);
  const connectionError = useConnectionLifecycleStore((state) => state.connectionError);
  const connectionRetryCount = useConnectionLifecycleStore((state) => state.connectionRetryCount);
  const savedConnection = useConnectionLifecycleStore((state) => state.savedConnection);
  const loadSavedConnection = useConnectionStore((state) => state.loadSavedConnection);
  const clearSavedConnection = useConnectionStore((state) => state.clearSavedConnection);
  const viewCachedSession = useConnectionStore((state) => state.viewCachedSession);
  const hasCachedMessages = useConnectionStore((state) =>
    Object.values(state.sessionStates).some(
      (ss) => ss?.messages && ss.messages.length > 0,
    ),
  );

  // Load saved connection and auto-connect on mount (skip auto-connect if user just disconnected)
  useEffect(() => {
    let mounted = true;
    const { userDisconnected } = useConnectionLifecycleStore.getState();
    loadSavedConnection().then(() => {
      if (!mounted || userDisconnected) return;
      const saved = useConnectionLifecycleStore.getState().savedConnection;
      if (saved) {
        setAutoConnecting(true);
        // #5518 — auto-select LAN vs tunnel for the saved record on reconnect.
        void useConnectionStore.getState().connectAuto(saved, { silent: true });
      }
    });
    return () => { mounted = false; };
  }, []);

  // Fall back to normal ConnectScreen if auto-connect fails
  useEffect(() => {
    if (autoConnecting && connectionPhase === 'disconnected') {
      setAutoConnecting(false);
    }
  }, [connectionPhase, autoConnecting]);

  const isLocalUrl = (u: string) => {
    const lower = u.toLowerCase();
    return lower.startsWith('ws://localhost') || lower.startsWith('ws://127.0.0.1')
      || lower.startsWith('wss://localhost') || lower.startsWith('wss://127.0.0.1');
  };

  const handleConnect = () => {
    const rawUrl = url.trim() || 'ws://localhost:8765';

    // If user pasted a chroxy:// URL into the manual entry field, parse it properly
    if (rawUrl.startsWith('chroxy://')) {
      const parsed = parseChroxyUrl(rawUrl);
      if (parsed.ok) {
        Keyboard.dismiss();
        // #5536 — capture the pinned identity (if the URL carried `idk=`) so the
        // key-exchange handler pins it on first connect.
        setPendingPairingIdentityKey(parsed.identityKey ?? null);
        if ('pairingId' in parsed && parsed.pairingId) {
          setPendingPairingId(parsed.pairingId);
          connect(parsed.wsUrl, '');
        } else {
          connect(parsed.wsUrl, parsed.token || token.trim());
        }
        return;
      }
      if (parsed.reason === 'missing_token') {
        Alert.alert(
          'Missing Token',
          `Include your token in the URL:\n\nchroxy://HOSTNAME?token=YOUR_TOKEN\n\nOr enter the server URL and token separately below.`,
        );
        return;
      }
      // invalid_url: malformed chroxy:// string — show an error rather than
      // falling through to produce a malformed wss://chroxy://... URL
      Alert.alert(
        'Invalid URL',
        `Could not parse this Chroxy URL. Expected format:\n\nchroxy://HOSTNAME?token=YOUR_TOKEN`,
      );
      return;
    }

    let wsUrl = rawUrl;
    if (!wsUrl.startsWith('wss://') && !wsUrl.startsWith('ws://')) {
      wsUrl = `wss://${wsUrl}`;
    }

    // Token is optional for localhost connections (--no-auth mode)
    const trimmedToken = token.trim();
    if (!trimmedToken && !isLocalUrl(wsUrl)) {
      Alert.alert(
        'Missing Token',
        `An API token is required for remote connections.\n\nYou can find your token in the QR code URL:\nchroxy://HOSTNAME?token=YOUR_TOKEN`,
      );
      return;
    }

    Keyboard.dismiss();
    connect(wsUrl, trimmedToken);
  };

  const handleReconnect = () => {
    if (savedConnection) {
      // #5518 — re-select LAN vs tunnel for the saved record on reconnect.
      void useConnectionStore.getState().connectAuto(savedConnection);
    }
  };

  const handleScanQR = async () => {
    if (!permission?.granted) {
      const result = await requestPermission();
      if (!result.granted) {
        Alert.alert(
          'Camera Permission',
          'Camera access is needed to scan QR codes. Enable it in Settings.',
        );
        return;
      }
    }
    scanLock.current = false;
    setShowScanner(true);
  };

  const handleBarCodeScanned = (result: BarcodeScanningResult) => {
    if (scanLock.current) return;
    scanLock.current = true;

    const parsed = parseChroxyUrl(result.data);
    if (parsed.ok) {
      setShowScanner(false);
      // #5536 — capture the pinned identity (if the QR carried `idk=`) so the
      // key-exchange handler pins it on first connect / verifies on later ones.
      setPendingPairingIdentityKey(parsed.identityKey ?? null);
      if ('pairingId' in parsed && parsed.pairingId) {
        // New pairing flow: set pairing ID before connecting
        setPendingPairingId(parsed.pairingId);
        connect(parsed.wsUrl, '');
      } else {
        // Legacy flow: connect with permanent token
        connect(parsed.wsUrl, parsed.token || '');
      }
    } else {
      const errorInfo = QR_ERROR_MESSAGES[parsed.reason] || QR_ERROR_MESSAGES.invalid_url;
      Alert.alert(
        errorInfo.title,
        errorInfo.message,
        [{ text: 'Try Again', onPress: () => { scanLock.current = false; } }],
      );
    }
  };

  useEffect(() => {
    return () => {
      if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    };
  }, []);

  const scrollToInput = () => {
    if (scrollTimerRef.current) clearTimeout(scrollTimerRef.current);
    scrollTimerRef.current = setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 300);
  };

  // Abort LAN scan on unmount
  useEffect(() => {
    return () => { scanAbortRef.current?.abort(); };
  }, []);

  const handleScanLAN = useCallback(async () => {
    if (scanning) {
      scanAbortRef.current?.abort();
      setScanning(false);
      return;
    }

    setScanning(true);
    setScanCompleted(false);
    setScanError(false);
    setScanNoWifi(false);
    setScannedSubnet(null);
    setDiscoveredServers([]);
    setScanProgress(0);

    const abort = new AbortController();
    scanAbortRef.current = abort;

    // Drive every terminal outcome through one helper so `scanCompleted` (the E2E
    // anchor) and the spinner state stay in sync regardless of which branch we hit.
    const finalizeScan = (patch?: { error?: boolean; noWifi?: boolean }) => {
      if (abort.signal.aborted) return;
      if (patch?.error) setScanError(true);
      if (patch?.noWifi) setScanNoWifi(true);
      setScanProgress(1);
      setScanning(false);
      setScanCompleted(true);
    };

    const port = validatePort(scanPort);
    if (port === null) {
      Alert.alert('Invalid Port', `Port must be between 1 and 65535. Using default (${DEFAULT_PORT}).`);
      setScanPort(String(DEFAULT_PORT));
      setScanning(false);
      return;
    }

    try {
      // Best-effort transport check: a cellular-only phone can still return a
      // *scannable* IP (e.g. CGNAT 100.64.x), so IP shape alone can't tell Wi-Fi
      // from cellular. getNetworkStateAsync makes the "not on Wi-Fi" state
      // authoritative for cellular; if it throws/undefined we fall back to the IP
      // heuristic below. We only treat an *explicit* CELLULAR type as no-LAN —
      // WIFI/ETHERNET/UNKNOWN still proceed to the IP-based subnet check.
      let onCellular = false;
      try {
        const netState = await Network.getNetworkStateAsync();
        onCellular = netState?.type === Network.NetworkStateType.CELLULAR;
      } catch {
        // Older/unsupported platform — rely on the IP check below.
      }
      if (abort.signal.aborted) {
        setScanning(false);
        return;
      }

      const deviceIp = await Network.getIpAddressAsync();
      if (abort.signal.aborted) {
        setScanning(false);
        return;
      }

      const subnet = deriveSubnet24(deviceIp);
      if (!subnet || onCellular) {
        // No usable LAN IP (0.0.0.0 / loopback / link-local) or an explicitly
        // cellular transport → the phone has no LAN to sweep. Almost always
        // "not connected to Wi-Fi".
        finalizeScan({ noWifi: true });
        return;
      }
      setScannedSubnet(subnet);

      await scanSubnet(subnet, port, abort.signal, {
        onProgress: (p) => setScanProgress(p),
        onFound: (found) => setDiscoveredServers((prev) => [...prev, ...found]),
      });
    } catch (err) {
      console.warn('[LAN scan] scan threw unexpectedly:', err);
      finalizeScan({ error: true });
      return;
    }

    finalizeScan();
  }, [scanning, scanPort]);

  const handleSelectDiscovered = (server: DiscoveredServer) => {
    const wsUrl = `ws://${server.ip}:${server.port}`;
    setUrl(wsUrl);
    // Show the manual entry form pre-filled with the server URL so the user can
    // provide their API token. Don't auto-connect with an empty token — most servers
    // require auth, and connecting with an empty token causes auth failures + rate limiting.
    setShowManual(true);
    scrollToInput();
  };

  // Reliable, discovery-independent fallback: reveal + scroll to the manual
  // host+port form. Surfaced from the empty state so a blocked scan has an
  // obvious next step (#6561).
  const jumpToManualEntry = () => {
    setShowManual(true);
    scrollToInput();
  };

  const openTroubleshooting = () => {
    Linking.openURL(LAN_TROUBLESHOOTING_URL).catch(() => {
      Alert.alert('Could not open link', LAN_TROUBLESHOOTING_URL);
    });
  };

  if (autoConnecting) {
    return (
      <View style={styles.autoConnectContainer}>
        <Icon name="satellite" size={48} color={COLORS.accentBlue} />
        <ActivityIndicator size="large" color={COLORS.accentBlue} style={styles.autoConnectSpinner} />
        <Text style={styles.autoConnectText}>
          Connecting to {savedConnection ? formatUrl(savedConnection.url) : 'server'}...
          {connectionRetryCount > 0 ? ` (attempt ${connectionRetryCount + 1}/6)` : ''}
        </Text>
        <TouchableOpacity
          style={styles.autoConnectCancel}
          onPress={() => {
            setAutoConnecting(false);
            disconnectWithQueueGuard();
          }}
          accessibilityRole="button"
          accessibilityLabel="Cancel connection attempt"
        >
          <Text style={styles.autoConnectCancelText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  if (showScanner) {
    return (
      <View style={styles.scannerContainer}>
        <CameraView
          style={styles.camera}
          facing="back"
          barcodeScannerSettings={{ barcodeTypes: ['qr'] }}
          onBarcodeScanned={handleBarCodeScanned}
        />
        <View style={styles.scannerOverlay}>
          <View style={styles.scannerFrame} />
          <Text style={styles.scannerHint}>
            Point at the QR code from your terminal
          </Text>
        </View>
        <TouchableOpacity
          style={styles.cancelButton}
          onPress={() => setShowScanner(false)}
          accessibilityRole="button"
          accessibilityLabel="Cancel scan"
        >
          <Text style={styles.cancelButtonText}>Cancel</Text>
        </TouchableOpacity>
      </View>
    );
  }

  return (
    <ScrollView
      ref={scrollRef}
      style={styles.container}
      contentContainerStyle={[styles.scrollContent, { paddingBottom: Math.max(insets.bottom, 24) + 300 }]}
      keyboardShouldPersistTaps="handled"
    >
      <View style={styles.header}>
        <Icon name="satellite" size={48} color={COLORS.accentBlue} />
        <Text style={styles.title}>Connect to Chroxy</Text>
        <Text style={styles.subtitle}>
          Run 'npx chroxy start' on your Mac, then scan the QR code
        </Text>
      </View>

      {/* Connection error banner */}
      {connectionError && connectionPhase === 'disconnected' && (
        <View style={styles.errorBanner}>
          <Text style={styles.errorBannerText}>{connectionError}</Text>
        </View>
      )}

      {/* Quick reconnect */}
      {savedConnection && (
        <View style={styles.savedSection}>
          <TouchableOpacity style={styles.reconnectButton} onPress={handleReconnect} accessibilityRole="button" accessibilityLabel={`Reconnect to ${formatUrl(savedConnection.url)}`}>
            <Text style={styles.reconnectButtonText}>Reconnect</Text>
            <Text style={styles.reconnectUrl}>{formatUrl(savedConnection.url)}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.forgetButton} onPress={clearSavedConnection} accessibilityRole="button" accessibilityLabel="Remove saved server connection">
            <Text style={styles.forgetButtonText}>Forget</Text>
          </TouchableOpacity>
        </View>
      )}

      {/* View cached session history offline */}
      {hasCachedMessages && !autoConnecting && (
        <TouchableOpacity
          style={styles.cachedButton}
          onPress={viewCachedSession}
          accessibilityRole="button"
          accessibilityLabel="View cached session history offline"
        >
          <Text style={styles.cachedButtonText}>View Last Session</Text>
          <Text style={styles.cachedButtonDetail}>Browse cached chat history offline</Text>
        </TouchableOpacity>
      )}

      <TouchableOpacity style={styles.qrButton} onPress={handleScanQR} accessibilityRole="button" accessibilityLabel="Open camera to scan QR code">
        <View style={styles.qrButtonContent}>
          <Icon name="camera" size={20} color={COLORS.textPrimary} />
          <Text style={styles.qrButtonText}>Scan QR Code</Text>
        </View>
      </TouchableOpacity>

      {/* LAN Discovery */}
      <View style={styles.lanRow}>
        <TouchableOpacity
          style={[styles.lanButton, styles.lanButtonFlex, scanning && styles.lanButtonScanning]}
          onPress={handleScanLAN}
          accessibilityRole="button"
          accessibilityLabel="Scan local network for Chroxy servers"
        >
        {scanning ? (
          <View style={styles.lanButtonContent}>
            <ActivityIndicator size="small" color={COLORS.textPrimary} />
            <Text style={styles.lanButtonText}>
              Scanning... {Math.round(scanProgress * 100)}%
            </Text>
          </View>
        ) : (
          <View style={styles.lanButtonContent}>
            <Icon name="satellite" size={16} color={COLORS.textPrimary} />
            <Text style={styles.lanButtonText}>Scan Local Network</Text>
          </View>
        )}
        </TouchableOpacity>
        <TextInput
          style={styles.portInput}
          value={scanPort}
          onChangeText={setScanPort}
          keyboardType="number-pad"
          maxLength={5}
          placeholder="Port"
          placeholderTextColor={COLORS.textDim}
          editable={!scanning}
          accessibilityLabel="LAN scan port number"
        />
      </View>

      {/* #6089: a single terminal-state anchor for E2E, rendered for EVERY scan
          outcome (found / empty / error all set scanCompleted). Placed
          immediately after the scan row — BEFORE the (potentially long)
          results list — so it stays within the initial viewport and Maestro's
          non-scrolling assertVisible finds it on the servers-found path too.
          Kept in the a11y tree (no accessibilityElementsHidden). */}
      {scanCompleted && (
        <View testID="lan-scan-complete" style={{ height: 1, width: 1 }} />
      )}

      {discoveredServers.length > 0 && (
        <View style={styles.discoveredSection}>
          <Text style={styles.discoveredTitle}>
            Found {discoveredServers.length} server{discoveredServers.length !== 1 ? 's' : ''} on LAN
          </Text>
          {discoveredServers.map((server) => (
            <TouchableOpacity
              key={`${server.ip}:${server.port}`}
              style={styles.discoveredItem}
              onPress={() => handleSelectDiscovered(server)}
              activeOpacity={0.7}
              accessibilityRole="button"
              accessibilityLabel={`Connect to ${server.hostname}`}
            >
              <View style={styles.discoveredInfo}>
                <Text style={styles.discoveredHostname}>{server.hostname}</Text>
                <Text style={styles.discoveredDetails}>
                  {server.ip}:{server.port} {ICON_BULLET} {server.mode}
                  {server.version ? ` ${ICON_BULLET} v${server.version}` : ''}
                </Text>
              </View>
              <Text style={styles.discoveredArrow}>{ICON_TRIANGLE_RIGHT}</Text>
            </TouchableOpacity>
          ))}
        </View>
      )}

      {scanCompleted && discoveredServers.length === 0 && !scanning && (
        <View
          style={styles.discoveredSection}
          testID="lan-scan-empty-state"
          accessibilityLabel={
            scanNoWifi
              ? 'LAN scan result: no local network to scan'
              : scanError
                ? 'LAN scan result: scan failed'
                : 'LAN scan result: no servers found'
          }
        >
          {scanNoWifi ? (
            <>
              <Text style={styles.scanEmptyTitle} testID="lan-scan-nowifi-title">
                No local network to scan
              </Text>
              <Text style={styles.scanEmptyHint} testID="lan-scan-nowifi-hint">
                Your phone isn't on a Wi-Fi network with a usable local address — it may be
                on cellular, or on Wi-Fi that hasn't assigned an IPv4 address. Connect to the
                same Wi-Fi as your computer and scan again — or enter the address manually below.
              </Text>
            </>
          ) : scanError ? (
            <>
              <Text style={styles.scanEmptyTitle} testID="lan-scan-error-title">
                Scan failed (port {scanPort})
              </Text>
              <Text style={styles.scanEmptyHint} testID="lan-scan-error-hint">
                Couldn't scan the network. Make sure Wi-Fi is on and your phone is on the
                same network as your computer, then try again.
              </Text>
            </>
          ) : (
            <>
              <Text style={styles.scanEmptyTitle} testID="lan-scan-empty-title">
                No servers found on port {scanPort}
              </Text>
              <Text style={styles.scanEmptyHint} testID="lan-scan-empty-hint">
                Scanned{' '}
                <Text style={styles.scanEmptyHighlight}>
                  {scannedSubnet ? `${scannedSubnet}.1-254` : 'your Wi-Fi'}
                </Text>{' '}
                and found no Chroxy daemon.{'\n\n'}
                If Chroxy is running and reachable at your computer's LAN IP, your Wi-Fi
                router may be blocking device-to-device connections (client/AP isolation) —
                common on mesh and guest networks.{'\n\n'}
                The reliable way in: <Text style={styles.scanEmptyHighlight}>Enter manually</Text>{' '}
                with your computer's IP and port, or{' '}
                <Text style={styles.scanEmptyHighlight}>Scan QR Code</Text>.
              </Text>
            </>
          )}

          <View style={styles.scanEmptyActions}>
            <TouchableOpacity
              style={styles.scanEmptyLinkButton}
              activeOpacity={0.7}
              onPress={jumpToManualEntry}
              accessibilityRole="button"
              accessibilityLabel="Enter server address manually"
              testID="lan-scan-manual-cta"
            >
              <Text style={styles.scanEmptyLink}>{ICON_TRIANGLE_RIGHT} Enter address manually</Text>
            </TouchableOpacity>
            {!scanNoWifi && (
              <TouchableOpacity
                style={styles.scanEmptyLinkButton}
                activeOpacity={0.7}
                onPress={openTroubleshooting}
                accessibilityRole="link"
                accessibilityLabel="Open LAN discovery troubleshooting guide"
                testID="lan-scan-troubleshooting-link"
              >
                <Text style={styles.scanEmptyLink}>{ICON_TRIANGLE_RIGHT} Troubleshooting: LAN discovery</Text>
              </TouchableOpacity>
            )}
          </View>
        </View>
      )}

      <TouchableOpacity
        style={styles.manualToggle}
        onPress={() => setShowManual(!showManual)}
        accessibilityRole="button"
        accessibilityLabel="Enter server address manually"
        testID="connect-manual-toggle"
      >
        <Text style={styles.manualToggleText}>
          {showManual ? `${ICON_TRIANGLE_DOWN} Hide manual entry` : `${ICON_TRIANGLE_RIGHT} Enter manually`}
        </Text>
      </TouchableOpacity>

      {showManual && (
        <View style={styles.manualForm}>
          <Text style={styles.label}>Server URL</Text>
          <TextInput
            style={styles.input}
            placeholder="ws://localhost:8765 (default)"
            placeholderTextColor={COLORS.textDim}
            value={url}
            onChangeText={setUrl}
            onFocus={scrollToInput}
            autoCapitalize="none"
            autoCorrect={false}
            accessibilityLabel="Server URL"
            testID="connect-server-url"
          />

          <Text style={styles.label}>
            API Token{isLocalUrl(url.trim() || 'ws://localhost:8765') ? ' (optional for localhost)' : ''}
          </Text>
          <View style={styles.tokenInputRow}>
            <TextInput
              style={[styles.input, styles.tokenInput]}
              placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
              placeholderTextColor={COLORS.textDim}
              value={token}
              onChangeText={setToken}
              onFocus={scrollToInput}
              autoCapitalize="none"
              autoCorrect={false}
              secureTextEntry={!showToken}
              accessibilityLabel="API Token"
              testID="connect-api-token"
            />
            <TouchableOpacity
              style={styles.tokenEyeButton}
              onPress={() => setShowToken((prev) => !prev)}
              accessibilityRole="button"
              accessibilityLabel={showToken ? 'Hide token' : 'Show token'}
            >
              <Icon name={showToken ? 'eyeOff' : 'eye'} size={20} color={COLORS.textMuted} />
            </TouchableOpacity>
          </View>

          <TouchableOpacity style={styles.connectButton} onPress={handleConnect} accessibilityRole="button" accessibilityLabel="Connect to server" testID="connect-submit">
            <Text style={styles.connectButtonText}>Connect</Text>
          </TouchableOpacity>
        </View>
      )}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: COLORS.backgroundPrimary,
  },
  scrollContent: {
    padding: 24,
  },
  header: {
    alignItems: 'center',
    marginTop: 40,
    marginBottom: 40,
  },
  logo: {
    fontSize: 64,
    marginBottom: 16,
  },
  title: {
    fontSize: 28,
    fontWeight: 'bold',
    color: COLORS.textPrimary,
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: COLORS.textMuted,
    textAlign: 'center',
    lineHeight: 22,
  },
  // Connection error
  errorBanner: {
    backgroundColor: COLORS.accentRedSubtle,
    borderRadius: 10,
    padding: 12,
    marginBottom: 24,
    alignItems: 'center',
  },
  errorBannerText: {
    color: COLORS.accentRed,
    fontSize: 14,
    fontWeight: '600',
  },
  // Saved connection / reconnect
  savedSection: {
    flexDirection: 'row',
    alignItems: 'center',
    marginBottom: 24,
    gap: 12,
  },
  reconnectButton: {
    flex: 1,
    backgroundColor: COLORS.accentGreen,
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
  },
  reconnectButtonText: {
    color: COLORS.textPrimary,
    fontSize: 18,
    fontWeight: '600',
  },
  reconnectUrl: {
    color: COLORS.reconnectUrlText,
    fontSize: 12,
    marginTop: 4,
  },
  forgetButton: {
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  forgetButtonText: {
    color: COLORS.accentRed,
    fontSize: 14,
  },
  cachedButton: {
    backgroundColor: COLORS.backgroundSecondary,
    paddingVertical: 14,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.borderPrimary,
    marginBottom: 16,
  },
  cachedButtonText: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '500',
  },
  cachedButtonDetail: {
    color: COLORS.textSecondary,
    fontSize: 12,
    marginTop: 2,
  },
  // QR and manual
  qrButton: {
    backgroundColor: COLORS.accentBlue,
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 24,
  },
  qrButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 8,
  },
  qrButtonText: {
    color: COLORS.textPrimary,
    fontSize: 18,
    fontWeight: '600',
  },
  manualToggle: {
    alignItems: 'center',
    paddingVertical: 12,
    minHeight: 44,
    justifyContent: 'center',
  },
  manualToggleText: {
    color: COLORS.accentBlue,
    fontSize: 14,
  },
  manualForm: {
    marginTop: 16,
  },
  label: {
    color: COLORS.textMuted,
    fontSize: 14,
    marginBottom: 8,
    marginTop: 16,
  },
  input: {
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 8,
    padding: 16,
    color: COLORS.textPrimary,
    fontSize: 16,
    borderWidth: 1,
    borderColor: COLORS.backgroundCard,
  },
  tokenInputRow: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
  },
  tokenInput: {
    flex: 1,
  },
  tokenEyeButton: {
    padding: 12,
    marginLeft: -44,
  },
  connectButton: {
    backgroundColor: COLORS.accentGreen,
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 24,
  },
  connectButtonText: {
    color: COLORS.textPrimary,
    fontSize: 18,
    fontWeight: '600',
  },
  // LAN Discovery
  lanRow: {
    flexDirection: 'row',
    gap: 8,
    marginBottom: 24,
  },
  lanButton: {
    backgroundColor: COLORS.backgroundCard,
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 12,
    alignItems: 'center',
    borderWidth: 1,
    borderColor: COLORS.borderPrimary,
  },
  lanButtonFlex: {
    flex: 1,
  },
  lanButtonScanning: {
    borderColor: COLORS.accentBlueBorder,
  },
  portInput: {
    backgroundColor: COLORS.backgroundCard,
    borderRadius: 12,
    borderWidth: 1,
    borderColor: COLORS.borderPrimary,
    paddingHorizontal: 12,
    paddingVertical: 16,
    color: COLORS.textPrimary,
    fontSize: 14,
    width: 64,
    textAlign: 'center',
  },
  lanButtonContent: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 10,
  },
  lanButtonText: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '500',
  },
  discoveredSection: {
    marginBottom: 24,
    gap: 8,
  },
  discoveredTitle: {
    color: COLORS.textMuted,
    fontSize: 12,
    fontWeight: '600',
    textTransform: 'uppercase',
    letterSpacing: 0.5,
    marginBottom: 4,
  },
  scanEmptyText: {
    color: COLORS.textDim,
    fontSize: 14,
    textAlign: 'center',
    paddingVertical: 8,
  },
  scanEmptyTitle: {
    color: COLORS.textMuted,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
    marginBottom: 6,
  },
  scanEmptyHint: {
    color: COLORS.textDim,
    fontSize: 13,
    textAlign: 'center',
    lineHeight: 19,
  },
  scanEmptyHighlight: {
    color: COLORS.textMuted,
    fontWeight: '600',
  },
  scanEmptyActions: {
    marginTop: 8,
    alignItems: 'center',
  },
  // Wrapper gives each link a >=44pt tap target (Apple HIG); the visible Text
  // stays 13pt. Matches the `manualToggle` pattern used elsewhere on this screen.
  scanEmptyLinkButton: {
    minHeight: 44,
    justifyContent: 'center',
    paddingHorizontal: 8,
  },
  scanEmptyLink: {
    color: COLORS.accentBlue,
    fontSize: 13,
    fontWeight: '600',
    textAlign: 'center',
  },
  discoveredItem: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: COLORS.backgroundSecondary,
    borderRadius: 10,
    padding: 14,
    borderWidth: 1,
    borderColor: COLORS.accentGreenBorder,
    minHeight: 44,
  },
  discoveredInfo: {
    flex: 1,
    gap: 2,
  },
  discoveredHostname: {
    color: COLORS.accentGreen,
    fontSize: 15,
    fontWeight: '600',
  },
  discoveredDetails: {
    color: COLORS.textMuted,
    fontSize: 11,
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
  },
  discoveredArrow: {
    color: COLORS.textDim,
    fontSize: 12,
    marginLeft: 8,
  },
  // Scanner styles
  scannerContainer: {
    flex: 1,
    backgroundColor: COLORS.backgroundTerminal,
  },
  camera: {
    flex: 1,
  },
  scannerOverlay: {
    ...StyleSheet.absoluteFillObject,
    justifyContent: 'center',
    alignItems: 'center',
  },
  scannerFrame: {
    width: 250,
    height: 250,
    borderWidth: 2,
    borderColor: COLORS.accentBlue,
    borderRadius: 16,
    backgroundColor: COLORS.borderTransparent,
  },
  scannerHint: {
    color: COLORS.textPrimary,
    fontSize: 16,
    marginTop: 24,
    textAlign: 'center',
    paddingHorizontal: 40,
  },
  cancelButton: {
    position: 'absolute',
    bottom: 60,
    alignSelf: 'center',
    backgroundColor: COLORS.cancelButtonOverlay,
    paddingVertical: 14,
    paddingHorizontal: 40,
    borderRadius: 12,
  },
  cancelButtonText: {
    color: COLORS.textPrimary,
    fontSize: 16,
    fontWeight: '600',
  },
  // Auto-connect styles
  autoConnectContainer: {
    flex: 1,
    backgroundColor: COLORS.backgroundPrimary,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 24,
  },
  autoConnectSpinner: {
    marginTop: 24,
    marginBottom: 16,
  },
  autoConnectText: {
    color: COLORS.textMuted,
    fontSize: 16,
    textAlign: 'center',
  },
  autoConnectCancel: {
    marginTop: 32,
    paddingVertical: 12,
    paddingHorizontal: 24,
  },
  autoConnectCancelText: {
    color: COLORS.accentBlue,
    fontSize: 16,
  },
});
