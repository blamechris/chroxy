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
} from 'react-native';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { CameraView, useCameraPermissions, BarcodeScanningResult } from 'expo-camera';
import { useConnectionStore } from '../store/connection';

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
  // Show a friendly version: "192.168.1.5:8765" or "abc.ngrok-free.dev"
  return url.replace(/^wss?:\/\//, '');
}

export function ConnectScreen() {
  const [url, setUrl] = useState('');
  const [token, setToken] = useState('');
  const [showManual, setShowManual] = useState(false);
  const [showScanner, setShowScanner] = useState(false);
  const [permission, requestPermission] = useCameraPermissions();
  const insets = useSafeAreaInsets();
  const scanLock = useRef(false);
  const scrollRef = useRef<ScrollView>(null);

  const connect = useConnectionStore((state) => state.connect);
  const savedConnection = useConnectionStore((state) => state.savedConnection);
  const loadSavedConnection = useConnectionStore((state) => state.loadSavedConnection);
  const clearSavedConnection = useConnectionStore((state) => state.clearSavedConnection);

  useEffect(() => {
    loadSavedConnection();
  }, []);

  const handleConnect = () => {
    if (!url || !token) {
      Alert.alert('Missing Info', 'Please enter both URL and token');
      return;
    }

    let wsUrl = url.trim();
    if (!wsUrl.startsWith('wss://') && !wsUrl.startsWith('ws://')) {
      wsUrl = `wss://${wsUrl}`;
    }

    Keyboard.dismiss();
    connect(wsUrl, token.trim());
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
        <Text style={styles.logo}>📡</Text>
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
        <Text style={styles.qrButtonText}>📷 Scan QR Code</Text>
      </TouchableOpacity>

      <TouchableOpacity
        style={styles.manualToggle}
        onPress={() => setShowManual(!showManual)}
      >
        <Text style={styles.manualToggleText}>
          {showManual ? '▼ Hide manual entry' : '▶ Enter manually'}
        </Text>
      </TouchableOpacity>

      {showManual && (
        <View style={styles.manualForm}>
          <Text style={styles.label}>Server URL</Text>
          <TextInput
            style={styles.input}
            placeholder="ws://your-mac-ip:8765"
            placeholderTextColor="#666"
            value={url}
            onChangeText={setUrl}
            onFocus={scrollToInput}
            autoCapitalize="none"
            autoCorrect={false}
          />

          <Text style={styles.label}>API Token</Text>
          <TextInput
            style={styles.input}
            placeholder="xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
            placeholderTextColor="#666"
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
    backgroundColor: '#0f0f1a',
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
    color: '#fff',
    marginBottom: 8,
  },
  subtitle: {
    fontSize: 16,
    color: '#888',
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
    backgroundColor: '#22c55e',
    paddingVertical: 16,
    paddingHorizontal: 20,
    borderRadius: 12,
    alignItems: 'center',
  },
  reconnectButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  reconnectUrl: {
    color: 'rgba(255,255,255,0.7)',
    fontSize: 12,
    marginTop: 4,
  },
  forgetButton: {
    paddingVertical: 16,
    paddingHorizontal: 16,
  },
  forgetButtonText: {
    color: '#ff4a4a',
    fontSize: 14,
  },
  // QR and manual
  qrButton: {
    backgroundColor: '#4a9eff',
    paddingVertical: 16,
    paddingHorizontal: 32,
    borderRadius: 12,
    alignItems: 'center',
    marginBottom: 24,
  },
  qrButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  manualToggle: {
    alignItems: 'center',
    paddingVertical: 12,
  },
  manualToggleText: {
    color: '#4a9eff',
    fontSize: 14,
  },
  manualForm: {
    marginTop: 16,
  },
  label: {
    color: '#888',
    fontSize: 14,
    marginBottom: 8,
    marginTop: 16,
  },
  input: {
    backgroundColor: '#1a1a2e',
    borderRadius: 8,
    padding: 16,
    color: '#fff',
    fontSize: 16,
    borderWidth: 1,
    borderColor: '#2a2a4e',
  },
  connectButton: {
    backgroundColor: '#22c55e',
    paddingVertical: 16,
    borderRadius: 12,
    alignItems: 'center',
    marginTop: 24,
  },
  connectButtonText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '600',
  },
  // Scanner styles
  scannerContainer: {
    flex: 1,
    backgroundColor: '#000',
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
    borderColor: '#4a9eff',
    borderRadius: 16,
    backgroundColor: 'transparent',
  },
  scannerHint: {
    color: '#fff',
    fontSize: 16,
    marginTop: 24,
    textAlign: 'center',
    paddingHorizontal: 40,
  },
  cancelButton: {
    position: 'absolute',
    bottom: 60,
    alignSelf: 'center',
    backgroundColor: 'rgba(255,255,255,0.2)',
    paddingVertical: 14,
    paddingHorizontal: 40,
    borderRadius: 12,
  },
  cancelButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '600',
  },
});
