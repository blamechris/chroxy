/**
 * #8470 -- a question card that ends with no answer.
 *
 * Two server signals, one card state each:
 *   - `permission_resolved { toolUseId, reason: 'superseded' }`: a newer question
 *     replaced this one, so it stops reading as waiting.
 *   - `error { code: 'QUESTION_NOT_DELIVERED', toolUseId }`: this client's answer
 *     reached nothing, so the card (marked answered on send) says so.
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'
import { questionEndedNotice } from '@chroxy/store-core'
import { setStore, handleMessage, setConnectionContext } from './message-handler'
import type { ConnectionState } from './types'
import { createEmptySessionState } from './utils'

function createMockStore(initialState: Partial<ConnectionState>) {
  let state = initialState as ConnectionState
  return {
    getState: () => state,
    setState: (
      updater:
        | Partial<ConnectionState>
        | ((s: ConnectionState) => Partial<ConnectionState>),
    ) => {
      state = { ...state, ...(typeof updater === 'function' ? updater(state) : updater) }
    },
  }
}

const mockCtx = {
  url: 'wss://test',
  token: 'test-token',
  isReconnect: false,
  silent: false,
  socket: {} as WebSocket,
}

const card = (over: Record<string, unknown> = {}) => ({
  id: 'q1',
  type: 'prompt',
  content: 'First?',
  toolUseId: 'ask-1',
  timestamp: 1,
  ...over,
})

describe('question cards that end with no answer (#8470)', () => {
  let store: ReturnType<typeof createMockStore>
  const sessionMessages = () =>
    (store.getState().sessionStates['sess-1'] as unknown as { messages: Array<Record<string, unknown>> }).messages as [
      Record<string, unknown>,
      Record<string, unknown>,
    ]

  beforeEach(() => {
    store = createMockStore({
      activeSessionId: 'sess-1',
      messages: [],
      addServerError: vi.fn(),
      sessionNotifications: [],
      sessionStates: {
        'sess-1': { messages: [card(), card({ id: 'q2', toolUseId: 'ask-2', content: 'Second?' })] },
      } as unknown as ConnectionState['sessionStates'],
    })
    setStore(store as never)
    setConnectionContext(mockCtx as never)
  })

  it('a superseded question stops reading as waiting; the question that replaced it is untouched', () => {
    handleMessage({ type: 'permission_resolved', toolUseId: 'ask-1', decision: 'deny', reason: 'superseded', sessionId: 'sess-1' })
    expect(sessionMessages()[0].answered).toBe('(superseded)')
    expect(sessionMessages()[1].answered).toBeUndefined()
  })

  it('a superseded frame never overwrites an answer the person gave', () => {
    store.setState({ sessionStates: { 'sess-1': { messages: [card({ answered: 'A1' })] } } as unknown as ConnectionState['sessionStates'] })
    handleMessage({ type: 'permission_resolved', toolUseId: 'ask-1', decision: 'deny', reason: 'superseded' })
    expect(sessionMessages()[0].answered).toBe('A1')
  })

  it('any other question resolution reason changes no card (they emit no frame today)', () => {
    handleMessage({ type: 'permission_resolved', toolUseId: 'ask-1', decision: 'deny', reason: 'timeout' })
    expect(sessionMessages()[0].answered).toBeUndefined()
  })

  it('keeps one notice per pending worker question across reconnect, then clears the exact question', () => {
    store.setState((state) => ({
      sessions: [{ sessionId: 'sess-1', name: 'Parent' }, { sessionId: 'worker', name: 'Worker' }] as ConnectionState['sessions'],
      sessionStates: { ...state.sessionStates, worker: createEmptySessionState() },
    }))
    const pending = {
      type: 'user_question', sessionId: 'worker', toolUseId: 'ask-codex-1',
      questions: [{ question: 'Select a layout', options: [{ label: 'List', description: 'Show one row per item' }], allowOther: false }],
    }
    const other = { ...pending, toolUseId: 'ask-codex-2' }
    const clear = {
      type: 'permission_resolved', toolUseId: pending.toolUseId, decision: 'deny',
      reason: 'resolved', resolvedBy: { kind: 'cleared' }, sessionId: 'worker',
    }
    const notices = () => store.getState().sessionNotifications
    const workerCards = () => store.getState().sessionStates.worker!.messages
    handleMessage(pending)
    handleMessage(pending)
    handleMessage(other)
    expect(notices().map((notice) => notice.toolUseId)).toEqual([pending.toolUseId, other.toolUseId])
    const originalNotices = notices()
    expect(workerCards()[0]?.options).toEqual([{ label: 'List — Show one row per item', value: 'List' }])

    handleMessage({ type: 'history_replay_start', sessionId: 'worker', fullHistory: true })
    handleMessage({ ...pending, historySeq: 1 })
    handleMessage({ ...other, historySeq: 2 })
    handleMessage({ type: 'history_replay_end', sessionId: 'worker' })
    handleMessage(pending)
    handleMessage(other)
    expect(workerCards().map((m) => [m.toolUseId, m.answered])).toEqual([
      [pending.toolUseId, undefined], [other.toolUseId, undefined],
    ])
    expect(notices()).toBe(originalNotices)

    handleMessage({ type: 'permission_request', requestId: pending.toolUseId, sessionId: 'worker', tool: 'Read' })
    handleMessage({ ...clear, toolUseId: 'ask-codex-unknown' })
    handleMessage({ ...clear, sessionId: 'sess-1' })
    handleMessage({ ...clear, requestId: pending.toolUseId })
    expect(workerCards().every((m) => m.answered === undefined)).toBe(true)
    expect(notices().every((n) => n.readAt === undefined)).toBe(true)

    handleMessage(clear)
    expect(workerCards().map((m) => m.answered)).toEqual(['(no longer pending)', undefined, undefined])
    expect(sessionMessages().map((m) => m.answered)).toEqual([undefined, undefined])
    expect(store.getState().activeSessionId).toBe('sess-1')
    expect(notices()[0]?.readAt).toEqual(expect.any(Number))
    expect(notices().slice(1).map((n) => [n.eventType, n.readAt])).toEqual([
      ['question', undefined], ['permission', undefined],
    ])
    const clearedNotices = notices()
    handleMessage(clear)
    handleMessage(pending)
    expect(workerCards()[0]?.answered).toBe('(no longer pending)')
    expect(notices()).toBe(clearedNotices)

    handleMessage({ type: 'permission_resolved', requestId: pending.toolUseId, decision: 'allow', sessionId: 'worker' })
    expect(workerCards()[2]?.answered).toBe('allow')
  })

  it('replaces the legacy notice while retaining an independent native question and permission', () => {
    store.setState((state) => ({
      sessions: [{ sessionId: 'worker', name: 'Worker' }] as ConnectionState['sessions'],
      sessionStates: { ...state.sessionStates, worker: createEmptySessionState() },
    }))
    const notices = () => store.getState().sessionNotifications
    const legacy = (n: number) => handleMessage({
      type: 'user_question', sessionId: 'worker', toolUseId: `ask-legacy-${n}`,
      questions: [{ question: `Legacy question ${n}?` }],
    })
    const toolUseId = 'ask-codex-current'
    legacy(1)
    handleMessage({ type: 'permission_request', requestId: 'permission-1', sessionId: 'worker', tool: 'Read' })
    handleMessage({ type: 'user_question', sessionId: 'worker', toolUseId, questions: [{ question: 'Native question?' }] })
    expect(notices().map((n) => n.message)).toEqual(['Legacy question 1?', 'Read', 'Native question?'])
    legacy(2)
    legacy(3)
    expect(notices().map((n) => [n.message, n.toolUseId, n.requestId])).toEqual([
      ['Read', undefined, 'permission-1'],
      ['Native question?', toolUseId, undefined],
      ['Legacy question 3?', undefined, undefined],
    ])
    handleMessage({ type: 'permission_resolved', toolUseId, sessionId: 'worker', decision: 'deny', reason: 'resolved' })
    expect(notices().filter((n) => n.readAt === undefined).map((n) => n.message)).toEqual(['Read', 'Legacy question 3?'])
  })

  it('uses history to retire a missed worker clear and preserves a human answer with literal closure text', () => {
    store.setState((state) => ({
      sessions: [{ sessionId: 'worker', name: 'Worker' }] as ConnectionState['sessions'],
      sessionStates: { ...state.sessionStates, worker: createEmptySessionState() },
    }))
    const pending = {
      type: 'user_question', sessionId: 'worker', toolUseId: 'ask-codex-1',
      questions: [{ question: 'Select a layout' }],
    }
    handleMessage(pending)
    const notice = store.getState().sessionNotifications[0]!
    const worker = () => store.getState().sessionStates.worker!
    const humanAnswer = {
      answered: '(no longer pending)',
      answeredAnswers: { 'Select a layout': '(no longer pending)' },
      answeredAt: 123,
    }
    store.setState((state) => ({
      sessionStates: {
        ...state.sessionStates, worker: { ...worker(), messages: [{ ...worker().messages[0]!, ...humanAnswer }] },
      },
    }))
    handleMessage({ type: 'history_replay_start', sessionId: 'worker', fullHistory: true })
    handleMessage({ ...pending, resolved: true, historySeq: 2 })
    handleMessage({ type: 'history_replay_end', sessionId: 'worker' })
    const answered = worker().messages[0]!
    expect(answered).toMatchObject(humanAnswer)
    expect(questionEndedNotice(answered.answered, answered.answeredAt)).toBeNull()
    expect(store.getState().sessionNotifications[0]).toMatchObject({ id: notice.id, readAt: expect.any(Number) })

    handleMessage({ ...pending, toolUseId: 'ask-codex-closed', resolved: true, historySeq: 3 })
    expect(worker().messages[1]?.answered).toBe('(no longer pending)')
    expect(store.getState().sessionNotifications).toHaveLength(1)
  })

  it('retires a notice even when an empty full replay evicts its card and closure row', () => {
    store.setState((state) => ({
      sessions: [{ sessionId: 'worker', name: 'Worker' }] as ConnectionState['sessions'],
      sessionStates: { ...state.sessionStates, worker: createEmptySessionState() },
    }))
    handleMessage({
      type: 'user_question', sessionId: 'worker', toolUseId: 'ask-codex-evicted',
      questions: [{ question: 'Evicted question?' }],
    })
    const notice = store.getState().sessionNotifications[0]!
    handleMessage({ type: 'history_replay_start', sessionId: 'worker', fullHistory: true })
    handleMessage({ type: 'history_replay_end', sessionId: 'worker', pendingQuestionToolUseIds: [] })
    expect(store.getState().sessionStates.worker!.messages).toEqual([])
    expect(store.getState().sessionNotifications).toEqual([{ ...notice, readAt: expect.any(Number) }])
  })

  it('reconciles a nonempty pending snapshot for just the replayed session', () => {
    store.setState((state) => ({
      sessions: [{ sessionId: 'worker', name: 'Worker' }, { sessionId: 'other', name: 'Other' }] as ConnectionState['sessions'],
      sessionStates: { ...state.sessionStates, worker: createEmptySessionState(), other: createEmptySessionState() },
    }))
    const question = (toolUseId: string, sessionId = 'worker') => handleMessage({
      type: 'user_question', sessionId, toolUseId, questions: [{ question: 'Input?' }],
    })
    question('ask-codex-stale')
    question('ask-codex-pending')
    question('ask-codex-answered')
    question('ask-codex-stale', 'other')
    question('ask-legacy')
    handleMessage({ type: 'permission_request', sessionId: 'worker', requestId: 'perm-1', tool: 'Read' })
    const humanAnswer = { answered: '(no longer pending)', answeredAt: 0, answeredAnswers: { 'Input?': '(no longer pending)' } }
    store.setState((state) => ({
      sessionStates: {
        ...state.sessionStates,
        worker: {
          ...state.sessionStates.worker!,
          messages: state.sessionStates.worker!.messages.map((m) =>
            m.toolUseId === 'ask-codex-answered' ? { ...m, ...humanAnswer } : m),
        },
      },
    }))
    handleMessage({ type: 'history_replay_start', sessionId: 'worker', fullHistory: false })
    question('ask-codex-live')
    handleMessage({
      type: 'history_replay_end', sessionId: 'worker',
      pendingQuestionToolUseIds: ['ask-codex-pending', 'ask-codex-live'],
    })
    const cards = store.getState().sessionStates.worker!.messages
    expect(cards.find((m) => m.toolUseId === 'ask-codex-stale')?.answered).toBe('(no longer pending)')
    expect(cards.find((m) => m.toolUseId === 'ask-codex-pending')?.answered).toBeUndefined()
    expect(cards.find((m) => m.toolUseId === 'ask-codex-live')?.answered).toBeUndefined()
    expect(cards.find((m) => m.toolUseId === 'ask-codex-answered')).toMatchObject(humanAnswer)
    expect(cards.find((m) => m.toolUseId === 'ask-legacy')?.answered).toBe('(resolved)')
    expect(cards.find((m) => m.requestId === 'perm-1')?.answered).toBeUndefined()
    expect(store.getState().sessionStates.other!.messages[0]?.answered).toBeUndefined()
    expect(store.getState().sessionNotifications.filter((n) => n.readAt !== undefined).map((n) => [n.sessionId, n.toolUseId])).toEqual([
      ['worker', 'ask-codex-stale'], ['worker', 'ask-codex-answered'],
    ])
  })

  it.each([undefined, null, {}, ['ask-codex-pending', 42], ['ask-legacy'], ['ask-codex-' + 'x'.repeat(257)]].map((value) => ({ value })))(
    'keeps native notices and cards when the pending snapshot is unknown or malformed ($value)',
    ({ value: pendingQuestionToolUseIds }) => {
      store.setState((state) => ({
        sessions: [{ sessionId: 'worker', name: 'Worker' }] as ConnectionState['sessions'],
        sessionStates: { ...state.sessionStates, worker: createEmptySessionState() },
      }))
      handleMessage({
        type: 'user_question', sessionId: 'worker', toolUseId: 'ask-codex-unknown',
        questions: [{ question: 'Still waiting?' }],
      })
      handleMessage({ type: 'history_replay_start', sessionId: 'worker', fullHistory: false })
      handleMessage({ type: 'history_replay_end', sessionId: 'worker', pendingQuestionToolUseIds })
      expect(store.getState().sessionStates.worker!.messages[0]?.answered).toBeUndefined()
      expect(store.getState().sessionNotifications[0]?.readAt).toBeUndefined()
    },
  )

  it.each([false, true])('carries an answer made on the visible prefix after a pending row replayed (close row: %s)', (closeRow) => {
    store.setState((state) => ({
      sessions: [{ sessionId: 'worker', name: 'Worker' }] as ConnectionState['sessions'],
      sessionStates: { ...state.sessionStates, worker: createEmptySessionState() },
    }));
    const dispatch = handleMessage;
    const pending = {
      type: 'user_question', sessionId: 'worker', toolUseId: 'ask-codex-interleaved',
      questions: [{ question: 'Select a layout' }],
    };
    dispatch(pending);
    const originalId = store.getState().sessionStates.worker!.messages[0]!.id;
    dispatch({ type: 'history_replay_start', sessionId: 'worker', fullHistory: true });
    dispatch({ ...pending, historySeq: 1 });
    expect(store.getState().sessionStates.worker!.messages).toHaveLength(2);
    const answer = { answered: '(no longer pending)', answeredAt: 0, answeredAnswers: { 'Select a layout': '(no longer pending)' } };
    store.setState((state) => ({ sessionStates: { ...state.sessionStates, worker: {
      ...state.sessionStates.worker!,
      messages: state.sessionStates.worker!.messages.map((m) => m.id === originalId ? { ...m, ...answer } : m),
    } } }));
    dispatch({ type: 'permission_resolved', sessionId: 'worker', toolUseId: pending.toolUseId, reason: 'resolved', decision: 'allow', resolvedBy: { kind: 'user' } });
    if (closeRow) dispatch({ ...pending, historySeq: 2, resolved: true });
    dispatch({ type: 'history_replay_end', sessionId: 'worker', pendingQuestionToolUseIds: [] });
    const kept = store.getState().sessionStates.worker!.messages;
    expect(kept).toHaveLength(1);
    expect(kept[0]).toMatchObject(answer);
    expect(questionEndedNotice(kept[0]!.answered, kept[0]!.answeredAt)).toBeNull();
  });

  it('QUESTION_NOT_DELIVERED retracts the answer the card was marked with on send', () => {
    store.setState({
      sessionStates: {
        'sess-1': { messages: [card({ answered: 'A1', answeredAt: 5, answeredAnswers: { 'First?': 'A1' } })] },
      } as unknown as ConnectionState['sessionStates'],
    })
    handleMessage({ type: 'error', requestId: null, code: 'QUESTION_NOT_DELIVERED', message: 'Your answer was not delivered', toolUseId: 'ask-1', sessionId: 'sess-1' })
    const m = sessionMessages()[0]
    expect(m.answered).toBe('(not delivered)')
    expect(m.answeredAt).toBeUndefined()
    expect('answeredAnswers' in m).toBe(false)
    expect(store.getState().addServerError).not.toHaveBeenCalled()
  })

  it('finds the card in the flat messages when no session state holds it', () => {
    store.setState({
      sessionStates: {} as ConnectionState['sessionStates'],
      messages: [card({ answered: 'A1' })] as unknown as ConnectionState['messages'],
    })
    handleMessage({ type: 'error', code: 'QUESTION_NOT_DELIVERED', message: 'm', toolUseId: 'ask-1' })
    expect((store.getState().messages[0] as unknown as Record<string, unknown>).answered).toBe('(not delivered)')
  })

  it('falls back to the error toast when no card holds that question', () => {
    handleMessage({ type: 'error', code: 'QUESTION_NOT_DELIVERED', message: 'Your answer was not delivered', toolUseId: 'ask-unknown', fatal: false })
    expect(sessionMessages()[0].answered).toBeUndefined()
    expect(store.getState().addServerError).toHaveBeenCalledWith('Your answer was not delivered', undefined, 'warning', undefined)
  })
})
