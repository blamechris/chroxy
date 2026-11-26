/**
 * #9069 — when Stop discards queued follow-ups the app says so: ONE "Not sent"
 * system notice naming every discarded message. Real store, real `sendInterrupt`,
 * real message handler (the shared store-core dispatch).
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
import { _testMessageHandler } from '../../store/message-handler';
import { createMockConnectionContext } from '../../test-utils/mock-connection-context';
import { createEmptySessionState } from '../../store/utils';
import type { SessionState } from '../../store/types';

const OPEN = 1; // WebSocket.OPEN
const LONG = 'refactor the authentication module so that it no longer reads the environment directly';

function seed(queued: Array<{ id: string; text: string }>): void {
  useConnectionStore.setState({
    socket: { readyState: OPEN, send: jest.fn() },
    activeSessionId: 's1',
    sessionStates: {
      s1: {
        ...createEmptySessionState(),
        streamingMessageId: 'r1',
        messages: [
          { id: 'r1', type: 'response', content: 'working', timestamp: 1 },
          ...queued.map((q, i) => ({ id: q.id, type: 'user_input', content: q.text, timestamp: 2 + i })),
        ],
        queuedMessages: queued.map((q, i) => ({
          clientMessageId: q.id, text: q.text, queuedAt: 2 + i, status: 'confirmed',
        })),
      } as unknown as SessionState,
    },
  } as never);
}

const dequeue = (id: string | undefined, reason: string, queueLength = 0) =>
  _testMessageHandler.handle({ type: 'message_dequeued', sessionId: 's1', clientMessageId: id, queueLength, reason });

const state = () => useConnectionStore.getState().sessionStates.s1;
const notices = () => state().messages.filter((m) => m.id.startsWith('queue-discarded-'));

beforeEach(() => {
  _testMessageHandler.setContext(createMockConnectionContext());
});

afterEach(() => {
  _testMessageHandler.clearContext();
  useConnectionStore.setState({ socket: null, sessionStates: {}, activeSessionId: null } as never);
});

describe('Stop discarding queued follow-ups (#9069)', () => {
  it('this client pressed Stop: two interrupted dequeues give exactly one notice naming both', () => {
    seed([{ id: 'q1', text: LONG }, { id: 'q2', text: 'and then add\n  tests' }]);
    useConnectionStore.getState().sendInterrupt();
    expect(state().queuedMessages).toHaveLength(0);
    expect(notices()).toHaveLength(0); // nothing claimed until the server confirms

    dequeue('q1', 'interrupted', 1);
    dequeue('q2', 'interrupted', 0);

    const n = notices();
    expect(n).toHaveLength(1);
    expect(n[0].type).toBe('system');
    expect(n[0].content).toBe(
      'Not sent — Stop discarded 2 queued messages: “refactor the authentication module so that it no longer rea…”, “and then add tests”',
    );
    expect(n[0].content).not.toContain('\n');
    expect(state().interruptedQueued).toEqual([]);
  });

  it('another client pressed Stop: dequeues for entries still shown give one notice', () => {
    seed([{ id: 'q1', text: 'first' }, { id: 'q2', text: 'second' }]);
    dequeue('q1', 'interrupted', 1);
    dequeue('q2', 'interrupted', 0);
    const n = notices();
    expect(n).toHaveLength(1);
    expect(n[0].content).toBe('Not sent — Stop discarded 2 queued messages: “first”, “second”');
  });

  it('controls: cancelled and flush dequeues produce no notice', () => {
    seed([{ id: 'q1', text: 'a' }, { id: 'q2', text: 'b' }]);
    dequeue('q1', 'cancelled', 1);
    dequeue('q2', 'flush', 0);
    expect(notices()).toHaveLength(0);
  });

  it('control: Stop with an empty queue produces no notice', () => {
    seed([]);
    useConnectionStore.getState().sendInterrupt();
    expect(notices()).toHaveLength(0);
    expect(state().interruptedQueued ?? []).toEqual([]);
  });
});
