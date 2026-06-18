/**
 * Notification-prefs optimistic update tests (#4558)
 *
 * Verifies that the per-category notification toggles in SettingsPanel feel
 * instant. The contract:
 *
 *   1. Clicking a toggle calls `setNotificationPrefsCategory(cat, next)`,
 *      which immediately patches `notificationPrefs.categories[cat]` in the
 *      store so the next React render reflects the new value — no waiting
 *      for the WS round-trip and broadcast.
 *   2. The same action still ships a `notification_prefs_set` message on the
 *      socket (the server remains the source of truth).
 *   3. When the eventual `notification_prefs` broadcast arrives, the
 *      message-handler overwrites the locally-optimistic value with whatever
 *      the server actually persisted. Server-wins reconciliation means a
 *      rejected/coerced toggle visibly reverts.
 *
 * Same contract is mirrored for the per-device override
 * (`setNotificationPrefsDevice`), the quiet-hours window
 * (`setNotificationPrefsQuietHours`), and the global bypass list
 * (`setNotificationPrefsBypassCategories`).
 */
import { describe, it, expect, beforeEach, vi } from 'vitest'

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

interface SentPayload {
  type: string
  prefs?: Record<string, unknown>
  [k: string]: unknown
}

function createMockSocket(sent: SentPayload[]): WebSocket {
  return {
    send: vi.fn((raw: string) => {
      try { sent.push(JSON.parse(raw) as SentPayload) } catch { /* noop */ }
    }),
    close: vi.fn(),
    readyState: WebSocket.OPEN,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

describe('#4558 — notification-prefs optimistic update', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  it('setNotificationPrefsCategory updates local notificationPrefs immediately', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = createMockSocket(sent)
    useConnectionStore.setState({
      socket,
      notificationPrefs: {
        categories: { permission: true, result: true, activity_update: true },
        devices: {},
        quietHours: null,
      },
    })

    // BEFORE the server broadcasts anything back, flip `result` off. The
    // local store must reflect the new value on the very next read.
    useConnectionStore.getState().setNotificationPrefsCategory('result', false)

    const after = useConnectionStore.getState().notificationPrefs!
    expect(after.categories.result).toBe(false)
    // Untouched categories survive — the optimistic patch is shallow-merge.
    expect(after.categories.permission).toBe(true)
    expect(after.categories.activity_update).toBe(true)
  })

  it('setNotificationPrefsCategory still ships the notification_prefs_set WS message', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = createMockSocket(sent)
    useConnectionStore.setState({
      socket,
      notificationPrefs: {
        categories: { permission: true, result: true },
        devices: {},
        quietHours: null,
      },
    })

    useConnectionStore.getState().setNotificationPrefsCategory('result', false)

    expect(sent).toHaveLength(1)
    expect(sent[0]).toEqual({
      type: 'notification_prefs_set',
      prefs: { categories: { result: false } },
    })
  })

  it('server snapshot overrides the local optimistic value when they disagree', async () => {
    const { useConnectionStore } = await import('./connection')
    const { handleMessage, setStore } = await import('./message-handler')

    const sent: SentPayload[] = []
    const socket = createMockSocket(sent)
    useConnectionStore.setState({
      socket,
      notificationPrefs: {
        categories: { permission: true, result: true },
        devices: {},
        quietHours: null,
      },
    })

    // Wire the message-handler to the real store so a broadcast actually
    // mutates `notificationPrefs`. The handler's setStore contract accepts
    // an object with `getState`/`setState` shaped like Zustand's; pass
    // through the real store as an opaque object — type machinery only
    // matters at the boundary, not inside the test fixture.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    setStore(useConnectionStore as any)

    // Optimistic flip: user clicks `result` off.
    useConnectionStore.getState().setNotificationPrefsCategory('result', false)
    expect(useConnectionStore.getState().notificationPrefs!.categories.result).toBe(false)

    // Server disagrees and broadcasts the truth (e.g. the patch was rejected
    // server-side or coerced — for whatever reason `result` is still enabled).
    handleMessage(
      {
        type: 'notification_prefs',
        prefs: {
          categories: { permission: true, result: true },
          devices: {},
          quietHours: null,
        },
      },
      { url: 'wss://t', token: 'tok', socket, isReconnect: false, silent: false },
    )

    // Server wins: the optimistic `false` is replaced by the broadcast `true`.
    expect(useConnectionStore.getState().notificationPrefs!.categories.result).toBe(true)
  })

  it('setNotificationPrefsCategory is a no-op on local state when notificationPrefs is null', async () => {
    // Defensive: the action is bound to a checkbox that only renders after
    // the first snapshot lands, but the toggle is gated by `notificationPrefs
    // == null`. If a race somehow triggered the action before the first
    // snapshot, we must NOT mint a synthetic snapshot (which would lock in
    // an incorrect "all categories enabled except this one" baseline). The
    // WS message still goes out so the server's reply seeds the snapshot.
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = createMockSocket(sent)
    useConnectionStore.setState({ socket, notificationPrefs: null })

    useConnectionStore.getState().setNotificationPrefsCategory('result', false)

    expect(useConnectionStore.getState().notificationPrefs).toBeNull()
    expect(sent).toHaveLength(1)
  })

  it('setNotificationPrefsDevice updates the device override immediately', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = createMockSocket(sent)
    useConnectionStore.setState({
      socket,
      notificationPrefs: {
        categories: { result: true },
        devices: {},
        quietHours: null,
      },
    })

    useConnectionStore.getState().setNotificationPrefsDevice('dev-a', 'result', false)

    const after = useConnectionStore.getState().notificationPrefs!
    expect(after.devices['dev-a']?.categories?.result).toBe(false)
    // Wire still ships.
    expect(sent[0]).toEqual({
      type: 'notification_prefs_set',
      prefs: { devices: { 'dev-a': { categories: { result: false } } } },
    })
  })

  it('setNotificationPrefsDevice preserves existing per-device categories on a single-key patch', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = createMockSocket(sent)
    useConnectionStore.setState({
      socket,
      notificationPrefs: {
        categories: { result: true, permission: true },
        devices: {
          'dev-a': { categories: { permission: false } },
        },
        quietHours: null,
      },
    })

    useConnectionStore.getState().setNotificationPrefsDevice('dev-a', 'result', false)

    const after = useConnectionStore.getState().notificationPrefs!
    expect(after.devices['dev-a']?.categories?.result).toBe(false)
    expect(after.devices['dev-a']?.categories?.permission).toBe(false)
  })

  it('setNotificationPrefsQuietHours sets the window locally and on the wire', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = createMockSocket(sent)
    useConnectionStore.setState({
      socket,
      notificationPrefs: {
        categories: { result: true },
        devices: {},
        quietHours: null,
      },
    })

    const win = { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' }
    useConnectionStore.getState().setNotificationPrefsQuietHours(win)

    expect(useConnectionStore.getState().notificationPrefs!.quietHours).toEqual(win)
    expect(sent[0]).toEqual({ type: 'notification_prefs_set', prefs: { quietHours: win } })
  })

  it('setNotificationPrefsQuietHours(null) clears the window locally and on the wire', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = createMockSocket(sent)
    useConnectionStore.setState({
      socket,
      notificationPrefs: {
        categories: { result: true },
        devices: {},
        quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
      },
    })

    useConnectionStore.getState().setNotificationPrefsQuietHours(null)

    expect(useConnectionStore.getState().notificationPrefs!.quietHours).toBeNull()
    expect(sent[0]).toEqual({ type: 'notification_prefs_set', prefs: { quietHours: null } })
  })

  it('setNotificationPrefsBypassCategories replaces the list locally and on the wire', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = createMockSocket(sent)
    useConnectionStore.setState({
      socket,
      notificationPrefs: {
        categories: { result: true },
        devices: {},
        quietHours: null,
        bypassCategories: ['permission', 'activity_error'],
      },
    })

    useConnectionStore.getState().setNotificationPrefsBypassCategories(['permission'])

    expect(useConnectionStore.getState().notificationPrefs!.bypassCategories).toEqual(['permission'])
    expect(sent[0]).toEqual({
      type: 'notification_prefs_set',
      prefs: { bypassCategories: ['permission'] },
    })
  })

  // #4564: per-device delete semantics. The dashboard mirrors the server
  // convention — sending `devices: { [token]: null }` drains an orphan
  // entry. The local snapshot drops the key immediately (optimistic) and
  // the server's broadcast confirms after the round-trip.
  it('deleteNotificationPrefsDevice removes the device entry locally and ships a null sentinel patch', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = createMockSocket(sent)
    useConnectionStore.setState({
      socket,
      notificationPrefs: {
        categories: { result: true },
        devices: {
          'dev-a': { categories: { result: false } },
          'dev-b': { categories: { result: false } },
        },
        quietHours: null,
      },
    })

    const sentResult = useConnectionStore.getState().deleteNotificationPrefsDevice('dev-a')

    expect(sentResult).toBe(true)
    const after = useConnectionStore.getState().notificationPrefs!
    expect(after.devices['dev-a']).toBeUndefined()
    // Sibling entries survive.
    expect(after.devices['dev-b']).toBeDefined()
    expect(sent[0]).toEqual({
      type: 'notification_prefs_set',
      prefs: { devices: { 'dev-a': null } },
    })
  })

  it('deleteNotificationPrefsDevice is a no-op when deviceKey is empty', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = createMockSocket(sent)
    useConnectionStore.setState({
      socket,
      notificationPrefs: {
        categories: { result: true },
        devices: { 'dev-a': { categories: { result: false } } },
        quietHours: null,
      },
    })

    const sentResult = useConnectionStore.getState().deleteNotificationPrefsDevice('')

    expect(sentResult).toBe(false)
    expect(sent).toHaveLength(0)
    expect(useConnectionStore.getState().notificationPrefs!.devices['dev-a']).toBeDefined()
  })

  it('deleteNotificationPrefsDevice returns false when the socket is closed and does not mutate state', async () => {
    const { useConnectionStore } = await import('./connection')
    const sent: SentPayload[] = []
    const socket = {
      send: vi.fn((raw: string) => {
        try { sent.push(JSON.parse(raw) as SentPayload) } catch { /* noop */ }
      }),
      close: vi.fn(),
      readyState: WebSocket.CLOSED,
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    } as unknown as WebSocket
    useConnectionStore.setState({
      socket,
      notificationPrefs: {
        categories: { result: true },
        devices: { 'dev-a': { categories: { result: false } } },
        quietHours: null,
      },
    })

    const sentResult = useConnectionStore.getState().deleteNotificationPrefsDevice('dev-a')

    expect(sentResult).toBe(false)
    // The optimistic deletion would never reconcile if the socket is closed,
    // so the action must not mutate local state on the closed-socket branch.
    expect(useConnectionStore.getState().notificationPrefs!.devices['dev-a']).toBeDefined()
    expect(sent).toHaveLength(0)
  })
})
