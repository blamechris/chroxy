import { Alert } from 'react-native';
import * as Notifications from 'expo-notifications';

// Spy on Alert.alert
const mockAlert = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

// Mock expo-notifications
jest.mock('expo-notifications', () => ({
  setNotificationHandler: jest.fn(),
  setNotificationCategoryAsync: jest.fn(),
  addNotificationResponseReceivedListener: jest.fn(),
  getPermissionsAsync: jest.fn(() =>
    Promise.resolve({ status: 'granted' }),
  ),
  requestPermissionsAsync: jest.fn(() =>
    Promise.resolve({ status: 'granted' }),
  ),
  getExpoPushTokenAsync: jest.fn(() =>
    Promise.resolve({ data: 'ExponentPushToken[test]' }),
  ),
  setNotificationChannelAsync: jest.fn(),
  DEFAULT_ACTION_IDENTIFIER: 'expo.modules.notifications.actions.DEFAULT',
  AndroidImportance: { HIGH: 4 },
}));

// Mock expo-device
jest.mock('expo-device', () => ({
  isDevice: true,
}));

// Mock expo-constants
jest.mock('expo-constants', () => ({
  expoConfig: { extra: { eas: { projectId: 'test-project' } } },
}));

// Mock expo-secure-store
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(),
  setItemAsync: jest.fn(),
  deleteItemAsync: jest.fn(),
}));

// Mock the connection store
const mockSocket = {
  readyState: 1, // WebSocket.OPEN
  send: jest.fn(),
};

const mockMarkPromptAnsweredByRequestId = jest.fn();

jest.mock('../store/connection', () => ({
  useConnectionStore: {
    getState: jest.fn(() => ({
      wsUrl: 'wss://test.trycloudflare.com',
      apiToken: 'test-token',
      socket: mockSocket,
      markPromptAnsweredByRequestId: mockMarkPromptAnsweredByRequestId,
    })),
  },
  loadConnection: jest.fn(() =>
    Promise.resolve({ url: 'wss://test.trycloudflare.com', token: 'test-token' }),
  ),
}));

// Import after mocks
import { setupNotificationResponseListener } from '../notifications';

const mockAddListener =
  Notifications.addNotificationResponseReceivedListener as jest.Mock;

const originalFetch = global.fetch;

beforeEach(() => {
  jest.clearAllMocks();
  mockSocket.readyState = 1; // WebSocket.OPEN
  // Reset getState mock to default
  const { useConnectionStore } = require('../store/connection');
  useConnectionStore.getState.mockReturnValue({
    wsUrl: 'wss://test.trycloudflare.com',
    apiToken: 'test-token',
    socket: mockSocket,
    markPromptAnsweredByRequestId: mockMarkPromptAnsweredByRequestId,
  });
});

afterEach(() => {
  global.fetch = originalFetch;
});

describe('setupNotificationResponseListener', () => {
  it('registers a notification response listener', () => {
    setupNotificationResponseListener();
    expect(mockAddListener).toHaveBeenCalledTimes(1);
    expect(typeof mockAddListener.mock.calls[0][0]).toBe('function');
  });

  it('maps approve action to allow decision via WebSocket', async () => {
    setupNotificationResponseListener();
    const handler = mockAddListener.mock.calls[0][0];

    await handler({
      actionIdentifier: 'approve',
      notification: {
        request: {
          content: {
            data: { category: 'permission', requestId: 'perm-123' },
          },
        },
      },
    });

    expect(mockSocket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'permission_response',
        requestId: 'perm-123',
        decision: 'allow',
      }),
    );
    expect(mockMarkPromptAnsweredByRequestId).toHaveBeenCalledWith('perm-123', 'allow');
  });

  it('maps deny action to deny decision via WebSocket', async () => {
    setupNotificationResponseListener();
    const handler = mockAddListener.mock.calls[0][0];

    await handler({
      actionIdentifier: 'deny',
      notification: {
        request: {
          content: {
            data: { category: 'permission', requestId: 'perm-456' },
          },
        },
      },
    });

    expect(mockSocket.send).toHaveBeenCalledWith(
      JSON.stringify({
        type: 'permission_response',
        requestId: 'perm-456',
        decision: 'deny',
      }),
    );
    expect(mockMarkPromptAnsweredByRequestId).toHaveBeenCalledWith('perm-456', 'deny');
  });

  it('ignores default action (body tap)', async () => {
    setupNotificationResponseListener();
    const handler = mockAddListener.mock.calls[0][0];

    await handler({
      actionIdentifier: 'expo.modules.notifications.actions.DEFAULT',
      notification: {
        request: {
          content: {
            data: { category: 'permission', requestId: 'perm-789' },
          },
        },
      },
    });

    expect(mockSocket.send).not.toHaveBeenCalled();
    expect(mockMarkPromptAnsweredByRequestId).not.toHaveBeenCalled();
  });

  it('ignores unknown action identifiers', async () => {
    setupNotificationResponseListener();
    const handler = mockAddListener.mock.calls[0][0];

    await handler({
      actionIdentifier: 'unknown_action',
      notification: {
        request: {
          content: {
            data: { category: 'permission', requestId: 'perm-unknown' },
          },
        },
      },
    });

    expect(mockSocket.send).not.toHaveBeenCalled();
    expect(mockMarkPromptAnsweredByRequestId).not.toHaveBeenCalled();
  });

  it('ignores non-permission categories', async () => {
    setupNotificationResponseListener();
    const handler = mockAddListener.mock.calls[0][0];

    await handler({
      actionIdentifier: 'approve',
      notification: {
        request: {
          content: {
            data: { category: 'idle', requestId: 'idle-1' },
          },
        },
      },
    });

    expect(mockSocket.send).not.toHaveBeenCalled();
    expect(mockMarkPromptAnsweredByRequestId).not.toHaveBeenCalled();
  });

  it('falls back to HTTP when WebSocket is disconnected', async () => {
    // Simulate disconnected socket
    mockSocket.readyState = 3; // WebSocket.CLOSED

    // Mock fetch for HTTP fallback
    const mockFetch = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200 }),
    ) as jest.Mock;
    global.fetch = mockFetch;

    setupNotificationResponseListener();
    const handler = mockAddListener.mock.calls[0][0];

    await handler({
      actionIdentifier: 'approve',
      notification: {
        request: {
          content: {
            data: { category: 'permission', requestId: 'perm-http-1' },
          },
        },
      },
    });

    // Should NOT have used WebSocket
    expect(mockSocket.send).not.toHaveBeenCalled();

    // Should have used HTTP fallback
    expect(mockFetch).toHaveBeenCalledTimes(1);
    const [url, opts] = mockFetch.mock.calls[0];
    expect(url).toBe('https://test.trycloudflare.com/permission-response');
    expect(opts.method).toBe('POST');
    expect(opts.headers.Authorization).toBe('Bearer test-token');
    expect(JSON.parse(opts.body)).toEqual({
      requestId: 'perm-http-1',
      decision: 'allow',
    });
    expect(mockMarkPromptAnsweredByRequestId).toHaveBeenCalledWith('perm-http-1', 'allow');
  });

  it('falls back to HTTP when socket is null', async () => {
    const { useConnectionStore } = require('../store/connection');
    useConnectionStore.getState.mockReturnValue({
      wsUrl: 'wss://test.trycloudflare.com',
      apiToken: 'test-token',
      socket: null,
      markPromptAnsweredByRequestId: mockMarkPromptAnsweredByRequestId,
    });

    const mockFetch = jest.fn(() =>
      Promise.resolve({ ok: true, status: 200 }),
    ) as jest.Mock;
    global.fetch = mockFetch;

    setupNotificationResponseListener();
    const handler = mockAddListener.mock.calls[0][0];

    await handler({
      actionIdentifier: 'deny',
      notification: {
        request: {
          content: {
            data: { category: 'permission', requestId: 'perm-http-2' },
          },
        },
      },
    });

    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(JSON.parse(mockFetch.mock.calls[0][1].body)).toEqual({
      requestId: 'perm-http-2',
      decision: 'deny',
    });
  });

  it('retries HTTP on transient failure then succeeds', async () => {
    jest.useFakeTimers();
    try {
      mockSocket.readyState = 3; // WebSocket.CLOSED

      // First call fails with 500, second succeeds
      const mockFetch = jest.fn()
        .mockResolvedValueOnce({ ok: false, status: 500 })
        .mockResolvedValueOnce({ ok: true, status: 200 }) as jest.Mock;
      global.fetch = mockFetch;

      setupNotificationResponseListener();
      const handler = mockAddListener.mock.calls[0][0];

      const promise = handler({
        actionIdentifier: 'approve',
        notification: {
          request: {
            content: {
              data: { category: 'permission', requestId: 'perm-retry-1' },
            },
          },
        },
      });

      // Advance past retry delays
      await jest.advanceTimersByTimeAsync(20_000);
      await promise;

      expect(mockFetch).toHaveBeenCalledTimes(2);
      expect(mockMarkPromptAnsweredByRequestId).toHaveBeenCalledWith('perm-retry-1', 'allow');
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not retry on 4xx client error', async () => {
    mockSocket.readyState = 3; // WebSocket.CLOSED

    const mockFetch = jest.fn(() =>
      Promise.resolve({ ok: false, status: 400 }),
    ) as jest.Mock;
    global.fetch = mockFetch;

    setupNotificationResponseListener();
    const handler = mockAddListener.mock.calls[0][0];

    await handler({
      actionIdentifier: 'approve',
      notification: {
        request: {
          content: {
            data: { category: 'permission', requestId: 'perm-4xx' },
          },
        },
      },
    });

    // Should NOT retry on 400
    expect(mockFetch).toHaveBeenCalledTimes(1);
    expect(mockMarkPromptAnsweredByRequestId).not.toHaveBeenCalled();
  });

  it('gives up after all retries exhausted', async () => {
    jest.useFakeTimers();
    try {
      mockSocket.readyState = 3; // WebSocket.CLOSED

      const mockFetch = jest.fn(() =>
        Promise.resolve({ ok: false, status: 502 }),
      ) as jest.Mock;
      global.fetch = mockFetch;

      setupNotificationResponseListener();
      const handler = mockAddListener.mock.calls[0][0];

      const promise = handler({
        actionIdentifier: 'approve',
        notification: {
          request: {
            content: {
              data: { category: 'permission', requestId: 'perm-exhaust' },
            },
          },
        },
      });

      // Advance past all retry delays
      await jest.advanceTimersByTimeAsync(20_000);
      await promise;

      // Should have tried 3 times (initial + 2 retries)
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockMarkPromptAnsweredByRequestId).not.toHaveBeenCalled();

      // Should show user-visible alert with Retry button
      expect(mockAlert).toHaveBeenCalledTimes(1);
      expect(mockAlert.mock.calls[0][0]).toBe('Permission Response Failed');
      expect(mockAlert.mock.calls[0][1]).toBe(
        'Could not deliver your response. Open the app to respond manually.',
      );
      const buttons = mockAlert.mock.calls[0][2] as Array<{
        text: string;
        onPress?: () => void;
      }>;
      expect(buttons).toHaveLength(2);
      expect(buttons[0].text).toBe('OK');
      expect(buttons[1].text).toBe('Retry');
    } finally {
      jest.useRealTimers();
    }
  });

  it('retry button in alert re-attempts HTTP delivery', async () => {
    jest.useFakeTimers();
    try {
      mockSocket.readyState = 3; // WebSocket.CLOSED

      // All initial attempts fail, then retry succeeds
      const mockFetch = jest.fn()
        .mockResolvedValue({ ok: false, status: 502 }) as jest.Mock;
      global.fetch = mockFetch;

      setupNotificationResponseListener();
      const handler = mockAddListener.mock.calls[0][0];

      const promise = handler({
        actionIdentifier: 'approve',
        notification: {
          request: {
            content: {
              data: { category: 'permission', requestId: 'perm-retry-btn' },
            },
          },
        },
      });

      await jest.advanceTimersByTimeAsync(20_000);
      await promise;

      // Initial 3 attempts failed
      expect(mockFetch).toHaveBeenCalledTimes(3);
      expect(mockMarkPromptAnsweredByRequestId).not.toHaveBeenCalled();

      // Now make fetch succeed for the retry button press
      mockFetch.mockResolvedValue({ ok: true, status: 200 });

      // Press the Retry button
      const buttons = mockAlert.mock.calls[0][2] as Array<{
        text: string;
        onPress?: () => void;
      }>;
      const retryButton = buttons.find((b) => b.text === 'Retry');
      expect(retryButton?.onPress).toBeDefined();
      retryButton!.onPress!();

      // Advance timers for the retry's internal delays
      await jest.advanceTimersByTimeAsync(20_000);
      // Flush microtasks
      await Promise.resolve();

      // Retry should have called fetch exactly one more time (total 4 calls)
      expect(mockFetch).toHaveBeenCalledTimes(4);
      expect(mockMarkPromptAnsweredByRequestId).toHaveBeenCalledWith(
        'perm-retry-btn',
        'allow',
      );
    } finally {
      jest.useRealTimers();
    }
  });
});
