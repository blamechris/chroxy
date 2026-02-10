import React, { useState, useRef, useEffect } from 'react';
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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import { useConnectionStore } from '../store/connection';
import { ICON_SATELLITE, ICON_CAMERA, ICON_TRIANGLE_DOWN, ICON_TRIANGLE_RIGHT } from '../constants/icons';
import { COLORS } from '../constants/colors';


function parseChroxyUrl(raw: string): { wsUrl: string; token: string } | null {
  try {
    let trimmed = raw.trim();
    if (trimmed.startsWith('chroxy://')) {
      const parsed = new URL(trimmed.replace('chroxy://', 'https://'));
      const wsUrl = `wss://${parsed.host}`;
      const token = parsed.searchParams.get('token');
      if (wsUrl && token) return { wsUrl, token };
    }
    if (trimmed.startsWith('wss://')) {
      return { wsUrl: trimmed, token: '' };
    }
  } catch {
    // Invalid URL
  }
  return null;
}

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

  const connect = useConnectionStore((state) => state.connect);
  const connectionPhase = useConnectionStore((state) => state.connectionPhase);
  const savedConnection = useConnectionStore((state) => state.savedConnection);
  const loadSavedConnection = useConnectionStore((state) => state.loadSavedConnection);
  const clearSavedConnection = useConnectionStore((state) => state.clearSavedConnection);

  // Load saved connection and auto-connect on mount
  useEffect(() => {
    loadSavedConnection().then(() => {
      const saved = useConnectionStore.getState().savedConnection;
      if (saved) {
        setAutoConnecting(true);
        connect(saved.url, saved.token, { silent: true });
      }
    });
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
    if (parsed && parsed.token) {
      setShowScanner(false);
      connect(parsed.wsUrl, parsed.token);
    } else {
      Alert.alert(
        'Invalid QR Code',
        'This doesn\'t look like a Chroxy connection code. Make sure you\'re scanning the QR from "npx chroxy start".',
        [{ text: 'Try Again', onPress: () => { scanLock.current = false; } }],
      );
    }
  };

  const scrollToInput = () => {
    setTimeout(() => {
      scrollRef.current?.scrollToEnd({ animated: true });
    }, 300);
  };

  if (autoConnecting) {
    return (
      <View style={styles.autoConnectContainer}>
        <Text style={styles.logo}>{ICON_SATELLITE}</Text>
        <ActivityIndicator size="large" color={COLORS.accentBlue} style={styles.autoConnectSpinner} />
        <Text style={styles.autoConnectText}>
          Connecting to {savedConnection ? formatUrl(savedConnection.url) : 'server'}...
        </Text>
        <TouchableOpacity
          style={styles.autoConnectCancel}
          onPress={() => {
            setAutoConnecting(false);
            useConnectionStore.getState().disconnect();
          }}
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
        <Text style={styles.logo}>{ICON_SATELLITE}</Text>
        <Text style={styles.title}>Connect to Chroxy</Text>
        <Text style={styles.subtitle}>
          Run 'npx chroxy start' on your Mac, then scan the QR code
        </Text>
      </View>

      {/* Quick reconnect */}
      {savedConnection && (
        <View style={styles.savedSection}>
          <TouchableOpacity style={styles.reconnectButton} onPress={handleReconnect}>
            <Text style={styles.reconnectButtonText}>Reconnect</Text>
            <Text style={styles.reconnectUrl}>{formatUrl(savedConnection.url)}</Text>
          </TouchableOpacity>
          <TouchableOpacity style={styles.forgetButton} onPress={clearSavedConnection}>
            <Text style={styles.forgetButtonText}>Forget</Text>
          </TouchableOpacity>
        </View>
      )}

      <TouchableOpacity style={styles.qrButton} onPress={handleScanQR}>
        <Text style={styles.qrButtonText}>{ICON_CAMERA} Scan QR Code</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.manualToggle}
        onPress={() => setShowManual(!showManual)}
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
          />

          <TouchableOpacity style={styles.connectButton} onPress={handleConnect}>
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
  // QR and manual
  qrButton: {
    backgroundColor: COLORS.accentBlue,
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 24,
  },
  qrButtonText: {
    color: COLORS.textPrimary,
    fontSize: 18,
    fontWeight: '600',
  },
  manualToggle: {
    alignItems: 'center',
    paddingVertical: 12,
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
