import * as Notifications from 'expo-notifications';

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
});
