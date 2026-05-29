/**
 * Smoke tests for the dashboard WebSocket message handler.
 *
 * Covers basic dispatch for a handful of key message types, malformed input,
 * and unknown-type handling. The handler is ~2300 lines — this file exercises
 * the dispatch entry points, not every branch.
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
  registerEvaluatorRequest,
  cancelEvaluatorRequest,
  registerTrustGrantRequest,
  clearPendingTrustGrants,
  _testTrustGrantPendingSize,
} from './message-handler'
import { createEmptySessionState } from './utils'
import type { ConnectionState } from './types'

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

function baseState(overrides: Partial<ConnectionState> = {}): Partial<ConnectionState> {
  const serverErrors: unknown[] = []
  // #3587: capture the optional `action` arg so new tests can assert
  // an actionable INVALID_AUTHOR toast carries a label + click handler.
  // Existing tests still read `serverErrors` as the message-string list.
  const serverErrorActions: Array<unknown> = []
  const grantCalls: Array<{ skillName: string; author: string }> = []
  const terminalWrites: string[] = []
  return {
    connectionPhase: 'connected',
    socket: null,
    sessions: [],
    activeSessionId: null,
    sessionStates: {},
    messages: [],
    terminalBuffer: '',
    terminalRawBuffer: '',
    customAgents: [],
    slashCommands: [],
    connectedClients: [],
    serverErrors,
    addServerError: (e: unknown, action?: unknown) => {
      serverErrors.push(e)
      serverErrorActions.push(action)
    },
    grantCommunitySkillTrust: (skillName: string, author: string) => {
      grantCalls.push({ skillName, author })
    },
    appendTerminalData: (d: string) => { terminalWrites.push(d) },
    _terminalWrites: terminalWrites,
    _serverErrorActions: serverErrorActions,
    _grantCalls: grantCalls,
    serverProtocolVersion: null,
    ...overrides,
  } as unknown as Partial<ConnectionState>
}

describe('dashboard message-handler dispatch', () => {
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
    // #3587: reset the in-flight skill_trust_grant tracking map between
    // tests so a leftover entry from one case doesn't leak into another.
    clearPendingTrustGrants()
    mockSocket = createMockSocket()
    store = createMockStore(baseState())
    setStore(store)
  })

  afterEach(() => {
    stopHeartbeat()
    clearDeltaBuffers()
    clearPermissionSplits()
    resetReplayFlags()
    // #3587: defensive cleanup so a test that registers a pending
    // trust-grant entry but doesn't consume it can't poison the next.
    clearPendingTrustGrants()
  })

  describe('auth_ok dispatch', () => {
    it('transitions connectionPhase to connected', () => {
      handleMessage(
        {
          type: 'auth_ok',
          serverMode: 'cli',
          cwd: '/tmp',
          serverVersion: '0.6.0',
          protocolVersion: 3,
          clientId: 'c1',
          connectedClients: [],
        },
        ctx() as any,
      )
      expect(store.getState().connectionPhase).toBe('connected')
      expect(store.getState().serverVersion).toBe('0.6.0')
    })
  })

  describe('error dispatch', () => {
    it('routes structured error messages to addServerError', () => {
      handleMessage(
        { type: 'error', code: 'BOOM', message: 'something broke' },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.serverErrors).toEqual(['something broke'])
    })

    it('falls back to generic text when message is missing', () => {
      handleMessage({ type: 'error', code: 'X' }, ctx() as any)
      const state = store.getState() as any
      expect(state.serverErrors).toHaveLength(1)
      expect(typeof state.serverErrors[0]).toBe('string')
    })

    // #3570: INVALID_AUTHOR error from skill_trust_grant carries the
    // structured `actualAuthor` field (#3568,
    // ServerSkillTrustGrantInvalidAuthorSchema). The dashboard surfaces
    // the real owner in the toast and points the operator at the
    // matching pending-row Trust button as the recovery path, instead
    // of regex-parsing the (intentionally unstable) human-readable
    // server message.
    describe('skill_trust_grant INVALID_AUTHOR (#3570)', () => {
      it('rewrites the toast to name the actualAuthor and points to the matching pending row', () => {
        handleMessage(
          {
            type: 'error',
            requestId: 'trust-grant-1',
            code: 'INVALID_AUTHOR',
            message: 'Author mismatch — skill resolves to a different owner',
            actualAuthor: 'alice',
          },
          ctx() as any,
        )
        const state = store.getState() as any
        expect(state.serverErrors).toHaveLength(1)
        const surfaced = state.serverErrors[0] as string
        expect(surfaced).toContain("'alice'")
        expect(surfaced.toLowerCase()).toContain('owned by')
        expect(surfaced).toContain("Trust alice")
        // Server's stable-wording-disclaimed text must NOT be the
        // surfaced toast — we built our own using the structured field.
        expect(surfaced).not.toBe('Author mismatch — skill resolves to a different owner')
      })

      it('falls back to the raw message when actualAuthor is missing (empty-author validation variant)', () => {
        // #3568 schema comment: the empty-`author` validation branch
        // emits INVALID_AUTHOR WITHOUT `actualAuthor`. The dashboard
        // must not crash and must show the server-supplied text.
        handleMessage(
          {
            type: 'error',
            requestId: 'trust-grant-2',
            code: 'INVALID_AUTHOR',
            message: 'author must be a non-empty string',
          },
          ctx() as any,
        )
        const state = store.getState() as any
        expect(state.serverErrors).toEqual(['author must be a non-empty string'])
      })

      it('ignores actualAuthor on unrelated error codes', () => {
        // Defensive: if some future handler accidentally sets
        // `actualAuthor` on a non-INVALID_AUTHOR error, we must NOT
        // rewrite — the structured field is INVALID_AUTHOR-only.
        handleMessage(
          {
            type: 'error',
            code: 'TRUST_FLUSH_FAILED',
            message: 'flush failed',
            actualAuthor: 'alice',
          },
          ctx() as any,
        )
        const state = store.getState() as any
        expect(state.serverErrors).toEqual(['flush failed'])
      })

      it('falls back to the raw message when actualAuthor is empty string', () => {
        // Empty string is treated as missing — we don't want to render
        // "owned by ''" if the server somehow sends a blank field.
        handleMessage(
          {
            type: 'error',
            code: 'INVALID_AUTHOR',
            message: 'Author mismatch',
            actualAuthor: '',
          },
          ctx() as any,
        )
        const state = store.getState() as any
        expect(state.serverErrors).toEqual(['Author mismatch'])
      })

      it('falls back to the raw message when actualAuthor is non-string', () => {
        handleMessage(
          {
            type: 'error',
            code: 'INVALID_AUTHOR',
            message: 'Author mismatch',
            actualAuthor: 42,
          },
          ctx() as any,
        )
        const state = store.getState() as any
        expect(state.serverErrors).toEqual(['Author mismatch'])
      })
    })

    // #3587: when the dashboard issued the original `skill_trust_grant`
    // and tracked the requestId locally, the INVALID_AUTHOR error gains
    // a one-click "Try as <actualAuthor>" recovery action that re-issues
    // skill_trust_grant against the corrected author.
    describe('skill_trust_grant INVALID_AUTHOR actionable toast (#3587)', () => {
      it('attaches a "Try as <actualAuthor>" action when the request was tracked', () => {
        registerTrustGrantRequest('trust-grant-actionable-1', {
          skillName: 'pyramid',
          author: 'bob',
        })
        handleMessage(
          {
            type: 'error',
            requestId: 'trust-grant-actionable-1',
            code: 'INVALID_AUTHOR',
            message: 'Author mismatch — server text',
            actualAuthor: 'alice',
          },
          ctx() as any,
        )
        const state = store.getState() as any
        // Surfaced toast names BOTH the actual owner and the wrong
        // author the operator clicked, plus the retry prompt.
        expect(state.serverErrors).toHaveLength(1)
        const surfaced = state.serverErrors[0] as string
        expect(surfaced).toContain("'alice'")
        expect(surfaced).toContain("'bob'")
        expect(surfaced.toLowerCase()).toContain('try as alice')
        // Action is attached.
        const action = state._serverErrorActions[0] as { label: string; onClick: () => void }
        expect(action).toBeDefined()
        expect(action.label).toBe('Try as alice')
        expect(typeof action.onClick).toBe('function')
      })

      it('action.onClick re-issues skill_trust_grant with the corrected author', () => {
        registerTrustGrantRequest('trust-grant-click-1', {
          skillName: 'mountain',
          author: 'bob',
        })
        handleMessage(
          {
            type: 'error',
            requestId: 'trust-grant-click-1',
            code: 'INVALID_AUTHOR',
            message: 'Author mismatch',
            actualAuthor: 'alice',
          },
          ctx() as any,
        )
        const state = store.getState() as any
        const action = state._serverErrorActions[0] as { label: string; onClick: () => void }
        expect(state._grantCalls).toEqual([])
        action.onClick()
        // Round-trip: the click fires grantCommunitySkillTrust with the
        // ORIGINAL skillName and the ACTUAL (corrected) author.
        expect(state._grantCalls).toEqual([{ skillName: 'mountain', author: 'alice' }])
      })

      it('falls back to the #3570 text-only hint when no tracked request matches the requestId', () => {
        // Disconnect/reconnect drops the in-flight map; a duplicate
        // INVALID_AUTHOR error after a manual close+reopen would land
        // here. We must not crash and must still rewrite the message
        // (no action button possible without the skillName).
        handleMessage(
          {
            type: 'error',
            requestId: 'trust-grant-untracked-1',
            code: 'INVALID_AUTHOR',
            message: 'Author mismatch',
            actualAuthor: 'alice',
          },
          ctx() as any,
        )
        const state = store.getState() as any
        const surfaced = state.serverErrors[0] as string
        expect(surfaced).toContain("'alice'")
        expect(surfaced).toContain("Trust alice")
        // No action — operator must use the pending row.
        expect(state._serverErrorActions[0]).toBeUndefined()
      })

      it('falls back to text-only when requestId is null (anonymous error)', () => {
        // The server schema permits `requestId: null` — we must not
        // try to consume from the map with a null key.
        registerTrustGrantRequest('trust-grant-null-1', {
          skillName: 'river',
          author: 'bob',
        })
        handleMessage(
          {
            type: 'error',
            requestId: null,
            code: 'INVALID_AUTHOR',
            message: 'Author mismatch',
            actualAuthor: 'alice',
          },
          ctx() as any,
        )
        const state = store.getState() as any
        // Hint rewritten (so operator still sees actualAuthor) but no
        // action attached.
        expect(state.serverErrors[0]).toContain("'alice'")
        expect(state._serverErrorActions[0]).toBeUndefined()
        // The unrelated registered request is still pending — the null
        // requestId error doesn't consume an arbitrary entry.
        expect(_testTrustGrantPendingSize()).toBe(1)
      })

      it('consumes the pending entry on first error so a duplicate retry has no action', () => {
        // Defensive: if the server somehow emits two INVALID_AUTHOR
        // errors for the same requestId (network duplication, future
        // protocol change), only the first carries the action.
        registerTrustGrantRequest('trust-grant-dup-1', {
          skillName: 'tree',
          author: 'bob',
        })
        const errorMsg = {
          type: 'error',
          requestId: 'trust-grant-dup-1',
          code: 'INVALID_AUTHOR',
          message: 'Author mismatch',
          actualAuthor: 'alice',
        }
        handleMessage(errorMsg, ctx() as any)
        handleMessage(errorMsg, ctx() as any)
        const state = store.getState() as any
        expect(state.serverErrors).toHaveLength(2)
        expect(state._serverErrorActions[0]).toBeDefined()
        // Second toast falls back to text-only (no action) because the
        // tracked request was consumed by the first.
        expect(state._serverErrorActions[1]).toBeUndefined()
      })

      it('skill_trust_grant_ok ack clears the pending entry', () => {
        // On the success path the error never fires — the entry must
        // still be released so the bounded map doesn't leak.
        registerTrustGrantRequest('trust-grant-ok-1', {
          skillName: 'lake',
          author: 'alice',
        })
        expect(_testTrustGrantPendingSize()).toBe(1)
        handleMessage(
          {
            type: 'skill_trust_grant_ok',
            requestId: 'trust-grant-ok-1',
            sessionId: 'sess-1',
            skillName: 'lake',
            author: 'alice',
          },
          ctx() as any,
        )
        expect(_testTrustGrantPendingSize()).toBe(0)
      })

      it('does not attach an action on non-INVALID_AUTHOR errors even with a tracked request', () => {
        // TRUST_FLUSH_FAILED still resolves the same requestId (the
        // server's catch block path), so the tracked entry is consumed
        // — but we never attach a "Try as" action because the right
        // recovery is "retry as the original author", not "swap author".
        registerTrustGrantRequest('trust-grant-flush-1', {
          skillName: 'star',
          author: 'alice',
        })
        handleMessage(
          {
            type: 'error',
            requestId: 'trust-grant-flush-1',
            code: 'TRUST_FLUSH_FAILED',
            message: 'flush failed',
          },
          ctx() as any,
        )
        const state = store.getState() as any
        expect(state.serverErrors).toEqual(['flush failed'])
        expect(state._serverErrorActions[0]).toBeUndefined()
        // Entry consumed (resolved): map is empty.
        expect(_testTrustGrantPendingSize()).toBe(0)
      })
    })
  })

  describe('session_error dispatch', () => {
    it('pushes non-crash session errors into addServerError', () => {
      handleMessage(
        {
          type: 'session_error',
          category: 'runtime',
          message: 'session failed',
          sessionId: 'sess-1',
        },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.serverErrors).toEqual(['session failed'])
    })

    // Issue #2904: bound-token error should be rewritten to something
    // actionable that names the session instead of the raw "Not authorized".
    it('rewrites SESSION_TOKEN_MISMATCH with bound session name into an actionable hint', () => {
      handleMessage(
        {
          type: 'session_error',
          code: 'SESSION_TOKEN_MISMATCH',
          message: 'Not authorized: client is bound to a specific session',
          boundSessionId: 'sess-xyz',
          boundSessionName: 'MarchBorne',
        },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.serverErrors).toHaveLength(1)
      const err = state.serverErrors[0]
      expect(err).toContain('MarchBorne')
      expect(err).toMatch(/disconnect/i)
    })

    it('falls back to the raw message when boundSessionName is missing', () => {
      handleMessage(
        {
          type: 'session_error',
          code: 'SESSION_TOKEN_MISMATCH',
          message: 'Not authorized: client is bound to a specific session',
          // no boundSessionName — old server OR name lookup failed
        },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.serverErrors).toEqual([
        'Not authorized: client is bound to a specific session',
      ])
    })
  })

  describe('session_restore_failed dispatch', () => {
    it('surfaces failed persisted sessions through addServerError', () => {
      handleMessage(
        {
          type: 'session_restore_failed',
          sessionId: 'sess-bad',
          name: 'Codex-Test',
          provider: 'codex',
          model: 'opus-4-6',
          errorCode: 'MODEL_NOT_SUPPORTED_BY_PROVIDER',
          errorMessage: 'Model "opus-4-6" is not supported by provider "codex"',
          originalHistoryPreserved: true,
          historyLength: 2,
        },
        ctx() as any,
      )

      const state = store.getState() as any
      expect(state.serverErrors).toEqual([
        'Failed to restore Codex-Test: Model "opus-4-6" is not supported by provider "codex"',
      ])
    })
  })

  describe('stream_delta dispatch', () => {
    // Fake timers for the 100ms delta batcher — runAllTimers() flushes
    // synchronously instead of waiting on real wall-clock setTimeout(150).
    beforeEach(() => {
      vi.useFakeTimers()
    })

    afterEach(() => {
      vi.useRealTimers()
    })

    it('forwards delta text to appendTerminalData', () => {
      handleMessage(
        {
          type: 'stream_delta',
          messageId: 'm1',
          sessionId: 'sess-1',
          delta: 'hello ',
        },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state._terminalWrites).toContain('hello ')
    })

    // #3071 — when stream_start is dropped (e.g., session not yet in store at
    // the time it arrived), the next stream_delta with the same messageId must
    // NOT concatenate onto the existing tool_use bubble. The delta handler
    // defends by detecting the type collision and lazy-creating a suffixed
    // response. Mirrors the equivalent fix in the mobile app handler.
    it('lazy-creates response bubble when stream_delta lands on a tool_use id', () => {
      const toolMsg = { id: 'msg-1', type: 'tool_use' as const, content: 'ls', timestamp: 1 }
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: {
          s1: { ...createEmptySessionState(), messages: [toolMsg] },
        },
      }))
      setStore(store)

      // Skip stream_start — simulate the dropped/raced case
      handleMessage(
        { type: 'stream_delta', messageId: 'msg-1', sessionId: 's1', delta: 'After tool ' },
        ctx() as any,
      )
      handleMessage(
        { type: 'stream_delta', messageId: 'msg-1', sessionId: 's1', delta: 'response' },
        ctx() as any,
      )
      // Flush the 100ms delta batcher
      vi.runAllTimers()

      const ss = (store.getState() as any).sessionStates.s1
      const responseMsg = ss.messages.find((m: any) => m.id === 'msg-1-response')
      expect(responseMsg).toBeDefined()
      expect(responseMsg?.type).toBe('response')
      expect(responseMsg?.content).toBe('After tool response')
      // tool_use bubble must remain pristine — no concatenated assistant text
      const toolUseMsg = ss.messages.find((m: any) => m.id === 'msg-1')
      expect(toolUseMsg?.content).toBe('ls')
    })

    // Same defensive fallback in the flat-messages mode, exercised when the
    // session isn't registered in sessionStates yet (pre-session bootstrap or
    // server hasn't echoed session_switched). The collision must still route to
    // a suffixed response id without polluting the tool_use bubble.
    it('lazy-creates response bubble in flat-messages mode when collision hits a tool_use', () => {
      const toolMsg = { id: 'msg-flat', type: 'tool_use' as const, content: 'ls', timestamp: 1 }
      store = createMockStore(baseState({
        activeSessionId: null,
        sessionStates: {},
        messages: [toolMsg],
      }))
      setStore(store)

      handleMessage(
        { type: 'stream_delta', messageId: 'msg-flat', delta: 'flat ' },
        ctx() as any,
      )
      handleMessage(
        { type: 'stream_delta', messageId: 'msg-flat', delta: 'response' },
        ctx() as any,
      )
      vi.runAllTimers()

      const flat = (store.getState() as any).messages
      const responseMsg = flat.find((m: any) => m.id === 'msg-flat-response')
      expect(responseMsg).toBeDefined()
      expect(responseMsg?.type).toBe('response')
      expect(responseMsg?.content).toBe('flat response')
      const toolUseMsg = flat.find((m: any) => m.id === 'msg-flat')
      expect(toolUseMsg?.content).toBe('ls')
    })

    // Belt-and-suspenders: even if a stream_delta sneaks past the defensive
    // remap in handleStreamDelta (e.g. the colliding tool_use is added to
    // state AFTER the delta is queued), flushPendingDeltas itself must never
    // apply delta text onto a non-response message.
    it('flushPendingDeltas type-filter prevents tool_use corruption when collision slips past defensive remap', () => {
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: {
          s1: { ...createEmptySessionState(), messages: [] },
        },
      }))
      setStore(store)

      // Step 1: dispatch delta when no message exists at this id — defensive
      // remap can't catch the collision since the tool_use isn't there yet.
      handleMessage(
        { type: 'stream_delta', messageId: 'msg-race', sessionId: 's1', delta: 'must not leak' },
        ctx() as any,
      )

      // Step 2: race condition — tool_use is added AFTER the delta is queued
      // but BEFORE the 100ms batcher flushes.
      ;(store as any).setState((s: any) => ({
        sessionStates: {
          ...s.sessionStates,
          s1: {
            ...s.sessionStates.s1,
            messages: [{ id: 'msg-race', type: 'tool_use' as const, content: 'ls', timestamp: 1 }],
          },
        },
      }))

      // Step 3: flush
      vi.runAllTimers()

      const ss = (store.getState() as any).sessionStates.s1
      const toolUse = ss.messages.find((m: any) => m.id === 'msg-race' && m.type === 'tool_use')
      // tool_use bubble must remain pristine — no delta concatenation
      expect(toolUse?.content).toBe('ls')
      // Orphan-create suffixes the response id when there's a non-response
      // collision, so the messages array does not contain duplicate ids.
      const orphan = ss.messages.find((m: any) => m.id === 'msg-race-response')
      expect(orphan?.type).toBe('response')
      expect(orphan?.content).toBe('must not leak')
      // No two messages share an id.
      const ids = ss.messages.map((m: any) => m.id)
      expect(new Set(ids).size).toBe(ids.length)
    })

    // #4297 — claude TUI fires stream_start at turn-start (per #4010), creating
    // an empty response slot at position 0. Tool events that follow append at
    // positions 1, 2, … . Then the final summary stream_delta arrives and the
    // text accumulates into the position-0 slot — making claude's wrap-up
    // appear ABOVE the tool groups it summarized. Fix: on the first delta for
    // an empty response slot, move that slot to the current end of the
    // messages array so chat order matches Output-tab order.
    describe('first-delta reorders empty response slot (#4297)', () => {
      it('moves the empty response slot to the end on first delta when tools were appended after stream_start', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        // Turn opens: stream_start fires first (#4010), creating empty response.
        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        // Tools fire while response slot is still empty.
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_a',
            tool: 'Bash',
            toolUseId: 'toolu_a',
            input: { command: 'ls' },
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'tool_result',
            toolUseId: 'toolu_a',
            result: 'foo bar',
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_b',
            tool: 'Read',
            toolUseId: 'toolu_b',
            input: { path: '/tmp' },
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'tool_result',
            toolUseId: 'toolu_b',
            result: 'baz',
            sessionId: 's1',
          },
          ctx() as any,
        )
        // Finally, the summary text streams in.
        handleMessage(
          { type: 'stream_delta', messageId: 'resp-1', sessionId: 's1', delta: 'All done.' },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        // Response message must sit AFTER the two tool bubbles, not at index 0.
        const lastMsg = ss.messages[ss.messages.length - 1]
        expect(lastMsg.id).toBe('resp-1')
        expect(lastMsg.type).toBe('response')
        expect(lastMsg.content).toBe('All done.')
        // Tool bubbles preserved in order before the response.
        expect(ss.messages[0].id).toBe('toolu_a')
        expect(ss.messages[1].id).toBe('toolu_b')
      })

      it('leaves response slot in place when text streams immediately (no interleaved tools)', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        handleMessage(
          { type: 'stream_start', messageId: 'resp-2', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          { type: 'stream_delta', messageId: 'resp-2', sessionId: 's1', delta: 'hi' },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        expect(ss.messages).toHaveLength(1)
        expect(ss.messages[0].id).toBe('resp-2')
        expect(ss.messages[0].content).toBe('hi')
      })

      it('does not reorder when a tool fires AFTER the first delta', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        handleMessage(
          { type: 'stream_start', messageId: 'resp-3', sessionId: 's1' },
          ctx() as any,
        )
        // Preamble text streams BEFORE any tool — response anchors at index 0.
        handleMessage(
          { type: 'stream_delta', messageId: 'resp-3', sessionId: 's1', delta: 'Let me check…' },
          ctx() as any,
        )
        vi.runAllTimers()
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_after',
            tool: 'Bash',
            toolUseId: 'toolu_after',
            input: { command: 'ls' },
            sessionId: 's1',
          },
          ctx() as any,
        )

        const ss = (store.getState() as any).sessionStates.s1
        // Preamble response at index 0, tool at index 1 — chronological order
        // matches the wire arrival.
        expect(ss.messages[0].id).toBe('resp-3')
        expect(ss.messages[1].id).toBe('toolu_after')
      })

      it('does not reorder a non-empty (reconnect-replayed) response slot', () => {
        // Simulate reconnect replay where a previous turn's response is
        // already populated. A subsequent delta on it should NOT reorder.
        const replayedResp = {
          id: 'resp-replay',
          type: 'response' as const,
          content: 'Existing replayed content. ',
          timestamp: 1,
        }
        const tool = { id: 'toolu_x', type: 'tool_use' as const, content: 'ls', timestamp: 2 }
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: {
              s1: { ...createEmptySessionState(), messages: [replayedResp, tool] },
            },
          }),
        )
        setStore(store)

        handleMessage(
          { type: 'stream_delta', messageId: 'resp-replay', sessionId: 's1', delta: 'more text' },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        // Response stays at index 0 (the reorder gate is content === '').
        expect(ss.messages[0].id).toBe('resp-replay')
        expect(ss.messages[0].content).toBe('Existing replayed content. more text')
        expect(ss.messages[1].id).toBe('toolu_x')
      })

      it('reorders empty response slot in flat-state branch (legacy/pre-session bootstrap)', () => {
        const flatBase = baseState({
          activeSessionId: null,
          sessions: [],
          sessionStates: {},
          messages: [],
        }) as Record<string, unknown>
        flatBase.addMessage = (m: unknown) => {
          const s = store.getState() as { messages: unknown[] }
          ;(store as { setState: (p: Record<string, unknown>) => void }).setState({
            messages: [...s.messages, m],
          })
        }
        store = createMockStore(flatBase)
        setStore(store)

        handleMessage({ type: 'stream_start', messageId: 'flat-resp' }, ctx() as any)
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'flat-tool',
            tool: 'Bash',
            toolUseId: 'flat-tool',
            input: { command: 'ls' },
          },
          ctx() as any,
        )
        handleMessage(
          { type: 'stream_delta', messageId: 'flat-resp', delta: 'flat summary' },
          ctx() as any,
        )
        vi.runAllTimers()

        const flat = (store.getState() as any).messages
        const last = flat[flat.length - 1]
        expect(last.id).toBe('flat-resp')
        expect(last.content).toBe('flat summary')
        expect(flat[0].id).toBe('flat-tool')
      })
    })
  })

  describe('malformed input', () => {
    it('ignores non-object messages', () => {
      expect(() => handleMessage('not an object', ctx() as any)).not.toThrow()
      expect(() => handleMessage(null, ctx() as any)).not.toThrow()
      expect(() => handleMessage(42, ctx() as any)).not.toThrow()
      expect(() => handleMessage([], ctx() as any)).not.toThrow()
    })

    it('ignores messages with missing or non-string type', () => {
      expect(() => handleMessage({}, ctx() as any)).not.toThrow()
      expect(() => handleMessage({ type: 123 }, ctx() as any)).not.toThrow()
    })
  })

  describe('server_status dispatch (#2836)', () => {
    it('sets serverPhase to tunnel_warming with attempt count for phase=tunnel_warming', () => {
      handleMessage(
        {
          type: 'server_status',
          phase: 'tunnel_warming',
          attempt: 3,
          maxAttempts: 20,
          tunnelMode: 'quick',
          tunnelUrl: 'https://abc.trycloudflare.com',
          message: 'Tunnel warming up… (3/20)',
        },
        ctx() as any,
      )
      const state = store.getState()
      expect(state.serverPhase).toBe('tunnel_warming')
      expect(state.tunnelProgress).toEqual({ attempt: 3, maxAttempts: 20 })
    })

    it('still recognizes legacy phase=tunnel_verifying', () => {
      handleMessage(
        {
          type: 'server_status',
          phase: 'tunnel_verifying',
          attempt: 1,
          maxAttempts: 20,
        },
        ctx() as any,
      )
      const state = store.getState()
      expect(state.serverPhase).toBe('tunnel_warming')
      expect(state.tunnelProgress).toEqual({ attempt: 1, maxAttempts: 20 })
    })

    it('transitions to ready on phase=ready and clears tunnelProgress', () => {
      // First warm up
      handleMessage(
        {
          type: 'server_status',
          phase: 'tunnel_warming',
          attempt: 5,
          maxAttempts: 20,
        },
        ctx() as any,
      )
      expect(store.getState().serverPhase).toBe('tunnel_warming')
      // Then transition to ready
      handleMessage(
        { type: 'server_status', phase: 'ready', tunnelUrl: 'https://abc.trycloudflare.com' },
        ctx() as any,
      )
      expect(store.getState().serverPhase).toBe('ready')
      expect(store.getState().tunnelProgress).toBeNull()
    })

    it('handles tunnel_warming without attempt count (initial broadcast)', () => {
      handleMessage(
        {
          type: 'server_status',
          phase: 'tunnel_warming',
          tunnelMode: 'quick',
          tunnelUrl: 'https://abc.trycloudflare.com',
          message: 'Tunnel warming up…',
        },
        ctx() as any,
      )
      const state = store.getState()
      expect(state.serverPhase).toBe('tunnel_warming')
      expect(state.tunnelProgress).toBeNull()
    })
  })

  describe('history replay: user_input rehydration', () => {
    function seed() {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: { s1: createEmptySessionState() },
        }),
      )
      setStore(store)
    }

    // Regression: server replays historical user prompts as
    // { type: 'message', messageType: 'user_input' }. On plain reconnect replay
    // (no session switch) the dashboard dropped them, leaving the chat empty
    // or showing orphaned assistant responses.
    it('rehydrates user_input entries during reconnect replay', () => {
      seed()
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      handleMessage(
        {
          type: 'message',
          messageType: 'user_input',
          content: 'scan the repo',
          sessionId: 's1',
          timestamp: 100,
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].type).toBe('user_input')
      expect(msgs[0].content).toBe('scan the repo')
    })

    // Previously a "cache is fresh" guard skipped ALL replay entries once the
    // legacy flat messages array had anything. Per-entry dedup at the same
    // handler already prevents duplicates, so the blanket guard was removed.
    it('does not blanket-skip replay when legacy messages list is non-empty', () => {
      seed()
      ;(store.getState() as any).messages = [{ id: 'legacy', type: 'system', content: 'x', timestamp: 1 }]
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      handleMessage(
        {
          type: 'message',
          messageType: 'response',
          content: 'new response',
          messageId: 'resp-1',
          sessionId: 's1',
          timestamp: 500,
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].type).toBe('response')
      expect(msgs[0].content).toBe('new response')
    })

    // Issue #2902: the sender's optimistic user_input carries the same id the
    // server stamped (via clientMessageId). On reconnect, replay must dedup by
    // that id — otherwise sender sees their own prompt twice.
    it('dedups replayed user_input against optimistic entry sharing the same id', () => {
      seed()
      const sharedId = 'user-7-1700000000000'
      ;(store.getState() as any).sessionStates.s1.messages = [
        { id: sharedId, type: 'user_input', content: 'hi there', timestamp: 1 },
      ]
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      handleMessage(
        {
          type: 'message',
          messageType: 'user_input',
          content: 'hi there [1 file(s) attached]', // server may suffix attachment marker
          messageId: sharedId,
          sessionId: 's1',
          timestamp: 2, // differs from optimistic timestamp
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(1)
    })

    it('preserves server-assigned messageId on rehydrated user_input (for future dedup)', () => {
      seed()
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      handleMessage(
        {
          type: 'message',
          messageType: 'user_input',
          content: 'replayed prompt',
          messageId: 'uin-123-9',
          sessionId: 's1',
          timestamp: 100,
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].id).toBe('uin-123-9')
    })

    it('skips messageType=user_input entries outside replay', () => {
      seed()
      handleMessage(
        {
          type: 'message',
          messageType: 'user_input',
          content: 'live echo',
          sessionId: 's1',
          timestamp: 200,
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(0)
    })
  })

  describe('history replay: tool_start dedup (#2901)', () => {
    function seedWithTool(toolId: string) {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: {
            s1: {
              ...createEmptySessionState(),
              messages: [
                { id: toolId, type: 'tool_use', content: 'Bash: ls', tool: 'Bash', timestamp: 1 },
              ],
            },
          },
        }),
      )
      setStore(store)
    }

    // Regression: on plain reconnect replay (not a session switch), the
    // dashboard's `tool_start` handler had a blanket
    // `_receivingHistoryReplay && !_isSessionSwitchReplay && get().messages.length > 0`
    // early return that fired against the legacy flat `messages` array — but
    // multi-session state keeps that array empty, so the guard never tripped
    // and replayed tool_use entries appended on top of the live copies. The
    // per-id dedup at the same handler now runs on every replay path.
    it('deduplicates tool_use by stable messageId during plain reconnect replay', () => {
      seedWithTool('tool-1')
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-1',
          tool: 'Bash',
          input: 'ls',
          sessionId: 's1',
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].id).toBe('tool-1')
    })

    it('deduplicates tool_use by stable messageId during session-switch replay', () => {
      seedWithTool('tool-1')
      handleMessage(
        { type: 'history_replay_start', sessionId: 's1', fullHistory: true },
        ctx() as any,
      )
      // session-switch replay clears messages first, so re-seed a tool to
      // simulate the replay sending the same tool a client already cached
      // (e.g. from a previous fetch). We bypass the clear by re-injecting.
      ;(store.getState() as any).sessionStates.s1.messages = [
        { id: 'tool-1', type: 'tool_use', content: 'Bash: ls', tool: 'Bash', timestamp: 1 },
      ]
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-1',
          tool: 'Bash',
          input: 'ls',
          sessionId: 's1',
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(1)
    })

    it('appends new tool_use whose id is not yet in cache (legitimate replay)', () => {
      seedWithTool('tool-1')
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-2',
          tool: 'Read',
          input: 'file.ts',
          sessionId: 's1',
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(2)
      expect(msgs[1].id).toBe('tool-2')
      expect(msgs[1].tool).toBe('Read')
    })

    it('does not blanket-skip tool_start replay when legacy messages list is non-empty', () => {
      // Pre-fix: legacy `messages.length > 0` guard would drop this entire
      // tool_start because the flat array had something. Per-id dedup lets
      // genuinely new tools through.
      seedWithTool('tool-1')
      ;(store.getState() as any).messages = [
        { id: 'legacy', type: 'system', content: 'x', timestamp: 1 },
      ]
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-3',
          tool: 'Edit',
          input: 'patch',
          sessionId: 's1',
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(2)
      expect(msgs[1].id).toBe('tool-3')
    })

    it('appends tool_use normally outside any history replay (live event)', () => {
      seedWithTool('tool-1')
      // No history_replay_start — this is a live tool_start
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-1', // same id, still appended because not in replay
          tool: 'Bash',
          input: 'ls',
          sessionId: 's1',
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      // Live duplicates are unusual but not handled here — only replay dedups.
      expect(msgs).toHaveLength(2)
    })
  })

  // #4081 — server emits `tool_input_delta { messageId, toolUseId,
  // partialJson }` chunks between tool_start and tool_result so the
  // bubble can render the input field forming. The dispatcher must
  // route the chunks to the matching tool_use bubble's
  // `toolInputPartial` accumulator, concatenating across deltas.
  describe('tool_input_delta dispatch (#4081)', () => {
    function seedWithTool(toolUseId: string, sessionId = 's1') {
      store = createMockStore(
        baseState({
          activeSessionId: sessionId,
          sessions: [{ sessionId, name: 'S1' } as any],
          sessionStates: {
            [sessionId]: {
              ...createEmptySessionState(),
              messages: [
                {
                  id: 'tu-msg-1',
                  type: 'tool_use',
                  content: 'Bash',
                  tool: 'Bash',
                  toolUseId,
                  timestamp: 1,
                },
              ],
            },
          },
        }),
      )
      setStore(store)
    }

    it('appends partialJson to toolInputPartial on first delta', () => {
      seedWithTool('tu-1')
      handleMessage(
        {
          type: 'tool_input_delta',
          messageId: 'msg-x',
          toolUseId: 'tu-1',
          partialJson: '{"command":"',
          sessionId: 's1',
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs[0].toolInputPartial).toBe('{"command":"')
    })

    it('concatenates 3 sequential deltas into the full buffer', () => {
      seedWithTool('tu-1')
      const chunks = ['{"command":"', 'rm -rf /tmp/', 'foo"}']
      for (const partialJson of chunks) {
        handleMessage(
          {
            type: 'tool_input_delta',
            messageId: 'msg-x',
            toolUseId: 'tu-1',
            partialJson,
            sessionId: 's1',
          },
          ctx() as any,
        )
      }
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs[0].toolInputPartial).toBe('{"command":"rm -rf /tmp/foo"}')
    })

    it('renders accumulated buffer even when partial JSON is unparseable', () => {
      // Acceptance criterion from the issue: partial JSON that can't yet
      // parse must accumulate and surface, NOT raise an error.
      seedWithTool('tu-1')
      handleMessage(
        {
          type: 'tool_input_delta',
          messageId: 'msg-x',
          toolUseId: 'tu-1',
          partialJson: '{"command":"rm -rf ',
          sessionId: 's1',
        },
        ctx() as any,
      )
      const msg = (store.getState() as any).sessionStates.s1.messages[0]
      // Buffer is present even though it is mid-token-stream JSON.
      expect(msg.toolInputPartial).toBe('{"command":"rm -rf ')
      // The tool_use entry remains a tool_use — no error message inserted.
      expect(msg.type).toBe('tool_use')
      expect((store.getState() as any).sessionStates.s1.messages).toHaveLength(1)
    })

    it('drops the delta silently when no matching tool_use exists', () => {
      seedWithTool('tu-1')
      handleMessage(
        {
          type: 'tool_input_delta',
          messageId: 'msg-x',
          toolUseId: 'tu-missing',
          partialJson: '{"a":1}',
          sessionId: 's1',
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].toolInputPartial).toBeUndefined()
    })

    it('drops malformed payloads (missing partialJson) without crashing', () => {
      seedWithTool('tu-1')
      handleMessage(
        {
          type: 'tool_input_delta',
          messageId: 'msg-x',
          toolUseId: 'tu-1',
          sessionId: 's1',
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs[0].toolInputPartial).toBeUndefined()
    })

    it('bubble keeps accumulated buffer when tool_result lands afterwards', () => {
      // Acceptance criterion: bubble switches to the standard result
      // view on tool_result. The buffer is preserved for replay/history;
      // the renderer (ToolBubble) gates display on the presence of
      // `result`. Here we just verify both fields coexist on the entry.
      seedWithTool('tu-1')
      handleMessage(
        {
          type: 'tool_input_delta',
          messageId: 'msg-x',
          toolUseId: 'tu-1',
          partialJson: '{"command":"ls"}',
          sessionId: 's1',
        },
        ctx() as any,
      )
      handleMessage(
        {
          type: 'tool_result',
          toolUseId: 'tu-1',
          result: 'file1.ts\nfile2.ts',
          sessionId: 's1',
        },
        ctx() as any,
      )
      const msg = (store.getState() as any).sessionStates.s1.messages[0]
      expect(msg.toolInputPartial).toBe('{"command":"ls"}')
      expect(msg.toolResult).toBe('file1.ts\nfile2.ts')
    })

    it('routes deltas to the correct tool_use when multiple are streaming', () => {
      // Multi-tool turn: both bubbles streaming simultaneously. The
      // dispatcher must use the toolUseId to disambiguate; no cross-
      // contamination is allowed.
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: {
            s1: {
              ...createEmptySessionState(),
              messages: [
                { id: 'm-a', type: 'tool_use', content: 'Bash', tool: 'Bash', toolUseId: 'tu-a', timestamp: 1 },
                { id: 'm-b', type: 'tool_use', content: 'Read', tool: 'Read', toolUseId: 'tu-b', timestamp: 2 },
              ],
            },
          },
        }),
      )
      setStore(store)
      handleMessage(
        { type: 'tool_input_delta', messageId: 'mx', toolUseId: 'tu-a', partialJson: '{"command":"ls"}', sessionId: 's1' },
        ctx() as any,
      )
      handleMessage(
        { type: 'tool_input_delta', messageId: 'mx', toolUseId: 'tu-b', partialJson: '{"path":"/etc"}', sessionId: 's1' },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs[0].toolInputPartial).toBe('{"command":"ls"}')
      expect(msgs[1].toolInputPartial).toBe('{"path":"/etc"}')
    })
  })

  // Regression for #3163: when a turn opens with a tool (no preamble text →
  // no stream_start), streamingMessageId is still 'pending' from sendInput.
  // The 5-second safety timer in sendInput would otherwise clear it, hiding
  // the stop button for the rest of the tool execution. tool_start must bump
  // streamingMessageId out of 'pending' so the safety timer no-ops.
  describe('tool_start streamingMessageId bump (#3163)', () => {
    it('bumps streamingMessageId out of "pending" when the turn opens with a tool', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: {
            s1: { ...createEmptySessionState(), messages: [], streamingMessageId: 'pending' },
          },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'toolu_first',
          tool: 'Bash',
          toolUseId: 'toolu_first',
          input: { command: 'ls' },
          sessionId: 's1',
        },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      // streamingMessageId is bumped to the tool bubble's id, which matches
      // the wire messageId when one is provided.
      expect(ss.streamingMessageId).toBe(ss.messages[0].id)
      expect(ss.streamingMessageId).toBe('toolu_first')
      expect(ss.streamingMessageId).not.toBe('pending')
    })

    it('does NOT overwrite streamingMessageId when stream_start has already fired', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: {
            s1: { ...createEmptySessionState(), messages: [], streamingMessageId: 'msg-real' },
          },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'toolu_after_text',
          tool: 'Bash',
          toolUseId: 'toolu_after_text',
          input: { command: 'ls' },
          sessionId: 's1',
        },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.streamingMessageId).toBe('msg-real')
    })

    it('bumps off "pending" using the synthesized tool bubble id when tool_start has no messageId', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: {
            s1: { ...createEmptySessionState(), messages: [], streamingMessageId: 'pending' },
          },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'tool_start',
          // messageId omitted — defensive against schema-violating input
          tool: 'Bash',
          toolUseId: 'toolu_no_msgid',
          input: { command: 'ls' },
          sessionId: 's1',
        },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      // sharedToolStart synthesizes a 'tool-N-<ts>' id when msg.messageId is
      // missing, and we bump streamingMessageId to that exact id so it always
      // matches a real message in state. No separate sentinel needed.
      expect(ss.messages).toHaveLength(1)
      expect(ss.streamingMessageId).toBe(ss.messages[0].id)
      expect(ss.streamingMessageId).not.toBe('pending')
      expect(ss.streamingMessageId).toMatch(/^tool-\d+-\d+$/)
    })

    // Flat-state branch (legacy / pre-session bootstrap): when the target
    // session isn't in sessionStates, sendInput writes 'pending' to flat state
    // and tool_start should bump it off 'pending' there too.
    it('bumps off "pending" in the flat-state branch when sessionStates is empty', () => {
      const flatBase = baseState({
        activeSessionId: null,
        sessions: [],
        sessionStates: {},
        messages: [],
        streamingMessageId: 'pending',
      }) as Record<string, unknown>
      // The dashboard's tool_start handler calls get().addMessage in the
      // flat-state path; provide a minimal mock that pushes to messages.
      flatBase.addMessage = (m: unknown) => {
        const s = store.getState() as { messages: unknown[] }
        ;(store as { setState: (p: Record<string, unknown>) => void }).setState({ messages: [...s.messages, m] })
      }
      store = createMockStore(flatBase)
      setStore(store)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'toolu_flat',
          tool: 'Bash',
          toolUseId: 'toolu_flat',
          input: { command: 'ls' },
          // No sessionId — flat-state path
        },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.streamingMessageId).toBe('toolu_flat')
      expect(state.streamingMessageId).not.toBe('pending')
      expect(state.messages.some((m: any) => m.id === 'toolu_flat' && m.type === 'tool_use')).toBe(true)
    })
  })

  // Regression for #3171: when the Agent SDK shuts down abnormally, agent_idle
  // can fire without a closing stream_end/result. Pre-#3171 the only paths that
  // cleared streamingMessageId mid-turn were stream_end, result, disconnect, or
  // a subsequent stream_start/tool_start — none of which arrive in this corner.
  // The 5s safety timer in sendInput used to recover this case but was bypassed
  // by #3170. agent_idle is now the recovery hook: it must clear streamingMessageId
  // so the stop button hides.
  describe('activeTools wiring (#4308)', () => {
    it('pushes an ActiveTool entry on tool_start', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-1',
          tool: 'Bash',
          toolUseId: 'tu-1',
          input: { command: 'ls' },
          sessionId: 's1',
        },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.activeTools).toHaveLength(1)
      expect(ss.activeTools[0].toolUseId).toBe('tu-1')
      expect(ss.activeTools[0].tool).toBe('Bash')
      expect(ss.activeTools[0].input).toEqual({ command: 'ls' })
      expect(typeof ss.activeTools[0].startedAt).toBe('number')
    })

    it('removes the matching entry on tool_result', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-1',
          tool: 'Bash',
          toolUseId: 'tu-1',
          input: { command: 'ls' },
          sessionId: 's1',
        },
        ctx() as any,
      )
      handleMessage(
        { type: 'tool_result', toolUseId: 'tu-1', result: 'out', sessionId: 's1' },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.activeTools).toEqual([])
    })

    it('supports parallel in-flight tools (multiple tool_start before any tool_result)', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-1',
          tool: 'Bash',
          toolUseId: 'tu-1',
          sessionId: 's1',
        },
        ctx() as any,
      )
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-2',
          tool: 'Read',
          toolUseId: 'tu-2',
          sessionId: 's1',
        },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.activeTools.map((t: any) => t.toolUseId)).toEqual(['tu-1', 'tu-2'])
      // Resolving tu-1 leaves tu-2 still in flight.
      handleMessage(
        { type: 'tool_result', toolUseId: 'tu-1', result: 'ok', sessionId: 's1' },
        ctx() as any,
      )
      const ss2 = (store.getState() as any).sessionStates.s1
      expect(ss2.activeTools.map((t: any) => t.toolUseId)).toEqual(['tu-2'])
    })

    it('clears activeTools on agent_idle as a safety net', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-1',
          tool: 'Bash',
          toolUseId: 'tu-1',
          sessionId: 's1',
        },
        ctx() as any,
      )
      // tool_result never arrives; agent_idle fires (e.g. abnormal SDK shutdown).
      handleMessage({ type: 'agent_idle', sessionId: 's1' }, ctx() as any)
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.activeTools).toEqual([])
    })

    it('clears activeTools on result as a safety net', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-1',
          tool: 'Bash',
          toolUseId: 'tu-1',
          sessionId: 's1',
        },
        ctx() as any,
      )
      handleMessage({ type: 'result', sessionId: 's1' }, ctx() as any)
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.activeTools).toEqual([])
    })
  })

  describe('agent_idle clears streamingMessageId (#3171)', () => {
    it('clears streamingMessageId when agent_idle fires mid-stream', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: {
            s1: { ...createEmptySessionState(), messages: [], streamingMessageId: 'msg-active', isIdle: false },
          },
        }),
      )
      setStore(store)
      handleMessage({ type: 'agent_idle', sessionId: 's1' }, ctx() as any)
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.isIdle).toBe(true)
      expect(ss.streamingMessageId).toBeNull()
    })

    it('also clears the "pending" sentinel left by sendInput on abnormal shutdown', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: {
            s1: { ...createEmptySessionState(), messages: [], streamingMessageId: 'pending', isIdle: false },
          },
        }),
      )
      setStore(store)
      handleMessage({ type: 'agent_idle', sessionId: 's1' }, ctx() as any)
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.streamingMessageId).toBeNull()
    })

    // Legacy/pre-bootstrap path: when the session isn't registered in
    // sessionStates yet, sendInput writes flat 'pending' and the dashboard UI
    // reads flat streamingMessageId directly. agent_idle must clear flat state
    // here too — without this, abnormal idle in legacy/PTY mode leaves the
    // stop button stuck. (Copilot review feedback on initial PR.)
    it('clears flat streamingMessageId when no sessionState is registered (legacy/pre-bootstrap)', () => {
      store = createMockStore(
        baseState({
          activeSessionId: null,
          sessions: [],
          sessionStates: {},
          streamingMessageId: 'pending',
          isIdle: false,
        } as any),
      )
      setStore(store)
      handleMessage({ type: 'agent_idle' }, ctx() as any)
      const state = store.getState() as any
      expect(state.streamingMessageId).toBeNull()
      expect(state.isIdle).toBe(true)
    })
  })

  describe('error dispatch — non-fatal severity routing (#4148)', () => {
    it('routes MAX_TOOL_ROUNDS_REACHED to severity=warning (yellow toast)', () => {
      const calls: Array<{ message: unknown; severity: unknown }> = []
      store = createMockStore(baseState())
      setStore(store)
      ;(store.getState() as any).addServerError = (
        message: unknown, _action: unknown, severity?: 'error' | 'warning',
      ) => {
        calls.push({ message, severity })
      }
      handleMessage(
        {
          type: 'error',
          code: 'MAX_TOOL_ROUNDS_REACHED',
          message: 'tool cap reached',
          fatal: false,
        } as any,
        ctx() as any,
      )
      expect(calls).toHaveLength(1)
      expect(calls[0]?.severity).toBe('warning')
    })

    it('routes any error with fatal: false to severity=warning, regardless of code', () => {
      const calls: Array<{ severity: unknown }> = []
      store = createMockStore(baseState())
      setStore(store)
      ;(store.getState() as any).addServerError = (
        _message: unknown, _action: unknown, severity?: 'error' | 'warning',
      ) => {
        calls.push({ severity })
      }
      handleMessage(
        {
          type: 'error',
          code: 'SOME_FUTURE_NON_FATAL_CODE',
          message: 'recoverable',
          fatal: false,
        } as any,
        ctx() as any,
      )
      expect(calls).toHaveLength(1)
      expect(calls[0]?.severity).toBe('warning')
    })

    it('routes STREAM_ERROR / ABORT and other unmarked codes to severity=error (red toast)', () => {
      const calls: Array<{ severity: unknown }> = []
      store = createMockStore(baseState())
      setStore(store)
      ;(store.getState() as any).addServerError = (
        _message: unknown, _action: unknown, severity?: 'error' | 'warning',
      ) => {
        calls.push({ severity })
      }
      handleMessage(
        { type: 'error', code: 'STREAM_ERROR', message: 'stream failed' } as any,
        ctx() as any,
      )
      handleMessage(
        { type: 'error', code: 'ABORT', message: 'aborted' } as any,
        ctx() as any,
      )
      expect(calls.map((c) => c.severity)).toEqual(['error', 'error'])
    })

    // #4193 — cross-layer regression guard for the typo-degrade contract.
    //
    // The parser-level test in store-core (`handlers.test.ts:776-795`) pins
    // that `handleError` returns `fatal: undefined` for a wire-side typo
    // like `fatal: 'false'` (string, not boolean). The dashboard's `case
    // 'error'` branch then evaluates `errFatal === false` which is false
    // for `undefined`, so the typo falls through to code-table
    // classification — `severity=error` (red toast), NOT the warning the
    // typo'd value tried to claim.
    //
    // The risk this test guards against: a future refactor splits the
    // strict-boolean check out of `handleError` (or relaxes it to
    // truthy/falsy), severs the parser → dispatch contract, and silently
    // downgrades a real error to a warning toast in the UI. The
    // parser-level test wouldn't notice because it only sees the parser
    // output; this one is the dispatch-level mirror.
    it('rejects fatal: "false" string (typo) and falls back to severity=error (#4178/#4193)', () => {
      const calls: Array<{ severity: unknown }> = []
      store = createMockStore(baseState())
      setStore(store)
      ;(store.getState() as any).addServerError = (
        _message: unknown, _action: unknown, severity?: 'error' | 'warning',
      ) => {
        calls.push({ severity })
      }
      handleMessage(
        {
          type: 'error',
          code: 'SOMETHING_UNKNOWN',
          message: 'oops',
          fatal: 'false', // typo: string not boolean — must not downgrade
        } as any,
        ctx() as any,
      )
      expect(calls).toHaveLength(1)
      expect(calls[0]?.severity).toBe('error')
    })

    // Companion case: `fatal: 1` (truthy non-boolean) is ALSO a typo and
    // must not be treated as `true` (which would just match the default
    // fatal path anyway) — the parser strict-boolean check should still
    // surface `fatal: undefined`, so dispatch lands on code-table
    // classification. Result is the same `severity=error` as above; this
    // pins that the strict-boolean check rejects non-boolean truthy
    // values too, not just non-boolean falsy ones.
    it('rejects fatal: 1 (non-boolean truthy) the same way as the string typo (#4193)', () => {
      const calls: Array<{ severity: unknown }> = []
      store = createMockStore(baseState())
      setStore(store)
      ;(store.getState() as any).addServerError = (
        _message: unknown, _action: unknown, severity?: 'error' | 'warning',
      ) => {
        calls.push({ severity })
      }
      handleMessage(
        {
          type: 'error',
          code: 'SOMETHING_UNKNOWN',
          message: 'oops',
          fatal: 1,
        } as any,
        ctx() as any,
      )
      expect(calls).toHaveLength(1)
      expect(calls[0]?.severity).toBe('error')
    })
  })

  describe('pairing_refreshed dispatch (#2916)', () => {
    it('increments pairingRefreshedCount when pairing_refreshed arrives', () => {
      store = createMockStore(baseState({ pairingRefreshedCount: 0 } as any))
      setStore(store)
      handleMessage({ type: 'pairing_refreshed' }, ctx() as any)
      expect((store.getState() as any).pairingRefreshedCount).toBe(1)
    })

    it('increments on each subsequent pairing_refreshed', () => {
      store = createMockStore(baseState({ pairingRefreshedCount: 3 } as any))
      setStore(store)
      handleMessage({ type: 'pairing_refreshed' }, ctx() as any)
      expect((store.getState() as any).pairingRefreshedCount).toBe(4)
    })
  })


  describe('byok_credentials_status dispatch (#4144 fileExists propagation)', () => {
    it('propagates the fileExists field to the store', () => {
      // Pre-fix the reducer hand-picked fields and silently dropped
      // fileExists, so the stale-file notice + Remove button were
      // both effectively dead in production. Pin the field flows
      // through the message-handler layer.
      handleMessage(
        {
          type: 'byok_credentials_status',
          status: 'set',
          source: 'env',
          masked: 'sk-ant-api03...[95 chars redacted]',
          fileExists: true,
        } as any,
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.byokCredentialsStatus).toEqual({
        status: 'set',
        source: 'env',
        masked: 'sk-ant-api03...[95 chars redacted]',
        reason: undefined,
        fileExists: true,
      })
    })

    it('preserves fileExists=false when the server omits or sets it explicitly false', () => {
      handleMessage(
        {
          type: 'byok_credentials_status',
          status: 'missing',
          source: 'none',
          reason: 'no key',
          fileExists: false,
        } as any,
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.byokCredentialsStatus.fileExists).toBe(false)
    })
  })

  describe('result — cost calculation for Codex/Gemini (cost: null from server)', () => {
    // #4206: the client-side cost fallback is now gated on the session's
    // provider matching CLIENT_ESTIMATED_COST_PROVIDERS. Tests must
    // therefore seed the SessionInfo with the right provider id —
    // otherwise the fallback no-ops and lastResultCost stays null.
    function seedWithModel(sessionId: string, model: string, provider: string) {
      store = createMockStore(
        baseState({
          sessions: [{ sessionId, name: 'S', model, provider } as any],
          sessionStates: { [sessionId]: createEmptySessionState() },
        }),
      )
      setStore(store)
    }

    it('computes lastResultCost client-side for a known Codex model when server sends cost: null', () => {
      seedWithModel('s-codex', 'gpt-4o', 'codex')
      handleMessage(
        {
          type: 'result',
          sessionId: 's-codex',
          cost: null,
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
        ctx() as any,
      )
      // gpt-4o: (1000/1000)*0.0025 + (500/1000)*0.01 = 0.0075
      const cost = (store.getState() as any).sessionStates['s-codex'].lastResultCost
      expect(cost).not.toBeNull()
      expect(cost).toBeCloseTo(0.0075, 6)
    })

    it('computes lastResultCost client-side for a known Gemini model when server sends cost: null', () => {
      seedWithModel('s-gemini', 'gemini-2.5-pro', 'gemini')
      handleMessage(
        {
          type: 'result',
          sessionId: 's-gemini',
          cost: null,
          usage: { input_tokens: 10000, output_tokens: 2000 },
        },
        ctx() as any,
      )
      // gemini-2.5-pro: (10000/1000)*0.00125 + (2000/1000)*0.01 = 0.0125 + 0.02 = 0.0325
      const cost = (store.getState() as any).sessionStates['s-gemini'].lastResultCost
      expect(cost).not.toBeNull()
      expect(cost).toBeCloseTo(0.0325, 6)
    })

    it('leaves lastResultCost null when model is unknown and server sends cost: null', () => {
      seedWithModel('s-unknown', 'some-unknown-model', 'codex')
      handleMessage(
        {
          type: 'result',
          sessionId: 's-unknown',
          cost: null,
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
        ctx() as any,
      )
      const cost = (store.getState() as any).sessionStates['s-unknown'].lastResultCost
      expect(cost).toBeNull()
    })

    it('uses server-provided cost when it is a number (Claude passthrough)', () => {
      seedWithModel('s-claude', 'claude-3-5-sonnet-20241022', 'claude-sdk')
      handleMessage(
        {
          type: 'result',
          sessionId: 's-claude',
          cost: 0.042,
          usage: { input_tokens: 5000, output_tokens: 1000 },
        },
        ctx() as any,
      )
      const cost = (store.getState() as any).sessionStates['s-claude'].lastResultCost
      expect(cost).toBe(0.042)
    })

    it('does NOT fall back to client-side pricing for providers NOT in CLIENT_ESTIMATED_COST_PROVIDERS', () => {
      // #4206: a server-priced provider (e.g. claude-byok) that
      // momentarily emits `cost: null` must NOT get a wrong client-side
      // estimate written into its session state. Pre-#4206 the
      // fallback fired purely on cost===null + usage, so any provider
      // could accidentally trigger it. Pin the gate here so a refactor
      // that drops the provider check has to fail this test.
      seedWithModel('s-byok', 'claude-3-5-sonnet-20241022', 'claude-byok')
      handleMessage(
        {
          type: 'result',
          sessionId: 's-byok',
          cost: null,
          usage: { input_tokens: 1000, output_tokens: 500 },
        },
        ctx() as any,
      )
      const cost = (store.getState() as any).sessionStates['s-byok'].lastResultCost
      expect(cost).toBeNull()
    })
  })

  describe('permission_request content rendering (#3122)', () => {
    it('renders just the tool name when description is missing', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's-perm',
          sessionStates: {
            's-perm': createEmptySessionState(),
          },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'permission_request',
          sessionId: 's-perm',
          requestId: 'perm-no-desc',
          tool: 'Bash',
          input: { command: 'ls' },
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates['s-perm'].messages
      const promptMsg = msgs.find((m: any) => m.type === 'prompt')
      expect(promptMsg).toBeDefined()
      expect(promptMsg.content).toBe('Bash')
      expect(promptMsg.content).not.toContain('undefined')
    })

    it('falls back to "Permission required" when both tool and description are missing', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's-perm',
          sessionStates: {
            's-perm': createEmptySessionState(),
          },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'permission_request',
          sessionId: 's-perm',
          requestId: 'perm-bare',
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates['s-perm'].messages
      const promptMsg = msgs.find((m: any) => m.type === 'prompt')
      expect(promptMsg).toBeDefined()
      expect(promptMsg.content).toBe('Permission required')
    })
  })

  // #3247 — direct unit coverage for the three skill message handlers.
  // The defensive normalization in handleSkillsList (#3209/#3205) is
  // forward-compat code: a future server adding fields shouldn't break
  // older dashboards. Without direct tests, a refactor could silently
  // drop the normalization and the next protocol bump breaks pre-existing
  // clients.
  describe('skill message handlers (#3247)', () => {
    function withSession(sessionId: string, overrides: Partial<ConnectionState> = {}) {
      const empty = createEmptySessionState()
      return baseState({
        activeSessionId: sessionId,
        sessionStates: { [sessionId]: empty },
        ...overrides,
      })
    }

    describe('skills_list', () => {
      it('stores normalized skills array on the active session', () => {
        store = createMockStore(withSession('s1'))
        setStore(store)
        handleMessage({
          type: 'skills_list',
          skills: [
            { name: 'review', description: 'Review PRs', source: 'global', activation: 'auto', active: true },
            { name: 'commit', source: 'repo', activation: 'manual', active: false },
          ],
        }, ctx() as any)

        const skills = (store.getState() as any).sessionStates.s1.skills
        expect(skills).toHaveLength(2)
        expect(skills[0]).toMatchObject({ name: 'review', source: 'global', activation: 'auto', active: true })
        expect(skills[1]).toMatchObject({ name: 'commit', source: 'repo', activation: 'manual', active: false })
      })

      it('routes to the explicit sessionId when provided (not just active)', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: { s1: empty, s2: empty },
        }))
        setStore(store)
        handleMessage({
          type: 'skills_list',
          sessionId: 's2',
          skills: [{ name: 'fmt' }],
        }, ctx() as any)

        const states = (store.getState() as any).sessionStates
        expect(states.s2.skills).toHaveLength(1)
        expect(states.s1.skills).toBeUndefined()
      })

      it('falls back to activeSessionId when sessionId is absent', () => {
        store = createMockStore(withSession('sFallback'))
        setStore(store)
        handleMessage({ type: 'skills_list', skills: [{ name: 'one' }] }, ctx() as any)

        const skills = (store.getState() as any).sessionStates.sFallback.skills
        expect(skills).toHaveLength(1)
        expect(skills[0].name).toBe('one')
      })

      it('ignores non-array skills payload (no throw, no mutation)', () => {
        store = createMockStore(withSession('s1'))
        setStore(store)
        expect(() =>
          handleMessage({ type: 'skills_list', skills: 'not-an-array' }, ctx() as any),
        ).not.toThrow()
        expect((store.getState() as any).sessionStates.s1.skills).toBeUndefined()
      })

      it('filters out entries with non-string name', () => {
        store = createMockStore(withSession('s1'))
        setStore(store)
        handleMessage({
          type: 'skills_list',
          skills: [
            { name: 'good' },
            { name: 42 },
            { name: null },
            {},
            { name: 'also-good' },
          ],
        }, ctx() as any)

        const skills = (store.getState() as any).sessionStates.s1.skills
        expect(skills.map((s: any) => s.name)).toEqual(['good', 'also-good'])
      })

      it('coerces unknown source / activation values to undefined', () => {
        store = createMockStore(withSession('s1'))
        setStore(store)
        handleMessage({
          type: 'skills_list',
          skills: [
            { name: 'a', source: 'something-new', activation: 'experimental', active: 'yes' },
          ],
        }, ctx() as any)

        const skill = (store.getState() as any).sessionStates.s1.skills[0]
        expect(skill.source).toBeUndefined()
        expect(skill.activation).toBeUndefined()
        // active normalised: only `boolean` types pass through
        expect(skill.active).toBeUndefined()
      })

      it('preserves audit metadata when present, drops non-string types', () => {
        store = createMockStore(withSession('s1'))
        setStore(store)
        handleMessage({
          type: 'skills_list',
          skills: [
            {
              name: 'auditable',
              version: '1.2.3',
              hashPrefix: 'deadbeef',
              firstSeen: '2026-01-01T00:00:00.000Z',
              lastVerified: '2026-05-03T00:00:00.000Z',
            },
            {
              name: 'malformed-meta',
              version: 42,
              hashPrefix: null,
              firstSeen: 12345,
              lastVerified: { iso: '2026-05-03' },
            },
          ],
        }, ctx() as any)

        const skills = (store.getState() as any).sessionStates.s1.skills
        expect(skills[0].version).toBe('1.2.3')
        expect(skills[0].hashPrefix).toBe('deadbeef')
        expect(skills[0].firstSeen).toBe('2026-01-01T00:00:00.000Z')
        expect(skills[0].lastVerified).toBe('2026-05-03T00:00:00.000Z')
        expect(skills[1].version).toBeUndefined()
        expect(skills[1].hashPrefix).toBeUndefined()
        expect(skills[1].firstSeen).toBeUndefined()
        expect(skills[1].lastVerified).toBeUndefined()
      })

      it('no-op when no active session and no sessionId on message', () => {
        store = createMockStore(baseState({ activeSessionId: null, sessionStates: {} }))
        setStore(store)
        expect(() =>
          handleMessage({ type: 'skills_list', skills: [{ name: 'a' }] }, ctx() as any),
        ).not.toThrow()
      })

      it('no-op when targetId resolves but no sessionStates entry exists', () => {
        store = createMockStore(baseState({
          activeSessionId: 'ghost',
          sessionStates: {},
        }))
        setStore(store)
        expect(() =>
          handleMessage({ type: 'skills_list', skills: [{ name: 'a' }] }, ctx() as any),
        ).not.toThrow()
      })
    })

    describe('skill_activated / skill_deactivated', () => {
      it('skill_activated flips active=true on the matching cached skill', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, skills: [{ name: 'x', activation: 'manual', active: false }] },
          },
        }))
        setStore(store)
        handleMessage({ type: 'skill_activated', skillName: 'x' }, ctx() as any)

        const skill = (store.getState() as any).sessionStates.s1.skills.find((s: any) => s.name === 'x')
        expect(skill.active).toBe(true)
      })

      it('skill_deactivated flips active=false on the matching cached skill', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, skills: [{ name: 'x', activation: 'manual', active: true }] },
          },
        }))
        setStore(store)
        handleMessage({ type: 'skill_deactivated', skillName: 'x' }, ctx() as any)

        const skill = (store.getState() as any).sessionStates.s1.skills.find((s: any) => s.name === 'x')
        expect(skill.active).toBe(false)
      })

      it('skill_activated leaves non-matching skills untouched', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, skills: [
              { name: 'x', activation: 'manual', active: false },
              { name: 'y', activation: 'manual', active: false },
            ] },
          },
        }))
        setStore(store)
        handleMessage({ type: 'skill_activated', skillName: 'x' }, ctx() as any)

        const skills = (store.getState() as any).sessionStates.s1.skills
        expect(skills.find((s: any) => s.name === 'x').active).toBe(true)
        expect(skills.find((s: any) => s.name === 'y').active).toBe(false)
      })

      // Lock in current behaviour when no skills are cached: the handler
      // calls `updateSession` with `(state.skills || []).map(...)`, which
      // writes an empty array (initialising the field from undefined).
      // Future contract: the next `list_skills` response is authoritative
      // and will overwrite this with the real skill set. The empty array
      // is a transient placeholder, not a final state.
      it('skill_activated initialises skills to [] when none were cached (next list_skills is authoritative)', () => {
        store = createMockStore(withSession('s1'))
        setStore(store)
        expect(() =>
          handleMessage({ type: 'skill_activated', skillName: 'x' }, ctx() as any),
        ).not.toThrow()
        // Sanity: starts undefined.
        // (createEmptySessionState doesn't set `skills`.)
        // After dispatch: empty array (no entries to flip; placeholder
        // until list_skills arrives).
        const skills = (store.getState() as any).sessionStates.s1.skills
        expect(skills).toEqual([])
      })

      it('skill_activated routes to explicit sessionId rather than active', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, skills: [{ name: 'x', activation: 'manual', active: false }] },
            s2: { ...empty, skills: [{ name: 'x', activation: 'manual', active: false }] },
          },
        }))
        setStore(store)
        handleMessage({ type: 'skill_activated', sessionId: 's2', skillName: 'x' }, ctx() as any)

        const states = (store.getState() as any).sessionStates
        expect(states.s1.skills[0].active).toBe(false)
        expect(states.s2.skills[0].active).toBe(true)
      })

      it('skill_activated no-ops when sessionId targets a session not in store', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, skills: [{ name: 'x', activation: 'manual', active: false }] },
          },
        }))
        setStore(store)
        expect(() =>
          handleMessage({ type: 'skill_activated', sessionId: 'ghost', skillName: 'x' }, ctx() as any),
        ).not.toThrow()
        // s1 untouched
        expect((store.getState() as any).sessionStates.s1.skills[0].active).toBe(false)
      })

      it('skill_activated ignores non-string skillName', () => {
        const empty = createEmptySessionState()
        const initial = [{ name: 'x', activation: 'manual' as const, active: false }]
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: { s1: { ...empty, skills: initial } },
        }))
        setStore(store)
        handleMessage({ type: 'skill_activated', skillName: 42 }, ctx() as any)
        handleMessage({ type: 'skill_activated', skillName: null }, ctx() as any)
        handleMessage({ type: 'skill_activated' }, ctx() as any)

        expect((store.getState() as any).sessionStates.s1.skills[0].active).toBe(false)
      })

      it('two sequential skill_activated broadcasts for different skills both apply', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, skills: [
              { name: 'a', activation: 'manual', active: false },
              { name: 'b', activation: 'manual', active: false },
            ] },
          },
        }))
        setStore(store)

        handleMessage({ type: 'skill_activated', skillName: 'a' }, ctx() as any)
        handleMessage({ type: 'skill_activated', skillName: 'b' }, ctx() as any)

        const skills = (store.getState() as any).sessionStates.s1.skills
        expect(skills.find((s: any) => s.name === 'a').active).toBe(true)
        expect(skills.find((s: any) => s.name === 'b').active).toBe(true)
      })
    })

    // #3235: operator re-trusted a skill after a content-hash mismatch.
    // The dashboard handler removes the skill name from the session's
    // `mismatchedSkillNames` array, clearing the SkillsPanel red-flag
    // indicator that #3205's `skill_changed` handler added.
    describe('skill_trust_accepted (#3235)', () => {
      it('removes the skill name from mismatchedSkillNames on the active session', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, mismatchedSkillNames: ['x', 'y'] },
          },
        }))
        setStore(store)
        handleMessage({ type: 'skill_trust_accepted', skillName: 'x' }, ctx() as any)

        const state = (store.getState() as any).sessionStates.s1
        expect(state.mismatchedSkillNames).toEqual(['y'])
      })

      it('routes to explicit sessionId rather than active', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, mismatchedSkillNames: ['x'] },
            s2: { ...empty, mismatchedSkillNames: ['x', 'y'] },
          },
        }))
        setStore(store)
        handleMessage({ type: 'skill_trust_accepted', sessionId: 's2', skillName: 'x' }, ctx() as any)

        const states = (store.getState() as any).sessionStates
        // s1 still has 'x' (broadcast was scoped to s2)
        expect(states.s1.mismatchedSkillNames).toEqual(['x'])
        // s2 has 'x' removed
        expect(states.s2.mismatchedSkillNames).toEqual(['y'])
      })

      it('no-ops when the skill name is not in mismatchedSkillNames (idempotent)', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, mismatchedSkillNames: ['y'] },
          },
        }))
        setStore(store)
        handleMessage({ type: 'skill_trust_accepted', skillName: 'x' }, ctx() as any)

        const state = (store.getState() as any).sessionStates.s1
        // Untouched — 'x' wasn't in the list, accepting it is a no-op.
        expect(state.mismatchedSkillNames).toEqual(['y'])
      })

      it('no-ops when sessionId targets a session not in store', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, mismatchedSkillNames: ['x'] },
          },
        }))
        setStore(store)
        expect(() =>
          handleMessage({ type: 'skill_trust_accepted', sessionId: 'ghost', skillName: 'x' }, ctx() as any),
        ).not.toThrow()
        // s1 untouched
        expect((store.getState() as any).sessionStates.s1.mismatchedSkillNames).toEqual(['x'])
      })

      it('ignores non-string skillName (no-op, no throw)', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, mismatchedSkillNames: ['x'] },
          },
        }))
        setStore(store)
        handleMessage({ type: 'skill_trust_accepted', skillName: 42 }, ctx() as any)
        handleMessage({ type: 'skill_trust_accepted', skillName: null }, ctx() as any)
        handleMessage({ type: 'skill_trust_accepted' }, ctx() as any)

        expect((store.getState() as any).sessionStates.s1.mismatchedSkillNames).toEqual(['x'])
      })

      it('handles missing mismatchedSkillNames field (does not throw)', () => {
        // Older sessions or fresh state where #3205 hasn't fired yet
        // won't have the array initialized. The handler should still
        // not throw.
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty },
          },
        }))
        setStore(store)
        expect(() =>
          handleMessage({ type: 'skill_trust_accepted', skillName: 'x' }, ctx() as any),
        ).not.toThrow()
      })
    })

    // #3298: community skill pending first-activation trust grant.
    // skill_trust_request adds to pendingCommunitySkills; idempotent.
    describe('skill_trust_request (#3298)', () => {
      it('adds entry to pendingCommunitySkills on active session', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: { s1: { ...empty } },
        }))
        setStore(store)
        handleMessage({ type: 'skill_trust_request', skillName: 'alice-skill', author: 'alice', sessionId: 's1' }, ctx() as any)

        const state = (store.getState() as any).sessionStates.s1
        expect(state.pendingCommunitySkills).toEqual([{ name: 'alice-skill', author: 'alice' }])
      })

      it('is idempotent — duplicate skill_trust_request does not double-add', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: { s1: { ...empty } },
        }))
        setStore(store)
        handleMessage({ type: 'skill_trust_request', skillName: 'alice-skill', author: 'alice', sessionId: 's1' }, ctx() as any)
        handleMessage({ type: 'skill_trust_request', skillName: 'alice-skill', author: 'alice', sessionId: 's1' }, ctx() as any)

        const state = (store.getState() as any).sessionStates.s1
        expect(state.pendingCommunitySkills).toHaveLength(1)
      })

      it('appends different entries (same author, different skill)', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: { s1: { ...empty } },
        }))
        setStore(store)
        handleMessage({ type: 'skill_trust_request', skillName: 'skill-a', author: 'alice', sessionId: 's1' }, ctx() as any)
        handleMessage({ type: 'skill_trust_request', skillName: 'skill-b', author: 'alice', sessionId: 's1' }, ctx() as any)

        const state = (store.getState() as any).sessionStates.s1
        expect(state.pendingCommunitySkills).toHaveLength(2)
      })

      it('ignores missing skillName or author (no-op, no throw)', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: { s1: { ...empty } },
        }))
        setStore(store)
        expect(() => handleMessage({ type: 'skill_trust_request', skillName: null, author: 'alice' }, ctx() as any)).not.toThrow()
        expect(() => handleMessage({ type: 'skill_trust_request', skillName: 'x', author: null }, ctx() as any)).not.toThrow()
        expect(() => handleMessage({ type: 'skill_trust_request' }, ctx() as any)).not.toThrow()

        const state = (store.getState() as any).sessionStates.s1
        expect(state.pendingCommunitySkills).toBeUndefined()
      })

      // #3310: description and path are now captured from the wire payload.
      it('captures description and path when present in the message', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: { s1: { ...empty } },
        }))
        setStore(store)
        handleMessage({
          type: 'skill_trust_request',
          skillName: 'alice-skill',
          author: 'alice',
          description: 'Does useful things',
          path: '/home/user/.chroxy/skills/community/alice/alice-skill.md',
          sessionId: 's1',
        }, ctx() as any)

        const state = (store.getState() as any).sessionStates.s1
        expect(state.pendingCommunitySkills).toEqual([{
          name: 'alice-skill',
          author: 'alice',
          description: 'Does useful things',
          path: '/home/user/.chroxy/skills/community/alice/alice-skill.md',
        }])
      })

      it('omits description / path from entry when absent in the message', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: { s1: { ...empty } },
        }))
        setStore(store)
        handleMessage({ type: 'skill_trust_request', skillName: 'alice-skill', author: 'alice', sessionId: 's1' }, ctx() as any)

        const state = (store.getState() as any).sessionStates.s1
        const entry = state.pendingCommunitySkills[0]
        expect(entry.description).toBeUndefined()
        expect(entry.path).toBeUndefined()
      })

      it('omits description / path when they are empty strings', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: { s1: { ...empty } },
        }))
        setStore(store)
        handleMessage({
          type: 'skill_trust_request',
          skillName: 'alice-skill',
          author: 'alice',
          description: '',
          path: '',
          sessionId: 's1',
        }, ctx() as any)

        const state = (store.getState() as any).sessionStates.s1
        const entry = state.pendingCommunitySkills[0]
        expect(entry.description).toBeUndefined()
        expect(entry.path).toBeUndefined()
      })
    })

    // #3298: community trust granted — remove from pendingCommunitySkills.
    describe('skill_trust_granted (#3298)', () => {
      it('removes matching entry from pendingCommunitySkills', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, pendingCommunitySkills: [
              { name: 'skill-a', author: 'alice' },
              { name: 'skill-b', author: 'alice' },
            ] },
          },
        }))
        setStore(store)
        handleMessage({ type: 'skill_trust_granted', skillName: 'skill-a', author: 'alice', sessionId: 's1' }, ctx() as any)

        const state = (store.getState() as any).sessionStates.s1
        expect(state.pendingCommunitySkills).toEqual([{ name: 'skill-b', author: 'alice' }])
      })

      it('is a no-op for unknown entries (does not throw)', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, pendingCommunitySkills: [{ name: 'skill-a', author: 'alice' }] },
          },
        }))
        setStore(store)
        expect(() =>
          handleMessage({ type: 'skill_trust_granted', skillName: 'nonexistent', author: 'alice', sessionId: 's1' }, ctx() as any),
        ).not.toThrow()

        const state = (store.getState() as any).sessionStates.s1
        expect(state.pendingCommunitySkills).toEqual([{ name: 'skill-a', author: 'alice' }])
      })

      it('ignores missing skillName or author (no-op, no throw)', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, pendingCommunitySkills: [{ name: 'skill-a', author: 'alice' }] },
          },
        }))
        setStore(store)
        expect(() => handleMessage({ type: 'skill_trust_granted', skillName: null, author: 'alice' }, ctx() as any)).not.toThrow()
        expect(() => handleMessage({ type: 'skill_trust_granted', skillName: 'skill-a', author: null }, ctx() as any)).not.toThrow()

        const state = (store.getState() as any).sessionStates.s1
        // List should be unchanged (no valid match)
        expect(state.pendingCommunitySkills).toEqual([{ name: 'skill-a', author: 'alice' }])
      })

      it('does not remove a same-name entry from a different author', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, pendingCommunitySkills: [
              { name: 'skill-x', author: 'alice' },
              { name: 'skill-x', author: 'bob' },
            ] },
          },
        }))
        setStore(store)
        handleMessage({ type: 'skill_trust_granted', skillName: 'skill-x', author: 'alice', sessionId: 's1' }, ctx() as any)

        const state = (store.getState() as any).sessionStates.s1
        expect(state.pendingCommunitySkills).toEqual([{ name: 'skill-x', author: 'bob' }])
      })
    })

    // #3298: skill_trust_grant_ok ack — leaves pendingCommunitySkills
    // untouched (that's cleared by the skill_trust_granted broadcast).
    // #3588: also clears the matching pendingTrustGrants entry so the
    // SkillsPanel in-flight state lifts.
    describe('skill_trust_grant_ok (#3298 / #3588)', () => {
      it('does not modify pendingCommunitySkills (cleared by skill_trust_granted broadcast)', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...empty, pendingCommunitySkills: [{ name: 'skill-a', author: 'alice' }] },
          },
        }))
        setStore(store)
        const stateBefore = (store.getState() as any).sessionStates.s1.pendingCommunitySkills

        expect(() =>
          handleMessage({ type: 'skill_trust_grant_ok', requestId: 'req-1', sessionId: 's1', skillName: 'skill-a', author: 'alice' }, ctx() as any),
        ).not.toThrow()

        const stateAfter = (store.getState() as any).sessionStates.s1.pendingCommunitySkills
        expect(stateAfter).toEqual(stateBefore)
      })

      // #3588: success ack clears the in-flight `pendingTrustGrants`
      // entry whose requestId matches.
      it('clears the matching pendingTrustGrants entry on success ack', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: {
              ...empty,
              pendingTrustGrants: [
                { requestId: 'req-1', skillName: 'skill-a', author: 'alice' },
                { requestId: 'req-2', skillName: 'skill-b', author: 'bob' },
              ],
            },
          },
        }))
        setStore(store)

        handleMessage(
          { type: 'skill_trust_grant_ok', requestId: 'req-1', sessionId: 's1' },
          ctx() as any,
        )

        const after = (store.getState() as any).sessionStates.s1.pendingTrustGrants
        expect(after).toEqual([
          { requestId: 'req-2', skillName: 'skill-b', author: 'bob' },
        ])
      })

      it('is idempotent when requestId is missing or unrecognised', () => {
        const empty = createEmptySessionState()
        const initial = [
          { requestId: 'req-1', skillName: 'skill-a', author: 'alice' },
        ]
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: { s1: { ...empty, pendingTrustGrants: initial } },
        }))
        setStore(store)

        // Missing requestId — no-op.
        handleMessage({ type: 'skill_trust_grant_ok', sessionId: 's1' }, ctx() as any)
        // Unrecognised requestId — no-op.
        handleMessage({ type: 'skill_trust_grant_ok', requestId: 'unknown', sessionId: 's1' }, ctx() as any)

        const after = (store.getState() as any).sessionStates.s1.pendingTrustGrants
        expect(after).toEqual(initial)
      })
    })

    // #3588: error envelope with a matching requestId clears the
    // in-flight pendingTrustGrants entry so the SkillsPanel row's
    // disabled state lifts on INVALID_AUTHOR / TRUST_NOT_ENABLED /
    // TRUST_FLUSH_FAILED responses.
    describe('skill_trust_grant error path (#3588)', () => {
      it('clears the matching pendingTrustGrants entry on error', () => {
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: {
              ...empty,
              pendingTrustGrants: [
                { requestId: 'req-1', skillName: 'skill-a', author: 'alice' },
              ],
            },
          },
        }))
        setStore(store)

        handleMessage(
          {
            type: 'error',
            requestId: 'req-1',
            code: 'INVALID_AUTHOR',
            message: 'Author mismatch',
            actualAuthor: 'bob',
          },
          ctx() as any,
        )

        const after = (store.getState() as any).sessionStates.s1.pendingTrustGrants
        expect(after).toEqual([])
      })

      it('clears the entry even when the error envelope lacks sessionId', () => {
        // Defensive: the server's error path may not always include
        // sessionId. The clear must still find the matching entry by
        // requestId across all session states.
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: {
              ...empty,
              pendingTrustGrants: [
                { requestId: 'req-7', skillName: 'skill-x', author: 'eve' },
              ],
            },
          },
        }))
        setStore(store)

        handleMessage(
          { type: 'error', requestId: 'req-7', code: 'TRUST_FLUSH_FAILED', message: 'flush failed' },
          ctx() as any,
        )

        const after = (store.getState() as any).sessionStates.s1.pendingTrustGrants
        expect(after).toEqual([])
      })

      it('leaves pendingTrustGrants untouched when no requestId matches', () => {
        const empty = createEmptySessionState()
        const initial = [
          { requestId: 'req-1', skillName: 'skill-a', author: 'alice' },
        ]
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: { s1: { ...empty, pendingTrustGrants: initial } },
        }))
        setStore(store)

        handleMessage(
          { type: 'error', requestId: 'something-else', code: 'OTHER', message: 'unrelated' },
          ctx() as any,
        )

        const after = (store.getState() as any).sessionStates.s1.pendingTrustGrants
        expect(after).toEqual(initial)
      })

      it('still records the toast (serverErrors) when clearing the in-flight entry', () => {
        // The pending-clear is in addition to the existing toast, not a
        // replacement — operators still get the error message.
        const empty = createEmptySessionState()
        store = createMockStore(baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: {
              ...empty,
              pendingTrustGrants: [
                { requestId: 'req-1', skillName: 'skill-a', author: 'alice' },
              ],
            },
          },
        }))
        setStore(store)

        handleMessage(
          { type: 'error', requestId: 'req-1', code: 'TRUST_NOT_ENABLED', message: 'trust disabled' },
          ctx() as any,
        )

        const after = store.getState() as any
        expect(after.sessionStates.s1.pendingTrustGrants).toEqual([])
        expect(after.serverErrors).toEqual(['trust disabled'])
      })
    })
  })

  // #3100 / #3068: evaluator round-trip resolves the matching pending entry
  // when the `evaluate_draft_result` arrives. Verify the wire-parsing path —
  // the InputBar component tests stub onEvaluate directly, so a regression
  // in the message-handler's parsing of error.status would slip through if
  // not covered here.
  describe('evaluate_draft_result dispatch', () => {
    it('resolves pending entry with the parsed payload (success/forward verdict)', async () => {
      const resolve = vi.fn()
      const reject = vi.fn()
      registerEvaluatorRequest('req-1', {
        resolve,
        reject,
        timeoutId: window.setTimeout(() => {}, 60_000) as unknown as number,
      })

      handleMessage({
        type: 'evaluate_draft_result',
        requestId: 'req-1',
        verdict: 'forward',
        rewritten: null,
        clarification: null,
        reasoning: 'looks fine',
      }, ctx() as any)

      expect(resolve).toHaveBeenCalledTimes(1)
      const payload = resolve.mock.calls[0]?.[0] as any
      expect(payload.verdict).toBe('forward')
      expect(payload.reasoning).toBe('looks fine')
      expect(payload.error).toBeUndefined()
      expect(reject).not.toHaveBeenCalled()
    })

    it('forwards error.status from the wire to the resolved payload', async () => {
      const resolve = vi.fn()
      const reject = vi.fn()
      registerEvaluatorRequest('req-2', {
        resolve,
        reject,
        timeoutId: window.setTimeout(() => {}, 60_000) as unknown as number,
      })

      handleMessage({
        type: 'evaluate_draft_result',
        requestId: 'req-2',
        error: { code: 'EVALUATOR_API_ERROR', message: 'Evaluator rate limited', status: 429 },
      }, ctx() as any)

      expect(resolve).toHaveBeenCalledTimes(1)
      const payload = resolve.mock.calls[0]?.[0] as any
      expect(payload.error).toEqual({
        code: 'EVALUATOR_API_ERROR',
        message: 'Evaluator rate limited',
        status: 429,
      })
    })

    it('leaves error.status undefined when the wire payload omits it', async () => {
      const resolve = vi.fn()
      registerEvaluatorRequest('req-3', {
        resolve,
        reject: vi.fn(),
        timeoutId: window.setTimeout(() => {}, 60_000) as unknown as number,
      })

      handleMessage({
        type: 'evaluate_draft_result',
        requestId: 'req-3',
        error: { code: 'EVALUATOR_NO_API_KEY', message: 'ANTHROPIC_API_KEY is not set' },
      }, ctx() as any)

      const payload = resolve.mock.calls[0]?.[0] as any
      expect(payload.error?.status).toBeUndefined()
      expect(payload.error?.code).toBe('EVALUATOR_NO_API_KEY')
    })

    it('drops late-arriving results with no matching pending entry (no throw)', () => {
      // Cancelled or already-timed-out requests should silently drop on the
      // floor — the resolver/reject pair is gone by the time the late result
      // arrives. Just ensure dispatch doesn't throw.
      expect(() => {
        handleMessage({
          type: 'evaluate_draft_result',
          requestId: 'req-gone',
          verdict: 'forward',
          reasoning: 'late',
        }, ctx() as any)
      }).not.toThrow()
    })

    it('drops results with no requestId (no throw, no pending lookup)', () => {
      const resolve = vi.fn()
      registerEvaluatorRequest('req-other', {
        resolve,
        reject: vi.fn(),
        timeoutId: window.setTimeout(() => {}, 60_000) as unknown as number,
      })

      handleMessage({
        type: 'evaluate_draft_result',
        requestId: null,
        verdict: 'forward',
        reasoning: 'no id',
      }, ctx() as any)

      expect(resolve).not.toHaveBeenCalled()
      cancelEvaluatorRequest('req-other')
    })
  })

  describe('unknown message types', () => {
    it('does not throw on unknown types', () => {
      expect(() =>
        handleMessage({ type: 'some_future_type', payload: 'x' }, ctx() as any),
      ).not.toThrow()
    })

    it('warns when server protocol version exceeds client', () => {
      store = createMockStore(baseState({ serverProtocolVersion: 9999 }))
      setStore(store)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      handleMessage({ type: 'brand_new_message' }, ctx() as any)
      expect(warn).toHaveBeenCalled()
      warn.mockRestore()
    })
  })

  // #3671: dashboard's sendClientVisible mirrors the mobile app pattern —
  // edge-triggered, memo-gated, encryption-pending guarded.
  describe('sendClientVisible (#3671)', () => {
    it('skips when socket is null or not OPEN', async () => {
      const { sendClientVisible, resetClientVisibleMemo } = await import('./message-handler')
      resetClientVisibleMemo()
      const closed = { send: vi.fn(), readyState: WebSocket.CLOSED } as unknown as WebSocket
      sendClientVisible(null, false)
      sendClientVisible(closed, false)
      expect((closed.send as any)).not.toHaveBeenCalled()
    })

    it('sends visible:false on first transition away from default true', async () => {
      const { sendClientVisible, resetClientVisibleMemo } = await import('./message-handler')
      resetClientVisibleMemo()
      const sock = createMockSocket()
      sendClientVisible(sock, false)
      const sent = JSON.parse((sock.send as any).mock.calls[0][0])
      expect(sent).toMatchObject({ type: 'client_visible', visible: false })
    })

    it('does not re-send when state matches the last value sent', async () => {
      const { sendClientVisible, resetClientVisibleMemo } = await import('./message-handler')
      resetClientVisibleMemo()
      const sock = createMockSocket()
      sendClientVisible(sock, false)
      sendClientVisible(sock, false)
      sendClientVisible(sock, false)
      expect((sock.send as any)).toHaveBeenCalledTimes(1)
    })

    it('emits both directions on a true→false→true cycle', async () => {
      const { sendClientVisible, resetClientVisibleMemo } = await import('./message-handler')
      resetClientVisibleMemo()
      const sock = createMockSocket()
      sendClientVisible(sock, false)
      sendClientVisible(sock, true)
      const calls = (sock.send as any).mock.calls.map((c: any[]) => JSON.parse(c[0]).visible)
      expect(calls).toEqual([false, true])
    })

    it('resetClientVisibleMemo allows the same state to be sent again', async () => {
      const { sendClientVisible, resetClientVisibleMemo } = await import('./message-handler')
      resetClientVisibleMemo()
      const sock = createMockSocket()
      sendClientVisible(sock, false)
      // After a fresh connect we expect the next call to fire even if the
      // desired state matches what we previously sent on the OLD socket.
      resetClientVisibleMemo()
      sendClientVisible(sock, false)
      expect((sock.send as any)).toHaveBeenCalledTimes(2)
    })

    // Copilot review of #3677: the encryption-handshake guard
    // `_pendingKeyPair !== null && _encryptionState === null` keeps the
    // dashboard from emitting plaintext client_visible mid key-exchange,
    // which the server would 1008-disconnect.
    it('skips when key-exchange handshake is in flight (#3677 review)', async () => {
      const { sendClientVisible, resetClientVisibleMemo, _testSetEncryptionHandshake } = await import('./message-handler') as any
      resetClientVisibleMemo()
      const sock = createMockSocket()

      // Open: pending keypair set, encryption not yet established.
      _testSetEncryptionHandshake({ pending: true, established: false })
      sendClientVisible(sock, false)
      expect((sock.send as any)).not.toHaveBeenCalled()

      // After key_exchange_ok: encryption established, pending cleared.
      _testSetEncryptionHandshake({ pending: false, established: true })
      sendClientVisible(sock, false)
      expect((sock.send as any)).toHaveBeenCalledTimes(1)

      // Reset the handshake state so subsequent tests in this file aren't
      // poisoned (encryption flag would force `wsSend` down the encrypt path).
      _testSetEncryptionHandshake({ pending: false, established: false })
    })
  })

  // #3899 — soft inactivity warning dispatch. Verifies the case stores the
  // warning on the right session and that the activity-bump branch wipes
  // it on the next activity event. Hard-cap kill path is exercised by the
  // server-side timeout tests (cli-session-timeout-pause / sdk-session).
  describe('inactivity_warning dispatch (#3899)', () => {
    it('stores idleMs + prefab on the targeted session', () => {
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: {
          s1: { ...createEmptySessionState() },
        },
      }))
      setStore(store)

      handleMessage(
        {
          type: 'inactivity_warning',
          sessionId: 's1',
          messageId: 'm-1',
          idleMs: 1_800_000,
          prefab: 'Status update?',
        },
        ctx() as any,
      )

      const warning = (store.getState() as any).sessionStates.s1.inactivityWarning
      expect(warning).not.toBeNull()
      expect(warning.idleMs).toBe(1_800_000)
      expect(warning.prefab).toBe('Status update?')
      expect(typeof warning.receivedAt).toBe('number')
    })

    it('drops the warning when the targeted session is unknown', () => {
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: { s1: { ...createEmptySessionState() } },
      }))
      setStore(store)

      handleMessage(
        {
          type: 'inactivity_warning',
          sessionId: 'unknown-sess',
          messageId: 'm-1',
          idleMs: 1_800_000,
          prefab: 'Status update?',
        },
        ctx() as any,
      )

      expect((store.getState() as any).sessionStates.s1.inactivityWarning).toBeNull()
    })

    it('ignores malformed payloads (idleMs <= 0)', () => {
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: { s1: { ...createEmptySessionState() } },
      }))
      setStore(store)

      handleMessage(
        {
          type: 'inactivity_warning',
          sessionId: 's1',
          messageId: 'm-1',
          idleMs: 0,
          prefab: 'Status update?',
        },
        ctx() as any,
      )

      expect((store.getState() as any).sessionStates.s1.inactivityWarning).toBeNull()
    })

    it('activity event clears an outstanding warning on the same session', () => {
      // Pre-seed a session that already has an inactivity warning.
      const seeded = {
        ...createEmptySessionState(),
        inactivityWarning: { idleMs: 1_800_000, prefab: 'Status update?', receivedAt: 100 },
      }
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: { s1: seeded },
      }))
      setStore(store)

      // result is an ACTIVITY_EVENT_TYPES member — dispatching it should
      // wipe the warning regardless of what the per-case handler does.
      handleMessage(
        { type: 'result', sessionId: 's1', usage: {}, cost: 0, duration: 0 },
        ctx() as any,
      )

      expect((store.getState() as any).sessionStates.s1.inactivityWarning).toBeNull()
    })
  })

  // #4466: switching tabs sends `switch_session`, which causes the server to
  // dispatch history_replay_start → all past events → history_replay_end.
  // Pre-fix, the dashboard's pre-handler logic ran the lastClientActivityAt
  // bump (#3758) and inactivityWarning dismiss (#3899) for EVERY replayed
  // event, plus the activeTools rebuild restarted the in-flight tool clock.
  // Visible symptoms: "Working… last activity Ns ago" reset to 1s, "Agent
  // quiet for Nm Ns" disappeared entirely, and the green "Running <tool> ·
  // Ns" pill restarted at 1s. The fix gates all three on the existing
  // `_receivingHistoryReplay` flag.
  describe('history replay must not reset activity timers (#4466)', () => {
    function seedSession(extra: Partial<ReturnType<typeof createEmptySessionState>> = {}) {
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessions: [{ sessionId: 's1', name: 'S1' } as any],
        sessionStates: { s1: { ...createEmptySessionState(), ...extra } },
      }))
      setStore(store)
    }

    it('does not bump lastClientActivityAt for replayed activity events', () => {
      seedSession({ lastClientActivityAt: 100 })
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      // tool_start is in ACTIVITY_EVENT_TYPES — pre-fix this bumped to Date.now().
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-1',
          tool: 'Bash',
          toolUseId: 'tu-1',
          input: { command: 'ls' },
          sessionId: 's1',
        },
        ctx() as any,
      )
      // The pre-seeded "stale" 100ms timestamp must survive — replay is NOT
      // fresh activity. Without this guard, every tab switch resets the
      // "last activity Ns ago" pill to "1s ago" no matter how long the
      // session has actually been idle.
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.lastClientActivityAt).toBe(100)
    })

    it('does not dismiss inactivityWarning for replayed activity events', () => {
      // "Agent quiet for 46m 32s · Status update?" chip is mid-display when
      // the user clicks back to this tab. Pre-fix, the first replayed
      // tool_start / message / result wiped it (because the activity-bump
      // path also clears inactivityWarning). User loses the chip and has
      // no idea anything is waiting on them.
      const warning = { idleMs: 2_792_000, prefab: 'Status update?', receivedAt: 200 }
      seedSession({ inactivityWarning: warning })
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      handleMessage(
        { type: 'result', sessionId: 's1', usage: {}, cost: 0, duration: 0 },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.inactivityWarning).toEqual(warning)
    })

    it('preserves activeTools across history_replay_start (no clock reset)', () => {
      // Pre-fix: history_replay_start cleared activeTools, then the replayed
      // tool_start rebuilt the entry with startedAt = Date.now(). The "Running
      // <tool> · Ns" pill restarted at 1s. Preserving the in-flight set
      // through the replay boundary keeps the elapsed clock intact — the
      // tool_result events that follow will still correctly drop resolved
      // entries.
      const startedAt = 100
      const inFlightTool = { toolUseId: 'tu-1', tool: 'Bash', input: { command: 'sleep 999' }, startedAt }
      seedSession({ activeTools: [inFlightTool] })
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.activeTools).toHaveLength(1)
      expect(ss.activeTools[0].toolUseId).toBe('tu-1')
      // Specifically the original startedAt must be preserved — that's what
      // drives the elapsed-time display.
      expect(ss.activeTools[0].startedAt).toBe(startedAt)
    })

    it('live activity AFTER history_replay_end still bumps lastClientActivityAt', () => {
      // Regression guard: the replay flag is cleared on history_replay_end,
      // so the next genuine live event must resume bumping the timestamp —
      // otherwise the gate would freeze activity tracking forever after the
      // first replay.
      seedSession({ lastClientActivityAt: 100 })
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      handleMessage({ type: 'history_replay_end', sessionId: 's1' }, ctx() as any)
      // Live activity event after replay closes — must bump.
      handleMessage(
        { type: 'tool_start', messageId: 't', tool: 'Bash', toolUseId: 'tu-2', sessionId: 's1' },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.lastClientActivityAt).toBeGreaterThan(100)
    })

    it('live activity AFTER history_replay_end still dismisses inactivityWarning', () => {
      const warning = { idleMs: 2_792_000, prefab: 'Status update?', receivedAt: 200 }
      seedSession({ inactivityWarning: warning })
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      handleMessage({ type: 'history_replay_end', sessionId: 's1' }, ctx() as any)
      handleMessage(
        { type: 'result', sessionId: 's1', usage: {}, cost: 0, duration: 0 },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.inactivityWarning).toBeNull()
    })

    // Regression for the agent-review critical finding (#4491): `result`
    // events are recorded in the per-session history ring buffer
    // (session-message-history.js) and replayed via PROXIED_EVENTS
    // (session-manager.js). The `case 'result'` handler also clears
    // activeTools — without a replay gate on THAT clear, every tab switch
    // on a session with at least one completed prior turn fires a replayed
    // result mid-replay, wiping the activeTools that history_replay_start
    // had intentionally preserved. Tested explicitly: a replayed result
    // must NOT touch activeTools, but a live result still must (#4308
    // turn-boundary sweep stays intact for the legitimate "missed
    // tool_result" case after a server crash / dropped broadcast).
    it('replayed result events do NOT clear activeTools (regression #4491)', () => {
      const startedAt = 100
      const inFlightTool = { toolUseId: 'tu-1', tool: 'Bash', input: { command: 'sleep' }, startedAt }
      seedSession({ activeTools: [inFlightTool] })
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      // result fires during the replay window — pre-fix this wiped activeTools.
      handleMessage(
        { type: 'result', sessionId: 's1', usage: {}, cost: 0, duration: 0 },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.activeTools).toHaveLength(1)
      expect(ss.activeTools[0].toolUseId).toBe('tu-1')
      expect(ss.activeTools[0].startedAt).toBe(startedAt)
    })

    it('live result events still clear activeTools (#4308 turn-boundary sweep preserved)', () => {
      // After history_replay_end clears the flag, a live result must still
      // sweep stale in-flight tools — that was the original #4308 behaviour
      // for missed tool_results from server crashes / dropped broadcasts.
      const inFlightTool = { toolUseId: 'tu-1', tool: 'Bash', input: { command: 'sleep' }, startedAt: 100 }
      seedSession({ activeTools: [inFlightTool] })
      handleMessage({ type: 'history_replay_start', sessionId: 's1' }, ctx() as any)
      handleMessage({ type: 'history_replay_end', sessionId: 's1' }, ctx() as any)
      handleMessage(
        { type: 'result', sessionId: 's1', usage: {}, cost: 0, duration: 0 },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.activeTools).toEqual([])
    })
  })
})
