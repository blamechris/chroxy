/**
 * Tests for WS close code and HTTP health check error message helpers.
 *
 * Verifies that only codes the server actually sends get specific messages,
 * and that dead-code arms for codes the server never sends are not present.
 */

// Mock haptics first — avoids native module load errors when importing connection.ts
jest.mock('../../utils/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: jest.fn(),
  hapticWarning: jest.fn(),
  hapticHeavy: jest.fn(),
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
jest.mock('../../store/message-handler', () => ({
  wsSend: jest.fn(),
  handleMessage: jest.fn(),
  setStore: jest.fn(),
  setStoreRef: jest.fn(),
  setConnectionContext: jest.fn(),
  setEncryptionState: jest.fn(),
  setPendingKeyPair: jest.fn(),
  getEncryptionState: jest.fn(() => null),
  getPendingKeyPair: jest.fn(() => null),
  connectionAttemptId: 0,
  bumpConnectionAttemptId: jest.fn(),
  disconnectedAttemptId: -1,
  setDisconnectedAttemptId: jest.fn(),
  lastConnectedUrl: null,
  setLastConnectedUrl: jest.fn(),
  pendingPairingId: null,
  setPendingPairingId: jest.fn(),
  setPendingSwitchSessionId: jest.fn(),
  resetReplayFlags: jest.fn(),
  clearPermissionSplits: jest.fn(),
  clearTerminalWriteBatching: jest.fn(),
  appendPendingTerminalWrite: jest.fn(),
  stopHeartbeat: jest.fn(),
  clearDeltaBuffers: jest.fn(),
  clearMessageQueue: jest.fn(),
  enqueueMessage: jest.fn(),
  updateSession: jest.fn(),
  updateActiveSession: jest.fn(),
  saveConnection: jest.fn(),
  clearConnection: jest.fn(),
  loadConnection: jest.fn().mockResolvedValue(null),
  drainMessageQueue: jest.fn(),
  CLIENT_PROTOCOL_VERSION: 1,
  _testQueueInternals: {},
  _testMessageHandler: jest.fn(),
}));

import { getWsCloseMessage, getHealthCheckErrorMessage } from '../../store/connection';

describe('getWsCloseMessage', () => {
  describe('codes the server actually sends', () => {
    it('returns null for 1000 (normal close — no error to show)', () => {
      expect(getWsCloseMessage(1000)).toBeNull();
    });

    it('returns encryption message for 1008 (ws-auth.js key exchange failure)', () => {
      const msg = getWsCloseMessage(1008);
      expect(msg).not.toBeNull();
      expect(msg).toMatch(/encryption failed/i);
      expect(msg).toMatch(/up to date/i);
    });

    it('returns backpressure message for 4008 (ws-broadcaster.js / ws-client-sender.js eviction)', () => {
      const msg = getWsCloseMessage(4008);
      expect(msg).not.toBeNull();
      expect(msg).toMatch(/overwhelmed|dropped/i);
    });
  });

  describe('browser/RN-generated codes (not sent by server)', () => {
    it('returns network message for 1006 (abnormal closure / network drop)', () => {
      const msg = getWsCloseMessage(1006);
      expect(msg).not.toBeNull();
      expect(msg).toMatch(/connection lost|network/i);
    });
  });

  describe('unknown codes', () => {
    it('returns generic message for unknown close codes', () => {
      const msg = getWsCloseMessage(9999);
      expect(msg).not.toBeNull();
      expect(msg).toMatch(/connection failed/i);
    });

    it('returns generic message for close code 0 (unexpected)', () => {
      const msg = getWsCloseMessage(0);
      expect(msg).not.toBeNull();
    });
  });

  describe('codes the server does NOT send (no dead-code arms)', () => {
    it('4001 is not a known server code — falls to generic message', () => {
      const msg = getWsCloseMessage(4001);
      // Should be the generic fallback, not a specific message
      expect(msg).toMatch(/connection failed/i);
    });

    it('4003 is not a known server code — falls to generic message', () => {
      const msg = getWsCloseMessage(4003);
      expect(msg).toMatch(/connection failed/i);
    });

    it('4004 is not a known server code — falls to generic message', () => {
      const msg = getWsCloseMessage(4004);
      expect(msg).toMatch(/connection failed/i);
    });
  });
});

describe('getHealthCheckErrorMessage', () => {
  it('returns timeout message for AbortError', () => {
    const msg = getHealthCheckErrorMessage({ name: 'AbortError', message: 'The user aborted a request.' });
    expect(msg).toMatch(/not responding/i);
  });

  it('returns token message for HTTP 4xx errors', () => {
    const msg = getHealthCheckErrorMessage({ message: 'HTTP 403' });
    expect(msg).toMatch(/token|rejected/i);
  });

  it('returns token message for HTTP 401 (unauthorized)', () => {
    const msg = getHealthCheckErrorMessage({ message: 'HTTP 401' });
    expect(msg).toMatch(/token|rejected/i);
  });

  it('returns server error message for HTTP 5xx errors', () => {
    const msg = getHealthCheckErrorMessage({ message: 'HTTP 503' });
    expect(msg).toMatch(/server error|restarting/i);
  });

  it('returns server error message for HTTP 500', () => {
    const msg = getHealthCheckErrorMessage({ message: 'HTTP 500' });
    expect(msg).toMatch(/server error|restarting/i);
  });

  it('returns unreachable message for other HTTP codes', () => {
    const msg = getHealthCheckErrorMessage({ message: 'HTTP 301' });
    expect(msg).toMatch(/unreachable|HTTP 301/i);
  });

  it('returns network message for non-HTTP errors', () => {
    const msg = getHealthCheckErrorMessage({ message: 'Network request failed' });
    expect(msg).toMatch(/network|reach/i);
  });

  it('handles missing message gracefully', () => {
    const msg = getHealthCheckErrorMessage({});
    expect(typeof msg).toBe('string');
    expect(msg.length).toBeGreaterThan(0);
  });
});
