/**
 * Notification-prefs / BYOK fail-loud contract tests (#4559)
 *
 * Pre-#4559 the BYOK and notification-prefs store actions silently no-op'd
 * when `socket.readyState !== OPEN`. The user toggled a checkbox, the WS
 * write was dropped, the optimistic patch never fired, and the toggle
 * snapped back to its prior state with no feedback. This file pins the
 * post-#4559 contract:
 *
 *   1. WS OPEN  → action sends the message and returns `true`.
 *   2. WS CLOSED → action does NOT send the message and returns `false`.
 *   3. The boolean is the SettingsPanel's signal to render an inline
 *      "server disconnected" banner (covered in SettingsPanel.test.tsx).
 *
 * Same contract covers `setNotificationPrefsCategory`,
 * `setNotificationPrefsDevice`, `setNotificationPrefsQuietHours`,
 * `setNotificationPrefsBypassCategories`, `refreshNotificationPrefs`,
 * `setByokCredentials`, `clearByokCredentials`, and
 * `refreshByokCredentialsStatus`.
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

function createMockSocket(sent: SentPayload[], readyState: number = WebSocket.OPEN): WebSocket {
  return {
    send: vi.fn((raw: string) => {
      try { sent.push(JSON.parse(raw) as SentPayload) } catch { /* noop */ }
    }),
    close: vi.fn(),
    readyState,
    addEventListener: vi.fn(),
    removeEventListener: vi.fn(),
  } as unknown as WebSocket
}

describe('#4559 — notification-prefs WS-closed fail-loud contract', () => {
  beforeEach(() => {
    vi.resetModules()
  })

  describe('setNotificationPrefsCategory', () => {
    it('returns true and sends a notification_prefs_set when WS is OPEN', async () => {
      const { useConnectionStore } = await import('./connection')
      const sent: SentPayload[] = []
      const socket = createMockSocket(sent, WebSocket.OPEN)
      useConnectionStore.setState({
        socket,
        notificationPrefs: {
          categories: { result: true },
          devices: {},
          quietHours: null,
        },
      })

      const result = useConnectionStore.getState().setNotificationPrefsCategory('result', false)

      expect(result).toBe(true)
      expect(sent).toHaveLength(1)
      expect(sent[0]).toEqual({
        type: 'notification_prefs_set',
        prefs: { categories: { result: false } },
      })
    })

    it('returns false and sends NO message when WS is CLOSED', async () => {
      // The whole point of #4559: the silent no-op is now visible.
      const { useConnectionStore } = await import('./connection')
      const sent: SentPayload[] = []
      const socket = createMockSocket(sent, WebSocket.CLOSED)
      useConnectionStore.setState({
        socket,
        notificationPrefs: {
          categories: { result: true },
          devices: {},
          quietHours: null,
        },
      })

      const result = useConnectionStore.getState().setNotificationPrefsCategory('result', false)

      expect(result).toBe(false)
      expect(sent).toHaveLength(0)
      // Optimistic patch must NOT fire either — a local-only flip would
      // drift on the next reconnect snapshot.
      expect(useConnectionStore.getState().notificationPrefs!.categories.result).toBe(true)
    })

    it('returns false when there is no socket at all', async () => {
      // Mirror the "never connected" path — no socket object, not even a
      // CLOSED one. Same contract: no send, false return.
      const { useConnectionStore } = await import('./connection')
      useConnectionStore.setState({
        socket: null,
        notificationPrefs: {
          categories: { result: true },
          devices: {},
          quietHours: null,
        },
      })

      const result = useConnectionStore.getState().setNotificationPrefsCategory('result', false)
      expect(result).toBe(false)
    })
  })

  describe('setNotificationPrefsDevice', () => {
    it('returns true and sends a device patch when WS is OPEN', async () => {
      const { useConnectionStore } = await import('./connection')
      const sent: SentPayload[] = []
      const socket = createMockSocket(sent, WebSocket.OPEN)
      useConnectionStore.setState({
        socket,
        notificationPrefs: {
          categories: { result: true },
          devices: {},
          quietHours: null,
        },
      })

      const result = useConnectionStore.getState().setNotificationPrefsDevice('dev-a', 'result', false)
      expect(result).toBe(true)
      expect(sent).toHaveLength(1)
    })

    it('returns false when WS is CLOSED', async () => {
      const { useConnectionStore } = await import('./connection')
      const sent: SentPayload[] = []
      const socket = createMockSocket(sent, WebSocket.CLOSED)
      useConnectionStore.setState({
        socket,
        notificationPrefs: {
          categories: { result: true },
          devices: {},
          quietHours: null,
        },
      })

      const result = useConnectionStore.getState().setNotificationPrefsDevice('dev-a', 'result', false)
      expect(result).toBe(false)
      expect(sent).toHaveLength(0)
    })

    it('returns false for empty deviceKey regardless of socket state', async () => {
      // Defensive no-op: never ship a `devices[""]` patch even if a stale
      // render somehow fires the action. SettingsPanel already gates on
      // currentDeviceKey, but the store guards both paths.
      const { useConnectionStore } = await import('./connection')
      const sent: SentPayload[] = []
      const socket = createMockSocket(sent, WebSocket.OPEN)
      useConnectionStore.setState({ socket, notificationPrefs: null })

      const result = useConnectionStore.getState().setNotificationPrefsDevice('', 'result', false)
      expect(result).toBe(false)
      expect(sent).toHaveLength(0)
    })
  })

  describe('setNotificationPrefsQuietHours', () => {
    it('returns true and sends a quietHours patch when WS is OPEN', async () => {
      const { useConnectionStore } = await import('./connection')
      const sent: SentPayload[] = []
      const socket = createMockSocket(sent, WebSocket.OPEN)
      useConnectionStore.setState({
        socket,
        notificationPrefs: {
          categories: {},
          devices: {},
          quietHours: null,
        },
      })

      const result = useConnectionStore.getState().setNotificationPrefsQuietHours({
        start: '22:00', end: '07:00', timezone: 'America/Los_Angeles',
      })
      expect(result).toBe(true)
      expect(sent).toHaveLength(1)
    })

    it('returns false when WS is CLOSED', async () => {
      const { useConnectionStore } = await import('./connection')
      const sent: SentPayload[] = []
      const socket = createMockSocket(sent, WebSocket.CLOSED)
      useConnectionStore.setState({
        socket,
        notificationPrefs: {
          categories: {},
          devices: {},
          quietHours: null,
        },
      })

      const result = useConnectionStore.getState().setNotificationPrefsQuietHours({
        start: '22:00', end: '07:00', timezone: 'America/Los_Angeles',
      })
      expect(result).toBe(false)
      expect(sent).toHaveLength(0)
    })
  })

  describe('setNotificationPrefsBypassCategories', () => {
    it('returns true and sends a bypassCategories patch when WS is OPEN', async () => {
      const { useConnectionStore } = await import('./connection')
      const sent: SentPayload[] = []
      const socket = createMockSocket(sent, WebSocket.OPEN)
      useConnectionStore.setState({
        socket,
        notificationPrefs: {
          categories: {},
          devices: {},
          quietHours: null,
          bypassCategories: ['permission', 'activity_error'],
        },
      })

      const result = useConnectionStore.getState().setNotificationPrefsBypassCategories(['permission'])
      expect(result).toBe(true)
      expect(sent).toHaveLength(1)
    })

    it('returns false when WS is CLOSED', async () => {
      const { useConnectionStore } = await import('./connection')
      const sent: SentPayload[] = []
      const socket = createMockSocket(sent, WebSocket.CLOSED)
      useConnectionStore.setState({
        socket,
        notificationPrefs: {
          categories: {},
          devices: {},
          quietHours: null,
          bypassCategories: ['permission', 'activity_error'],
        },
      })

      const result = useConnectionStore.getState().setNotificationPrefsBypassCategories(['permission'])
      expect(result).toBe(false)
      expect(sent).toHaveLength(0)
    })
  })

  describe('refreshNotificationPrefs', () => {
    it('returns true and sends notification_prefs_get when WS is OPEN', async () => {
      const { useConnectionStore } = await import('./connection')
      const sent: SentPayload[] = []
      const socket = createMockSocket(sent, WebSocket.OPEN)
      useConnectionStore.setState({ socket })

      const result = useConnectionStore.getState().refreshNotificationPrefs()
      expect(result).toBe(true)
      expect(sent).toHaveLength(1)
      expect(sent[0]?.type).toBe('notification_prefs_get')
    })

    it('returns false when WS is CLOSED', async () => {
      const { useConnectionStore } = await import('./connection')
      const sent: SentPayload[] = []
      const socket = createMockSocket(sent, WebSocket.CLOSED)
      useConnectionStore.setState({ socket })

      const result = useConnectionStore.getState().refreshNotificationPrefs()
      expect(result).toBe(false)
      expect(sent).toHaveLength(0)
    })
  })

  describe('BYOK actions', () => {
    it('setByokCredentials returns true + sends when WS is OPEN', async () => {
      const { useConnectionStore } = await import('./connection')
      const sent: SentPayload[] = []
      const socket = createMockSocket(sent, WebSocket.OPEN)
      useConnectionStore.setState({ socket })

      const result = useConnectionStore.getState().setByokCredentials('sk-ant-abc')
      expect(result).toBe(true)
      expect(sent).toHaveLength(1)
      expect(sent[0]?.type).toBe('byok_set_credentials')
    })

    it('setByokCredentials returns false + sends nothing when WS is CLOSED', async () => {
      const { useConnectionStore } = await import('./connection')
      const sent: SentPayload[] = []
      const socket = createMockSocket(sent, WebSocket.CLOSED)
      useConnectionStore.setState({ socket })

      const result = useConnectionStore.getState().setByokCredentials('sk-ant-abc')
      expect(result).toBe(false)
      expect(sent).toHaveLength(0)
    })

    it('clearByokCredentials returns true + sends when WS is OPEN', async () => {
      const { useConnectionStore } = await import('./connection')
      const sent: SentPayload[] = []
      const socket = createMockSocket(sent, WebSocket.OPEN)
      useConnectionStore.setState({ socket })

      const result = useConnectionStore.getState().clearByokCredentials()
      expect(result).toBe(true)
      expect(sent[0]?.type).toBe('byok_clear_credentials')
    })

    it('clearByokCredentials returns false when WS is CLOSED', async () => {
      const { useConnectionStore } = await import('./connection')
      const sent: SentPayload[] = []
      const socket = createMockSocket(sent, WebSocket.CLOSED)
      useConnectionStore.setState({ socket })

      const result = useConnectionStore.getState().clearByokCredentials()
      expect(result).toBe(false)
      expect(sent).toHaveLength(0)
    })

    it('refreshByokCredentialsStatus returns true when WS is OPEN', async () => {
      const { useConnectionStore } = await import('./connection')
      const sent: SentPayload[] = []
      const socket = createMockSocket(sent, WebSocket.OPEN)
      useConnectionStore.setState({ socket })

      const result = useConnectionStore.getState().refreshByokCredentialsStatus()
      expect(result).toBe(true)
      expect(sent[0]?.type).toBe('byok_get_credentials_status')
    })

    it('refreshByokCredentialsStatus returns false when WS is CLOSED', async () => {
      const { useConnectionStore } = await import('./connection')
      const sent: SentPayload[] = []
      const socket = createMockSocket(sent, WebSocket.CLOSED)
      useConnectionStore.setState({ socket })

      const result = useConnectionStore.getState().refreshByokCredentialsStatus()
      expect(result).toBe(false)
      expect(sent).toHaveLength(0)
    })
  })
})
