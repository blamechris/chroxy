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
 * - gateReady: whether the cold-start lock decision has resolved. The app must
 *   NOT mount the navigator (and thus must not auto-reconnect using the stored
 *   token) until this is true — otherwise a cold start races the async
 *   preference read and opens straight into the app, bypassing the lock (#5643).
 * - unlock: trigger biometric prompt
 * - refresh: re-read the preference (e.g. after a Settings toggle)
 * - enabled: current biometric-lock preference
 */
export function useBiometricLock() {
  // Cold-start default is LOCKED-pending: until the async preference read
  // resolves we keep the gate closed (gateReady=false) so no app content or
  // auto-reconnect can run. We do NOT default isLocked=true here because that
  // would flash the LockScreen even for users with the preference disabled;
  // instead the gate hides everything until we know which state to land in.
  const [isLocked, setIsLocked] = useState(false);
  const [enabled, setEnabled] = useState(false);
  const [gateReady, setGateReady] = useState(false);
  const appStateRef = useRef<AppStateStatus>(AppState.currentState);
  const wentBackground = useRef(false);

  // Resolve the cold-start lock decision on mount. This MUST complete before
  // the navigator mounts (App gates on gateReady), so the stored-token
  // auto-reconnect can't fire while the app should be locked.
  useEffect(() => {
    let cancelled = false;
    getBiometricEnabled().then(async (val) => {
      if (cancelled) return;
      setEnabled(val);
      if (!val) {
        // Preference disabled — never lock, open the gate immediately.
        setIsLocked(false);
        setGateReady(true);
        return;
      }
      // Preference enabled. Guard against a permanent lockout: if biometric
      // enrollment was revoked (e.g. all fingerprints/Face ID removed) the
      // unlock prompt would always fail, so auto-disable and open the gate —
      // mirrors the SettingsScreen auto-disable path.
      const available = await isBiometricAvailable();
      if (cancelled) return;
      if (!available) {
        await setBiometricEnabled(false);
        if (cancelled) return;
        setEnabled(false);
        setIsLocked(false);
        setGateReady(true);
        return;
      }
      // Enabled and available — lock on cold start, then open the gate so the
      // LockScreen renders (the navigator stays unmounted until unlock).
      setIsLocked(true);
      setGateReady(true);
    });
    return () => {
      cancelled = true;
    };
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

  return { isLocked, gateReady, unlock, refresh, enabled };
}
