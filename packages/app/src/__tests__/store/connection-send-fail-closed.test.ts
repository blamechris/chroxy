/**
 * #6308 — closing-socket TOCTOU: wsSend's false return must not be ignored.
 *
 * #6293 hardened wsSend to catch the InvalidStateError socket.send() throws when
 * the socket flips OPEN → CLOSING mid-send over a flaky tunnel, returning `false`
 * instead of throwing. sendInput was taught to check that (fall back to enqueue),
 * but four sibling call sites kept reporting success while mutating local state —
 * a "sent it and nothing happened" silent failure (the durability north star).
 *
 * These tests pin the fixed behaviour: when the send throws (modelled by a socket
 * whose readyState is OPEN but whose send() throws), each action must NOT report a
 * plain 'sent' and must NOT leave the UI asserting something the server never saw.
 */
jest.mock('expo-secure-store', () => ({
  getItemAsync: jest.fn(() => Promise.resolve(null)),
  setItemAsync: jest.fn(() => Promise.resolve()),
  deleteItemAsync: jest.fn(() => Promise.resolve()),
}));

jest.mock('../../utils/haptics', () => ({
  hapticLight: jest.fn(),
  hapticMedium: jest.fn(),
  hapticWarning: jest.fn(),
  hapticSuccess: jest.fn(),
}));

import { useConnectionStore } from '../../store/connection';
import type { SessionState } from '../../store/types';

interface FakeSocket {
  readyState: number;
  send: jest.Mock;
}

const OPEN = 1; // WebSocket.OPEN

/** A socket that passes the readyState===OPEN check but throws on send() —
 *  the exact TOCTOU #6293/#6308 guard against. The real wsSend catches the throw,
 *  warns, and returns false. */
function closingSocket(): FakeSocket {
  return {
    readyState: OPEN,
    send: jest.fn(() => {
      throw new Error('InvalidStateError: socket is closing');
    }),
  };
}

function liveSocket(): FakeSocket {
  return { readyState: OPEN, send: jest.fn() };
}

function seedSession(overrides: Partial<SessionState> = {}): void {
  const base = {
    messages: [],
    queuedMessages: [],
    streamingMessageId: null,
    claudeReady: true,
  } as unknown as SessionState;
  useConnectionStore.setState({
    activeSessionId: 'sess-1',
    sessions: [{ sessionId: 'sess-1', name: 'sess-1', provider: 'claude-sdk' }],
    sessionStates: { 'sess-1': { ...base, ...overrides } },
    sessionNotifications: [],
    socket: null,
  } as never);
}

function activeState(): SessionState {
  return useConnectionStore.getState().sessionStates['sess-1'];
}

describe('#6308 — sendCancelQueued does not lie on a closing socket', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('returns false and preserves the queued entry + bubble when the send throws', () => {
    const socket = closingSocket();
    seedSession({
      messages: [{ id: 'cmid-1', type: 'user_input', content: 'a', timestamp: 1 }],
      queuedMessages: [{ clientMessageId: 'cmid-1', text: 'a', queuedAt: 1, status: 'confirmed' }],
    } as unknown as Partial<SessionState>);
    useConnectionStore.setState({ socket } as never);

    const result = useConnectionStore.getState().sendCancelQueued('cmid-1');

    // The send was attempted, but reported failure rather than a phantom 'sent'.
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
    // Nothing was optimistically dropped — the server still holds the queued
    // message, so the bubble + entry must stay so the cancel is retryable and the
    // turn is not orphaned.
    expect(activeState().queuedMessages.map((m) => m.clientMessageId)).toEqual(['cmid-1']);
    expect(activeState().messages.map((m) => m.id)).toEqual(['cmid-1']);
  });

  it('still drops the entry on a healthy send (happy-path regression guard)', () => {
    const socket = liveSocket();
    seedSession({
      messages: [{ id: 'cmid-1', type: 'user_input', content: 'a', timestamp: 1 }],
      queuedMessages: [{ clientMessageId: 'cmid-1', text: 'a', queuedAt: 1, status: 'confirmed' }],
    } as unknown as Partial<SessionState>);
    useConnectionStore.setState({ socket } as never);

    expect(useConnectionStore.getState().sendCancelQueued('cmid-1')).toBe('sent');
    expect(activeState().queuedMessages).toHaveLength(0);
    expect(activeState().messages).toHaveLength(0);
  });
});

describe('#6308 — sendInterrupt does not report a phantom send on a closing socket', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('falls back to the offline queue (returns queued, not sent) when the send throws', () => {
    const socket = closingSocket();
    seedSession({
      streamingMessageId: 'live-1',
      messages: [{ id: 'live-1', type: 'response', content: '…', timestamp: 1 }],
    } as unknown as Partial<SessionState>);
    useConnectionStore.setState({ socket } as never);

    const result = useConnectionStore.getState().sendInterrupt();

    expect(socket.send).toHaveBeenCalledTimes(1);
    // The interrupt is queueable (5s TTL) — a failed live send routes to the
    // offline queue so it retries on reconnect, instead of the pre-fix 'sent' lie.
    expect(result).toBe('queued');
    expect(result).not.toBe('sent');
  });
});

describe('#6308 — sendPermissionResponse does not mark answered on a closing socket', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('returns false and leaves the prompt un-answered when the send throws', () => {
    const socket = closingSocket();
    seedSession({
      messages: [{ id: 'p1', type: 'prompt', requestId: 'req-1', tool: 'Read', timestamp: 1 }],
    } as unknown as Partial<SessionState>);
    useConnectionStore.setState({ socket } as never);

    const result = useConnectionStore.getState().sendPermissionResponse('req-1', 'allow');

    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
    // The prompt must stay actionable — marking it 'Allowed' while the server never
    // saw the frame (and auto-denies on timeout) is the #5699 silent-loss symptom.
    const prompt = activeState().messages.find((m) => m.requestId === 'req-1');
    expect(prompt?.answered).toBeUndefined();
  });

  it('marks the prompt answered on a healthy send (happy-path regression guard)', () => {
    const socket = liveSocket();
    seedSession({
      messages: [{ id: 'p1', type: 'prompt', requestId: 'req-1', tool: 'Read', timestamp: 1 }],
    } as unknown as Partial<SessionState>);
    useConnectionStore.setState({ socket } as never);

    expect(useConnectionStore.getState().sendPermissionResponse('req-1', 'allow')).toBe('sent');
    const prompt = activeState().messages.find((m) => m.requestId === 'req-1');
    expect(prompt?.answered).toBe('allow');
  });
});

describe('#6308 — sendUserQuestionResponse does not lie on a closing socket', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  it('returns false when the send throws (answer tied to a live request)', () => {
    const socket = closingSocket();
    seedSession();
    useConnectionStore.setState({ socket } as never);

    const result = useConnectionStore.getState().sendUserQuestionResponse('Option A', 'tool-1');

    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
  });

  it('returns sent on a healthy send (happy-path regression guard)', () => {
    const socket = liveSocket();
    seedSession();
    useConnectionStore.setState({ socket } as never);

    expect(useConnectionStore.getState().sendUserQuestionResponse('Option A', 'tool-1')).toBe('sent');
    expect(socket.send).toHaveBeenCalledTimes(1);
  });
});

describe('#6310 — notification-prefs setters do not lie on a closing socket', () => {
  let warn: jest.SpyInstance;
  beforeEach(() => { warn = jest.spyOn(console, 'warn').mockImplementation(() => {}); });
  afterEach(() => { warn.mockRestore(); });

  function seedPrefs(socket: FakeSocket): void {
    useConnectionStore.setState({
      socket,
      notificationPrefs: {
        categories: {},
        devices: { 'dev-1': { categories: {} } },
        quietHours: null,
        bypassCategories: [],
      },
    } as never);
  }
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const prefs = (): any => useConnectionStore.getState().notificationPrefs;

  it('setNotificationPrefsCategory: returns false + no optimistic flip when the send throws', () => {
    const socket = closingSocket();
    seedPrefs(socket);
    const result = useConnectionStore.getState().setNotificationPrefsCategory('push', false);
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
    expect(prefs().categories.push).toBeUndefined();
  });

  it('setNotificationPrefsCategory: applies the optimistic flip on a healthy send', () => {
    const socket = liveSocket();
    seedPrefs(socket);
    expect(useConnectionStore.getState().setNotificationPrefsCategory('push', false)).toBe(true);
    expect(prefs().categories.push).toBe(false);
  });

  it('setNotificationPrefsDevice: returns false + no optimistic patch when the send throws', () => {
    const socket = closingSocket();
    seedPrefs(socket);
    const result = useConnectionStore.getState().setNotificationPrefsDevice('dev-1', 'push', false);
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
    expect(prefs().devices['dev-1'].categories.push).toBeUndefined();
  });

  it('deleteNotificationPrefsDevice: returns false + keeps the row when the send throws', () => {
    const socket = closingSocket();
    seedPrefs(socket);
    const result = useConnectionStore.getState().deleteNotificationPrefsDevice('dev-1');
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
    expect(prefs().devices['dev-1']).toBeDefined();
  });

  it('deleteNotificationPrefsDevice: drops the row on a healthy send', () => {
    const socket = liveSocket();
    seedPrefs(socket);
    expect(useConnectionStore.getState().deleteNotificationPrefsDevice('dev-1')).toBe(true);
    expect(prefs().devices['dev-1']).toBeUndefined();
  });

  it('setNotificationPrefsQuietHours: returns false + no optimistic set when the send throws', () => {
    const socket = closingSocket();
    seedPrefs(socket);
    const result = useConnectionStore.getState().setNotificationPrefsQuietHours({ start: '22:00', end: '07:00', timezone: 'UTC' });
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
    expect(prefs().quietHours).toBeNull();
  });

  it('setNotificationPrefsBypassCategories: returns false + no optimistic set when the send throws', () => {
    const socket = closingSocket();
    seedPrefs(socket);
    const result = useConnectionStore.getState().setNotificationPrefsBypassCategories(['errors']);
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(result).toBe(false);
    expect(prefs().bypassCategories).toEqual([]);
  });

  it('setNotificationPrefsBypassCategories: applies the list on a healthy send', () => {
    const socket = liveSocket();
    seedPrefs(socket);
    expect(useConnectionStore.getState().setNotificationPrefsBypassCategories(['errors'])).toBe(true);
    expect(prefs().bypassCategories).toEqual(['errors']);
  });
});

describe('#6321 — permission-mode setters do not leave a phantom mode on a closing socket', () => {
  // These return void (unlike the notification-prefs family) and self-heal on a
  // server CAPABILITY_NOT_SUPPORTED *rejection* — but a failed send has no
  // round-trip, so no rejection arrives. The observable contract is that the
  // optimistic permissionMode flip + pending registration (both gated in the same
  // `if (!wsSend) return` block) do NOT happen when the send throws.
  it('setPermissionMode: no optimistic permissionMode flip when the send throws', () => {
    seedSession({ permissionMode: 'default' } as Partial<SessionState>);
    const socket = closingSocket();
    useConnectionStore.setState({ socket } as never);
    useConnectionStore.getState().setPermissionMode('plan');
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(activeState().permissionMode).toBe('default');
  });

  it('setPermissionMode: applies the optimistic flip on a healthy send', () => {
    seedSession({ permissionMode: 'default' } as Partial<SessionState>);
    const socket = liveSocket();
    useConnectionStore.setState({ socket } as never);
    useConnectionStore.getState().setPermissionMode('plan');
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(activeState().permissionMode).toBe('plan');
  });

  it('confirmPermissionMode: no optimistic flip but still clears the confirm dialog when the send throws', () => {
    seedSession({ permissionMode: 'default' } as Partial<SessionState>);
    const socket = closingSocket();
    useConnectionStore.setState({ socket, pendingPermissionConfirm: { mode: 'auto' } } as never);
    useConnectionStore.getState().confirmPermissionMode('auto');
    expect(socket.send).toHaveBeenCalledTimes(1);
    expect(activeState().permissionMode).toBe('default');
    // The dialog still closes — the user did confirm; only the optimistic flip is gated.
    expect(useConnectionStore.getState().pendingPermissionConfirm).toBeNull();
  });

  it('confirmPermissionMode: applies the flip + clears the dialog on a healthy send', () => {
    seedSession({ permissionMode: 'default' } as Partial<SessionState>);
    const socket = liveSocket();
    useConnectionStore.setState({ socket, pendingPermissionConfirm: { mode: 'auto' } } as never);
    useConnectionStore.getState().confirmPermissionMode('auto');
    expect(activeState().permissionMode).toBe('auto');
    expect(useConnectionStore.getState().pendingPermissionConfirm).toBeNull();
  });
});
