import React from 'react';
import { AppState, type AppStateStatus } from 'react-native';

// Mock expo-local-authentication
jest.mock('expo-local-authentication', () => ({
  hasHardwareAsync: jest.fn(() => Promise.resolve(true)),
  isEnrolledAsync: jest.fn(() => Promise.resolve(true)),
  authenticateAsync: jest.fn(() => Promise.resolve({ success: true })),
}));

// Mock expo-secure-store
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
}));

import * as LocalAuthentication from 'expo-local-authentication';
import * as SecureStore from 'expo-secure-store';
import {
  isBiometricAvailable,
  getBiometricEnabled,
  setBiometricEnabled,
  authenticate,
  useBiometricLock,
} from '../../hooks/useBiometricLock';

// Capture AppState listener
let appStateCallback: ((state: AppStateStatus) => void) | null = null;
const removeSpy = jest.fn();
jest.spyOn(AppState, 'addEventListener').mockImplementation((_event, callback) => {
  appStateCallback = callback as (state: AppStateStatus) => void;
  return { remove: removeSpy } as any;
});

import { renderHookSimple, actAsync, flushMicrotasks } from '../../test-utils/test-helpers';

beforeEach(() => {
  jest.clearAllMocks();
  appStateCallback = null;
  // Reset AppState.currentState so the hook's ref starts at 'active'
  Object.defineProperty(AppState, 'currentState', {
    value: 'active',
    writable: true,
    configurable: true,
  });
  (SecureStore.getItemAsync as jest.Mock).mockResolvedValue(null);
  (LocalAuthentication.hasHardwareAsync as jest.Mock).mockResolvedValue(true);
  (LocalAuthentication.isEnrolledAsync as jest.Mock).mockResolvedValue(true);
  (LocalAuthentication.authenticateAsync as jest.Mock).mockResolvedValue({ success: true });
});

// ---------------------------------------------------------------------------
// Standalone function tests
// ---------------------------------------------------------------------------

describe('isBiometricAvailable', () => {
  it('returns true when hardware present and enrolled', async () => {
    expect(await isBiometricAvailable()).toBe(true);
  });

  it('returns false when hardware not present', async () => {
    (LocalAuthentication.hasHardwareAsync as jest.Mock).mockResolvedValue(false);
    expect(await isBiometricAvailable()).toBe(false);
  });

  it('returns false when not enrolled', async () => {
    (LocalAuthentication.isEnrolledAsync as jest.Mock).mockResolvedValue(false);
    expect(await isBiometricAvailable()).toBe(false);
  });

  it('returns false on error', async () => {
    (LocalAuthentication.hasHardwareAsync as jest.Mock).mockRejectedValue(new Error('fail'));
    expect(await isBiometricAvailable()).toBe(false);
  });
});

describe('getBiometricEnabled / setBiometricEnabled', () => {
  it('returns false when not set', async () => {
    expect(await getBiometricEnabled()).toBe(false);
  });

  it('returns true when stored as "true"', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValue('true');
    expect(await getBiometricEnabled()).toBe(true);
  });

  it('round-trips via SecureStore', async () => {
    await setBiometricEnabled(true);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('chroxy_biometric_enabled', 'true');

    await setBiometricEnabled(false);
    expect(SecureStore.setItemAsync).toHaveBeenCalledWith('chroxy_biometric_enabled', 'false');
  });

  it('handles SecureStore errors gracefully', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockRejectedValue(new Error('fail'));
    expect(await getBiometricEnabled()).toBe(false);
  });
});

describe('authenticate', () => {
  it('returns true on success', async () => {
    expect(await authenticate()).toBe(true);
    expect(LocalAuthentication.authenticateAsync).toHaveBeenCalledWith(
      expect.objectContaining({ promptMessage: 'Unlock Chroxy' }),
    );
  });

  it('returns false on failure', async () => {
    (LocalAuthentication.authenticateAsync as jest.Mock).mockResolvedValue({ success: false });
    expect(await authenticate()).toBe(false);
  });

  it('returns false on error', async () => {
    (LocalAuthentication.authenticateAsync as jest.Mock).mockRejectedValue(new Error('fail'));
    expect(await authenticate()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Hook tests
// ---------------------------------------------------------------------------

describe('useBiometricLock', () => {
  it('initializes with isLocked=false and enabled=false', async () => {
    const { result } = renderHookSimple(() => useBiometricLock());
    await actAsync(async () => { await flushMicrotasks(); });
    expect(result.current.isLocked).toBe(false);
    expect(result.current.enabled).toBe(false);
  });

  it('reads enabled state on mount', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValue('true');
    const { result } = renderHookSimple(() => useBiometricLock());
    await actAsync(async () => { await flushMicrotasks(); });
    expect(result.current.enabled).toBe(true);
  });

  it('locks on background->foreground when enabled', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValue('true');
    const { result } = renderHookSimple(() => useBiometricLock());
    await actAsync(async () => { await flushMicrotasks(); });
    expect(result.current.enabled).toBe(true);

    // Go to background
    await actAsync(async () => { appStateCallback?.('background'); });
    // Return to foreground — triggers getBiometricEnabled + setIsLocked(true)
    await actAsync(async () => { appStateCallback?.('active'); });
    await actAsync(async () => { await flushMicrotasks(); });

    expect(result.current.isLocked).toBe(true);
  });

  it('does NOT lock on background->foreground when disabled', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValue('false');
    const { result } = renderHookSimple(() => useBiometricLock());
    await actAsync(async () => { await flushMicrotasks(); });

    await actAsync(async () => { appStateCallback?.('background'); });
    await actAsync(async () => { appStateCallback?.('active'); });
    await actAsync(async () => { await flushMicrotasks(); });

    expect(result.current.isLocked).toBe(false);
  });

  it('unlock() calls authenticate and unlocks on success', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValue('true');
    const { result } = renderHookSimple(() => useBiometricLock());
    await actAsync(async () => { await flushMicrotasks(); });

    // Lock
    await actAsync(async () => { appStateCallback?.('background'); });
    await actAsync(async () => { appStateCallback?.('active'); });
    await actAsync(async () => { await flushMicrotasks(); });
    expect(result.current.isLocked).toBe(true);

    // Unlock
    let success: boolean | undefined;
    await actAsync(async () => { success = await result.current.unlock(); });
    expect(success).toBe(true);
    expect(result.current.isLocked).toBe(false);
  });

  it('unlock() keeps locked on auth failure', async () => {
    (LocalAuthentication.authenticateAsync as jest.Mock).mockResolvedValue({ success: false });
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValue('true');
    const { result } = renderHookSimple(() => useBiometricLock());
    await actAsync(async () => { await flushMicrotasks(); });

    // Lock
    await actAsync(async () => { appStateCallback?.('background'); });
    await actAsync(async () => { appStateCallback?.('active'); });
    await actAsync(async () => { await flushMicrotasks(); });
    expect(result.current.isLocked).toBe(true);

    // Failed unlock
    await actAsync(async () => { await result.current.unlock(); });
    expect(result.current.isLocked).toBe(true);
  });

  it('refresh() re-reads preference and unlocks when disabled externally', async () => {
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValue('true');
    const { result } = renderHookSimple(() => useBiometricLock());
    await actAsync(async () => { await flushMicrotasks(); });

    // Lock
    await actAsync(async () => { appStateCallback?.('background'); });
    await actAsync(async () => { appStateCallback?.('active'); });
    await actAsync(async () => { await flushMicrotasks(); });
    expect(result.current.isLocked).toBe(true);

    // Externally disable
    (SecureStore.getItemAsync as jest.Mock).mockResolvedValue('false');
    await actAsync(async () => { await result.current.refresh(); });
    expect(result.current.enabled).toBe(false);
    expect(result.current.isLocked).toBe(false);
  });

  it('cleans up AppState listener on unmount', () => {
    const { unmount } = renderHookSimple(() => useBiometricLock());
    unmount();
    expect(removeSpy).toHaveBeenCalled();
  });
});
