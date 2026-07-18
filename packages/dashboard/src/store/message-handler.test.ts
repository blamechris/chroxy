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
  registerModelChangeRequest,
  clearPendingModelReverts,
  _testModelRevertPendingSize,
  registerPermissionModeChangeRequest,
  clearPendingPermissionModeReverts,
  _testPermissionModeRevertPendingSize,
  registerThinkingLevelChangeRequest,
  clearPendingThinkingLevelReverts,
  _testThinkingLevelRevertPendingSize,
  setDeltaFlushIntervalOverride,
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
  // #4878: capture info-level notifications (addInfoNotification) so the
  // session_stopped dispatch test can assert the toast text without
  // having to wire the full Zustand store.
  const infoNotifications: unknown[] = []
  const grantCalls: Array<{ skillName: string; author: string }> = []
  const terminalWrites: string[] = []
  const terminalSizeCalls: Array<{ sessionId: string; cols: number; rows: number }> = []
  // #4982 — capture every setSessionNotFoundError call (the SESSION_NOT_FOUND
  // branch of session_error wires through this setter; we assert on the
  // shape of the call).
  const sessionNotFoundCalls: unknown[] = []
  const updateServerCalls: Array<{ serverId: string; patch: unknown }> = []
  const removeServerCalls: string[] = []
  return {
    connectionPhase: 'connected',
    socket: null,
    sessions: [],
    activeSessionId: null,
    // #3855: generalized provider-credential state defaults so the
    // credentials_status / credential_test_result dispatch tests start from a
    // clean, well-typed baseline.
    credentialsStatus: null,
    credentialTestResults: {},
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
    addInfoNotification: (e: unknown) => {
      infoNotifications.push(e)
    },
    // #4982 — capture session-not-found chip state so the test suite can
    // assert the SESSION_NOT_FOUND branch of session_error wires through.
    // Tracked via a side-channel array since the mock store treats every
    // `set()` as a shallow merge; reading state.sessionNotFoundError
    // direct would catch only the LAST setter call, missing repeated
    // sets (rare but worth covering).
    setSessionNotFoundError: (err: unknown) => {
      sessionNotFoundCalls.push(err)
    },
    grantCommunitySkillTrust: (skillName: string, author: string) => {
      grantCalls.push({ skillName, author })
    },
    appendTerminalData: (d: string) => { terminalWrites.push(d) },
    setTerminalSize: (sessionId: string, cols: number, rows: number) => { terminalSizeCalls.push({ sessionId, cols, rows }) },
    // #5281 ③ PR 2 — server registry surface for the pairing auth_ok/pair_fail
    // paths. Captured so tests can assert token persistence + dead-entry cleanup.
    activeServerId: null,
    serverRegistry: [],
    updateServer: (serverId: string, patch: unknown) => { updateServerCalls.push({ serverId, patch }) },
    removeServer: (serverId: string) => { removeServerCalls.push(serverId) },
    _terminalWrites: terminalWrites,
    _terminalSizeCalls: terminalSizeCalls,
    _serverErrorActions: serverErrorActions,
    _infoNotifications: infoNotifications,
    _grantCalls: grantCalls,
    _sessionNotFoundCalls: sessionNotFoundCalls,
    _updateServerCalls: updateServerCalls,
    _removeServerCalls: removeServerCalls,
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

    it('#5281 ③ PR 2 — adopts a paired sessionToken and persists it on the active server', () => {
      store = createMockStore(baseState({ activeServerId: 'srv_paired' }))
      setStore(store)
      handleMessage(
        {
          type: 'auth_ok',
          serverMode: 'cli',
          serverVersion: '0.6.0',
          protocolVersion: 3,
          clientId: 'c1',
          connectedClients: [],
          sessionToken: 'sess-tok-xyz',
        },
        ctx() as any,
      )
      const state = store.getState() as any
      // Effective token = the issued session token (ctx.token was 'tok').
      expect(state.apiToken).toBe('sess-tok-xyz')
      expect(state.savedConnection.token).toBe('sess-tok-xyz')
      // …and written back to the registry entry for reconnects.
      expect(state._updateServerCalls).toEqual([{ serverId: 'srv_paired', patch: { token: 'sess-tok-xyz' } }])
    })

    it('does not touch the registry on a normal token auth (no sessionToken)', () => {
      store = createMockStore(baseState({ activeServerId: 'srv_x' }))
      setStore(store)
      handleMessage(
        { type: 'auth_ok', serverMode: 'cli', serverVersion: '0.6.0', protocolVersion: 3, clientId: 'c1', connectedClients: [] },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state._updateServerCalls).toEqual([])
      expect(state.apiToken).toBe('tok') // ctx.token unchanged
    })
  })

  describe('monthly_budget dispatch (#5665)', () => {
    it('stores the latest monthly credit-meter snapshot', () => {
      store = createMockStore(baseState({ monthlyBudget: null }))
      setStore(store)
      handleMessage(
        {
          type: 'monthly_budget',
          month: '2026-06',
          spentUsd: 23.45,
          turnsBilled: 12,
          budgetUsd: 100,
          warningPercent: 80,
          percent: 23.45,
          warning: false,
          exceeded: false,
          justWarned: false,
          justExceeded: false,
        },
        ctx() as any,
      )
      expect((store.getState() as any).monthlyBudget).toEqual({
        month: '2026-06',
        spentUsd: 23.45,
        turnsBilled: 12,
        budgetUsd: 100,
        warningPercent: 80,
        percent: 23.45,
        warning: false,
        exceeded: false,
      })
    })

    it('preserves a null cap / percent (no tier configured)', () => {
      store = createMockStore(baseState({ monthlyBudget: null }))
      setStore(store)
      handleMessage(
        {
          type: 'monthly_budget',
          month: '2026-06',
          spentUsd: 8.2,
          turnsBilled: 3,
          budgetUsd: null,
          warningPercent: 80,
          percent: null,
          warning: false,
          exceeded: false,
        },
        ctx() as any,
      )
      const mb = (store.getState() as any).monthlyBudget
      expect(mb.budgetUsd).toBeNull()
      expect(mb.percent).toBeNull()
      expect(mb.spentUsd).toBe(8.2)
    })

    it('ignores a malformed snapshot with no month', () => {
      store = createMockStore(baseState({ monthlyBudget: null }))
      setStore(store)
      handleMessage({ type: 'monthly_budget', spentUsd: 5 }, ctx() as any)
      expect((store.getState() as any).monthlyBudget).toBeNull()
    })

    it('fires a one-time info toast on a fresh warning crossing (justWarned)', () => {
      store = createMockStore(baseState({ monthlyBudget: null }))
      setStore(store)
      handleMessage(
        {
          type: 'monthly_budget',
          month: '2026-06',
          spentUsd: 85, turnsBilled: 7, budgetUsd: 100,
          warningPercent: 80, percent: 85, warning: true, exceeded: false,
          justWarned: true, justExceeded: false,
        },
        ctx() as any,
      )
      const infos = (store.getState() as any)._infoNotifications as string[]
      expect(infos.length).toBe(1)
      expect(infos[0]!).toContain('85%')
      expect(infos[0]!).toContain('$85.00 of $100.00')
    })

    it('fires the exceeded toast on justExceeded but not on a steady-state snapshot', () => {
      store = createMockStore(baseState({ monthlyBudget: null }))
      setStore(store)
      // Steady-state snapshot (no crossing) → no toast.
      handleMessage(
        {
          type: 'monthly_budget', month: '2026-06',
          spentUsd: 50, turnsBilled: 3, budgetUsd: 100,
          warningPercent: 80, percent: 50, warning: false, exceeded: false,
        },
        ctx() as any,
      )
      expect(((store.getState() as any)._infoNotifications as string[]).length).toBe(0)
      // Fresh exceeded crossing → toast.
      handleMessage(
        {
          type: 'monthly_budget', month: '2026-06',
          spentUsd: 105, turnsBilled: 8, budgetUsd: 100,
          warningPercent: 80, percent: 105, warning: true, exceeded: true,
          justWarned: false, justExceeded: true,
        },
        ctx() as any,
      )
      const infos = (store.getState() as any)._infoNotifications as string[]
      expect(infos.length).toBe(1)
      expect(infos[0]!.toLowerCase()).toContain('exceeded')
    })
  })

  describe('pair_fail dispatch (#5281 ③ PR 2)', () => {
    it('removes the optimistic tokenless entry and alerts', () => {
      store = createMockStore(baseState({
        activeServerId: 'srv_paired',
        serverRegistry: [{ id: 'srv_paired', name: 'P', wsUrl: 'ws://x/ws', token: '', lastConnectedAt: null }],
      }))
      setStore(store)
      handleMessage({ type: 'pair_fail', reason: 'expired' }, ctx() as any)
      const state = store.getState() as any
      expect(state.connectionPhase).toBe('disconnected')
      expect(state._removeServerCalls).toEqual(['srv_paired'])
    })

    it('keeps an entry that already has a token (not an optimistic pairing entry)', () => {
      store = createMockStore(baseState({
        activeServerId: 'srv_real',
        serverRegistry: [{ id: 'srv_real', name: 'R', wsUrl: 'ws://x/ws', token: 'keep', lastConnectedAt: null }],
      }))
      setStore(store)
      handleMessage({ type: 'pair_fail', reason: 'rate_limited' }, ctx() as any)
      expect((store.getState() as any)._removeServerCalls).toEqual([])
    })

    // #5513 — approval-gated redemption: a Discord-delivered link mints no
    // token; the server replies requires_approval. The dashboard falls into the
    // request-pair flow for the same host instead of dead-ending on an alert.
    it('records the host in pendingApprovalPairHost on requires_approval (#5513)', () => {
      store = createMockStore(baseState({
        activeServerId: 'srv_gated',
        serverRegistry: [{ id: 'srv_gated', name: 'GatedHost', wsUrl: 'wss://gated/ws', token: '', lastConnectedAt: null }],
      }))
      setStore(store)
      handleMessage({ type: 'pair_fail', reason: 'requires_approval' }, ctx() as any)
      const state = store.getState() as any
      expect(state.pendingApprovalPairHost).toEqual({ name: 'GatedHost', wsUrl: 'wss://gated/ws' })
      // The optimistic tokenless entry is still cleaned up.
      expect(state._removeServerCalls).toEqual(['srv_gated'])
    })

    it('does NOT set pendingApprovalPairHost for other pair_fail reasons (#5513)', () => {
      store = createMockStore(baseState({
        activeServerId: 'srv_gated',
        serverRegistry: [{ id: 'srv_gated', name: 'GatedHost', wsUrl: 'wss://gated/ws', token: '', lastConnectedAt: null }],
      }))
      setStore(store)
      handleMessage({ type: 'pair_fail', reason: 'expired' }, ctx() as any)
      expect((store.getState() as any).pendingApprovalPairHost).toBeUndefined()
    })
  })

  describe('terminal_output dispatch (#5835 PR2)', () => {
    it('appends terminal_output bytes for the active session to the terminal', () => {
      store = createMockStore(baseState({ activeSessionId: 'sess-1' }))
      setStore(store)
      handleMessage({ type: 'terminal_output', sessionId: 'sess-1', data: '\x1b[31mhi\x1b[0m' }, ctx() as any)
      expect((store.getState() as any)._terminalWrites).toEqual(['\x1b[31mhi\x1b[0m'])
    })

    it('ignores a terminal_output for a non-active session (stale post-switch frame)', () => {
      store = createMockStore(baseState({ activeSessionId: 'sess-1' }))
      setStore(store)
      handleMessage({ type: 'terminal_output', sessionId: 'other', data: 'nope' }, ctx() as any)
      expect((store.getState() as any)._terminalWrites).toEqual([])
    })

    it('ignores a terminal_output with non-string data', () => {
      store = createMockStore(baseState({ activeSessionId: 'sess-1' }))
      setStore(store)
      handleMessage({ type: 'terminal_output', sessionId: 'sess-1', data: 123 }, ctx() as any)
      expect((store.getState() as any)._terminalWrites).toEqual([])
    })

    it('ignores a terminal_output with a missing sessionId (no bleed into active terminal)', () => {
      store = createMockStore(baseState({ activeSessionId: 'sess-1' }))
      setStore(store)
      handleMessage({ type: 'terminal_output', data: 'orphan' }, ctx() as any)
      expect((store.getState() as any)._terminalWrites).toEqual([])
    })
  })

  describe('terminal_size dispatch (#5835 Phase 2)', () => {
    it('records the authoritative size for the active session', () => {
      store = createMockStore(baseState({ activeSessionId: 'sess-1' }))
      setStore(store)
      handleMessage({ type: 'terminal_size', sessionId: 'sess-1', cols: 160, rows: 48 }, ctx() as any)
      expect((store.getState() as any)._terminalSizeCalls).toEqual([{ sessionId: 'sess-1', cols: 160, rows: 48 }])
    })

    it('ignores terminal_size for a non-active session', () => {
      store = createMockStore(baseState({ activeSessionId: 'sess-1' }))
      setStore(store)
      handleMessage({ type: 'terminal_size', sessionId: 'other', cols: 100, rows: 40 }, ctx() as any)
      expect((store.getState() as any)._terminalSizeCalls).toEqual([])
    })

    it('ignores terminal_size with non-number / missing dimensions', () => {
      store = createMockStore(baseState({ activeSessionId: 'sess-1' }))
      setStore(store)
      handleMessage({ type: 'terminal_size', sessionId: 'sess-1', cols: '80', rows: 24 }, ctx() as any)
      handleMessage({ type: 'terminal_size', sessionId: 'sess-1', cols: 80 }, ctx() as any)
      expect((store.getState() as any)._terminalSizeCalls).toEqual([])
    })

    it('ignores terminal_size with a missing sessionId', () => {
      store = createMockStore(baseState({ activeSessionId: 'sess-1' }))
      setStore(store)
      handleMessage({ type: 'terminal_size', cols: 80, rows: 24 }, ctx() as any)
      expect((store.getState() as any)._terminalSizeCalls).toEqual([])
    })

    it('ignores terminal_size with non-positive dimensions', () => {
      store = createMockStore(baseState({ activeSessionId: 'sess-1' }))
      setStore(store)
      handleMessage({ type: 'terminal_size', sessionId: 'sess-1', cols: 0, rows: 24 }, ctx() as any)
      handleMessage({ type: 'terminal_size', sessionId: 'sess-1', cols: 80, rows: -1 }, ctx() as any)
      expect((store.getState() as any)._terminalSizeCalls).toEqual([])
    })

    it('ignores terminal_size with NaN / Infinity / non-integer dimensions', () => {
      store = createMockStore(baseState({ activeSessionId: 'sess-1' }))
      setStore(store)
      handleMessage({ type: 'terminal_size', sessionId: 'sess-1', cols: NaN, rows: 24 }, ctx() as any)
      handleMessage({ type: 'terminal_size', sessionId: 'sess-1', cols: Infinity, rows: 24 }, ctx() as any)
      handleMessage({ type: 'terminal_size', sessionId: 'sess-1', cols: 80.5, rows: 24 }, ctx() as any)
      expect((store.getState() as any)._terminalSizeCalls).toEqual([])
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

    // #5711 (Gap 2, client half): set_model is optimistic; a MODEL_NOT_APPLIED
    // rejection (e.g. a mid-turn no-op the server #5696 now reports) must roll
    // the dropdown back instead of leaving it on a model the session never
    // switched to.
    describe('MODEL_NOT_APPLIED revert (#5711)', () => {
      afterEach(() => { clearPendingModelReverts() })

      it('reverts the optimistic activeModel for the rejected request\'s session', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            activeModel: 'haiku', // optimistic value already applied by setModel
            sessionStates: { s1: { ...createEmptySessionState(), activeModel: 'haiku' } },
          }),
        )
        setStore(store)
        // setModel would have registered this before sending; previousModel is
        // what the session was on BEFORE the optimistic flip.
        registerModelChangeRequest('set-model-1', { sessionId: 's1', previousModel: 'sonnet' })

        handleMessage(
          { type: 'error', requestId: 'set-model-1', code: 'MODEL_NOT_APPLIED', message: 'mid-turn' },
          ctx() as any,
        )

        const state = store.getState() as any
        expect(state.sessionStates.s1.activeModel).toBe('sonnet') // rolled back
        // The flat top-level activeModel (what the dropdown renders for the
        // active session) is rolled back too.
        expect(state.activeModel).toBe('sonnet')
        expect(_testModelRevertPendingSize()).toBe(0) // consumed
      })

      it('reverts the SECOND of two rapid changes even after the first acks (per-request, not per-session)', () => {
        // A→B (req1) then B→C (req2) on s1, both in-flight. Server acks req1
        // (model_changed B) and rejects req2 (mid-turn). The revert must restore
        // B (req2's previousModel), not leave the dropdown on C — i.e. req1's
        // success must NOT drop req2's pending revert.
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            activeModel: 'C',
            sessionStates: { s1: { ...createEmptySessionState(), activeModel: 'C' } },
          }),
        )
        setStore(store)
        registerModelChangeRequest('req1', { sessionId: 's1', previousModel: 'A' })
        registerModelChangeRequest('req2', { sessionId: 's1', previousModel: 'B' })
        expect(_testModelRevertPendingSize()).toBe(2)

        // req1 succeeds first.
        handleMessage({ type: 'model_changed', sessionId: 's1', model: 'B' }, ctx() as any)
        // Discriminating assertion: success must NOT consume/clear either pending
        // revert (the clear-on-success regression). Without this, the test passes
        // either way — req2's revert target ('B') equals the success value ('B'),
        // so the final activeModel is 'B' whether or not the revert actually fired.
        expect(_testModelRevertPendingSize()).toBe(2)
        // req2 is then rejected.
        handleMessage(
          { type: 'error', requestId: 'req2', code: 'MODEL_NOT_APPLIED', message: 'mid-turn' },
          ctx() as any,
        )

        const state = store.getState() as any
        expect(state.sessionStates.s1.activeModel).toBe('B') // req2 rolled back to B, not stuck on C
        expect(_testModelRevertPendingSize()).toBe(1) // req2 consumed; req1 still pending
      })

      it('does NOT revert when the error requestId does not match a pending change', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessionStates: { s1: { ...createEmptySessionState(), activeModel: 'haiku' } },
          }),
        )
        setStore(store)
        registerModelChangeRequest('set-model-1', { sessionId: 's1', previousModel: 'sonnet' })

        handleMessage(
          { type: 'error', requestId: 'some-other-request', code: 'MODEL_NOT_APPLIED', message: 'x' },
          ctx() as any,
        )

        expect((store.getState() as any).sessionStates.s1.activeModel).toBe('haiku') // untouched
        expect(_testModelRevertPendingSize()).toBe(1) // still pending
      })

      it('clears all pending reverts on disconnect', () => {
        registerModelChangeRequest('req-a', { sessionId: 's1', previousModel: 'sonnet' })
        registerModelChangeRequest('req-b', { sessionId: 's2', previousModel: 'opus' })
        expect(_testModelRevertPendingSize()).toBe(2)
        clearPendingModelReverts()
        expect(_testModelRevertPendingSize()).toBe(0)
      })
    })

    // #5716 (sibling of #5711): set_permission_mode is optimistic too; a
    // PERMISSION_MODE_NOT_APPLIED rejection (mid-turn change or same-mode no-op)
    // must roll the dropdown back — the dangerous case being a phantom switch to
    // 'auto'/bypass the session never actually entered.
    describe('PERMISSION_MODE_NOT_APPLIED revert (#5716)', () => {
      afterEach(() => { clearPendingPermissionModeReverts() })

      it('reverts the optimistic permissionMode for the rejected request\'s session', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            permissionMode: 'auto', // optimistic value already applied by setPermissionMode
            sessionStates: { s1: { ...createEmptySessionState(), permissionMode: 'auto' } },
          }),
        )
        setStore(store)
        registerPermissionModeChangeRequest('set-perm-1', { sessionId: 's1', previousMode: 'approve' })

        handleMessage(
          { type: 'error', requestId: 'set-perm-1', code: 'PERMISSION_MODE_NOT_APPLIED', message: 'session busy' },
          ctx() as any,
        )

        const state = store.getState() as any
        expect(state.sessionStates.s1.permissionMode).toBe('approve') // rolled back from phantom bypass
        expect(state.permissionMode).toBe('approve') // flat top-level reverted too
        expect(_testPermissionModeRevertPendingSize()).toBe(0) // consumed
      })

      // #5722 review (Copilot): setPermissionMode also overwrites
      // previousPermissionMode (the Shift+Tab toggle target). A rejected change
      // must restore THAT too, else the toggle silently becomes a no-op
      // (previous == current). Compare-and-swap so a later success isn't clobbered.
      it('also restores previousPermissionMode (the Shift+Tab toggle target) on revert', () => {
        // Session was on 'plan' with the toggle pointing back at 'approve'. The user
        // switches plan→auto; setPermissionMode optimistically sets permissionMode
        // 'auto' AND previousPermissionMode 'plan'. The server then rejects it.
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            permissionMode: 'auto', // optimistic value
            previousPermissionMode: 'plan', // optimistic toggle target (was 'approve' before)
            sessionStates: { s1: { ...createEmptySessionState(), permissionMode: 'auto' } },
          }),
        )
        setStore(store)
        registerPermissionModeChangeRequest('set-perm-1', {
          sessionId: 's1',
          previousMode: 'plan', // restore permissionMode → plan
          priorPreviousMode: 'approve', // restore the toggle target → approve
        })

        handleMessage(
          { type: 'error', requestId: 'set-perm-1', code: 'PERMISSION_MODE_NOT_APPLIED', message: 'mid-turn' },
          ctx() as any,
        )

        const state = store.getState() as any
        expect(state.sessionStates.s1.permissionMode).toBe('plan') // mode rolled back
        expect(state.previousPermissionMode).toBe('approve') // toggle target rolled back too
      })

      it('does NOT clobber previousPermissionMode if a later change already moved it (compare-and-swap)', () => {
        // Same rejected req (previousMode 'plan'), but by the time the error lands a
        // newer successful change has set previousPermissionMode to 'acceptEdits'.
        // The CAS must leave that newer value intact (current !== revert.previousMode).
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            permissionMode: 'auto',
            previousPermissionMode: 'acceptEdits', // a later change moved it
            sessionStates: { s1: { ...createEmptySessionState(), permissionMode: 'auto' } },
          }),
        )
        setStore(store)
        registerPermissionModeChangeRequest('set-perm-1', {
          sessionId: 's1',
          previousMode: 'plan',
          priorPreviousMode: 'approve',
        })

        handleMessage(
          { type: 'error', requestId: 'set-perm-1', code: 'PERMISSION_MODE_NOT_APPLIED', message: 'mid-turn' },
          ctx() as any,
        )

        const state = store.getState() as any
        expect(state.previousPermissionMode).toBe('acceptEdits') // newer value preserved, not clobbered
      })

      it('reverts the SECOND of two rapid changes even after the first acks (per-request, not per-session)', () => {
        // approve→plan (req1) then plan→auto (req2) on s1, both in-flight. Server
        // acks req1 (permission_mode_changed plan) and rejects req2 (mid-turn). The
        // revert must restore 'plan' (req2's previousMode), not leave a phantom auto.
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            permissionMode: 'auto',
            sessionStates: { s1: { ...createEmptySessionState(), permissionMode: 'auto' } },
          }),
        )
        setStore(store)
        registerPermissionModeChangeRequest('req1', { sessionId: 's1', previousMode: 'approve' })
        registerPermissionModeChangeRequest('req2', { sessionId: 's1', previousMode: 'plan' })
        expect(_testPermissionModeRevertPendingSize()).toBe(2)

        handleMessage({ type: 'permission_mode_changed', sessionId: 's1', mode: 'plan' }, ctx() as any)
        // Discriminating assertion: the success broadcast must NOT consume/clear
        // either pending revert (the #5715 clear-on-success regression). The final
        // permissionMode check alone can't catch that here — req2's revert target
        // ('plan') equals the success value ('plan'), so the state is 'plan'
        // whether or not the revert fired.
        expect(_testPermissionModeRevertPendingSize()).toBe(2)
        handleMessage(
          { type: 'error', requestId: 'req2', code: 'PERMISSION_MODE_NOT_APPLIED', message: 'mid-turn' },
          ctx() as any,
        )

        const state = store.getState() as any
        expect(state.sessionStates.s1.permissionMode).toBe('plan') // req2 rolled back to plan, not stuck on auto
        expect(_testPermissionModeRevertPendingSize()).toBe(1) // req2 consumed; req1 still pending
      })

      it('does NOT revert when the error requestId does not match a pending change', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessionStates: { s1: { ...createEmptySessionState(), permissionMode: 'auto' } },
          }),
        )
        setStore(store)
        registerPermissionModeChangeRequest('set-perm-1', { sessionId: 's1', previousMode: 'approve' })

        handleMessage(
          { type: 'error', requestId: 'some-other-request', code: 'PERMISSION_MODE_NOT_APPLIED', message: 'x' },
          ctx() as any,
        )

        expect((store.getState() as any).sessionStates.s1.permissionMode).toBe('auto') // untouched
        expect(_testPermissionModeRevertPendingSize()).toBe(1) // still pending
      })

      it('clears all pending reverts on disconnect', () => {
        registerPermissionModeChangeRequest('req-a', { sessionId: 's1', previousMode: 'approve' })
        registerPermissionModeChangeRequest('req-b', { sessionId: 's2', previousMode: 'plan' })
        expect(_testPermissionModeRevertPendingSize()).toBe(2)
        clearPendingPermissionModeReverts()
        expect(_testPermissionModeRevertPendingSize()).toBe(0)
      })
    })

    // #5731 T9 (sibling of #5711/#5716): set_thinking_level is optimistic too; a
    // THINKING_LEVEL_NOT_APPLIED rejection (invalid level, provider without
    // thinking-level control, or a setThinkingLevel throw) must roll the dropdown
    // back instead of leaving it on a level the session never entered.
    describe('THINKING_LEVEL_NOT_APPLIED revert (#5731 T9)', () => {
      afterEach(() => { clearPendingThinkingLevelReverts() })

      it('reverts the optimistic thinkingLevel for the rejected request\'s session', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessionStates: { s1: { ...createEmptySessionState(), thinkingLevel: 'high' } }, // optimistic value
          }),
        )
        setStore(store)
        registerThinkingLevelChangeRequest('set-thinking-1', { sessionId: 's1', previousLevel: 'default' })

        handleMessage(
          { type: 'error', requestId: 'set-thinking-1', code: 'THINKING_LEVEL_NOT_APPLIED', message: 'provider does not support thinking level control' },
          ctx() as any,
        )

        expect((store.getState() as any).sessionStates.s1.thinkingLevel).toBe('default') // rolled back
        expect(_testThinkingLevelRevertPendingSize()).toBe(0) // consumed
      })

      it('does NOT revert when the error requestId does not match a pending change', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessionStates: { s1: { ...createEmptySessionState(), thinkingLevel: 'max' } },
          }),
        )
        setStore(store)
        registerThinkingLevelChangeRequest('set-thinking-1', { sessionId: 's1', previousLevel: 'default' })

        handleMessage(
          { type: 'error', requestId: 'other', code: 'THINKING_LEVEL_NOT_APPLIED', message: 'x' },
          ctx() as any,
        )

        expect((store.getState() as any).sessionStates.s1.thinkingLevel).toBe('max') // untouched
        expect(_testThinkingLevelRevertPendingSize()).toBe(1) // still pending
      })

      it('clears all pending reverts on disconnect', () => {
        registerThinkingLevelChangeRequest('req-a', { sessionId: 's1', previousLevel: 'default' })
        registerThinkingLevelChangeRequest('req-b', { sessionId: 's2', previousLevel: 'high' })
        expect(_testThinkingLevelRevertPendingSize()).toBe(2)
        clearPendingThinkingLevelReverts()
        expect(_testThinkingLevelRevertPendingSize()).toBe(0)
      })
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

    // #5281 ①.3 — input_conflict is an expected shared-session event, not a
    // failure. It must NOT raise the red serverError / modal alert the generic
    // branch uses, and must clean up the optimistic send the server refused.
    it('routes input_conflict to a calm notice and removes the stranded optimistic send', () => {
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: {
          s1: {
            ...createEmptySessionState(),
            messages: [
              { id: 'older', type: 'user_input', content: 'earlier', timestamp: 0 },
              { id: 'user-123', type: 'user_input', content: 'hi', timestamp: 1 },
              { id: 'thinking', type: 'thinking', content: '', timestamp: 2 },
            ],
            streamingMessageId: 'pending',
          },
        },
      }))
      setStore(store)

      const reason = 'Session is already processing input from another device. Wait for it to finish or interrupt first.';
      handleMessage(
        {
          type: 'session_error',
          category: 'input_conflict',
          sessionId: 's1',
          clientMessageId: 'user-123',
          message: reason,
        },
        ctx() as any,
      )

      const state = store.getState() as any
      // Calm info notice (the server's specific reason), not a red error.
      expect(state.serverErrors).toEqual([])
      expect(state._infoNotifications).toEqual([reason])
      // The stranded optimistic user message + thinking spinner are gone…
      const ss = state.sessionStates.s1
      expect(ss.messages.find((m: any) => m.id === 'user-123')).toBeUndefined()
      expect(ss.messages.find((m: any) => m.type === 'thinking')).toBeUndefined()
      expect(ss.streamingMessageId).toBeNull()
      // …but only the rejected send — prior real messages are untouched.
      expect(ss.messages.find((m: any) => m.id === 'older')).toBeDefined()
    })

    it('cleans up root-level (CLI single-session) store mode too', () => {
      // No active session / no sessionStates entry — addUserMessage put the
      // optimistic send on the top-level messages/streamingMessageId.
      store = createMockStore(baseState({
        activeSessionId: null,
        sessionStates: {},
        messages: [
          { id: 'user-7', type: 'user_input', content: 'hi', timestamp: 1 },
          { id: 'thinking', type: 'thinking', content: '', timestamp: 2 },
        ],
        streamingMessageId: 'pending',
      }))
      setStore(store)

      handleMessage(
        { type: 'session_error', category: 'input_conflict', clientMessageId: 'user-7', message: 'busy' },
        ctx() as any,
      )

      const state = store.getState() as any
      expect(state.messages.find((m: any) => m.id === 'user-7')).toBeUndefined()
      expect(state.messages.find((m: any) => m.type === 'thinking')).toBeUndefined()
      expect(state.streamingMessageId).toBeNull()
      expect(state.serverErrors).toEqual([])
    })

    it('only drops the rejected user_input, never a colliding message of another type', () => {
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: {
          s1: {
            ...createEmptySessionState(),
            messages: [
              // A non-user_input message that happens to share the rejected id.
              { id: 'dup', type: 'tool_use', content: 'ls', timestamp: 1 },
              { id: 'thinking', type: 'thinking', content: '', timestamp: 2 },
            ],
            streamingMessageId: 'pending',
          },
        },
      }))
      setStore(store)

      handleMessage(
        { type: 'session_error', category: 'input_conflict', sessionId: 's1', clientMessageId: 'dup', message: 'busy' },
        ctx() as any,
      )

      const ss = (store.getState() as any).sessionStates.s1
      // The tool_use at the colliding id survives; only the spinner cleared.
      expect(ss.messages.find((m: any) => m.id === 'dup' && m.type === 'tool_use')).toBeDefined()
      expect(ss.messages.find((m: any) => m.type === 'thinking')).toBeUndefined()
      expect(ss.streamingMessageId).toBeNull()
    })

    it('shows the evaluator-lock reason verbatim (not the cross-device copy)', () => {
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
      }))
      setStore(store)

      const evalReason = 'Session is already evaluating a previous draft. Wait for it to finish or interrupt first.';
      handleMessage(
        { type: 'session_error', category: 'input_conflict', sessionId: 's1', message: evalReason },
        ctx() as any,
      )

      expect((store.getState() as any)._infoNotifications).toEqual([evalReason])
      expect((store.getState() as any).serverErrors).toEqual([])
    })

    it('input_conflict still clears the spinner when the server omits clientMessageId', () => {
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: {
          s1: {
            ...createEmptySessionState(),
            messages: [
              { id: 'user-9', type: 'user_input', content: 'hi', timestamp: 1 },
              { id: 'thinking', type: 'thinking', content: '', timestamp: 2 },
            ],
            streamingMessageId: 'pending',
          },
        },
      }))
      setStore(store)

      handleMessage(
        { type: 'session_error', category: 'input_conflict', sessionId: 's1', message: 'busy' },
        ctx() as any,
      )

      const ss = (store.getState() as any).sessionStates.s1
      // Without the echoed id the ghost message can't be removed, but the
      // spinner must still clear (no perpetual "thinking").
      expect(ss.messages.find((m: any) => m.type === 'thinking')).toBeUndefined()
      expect(ss.streamingMessageId).toBeNull()
      expect((store.getState() as any).serverErrors).toEqual([])
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

    // #4982 — SESSION_NOT_FOUND surface. Server emits this when the
    // dashboard's persisted activeSessionId points at a pre-restart id
    // (regenerated by session-manager.restoreState()). Without the
    // dashboard clearing the stale id, every retry hits the same dead
    // session and the operator is wedged into the #4935 loop.
    describe('SESSION_NOT_FOUND branch (#4982)', () => {
      it('clears the stale activeSessionId so the next send doesn\'t loop', () => {
        store = createMockStore(baseState({ activeSessionId: 'stale-id-pre-restart' }))
        setStore(store)
        handleMessage(
          {
            type: 'session_error',
            code: 'SESSION_NOT_FOUND',
            message: 'Session not found: stale-id-pre-restart',
            attemptedSessionId: 'stale-id-pre-restart',
          },
          ctx() as any,
        )
        const state = store.getState() as any
        expect(state.activeSessionId).toBeNull()
      })

      it('forwards attemptedSessionId + message to setSessionNotFoundError so the chip renders', () => {
        handleMessage(
          {
            type: 'session_error',
            code: 'SESSION_NOT_FOUND',
            message: 'Session not found: stale-id',
            attemptedSessionId: 'stale-id',
          },
          ctx() as any,
        )
        const state = store.getState() as any
        expect(state._sessionNotFoundCalls).toHaveLength(1)
        expect(state._sessionNotFoundCalls[0]).toEqual({
          attemptedSessionId: 'stale-id',
          message: 'Session not found: stale-id',
        })
      })

      it('still surfaces the message via addServerError so the toast fires once', () => {
        handleMessage(
          {
            type: 'session_error',
            code: 'SESSION_NOT_FOUND',
            message: 'Session not found: stale-id',
          },
          ctx() as any,
        )
        const state = store.getState() as any
        expect(state.serverErrors).toEqual(['Session not found: stale-id'])
      })

      it('passes attemptedSessionId=null when the server omits the field (pre-#4979 fallback)', () => {
        handleMessage(
          {
            type: 'session_error',
            code: 'SESSION_NOT_FOUND',
            message: 'Session not found',
            // No attemptedSessionId — older server or non-standard envelope
          },
          ctx() as any,
        )
        const state = store.getState() as any
        expect(state._sessionNotFoundCalls).toHaveLength(1)
        expect(state._sessionNotFoundCalls[0]).toMatchObject({
          attemptedSessionId: null,
          message: 'Session not found',
        })
      })

      it('does NOT clear activeSessionId for SESSION_TOKEN_MISMATCH (different code, different recovery)', () => {
        store = createMockStore(baseState({ activeSessionId: 'live-id' }))
        setStore(store)
        handleMessage(
          {
            type: 'session_error',
            code: 'SESSION_TOKEN_MISMATCH',
            message: 'Not authorized',
            boundSessionName: 'Other',
          },
          ctx() as any,
        )
        const state = store.getState() as any
        expect(state.activeSessionId).toBe('live-id')
        expect(state._sessionNotFoundCalls).toHaveLength(0)
      })
    })
  })

  // #5589 / #5281 — explicit primary-ownership. The server names the primary
  // (`primaryClientId`); the dashboard derives THIS client's role by comparing
  // it to its own id (`myClientId`) and stores both per-session.
  describe('session_role dispatch (#5589 / #5281)', () => {
    it('derives observer when another device holds primary', () => {
      store = createMockStore(baseState({
        myClientId: 'me',
        activeSessionId: 's1',
        sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
      }))
      setStore(store)
      handleMessage(
        { type: 'session_role', sessionId: 's1', primaryClientId: 'other' },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.sessionRole).toBe('observer')
      expect(ss.primaryClientId).toBe('other')
    })

    it('derives primary when this device holds primary', () => {
      store = createMockStore(baseState({
        myClientId: 'me',
        activeSessionId: 's1',
        sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
      }))
      setStore(store)
      handleMessage(
        { type: 'session_role', sessionId: 's1', primaryClientId: 'me' },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.sessionRole).toBe('primary')
      expect(ss.primaryClientId).toBe('me')
    })

    it('derives unclaimed when the slot is vacated (nobody-until-claim)', () => {
      store = createMockStore(baseState({
        myClientId: 'me',
        activeSessionId: 's1',
        sessionStates: {
          s1: { ...createEmptySessionState(), messages: [], sessionRole: 'observer', primaryClientId: 'other' },
        },
      }))
      setStore(store)
      handleMessage(
        { type: 'session_role', sessionId: 's1', primaryClientId: null },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.sessionRole).toBe('unclaimed')
      expect(ss.primaryClientId).toBeNull()
    })

    it('ignores a session_role for a session not in the local store', () => {
      store = createMockStore(baseState({ myClientId: 'me', sessionStates: {} }))
      setStore(store)
      handleMessage(
        { type: 'session_role', sessionId: 'ghost', primaryClientId: 'other' },
        ctx() as any,
      )
      expect((store.getState() as any).sessionStates.ghost).toBeUndefined()
    })
  })

  // #5589 / #5281 — a `claim_primary` rejection (PRIMARY_HELD) arrives as a
  // `session_error` of category input_conflict, so it rides the same calm
  // notice path as a busy-session conflict (no red alert).
  describe('PRIMARY_HELD claim rejection (#5589)', () => {
    it('surfaces the rejection as a calm info notice, not a red error', () => {
      store = createMockStore(baseState({
        myClientId: 'me',
        activeSessionId: 's1',
        sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
      }))
      setStore(store)
      const reason = 'Another device is the primary for this session. Request a hand-off or wait for it to release.'
      handleMessage(
        {
          type: 'session_error',
          category: 'input_conflict',
          sessionId: 's1',
          code: 'PRIMARY_HELD',
          primaryClientId: 'other',
          message: reason,
        },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.serverErrors).toEqual([])
      expect(state._infoNotifications).toEqual([reason])
    })
  })

  // #4878 — user-initiated Stop confirmation. The wire path was wired by
  // PR #4868; this is the dashboard UX follow-up. Renders a quiet info
  // toast (NOT the red `addServerError` reserved for crashes), so the
  // operator gets a positive "you clicked Stop and the session did indeed
  // stop" confirmation. Pairs with `session_error` which fires for
  // unexpected exits / auto-respawn.
  describe('session_stopped dispatch (#4878)', () => {
    it('renders a quiet info-level toast on clean exit (code 0)', () => {
      handleMessage(
        { type: 'session_stopped', sessionId: 'sess-1', code: 0 },
        ctx() as any,
      )
      const state = store.getState() as any
      // Info notification, not a server error — the red-toast surface is
      // reserved for genuine error conditions (STREAM_ERROR / ABORT / crash).
      expect(state._infoNotifications).toEqual(['Session stopped.'])
      expect(state.serverErrors).toEqual([])
    })

    it('omits the exit-code suffix when code is missing (future in-process providers)', () => {
      // Per the #4756 follow-up, providers that don't have a child process
      // (e.g. in-process SDK session) may emit session_stopped without a
      // numeric exit code. The bare "Session stopped." carries the signal.
      handleMessage(
        { type: 'session_stopped', sessionId: 'sess-1' },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state._infoNotifications).toEqual(['Session stopped.'])
    })

    it('surfaces a non-zero exit code as a diagnostic suffix (e.g. SIGTERM → 143)', () => {
      handleMessage(
        { type: 'session_stopped', sessionId: 'sess-1', code: 143 },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state._infoNotifications).toEqual(['Session stopped. (exit 143)'])
      // Still NOT a server error — a non-zero exit code from a
      // user-initiated Stop (SIGTERM = 143) is not a crash. The crash
      // path stays on session_error.
      expect(state.serverErrors).toEqual([])
    })

    it('handles legacy-cli broadcasts (sessionId omitted) the same way', () => {
      // ws-forwarding's legacy-cli path forwards session_stopped without
      // a sessionId field (matches the claude_ready / error pattern).
      // The dashboard toast doesn't depend on sessionId — it's a global
      // confirmation either way.
      handleMessage(
        { type: 'session_stopped', code: 0 },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state._infoNotifications).toEqual(['Session stopped.'])
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

  describe('session_persist_failed dispatch (#5714)', () => {
    it('surfaces an unsaved session-list mutation through addServerError', () => {
      handleMessage(
        { type: 'session_persist_failed', sessionId: 'sess-1', name: 'My Session' },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.serverErrors).toHaveLength(1)
      expect(state.serverErrors[0]).toContain('"My Session"')
      expect(state.serverErrors[0]).toContain('may be lost on restart')
    })

    it('falls back to the sessionId label when name is null (destroy path)', () => {
      handleMessage(
        { type: 'session_persist_failed', sessionId: 'sess-gone', name: null },
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.serverErrors[0]).toContain('session sess-gone')
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

    // #5516 (epic #5514): the flush is scheduled on an ADAPTIVE timer (was a
    // fixed 100ms). With the constant override pinned, the first delta must
    // schedule a setTimeout at exactly that interval. Default (no override)
    // behavior is covered by resolveDeltaFlushMs's store-core unit tests.
    it('schedules the delta flush at the overridden interval (#5516)', () => {
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
      }))
      setStore(store)

      const setTimeoutSpy = vi.spyOn(globalThis, 'setTimeout')
      try {
        setDeltaFlushIntervalOverride(16)
        handleMessage({ type: 'stream_start', messageId: 'msg-x', sessionId: 's1' }, ctx() as any)
        handleMessage({ type: 'stream_delta', messageId: 'msg-x', sessionId: 's1', delta: 'Hi' }, ctx() as any)

        const flushCall = setTimeoutSpy.mock.calls.find((c) => c[1] === 16)
        expect(flushCall).toBeDefined()

        vi.runAllTimers()
        const ss = (store.getState() as any).sessionStates.s1
        expect(ss.messages.find((m: any) => m.id === 'msg-x')?.content).toBe('Hi')
      } finally {
        setDeltaFlushIntervalOverride(null)
        setTimeoutSpy.mockRestore()
      }
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
        // already populated. A subsequent delta on it must NOT reorder the
        // existing slot — the #4297 reorder gate is `content === ''`.
        //
        // Post-#4889: because a tool_use follows the populated response,
        // the new delta materializes into a continuation slot at the end
        // instead of concatenating onto the existing content. The original
        // response is preserved in place (no reorder), the tool stays at
        // index 1, and the new text lands in a fresh `-cont-` bubble.
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
        // Original response stays at index 0 with its replayed content intact
        // (no reorder, no concatenation).
        expect(ss.messages[0].id).toBe('resp-replay')
        expect(ss.messages[0].content).toBe('Existing replayed content. ')
        // Tool remains at index 1.
        expect(ss.messages[1].id).toBe('toolu_x')
        // The new delta lands in a continuation slot appended at the end.
        const last = ss.messages[ss.messages.length - 1]
        expect(last.type).toBe('response')
        expect(last.content).toBe('more text')
        expect(last.id).toMatch(/^resp-replay-cont-/)
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

    // #4889 — when an assistant turn streams text → tool → text → tool → text,
    // the server reuses ONE messageId for the entire response. The #4297 fix
    // (reorder empty slot to end) only handles the FIRST delta — subsequent
    // text chunks (after intervening tool_use messages) concatenate into the
    // same content field with no separator, producing `…before filing.Filing
    // now.Filed:` and losing paragraph breaks.
    //
    // Fix: when a delta arrives for a non-empty response that already has a
    // tool_use appended after it, materialize a fresh response continuation
    // slot at the end of the messages array (suffixed id `-cont-N`). Each
    // post-tool text chunk becomes its own response bubble — formatTranscript
    // already separates response messages with `\n\n`.
    describe('post-tool text chunks split into continuation slots (#4889)', () => {
      it('creates a new response slot when delta arrives for a response with tool_use appended after it', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        // text-A → tool → text-B → tool → text-C
        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          { type: 'stream_delta', messageId: 'resp-1', sessionId: 's1', delta: 'Let me check chroxy before filing.' },
          ctx() as any,
        )
        vi.runAllTimers()
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_a',
            tool: 'Bash',
            toolUseId: 'toolu_a',
            input: { command: 'gh issue list' },
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          { type: 'tool_result', toolUseId: 'toolu_a', result: 'ok', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          { type: 'stream_delta', messageId: 'resp-1', sessionId: 's1', delta: 'Filing now.' },
          ctx() as any,
        )
        vi.runAllTimers()
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_b',
            tool: 'Bash',
            toolUseId: 'toolu_b',
            input: { command: 'gh issue create' },
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          { type: 'tool_result', toolUseId: 'toolu_b', result: 'https://...', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          { type: 'stream_delta', messageId: 'resp-1', sessionId: 's1', delta: 'Filed: https://github.com/...' },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        // Three distinct response bubbles, each carrying one chunk
        const responses = ss.messages.filter((m: any) => m.type === 'response')
        const tools = ss.messages.filter((m: any) => m.type === 'tool_use')
        expect(responses).toHaveLength(3)
        expect(tools).toHaveLength(2)
        expect(responses[0].content).toBe('Let me check chroxy before filing.')
        expect(responses[1].content).toBe('Filing now.')
        expect(responses[2].content).toBe('Filed: https://github.com/...')
        // No `.X` (period followed by capital with no space) across boundaries —
        // the join in formatTranscript inserts `\n\n` so the concatenation is safe.
        const joined = responses.map((r: any) => r.content).join('\n\n')
        expect(joined).not.toMatch(/\.[A-Z]/)
      })

      it('places each continuation slot AFTER the preceding tool_use (#4297 ordering preserved)', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        // Sentence-terminated fixtures so #4975 mid-word peel doesn't kick
        // in — the prior delta ends with `.` (non-word char) and the
        // continuation starts with a capital, matching a real paragraph
        // break the LLM would emit.
        handleMessage(
          { type: 'stream_delta', messageId: 'resp-1', sessionId: 's1', delta: 'preamble.' },
          ctx() as any,
        )
        vi.runAllTimers()
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
          { type: 'stream_delta', messageId: 'resp-1', sessionId: 's1', delta: 'Summary.' },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        // [response('preamble.'), tool, response('Summary.')]
        expect(ss.messages).toHaveLength(3)
        expect(ss.messages[0].type).toBe('response')
        expect(ss.messages[0].content).toBe('preamble.')
        expect(ss.messages[1].type).toBe('tool_use')
        expect(ss.messages[1].id).toBe('toolu_a')
        expect(ss.messages[2].type).toBe('response')
        expect(ss.messages[2].content).toBe('Summary.')
      })

      it('does not split when consecutive deltas arrive without an intervening tool', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          { type: 'stream_delta', messageId: 'resp-1', sessionId: 's1', delta: 'hello ' },
          ctx() as any,
        )
        handleMessage(
          { type: 'stream_delta', messageId: 'resp-1', sessionId: 's1', delta: 'world' },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        // No tool ran — single response slot with concatenated deltas
        expect(ss.messages).toHaveLength(1)
        expect(ss.messages[0].type).toBe('response')
        expect(ss.messages[0].content).toBe('hello world')
      })

      it('splits in the flat-messages branch (legacy/pre-session bootstrap)', () => {
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
        // Sentence-terminated fixtures so #4975 mid-word peel doesn't fire.
        handleMessage(
          { type: 'stream_delta', messageId: 'flat-resp', delta: 'part 1.' },
          ctx() as any,
        )
        vi.runAllTimers()
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
          { type: 'stream_delta', messageId: 'flat-resp', delta: 'Part 2.' },
          ctx() as any,
        )
        vi.runAllTimers()

        const flat = (store.getState() as any).messages
        const responses = flat.filter((m: any) => m.type === 'response')
        const tools = flat.filter((m: any) => m.type === 'tool_use')
        expect(responses).toHaveLength(2)
        expect(tools).toHaveLength(1)
        expect(responses[0].content).toBe('part 1.')
        expect(responses[1].content).toBe('Part 2.')
      })
    })

    // #4975 — mid-word peel. When the LLM interrupts a text content block to
    // call a tool, the boundary can land inside a word (e.g. "Del" before
    // the tool, "egating" after). Without intervention the user sees "Del"
    // in one bubble, the tool bubble, then "egating..." in another —
    // visually fragmented mid-word. The handler peels the trailing partial
    // word off the prior slot and seeds the continuation buffer with it so
    // the word reassembles in the post-tool bubble.
    //
    // #4999 follow-up — the mid-sentence gate added on the post-#4889 split
    // now coalesces these cases into a single bubble before the peel runs,
    // so the trailing-word and whitespace-led tests below now assert the
    // coalesced shape. The peel itself stays as defense-in-depth for the
    // sentence-boundary path (prior ends in `.` but the next word continues
    // mid-word, like `PR #3.Del` -> tool -> `egating`).
    describe('mid-word peel across tool boundary (#4975)', () => {
      it('coalesces mid-word splits into a single bubble (post-#4999 — peel no longer needed for mid-word inside a sentence)', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        // text "Starting Phase 1 — agent-review on PR #3.Del" -> tool -> "egating..."
        // The pre-tool content ends with `l` (mid-sentence), so the
        // mid-sentence gate from #4999 routes the post-tool delta to the
        // existing slot — one bubble, no mid-word artifact possible.
        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'Starting Phase 1 — agent-review on PR #3.Del',
          },
          ctx() as any,
        )
        vi.runAllTimers()
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_a',
            tool: 'Task',
            toolUseId: 'toolu_a',
            input: { description: 'agent-review' },
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'egating the deep review to an independent reviewer agent.',
          },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        const responses = ss.messages.filter((m: any) => m.type === 'response')
        // One coalesced bubble — the word "Delegating" reads cleanly.
        expect(responses).toHaveLength(1)
        expect(responses[0].content).toBe(
          'Starting Phase 1 — agent-review on PR #3.Delegating the deep review to an independent reviewer agent.',
        )
        expect(responses[0].content).toContain('Delegating')
      })

      it('coalesces mid-word splits even when prior content is still buffered (delta not yet flushed)', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        // Skip vi.runAllTimers() so "PR #3.Del" stays in pendingDeltas
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'PR #3.Del',
          },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_a',
            tool: 'Task',
            toolUseId: 'toolu_a',
            input: {},
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'egating now.',
          },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        const responses = ss.messages.filter((m: any) => m.type === 'response')
        // Mid-sentence gate sees the buffered "PR #3.Del" ending in `l`
        // and routes the post-tool delta to the same bubble.
        expect(responses).toHaveLength(1)
        expect(responses[0].content).toBe('PR #3.Delegating now.')
      })

      it('does NOT peel when prior content ends at a sentence boundary (clean break)', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        // Existing #4889 behaviour: "Let me check chroxy before filing." ->
        // tool -> "Filing now." keeps the period at the end and starts a
        // fresh continuation with "Filing now." — no peel because the prior
        // ends with `.` (not a word char).
        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'Let me check chroxy before filing.',
          },
          ctx() as any,
        )
        vi.runAllTimers()
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_a',
            tool: 'Bash',
            toolUseId: 'toolu_a',
            input: { command: 'gh issue list' },
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'Filing now.',
          },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        const responses = ss.messages.filter((m: any) => m.type === 'response')
        expect(responses).toHaveLength(2)
        expect(responses[0].content).toBe('Let me check chroxy before filing.')
        expect(responses[1].content).toBe('Filing now.')
      })

      it('coalesces when prior ends mid-sentence and incoming delta starts with whitespace (post-#4999)', () => {
        // Pre-#4999: this case (prior ends in word char `Running`, incoming
        // starts with whitespace) split into two bubbles to avoid moving
        // a complete word across the tool boundary. Post-#4999: the
        // mid-sentence gate sees `Running` is not a sentence terminator
        // and coalesces into one bubble — the LLM emitted a single
        // sentence interrupted by a tool.
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        // Prior delta ends with `Running` (word char `g`).
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'Starting Phase 1 — agent-review on PR #3 is up. Running',
          },
          ctx() as any,
        )
        vi.runAllTimers()
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_a',
            tool: 'Task',
            toolUseId: 'toolu_a',
            input: { description: 'agent-review' },
            sessionId: 's1',
          },
          ctx() as any,
        )
        // Incoming delta starts with a space — a normal word boundary
        // but mid-sentence (no terminator before the tool).
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: ' /full-review then /batch-merge.',
          },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        const responses = ss.messages.filter((m: any) => m.type === 'response')
        // One bubble — the sentence "Running /full-review..." reads cleanly.
        expect(responses).toHaveLength(1)
        expect(responses[0].content).toBe(
          'Starting Phase 1 — agent-review on PR #3 is up. Running /full-review then /batch-merge.',
        )
      })

      it('coalesces when prior ends mid-sentence and incoming delta starts with non-terminator punctuation (post-#4999)', () => {
        // Mirror of the whitespace case — `,`, `(`, `:` etc. are NOT
        // sentence terminators on the prior side, so the mid-sentence gate
        // coalesces. Note: a sentence terminator (`.`) on the INCOMING
        // side does not affect the gate; only the prior bubble's tail
        // matters.
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'Fetched PR',
          },
          ctx() as any,
        )
        vi.runAllTimers()
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_a',
            tool: 'Bash',
            toolUseId: 'toolu_a',
            input: {},
            sessionId: 's1',
          },
          ctx() as any,
        )
        // Incoming starts with `.` then a new sentence — but the prior
        // bubble itself ends mid-sentence (`R` is a word char), so
        // coalesce.
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: '. Next step: review.',
          },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        const responses = ss.messages.filter((m: any) => m.type === 'response')
        expect(responses).toHaveLength(1)
        expect(responses[0].content).toBe('Fetched PR. Next step: review.')
      })
    })

    // #4999 — Mid-sentence fragmentation. When the LLM emits a single sentence
    // interrupted mid-stream by a tool call (e.g. "...CSS" → tool → " vars).")
    // the post-#4889 continuation split produced two visible bubbles around
    // the tool, breaking the sentence in two. The #4975 mid-word peel only
    // covered the narrow case where both sides of the boundary were in a word;
    // a normal word boundary mid-sentence (prior ends in `S`, incoming starts
    // with whitespace) still fragmented. The split should only fire when the
    // prior bubble's content ends at a sentence boundary (`.`, `!`, `?`, `\n`)
    // — otherwise the delta routes back to the existing slot so the text
    // renders as one contiguous bubble followed by the tool.
    describe('no split when prior bubble ends mid-sentence (#4999)', () => {
      it('coalesces text into a single bubble when prior content ends in a word char with whitespace-led continuation', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        // Repro from #4999 — the visible bubbles were:
        //   A: "Now the keyboard handler + render need updates (overlay + className + CSS"
        //   tool (Read)
        //   B: " vars)."
        // The sentence is broken mid-stream; the user expects ONE bubble.
        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'Now the keyboard handler + render need updates (overlay + className + CSS',
          },
          ctx() as any,
        )
        vi.runAllTimers()
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_a',
            tool: 'Read',
            toolUseId: 'toolu_a',
            input: { file_path: '/x' },
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: ' vars).',
          },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        const responses = ss.messages.filter((m: any) => m.type === 'response')
        const tools = ss.messages.filter((m: any) => m.type === 'tool_use')
        // ONE response bubble carrying the full sentence — no mid-sentence split.
        expect(responses).toHaveLength(1)
        expect(tools).toHaveLength(1)
        expect(responses[0].content).toBe(
          'Now the keyboard handler + render need updates (overlay + className + CSS vars).',
        )
      })

      it('coalesces when prior ends in an open paren and incoming starts mid-sentence', () => {
        // Defensive: punctuation that isn't a sentence terminator (open paren,
        // colon, comma) also indicates the sentence continues.
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'See the helper (',
          },
          ctx() as any,
        )
        vi.runAllTimers()
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_a',
            tool: 'Read',
            toolUseId: 'toolu_a',
            input: { file_path: '/x' },
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'utils.ts).',
          },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        const responses = ss.messages.filter((m: any) => m.type === 'response')
        expect(responses).toHaveLength(1)
        expect(responses[0].content).toBe('See the helper (utils.ts).')
      })

      it('STILL splits when prior content ends at a sentence boundary (paragraph break preserved, #4889)', () => {
        // The #4889 case must keep working: "...filing." → tool → "Filing now."
        // is two separate sentences, so each gets its own bubble.
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'Let me check chroxy before filing.',
          },
          ctx() as any,
        )
        vi.runAllTimers()
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_a',
            tool: 'Bash',
            toolUseId: 'toolu_a',
            input: { command: 'gh issue list' },
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'Filing now.',
          },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        const responses = ss.messages.filter((m: any) => m.type === 'response')
        expect(responses).toHaveLength(2)
        expect(responses[0].content).toBe('Let me check chroxy before filing.')
        expect(responses[1].content).toBe('Filing now.')
      })

      it('STILL splits when prior ends in a question mark', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'What is the state of the PR?',
          },
          ctx() as any,
        )
        vi.runAllTimers()
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_a',
            tool: 'Bash',
            toolUseId: 'toolu_a',
            input: {},
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'It looks open.',
          },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        const responses = ss.messages.filter((m: any) => m.type === 'response')
        expect(responses).toHaveLength(2)
        expect(responses[0].content).toBe('What is the state of the PR?')
        expect(responses[1].content).toBe('It looks open.')
      })

      it('STILL splits when prior ends in a sentence terminator wrapped in closing punctuation/quotes', () => {
        // Copilot review of #5011 — a completed sentence followed by closing
        // punctuation (`.")`, `."`, `!'`, `?)`) was being treated as
        // mid-sentence because the gate only inspected the very last char.
        // Strip trailing closers before evaluating the terminator so the
        // #4889 paragraph split still fires.
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'He said "the build is done."',
          },
          ctx() as any,
        )
        vi.runAllTimers()
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_a',
            tool: 'Bash',
            toolUseId: 'toolu_a',
            input: {},
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'Filing the report now.',
          },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        const responses = ss.messages.filter((m: any) => m.type === 'response')
        expect(responses).toHaveLength(2)
        expect(responses[0].content).toBe('He said "the build is done."')
        expect(responses[1].content).toBe('Filing the report now.')
      })

      it('STILL splits when prior ends in a terminator wrapped in a closing paren', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: '(see the docs for more.)',
          },
          ctx() as any,
        )
        vi.runAllTimers()
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_a',
            tool: 'Read',
            toolUseId: 'toolu_a',
            input: { file_path: '/x' },
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'Continuing with the next section.',
          },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        const responses = ss.messages.filter((m: any) => m.type === 'response')
        expect(responses).toHaveLength(2)
        expect(responses[0].content).toBe('(see the docs for more.)')
        expect(responses[1].content).toBe('Continuing with the next section.')
      })

      // #5014 — unicode sentence terminators (CJK fullwidth + ideographic
      // full stop) must also satisfy the gate so paragraph splits are
      // preserved across a tool boundary in non-ASCII assistant output.
      it('STILL splits when prior ends in a fullwidth full stop (U+FF0E)', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'ファイルを確認します．',
          },
          ctx() as any,
        )
        vi.runAllTimers()
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_a',
            tool: 'Bash',
            toolUseId: 'toolu_a',
            input: {},
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: '次の段落です．',
          },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        const responses = ss.messages.filter((m: any) => m.type === 'response')
        expect(responses).toHaveLength(2)
        expect(responses[0].content).toBe('ファイルを確認します．')
        expect(responses[1].content).toBe('次の段落です．')
      })

      it('STILL splits when prior ends in a fullwidth exclamation mark (U+FF01)', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'やった！',
          },
          ctx() as any,
        )
        vi.runAllTimers()
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_a',
            tool: 'Bash',
            toolUseId: 'toolu_a',
            input: {},
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: '続行します．',
          },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        const responses = ss.messages.filter((m: any) => m.type === 'response')
        expect(responses).toHaveLength(2)
        expect(responses[0].content).toBe('やった！')
        expect(responses[1].content).toBe('続行します．')
      })

      it('STILL splits when prior ends in a fullwidth question mark (U+FF1F)', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: 'これは正しいですか？',
          },
          ctx() as any,
        )
        vi.runAllTimers()
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_a',
            tool: 'Bash',
            toolUseId: 'toolu_a',
            input: {},
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: '確認しました．',
          },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        const responses = ss.messages.filter((m: any) => m.type === 'response')
        expect(responses).toHaveLength(2)
        expect(responses[0].content).toBe('これは正しいですか？')
        expect(responses[1].content).toBe('確認しました．')
      })

      it('STILL splits when prior ends in an ideographic full stop (U+3002)', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: '准备检查文件。',
          },
          ctx() as any,
        )
        vi.runAllTimers()
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_a',
            tool: 'Bash',
            toolUseId: 'toolu_a',
            input: {},
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: '现在归档。',
          },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        const responses = ss.messages.filter((m: any) => m.type === 'response')
        expect(responses).toHaveLength(2)
        expect(responses[0].content).toBe('准备检查文件。')
        expect(responses[1].content).toBe('现在归档。')
      })

      // #5033 review — composition: CJK terminator wrapped in a CJK closing
      // bracket must still satisfy the gate. The strip set drops `」` so the
      // gate sees `。` and the split fires.
      it('STILL splits when prior ends in a CJK terminator wrapped in a CJK closing bracket', () => {
        store = createMockStore(
          baseState({
            activeSessionId: 's1',
            sessions: [{ sessionId: 's1', name: 'S1' } as any],
            sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
          }),
        )
        setStore(store)

        handleMessage(
          { type: 'stream_start', messageId: 'resp-1', sessionId: 's1' },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: '「ファイルを確認します。」',
          },
          ctx() as any,
        )
        vi.runAllTimers()
        handleMessage(
          {
            type: 'tool_start',
            messageId: 'toolu_a',
            tool: 'Bash',
            toolUseId: 'toolu_a',
            input: {},
            sessionId: 's1',
          },
          ctx() as any,
        )
        handleMessage(
          {
            type: 'stream_delta',
            messageId: 'resp-1',
            sessionId: 's1',
            delta: '次の段落です．',
          },
          ctx() as any,
        )
        vi.runAllTimers()

        const ss = (store.getState() as any).sessionStates.s1
        const responses = ss.messages.filter((m: any) => m.type === 'response')
        expect(responses).toHaveLength(2)
        expect(responses[0].content).toBe('「ファイルを確認します。」')
        expect(responses[1].content).toBe('次の段落です．')
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

    it('deduplicates tool_use by stable messageId during a full-rebuild replay (#5555.4)', () => {
      // #5555.4 — full rebuild no longer wipes at start; the old prefix stays
      // visible and the replayed set is appended then swapped at end. Dedup
      // during rebuild is scoped to the appended tail, so a replay that sends
      // the SAME tool twice still collapses to one entry, and the atomic swap
      // drops the pre-replay prefix.
      seedWithTool('tool-1') // pre-replay prefix (stays visible, no flash)
      handleMessage(
        { type: 'history_replay_start', sessionId: 's1', fullHistory: true },
        ctx() as any,
      )
      // Messages are NOT cleared — the prefix is still there.
      expect((store.getState() as any).sessionStates.s1.messages).toHaveLength(1)
      const send = (id: string) =>
        handleMessage(
          { type: 'tool_start', messageId: id, tool: 'Bash', input: 'ls', sessionId: 's1' },
          ctx() as any,
        )
      send('tool-1') // first replayed copy → appended to tail
      send('tool-1') // duplicate within the replay → deduped against the tail
      handleMessage({ type: 'history_replay_end', sessionId: 's1' }, ctx() as any)
      // Atomic swap → only the replayed tail (one tool-1), prefix dropped.
      const msgs = (store.getState() as any).sessionStates.s1.messages
      expect(msgs).toHaveLength(1)
      expect(msgs[0].id).toBe('tool-1')
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

  // #5778 — the Output tab (terminal preview) must show the unwrapped
  // stdout/stderr text of a tool result, not the raw `{"stdout":...}` JSON
  // envelope. These guard the wiring in handleToolResult, not just the helper.
  describe('Output-tab tool_result unwrap (#5778)', () => {
    it('forwards only the unwrapped stdout to appendTerminalData', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
        }),
      )
      setStore(store)
      const envelope = JSON.stringify({
        stdout: 'total 0\ndrwxr-xr-x',
        stderr: '',
        interrupted: false,
      })
      handleMessage(
        { type: 'tool_result', toolUseId: 'tu-1', result: envelope, sessionId: 's1' },
        ctx() as any,
      )
      const writes = (store.getState() as any)._terminalWrites as string[]
      expect(writes).toHaveLength(1)
      // Dim-styled preview wraps the unwrapped text — assert no JSON braces leak.
      expect(writes[0]).toContain('total 0\ndrwxr-xr-x')
      expect(writes[0]).not.toContain('"stdout"')
      expect(writes[0]).not.toContain('{')
    })

    it('passes a plain-string result through unchanged', () => {
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessions: [{ sessionId: 's1', name: 'S1' } as any],
          sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
        }),
      )
      setStore(store)
      handleMessage(
        { type: 'tool_result', toolUseId: 'tu-2', result: 'plain output line', sessionId: 's1' },
        ctx() as any,
      )
      const writes = (store.getState() as any)._terminalWrites as string[]
      expect(writes).toHaveLength(1)
      expect(writes[0]).toContain('plain output line')
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

  // #5039 — PR #5037 added optional `usage` + `cost` to the error envelope so
  // a Task subagent error path can surface "this turn cost $X" in the
  // dashboard toast. The dispatch must pass the pre-formatted sub-line into
  // addServerError as the 4th positional arg; without it, the partial-cost
  // information reaches the wire but never makes it onto the toast.
  describe('error dispatch — partial-cost sub-line (#5039)', () => {
    it('threads the partial-cost line into addServerError when cost+usage present', () => {
      const calls: Array<{ message: unknown; partialCostLine: unknown }> = []
      store = createMockStore(baseState())
      setStore(store)
      ;(store.getState() as any).addServerError = (
        message: unknown,
        _action: unknown,
        _severity: unknown,
        partialCostLine?: string,
      ) => {
        calls.push({ message, partialCostLine })
      }
      handleMessage(
        {
          type: 'error',
          code: 'STREAM_ERROR',
          message: 'stream failed',
          cost: 0.0875,
          usage: {
            input_tokens: 1234,
            output_tokens: 3400,
            cache_read_input_tokens: 0,
            cache_creation_input_tokens: 0,
          },
        } as any,
        ctx() as any,
      )
      expect(calls).toHaveLength(1)
      expect(calls[0]?.message).toBe('stream failed')
      // Pre-formatted via the shared `formatPartialCostLine` helper so
      // the dashboard + mobile alerts can't drift on copy/format.
      expect(calls[0]?.partialCostLine).toBe('This turn cost $0.087 (1.2K in · 3.4K out)')
    })

    it('passes undefined when the wire shape has no partials (pre-#5037 servers)', () => {
      // Default error envelope without cost — the dispatch must NOT
      // synthesize an empty/zero sub-line. Asserting `undefined` (not
      // empty string) pins the addServerError 4th-arg contract: the
      // store's spread-on-truthy guard skips the field entirely.
      const calls: Array<{ partialCostLine: unknown }> = []
      store = createMockStore(baseState())
      setStore(store)
      ;(store.getState() as any).addServerError = (
        _message: unknown,
        _action: unknown,
        _severity: unknown,
        partialCostLine?: string,
      ) => {
        calls.push({ partialCostLine })
      }
      handleMessage(
        { type: 'error', code: 'STREAM_ERROR', message: 'no partials here' } as any,
        ctx() as any,
      )
      expect(calls).toHaveLength(1)
      expect(calls[0]?.partialCostLine).toBeUndefined()
    })

    it('renders cost-only line when usage is missing (subscription provider)', () => {
      // Subscription-billed providers can produce a cost without a
      // token breakdown — the sub-line must still surface so the user
      // sees the failed-turn spend.
      const calls: Array<{ partialCostLine: unknown }> = []
      store = createMockStore(baseState())
      setStore(store)
      ;(store.getState() as any).addServerError = (
        _message: unknown,
        _action: unknown,
        _severity: unknown,
        partialCostLine?: string,
      ) => {
        calls.push({ partialCostLine })
      }
      handleMessage(
        { type: 'error', code: 'ABORT', message: 'cancelled', cost: 0.05 } as any,
        ctx() as any,
      )
      expect(calls).toHaveLength(1)
      expect(calls[0]?.partialCostLine).toBe('This turn cost $0.050')
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

  describe('credentials_status dispatch (#3855)', () => {
    it('stores the masked, value-free snapshot', () => {
      handleMessage(
        {
          type: 'credentials_status',
          requestId: 'r1',
          credentials: [
            { key: 'OPENAI_API_KEY', provider: 'OpenAI / Codex', label: 'OpenAI API key', kind: 'api-key', status: 'set', source: 'store', masked: 'sk...[3 chars redacted]', oauth: false },
            { key: 'ANTHROPIC_API_KEY', provider: 'Anthropic', label: 'Anthropic API key', kind: 'api-key', status: 'missing', source: 'oauth', oauth: true },
          ],
          fileExists: true,
          fileError: null,
        } as any,
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.credentialsStatus.credentials).toHaveLength(2)
      expect(state.credentialsStatus.credentials[0].source).toBe('store')
      expect(state.credentialsStatus.credentials[1].oauth).toBe(true)
      expect(state.credentialsStatus.fileExists).toBe(true)
      expect(state.credentialsStatus.fileError).toBeNull()
    })

    it('ignores a malformed payload (leaves the store unchanged)', () => {
      handleMessage(
        // Missing the required `credentials` array.
        { type: 'credentials_status', requestId: 'r2' } as any,
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.credentialsStatus).toBeNull()
    })
  })

  describe('credential_test_result dispatch (#3855)', () => {
    it('stores the result keyed by credential', () => {
      handleMessage(
        { type: 'credential_test_result', requestId: 'r3', key: 'OPENAI_API_KEY', ok: true, model: 'models.list', latencyMs: 42 } as any,
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.credentialTestResults.OPENAI_API_KEY).toEqual({ ok: true, error: undefined, model: 'models.list', latencyMs: 42 })
    })

    it('keeps results for other keys when a new one arrives', () => {
      handleMessage(
        { type: 'credential_test_result', key: 'OPENAI_API_KEY', ok: true } as any,
        ctx() as any,
      )
      handleMessage(
        { type: 'credential_test_result', key: 'GEMINI_API_KEY', ok: false, error: 'bad key' } as any,
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.credentialTestResults.OPENAI_API_KEY.ok).toBe(true)
      expect(state.credentialTestResults.GEMINI_API_KEY.ok).toBe(false)
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

    it('routes the prompt to its owning (non-active) session and records originSessionId (#5667)', () => {
      // 's-bg' is asking while 's-active' is focused. The prompt must land in
      // s-bg's message list (not the active tab) and carry originSessionId so
      // the renderer can label which session asked.
      store = createMockStore(
        baseState({
          activeSessionId: 's-active',
          // Background session asking → pushSessionNotification runs (it
          // early-returns only for the active session), so seed the array it
          // mutates. Exercises the real cross-session notification path.
          sessionNotifications: [],
          sessionStates: {
            's-active': createEmptySessionState(),
            's-bg': createEmptySessionState(),
          },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'permission_request',
          sessionId: 's-bg',
          requestId: 'perm-bg',
          tool: 'Bash',
          input: { command: 'rm -rf /tmp/x' },
          remainingMs: 300000,
        },
        ctx() as any,
      )
      const bgMsgs = (store.getState() as any).sessionStates['s-bg'].messages
      const activeMsgs = (store.getState() as any).sessionStates['s-active'].messages
      const promptMsg = bgMsgs.find((m: any) => m.type === 'prompt')
      expect(promptMsg).toBeDefined()
      expect(promptMsg.originSessionId).toBe('s-bg')
      // The active tab must NOT have received the background session's prompt.
      expect(activeMsgs.find((m: any) => m.type === 'prompt')).toBeUndefined()
    })

    it('creates the owning session state and routes the prompt there when that session is NOT loaded (#5693)', () => {
      // 's-bg' is asking but its sessionState has not been hydrated on this
      // client (only 's-active' is loaded). Containment fix: create s-bg's
      // (tab-invisible) state and route the prompt there — never into the active
      // tab's transcript or the flat top-level messages that mirror it.
      store = createMockStore(
        baseState({
          activeSessionId: 's-active',
          sessionNotifications: [],
          sessionStates: { 's-active': createEmptySessionState() }, // NO 's-bg'
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'permission_request',
          sessionId: 's-bg',
          requestId: 'perm-unloaded',
          tool: 'Bash',
          input: { command: 'rm -rf /tmp/x' },
          remainingMs: 300000,
        },
        ctx() as any,
      )
      const state = store.getState() as any
      // Owning session state was created and holds the labeled prompt.
      expect(state.sessionStates['s-bg']).toBeDefined()
      const bgPrompt = state.sessionStates['s-bg'].messages.find((m: any) => m.type === 'prompt')
      expect(bgPrompt).toBeDefined()
      expect(bgPrompt.originSessionId).toBe('s-bg')
      // The active tab must NOT have received it — not its state...
      expect(state.sessionStates['s-active'].messages.find((m: any) => m.type === 'prompt')).toBeUndefined()
      // ...and not the flat top-level messages that mirror the focused tab.
      expect((state.messages || []).find((m: any) => m.type === 'prompt')).toBeUndefined()
      // Tab-invisibility (the whole safety basis): creating s-bg's state must
      // NOT register it as a tab — tabs derive from `sessions`, not the
      // `sessionStates` keys.
      expect((state.sessions || []).some((s: any) => s.sessionId === 's-bg')).toBe(false)
    })

    it('does not clear the active tab\'s in-flight stream when a mapped prompt arrives for an unloaded session (#5693)', () => {
      // s-active is mid-stream; s-bg (not loaded) asks for permission. The #554
      // stream-split must read s-bg's stream (null after the containment guard
      // creates its state), NOT fall back to the active session's
      // streamingMessageId and null it — that would interrupt the focused tab's
      // response just because a different session asked.
      store = createMockStore(
        baseState({
          activeSessionId: 's-active',
          streamingMessageId: 'stream-active',
          sessionNotifications: [],
          sessionStates: {
            's-active': { ...createEmptySessionState(), streamingMessageId: 'stream-active' },
          }, // NO s-bg
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'permission_request',
          sessionId: 's-bg',
          requestId: 'perm-stream',
          tool: 'Bash',
          input: { command: 'ls' },
          remainingMs: 300000,
        },
        ctx() as any,
      )
      const state = store.getState() as any
      // The active tab's stream is preserved — not cleared by s-bg's permission.
      expect(state.streamingMessageId).toBe('stream-active')
      // Containment still holds: s-bg received its prompt.
      expect(state.sessionStates['s-bg'].messages.find((m: any) => m.type === 'prompt')).toBeDefined()
    })

    it('leaves originSessionId undefined for an unmapped request (no wire sessionId) (#5667)', () => {
      // No sessionId on the wire → the prompt falls back to the active tab for
      // routing, but originSessionId must stay undefined (not the active id) so
      // it is not mislabelled as the active session's own prompt.
      store = createMockStore(
        baseState({
          activeSessionId: 's-active',
          sessionStates: { 's-active': createEmptySessionState() },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'permission_request',
          requestId: 'perm-unmapped',
          tool: 'Bash',
          input: { command: 'ls' },
          remainingMs: 300000,
        },
        ctx() as any,
      )
      const msgs = (store.getState() as any).sessionStates['s-active'].messages
      const promptMsg = msgs.find((m: any) => m.type === 'prompt')
      expect(promptMsg).toBeDefined()
      expect(promptMsg.originSessionId).toBeUndefined()
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

  // #4653 — multi_question_intervention dispatch. The server fires this
  // session_event when ClaudeTuiSession's PreToolUse hook sees a multi-q
  // AskUserQuestion (the exact deny condition shipped in #4648). The
  // dashboard appends to the per-session interventions ring + on the FIRST
  // intervention also pushes a one-time system ChatMessage so the user
  // actually sees the deny happened.
  describe('multi_question_intervention dispatch (#4653)', () => {
    it('appends an intervention entry to the targeted session', () => {
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: { s1: { ...createEmptySessionState() } },
      }))
      setStore(store)

      handleMessage(
        {
          type: 'multi_question_intervention',
          sessionId: 's1',
          toolUseId: 'toolu_first',
          questionCount: 3,
          reason: 'multi_question',
          timestamp: 1700000000000,
        },
        ctx() as any,
      )

      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.interventions).toHaveLength(1)
      expect(ss.interventions[0]).toEqual({
        kind: 'multi_question',
        toolUseId: 'toolu_first',
        count: 3,
        timestamp: 1700000000000,
      })
    })

    it('pushes a one-time system ChatMessage on the FIRST intervention', () => {
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: { s1: { ...createEmptySessionState() } },
      }))
      setStore(store)

      handleMessage(
        {
          type: 'multi_question_intervention',
          sessionId: 's1',
          toolUseId: 'toolu_a',
          questionCount: 2,
        },
        ctx() as any,
      )

      const messages = (store.getState() as any).sessionStates.s1.messages
      expect(messages).toHaveLength(1)
      expect(messages[0].type).toBe('system')
      expect(messages[0].content).toMatch(/multi-question form/i)
      expect(messages[0].content).toMatch(/one at a time|single questions/i)
    })

    it('does NOT push a second system message for subsequent distinct interventions', () => {
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: { s1: { ...createEmptySessionState() } },
      }))
      setStore(store)

      // First intervention — system message lands.
      handleMessage(
        { type: 'multi_question_intervention', sessionId: 's1', toolUseId: 'tu_1', questionCount: 2 },
        ctx() as any,
      )
      // Second distinct intervention — counter ticks, no second system message.
      handleMessage(
        { type: 'multi_question_intervention', sessionId: 's1', toolUseId: 'tu_2', questionCount: 4 },
        ctx() as any,
      )

      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.interventions).toHaveLength(2)
      // Only ONE system message — repeats just bump the counter.
      const systemMessages = ss.messages.filter((m: any) => m.type === 'system')
      expect(systemMessages).toHaveLength(1)
    })

    it('dedups repeats by toolUseId — counter does not tick for stuck-model re-emits', () => {
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: { s1: { ...createEmptySessionState() } },
      }))
      setStore(store)

      handleMessage(
        { type: 'multi_question_intervention', sessionId: 's1', toolUseId: 'tu_stuck', questionCount: 3 },
        ctx() as any,
      )
      handleMessage(
        { type: 'multi_question_intervention', sessionId: 's1', toolUseId: 'tu_stuck', questionCount: 3 },
        ctx() as any,
      )
      handleMessage(
        { type: 'multi_question_intervention', sessionId: 's1', toolUseId: 'tu_stuck', questionCount: 3 },
        ctx() as any,
      )

      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.interventions).toHaveLength(1)
    })

    it('drops the event when the targeted session is unknown', () => {
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: { s1: { ...createEmptySessionState() } },
      }))
      setStore(store)

      handleMessage(
        {
          type: 'multi_question_intervention',
          sessionId: 'unknown-sess',
          toolUseId: 'tu_x',
          questionCount: 2,
        },
        ctx() as any,
      )

      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.interventions).toHaveLength(0)
      expect(ss.messages).toHaveLength(0)
    })

    it('ignores malformed payloads (missing toolUseId)', () => {
      store = createMockStore(baseState({
        activeSessionId: 's1',
        sessionStates: { s1: { ...createEmptySessionState() } },
      }))
      setStore(store)

      handleMessage(
        { type: 'multi_question_intervention', sessionId: 's1', questionCount: 2 } as any,
        ctx() as any,
      )

      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.interventions).toHaveLength(0)
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

    // #4607 — full tab-switch flow: server's `replayHistory()` always sends
    // `fullHistory: true`, which the dashboard treats as "clear messages
    // before applying replayed events" (ws-history.js:372, message-handler
    // case 'history_replay_start'). With messages wiped, the dedup check
    // inside `sharedToolStart` (`cachedMessages.some(m => m.id === toolId)`)
    // can no longer find the prior tool_use bubble, so it falls through and
    // builds a fresh chatMessage with `timestamp: Date.now()` PLUS a fresh
    // ActiveTool whose `startedAt` is also Date.now(). The toolUseId-dedup
    // inside `applyToActiveTools` preserves the original ActiveTool entry
    // (so the structured `activeTools` slot keeps its original startedAt) —
    // BUT the new tool_use bubble pushed onto `messages` carries the fresh
    // timestamp. The ActivityIndicator's `findInFlightToolUse` fallback
    // would read THAT timestamp if `activeTools` were ever empty (e.g. a
    // server that didn't broadcast tool_start, or pre-bootstrap), so any
    // future regression that empties `activeTools` mid-replay would silently
    // reset the timer to ~0s. Pin both invariants in one place.
    it('full tab-switch (history_replay_start fullHistory:true + replayed tool_start) preserves startedAt (#4607)', () => {
      const originalStartedAt = 100
      const originalToolMsg = {
        id: 'tool-1',
        type: 'tool_use' as const,
        content: '{"command":"sleep 999"}',
        tool: 'Bash',
        toolUseId: 'tu-1',
        timestamp: originalStartedAt,
      }
      const inFlightTool = {
        toolUseId: 'tu-1',
        tool: 'Bash',
        input: { command: 'sleep 999' },
        startedAt: originalStartedAt,
      }
      seedSession({
        activeTools: [inFlightTool],
        messages: [originalToolMsg as any],
      })
      // Step 1: tab switch → server sends history_replay_start with
      // fullHistory:true. #5555.4 — messages are NO LONGER wiped here (no blank
      // flash); the prefix stays visible until the atomic swap at end. The
      // replay-dedup cache is scoped to the appended tail, so the cached-message
      // dedup still "misses" the replayed tool_start (it's not in the tail yet).
      handleMessage(
        { type: 'history_replay_start', sessionId: 's1', fullHistory: true },
        ctx() as any,
      )
      // After history_replay_start: prefix preserved; activeTools intact.
      let ss = (store.getState() as any).sessionStates.s1
      expect(ss.messages).toHaveLength(1)
      expect(ss.activeTools).toHaveLength(1)
      expect(ss.activeTools[0].startedAt).toBe(originalStartedAt)
      // Step 2: server replays the original tool_start (same messageId and
      // toolUseId). Pre-fix path would have rebuilt the activeTools entry
      // with startedAt: Date.now(); the toolUseId dedup in
      // applyToActiveTools is what saves us, but the test pins it.
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-1',
          tool: 'Bash',
          toolUseId: 'tu-1',
          input: { command: 'sleep 999' },
          sessionId: 's1',
        },
        ctx() as any,
      )
      ss = (store.getState() as any).sessionStates.s1
      // Critical invariant: activeTools entry's startedAt is preserved.
      // This is what the ActivityIndicator reads for "Running Bash · Ns".
      expect(ss.activeTools).toHaveLength(1)
      expect(ss.activeTools[0].toolUseId).toBe('tu-1')
      expect(ss.activeTools[0].startedAt).toBe(originalStartedAt)
      // Step 3: history_replay_end — flag clears, normal operation resumes.
      handleMessage({ type: 'history_replay_end', sessionId: 's1' }, ctx() as any)
      ss = (store.getState() as any).sessionStates.s1
      expect(ss.activeTools[0].startedAt).toBe(originalStartedAt)
    })

    // #4607 — fallback-path coverage. ActivityIndicator prefers `activeTools`
    // but falls back to `findInFlightToolUse(messages)` when activeTools is
    // empty. That fallback reads `m.timestamp` from the tool_use ChatMessage.
    // After a replayed tool_start the messages array contains a freshly
    // pushed tool_use bubble with `timestamp: Date.now()` — so if the
    // fallback ever fires post-replay the timer would jump to ~0s. Pin that
    // the replayed bubble carries the ORIGINAL server-side timestamp when
    // the server includes one in the tool_start payload (history entries
    // do — session-message-history.js:208-216 stamps `timestamp: Date.now()`
    // at append time and forwards it on replay). Without this, the
    // "Running X · 1s" symptom resurfaces the moment activeTools is empty
    // for any reason (handleAgentIdle, future refactor, missing toolUseId).
    it('replayed tool_use bubble inherits the wire timestamp, not Date.now() (#4607)', () => {
      const wireTimestamp = 200
      seedSession({ activeTools: [] })
      handleMessage(
        { type: 'history_replay_start', sessionId: 's1', fullHistory: true },
        ctx() as any,
      )
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-1',
          tool: 'Bash',
          toolUseId: 'tu-1',
          input: { command: 'sleep 999' },
          sessionId: 's1',
          timestamp: wireTimestamp,
        },
        ctx() as any,
      )
      handleMessage({ type: 'history_replay_end', sessionId: 's1' }, ctx() as any)
      const ss = (store.getState() as any).sessionStates.s1
      const toolMsg = ss.messages.find((m: any) => m.id === 'tool-1')
      expect(toolMsg).toBeDefined()
      expect(toolMsg.timestamp).toBe(wireTimestamp)
      // And the rebuilt activeTools entry must also use the wire timestamp.
      expect(ss.activeTools).toHaveLength(1)
      expect(ss.activeTools[0].startedAt).toBe(wireTimestamp)
    })
  })

  // #4493 — the replay flag must be scoped per-session. Pre-fix it was a
  // module-level boolean: once `history_replay_start` fired for session A,
  // every interleaved live event from session B (replayHistory chunks over
  // setImmediate, so live broadcasts can land between chunks) was treated
  // as replay and dropped its activity bump / activeTools clear.
  describe('replay flag is per-session (#4493)', () => {
    function seedTwoSessions(
      sA: Partial<ReturnType<typeof createEmptySessionState>> = {},
      sB: Partial<ReturnType<typeof createEmptySessionState>> = {},
    ) {
      store = createMockStore(baseState({
        activeSessionId: 'sA',
        sessions: [
          { sessionId: 'sA', name: 'A' } as any,
          { sessionId: 'sB', name: 'B' } as any,
        ],
        sessionStates: {
          sA: { ...createEmptySessionState(), ...sA },
          sB: { ...createEmptySessionState(), ...sB },
        },
      }))
      setStore(store)
    }

    it('live tool_start for session B bumps B during session A replay', () => {
      // Session A is mid-replay; an interleaved live tool_start for B must
      // still bump B.lastClientActivityAt. Pre-fix the module flag was true
      // (for A) so B's bump was suppressed.
      seedTwoSessions({ lastClientActivityAt: 100 }, { lastClientActivityAt: 100 })
      handleMessage({ type: 'history_replay_start', sessionId: 'sA' }, ctx() as any)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-b-1',
          tool: 'Bash',
          toolUseId: 'tu-b-1',
          input: { command: 'echo hi' },
          sessionId: 'sB',
        },
        ctx() as any,
      )
      const ssB = (store.getState() as any).sessionStates.sB
      expect(ssB.lastClientActivityAt).toBeGreaterThan(100)
    })

    it('replayed tool_start for session A still does NOT bump A', () => {
      // Sanity: per-session scoping must still suppress replayed events for
      // the actually-replaying session (the #4466 guarantee).
      seedTwoSessions({ lastClientActivityAt: 100 }, { lastClientActivityAt: 100 })
      handleMessage({ type: 'history_replay_start', sessionId: 'sA' }, ctx() as any)
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-a-1',
          tool: 'Bash',
          toolUseId: 'tu-a-1',
          input: { command: 'sleep' },
          sessionId: 'sA',
        },
        ctx() as any,
      )
      const ssA = (store.getState() as any).sessionStates.sA
      expect(ssA.lastClientActivityAt).toBe(100)
    })

    it('live result for session B still clears B.activeTools during A replay', () => {
      // Mirror of the #4491 gate, per-session: a live `result` for session
      // B during A's replay window must still run the #4308 turn-boundary
      // sweep on B.activeTools.
      const inFlightToolB = { toolUseId: 'tu-b-1', tool: 'Bash', input: { command: 'sleep' }, startedAt: 100 }
      seedTwoSessions({}, { activeTools: [inFlightToolB] })
      handleMessage({ type: 'history_replay_start', sessionId: 'sA' }, ctx() as any)
      handleMessage(
        { type: 'result', sessionId: 'sB', usage: {}, cost: 0, duration: 0 },
        ctx() as any,
      )
      const ssB = (store.getState() as any).sessionStates.sB
      expect(ssB.activeTools).toEqual([])
    })

    it('history_replay_end for A clears only A from the replaying set', () => {
      // With two sessions concurrently replaying, ending one must not
      // un-gate the other.
      seedTwoSessions({ lastClientActivityAt: 100 }, { lastClientActivityAt: 100 })
      handleMessage({ type: 'history_replay_start', sessionId: 'sA' }, ctx() as any)
      handleMessage({ type: 'history_replay_start', sessionId: 'sB' }, ctx() as any)
      handleMessage({ type: 'history_replay_end', sessionId: 'sA' }, ctx() as any)
      // sB is still replaying — a replayed tool_start for B must not bump.
      handleMessage(
        {
          type: 'tool_start',
          messageId: 'tool-b-1',
          tool: 'Bash',
          toolUseId: 'tu-b-1',
          input: { command: 'sleep' },
          sessionId: 'sB',
        },
        ctx() as any,
      )
      const ssB = (store.getState() as any).sessionStates.sB
      expect(ssB.lastClientActivityAt).toBe(100)
    })
  })

  // #4639 — the Working banner desyncs across tabs / remounts because
  // `sessionStates[id].isIdle` is initialised to `true` and only flipped by
  // local events (`agent_busy` / `agent_idle`). When a new tab opens, when
  // session_state is rebuilt for a previously-unobserved session, or when
  // the server tells us via `session_activity` that a session is still
  // in-flight, the dashboard must trust the server's authoritative `isBusy`
  // flag over the local default.
  describe('isIdle authoritative sync (#4639)', () => {
    it('session_list seeds isIdle from server isBusy for a brand new session entry', () => {
      // Fresh store with no session state for s1. session_list arrives with
      // isBusy: true (the server considers the session in-flight). Pre-fix
      // the dashboard would default isIdle to true and the Working banner
      // would not render until the next live event landed.
      store = createMockStore(baseState())
      setStore(store)
      handleMessage(
        {
          type: 'session_list',
          sessions: [
            { sessionId: 's1', name: 'S1', isBusy: true } as any,
          ],
        },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss).toBeDefined()
      expect(ss.isIdle).toBe(false)
    })

    it('session_list seeds isIdle: true for an idle session', () => {
      store = createMockStore(baseState())
      setStore(store)
      handleMessage(
        {
          type: 'session_list',
          sessions: [
            { sessionId: 's1', name: 'S1', isBusy: false } as any,
          ],
        },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.isIdle).toBe(true)
    })

    it('session_list resyncs isIdle on an existing session when server flips to busy', () => {
      // Tab swap path: the session state exists with isIdle: true (default
      // after createEmptySessionState), but the server is still in-flight.
      // A periodic session_list snapshot should correct the local state so
      // the banner re-appears for the user.
      store = createMockStore(
        baseState({
          sessionStates: {
            s1: { ...createEmptySessionState(), isIdle: true },
          },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'session_list',
          sessions: [
            { sessionId: 's1', name: 'S1', isBusy: true } as any,
          ],
        },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.isIdle).toBe(false)
    })

    it('session_list resyncs isIdle on an existing session when server flips to idle', () => {
      // The reverse case: a stuck local `isIdle: false` (e.g. missed an
      // agent_idle event) gets corrected on the next snapshot.
      store = createMockStore(
        baseState({
          sessionStates: {
            s1: { ...createEmptySessionState(), isIdle: false },
          },
        }),
      )
      setStore(store)
      handleMessage(
        {
          type: 'session_list',
          sessions: [
            { sessionId: 's1', name: 'S1', isBusy: false } as any,
          ],
        },
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.isIdle).toBe(true)
    })

    it('session_activity sets isIdle: false when server reports busy', () => {
      // The server already emits `session_activity` on stream_start / result
      // (ws-forwarding.js), but pre-fix the dashboard had no handler for it
      // — so peer-tab busy state never propagated. Wire it up.
      store = createMockStore(
        baseState({
          sessionStates: {
            s1: { ...createEmptySessionState(), isIdle: true },
          },
        }),
      )
      setStore(store)
      handleMessage(
        { type: 'session_activity', sessionId: 's1', isBusy: true } as any,
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.isIdle).toBe(false)
    })

    it('session_activity sets isIdle: true when server reports idle', () => {
      store = createMockStore(
        baseState({
          sessionStates: {
            s1: { ...createEmptySessionState(), isIdle: false },
          },
        }),
      )
      setStore(store)
      handleMessage(
        { type: 'session_activity', sessionId: 's1', isBusy: false } as any,
        ctx() as any,
      )
      const ss = (store.getState() as any).sessionStates.s1
      expect(ss.isIdle).toBe(true)
    })

    it('session_activity is a no-op when the session is not in sessionStates', () => {
      // Defensive: a session_activity for an unknown session must not crash
      // or create a phantom entry — the session_list path is responsible
      // for seeding new sessions.
      store = createMockStore(baseState())
      setStore(store)
      handleMessage(
        { type: 'session_activity', sessionId: 'unknown', isBusy: true } as any,
        ctx() as any,
      )
      const states = (store.getState() as any).sessionStates
      expect(states.unknown).toBeUndefined()
    })

    it('session_activity syncs the flat isIdle when the active session changes', () => {
      // When the active session's busy state changes, the flat-state mirror
      // (read by App.tsx's `isBusy={!isIdle}` props) must update too so the
      // Stop/Send button switches without a tab interaction.
      store = createMockStore(
        baseState({
          activeSessionId: 's1',
          sessionStates: {
            s1: { ...createEmptySessionState(), isIdle: true },
          },
          isIdle: true,
        } as any),
      )
      setStore(store)
      handleMessage(
        { type: 'session_activity', sessionId: 's1', isBusy: true } as any,
        ctx() as any,
      )
      expect((store.getState() as any).isIdle).toBe(false)
    })
  })
})

// #6767/#6827 — a 'files'-mode checkpoint restore keeps the CURRENT session, so
// the dispatch renders a visible system confirmation in the active session's
// transcript instead of re-homing (a silent files-only rewind looked like
// nothing happened client-side).
describe("checkpoint_restored (mode 'files') confirmation (#6827)", () => {
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
    mockSocket = createMockSocket()
  })

  it('appends a files-restored system message to the active session and does not switch', () => {
    const switchSession = vi.fn()
    store = createMockStore(
      baseState({
        activeSessionId: 's1',
        sessions: [{ sessionId: 's1', name: 'S1' } as any],
        sessionStates: { s1: { ...createEmptySessionState(), messages: [] } },
        switchSession,
      } as any),
    )
    setStore(store)

    handleMessage(
      {
        type: 'checkpoint_restored',
        checkpointId: 'cp-1',
        mode: 'files',
        filesOnly: true,
        name: 'Before refactor',
      } as any,
      ctx() as any,
    )

    expect(switchSession).not.toHaveBeenCalled()
    const ss = (store.getState() as any).sessionStates.s1
    expect(ss.messages).toHaveLength(1)
    expect(ss.messages[0]).toMatchObject({
      type: 'system',
      content: 'Files restored to checkpoint "Before refactor"',
    })
  })

  // #6823 — file_list populates the @-picker (files) and mcpResources.
  describe('file_list dispatch', () => {
    it('populates filePickerFiles and mcpResources', () => {
      handleMessage(
        {
          type: 'file_list',
          files: [{ path: 'src/index.ts', type: 'file', size: 10 }],
          resources: [{ uri: 'file:///notes.md', name: 'Notes', server: 'stub', mimeType: 'text/markdown' }],
          error: null,
        } as any,
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.filePickerFiles).toEqual([{ path: 'src/index.ts', type: 'file', size: 10 }])
      expect(state.mcpResources).toEqual([
        { uri: 'file:///notes.md', name: 'Notes', description: undefined, mimeType: 'text/markdown', server: 'stub' },
      ])
    })

    it('defaults mcpResources to [] when the server omits resources', () => {
      handleMessage(
        { type: 'file_list', files: [], error: null } as any,
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.filePickerFiles).toEqual([])
      expect(state.mcpResources).toEqual([])
    })

    it('falls back a resource name to its uri when name is missing', () => {
      handleMessage(
        { type: 'file_list', files: [], resources: [{ uri: 'db://users', server: 'stub' }], error: null } as any,
        ctx() as any,
      )
      const state = store.getState() as any
      expect(state.mcpResources[0].name).toBe('db://users')
    })
  })
})
