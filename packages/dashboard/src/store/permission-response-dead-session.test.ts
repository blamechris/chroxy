/**
 * #7466 — answering a permission must never make a session that no longer
 * exists the active one.
 *
 * `sendPermissionResponse` auto-switches to the session that owns the prompt, so
 * an operator who answers a cross-session banner lands on the asking session.
 * The owner id is looked up from `sessionNotifications` (falling back to a scan
 * of `sessionStates`) — and BOTH of those outlive the session itself:
 * `sessionNotifications` is never pruned when a session closes, and
 * `sessionStates` keeps a closed session's transcript. `switchSession` then
 * writes `activeSessionId` unconditionally, with no membership check against
 * `sessions`.
 *
 * So clicking Allow/Deny on a STALE prompt — one whose session is gone after a
 * close or a daemon restart that regenerated ids — points `activeSessionId` at
 * an id no tab carries. `SessionBar` marks a tab active purely by
 * `s.sessionId === activeSessionId` (App.tsx), so the whole strip renders with
 * NOTHING selected: the wedged tab bar in the dogfood report.
 *
 * The guard is a membership check, not a "don't switch" rule — the legitimate
 * cross-session jump is the whole point of the feature and is pinned below as
 * the positive control.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import type { SessionInfo, SessionNotification } from './types'

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

function makeSession(sessionId: string, name: string): SessionInfo {
  return {
    sessionId,
    name,
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

function permissionNotification(sessionId: string, requestId: string): SessionNotification {
  return {
    id: `n-${requestId}`,
    sessionId,
    sessionName: sessionId,
    eventType: 'permission',
    message: 'Bash: rm -rf /tmp/x',
    timestamp: Date.now(),
    requestId,
  }
}

beforeEach(() => {
  vi.resetModules()
  vi.spyOn(console, 'warn').mockImplementation(() => {})
})
afterEach(() => {
  vi.restoreAllMocks()
})

describe('#7466 — sendPermissionResponse auto-switch is membership-checked', () => {
  it('does NOT switch to a prompt owner that is absent from `sessions` (notification lookup)', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const sent: unknown[] = []
    useConnectionStore.setState({
      socket: liveSocket(sent),
      activeSessionId: 'sess-live',
      sessions: [makeSession('sess-live', 'Chroxy')],
      // The banner outlived its session: `sessionNotifications` is not pruned on
      // close, so the row still names the dead id.
      sessionNotifications: [permissionNotification('sess-dead', 'req-stale')],
      sessionStates: { 'sess-live': createEmptySessionState() },
      messages: [],
    })

    useConnectionStore.getState().sendPermissionResponse('req-stale', 'allow')

    expect(useConnectionStore.getState().activeSessionId).toBe('sess-live')
    // Nothing may have been asked of the server about the dead session either.
    expect(sent.some((m) => (m as { type?: string }).type === 'switch_session')).toBe(false)
  })

  it('does NOT switch to a prompt owner that is absent from `sessions` (sessionStates scan)', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const sent: unknown[] = []
    useConnectionStore.setState({
      socket: liveSocket(sent),
      activeSessionId: 'sess-live',
      sessions: [makeSession('sess-live', 'Chroxy')],
      sessionNotifications: [],
      sessionStates: {
        'sess-live': createEmptySessionState(),
        // A closed session's transcript is retained in sessionStates, so the
        // fallback scan finds the prompt under an id that has no tab.
        'sess-dead': {
          ...createEmptySessionState(),
          messages: [
            {
              id: 'm-1',
              type: 'prompt',
              content: 'Bash: rm -rf /tmp/x',
              timestamp: 1,
              requestId: 'req-stale',
              expiresAt: Date.now() + 60_000,
            },
          ],
        },
      },
      messages: [],
    })

    useConnectionStore.getState().sendPermissionResponse('req-stale', 'allow')

    expect(useConnectionStore.getState().activeSessionId).toBe('sess-live')
    expect(sent.some((m) => (m as { type?: string }).type === 'switch_session')).toBe(false)
  })

  it('POSITIVE CONTROL: still switches to a prompt owner that IS in `sessions`', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const sent: unknown[] = []
    useConnectionStore.setState({
      socket: liveSocket(sent),
      activeSessionId: 'sess-live',
      sessions: [makeSession('sess-live', 'Chroxy'), makeSession('sess-other', 'DockKeeper')],
      sessionNotifications: [permissionNotification('sess-other', 'req-live')],
      sessionStates: {
        'sess-live': createEmptySessionState(),
        'sess-other': createEmptySessionState(),
      },
      messages: [],
    })

    useConnectionStore.getState().sendPermissionResponse('req-live', 'allow')

    expect(useConnectionStore.getState().activeSessionId).toBe('sess-other')
    expect(sent.some((m) => (m as { type?: string }).type === 'switch_session')).toBe(true)
  })

  it('POSITIVE CONTROL: the permission_response itself is still sent for a stale prompt', async () => {
    // The membership check gates NAVIGATION only. The answer still goes to the
    // server, which is the authority on whether the request is still pending —
    // suppressing the send here would invent a second, client-side notion of
    // "already handled" (#7390's one-signal rule).
    const { useConnectionStore, createEmptySessionState } = await import('./connection')
    const sent: unknown[] = []
    useConnectionStore.setState({
      socket: liveSocket(sent),
      activeSessionId: 'sess-live',
      sessions: [makeSession('sess-live', 'Chroxy')],
      sessionNotifications: [permissionNotification('sess-dead', 'req-stale')],
      sessionStates: { 'sess-live': createEmptySessionState() },
      messages: [],
    })

    useConnectionStore.getState().sendPermissionResponse('req-stale', 'allow')

    const responses = sent.filter((m) => (m as { type?: string }).type === 'permission_response')
    expect(responses).toHaveLength(1)
    expect(responses[0]).toMatchObject({ requestId: 'req-stale', decision: 'allow' })
  })
})
