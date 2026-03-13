/**
 * Tests for useConnectionLifecycleStore — extracted connection lifecycle state.
 */

// Mock wsSend before importing anything
const wsSendCalls: { socket: unknown; payload: unknown }[] = [];
jest.mock('../../store/message-handler', () => ({
  wsSend: (socket: unknown, payload: unknown) => {
    wsSendCalls.push({ socket, payload });
  },
  // Stub other exports that connection.ts might import
  handleMessage: jest.fn(),
  setStoreRef: jest.fn(),
  updateActiveSession: jest.fn(),
  saveConnection: jest.fn(),
  clearConnection: jest.fn(),
  loadConnection: jest.fn().mockResolvedValue(null),
  drainMessageQueue: jest.fn(),
  CLIENT_PROTOCOL_VERSION: 1,
}));

jest.mock('react-native', () => ({
  Alert: { alert: jest.fn() },
  AppState: { addEventListener: jest.fn(() => ({ remove: jest.fn() })) },
  Platform: { OS: 'ios' },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn().mockResolvedValue(null),
  setItemAsync: jest.fn().mockResolvedValue(undefined),
  deleteItemAsync: jest.fn().mockResolvedValue(undefined),
}));

jest.mock('expo-device', () => ({
  deviceName: 'Test Device',
  deviceType: 1,
  osName: 'iOS',
}));

import { useConnectionLifecycleStore } from '../../store/connection-lifecycle';

beforeEach(() => {
  // Hard reset: reset() preserves savedConnection/userDisconnected,
  // so explicitly clear them to prevent cross-test leakage
  useConnectionLifecycleStore.getState().reset();
  useConnectionLifecycleStore.getState().setSavedConnection(null);
  useConnectionLifecycleStore.getState().setUserDisconnected(false);
  wsSendCalls.length = 0;
});

describe('useConnectionLifecycleStore', () => {
  describe('initial state', () => {
    it('has disconnected phase', () => {
      const state = useConnectionLifecycleStore.getState();
      expect(state.connectionPhase).toBe('disconnected');
    });

    it('has null connection fields', () => {
      const state = useConnectionLifecycleStore.getState();
      expect(state.wsUrl).toBeNull();
      expect(state.apiToken).toBeNull();
      expect(state.serverMode).toBeNull();
      expect(state.serverVersion).toBeNull();
      expect(state.latestVersion).toBeNull();
      expect(state.serverCommit).toBeNull();
      expect(state.serverProtocolVersion).toBeNull();
      expect(state.sessionCwd).toBeNull();
      expect(state.isEncrypted).toBe(false);
    });

    it('has null connection quality', () => {
      const state = useConnectionLifecycleStore.getState();
      expect(state.latencyMs).toBeNull();
      expect(state.connectionQuality).toBeNull();
      expect(state.connectionError).toBeNull();
      expect(state.connectionRetryCount).toBe(0);
    });

    it('has no saved connection', () => {
      const state = useConnectionLifecycleStore.getState();
      expect(state.savedConnection).toBeNull();
      expect(state.userDisconnected).toBe(false);
    });
  });

  describe('setConnectionPhase', () => {
    it('updates connectionPhase', () => {
      useConnectionLifecycleStore.getState().setConnectionPhase('connecting');
      expect(useConnectionLifecycleStore.getState().connectionPhase).toBe('connecting');
    });
  });

  describe('setServerInfo', () => {
    it('sets all server info fields', () => {
      useConnectionLifecycleStore.getState().setServerInfo({
        serverMode: 'cli',
        serverVersion: '0.5.0',
        latestVersion: '0.5.1',
        serverCommit: 'abc123',
        serverProtocolVersion: 1,
        sessionCwd: '/home/user',
        isEncrypted: true,
      });
      const state = useConnectionLifecycleStore.getState();
      expect(state.serverMode).toBe('cli');
      expect(state.serverVersion).toBe('0.5.0');
      expect(state.latestVersion).toBe('0.5.1');
      expect(state.serverCommit).toBe('abc123');
      expect(state.serverProtocolVersion).toBe(1);
      expect(state.sessionCwd).toBe('/home/user');
      expect(state.isEncrypted).toBe(true);
    });

    it('allows partial updates', () => {
      useConnectionLifecycleStore.getState().setServerInfo({ serverVersion: '0.5.0' });
      useConnectionLifecycleStore.getState().setServerInfo({ sessionCwd: '/tmp' });
      const state = useConnectionLifecycleStore.getState();
      expect(state.serverVersion).toBe('0.5.0');
      expect(state.sessionCwd).toBe('/tmp');
    });
  });

  describe('setConnectionDetails', () => {
    it('sets url and token', () => {
      useConnectionLifecycleStore.getState().setConnectionDetails('wss://example.com', 'token123');
      const state = useConnectionLifecycleStore.getState();
      expect(state.wsUrl).toBe('wss://example.com');
      expect(state.apiToken).toBe('token123');
    });
  });

  describe('setConnectionQuality', () => {
    it('sets latency and quality', () => {
      useConnectionLifecycleStore.getState().setConnectionQuality(50, 'good');
      const state = useConnectionLifecycleStore.getState();
      expect(state.latencyMs).toBe(50);
      expect(state.connectionQuality).toBe('good');
    });
  });

  describe('setConnectionError', () => {
    it('sets error and retry count', () => {
      useConnectionLifecycleStore.getState().setConnectionError('Connection lost', 3);
      const state = useConnectionLifecycleStore.getState();
      expect(state.connectionError).toBe('Connection lost');
      expect(state.connectionRetryCount).toBe(3);
    });
  });

  describe('reset', () => {
    it('resets all fields to initial values', () => {
      const store = useConnectionLifecycleStore.getState();
      store.setConnectionPhase('connected');
      store.setConnectionDetails('wss://example.com', 'token123');
      store.setServerInfo({ serverVersion: '0.5.0', sessionCwd: '/home' });
      store.setConnectionQuality(50, 'good');
      store.setConnectionError('some error', 2);

      store.reset();

      const state = useConnectionLifecycleStore.getState();
      expect(state.connectionPhase).toBe('disconnected');
      expect(state.wsUrl).toBeNull();
      expect(state.apiToken).toBeNull();
      expect(state.serverVersion).toBeNull();
      expect(state.sessionCwd).toBeNull();
      expect(state.latencyMs).toBeNull();
      expect(state.connectionQuality).toBeNull();
      expect(state.connectionError).toBeNull();
      expect(state.connectionRetryCount).toBe(0);
    });

    it('preserves savedConnection on reset', () => {
      const store = useConnectionLifecycleStore.getState();
      store.setSavedConnection({ url: 'wss://saved.com', token: 'saved-token' });
      store.reset();
      expect(useConnectionLifecycleStore.getState().savedConnection).toEqual({
        url: 'wss://saved.com',
        token: 'saved-token',
      });
    });
  });

  describe('setSavedConnection', () => {
    it('sets saved connection', () => {
      useConnectionLifecycleStore.getState().setSavedConnection({
        url: 'wss://saved.com',
        token: 'saved-token',
      });
      expect(useConnectionLifecycleStore.getState().savedConnection).toEqual({
        url: 'wss://saved.com',
        token: 'saved-token',
      });
    });

    it('clears saved connection with null', () => {
      useConnectionLifecycleStore.getState().setSavedConnection({
        url: 'wss://saved.com',
        token: 'saved-token',
      });
      useConnectionLifecycleStore.getState().setSavedConnection(null);
      expect(useConnectionLifecycleStore.getState().savedConnection).toBeNull();
    });
  });

  describe('setUserDisconnected', () => {
    it('sets user disconnected flag', () => {
      useConnectionLifecycleStore.getState().setUserDisconnected(true);
      expect(useConnectionLifecycleStore.getState().userDisconnected).toBe(true);
    });
  });
});
