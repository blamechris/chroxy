/**
 * #4663 — Multi-client broadcast coverage for per-session setting handlers
 * (dashboard side).
 *
 * Companion to packages/server/tests/handlers/settings-handlers-multi-client-broadcast.test.js.
 * Together they pin the full handler-level pipeline:
 *
 *   1. Server-side: a `set_xxx` from Client A produces a `xxx_changed`
 *      broadcast that lands at every client subscribed to that session
 *      (covered server-side).
 *   2. Dashboard-side (this file): when an `xxx_changed` event arrives,
 *      `handle*Changed` updates the entry in the `sessions` array
 *      without losing any unrelated session state (other sessions, other
 *      fields on the targeted session, sessionStates, etc.).
 *
 * Coverage previously stopped at the input → action → wire send level
 * (see SettingsPanel.test.tsx) — the receive-side store mutation was
 * untested, which hid the cross-session-switch bug noted in #4662 and
 * any future regression where a handler clobbers state it shouldn't
 * touch.
 *
 * The three handlers covered:
 *   - handlePromptEvaluatorChanged          (#3185 → prompt_evaluator_changed)
 *   - handleChroxyContextHintChanged        (#3805 → chroxy_context_hint_changed)
 *   - handleSessionPreambleChanged          (#4660 → session_preamble_changed)
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
import type { ConnectionState, SessionState } from './types'

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

/**
 * Build a base store state with two sessions so we can assert that
 * routing only touches the targeted session and the untouched session
 * keeps its full shape.
 */
function baseStateWithTwoSessions(): Partial<ConnectionState> {
  const s1State: SessionState = {
    ...createEmptySessionState(),
    // Stuff some content into s1 so we can prove it isn't clobbered.
    messages: [{ id: 'm-1', type: 'response', content: 'hello', timestamp: 1 } as any],
  }
  const s2State: SessionState = {
    ...createEmptySessionState(),
    messages: [{ id: 'm-2', type: 'response', content: 'goodbye', timestamp: 2 } as any],
  }

  return {
    connectionPhase: 'connected',
    socket: null,
    sessions: [
      {
        sessionId: 's1',
        name: 'Session 1',
        cwd: '/tmp/s1',
        promptEvaluator: false,
        chroxyContextHint: false,
        sessionPreamble: '',
      } as any,
      {
        sessionId: 's2',
        name: 'Session 2',
        cwd: '/tmp/s2',
        promptEvaluator: false,
        chroxyContextHint: false,
        sessionPreamble: '',
      } as any,
    ],
    activeSessionId: 's1',
    sessionStates: { s1: s1State, s2: s2State },
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

describe('dashboard message-handler — per-session setting broadcast receivers (#4663)', () => {
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
    store = createMockStore(baseStateWithTwoSessions())
    setStore(store)
  })

  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
    clearPermissionSplits()
    resetReplayFlags()
  })

  describe('prompt_evaluator_changed (#3185)', () => {
    it('updates the targeted session entry and leaves the other session untouched', () => {
      handleMessage(
        { type: 'prompt_evaluator_changed', sessionId: 's1', value: true },
        ctx() as any,
      )

      const state = store.getState() as ConnectionState
      const s1 = state.sessions.find((s) => s.sessionId === 's1')!
      const s2 = state.sessions.find((s) => s.sessionId === 's2')!

      expect(s1.promptEvaluator).toBe(true)
      // Bystander session must keep its original value — regression
      // guard for the cross-session-switch bug noted in #4662.
      expect(s2.promptEvaluator).toBe(false)
    })

    it('preserves unrelated fields on the targeted session entry', () => {
      handleMessage(
        { type: 'prompt_evaluator_changed', sessionId: 's1', value: true },
        ctx() as any,
      )

      const state = store.getState() as ConnectionState
      const s1 = state.sessions.find((s) => s.sessionId === 's1')!

      // The other per-session settings must not be touched.
      expect(s1.chroxyContextHint).toBe(false)
      expect(s1.sessionPreamble).toBe('')
      expect(s1.name).toBe('Session 1')
      expect(s1.cwd).toBe('/tmp/s1')
    })

    it('does not touch sessionStates (messages, transient state)', () => {
      handleMessage(
        { type: 'prompt_evaluator_changed', sessionId: 's1', value: true },
        ctx() as any,
      )

      const state = store.getState() as ConnectionState
      // The handler operates on the `sessions` summary list only — the
      // per-session message log lives in `sessionStates` and must be
      // left alone.
      expect(state.sessionStates.s1!.messages).toHaveLength(1)
      expect(state.sessionStates.s1!.messages[0]!.id).toBe('m-1')
      expect(state.sessionStates.s2!.messages).toHaveLength(1)
      expect(state.sessionStates.s2!.messages[0]!.id).toBe('m-2')
    })

    it('drops the event when value is not a boolean (defensive)', () => {
      handleMessage(
        { type: 'prompt_evaluator_changed', sessionId: 's1', value: 'true' as any },
        ctx() as any,
      )

      const state = store.getState() as ConnectionState
      const s1 = state.sessions.find((s) => s.sessionId === 's1')!
      // No mutation on malformed payload.
      expect(s1.promptEvaluator).toBe(false)
    })

    it('falls back to activeSessionId when sessionId is missing on the wire', () => {
      // Some legacy server paths omit sessionId in favour of the
      // active-session implicit-target convention. The handler uses
      // resolveSessionId which falls back to get().activeSessionId.
      handleMessage(
        { type: 'prompt_evaluator_changed', value: true },
        ctx() as any,
      )

      const state = store.getState() as ConnectionState
      const s1 = state.sessions.find((s) => s.sessionId === 's1')!
      expect(s1.promptEvaluator).toBe(true)
    })
  })

  describe('chroxy_context_hint_changed (#3805)', () => {
    it('updates the targeted session entry and leaves the other session untouched', () => {
      handleMessage(
        { type: 'chroxy_context_hint_changed', sessionId: 's1', value: true },
        ctx() as any,
      )

      const state = store.getState() as ConnectionState
      const s1 = state.sessions.find((s) => s.sessionId === 's1')!
      const s2 = state.sessions.find((s) => s.sessionId === 's2')!

      expect(s1.chroxyContextHint).toBe(true)
      expect(s2.chroxyContextHint).toBe(false)
    })

    it('preserves unrelated fields on the targeted session entry', () => {
      handleMessage(
        { type: 'chroxy_context_hint_changed', sessionId: 's1', value: true },
        ctx() as any,
      )

      const state = store.getState() as ConnectionState
      const s1 = state.sessions.find((s) => s.sessionId === 's1')!

      expect(s1.promptEvaluator).toBe(false)
      expect(s1.sessionPreamble).toBe('')
      expect(s1.name).toBe('Session 1')
    })

    it('drops the event when value is not a boolean (defensive)', () => {
      handleMessage(
        { type: 'chroxy_context_hint_changed', sessionId: 's1', value: 1 as any },
        ctx() as any,
      )

      const state = store.getState() as ConnectionState
      const s1 = state.sessions.find((s) => s.sessionId === 's1')!
      expect(s1.chroxyContextHint).toBe(false)
    })
  })

  describe('session_preamble_changed (#4660)', () => {
    it('updates the targeted session entry and leaves the other session untouched', () => {
      handleMessage(
        {
          type: 'session_preamble_changed',
          sessionId: 's1',
          value: 'always use bullet points',
        },
        ctx() as any,
      )

      const state = store.getState() as ConnectionState
      const s1 = state.sessions.find((s) => s.sessionId === 's1')!
      const s2 = state.sessions.find((s) => s.sessionId === 's2')!

      expect(s1.sessionPreamble).toBe('always use bullet points')
      expect(s2.sessionPreamble).toBe('')
    })

    it('accepts an empty string payload (clears the preamble)', () => {
      // Seed s1 with a preamble so we can verify the clear path.
      store.setState((prev: any) => ({
        sessions: prev.sessions.map((s: any) =>
          s.sessionId === 's1' ? { ...s, sessionPreamble: 'old text' } : s,
        ),
      }))

      handleMessage(
        { type: 'session_preamble_changed', sessionId: 's1', value: '' },
        ctx() as any,
      )

      const state = store.getState() as ConnectionState
      const s1 = state.sessions.find((s) => s.sessionId === 's1')!
      expect(s1.sessionPreamble).toBe('')
    })

    it('preserves unrelated fields on the targeted session entry', () => {
      handleMessage(
        {
          type: 'session_preamble_changed',
          sessionId: 's1',
          value: 'new preamble',
        },
        ctx() as any,
      )

      const state = store.getState() as ConnectionState
      const s1 = state.sessions.find((s) => s.sessionId === 's1')!

      expect(s1.promptEvaluator).toBe(false)
      expect(s1.chroxyContextHint).toBe(false)
      expect(s1.name).toBe('Session 1')
      expect(s1.cwd).toBe('/tmp/s1')
    })

    it('drops the event when value is not a string (defensive)', () => {
      handleMessage(
        {
          type: 'session_preamble_changed',
          sessionId: 's1',
          value: 42 as any,
        },
        ctx() as any,
      )

      const state = store.getState() as ConnectionState
      const s1 = state.sessions.find((s) => s.sessionId === 's1')!
      expect(s1.sessionPreamble).toBe('')
    })
  })

  // #4663 — the original bug class is "Client A sends set_xxx, Client B's
  // dashboard receives the broadcast but doesn't update because the
  // `sessions` array is shared by reference and another component mutates
  // it elsewhere." This test pins the immutability contract: the handler
  // creates a NEW sessions array (so React/Zustand selectors see a
  // reference change) AND new entry objects (so deep-equal selectors
  // see a change on the affected entry only).
  describe('immutability contract — selectors get reference changes', () => {
    it('handlePromptEvaluatorChanged returns a new sessions array', () => {
      const before = (store.getState() as ConnectionState).sessions
      handleMessage(
        { type: 'prompt_evaluator_changed', sessionId: 's1', value: true },
        ctx() as any,
      )
      const after = (store.getState() as ConnectionState).sessions
      expect(after).not.toBe(before)
    })

    it('handleChroxyContextHintChanged returns a new sessions array', () => {
      const before = (store.getState() as ConnectionState).sessions
      handleMessage(
        { type: 'chroxy_context_hint_changed', sessionId: 's1', value: true },
        ctx() as any,
      )
      const after = (store.getState() as ConnectionState).sessions
      expect(after).not.toBe(before)
    })

    it('handleSessionPreambleChanged returns a new sessions array and a new s1 entry', () => {
      const before = (store.getState() as ConnectionState).sessions
      const beforeS1 = before.find((s) => s.sessionId === 's1')!
      const beforeS2 = before.find((s) => s.sessionId === 's2')!

      handleMessage(
        { type: 'session_preamble_changed', sessionId: 's1', value: 'x' },
        ctx() as any,
      )

      const after = (store.getState() as ConnectionState).sessions
      const afterS1 = after.find((s) => s.sessionId === 's1')!
      const afterS2 = after.find((s) => s.sessionId === 's2')!

      expect(after).not.toBe(before)
      expect(afterS1).not.toBe(beforeS1)
      // Bystander session entry can be reused (map only replaces the
      // matched entry) — pin that contract so a future refactor that
      // copies every entry is caught and reviewed.
      expect(afterS2).toBe(beforeS2)
    })
  })
})
