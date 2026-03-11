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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import * as Network from 'expo-network';
import { useConnectionStore } from '../store/connection';
import { setPendingPairingId } from '../store/message-handler';
import { Icon } from '../components/Icon';
import { ICON_TRIANGLE_DOWN, ICON_TRIANGLE_RIGHT, ICON_BULLET } from '../constants/icons';
import { COLORS } from '../constants/colors';

const DEFAULT_PORT = 8765;

interface DiscoveredServer {
  ip: string;
  port: number;
  hostname: string;
  mode: string;
  version: string;
}


type ParseResult =
  | { ok: true; wsUrl: string; token: string; pairingId?: undefined }
  | { ok: true; wsUrl: string; token?: undefined; pairingId: string }
  | { ok: false; reason: 'not_chroxy' | 'missing_token' | 'invalid_url' };

export function parseChroxyUrl(raw: string): ParseResult {
  try {
    const trimmed = raw.trim();
    if (trimmed.startsWith('chroxy://')) {
      const parsed = new URL(trimmed.replace('chroxy://', 'https://'));
      const wsUrl = `wss://${parsed.host}`;

      // New pairing flow: chroxy://host?pair=PAIRING_ID
      const pairingId = parsed.searchParams.get('pair');
      if (pairingId) return { ok: true, wsUrl, pairingId };

      // Legacy flow: chroxy://host?token=TOKEN
      const token = parsed.searchParams.get('token');
      if (token) return { ok: true, wsUrl, token };

      return { ok: false, reason: 'missing_token' };
    }
    if (trimmed.startsWith('wss://')) {
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
  const [showScanner, setShowScanner] = useState(false);
  const [autoConnecting, setAutoConnecting] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const insets = useSafeAreaInsets();
  const scanLock = useRef(false);
  const scrollRef = useRef<ScrollView>(null);

  const [scanning, setScanning] = useState(false);
  const [scanCompleted, setScanCompleted] = useState(false);
  const [discoveredServers, setDiscoveredServers] = useState<DiscoveredServer[]>([]);
  const [scanProgress, setScanProgress] = useState(0);
  const [scanPort, setScanPort] = useState(String(DEFAULT_PORT));
  const scanAbortRef = useRef<AbortController | null>(null);
  const scrollTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const connect = useConnectionStore((state) => state.connect);
  const connectionPhase = useConnectionStore((state) => state.connectionPhase);
  const connectionError = useConnectionStore((state) => state.connectionError);
  const connectionRetryCount = useConnectionStore((state) => state.connectionRetryCount);
  const savedConnection = useConnectionStore((state) => state.savedConnection);
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
    const { userDisconnected } = useConnectionStore.getState();
    loadSavedConnection().then(() => {
      if (!mounted || userDisconnected) return;
      const saved = useConnectionStore.getState().savedConnection;
      if (saved) {
        setAutoConnecting(true);
        connect(saved.url, saved.token, { silent: true });
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
    let wsUrl = url.trim() || 'ws://localhost:8765';
    if (!wsUrl.startsWith('wss://') && !wsUrl.startsWith('ws://')) {
      wsUrl = `wss://${wsUrl}`;
    }

    // Token is optional for localhost connections (--no-auth mode)
    const trimmedToken = token.trim();
    if (!trimmedToken && !isLocalUrl(wsUrl)) {
      Alert.alert('Missing Token', 'API token is required for remote connections');
      return;
    }

    Keyboard.dismiss();
    connect(wsUrl, trimmedToken);
  };

  const handleReconnect = () => {
    if (savedConnection) {
      connect(savedConnection.url, savedConnection.token);
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
    setDiscoveredServers([]);
    setScanProgress(0);

    const abort = new AbortController();
    scanAbortRef.current = abort;

    try {
      const deviceIp = await Network.getIpAddressAsync();
      if (!deviceIp || abort.signal.aborted) {
        setScanning(false);
        return;
      }

      const subnet = deviceIp.split('.').slice(0, 3).join('.');
      const parsed = parseInt(scanPort, 10);
      if (isNaN(parsed) || parsed < 1 || parsed > 65535) {
        Alert.alert('Invalid Port', `Port must be between 1 and 65535. Using default (${DEFAULT_PORT}).`);
        setScanPort(String(DEFAULT_PORT));
        setScanning(false);
        return;
      }
      const port = parsed;
      const batchSize = 30;
      let scanned = 0;

      for (let start = 1; start <= 254 && !abort.signal.aborted; start += batchSize) {
        const batch: Promise<DiscoveredServer | null>[] = [];
        for (let i = start; i < Math.min(start + batchSize, 255); i++) {
          const targetIp = `${subnet}.${i}`;
          batch.push(
            (async (): Promise<DiscoveredServer | null> => {
              const ctrl = new AbortController();
              const timeout = setTimeout(() => ctrl.abort(), 1500);
              // Propagate outer abort signal to cancel in-flight requests immediately
              const onOuterAbort = () => ctrl.abort();
              abort.signal.addEventListener('abort', onOuterAbort);
              try {
                const res = await fetch(`http://${targetIp}:${port}/health`, { signal: ctrl.signal });
                const data = await res.json();
                if (data.status === 'ok') {
                  return { ip: targetIp, port, hostname: data.hostname || targetIp, mode: data.mode || 'unknown', version: data.version || '' };
                }
              } catch {
                // Expected for most IPs
              } finally {
                clearTimeout(timeout);
                abort.signal.removeEventListener('abort', onOuterAbort);
              }
              return null;
            })()
          );
        }

        const results = await Promise.all(batch);
        if (abort.signal.aborted) break;

        const found = results.filter((r): r is DiscoveredServer => r !== null);
        if (found.length > 0) {
          setDiscoveredServers((prev) => [...prev, ...found]);
        }
        scanned += batch.length;
        setScanProgress(Math.min(scanned / 254, 1));
      }
    } catch {
      Alert.alert(
        'Network Error',
        'Could not scan the local network. Make sure you are connected to WiFi and your phone and computer are on the same network.',
      );
    }

    if (!abort.signal.aborted) {
      setScanProgress(1);
      setScanning(false);
      setScanCompleted(true);
    }
  }, [scanning, scanPort]);

  const handleSelectDiscovered = (server: DiscoveredServer) => {
    setUrl(`ws://${server.ip}:${server.port}`);
    setShowManual(true);
    setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 100);
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
            useConnectionStore.getState().disconnect();
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
        <View style={styles.discoveredSection}>
          <Text style={styles.scanEmptyText}>No servers found on LAN (port {scanPort})</Text>
        </View>
      )}

      <TouchableOpacity
        style={styles.manualToggle}
        onPress={() => setShowManual(!showManual)}
        accessibilityRole="button"
        accessibilityLabel="Enter server address manually"
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
          />

          <Text style={styles.label}>
            API Token{isLocalUrl(url.trim() || 'ws://localhost:8765') ? ' (optional for localhost)' : ''}
          </Text>
          <TextInput
            style={styles.input}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            placeholderTextColor={COLORS.textDim}
            value={token}
            onChangeText={setToken}
            onFocus={scrollToInput}
            autoCapitalize="none"
            autoCorrect={false}
            secureTextEntry
            accessibilityLabel="API Token"
          />

          <TouchableOpacity style={styles.connectButton} onPress={handleConnect} accessibilityRole="button" accessibilityLabel="Connect to server">
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
