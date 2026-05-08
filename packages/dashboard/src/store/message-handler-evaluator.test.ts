/**
 * #3188 — auto-evaluator (rewrite / clarify) message-handler tests.
 *
 * The pre-existing message-handler.test.ts only covers the manual
 * `evaluate_draft_result` round-trip. These tests cover the broadcast
 * events fired by the auto-evaluator hook (#3186) when a session has
 * `promptEvaluator: true`:
 *
 *  - `evaluator_rewrite` — push a `system` ChatMessage carrying the
 *    rewrite metadata so ChatView can render the explanation banner.
 *  - `evaluator_clarify` — set `pendingEvaluatorClarify` on the session
 *    so the inline clarify prompt block renders above InputBar.
 *
 * Replay safety: receiving the same `evaluatorIterationId` twice (live
 * broadcast then localStorage-cache replay via `sessionMessagesKey`,
 * or duplicate broadcast) must NOT insert a duplicate banner or reset
 * clarify state.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'

vi.mock('./crypto', () => ({
  createKeyPair: vi.fn(() => ({ publicKey: 'mock-pub', secretKey: 'mock-sec' })),
  deriveSharedKey: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  generateConnectionSalt: vi.fn(() => 'mock-salt'),
  deriveConnectionKey: vi.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0,
  DIRECTION_SERVER: 1,
}))

vi.mock('./persistence', () => ({
  clearPersistedSession: vi.fn(),
}))

import {
  handleMessage,
  setStore,
  clearDeltaBuffers,
  clearPermissionSplits,
  stopHeartbeat,
  resetReplayFlags,
} from './message-handler'
import { createEmptySessionState } from './utils'
import type { ChatMessage, ConnectionState, SessionState } from './types'

function createMockStore(initial: Partial<ConnectionState>) {
  let state = initial as ConnectionState
  return {
    getState: () => state,
    setState: (s: Partial<ConnectionState> | ((prev: ConnectionState) => Partial<ConnectionState>)) => {
      const patch = typeof s === 'function' ? s(state) : s
      state = { ...state, ...patch }
    },
  }
}

function createMockSocket(): WebSocket {
  return {
    send: vi.fn(),
    close: vi.fn(),
    readyState: WebSocket.OPEN,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

function baseStateWithSession(
  sessionId: string,
  overrides: Partial<SessionState> = {},
): Partial<ConnectionState> {
  return {
    connectionPhase: 'connected',
    socket: null,
    sessions: [],
    activeSessionId: sessionId,
    sessionStates: { [sessionId]: { ...createEmptySessionState(), ...overrides } },
    messages: [],
    myClientId: 'client-1',
    terminalBuffer: '',
    terminalRawBuffer: '',
    serverErrors: [],
    addServerError: () => {},
    appendTerminalData: () => {},
    serverProtocolVersion: null,
  } as unknown as Partial<ConnectionState>
}

describe('dashboard message-handler — auto-evaluator (#3188)', () => {
  let store: ReturnType<typeof createMockStore>
  let mockSocket: WebSocket
  const ctx = () => ({
    url: 'wss://t',
    token: 'tok',
    socket: mockSocket,
    isReconnect: false,
    silent: false,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    clearDeltaBuffers()
    clearPermissionSplits()
    mockSocket = createMockSocket()
    store = createMockStore(baseStateWithSession('s1'))
    setStore(store)
  })

  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
    clearPermissionSplits()
    resetReplayFlags()
  })

  describe('evaluator_rewrite', () => {
    it('inserts a system ChatMessage with rewrite evaluator metadata', () => {
      handleMessage({
        type: 'evaluator_rewrite',
        sessionId: 's1',
        originalDraft: 'fix it',
        rewritten: 'Please fix the failing test in foo.js',
        reasoning: 'Original was too vague.',
        evaluatorIterationId: 'iter-abc-1',
      }, ctx() as any)

      const session = (store.getState() as any).sessionStates.s1 as SessionState
      expect(session.messages).toHaveLength(1)
      const sysMsg = session.messages[0]!
      expect(sysMsg.type).toBe('system')
      expect(sysMsg.evaluator).toBeDefined()
      expect(sysMsg.evaluator?.kind).toBe('rewrite')
      expect(sysMsg.evaluator?.evaluatorIterationId).toBe('iter-abc-1')
      expect(sysMsg.evaluator?.originalDraft).toBe('fix it')
      expect(sysMsg.evaluator?.rewritten).toBe('Please fix the failing test in foo.js')
      expect(sysMsg.evaluator?.reasoning).toBe('Original was too vague.')
      // Banner-summary content drives the collapsed-state label.
      expect(sysMsg.content).toContain('rewritten')
    })

    it('routes to the targeted session, not just the active one', () => {
      // Two sessions: active=s1, rewrite payload targets s2.
      const s2 = createEmptySessionState()
      store.setState((prev: any) => ({
        sessionStates: { ...prev.sessionStates, s2 },
      }))

      handleMessage({
        type: 'evaluator_rewrite',
        sessionId: 's2',
        originalDraft: 'do it',
        rewritten: 'Run the linter on src/',
        reasoning: 'specified target',
        evaluatorIterationId: 'iter-s2-1',
      }, ctx() as any)

      const states = (store.getState() as any).sessionStates as Record<string, SessionState>
      expect(states.s1!.messages).toEqual([])
      expect(states.s2!.messages).toHaveLength(1)
      expect(states.s2!.messages[0]!.evaluator?.evaluatorIterationId).toBe('iter-s2-1')
    })

    it('dedupes by evaluatorIterationId on replay (no duplicate banner)', () => {
      const event = {
        type: 'evaluator_rewrite',
        sessionId: 's1',
        originalDraft: 'fix it',
        rewritten: 'Please fix the failing test in foo.js',
        reasoning: 'too vague',
        evaluatorIterationId: 'iter-dup-1',
      }
      handleMessage(event, ctx() as any)
      handleMessage(event, ctx() as any) // simulate localStorage-cache replay (sessionMessagesKey)

      const session = (store.getState() as any).sessionStates.s1 as SessionState
      expect(session.messages).toHaveLength(1)
    })

    it('clears any stale pendingEvaluatorClarify when a new rewrite verdict lands', () => {
      // Prime: clarify is pending from a prior round-trip.
      store.setState((prev: any) => ({
        sessionStates: {
          ...prev.sessionStates,
          s1: {
            ...prev.sessionStates.s1,
            pendingEvaluatorClarify: {
              evaluatorIterationId: 'iter-prior',
              evaluatorIteration: 1,
              originalDraft: 'fix',
              clarification: 'which file?',
              reasoning: '',
            },
          },
        },
      }))

      handleMessage({
        type: 'evaluator_rewrite',
        sessionId: 's1',
        originalDraft: 'fix it',
        rewritten: 'Please fix foo.js',
        reasoning: '',
        evaluatorIterationId: 'iter-new',
      }, ctx() as any)

      const session = (store.getState() as any).sessionStates.s1 as SessionState
      expect(session.messages).toHaveLength(1)
      expect(session.pendingEvaluatorClarify).toBeNull()
    })

    it('drops the event when required fields are missing', () => {
      handleMessage({
        type: 'evaluator_rewrite',
        sessionId: 's1',
        // missing originalDraft + rewritten
        evaluatorIterationId: 'iter-bad-1',
      }, ctx() as any)

      const session = (store.getState() as any).sessionStates.s1 as SessionState
      expect(session.messages).toEqual([])
    })

    it('drops the event when the targeted session does not exist', () => {
      handleMessage({
        type: 'evaluator_rewrite',
        sessionId: 'session-that-does-not-exist',
        originalDraft: 'x',
        rewritten: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-x',
      }, ctx() as any)

      const session = (store.getState() as any).sessionStates.s1 as SessionState
      expect(session.messages).toEqual([])
    })
  })

  describe('evaluator_clarify', () => {
    it('sets pendingEvaluatorClarify with iteration counter and question', () => {
      handleMessage({
        type: 'evaluator_clarify',
        sessionId: 's1',
        originalDraft: 'fix it',
        clarification: 'Which file?',
        reasoning: 'Draft does not specify a file.',
        evaluatorIterationId: 'iter-c1',
        evaluatorIteration: 1,
      }, ctx() as any)

      const session = (store.getState() as any).sessionStates.s1 as SessionState
      expect(session.pendingEvaluatorClarify).toBeDefined()
      expect(session.pendingEvaluatorClarify!.evaluatorIteration).toBe(1)
      expect(session.pendingEvaluatorClarify!.clarification).toBe('Which file?')
      expect(session.pendingEvaluatorClarify!.originalDraft).toBe('fix it')
      expect(session.pendingEvaluatorClarify!.reasoning).toBe('Draft does not specify a file.')
      expect(session.pendingEvaluatorClarify!.evaluatorIterationId).toBe('iter-c1')
    })

    it('renders Iteration 2/3 and 3/3 transparency for subsequent rounds', () => {
      // Round 2.
      handleMessage({
        type: 'evaluator_clarify',
        sessionId: 's1',
        originalDraft: 'still vague',
        clarification: 'Which directory?',
        reasoning: 'still vague',
        evaluatorIterationId: 'iter-c2',
        evaluatorIteration: 2,
      }, ctx() as any)

      let session = (store.getState() as any).sessionStates.s1 as SessionState
      expect(session.pendingEvaluatorClarify!.evaluatorIteration).toBe(2)

      // Round 3 (server's max).
      handleMessage({
        type: 'evaluator_clarify',
        sessionId: 's1',
        originalDraft: 'still vague',
        clarification: 'I still cannot tell — which file?',
        reasoning: 'final attempt',
        evaluatorIterationId: 'iter-c3',
        evaluatorIteration: 3,
      }, ctx() as any)

      session = (store.getState() as any).sessionStates.s1 as SessionState
      expect(session.pendingEvaluatorClarify!.evaluatorIteration).toBe(3)
      expect(session.pendingEvaluatorClarify!.evaluatorIterationId).toBe('iter-c3')
    })

    it('does NOT push a banner system message — clarify state is transient', () => {
      handleMessage({
        type: 'evaluator_clarify',
        sessionId: 's1',
        originalDraft: 'x',
        clarification: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-c1',
        evaluatorIteration: 1,
      }, ctx() as any)

      const session = (store.getState() as any).sessionStates.s1 as SessionState
      // No system message — only the persisted rewrite banner adds one.
      expect(session.messages).toEqual([])
    })

    it('dedupes a duplicate broadcast for the same evaluatorIterationId', () => {
      const event = {
        type: 'evaluator_clarify',
        sessionId: 's1',
        originalDraft: 'fix',
        clarification: 'which file?',
        reasoning: 'vague',
        evaluatorIterationId: 'iter-dup-c',
        evaluatorIteration: 1,
      }
      handleMessage(event, ctx() as any)
      const first = (store.getState() as any).sessionStates.s1.pendingEvaluatorClarify
      handleMessage(event, ctx() as any)
      const second = (store.getState() as any).sessionStates.s1.pendingEvaluatorClarify
      // Reference unchanged — handler short-circuited on the dedup check.
      expect(second).toBe(first)
    })

    it('drops the event when evaluatorIteration is not a positive integer', () => {
      // 0 violates the schema (1-based) — defensive.
      handleMessage({
        type: 'evaluator_clarify',
        sessionId: 's1',
        originalDraft: 'x',
        clarification: 'y',
        reasoning: '',
        evaluatorIterationId: 'iter-bad',
        evaluatorIteration: 0,
      }, ctx() as any)

      const session = (store.getState() as any).sessionStates.s1 as SessionState
      expect(session.pendingEvaluatorClarify).toBeUndefined()
    })

    it('drops the event when targeted session does not exist', () => {
      handleMessage({
        type: 'evaluator_clarify',
        sessionId: 'no-such-session',
        originalDraft: 'x',
        clarification: 'y',
        reasoning: 'z',
        evaluatorIterationId: 'iter-x',
        evaluatorIteration: 1,
      }, ctx() as any)

      const session = (store.getState() as any).sessionStates.s1 as SessionState
      expect(session.pendingEvaluatorClarify).toBeUndefined()
    })
  })

  describe('replay safety — system message survives reconnect', () => {
    it('a rewrite system message replayed via session messages still renders only once', () => {
      // First arrival: live broadcast.
      handleMessage({
        type: 'evaluator_rewrite',
        sessionId: 's1',
        originalDraft: 'fix it',
        rewritten: 'Run lint on src/',
        reasoning: '',
        evaluatorIterationId: 'iter-replay-1',
      }, ctx() as any)
      const before = (store.getState() as any).sessionStates.s1.messages as ChatMessage[]
      expect(before).toHaveLength(1)

      // Simulate reconnect: handler called again with the same event id
      // (e.g. the cached system message is replayed from the per-session
      // localStorage cache, and the live event arrives a second time
      // too).
      handleMessage({
        type: 'evaluator_rewrite',
        sessionId: 's1',
        originalDraft: 'fix it',
        rewritten: 'Run lint on src/',
        reasoning: '',
        evaluatorIterationId: 'iter-replay-1',
      }, ctx() as any)

      const after = (store.getState() as any).sessionStates.s1.messages as ChatMessage[]
      expect(after).toHaveLength(1)
      expect(after[0]!.evaluator?.evaluatorIterationId).toBe('iter-replay-1')
    })
  })

  // #3188 — pendingEvaluatorClarify lifecycle hardening (Copilot review on PR #3643).
  // The clarify prompt must drop on:
  //   - cross-client user_input echo (a remote client answered)
  // and stay PUT on:
  //   - failed local send (queue full, etc.) — covered by sendInput tests
  describe('pendingEvaluatorClarify lifecycle', () => {
    it('clears pendingEvaluatorClarify when a remote client answers (user_input echo)', () => {
      // Set up a pending clarify on s1.
      handleMessage({
        type: 'evaluator_clarify',
        sessionId: 's1',
        originalDraft: 'remove it',
        clarification: 'Which file?',
        reasoning: 'Ambiguous.',
        evaluatorIterationId: 'iter-1',
        evaluatorIteration: 1,
      }, ctx() as any)
      let session = (store.getState() as any).sessionStates.s1 as SessionState
      expect(session.pendingEvaluatorClarify).toBeDefined()

      // Simulate a remote client (different clientId) answering.
      handleMessage({
        type: 'user_input',
        sessionId: 's1',
        clientId: 'other-client',
        text: 'src/utils.js',
        messageId: 'remote-1',
        timestamp: Date.now(),
      }, ctx() as any)

      session = (store.getState() as any).sessionStates.s1 as SessionState
      expect(session.pendingEvaluatorClarify).toBeNull()
    })

    it('does NOT clear pendingEvaluatorClarify when the echo is from this client (no-op)', () => {
      // sharedUserInput skips echoes from the local clientId — that path
      // is covered by the existing user_input handler test. Here we just
      // pin that the clarify clear is gated behind sharedUserInput's
      // null-result short-circuit.
      handleMessage({
        type: 'evaluator_clarify',
        sessionId: 's1',
        originalDraft: 'remove it',
        clarification: 'Which file?',
        reasoning: 'Ambiguous.',
        evaluatorIterationId: 'iter-2',
        evaluatorIteration: 1,
      }, ctx() as any)

      // myClientId in baseStateWithSession is 'client-1'; emit a
      // user_input echo from the same id — sharedUserInput returns null,
      // handler returns early, pendingEvaluatorClarify is preserved.
      handleMessage({
        type: 'user_input',
        sessionId: 's1',
        clientId: 'client-1',
        text: 'self-echo',
        messageId: 'self-1',
        timestamp: Date.now(),
      }, ctx() as any)

      const session = (store.getState() as any).sessionStates.s1 as SessionState
      expect(session.pendingEvaluatorClarify).toBeDefined()
      expect(session.pendingEvaluatorClarify?.evaluatorIterationId).toBe('iter-2')
    })
  })
})
