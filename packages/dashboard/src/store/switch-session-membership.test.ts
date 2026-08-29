/**
 * #7475 — `switchSession` is the ONE place that decides whether a target id may
 * become `activeSessionId`.
 *
 * #7472 proved the mechanism and fixed it at a single call site (the permission
 * auto-switch in `sendPermissionResponse`). `switchSession` itself still wrote
 * `activeSessionId` unconditionally, so every OTHER caller could still hand it
 * an id absent from `sessions` — and `SessionBar` marks a tab active purely by
 * `s.sessionId === activeSessionId`, so a dangling id renders the whole strip
 * with nothing selected and no way back except clicking a tab.
 *
 * That is the "a guard wired to only some of its callers, correct for every
 * input it sees and never reached by the rest" family in
 * docs/false-safety-guards.md (#7262). The remedy is a choke point, not another
 * copy of the one-line check.
 *
 * WHY IT IS A TWO-DOOR SHAPE, not a blanket guard: the checkpoint-restore path
 * legitimately switches to a session BEFORE the roster confirms it — the server
 * creates the new session and re-homes the client onto it, and `session_list`
 * follows. A blanket membership check would silently strand every restore. So
 * the default door checks membership and the restore path opts out EXPLICITLY,
 * which is also what makes the opt-out greppable: `allowUnlisted` appears in the
 * codebase exactly where a caller has argued for it.
 *
 * The matrix below has one cell per caller, because the whole defect class is
 * "the guard was correct for the callers it had". The callers, from #7475's own
 * enumeration plus one it did not have:
 *
 *   1. sendPermissionResponse auto-switch        default door  (#7472's cell)
 *   2. OrchestrationRunsSection "Open session"   default door  (SwitchSessionCallSites.test.tsx)
 *   3. ControlRoomView jump-to-intervene         default door  (SwitchSessionCallSites.test.tsx)
 *   4. switchToRestoredSession (checkpoint)      OPT-OUT       (below)
 *   5. client_focus_changed follow-mode          default door  (below)
 *
 * Caller 5 is the phantom fifth #7475's table does not list, and it was NOT
 * covered by accident: `dispatchClientFocusChanged` gates on
 * `adapter.hasSession(id)`, which the dashboard backs with
 * `!!sessionStates[id]` — the very map #7472 identified as one that OUTLIVES the
 * session (it retains a closed session's transcript). So follow-mode had a
 * membership check against the wrong roster, which is the most expensive kind:
 * it looks handled.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { ConnectionState, SessionInfo } from './types'

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

function liveSocket(sent: unknown[]): WebSocket {
  return {
    send: vi.fn((raw: string) => {
      try {
        sent.push(JSON.parse(raw))
      } catch {
        /* noop */
      }
    }),
    close: vi.fn(),
    readyState: WebSocket.OPEN,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

function makeSession(sessionId: string): SessionInfo {
  return {
    sessionId,
    name: sessionId,
    cwd: '/tmp',
    type: 'cli',
    hasTerminal: false,
    model: null,
    permissionMode: null,
    isBusy: false,
    createdAt: 1,
    conversationId: null,
  } as SessionInfo
}

beforeEach(() => {
  vi.resetModules()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

// ---------------------------------------------------------------------------
// The choke point itself
// ---------------------------------------------------------------------------

describe('#7475 — switchSession membership-checks by default', () => {
  it('does NOT make an id absent from `sessions` the active one', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const sent: unknown[] = []
    useConnectionStore.setState({
      socket: liveSocket(sent),
      activeSessionId: 'sess-live',
      sessions: [makeSession('sess-live')],
      // The transcript for the dead session is still cached — that is exactly
      // the state that made the old code look safe: `sessionStates` has it.
      sessionStates: {
        'sess-live': createEmptySessionState(),
        'sess-dead': createEmptySessionState(),
      },
    } as unknown as Partial<ConnectionState>)

    useConnectionStore.getState().switchSession('sess-dead')

    expect(useConnectionStore.getState().activeSessionId).toBe('sess-live')
    // And nothing went on the wire: the server must not be told to switch to a
    // session this client has already decided it cannot show.
    expect(sent.filter((m) => (m as { type?: string }).type === 'switch_session')).toEqual([])
  })

  it('POSITIVE CONTROL: an id present in `sessions` still becomes active', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const sent: unknown[] = []
    useConnectionStore.setState({
      socket: liveSocket(sent),
      activeSessionId: 'sess-a',
      sessions: [makeSession('sess-a'), makeSession('sess-b')],
      sessionStates: { 'sess-a': createEmptySessionState(), 'sess-b': createEmptySessionState() },
    } as unknown as Partial<ConnectionState>)

    useConnectionStore.getState().switchSession('sess-b')

    expect(useConnectionStore.getState().activeSessionId).toBe('sess-b')
    expect(sent.filter((m) => (m as { type?: string }).type === 'switch_session')).toHaveLength(1)
  })

  it('POSITIVE CONTROL: a session with NO cached state still switches when rostered', async () => {
    // The uncached branch writes a different `set({...})` — both branches must
    // sit behind the same gate, and the gate must not be mistaken for "has a
    // cached transcript".
    const { useConnectionStore } = await import('./connection')
    const sent: unknown[] = []
    useConnectionStore.setState({
      socket: liveSocket(sent),
      activeSessionId: 'sess-a',
      sessions: [makeSession('sess-a'), makeSession('sess-fresh')],
      sessionStates: {},
    } as unknown as Partial<ConnectionState>)

    useConnectionStore.getState().switchSession('sess-fresh')

    expect(useConnectionStore.getState().activeSessionId).toBe('sess-fresh')
  })

  it('the OPT-OUT door switches to an unlisted id, on purpose', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: unknown[] = []
    useConnectionStore.setState({
      socket: liveSocket(sent),
      activeSessionId: 'sess-a',
      sessions: [makeSession('sess-a')],
      sessionStates: {},
    } as unknown as Partial<ConnectionState>)

    useConnectionStore.getState().switchSession('sess-ahead-of-roster', { allowUnlisted: true })

    expect(useConnectionStore.getState().activeSessionId).toBe('sess-ahead-of-roster')
  })

  it('a REFUSED switch performs none of the switch side effects', async () => {
    // The clears (`sessionNotFoundError`, the permission-audit pull, the memory
    // stack) all belong to "we are now looking at a different session". Running
    // them for a switch that did not happen would wipe the CURRENT session's
    // panels — a refusal has to be inert, not half-applied.
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    useConnectionStore.setState({
      socket: liveSocket([]),
      activeSessionId: 'sess-live',
      sessions: [makeSession('sess-live')],
      sessionStates: { 'sess-live': createEmptySessionState() },
      sessionNotFoundError: 'sess-dead is gone',
      permissionAudit: [{ id: 'a1' }],
      memoryStackEntries: [{ id: 'm1' }],
      sessionNotifications: [
        {
          id: 'n-1',
          sessionId: 'sess-dead',
          sessionName: 'dead',
          eventType: 'permission',
          message: 'x',
          timestamp: 1,
          requestId: 'r-1',
        },
      ],
    } as unknown as Partial<ConnectionState>)

    useConnectionStore.getState().switchSession('sess-dead')

    const s = useConnectionStore.getState()
    expect(s.sessionNotFoundError).toBe('sess-dead is gone')
    expect(s.permissionAudit).not.toBeNull()
    expect(s.memoryStackEntries).not.toBeNull()
    // Notifications for the refused target must NOT be marked read — the
    // operator never saw that session, so the alert is still unacknowledged.
    expect(s.sessionNotifications[0]!.readAt).toBeUndefined()
  })

  it('POSITIVE CONTROL: an ACCEPTED switch does perform them', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    useConnectionStore.setState({
      socket: liveSocket([]),
      activeSessionId: 'sess-a',
      sessions: [makeSession('sess-a'), makeSession('sess-b')],
      sessionStates: { 'sess-a': createEmptySessionState(), 'sess-b': createEmptySessionState() },
      sessionNotFoundError: 'stale banner',
      permissionAudit: [{ id: 'a1' }],
      memoryStackEntries: [{ id: 'm1' }],
      sessionNotifications: [
        {
          id: 'n-1',
          sessionId: 'sess-b',
          sessionName: 'b',
          eventType: 'permission',
          message: 'x',
          timestamp: 1,
          requestId: 'r-1',
        },
      ],
    } as unknown as Partial<ConnectionState>)

    useConnectionStore.getState().switchSession('sess-b')

    const s = useConnectionStore.getState()
    expect(s.sessionNotFoundError).toBeNull()
    expect(s.permissionAudit).toBeNull()
    expect(s.memoryStackEntries).toBeNull()
    expect(s.sessionNotifications[0]!.readAt).toEqual(expect.any(Number))
  })
})

// ---------------------------------------------------------------------------
// The RETURN contract
//
// Added because a mutant survived without it. `switchSession` returning `true`
// on a refusal was killed by nothing: App.test.tsx proves App does the right
// thing GIVEN a `false`, and the tests above prove the store refuses — but the
// seam between them, "the store says so out loud", was asserted by neither. The
// consequence of that gap is not cosmetic: App's `isSwitchingSession` blanks the
// entire content area until `activeSessionId` changes, so a refusal reported as
// success wedges the dashboard on a skeleton with no way out but another tab.
// ---------------------------------------------------------------------------

describe('#7475 — switchSession REPORTS what it did', () => {
  it('returns false when it refuses an unrostered target', async () => {
    const { useConnectionStore } = await import('./connection')
    useConnectionStore.setState({
      socket: liveSocket([]),
      activeSessionId: 'sess-live',
      sessions: [makeSession('sess-live')],
      sessionStates: {},
    } as unknown as Partial<ConnectionState>)

    expect(useConnectionStore.getState().switchSession('sess-dead')).toBe(false)
  })

  it('returns true when the switch happened', async () => {
    const { useConnectionStore } = await import('./connection')
    useConnectionStore.setState({
      socket: liveSocket([]),
      activeSessionId: 'sess-a',
      sessions: [makeSession('sess-a'), makeSession('sess-b')],
      sessionStates: {},
    } as unknown as Partial<ConnectionState>)

    expect(useConnectionStore.getState().switchSession('sess-b')).toBe(true)
  })

  it('returns true for the already-active no-op — the caller got what it asked for', async () => {
    // Not a refusal: the requested session IS the active one. Reporting false
    // here would make App treat an ordinary re-click as a failure.
    const { useConnectionStore } = await import('./connection')
    useConnectionStore.setState({
      socket: liveSocket([]),
      activeSessionId: 'sess-a',
      sessions: [makeSession('sess-a')],
      sessionStates: {},
    } as unknown as Partial<ConnectionState>)

    expect(useConnectionStore.getState().switchSession('sess-a')).toBe(true)
  })

  it('returns true through the opt-out door', async () => {
    const { useConnectionStore } = await import('./connection')
    useConnectionStore.setState({
      socket: liveSocket([]),
      activeSessionId: 'sess-a',
      sessions: [makeSession('sess-a')],
      sessionStates: {},
    } as unknown as Partial<ConnectionState>)

    expect(
      useConnectionStore.getState().switchSession('sess-new', { allowUnlisted: true }),
    ).toBe(true)
  })
})

// ---------------------------------------------------------------------------
// Matrix cell 1 — the permission auto-switch (#7472's call site)
// ---------------------------------------------------------------------------

describe('#7475 cell 1 — sendPermissionResponse auto-switch', () => {
  it('still refuses a dead prompt owner once the check lives at the choke point', async () => {
    // #7472 put the check inline here. Moving the decision into `switchSession`
    // must not lose it — this is the regression that "one predicate" risks.
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const sent: unknown[] = []
    useConnectionStore.setState({
      socket: liveSocket(sent),
      activeSessionId: 'sess-live',
      sessions: [makeSession('sess-live')],
      sessionStates: {
        'sess-live': createEmptySessionState(),
        'sess-dead': createEmptySessionState(),
      },
      sessionNotifications: [
        {
          id: 'n-1',
          sessionId: 'sess-dead',
          sessionName: 'dead',
          eventType: 'permission',
          message: 'Bash: rm -rf /tmp/x',
          timestamp: 1,
          requestId: 'req-1',
        },
      ],
    } as unknown as Partial<ConnectionState>)

    useConnectionStore.getState().sendPermissionResponse('req-1', 'allow')

    expect(useConnectionStore.getState().activeSessionId).toBe('sess-live')
    // The answer itself still goes to the server — the server stays the
    // authority on whether the request is pending (#7472).
    expect(sent.filter((m) => (m as { type?: string }).type === 'permission_response')).toHaveLength(1)
  })

  it('POSITIVE CONTROL: a LIVE prompt owner is still jumped to', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const sent: unknown[] = []
    useConnectionStore.setState({
      socket: liveSocket(sent),
      activeSessionId: 'sess-a',
      sessions: [makeSession('sess-a'), makeSession('sess-owner')],
      sessionStates: { 'sess-a': createEmptySessionState(), 'sess-owner': createEmptySessionState() },
      sessionNotifications: [
        {
          id: 'n-1',
          sessionId: 'sess-owner',
          sessionName: 'owner',
          eventType: 'permission',
          message: 'Bash: rm -rf /tmp/x',
          timestamp: 1,
          requestId: 'req-1',
        },
      ],
    } as unknown as Partial<ConnectionState>)

    useConnectionStore.getState().sendPermissionResponse('req-1', 'allow')

    expect(useConnectionStore.getState().activeSessionId).toBe('sess-owner')
  })
})

// ---------------------------------------------------------------------------
// Matrix cells 4 and 5 — the two server-driven callers, through handleMessage
// ---------------------------------------------------------------------------

describe('#7475 cells 4 & 5 — the server-driven callers', () => {
  async function wireRealStore() {
    const connection = await import('./connection')
    const mh = await import('./message-handler')
    mh.setStore(connection.useConnectionStore as never)
    return { ...connection, ...mh }
  }

  const ctx = (socket: WebSocket) =>
    ({ url: 'wss://t', token: 'tok', socket, isReconnect: false, silent: false }) as never

  it('cell 4 (OPT-OUT): checkpoint_restored switches to a session the roster has NOT got yet', async () => {
    // The server just created this session and re-homed us onto it;
    // `session_list` has not arrived. Refusing here would strand every restore,
    // which is why this caller opts out explicitly.
    const { useConnectionStore, handleMessage, stopHeartbeat, clearDeltaBuffers } = await wireRealStore()
    const socket = liveSocket([])
    useConnectionStore.setState({
      socket,
      connectionPhase: 'connected',
      activeSessionId: 'sess-old',
      sessions: [makeSession('sess-old')],
      sessionStates: {},
    } as unknown as Partial<ConnectionState>)

    handleMessage(
      { type: 'checkpoint_restored', checkpointId: 'cp-1', newSessionId: 'sess-restored' },
      ctx(socket),
    )

    expect(useConnectionStore.getState().activeSessionId).toBe('sess-restored')
    stopHeartbeat()
    clearDeltaBuffers()
  })

  it('cell 5 (DEFAULT): follow-mode does NOT follow another client onto an unrostered session', async () => {
    // The phantom fifth caller. `dispatchClientFocusChanged` gates on
    // `hasSession`, which the dashboard backs with `sessionStates` — a map that
    // outlives the session. Seed exactly that shape: cached transcript present,
    // roster entry gone.
    const { useConnectionStore, createEmptySessionState, handleMessage, stopHeartbeat, clearDeltaBuffers } =
      await wireRealStore()
    const socket = liveSocket([])
    useConnectionStore.setState({
      socket,
      connectionPhase: 'connected',
      activeSessionId: 'sess-live',
      myClientId: 'me',
      followMode: true,
      sessions: [makeSession('sess-live')],
      sessionStates: {
        'sess-live': createEmptySessionState(),
        'sess-dead': createEmptySessionState(),
      },
    } as unknown as Partial<ConnectionState>)

    handleMessage(
      { type: 'client_focus_changed', clientId: 'other', sessionId: 'sess-dead' },
      ctx(socket),
    )

    expect(useConnectionStore.getState().activeSessionId).toBe('sess-live')
    stopHeartbeat()
    clearDeltaBuffers()
  })

  it('cell 5 POSITIVE CONTROL: follow-mode still follows onto a ROSTERED session', async () => {
    const { useConnectionStore, createEmptySessionState, handleMessage, stopHeartbeat, clearDeltaBuffers } =
      await wireRealStore()
    const socket = liveSocket([])
    useConnectionStore.setState({
      socket,
      connectionPhase: 'connected',
      activeSessionId: 'sess-live',
      myClientId: 'me',
      followMode: true,
      sessions: [makeSession('sess-live'), makeSession('sess-peer')],
      sessionStates: {
        'sess-live': createEmptySessionState(),
        'sess-peer': createEmptySessionState(),
      },
    } as unknown as Partial<ConnectionState>)

    handleMessage(
      { type: 'client_focus_changed', clientId: 'other', sessionId: 'sess-peer' },
      ctx(socket),
    )

    expect(useConnectionStore.getState().activeSessionId).toBe('sess-peer')
    stopHeartbeat()
    clearDeltaBuffers()
  })
})
