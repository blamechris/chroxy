/**
 * #9222 — a permission banner for a session that left THIS client's roster must
 * not keep live Allow/Deny.
 *
 * `permissionNotificationStatus` is conservative on absence ("no prompt found"
 * means pending, so a banner that predates its prompt's hydration stays
 * answerable). The `session_list` prune deletes `sessionStates[id]` while
 * `sessionNotifications` survives as history, so the two became
 * indistinguishable. The store now stamps `sessionUnavailableAt` on rows whose
 * session it WATCHED leave the roster. A removal may be a scope change rather
 * than a close, so the wording is "unavailable to this client"; only an explicit
 * `session_timeout` is definitive (`sessionEndedAt`). Recovery is
 * request-specific: only a validated `permission_request` for the SAME
 * (session, request) lifts it, never a session reappearing and never an ended
 * row. These tests pin render, click-time, send-time and recovery behavior plus
 * the controls that must not change.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import {
  NotificationBanners,
  permissionNotificationStatus,
  type PermissionBannerStatus,
} from './NotificationBanners'
import { markSessionNotificationsUnavailable, keptWhenReplacing } from '../store/utils'
import type { SessionNotification } from '../store/types'

vi.mock('../store/crypto', () => ({
  createKeyPair: vi.fn(() => ({ publicKey: 'mock-pub', secretKey: 'mock-sec' })),
  deriveSharedKey: vi.fn(),
  encrypt: vi.fn(),
  decrypt: vi.fn(),
  generateConnectionSalt: vi.fn(() => 'mock-salt'),
  deriveConnectionKey: vi.fn(() => new Uint8Array(32)),
  DIRECTION_CLIENT: 0,
  DIRECTION_SERVER: 1,
}))

afterEach(cleanup)

const NOW = 1_700_000_000_000

function notification(overrides: Partial<SessionNotification> = {}): SessionNotification {
  return {
    id: 'n-1',
    sessionId: 'sess-1',
    sessionName: 'Chroxy',
    eventType: 'permission',
    message: 'Bash: ls',
    timestamp: NOW - 1000,
    requestId: 'req-abc',
    ...overrides,
  }
}

function renderBanner(
  n: SessionNotification,
  status: (n: SessionNotification) => PermissionBannerStatus,
  handlers: { onApprove?: () => void; onDeny?: () => void; onMarkRead?: () => void; onDismiss?: () => void } = {},
) {
  return render(
    <NotificationBanners
      notifications={[n]}
      onApprove={handlers.onApprove ?? vi.fn()}
      onDeny={handlers.onDeny ?? vi.fn()}
      onDismiss={handlers.onDismiss ?? vi.fn()}
      onMarkRead={handlers.onMarkRead ?? vi.fn()}
      onSwitchSession={vi.fn()}
      permissionStatus={status}
      isSessionListed={() => false}
      isSessionStarting={() => false}
    />,
  )
}

describe('#9222 — permissionNotificationStatus', () => {
  it("is 'session-unavailable' for an unavailable-stamped row with no prompt in sessionStates", () => {
    expect(
      permissionNotificationStatus(notification({ sessionUnavailableAt: NOW }), {}, NOW, true),
    ).toBe('session-unavailable')
  })

  it("is 'session-unavailable' for an ended row, and stays so while disconnected", () => {
    const ended = notification({ sessionUnavailableAt: NOW, sessionEndedAt: NOW })
    expect(permissionNotificationStatus(ended, {}, NOW, true)).toBe('session-unavailable')
    expect(permissionNotificationStatus(ended, {}, NOW, false)).toBe('session-unavailable')
  })

  it("HYDRATION CONTROL: an UNstamped row with no prompt yet is still 'actionable'", () => {
    expect(permissionNotificationStatus(notification(), {}, NOW, true)).toBe('actionable')
  })

  it("CONTROL: an UNstamped row, disconnected, is still 'disconnected'", () => {
    expect(permissionNotificationStatus(notification(), {}, NOW, false)).toBe('disconnected')
  })

  it('CONTROL: a non-permission alert is unaffected by the stamp', () => {
    expect(
      permissionNotificationStatus(
        notification({ eventType: 'completed', requestId: undefined, sessionUnavailableAt: NOW }),
        {},
        NOW,
        true,
      ),
    ).toBe('actionable')
  })
})

describe('#9222 — banner render', () => {
  it('renders no Allow/Deny, uses the NEUTRAL wording, and keeps the row as a record', () => {
    renderBanner(notification({ sessionUnavailableAt: NOW }), () => 'session-unavailable')
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull()
    const label = screen.getByTestId('notification-banner-session-unavailable').textContent ?? ''
    expect(label).toMatch(/unavailable to this client/)
    expect(/closed/i.test(label)).toBe(false)
    expect(screen.getByText('Bash: ls')).toBeTruthy()
    expect(screen.getByTestId('notification-banner-session-name').textContent).toBe('Chroxy')
  })

  it('an ended row says "ended" (definitive), not "unavailable"', () => {
    renderBanner(
      notification({ sessionUnavailableAt: NOW, sessionEndedAt: NOW }),
      () => 'session-unavailable',
    )
    expect(screen.getByTestId('notification-banner-session-unavailable').textContent).toMatch(/ended/)
  })

  it('Dismiss on a retired row marks it read (keeps history), never removes it', () => {
    const onMarkRead = vi.fn()
    const onDismiss = vi.fn()
    renderBanner(notification({ sessionUnavailableAt: NOW }), () => 'session-unavailable', {
      onMarkRead,
      onDismiss,
    })
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onMarkRead).toHaveBeenCalledWith('n-1')
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('CONTROL: a genuinely pending row keeps Allow/Deny', () => {
    renderBanner(notification(), () => 'actionable')
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()
    expect(screen.queryByTestId('notification-banner-session-unavailable')).toBeNull()
  })
})

describe('#9222 — click race: rendered actionable, session removed before the click', () => {
  for (const [label, name, handler] of [
    ['Allow', 'Allow', 'onApprove'],
    ['Deny', 'Deny', 'onDeny'],
  ] as const) {
    it(`${label}: the click-time re-check refuses and redraws as unavailable`, () => {
      let status: PermissionBannerStatus = 'actionable'
      const fn = vi.fn()
      renderBanner(notification(), () => status, { [handler]: fn })
      status = 'session-unavailable'
      fireEvent.click(screen.getByRole('button', { name }))
      expect(fn).not.toHaveBeenCalled()
      expect(screen.queryByRole('button', { name })).toBeNull()
      expect(screen.getByTestId('notification-banner-session-unavailable')).toBeTruthy()
    })
  }
})

describe('#9222 — helpers', () => {
  it('markSessionNotificationsUnavailable stamps only removed sessions and keeps the rows', () => {
    const rows = [
      notification({ id: 'a', sessionId: 'gone' }),
      notification({ id: 'b', sessionId: 'live' }),
    ]
    const out = markSessionNotificationsUnavailable(rows, ['gone'], NOW)
    expect(out).toHaveLength(2)
    expect(out?.[0]?.sessionUnavailableAt).toBe(NOW)
    expect(out?.[0]?.sessionEndedAt).toBeUndefined()
    expect(out?.[1]?.sessionUnavailableAt).toBeUndefined()
  })

  it('ended=true marks the row definitive, upgrading an already-unavailable row', () => {
    const rows = [notification({ sessionId: 'gone', sessionUnavailableAt: 5 })]
    const out = markSessionNotificationsUnavailable(rows, ['gone'], NOW, true)
    expect(out?.[0]?.sessionUnavailableAt).toBe(5)
    expect(out?.[0]?.sessionEndedAt).toBe(NOW)
  })

  it('returns the SAME array when nothing matches or nothing is new, and tolerates undefined', () => {
    const live = [notification({ sessionId: 'live' })]
    expect(markSessionNotificationsUnavailable(live, ['gone'], NOW)).toBe(live)
    expect(markSessionNotificationsUnavailable(live, [], NOW)).toBe(live)
    const stamped = [notification({ sessionId: 'gone', sessionUnavailableAt: 5 })]
    expect(markSessionNotificationsUnavailable(stamped, ['gone'], NOW)).toBe(stamped)
    expect(markSessionNotificationsUnavailable(undefined, ['gone'], NOW)).toBeUndefined()
  })

  it('keptWhenReplacing keeps a retired row for ANOTHER request (as read history)', () => {
    const rows = [notification({ id: 'old', requestId: 'req-old', sessionUnavailableAt: 5 })]
    const kept = keptWhenReplacing(rows, 'sess-1', 'permission', 'req-new', NOW)
    expect(kept).toHaveLength(1)
    expect(kept[0]?.requestId).toBe('req-old')
    expect(kept[0]?.readAt).toBe(NOW)
  })

  it('keptWhenReplacing drops an UNstamped same-kind row (existing dedup is unchanged)', () => {
    const rows = [notification({ id: 'old', requestId: 'req-old' })]
    expect(keptWhenReplacing(rows, 'sess-1', 'permission', 'req-new', NOW)).toHaveLength(0)
  })

  it('keptWhenReplacing never drops an ENDED row, even for the same request id', () => {
    const rows = [
      notification({ requestId: 'req-abc', sessionUnavailableAt: 5, sessionEndedAt: 5 }),
    ]
    expect(keptWhenReplacing(rows, 'sess-1', 'permission', 'req-abc', NOW)).toHaveLength(1)
  })
})

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

const CTX = { url: 'wss://t', token: 'tok', socket: null, isReconnect: false, silent: false } as never
const permissionSends = (sent: unknown[]) =>
  sent.filter((m) => (m as { type?: string }).type === 'permission_response')

describe('#9222 — store: stamping, send guard, exact-request recovery', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  async function seed(rows: SessionNotification[]) {
    const { useConnectionStore, createEmptySessionState } = await import('../store/connection')
    const mh = await import('../store/message-handler')
    const sent: unknown[] = []
    useConnectionStore.setState({
      socket: liveSocket(sent),
      activeSessionId: 'sess-live',
      sessions: [
        { sessionId: 'sess-live', name: 'Live' },
        { sessionId: 'sess-1', name: 'Chroxy' },
      ] as never,
      sessionStates: {
        'sess-live': createEmptySessionState(),
        'sess-1': createEmptySessionState(),
      },
      sessionNotifications: rows,
    })
    return { store: useConnectionStore, mh, sent }
  }

  const permissionRequest = (sessionId: string, requestId: string) => ({
    type: 'permission_request',
    sessionId,
    requestId,
    tool: 'Bash',
    description: 'ls',
    input: { command: 'ls' },
  })

  it('sendPermissionResponse sends nothing for an unavailable request and keeps the row', async () => {
    const { store, sent } = await seed([notification({ sessionUnavailableAt: NOW })])
    expect(store.getState().sendPermissionResponse('req-abc', 'allow')).toBe(false)
    expect(permissionSends(sent)).toHaveLength(0)
    expect(store.getState().sessionNotifications).toHaveLength(1)
  })

  it('CONTROL: an unstamped row still sends', async () => {
    const { store, sent } = await seed([notification()])
    expect(store.getState().sendPermissionResponse('req-abc', 'allow')).not.toBe(false)
    expect(permissionSends(sent)).toHaveLength(1)
  })

  it('send race: stamped between render and click, the fresh store read refuses', async () => {
    const row = notification()
    const { store, sent } = await seed([row])
    store.setState({ sessionNotifications: [{ ...row, sessionUnavailableAt: NOW }] })
    expect(store.getState().sendPermissionResponse('req-abc', 'deny')).toBe(false)
    expect(permissionSends(sent)).toHaveLength(0)
  })

  it('a session_list that drops the session stamps its alert (unavailable, NOT ended) and keeps history', async () => {
    const { store, mh } = await seed([
      notification(),
      notification({ id: 'n-live', sessionId: 'sess-live', requestId: 'req-live' }),
    ])
    mh.handleMessage({ type: 'session_list', sessions: [{ sessionId: 'sess-live', name: 'Live' }] }, CTX)
    const rows = store.getState().sessionNotifications
    expect(rows).toHaveLength(2)
    const dropped = rows.find((r) => r.id === 'n-1')
    expect(dropped?.sessionUnavailableAt).toBeTypeOf('number')
    expect(dropped?.sessionEndedAt).toBeUndefined()
    expect(rows.find((r) => r.id === 'n-live')?.sessionUnavailableAt).toBeUndefined()
  })

  it('session_timeout stamps the alert as ENDED and a same-request replay does not recover it', async () => {
    const { store, mh, sent } = await seed([notification(), notification({ id: 'n-2', sessionId: 'sess-live', requestId: 'req-live' })])
    mh.handleMessage({ type: 'session_timeout', sessionId: 'sess-1', name: 'Chroxy', idleMs: 1 } as never, CTX)
    let row = store.getState().sessionNotifications.find((r) => r.id === 'n-1')
    expect(row?.sessionUnavailableAt).toBeTypeOf('number')
    expect(row?.sessionEndedAt).toBeTypeOf('number')
    expect(store.getState().sessionNotifications.find((r) => r.id === 'n-2')?.sessionUnavailableAt).toBeUndefined()
    mh.handleMessage(permissionRequest('sess-1', 'req-abc'), CTX)
    row = store.getState().sessionNotifications.find((r) => r.requestId === 'req-abc' && r.sessionEndedAt !== undefined)
    expect(row).toBeTruthy()
    expect(store.getState().sendPermissionResponse('req-abc', 'allow')).toBe(false)
    expect(permissionSends(sent)).toHaveLength(0)
  })

  it('RECONNECT/SCOPE: the session reappearing in a later session_list does NOT revive its old request', async () => {
    const { store, mh, sent } = await seed([notification()])
    mh.handleMessage({ type: 'session_list', sessions: [{ sessionId: 'sess-live', name: 'Live' }] }, CTX)
    mh.handleMessage(
      { type: 'session_list', sessions: [{ sessionId: 'sess-live', name: 'Live' }, { sessionId: 'sess-1', name: 'Chroxy' }] },
      CTX,
    )
    expect(store.getState().sessionNotifications.find((r) => r.id === 'n-1')?.sessionUnavailableAt).toBeTypeOf('number')
    expect(store.getState().sendPermissionResponse('req-abc', 'allow')).toBe(false)
    expect(permissionSends(sent)).toHaveLength(0)
  })

  it('EXACT-REQUEST RECOVERY: a permission_request for the SAME (session, request) restores it', async () => {
    const { store, mh, sent } = await seed([notification({ sessionUnavailableAt: NOW })])
    mh.handleMessage(permissionRequest('sess-1', 'req-abc'), CTX)
    expect(store.getState().sessionNotifications.some((r) => r.requestId === 'req-abc' && r.sessionUnavailableAt !== undefined)).toBe(false)
    expect(store.getState().sendPermissionResponse('req-abc', 'allow')).not.toBe(false)
    expect(permissionSends(sent)).toHaveLength(1)
  })

  it('RECOVERY IS REQUEST-SPECIFIC: a DIFFERENT request replacing the row does not let the OLD id send', async () => {
    const { store, mh, sent } = await seed([notification({ sessionUnavailableAt: NOW })])
    mh.handleMessage(permissionRequest('sess-1', 'req-new'), CTX)
    // the old request's evidence survived the replacement, as read history
    const old = store.getState().sessionNotifications.find((r) => r.requestId === 'req-abc')
    expect(old?.sessionUnavailableAt).toBeTypeOf('number')
    expect(old?.readAt).toBeTypeOf('number')
    expect(store.getState().sendPermissionResponse('req-abc', 'allow')).toBe(false)
    expect(permissionSends(sent)).toHaveLength(0)
    // ...while the NEW request is answerable
    expect(store.getState().sendPermissionResponse('req-new', 'allow')).not.toBe(false)
    expect(permissionSends(sent)).toHaveLength(1)
  })

  it('CROSS-SESSION CONTROL: the same request id in ANOTHER session does not lift this row', async () => {
    const { store, mh, sent } = await seed([notification({ sessionUnavailableAt: NOW })])
    mh.handleMessage(permissionRequest('sess-live', 'req-abc'), CTX)
    const stamped = store.getState().sessionNotifications.find((r) => r.sessionId === 'sess-1' && r.requestId === 'req-abc')
    expect(stamped?.sessionUnavailableAt).toBeTypeOf('number')
    expect(store.getState().sendPermissionResponse('req-abc', 'allow')).toBe(false)
    expect(permissionSends(sent)).toHaveLength(0)
  })

  it('dismissSessionNotification keeps a retired permission row as read history (evidence survives dismissal)', async () => {
    const { store, sent } = await seed([notification({ sessionUnavailableAt: NOW })])
    store.getState().dismissSessionNotification('n-1')
    const rows = store.getState().sessionNotifications
    expect(rows).toHaveLength(1)
    expect(rows[0]?.readAt).toBeTypeOf('number')
    expect(store.getState().sendPermissionResponse('req-abc', 'allow')).toBe(false)
    expect(permissionSends(sent)).toHaveLength(0)
  })

  it('CONTROL: dismissSessionNotification still removes a live row', async () => {
    const { store } = await seed([notification()])
    store.getState().dismissSessionNotification('n-1')
    expect(store.getState().sessionNotifications).toHaveLength(0)
  })
})
