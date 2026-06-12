/**
 * #5633 — the offline queue must not drop user input/interrupts silently.
 *
 * Two failure modes are covered:
 *  1. Queue overflow: the 11th message (QUEUE_MAX_SIZE = 10) was dropped and
 *     enqueueMessage returned false with no user-visible signal.
 *  2. TTL expiry on drain: a queued `interrupt` (5s TTL) could expire while a
 *     longer reconnect backoff ran, evaporating without trace.
 *
 * Both now surface a `system` message into the active session's transcript via
 * the store's addMessage — matching the existing "Message queued…" feedback.
 */

// ---------------------------------------------------------------------------
// Mocks — native modules pulled in transitively by message-handler.ts
// ---------------------------------------------------------------------------
jest.mock('../src/utils/crypto', () => ({
  createKeyPair: jest.fn(),
  deriveSharedKey: jest.fn(),
  encrypt: jest.fn(),
  decrypt: jest.fn(),
  generateConnectionSalt: jest.fn(() => 'mock-salt'),
  deriveConnectionKey: jest.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0,
  DIRECTION_SERVER: 1,
}));

jest.mock('../src/notifications', () => ({
  registerForPushNotifications: jest.fn(),
}));

jest.mock('../src/utils/haptics', () => ({
  hapticSuccess: jest.fn(),
}));

jest.mock('../src/store/persistence', () => ({
  clearPersistedSession: jest.fn(),
}));

jest.mock('../src/store/imperative-callbacks', () => ({
  getCallback: jest.fn(() => undefined),
}));

jest.mock('../src/store/multi-client', () => ({
  useMultiClientStore: { getState: jest.fn(() => ({ setClients: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/web', () => ({
  useWebStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('../src/store/cost', () => ({
  useCostStore: { getState: jest.fn(() => ({ handleCostUpdate: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/terminal', () => ({
  useTerminalStore: { getState: jest.fn(() => ({ appendTerminalData: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/notifications', () => ({
  useNotificationStore: { getState: jest.fn(() => ({ addNotification: jest.fn(), dismissNotification: jest.fn() })), setState: jest.fn() },
}));

jest.mock('../src/store/conversations', () => ({
  useConversationStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('../src/store/connection-lifecycle', () => ({
  useConnectionLifecycleStore: { getState: jest.fn(() => ({})), setState: jest.fn() },
}));

jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

// ---------------------------------------------------------------------------
// Imports
// ---------------------------------------------------------------------------
import {
  setStore,
  enqueueMessage,
  drainMessageQueue,
  clearMessageQueue,
} from '../src/store/message-handler';
import type { ChatMessage } from '../src/store/types';

// ---------------------------------------------------------------------------
// Test store — only needs addMessage + an active session so notifyQueueFailure
// can land a system message we can assert on.
// ---------------------------------------------------------------------------
function makeStore() {
  const added: ChatMessage[] = [];
  const store = {
    getState: () => ({
      activeSessionId: 'sess-1',
      addMessage: (m: ChatMessage) => added.push(m),
    }),
    setState: () => {},
  };
  return { store, added };
}

describe('offline queue silent-drop surfacing (#5633)', () => {
  afterEach(() => {
    clearMessageQueue();
    jest.useRealTimers();
  });

  it('surfaces a system message when the queue overflows past QUEUE_MAX_SIZE', () => {
    const { store, added } = makeStore();
    setStore(store as any);

    // First 10 enqueue cleanly.
    for (let i = 0; i < 10; i++) {
      expect(enqueueMessage('input', { type: 'input', data: `m${i}` })).toBe('queued');
    }
    expect(added).toHaveLength(0);

    // The 11th overflows: returns false AND surfaces a system message.
    expect(enqueueMessage('input', { type: 'input', data: 'm10' })).toBe(false);
    expect(added).toHaveLength(1);
    expect(added[0].type).toBe('system');
    expect(added[0].content).toMatch(/too many pending/i);
  });

  it('does NOT surface anything for non-queueable (excluded / no-TTL) types', () => {
    const { store, added } = makeStore();
    setStore(store as any);

    // Excluded type.
    expect(enqueueMessage('resize', { type: 'resize' })).toBe(false);
    // No TTL configured.
    expect(enqueueMessage('totally_unknown', {})).toBe(false);
    expect(added).toHaveLength(0);
  });

  it('surfaces a dropped interrupt when its TTL expires before drain', () => {
    jest.useFakeTimers();
    const { store, added } = makeStore();
    setStore(store as any);

    expect(enqueueMessage('interrupt', { type: 'interrupt' })).toBe('queued');
    expect(added).toHaveLength(0);

    // Advance past the interrupt's 5s TTL, then drain.
    jest.advanceTimersByTime(6_000);
    const socket = { send: jest.fn(), readyState: 1 } as unknown as WebSocket;
    drainMessageQueue(socket);

    expect(added).toHaveLength(1);
    expect(added[0].type).toBe('system');
    expect(added[0].content).toMatch(/interrupt expired/i);
    // The dead interrupt must NOT have been sent.
    expect((socket as any).send).not.toHaveBeenCalled();
  });

  it('drains still-valid messages without spurious drop notices', () => {
    jest.useFakeTimers();
    const { store, added } = makeStore();
    setStore(store as any);

    enqueueMessage('input', { type: 'input', data: 'hi' });
    const wsSent: unknown[] = [];
    const socket = {
      send: (raw: string) => wsSent.push(raw),
      readyState: 1,
    } as unknown as WebSocket;

    drainMessageQueue(socket);

    // No drop notice; the message went out.
    expect(added).toHaveLength(0);
    expect(wsSent).toHaveLength(1);
  });
});
