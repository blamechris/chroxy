/**
 * Hook for biometric app lock (Face ID / Touch ID).
 *
 * Uses expo-local-authentication to gate app access when returning
 * from background. The setting is persisted in SecureStore.
 */
import { useEffect, useRef, useCallback, useState } from 'react';
import { AppState, type AppStateStatus } from 'react-native';
import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';

const STORAGE_KEY = 'chroxy_biometric_enabled';

/** Check whether the device supports biometric auth */
export async function isBiometricAvailable(): Promise<boolean> {
  try {
    const compatible = await LocalAuthentication.hasHardwareAsync();
    if (!compatible) return false;
    const enrolled = await LocalAuthentication.isEnrolledAsync();
    return enrolled;
  } catch {
    return false;
  }
}

/** Read persisted biometric preference */
export async function getBiometricEnabled(): Promise<boolean> {
  try {
    const raw = await SecureStore.getItemAsync(STORAGE_KEY);
    return raw === 'true';
  } catch {
    return false;
  }
}

/** Persist biometric preference */
export async function setBiometricEnabled(enabled: boolean): Promise<void> {
  try {
    await SecureStore.setItemAsync(STORAGE_KEY, enabled ? 'true' : 'false');
  } catch {
    // Storage not available
  }
}

/** Prompt for biometric authentication. Returns true if successful. */
export async function authenticate(): Promise<boolean> {
  try {
    const result = await LocalAuthentication.authenticateAsync({
      promptMessage: 'Unlock Chroxy',
      fallbackLabel: 'Use Passcode',
      cancelLabel: 'Cancel',
      disableDeviceFallback: false,
    });
    return result.success;
  } catch {
    return false;
  }
}

/**
 * Hook that manages biometric lock state. Returns:
 * - isLocked: whether the app is currently locked
 * - unlock: trigger biometric prompt
 */
export function useBiometricLock() {
  const [isLocked, setIsLocked] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const wentBackground = useRef(false);

  // Load setting on mount
  useEffect(() => {
    getBiometricEnabled().then(setEnabled);
  }, []);

  // Track app state transitions and re-sync preference on foreground
  useEffect(() => {
    const sub = AppState.addEventListener('change', (next: AppStateStatus) => {
      const prev = appStateRef.current;
      appStateRef.current = next;

      if (prev === 'active' && (next === 'background' || next === 'inactive')) {
        wentBackground.current = true;
      }

      if (next === 'active') {
        // Re-read preference on every foreground transition so Settings
        // toggle changes take effect without restart
        getBiometricEnabled().then((val) => {
          setEnabled(val);
          if (!val) {
            // Preference was disabled — ensure unlocked
            setIsLocked(false);
            return;
          }
          if (wentBackground.current) {
            wentBackground.current = false;
            setIsLocked(true);
          }
        });
      }
    });

    return () => sub.remove();
  }, []);

  const unlock = useCallback(async () => {
    const success = await authenticate();
    if (success) {
      setIsLocked(false);
    }
    return success;
  }, []);

  // Re-sync when enabled changes externally (e.g., settings toggle)
  const refresh = useCallback(async () => {
    const val = await getBiometricEnabled();
    setEnabled(val);
    if (!val) setIsLocked(false);
  }, []);

  return { isLocked, unlock, refresh, enabled };
}
