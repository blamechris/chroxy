/**
 * Regression tests for issue #3076:
 * Backgrounding/resuming the Android app wipes Claude's last response text.
 *
 * Root cause: the persistence subscriber in connection.ts only persisted
 * session messages when `messages.length` changed. Streaming `stream_delta`
 * events update the existing response message's `content` in place — the
 * messages array reference changes but its length does not. The new content
 * was therefore never written to AsyncStorage. After Android killed the
 * backgrounded process, the cold-start cache load surfaced the stream_start
 * stub (`content: ''`) for the most recent response, producing the visible
 * "Claude" header with an empty body.
 *
 * Fix: switch the persistence trigger from length comparison to reference
 * comparison. flushPendingDeltas always returns a new messages array when
 * content changes (`messages.map(...)`), so reference comparison catches
 * both new entries and in-place content updates. The persister is debounced
 * per session (500ms) so streaming many deltas still collapses into a
 * single AsyncStorage write.
 */
import { persistSessionMessages } from '../../store/persistence';
import { useConnectionStore } from '../../store/connection';
import { createEmptySessionState } from '../../store/utils';
import type { ChatMessage } from '../../store/types';

// Mock persistence so we can assert calls without touching AsyncStorage
jest.mock('../../store/persistence', () => ({
  persistSessionMessages: jest.fn(),
  persistViewMode: jest.fn(),
  persistActiveSession: jest.fn(() => Promise.resolve()),
  persistTerminalBuffer: jest.fn(),
  persistSessionList: jest.fn(),
  persistLastConversationId: jest.fn(() => Promise.resolve()),
  loadLastConversationId: jest.fn(() => Promise.resolve(null)),
  loadPersistedState: jest.fn(() => Promise.resolve({ viewMode: null, activeSessionId: null, terminalBuffer: null })),
  loadSessionMessages: jest.fn(() => Promise.resolve([])),
  loadSessionList: jest.fn(() => Promise.resolve([])),
  loadAllSessionMessages: jest.fn(() => Promise.resolve({})),
  clearPersistedState: jest.fn(() => Promise.resolve()),
  clearPersistedSession: jest.fn(() => Promise.resolve()),
  _resetForTesting: jest.fn(),
}));

const mockedPersist = persistSessionMessages as jest.MockedFunction<typeof persistSessionMessages>;

const SESSION_ID = 's1';

function setupStoreWithSession(initialMessages: ChatMessage[]): void {
  // Establish a baseline state so the subscriber's per-session cache is
  // populated. The subscriber only triggers persistence when the messages
  // array reference changes, so this seeds it with a known reference.
  useConnectionStore.setState({
    activeSessionId: SESSION_ID,
    sessions: [{ sessionId: SESSION_ID, name: 'S1' } as never],
    sessionStates: {
      [SESSION_ID]: { ...createEmptySessionState(), messages: initialMessages },
    },
  });
}

beforeEach(() => {
  mockedPersist.mockClear();
});

describe('persistence subscriber — issue #3076', () => {
  // Streaming a response in place must persist the updated content even
  // though messages.length doesn't change. Without the fix, the response
  // body never reached AsyncStorage and a cold-restart showed an empty bubble.
  it('persists when messages array reference changes without length change', () => {
    const userMsg: ChatMessage = {
      id: 'u-1',
      type: 'user_input',
      content: 'hello',
      timestamp: 1,
    };
    const responseMsg: ChatMessage = {
      id: 'r-1',
      type: 'response',
      content: '', // stream_start stub — what the bug persisted
      timestamp: 2,
    };
    setupStoreWithSession([userMsg, responseMsg]);
    mockedPersist.mockClear();

    // Simulate a stream_delta flush: same length, new array, updated content
    const updatedResponse: ChatMessage = { ...responseMsg, content: 'Hello world' };
    useConnectionStore.setState({
      sessionStates: {
        [SESSION_ID]: {
          ...useConnectionStore.getState().sessionStates[SESSION_ID],
          messages: [userMsg, updatedResponse],
        },
      },
    });

    expect(mockedPersist).toHaveBeenCalled();
    // Last call carries the latest content
    const calls = mockedPersist.mock.calls;
    const lastCall = calls[calls.length - 1];
    expect(lastCall[0]).toBe(SESSION_ID);
    const persistedMessages = lastCall[1];
    const persistedResponse = persistedMessages.find((m) => m.id === 'r-1');
    expect(persistedResponse?.content).toBe('Hello world');
  });

  it('persists on append (length change) — regression for the existing pre-fix behavior', () => {
    setupStoreWithSession([]);
    mockedPersist.mockClear();

    const newMsg: ChatMessage = {
      id: 'u-1',
      type: 'user_input',
      content: 'hello',
      timestamp: 1,
    };
    useConnectionStore.setState({
      sessionStates: {
        [SESSION_ID]: {
          ...useConnectionStore.getState().sessionStates[SESSION_ID],
          messages: [newMsg],
        },
      },
    });

    expect(mockedPersist).toHaveBeenCalled();
    const lastCall = mockedPersist.mock.calls[mockedPersist.mock.calls.length - 1];
    expect(lastCall[1]).toHaveLength(1);
  });

  it('does not re-persist when the messages reference is unchanged (no spurious writes)', () => {
    const userMsg: ChatMessage = {
      id: 'u-1',
      type: 'user_input',
      content: 'hello',
      timestamp: 1,
    };
    setupStoreWithSession([userMsg]);
    mockedPersist.mockClear();

    // Update a non-messages field — should not trigger persistence for messages
    useConnectionStore.setState({
      sessionStates: {
        [SESSION_ID]: {
          ...useConnectionStore.getState().sessionStates[SESSION_ID],
          // same messages reference
        },
      },
    });

    expect(mockedPersist).not.toHaveBeenCalled();
  });

  it('persists the most recent content for a multi-delta stream (final write reflects full body)', () => {
    const responseMsg: ChatMessage = {
      id: 'r-1',
      type: 'response',
      content: '',
      timestamp: 2,
    };
    setupStoreWithSession([responseMsg]);
    mockedPersist.mockClear();

    // Three delta-like updates: same length, growing content, new array each time
    const chunks = ['Hello', ' world', '!'];
    let acc = '';
    for (const chunk of chunks) {
      acc += chunk;
      const updated: ChatMessage = { ...responseMsg, content: acc };
      useConnectionStore.setState({
        sessionStates: {
          [SESSION_ID]: {
            ...useConnectionStore.getState().sessionStates[SESSION_ID],
            messages: [updated],
          },
        },
      });
    }

    expect(mockedPersist).toHaveBeenCalled();
    const lastCall = mockedPersist.mock.calls[mockedPersist.mock.calls.length - 1];
    expect(lastCall[1][0].content).toBe('Hello world!');
  });
});
