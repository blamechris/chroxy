/**
 * #8470 -- a question card that ends with no answer.
 *   - `permission_resolved { toolUseId, reason: 'superseded' }`: a newer question
 *     replaced this one, so it stops reading as waiting.
 *   - `error { code: 'QUESTION_NOT_DELIVERED', toolUseId }`: this client's answer
 *     reached nothing, so the card (marked answered on send) says so.
 */
import { Alert } from 'react-native';
import { questionEndedNotice } from '@chroxy/store-core';
import { _testMessageHandler, setStore } from '../../store/message-handler';
import { createMockConnectionContext } from '../../test-utils/mock-connection-context';
import { createEmptySessionState } from '../../store/utils';
import type { ConnectionState } from '../../store/types';
import { useNotificationStore } from '../../store/notifications';

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
    useNotificationStore.setState({ sessionNotifications: [], activityHistory: [] });
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

  it('restores pending worker questions across reconnect and removes only the cleared notice', () => {
    store.setState((state) => ({
      sessions: [...state.sessions, { sessionId: 'worker', name: 'Worker' } as ConnectionState['sessions'][number]],
      sessionStates: { ...state.sessionStates, worker: createEmptySessionState() },
    }));
    const dispatch = _testMessageHandler.handle;
    const pending = {
      type: 'user_question', sessionId: 'worker', toolUseId: 'ask-codex-1',
      questions: [{ question: 'Select a layout', options: [{ label: 'List' }], allowOther: false }],
    };
    const other = { ...pending, toolUseId: 'ask-codex-2' };
    const notices = () => store.getState().sessionNotifications;
    const mobileNotices = () => useNotificationStore.getState().sessionNotifications;
    const workerCards = () => store.getState().sessionStates.worker.messages;
    dispatch(pending);
    dispatch(pending);
    dispatch(other);
    expect(notices().map((n) => n.toolUseId)).toEqual([pending.toolUseId, other.toolUseId]);
    expect(mobileNotices()).toEqual(notices());
    expect(workerCards()[0].options).toEqual([{ label: 'List', value: 'List' }]);
    const originalNotices = notices();

    dispatch({ type: 'history_replay_start', sessionId: 'worker', fullHistory: true });
    dispatch({ ...pending, historySeq: 1 });
    dispatch({ ...other, historySeq: 2 });
    dispatch({ type: 'history_replay_end', sessionId: 'worker' });
    dispatch(pending);
    dispatch(other);
    expect(workerCards().map((m) => [m.toolUseId, m.answered])).toEqual([
      [pending.toolUseId, undefined], [other.toolUseId, undefined],
    ]);
    expect(notices()).toBe(originalNotices);
    expect(useNotificationStore.getState().activityHistory).toHaveLength(2);

    dispatch({ type: 'permission_request', requestId: pending.toolUseId, sessionId: 'worker', tool: 'Read' });
    const clear = {
      type: 'permission_resolved', toolUseId: pending.toolUseId, decision: 'deny',
      reason: 'resolved', resolvedBy: { kind: 'cleared' }, sessionId: 'worker',
    };
    dispatch({ ...clear, toolUseId: 'ask-codex-unknown' });
    dispatch({ ...clear, sessionId: 's1' });
    dispatch({ ...clear, requestId: pending.toolUseId });
    expect(notices()).toHaveLength(3);
    expect(workerCards().every((m) => m.answered === undefined)).toBe(true);
    dispatch(clear);
    expect(workerCards().map((m) => m.answered)).toEqual(['(no longer pending)', undefined, undefined]);
    expect(notices().map((n) => [n.eventType, n.toolUseId, n.requestId])).toEqual([
      ['question', other.toolUseId, undefined], ['permission', undefined, pending.toolUseId],
    ]);
    expect(mobileNotices()).toEqual(notices());
    expect(store.getState().activeSessionId).toBe('s1');
    expect(messages().map((m) => m.answered)).toEqual([undefined, undefined]);
    const clearedNotices = notices();
    dispatch(clear);
    dispatch(pending);
    expect(workerCards()[0].answered).toBe('(no longer pending)');
    expect(notices()).toBe(clearedNotices);

    dispatch({ type: 'permission_resolved', requestId: pending.toolUseId, decision: 'allow', sessionId: 'worker' });
    expect(workerCards()[2].answered).toBe('allow');
  });

  it('replaces the legacy notice in both mobile stores without touching native questions or permissions', () => {
    store.setState((state) => ({
      sessions: [...state.sessions, { sessionId: 'worker', name: 'Worker' } as ConnectionState['sessions'][number]],
      sessionStates: { ...state.sessionStates, worker: createEmptySessionState() },
    }));
    const dispatch = _testMessageHandler.handle;
    const notices = () => store.getState().sessionNotifications;
    const mobileNotices = () => useNotificationStore.getState().sessionNotifications;
    const legacy = (n: number) => dispatch({
      type: 'user_question', sessionId: 'worker', toolUseId: `ask-legacy-${n}`,
      questions: [{ question: `Legacy question ${n}?` }],
    });
    const toolUseId = 'ask-codex-current';
    legacy(1);
    dispatch({ type: 'permission_request', requestId: 'permission-1', sessionId: 'worker', tool: 'Read' });
    dispatch({ type: 'user_question', sessionId: 'worker', toolUseId, questions: [{ question: 'Native question?' }] });
    expect(notices().map((n) => n.message)).toEqual(['Legacy question 1?', 'Read', 'Native question?']);
    expect(mobileNotices()).toEqual(notices());
    legacy(2);
    legacy(3);
    expect(notices().map((n) => [n.message, n.toolUseId, n.requestId])).toEqual([
      ['Read', undefined, 'permission-1'],
      ['Native question?', toolUseId, undefined],
      ['Legacy question 3?', undefined, undefined],
    ]);
    expect(mobileNotices()).toEqual(notices());
    dispatch({ type: 'permission_resolved', toolUseId, sessionId: 'worker', decision: 'deny', reason: 'resolved' });
    expect(notices().map((n) => n.message)).toEqual(['Read', 'Legacy question 3?']);
    expect(mobileNotices()).toEqual(notices());
  });

  it('preserves a real answer with literal closure text through native live clear and history replay', () => {
    const answer = {
      answered: '(no longer pending)', answeredAt: 5, answeredAnswers: { 'First?': '(no longer pending)' },
    };
    const toolUseId = 'ask-codex-1';
    seed([card({ ...answer, toolUseId })]);
    const dispatch = _testMessageHandler.handle;
    dispatch({
      type: 'permission_resolved', toolUseId, decision: 'allow',
      reason: 'resolved', resolvedBy: { kind: 'user' }, sessionId: 's1',
    });
    expect(messages()[0]).toMatchObject(answer);
    dispatch({ type: 'history_replay_start', sessionId: 's1', fullHistory: true });
    dispatch({
      type: 'user_question', toolUseId, sessionId: 's1',
      questions: [{ question: 'First?' }], resolved: true, historySeq: 2,
    });
    dispatch({ type: 'history_replay_end', sessionId: 's1' });
    expect(messages()[0]).toMatchObject(answer);
    expect(questionEndedNotice(messages()[0].answered, messages()[0].answeredAt)).toBeNull();
  });

  it('removes a notice after missed worker clear history and skips fresh historical notices', () => {
    store.setState((state) => ({
      sessions: [...state.sessions, { sessionId: 'worker', name: 'Worker' } as ConnectionState['sessions'][number]],
      sessionStates: { ...state.sessionStates, worker: createEmptySessionState() },
    }));
    const dispatch = _testMessageHandler.handle;
    const pending = {
      type: 'user_question', sessionId: 'worker', toolUseId: 'ask-codex-1',
      questions: [{ question: 'Select a layout' }],
    };
    dispatch(pending);
    expect(store.getState().sessionNotifications).toHaveLength(1);
    expect(useNotificationStore.getState().sessionNotifications).toHaveLength(1);

    dispatch({ type: 'history_replay_start', sessionId: 'worker', fullHistory: false });
    dispatch({ ...pending, resolved: true, historySeq: 2 });
    dispatch({ ...pending, toolUseId: 'ask-codex-closed', resolved: true, historySeq: 3 });
    dispatch({ type: 'history_replay_end', sessionId: 'worker' });
    expect(store.getState().sessionStates.worker.messages.map((m) => m.answered)).toEqual([
      '(no longer pending)', '(no longer pending)',
    ]);
    expect(store.getState().sessionNotifications).toEqual([]);
    expect(useNotificationStore.getState().sessionNotifications).toEqual([]);
    expect(useNotificationStore.getState().activityHistory).toHaveLength(1);
  });

  it.each([false, true])('retires a notice after an empty full replay evicts its card (mirror only: %s)', (mirrorOnly) => {
    store.setState((state) => ({
      sessions: [...state.sessions, { sessionId: 'worker', name: 'Worker' } as ConnectionState['sessions'][number]],
      sessionStates: { ...state.sessionStates, worker: createEmptySessionState() },
    }));
    const dispatch = _testMessageHandler.handle;
    dispatch({
      type: 'user_question', sessionId: 'worker', toolUseId: 'ask-codex-evicted',
      questions: [{ question: 'Evicted question?' }],
    });
    if (mirrorOnly) store.setState({ sessionNotifications: [] });
    dispatch({ type: 'history_replay_start', sessionId: 'worker', fullHistory: true });
    dispatch({ type: 'history_replay_end', sessionId: 'worker', pendingQuestionToolUseIds: [] });
    expect(store.getState().sessionStates.worker.messages).toEqual([]);
    expect(store.getState().sessionNotifications).toEqual([]);
    expect(useNotificationStore.getState().sessionNotifications).toEqual([]);
    expect(useNotificationStore.getState().activityHistory).toHaveLength(1);
  });

  it('reconciles a nonempty pending snapshot for just the replayed session and clears both notice stores', () => {
    store.setState((state) => ({
      sessions: [
        ...state.sessions, { sessionId: 'worker', name: 'Worker' }, { sessionId: 'other', name: 'Other' },
      ] as ConnectionState['sessions'],
      sessionStates: { ...state.sessionStates, worker: createEmptySessionState(), other: createEmptySessionState() },
    }));
    const dispatch = _testMessageHandler.handle;
    const question = (toolUseId: string, sessionId = 'worker') => dispatch({
      type: 'user_question', sessionId, toolUseId, questions: [{ question: 'Input?' }],
    });
    question('ask-codex-stale');
    question('ask-codex-pending');
    question('ask-codex-answered');
    question('ask-codex-stale', 'other');
    question('ask-legacy');
    dispatch({ type: 'permission_request', sessionId: 'worker', requestId: 'perm-1', tool: 'Read' });
    const humanAnswer = { answered: '(no longer pending)', answeredAt: 0, answeredAnswers: { 'Input?': '(no longer pending)' } };
    store.setState((state) => ({
      sessionStates: {
        ...state.sessionStates,
        worker: {
          ...state.sessionStates.worker,
          messages: state.sessionStates.worker.messages.map((m) =>
            m.toolUseId === 'ask-codex-answered' ? { ...m, ...humanAnswer } : m),
        },
      },
    }));
    dispatch({ type: 'history_replay_start', sessionId: 'worker', fullHistory: false });
    question('ask-codex-live');
    dispatch({
      type: 'history_replay_end', sessionId: 'worker',
      pendingQuestionToolUseIds: ['ask-codex-pending', 'ask-codex-live'],
    });
    const state = store.getState();
    const cards = state.sessionStates.worker.messages;
    expect(cards.find((m) => m.toolUseId === 'ask-codex-stale')?.answered).toBe('(no longer pending)');
    expect(cards.find((m) => m.toolUseId === 'ask-codex-pending')?.answered).toBeUndefined();
    expect(cards.find((m) => m.toolUseId === 'ask-codex-live')?.answered).toBeUndefined();
    expect(cards.find((m) => m.toolUseId === 'ask-codex-answered')).toMatchObject(humanAnswer);
    expect(cards.find((m) => m.toolUseId === 'ask-legacy')?.answered).toBe('(resolved)');
    expect(cards.find((m) => m.requestId === 'perm-1')?.answered).toBeUndefined();
    expect(state.sessionStates.other.messages[0].answered).toBeUndefined();
    expect(state.sessionNotifications.map((n) => [n.sessionId, n.toolUseId, n.eventType])).toEqual([
      ['worker', 'ask-codex-pending', 'question'], ['other', 'ask-codex-stale', 'question'],
      ['worker', undefined, 'question'], ['worker', undefined, 'permission'], ['worker', 'ask-codex-live', 'question'],
    ]);
    expect(useNotificationStore.getState().sessionNotifications).toEqual(state.sessionNotifications);
  });

  it.each([undefined, null, {}, ['ask-codex-pending', 42], ['ask-legacy'], ['ask-codex-' + 'x'.repeat(257)]].map((value) => ({ value })))(
    'keeps native notices and cards when the pending snapshot is unknown or malformed ($value)',
    ({ value: pendingQuestionToolUseIds }) => {
      store.setState((state) => ({
        sessions: [...state.sessions, { sessionId: 'worker', name: 'Worker' } as ConnectionState['sessions'][number]],
        sessionStates: { ...state.sessionStates, worker: createEmptySessionState() },
      }));
      const dispatch = _testMessageHandler.handle;
      dispatch({
        type: 'user_question', sessionId: 'worker', toolUseId: 'ask-codex-unknown',
        questions: [{ question: 'Still waiting?' }],
      });
      dispatch({ type: 'history_replay_start', sessionId: 'worker', fullHistory: false });
      dispatch({ type: 'history_replay_end', sessionId: 'worker', pendingQuestionToolUseIds });
      expect(store.getState().sessionStates.worker.messages[0].answered).toBeUndefined();
      expect(store.getState().sessionNotifications).toHaveLength(1);
      expect(useNotificationStore.getState().sessionNotifications).toHaveLength(1);
    },
  );

  it.each([false, true])('carries an answer made on the visible prefix after a pending row replayed (close row: %s)', (closeRow) => {
    store.setState((state) => ({
      sessions: [{ sessionId: 'worker', name: 'Worker' }] as ConnectionState['sessions'],
      sessionStates: { ...state.sessionStates, worker: createEmptySessionState() },
    }));
    const dispatch = _testMessageHandler.handle;
    const pending = {
      type: 'user_question', sessionId: 'worker', toolUseId: 'ask-codex-interleaved',
      questions: [{ question: 'Select a layout' }],
    };
    dispatch(pending);
    const originalId = store.getState().sessionStates.worker.messages[0].id;
    dispatch({ type: 'history_replay_start', sessionId: 'worker', fullHistory: true });
    dispatch({ ...pending, historySeq: 1 });
    expect(store.getState().sessionStates.worker.messages).toHaveLength(2);
    const answer = { answered: '(no longer pending)', answeredAt: 0, answeredAnswers: { 'Select a layout': '(no longer pending)' } };
    store.setState((state) => ({ sessionStates: { ...state.sessionStates, worker: {
      ...state.sessionStates.worker,
      messages: state.sessionStates.worker.messages.map((m) => m.id === originalId ? { ...m, ...answer } : m),
    } } }));
    dispatch({ type: 'permission_resolved', sessionId: 'worker', toolUseId: pending.toolUseId, reason: 'resolved', decision: 'allow', resolvedBy: { kind: 'user' } });
    if (closeRow) dispatch({ ...pending, historySeq: 2, resolved: true });
    dispatch({ type: 'history_replay_end', sessionId: 'worker', pendingQuestionToolUseIds: [] });
    const kept = store.getState().sessionStates.worker.messages;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject(answer);
    expect(questionEndedNotice(kept[0].answered, kept[0].answeredAt)).toBeNull();
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
