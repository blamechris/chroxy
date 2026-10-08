/**
 * #8470 -- a question card that ends with no answer.
 *   - `permission_resolved { toolUseId, reason: 'superseded' }`: a newer question
 *     replaced this one, so it stops reading as waiting.
 *   - `error { code: 'QUESTION_NOT_DELIVERED', toolUseId }`: this client's answer
 *     reached nothing, so the card (marked answered on send) says so.
 */
import { Alert } from 'react-native';
import { _testMessageHandler, setStore } from '../../store/message-handler';
import { createMockConnectionContext } from '../../test-utils/mock-connection-context';
import { createEmptySessionState } from '../../store/utils';
import type { ConnectionState } from '../../store/types';

jest.mock('../../store/persistence', () => ({
  clearPersistedSession: jest.fn(() => Promise.resolve()),
  persistSessionMessages: jest.fn(),
  persistViewMode: jest.fn(),
  persistActiveSession: jest.fn(),
  persistTerminalBuffer: jest.fn(),
  loadPersistedState: jest.fn(),
  loadSessionMessages: jest.fn(),
  clearPersistedState: jest.fn(),
  _resetForTesting: jest.fn(),
}));

const alertSpy = jest.spyOn(Alert, 'alert').mockImplementation(() => {});

function createMockStore(initialState: Partial<ConnectionState>) {
  let state = initialState as ConnectionState;
  return {
    getState: () => state,
    setState: (updater: Partial<ConnectionState> | ((s: ConnectionState) => Partial<ConnectionState>)) => {
      state = { ...state, ...(typeof updater === 'function' ? updater(state) : updater) };
    },
    subscribe: () => () => {},
    destroy: () => {},
  };
}

const card = (over: Record<string, unknown> = {}) => ({
  id: 'q1', type: 'prompt', content: 'First?', toolUseId: 'ask-1', timestamp: 1, ...over,
});

describe('question cards that end with no answer (#8470)', () => {
  let store: ReturnType<typeof createMockStore>;
  const messages = () => (store.getState().sessionStates.s1.messages as any[]);
  const seed = (msgs: any[]) => {
    store = createMockStore({
      activeSessionId: 's1',
      sessions: [{ sessionId: 's1', name: 'S1' } as any],
      sessionStates: { s1: { ...createEmptySessionState(), messages: msgs } },
      sessionNotifications: [],
    });
    setStore(store as any);
    _testMessageHandler.setContext(createMockConnectionContext());
  };

  beforeEach(() => {
    alertSpy.mockClear();
    seed([card(), card({ id: 'q2', toolUseId: 'ask-2', content: 'Second?' })]);
  });

  it('a superseded question stops reading as waiting; the question that replaced it is untouched', () => {
    _testMessageHandler.handle({ type: 'permission_resolved', toolUseId: 'ask-1', decision: 'deny', reason: 'superseded', sessionId: 's1' });
    expect(messages()[0].answered).toBe('(superseded)');
    expect(messages()[1].answered).toBeUndefined();
  });

  it('a superseded frame never overwrites an answer the person gave', () => {
    seed([card({ answered: 'A1' })]);
    _testMessageHandler.handle({ type: 'permission_resolved', toolUseId: 'ask-1', decision: 'deny', reason: 'superseded' });
    expect(messages()[0].answered).toBe('A1');
  });

  it('QUESTION_NOT_DELIVERED retracts the answer the card was marked with on send, without an alert', () => {
    seed([card({ answered: 'A1', answeredAt: 5, answeredAnswers: { 'First?': 'A1' } })]);
    _testMessageHandler.handle({ type: 'error', requestId: null, code: 'QUESTION_NOT_DELIVERED', message: 'Your answer was not delivered', toolUseId: 'ask-1', sessionId: 's1', fatal: false });
    const m = messages()[0];
    expect(m.answered).toBe('(not delivered)');
    expect(m.answeredAt).toBeUndefined();
    expect('answeredAnswers' in m).toBe(false);
    expect(alertSpy).not.toHaveBeenCalled();
  });

  it('falls back to the alert when no card holds that question', () => {
    _testMessageHandler.handle({ type: 'error', code: 'QUESTION_NOT_DELIVERED', message: 'Your answer was not delivered', toolUseId: 'ask-unknown' });
    expect(messages()[0].answered).toBeUndefined();
    expect(alertSpy).toHaveBeenCalled();
    expect(JSON.stringify(alertSpy.mock.calls)).toContain('Your answer was not delivered');
  });
});
