/**
 * #5633 — the offline queue must not drop user input/interrupts silently.
 *
 * Two failure modes are covered:
 *  1. Queue overflow: the 11th message (QUEUE_MAX_SIZE = 10) was dropped and
 *     enqueueMessage returned false with no user-visible signal.
 *  2. TTL expiry on drain: a queued `interrupt` (5s TTL) could expire while a
 *     longer reconnect backoff ran, evaporating without trace.
 *
 * Both now surface a `system` message into the transcript of the session the
 * dropped action belonged to (the queued payload's `sessionId`), falling back
 * to the active session via addMessage only when the payload carried none —
 * matching the existing "Message queued…" feedback. If the user switched
 * sessions while disconnected, the notice must follow the action's session, not
 * leak into whatever's active now.
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
// Test store — supports BOTH the active-session fallback (addMessage) and the
// session-targeted append path (updateSession → setState({ sessionStates })).
// `added` captures the active-session fallback; `sessionStates[sid].messages`
// captures notices routed to a specific session so we can assert which
// transcript a drop notice landed in.
// ---------------------------------------------------------------------------
function makeStore(opts?: { activeSessionId?: string | null; sessionIds?: string[] }) {
  const added: ChatMessage[] = [];
  const activeSessionId = opts?.activeSessionId === undefined ? 'sess-1' : opts.activeSessionId;
  const sessionIds = opts?.sessionIds ?? ['sess-1'];
  let state: any = {
    activeSessionId,
    sessionStates: Object.fromEntries(
      sessionIds.map((id) => [id, { messages: [] as ChatMessage[] }]),
    ),
    addMessage: (m: ChatMessage) => added.push(m),
  };
  const store = {
    getState: () => state,
    setState: (patch: any) => {
      state = { ...state, ...patch };
    },
  };
  return { store, added, sessionMessages: (id: string) => store.getState().sessionStates[id]?.messages ?? [] };
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

    // The 11th overflows: returns false AND surfaces a system message. No
    // sessionId on the payload → falls back to the active session (addMessage).
    expect(enqueueMessage('input', { type: 'input', data: 'm10' })).toBe(false);
    expect(added).toHaveLength(1);
    expect(added[0].type).toBe('system');
    expect(added[0].content).toMatch(/too many pending/i);
    expect(added[0].content).toMatch(/message/i);
  });

  it('routes an overflowed input notice to the payload session, not the active one (#5633)', () => {
    // The user was typing into sess-2 while disconnected, then switched to view
    // sess-1. The overflow notice must land in sess-2's transcript.
    const { store, added, sessionMessages } = makeStore({
      activeSessionId: 'sess-1',
      sessionIds: ['sess-1', 'sess-2'],
    });
    setStore(store as any);

    for (let i = 0; i < 10; i++) {
      enqueueMessage('input', { type: 'input', data: `m${i}`, sessionId: 'sess-2' });
    }
    expect(enqueueMessage('input', { type: 'input', data: 'm10', sessionId: 'sess-2' })).toBe(false);

    // Notice landed in sess-2 (the payload's session), NOT the active sess-1.
    const target = sessionMessages('sess-2');
    expect(target).toHaveLength(1);
    expect(target[0].type).toBe('system');
    expect(target[0].content).toMatch(/too many pending/i);
    // Negative control: nothing leaked into the active session's fallback path
    // or into sess-1's transcript.
    expect(added).toHaveLength(0);
    expect(sessionMessages('sess-1')).toHaveLength(0);
  });

  it('uses interrupt-specific copy on overflow, distinct from the message copy (#5633)', () => {
    const { store, sessionMessages } = makeStore({
      activeSessionId: 'sess-1',
      sessionIds: ['sess-1'],
    });
    setStore(store as any);

    // Fill the queue with interrupts targeting sess-1, then overflow with one.
    for (let i = 0; i < 10; i++) {
      enqueueMessage('interrupt', { type: 'interrupt', sessionId: 'sess-1' });
    }
    expect(enqueueMessage('interrupt', { type: 'interrupt', sessionId: 'sess-1' })).toBe(false);

    const notices = sessionMessages('sess-1');
    expect(notices).toHaveLength(1);
    expect(notices[0].content).toMatch(/interrupt/i);
    expect(notices[0].content).toMatch(/deliver/i);
    // The interrupt copy must NOT call the dropped action a "message".
    expect(notices[0].content).not.toMatch(/your message/i);
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

  it('routes a TTL-expired interrupt notice to the payload session, not the active one (#5633)', () => {
    jest.useFakeTimers();
    // Active session is sess-1, but the interrupt was fired against sess-2.
    const { store, added, sessionMessages } = makeStore({
      activeSessionId: 'sess-1',
      sessionIds: ['sess-1', 'sess-2'],
    });
    setStore(store as any);

    enqueueMessage('interrupt', { type: 'interrupt', sessionId: 'sess-2' });
    jest.advanceTimersByTime(6_000);
    const socket = { send: jest.fn(), readyState: 1 } as unknown as WebSocket;
    drainMessageQueue(socket);

    // Notice landed in sess-2, not the active sess-1.
    const target = sessionMessages('sess-2');
    expect(target).toHaveLength(1);
    expect(target[0].content).toMatch(/interrupt expired/i);
    // Negative control: active fallback + sess-1 untouched.
    expect(added).toHaveLength(0);
    expect(sessionMessages('sess-1')).toHaveLength(0);
  });

  it('uses distinct copy for an expired message vs an expired interrupt (#5633)', () => {
    jest.useFakeTimers();
    const { store, added } = makeStore();
    setStore(store as any);

    // An expired `input` (60s TTL) routes through the non-interrupt branch.
    enqueueMessage('input', { type: 'input', data: 'late' });
    jest.advanceTimersByTime(61_000);
    drainMessageQueue({ send: jest.fn(), readyState: 1 } as unknown as WebSocket);

    expect(added).toHaveLength(1);
    const messageCopy = added[0].content;
    expect(messageCopy).toMatch(/message expired/i);
    // The message branch must NOT use the interrupt wording.
    expect(messageCopy).not.toMatch(/interrupt/i);
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
