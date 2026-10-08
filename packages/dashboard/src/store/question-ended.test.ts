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
