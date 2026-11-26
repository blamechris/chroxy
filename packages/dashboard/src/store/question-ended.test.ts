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
      type: 'user_question', sessionId: 'worker', toolUseId: 'codex-ask-1',
      questions: [{ question: 'Select a layout', options: [{ label: 'List', description: 'Show one row per item' }], allowOther: false }],
    }
    const other = { ...pending, toolUseId: 'codex-ask-2' }
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
    handleMessage({ ...clear, toolUseId: 'unknown' })
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

  it('uses history to retire a missed worker clear without overwriting human answers', () => {
    store.setState((state) => ({
      sessions: [{ sessionId: 'worker', name: 'Worker' }] as ConnectionState['sessions'],
      sessionStates: { ...state.sessionStates, worker: createEmptySessionState() },
    }))
    const pending = {
      type: 'user_question', sessionId: 'worker', toolUseId: 'codex-ask-1',
      questions: [{ question: 'Select a layout' }],
    }
    handleMessage(pending)
    const notice = store.getState().sessionNotifications[0]!
    const worker = () => store.getState().sessionStates.worker!
    const humanAnswer = { answered: 'List', answeredAnswers: { 'Select a layout': 'List' }, answeredAt: 123 }
    store.setState((state) => ({
      sessionStates: {
        ...state.sessionStates, worker: { ...worker(), messages: [{ ...worker().messages[0]!, ...humanAnswer }] },
      },
    }))
    handleMessage({ type: 'history_replay_start', sessionId: 'worker', fullHistory: true })
    handleMessage({ ...pending, resolved: true, historySeq: 2 })
    handleMessage({ type: 'history_replay_end', sessionId: 'worker' })
    expect(worker().messages[0]).toMatchObject(humanAnswer)
    expect(store.getState().sessionNotifications[0]).toMatchObject({ id: notice.id, readAt: expect.any(Number) })

    handleMessage({ ...pending, toolUseId: 'codex-closed', resolved: true, historySeq: 3 })
    expect(worker().messages[1]?.answered).toBe('(no longer pending)')
    expect(store.getState().sessionNotifications).toHaveLength(1)
  })

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
