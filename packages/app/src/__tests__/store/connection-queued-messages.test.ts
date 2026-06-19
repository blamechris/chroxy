/**
 * #5938 (epic #5935 slice ③) — send-while-streaming queue, store layer.
 *
 * Covers the two store actions the mobile queued-message UI relies on:
 *   1. `addUserMessage(..., { queued: true })` — a mid-turn send must append the
 *      user bubble + seed an optimistic `'pending'` queue entry WITHOUT
 *      re-arming the live turn's thinking indicator / streamingMessageId (that
 *      would stomp the in-flight turn). The non-queued path still arms as before.
 *   2. `sendCancelQueued(clientMessageId)` — sends a `cancel_queued` wire frame
 *      and optimistically drops the local entry when connected; refuses (returns
 *      false, no mutation) while disconnected.
 *
 * Reconciliation against the server's message_queued/message_dequeued is owned
 * by the shared store-core dispatch table (tested in store-core); these tests
 * pin the app-store send/cancel path that feeds it.
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

function seedSession(overrides: Partial<SessionState> = {}): void {
  const base = {
    messages: [],
    queuedMessages: [],
    streamingMessageId: null,
    claudeReady: true,
  } as unknown as SessionState;
  useConnectionStore.setState({
    activeSessionId: 'sess-1',
    sessionStates: { 'sess-1': { ...base, ...overrides } },
    socket: null,
  } as never);
}

function activeState(): SessionState {
  return useConnectionStore.getState().sessionStates['sess-1'];
}

describe('#5938 — addUserMessage queued path', () => {
  it('seeds an optimistic pending entry and does NOT re-arm the live turn', () => {
    // A turn is already streaming (id 'live-1') with its own thinking bubble.
    seedSession({
      streamingMessageId: 'live-1',
      messages: [{ id: 'live-1', type: 'thinking', content: '', timestamp: 1 }],
    } as unknown as Partial<SessionState>);

    useConnectionStore.getState().addUserMessage('queued follow-up', undefined, {
      clientMessageId: 'cmid-1',
      queued: true,
    });

    const s = activeState();
    // The user bubble is appended.
    const userMsg = s.messages.find((m) => m.id === 'cmid-1');
    expect(userMsg).toBeTruthy();
    expect(userMsg?.type).toBe('user_input');
    expect(userMsg?.content).toBe('queued follow-up');
    // The live turn is untouched — no fresh thinking arm, stream id preserved.
    expect(s.streamingMessageId).toBe('live-1');
    expect(s.messages.filter((m) => m.type === 'thinking')).toHaveLength(1);
    // An optimistic pending queue entry exists, keyed by the clientMessageId.
    expect(s.queuedMessages).toHaveLength(1);
    expect(s.queuedMessages[0]).toMatchObject({
      clientMessageId: 'cmid-1',
      text: 'queued follow-up',
      status: 'pending',
    });
  });

  it('dedupes a repeat queued send by clientMessageId', () => {
    seedSession({ streamingMessageId: 'live-1' } as unknown as Partial<SessionState>);
    const add = useConnectionStore.getState().addUserMessage;
    add('dup', undefined, { clientMessageId: 'cmid-dup', queued: true });
    add('dup', undefined, { clientMessageId: 'cmid-dup', queued: true });
    expect(activeState().queuedMessages).toHaveLength(1);
  });

  it('the non-queued path still arms the thinking indicator (regression guard)', () => {
    seedSession();
    useConnectionStore.getState().addUserMessage('fresh turn', undefined, {
      clientMessageId: 'cmid-2',
    });
    const s = activeState();
    expect(s.streamingMessageId).toBe('pending');
    expect(s.messages.some((m) => m.type === 'thinking')).toBe(true);
    // No queue entry on a normal (idle) send.
    expect(s.queuedMessages).toHaveLength(0);
  });
});

describe('#5938 — sendCancelQueued', () => {
  it('sends a cancel_queued frame and optimistically drops the entry when connected', () => {
    const socket: FakeSocket = { readyState: OPEN, send: jest.fn() };
    seedSession({
      queuedMessages: [
        { clientMessageId: 'cmid-1', text: 'a', queuedAt: 1, status: 'confirmed' },
        { clientMessageId: 'cmid-2', text: 'b', queuedAt: 2, status: 'pending' },
      ],
    } as unknown as Partial<SessionState>);
    useConnectionStore.setState({ socket } as never);

    const result = useConnectionStore.getState().sendCancelQueued('cmid-1');
    expect(result).toBe('sent');
    expect(socket.send).toHaveBeenCalledTimes(1);
    const sent = JSON.parse(socket.send.mock.calls[0][0]);
    expect(sent).toMatchObject({ type: 'cancel_queued', clientMessageId: 'cmid-1', sessionId: 'sess-1' });
    // Only the cancelled entry is dropped.
    const ids = activeState().queuedMessages.map((m) => m.clientMessageId);
    expect(ids).toEqual(['cmid-2']);
  });

  it('refuses (returns false, no mutation) while disconnected', () => {
    seedSession({
      queuedMessages: [{ clientMessageId: 'cmid-1', text: 'a', queuedAt: 1, status: 'confirmed' }],
    } as unknown as Partial<SessionState>);
    useConnectionStore.setState({ socket: null } as never);

    const result = useConnectionStore.getState().sendCancelQueued('cmid-1');
    expect(result).toBe(false);
    // The entry is preserved — the queue stays actionable on reconnect.
    expect(activeState().queuedMessages).toHaveLength(1);
  });
});
