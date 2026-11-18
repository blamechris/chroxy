/**
 * #9222 — a permission banner for a RETIRED session must not keep live
 * Allow/Deny buttons.
 *
 * `permissionNotificationStatus` is conservative on absence ("no prompt found"
 * means pending, so a banner that predates its prompt's hydration stays
 * answerable). The `session_list` prune deletes `sessionStates[id]` for a removed
 * session while `sessionNotifications` survives as history, so the two states
 * became indistinguishable. The store now stamps `sessionClosedAt` on rows whose
 * session it WATCHED leave the roster; that stamp is the authoritative retirement
 * signal, and these tests pin render, click-time and send-time behaviour plus the
 * controls that must not change.
 */
import { describe, it, expect, vi, afterEach, beforeEach } from 'vitest'
import { render, screen, fireEvent, cleanup } from '@testing-library/react'
import {
  NotificationBanners,
  permissionNotificationStatus,
  type PermissionBannerStatus,
} from './NotificationBanners'
import { markSessionNotificationsClosed } from '../store/utils'
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
  handlers: { onApprove?: () => void; onDeny?: () => void; onMarkRead?: () => void } = {},
) {
  return render(
    <NotificationBanners
      notifications={[n]}
      onApprove={handlers.onApprove ?? vi.fn()}
      onDeny={handlers.onDeny ?? vi.fn()}
      onDismiss={vi.fn()}
      onMarkRead={handlers.onMarkRead ?? vi.fn()}
      onSwitchSession={vi.fn()}
      permissionStatus={status}
      isSessionListed={() => false}
      isSessionStarting={() => false}
    />,
  )
}

describe('#9222 — permissionNotificationStatus', () => {
  it("is 'session-closed' for a stamped row even though no prompt is in sessionStates", () => {
    expect(
      permissionNotificationStatus(notification({ sessionClosedAt: NOW }), {}, NOW, true),
    ).toBe('session-closed')
  })

  it("stays 'session-closed' while disconnected (retired beats reconnect-to-answer)", () => {
    expect(
      permissionNotificationStatus(notification({ sessionClosedAt: NOW }), {}, NOW, false),
    ).toBe('session-closed')
  })

  it("CONTROL: an UNstamped row with no prompt yet (hydration) is still 'actionable'", () => {
    expect(permissionNotificationStatus(notification(), {}, NOW, true)).toBe('actionable')
  })

  it("CONTROL: an UNstamped row, disconnected, is still 'disconnected'", () => {
    expect(permissionNotificationStatus(notification(), {}, NOW, false)).toBe('disconnected')
  })

  it("CONTROL: a non-permission alert is unaffected by the stamp", () => {
    expect(
      permissionNotificationStatus(
        notification({ eventType: 'completed', requestId: undefined, sessionClosedAt: NOW }),
        {},
        NOW,
        true,
      ),
    ).toBe('actionable')
  })
})

describe('#9222 — banner render', () => {
  it('renders no Allow/Deny, explains the retirement, and keeps the row as a record', () => {
    renderBanner(notification({ sessionClosedAt: NOW }), () => 'session-closed')
    expect(screen.queryByRole('button', { name: 'Allow' })).toBeNull()
    expect(screen.queryByRole('button', { name: 'Deny' })).toBeNull()
    expect(screen.getByTestId('notification-banner-session-closed').textContent).toMatch(
      /Session closed/,
    )
    // History survives: the message and name are still there.
    expect(screen.getByText('Bash: ls')).toBeTruthy()
    expect(screen.getByTestId('notification-banner-session-name').textContent).toBe('Chroxy')
  })

  it('Dismiss on a retired row marks it read (keeps history), never removes it', () => {
    const onMarkRead = vi.fn()
    const onDismiss = vi.fn()
    render(
      <NotificationBanners
        notifications={[notification({ sessionClosedAt: NOW })]}
        onApprove={vi.fn()}
        onDeny={vi.fn()}
        onDismiss={onDismiss}
        onMarkRead={onMarkRead}
        onSwitchSession={vi.fn()}
        permissionStatus={() => 'session-closed'}
        isSessionListed={() => false}
        isSessionStarting={() => false}
      />,
    )
    fireEvent.click(screen.getByRole('button', { name: 'Dismiss' }))
    expect(onMarkRead).toHaveBeenCalledWith('n-1')
    expect(onDismiss).not.toHaveBeenCalled()
  })

  it('CONTROL: a genuinely pending row keeps Allow/Deny', () => {
    renderBanner(notification(), () => 'actionable')
    expect(screen.getByRole('button', { name: 'Allow' })).toBeTruthy()
    expect(screen.getByRole('button', { name: 'Deny' })).toBeTruthy()
    expect(screen.queryByTestId('notification-banner-session-closed')).toBeNull()
  })
})

describe('#9222 — click race: row rendered actionable, session retired before the click', () => {
  for (const [label, name, handler] of [
    ['Allow', 'Allow', 'onApprove'],
    ['Deny', 'Deny', 'onDeny'],
  ] as const) {
    it(`${label}: the click-time re-check refuses and redraws as retired`, () => {
      let status: PermissionBannerStatus = 'actionable'
      const fn = vi.fn()
      renderBanner(notification(), () => status, { [handler]: fn })
      // The session is retired between render and click; nothing re-rendered.
      status = 'session-closed'
      fireEvent.click(screen.getByRole('button', { name }))
      expect(fn).not.toHaveBeenCalled()
      expect(screen.queryByRole('button', { name })).toBeNull()
      expect(screen.getByTestId('notification-banner-session-closed')).toBeTruthy()
    })
  }
})

describe('#9222 — markSessionNotificationsClosed', () => {
  it('stamps only rows of removed sessions, keeping them in the list', () => {
    const rows = [
      notification({ id: 'a', sessionId: 'gone' }),
      notification({ id: 'b', sessionId: 'live' }),
    ]
    const out = markSessionNotificationsClosed(rows, ['gone'], NOW)
    expect(out).toHaveLength(2)
    expect(out?.[0]?.sessionClosedAt).toBe(NOW)
    expect(out?.[1]?.sessionClosedAt).toBeUndefined()
  })

  it('returns the SAME array when nothing matches (no subscriber churn)', () => {
    const rows = [notification({ sessionId: 'live' })]
    expect(markSessionNotificationsClosed(rows, ['gone'], NOW)).toBe(rows)
    expect(markSessionNotificationsClosed(rows, [], NOW)).toBe(rows)
  })

  it('tolerates undefined state (partially-seeded store) and returns it unchanged', () => {
    expect(markSessionNotificationsClosed(undefined, ['gone'], NOW)).toBeUndefined()
  })

  it('does not restamp an already-retired row', () => {
    const rows = [notification({ sessionId: 'gone', sessionClosedAt: 5 })]
    const out = markSessionNotificationsClosed(rows, ['gone'], NOW)
    expect(out).toBe(rows)
    expect(out?.[0]?.sessionClosedAt).toBe(5)
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

describe('#9222 — store: prune stamps, and the send choke point refuses', () => {
  beforeEach(() => {
    vi.resetModules()
    vi.spyOn(console, 'warn').mockImplementation(() => {})
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('sendPermissionResponse sends nothing for a retired session and leaves the row', async () => {
    const { useConnectionStore } = await import('../store/connection')
    const sent: unknown[] = []
    useConnectionStore.setState({
      socket: liveSocket(sent),
      sessions: [],
      sessionNotifications: [notification({ sessionClosedAt: NOW })],
    })
    const ok = useConnectionStore.getState().sendPermissionResponse('req-abc', 'allow')
    expect(ok).toBe(false)
    expect(sent.some((m) => (m as { type?: string }).type === 'permission_response')).toBe(false)
    expect(useConnectionStore.getState().sessionNotifications).toHaveLength(1)
  })

  it('CONTROL: an unstamped row still sends', async () => {
    const { useConnectionStore } = await import('../store/connection')
    const sent: unknown[] = []
    useConnectionStore.setState({
      socket: liveSocket(sent),
      sessions: [],
      sessionNotifications: [notification()],
    })
    const ok = useConnectionStore.getState().sendPermissionResponse('req-abc', 'allow')
    expect(ok).not.toBe(false)
    expect(sent.some((m) => (m as { type?: string }).type === 'permission_response')).toBe(true)
  })

  it('send race: stamped between render and click, the fresh store read refuses', async () => {
    const { useConnectionStore } = await import('../store/connection')
    const sent: unknown[] = []
    const rowOnScreen = notification()
    useConnectionStore.setState({
      socket: liveSocket(sent),
      sessions: [],
      sessionNotifications: [rowOnScreen],
    })
    // The session is retired in the store AFTER the row was rendered.
    useConnectionStore.setState({
      sessionNotifications: [{ ...rowOnScreen, sessionClosedAt: NOW }],
    })
    expect(useConnectionStore.getState().sendPermissionResponse('req-abc', 'deny')).toBe(false)
    expect(sent).toHaveLength(0)
  })

  it('a session_list that drops the session stamps its alert and keeps the history', async () => {
    const { useConnectionStore, createEmptySessionState } = await import('../store/connection')
    const { handleMessage } = await import('../store/message-handler')
    useConnectionStore.setState({
      socket: liveSocket([]),
      activeSessionId: 'sess-live',
      sessions: [
        { sessionId: 'sess-live', name: 'Live' },
        { sessionId: 'sess-1', name: 'Chroxy' },
      ] as never,
      sessionStates: {
        'sess-live': createEmptySessionState(),
        'sess-1': createEmptySessionState(),
      },
      sessionNotifications: [
        notification(),
        notification({ id: 'n-live', sessionId: 'sess-live', requestId: 'req-live' }),
      ],
    })
    handleMessage(
      { type: 'session_list', sessions: [{ sessionId: 'sess-live', name: 'Live' }] },
      { url: 'wss://t', token: 'tok', socket: null, isReconnect: false, silent: false } as never,
    )
    const rows = useConnectionStore.getState().sessionNotifications
    expect(rows).toHaveLength(2)
    expect(rows.find((r) => r.id === 'n-1')?.sessionClosedAt).toBeTypeOf('number')
    expect(rows.find((r) => r.id === 'n-live')?.sessionClosedAt).toBeUndefined()
  })
})
