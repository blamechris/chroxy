/**
 * #8268 — on connect, the dashboard compares the bundle it loaded with what the
 * daemon that served it runs now, and reloads (nothing to lose) or raises the
 * persistent "Chroxy was updated" banner (something to lose). jsdom's page is
 * http://localhost:3000, so ws://localhost:3000/ws is "the daemon that served this
 * page" and anything else is another server.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'

const lsStore: Record<string, string> = {}
Object.defineProperty(globalThis, 'localStorage', {
  value: {
    getItem: (k: string) => lsStore[k] ?? null,
    setItem: (k: string, v: string) => { lsStore[k] = v },
    removeItem: (k: string) => { delete lsStore[k] },
    clear: () => { for (const k of Object.keys(lsStore)) delete lsStore[k] },
    get length() { return Object.keys(lsStore).length },
    key: (i: number) => Object.keys(lsStore)[i] ?? null,
  },
  writable: true,
})
vi.mock('../utils/auth', () => ({ getAuthToken: () => null }))

class MockWebSocket {
  static OPEN = 1
  static instances: MockWebSocket[] = []
  url: string
  readyState = 1
  onopen: (() => void) | null = null
  onmessage: ((e: unknown) => void) | null = null
  onclose: ((e?: unknown) => void) | null = null
  onerror: ((e?: unknown) => void) | null = null
  constructor(url: string) { this.url = url; MockWebSocket.instances.push(this) }
  send() {}
  close() { this.readyState = 3 }
}
;(globalThis as unknown as { WebSocket: unknown }).WebSocket = MockWebSocket
;(globalThis as unknown as { fetch: unknown }).fetch = vi.fn(async () => ({ ok: true, status: 200, json: async () => ({ status: 'ok' }) }))

const { useConnectionStore } = await import('./connection')
const { setPageReloader, getClientVersion } = await import('../utils/stale-bundle')

const OWN = `ws://${window.location.host}/ws`
const REMOTE = 'wss://other-host.example.com/ws'

async function connectAndAuth(url: string, authOk: Record<string, unknown>): Promise<void> {
  const before = MockWebSocket.instances.length
  useConnectionStore.getState().connect(url, 'tok')
  await vi.advanceTimersByTimeAsync(0)
  const ws = MockWebSocket.instances[before]!
  ws.onopen?.()
  await vi.advanceTimersByTimeAsync(0)
  ws.onmessage?.({ data: JSON.stringify({ type: 'auth_ok', serverMode: 'cli', ...authOk }) })
  await vi.advanceTimersByTimeAsync(0)
}

const setClientBuild = (id: string | null) => {
  document.head.innerHTML = id ? `<meta name="chroxy-build" content="${id}">` : ''
}

let reload: ReturnType<typeof vi.fn<() => void>>
let restore: () => void

beforeEach(() => {
  vi.useFakeTimers()
  MockWebSocket.instances = []
  window.sessionStorage.clear()
  document.body.innerHTML = ''
  vi.spyOn(console, 'log').mockImplementation(() => {})
  reload = vi.fn<() => void>()
  restore = setPageReloader(reload)
  useConnectionStore.setState({
    serverRegistry: [], activeServerId: null, connectionPhase: 'disconnected',
    wsUrl: null, userDisconnected: false, staleBundle: null,
  })
})

afterEach(() => {
  restore()
  setClientBuild(null)
  vi.restoreAllMocks()
  vi.useRealTimers()
})

describe('stale bundle on connect (#8268)', () => {
  it('reloads once when the served build differs and nothing would be lost', async () => {
    setClientBuild('old-build')
    await connectAndAuth(OWN, { serverVersion: getClientVersion() ?? '0.0.0', dashboardBuildId: 'new-build' })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(useConnectionStore.getState().staleBundle).toMatchObject({ clientBuildId: 'old-build', serverBuildId: 'new-build' })
  })

  it('does NOT reload when the build matches', async () => {
    setClientBuild('same-build')
    await connectAndAuth(OWN, { serverVersion: getClientVersion() ?? '0.0.0', dashboardBuildId: 'same-build' })
    expect(reload).not.toHaveBeenCalled()
    expect(useConnectionStore.getState().staleBundle).toBeNull()
  })

  it('keeps the persistent banner state and does not reload while a draft is open', async () => {
    setClientBuild('old-build')
    document.body.innerHTML = '<textarea>an unsent message</textarea>'
    await connectAndAuth(OWN, { serverVersion: getClientVersion() ?? '0.0.0', dashboardBuildId: 'new-build' })
    expect(reload).not.toHaveBeenCalled()
    expect(useConnectionStore.getState().staleBundle).not.toBeNull()
  })

  it('catches a version change when the daemon sends no build id (older daemon)', async () => {
    setClientBuild(null)
    await connectAndAuth(OWN, { serverVersion: '99.0.0' })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(useConnectionStore.getState().staleBundle).toMatchObject({ serverVersion: '99.0.0' })
  })

  it('ignores a server this page did not come from: a LAN host runs a different build by design', async () => {
    setClientBuild('old-build')
    await connectAndAuth(REMOTE, { serverVersion: '99.0.0', dashboardBuildId: 'new-build' })
    expect(reload).not.toHaveBeenCalled()
    expect(useConnectionStore.getState().staleBundle).toBeNull()
  })

  it('a second connect that is still stale after the reload shows the banner instead of looping', async () => {
    setClientBuild('old-build')
    await connectAndAuth(OWN, { serverVersion: getClientVersion() ?? '0.0.0', dashboardBuildId: 'new-build' })
    await connectAndAuth(OWN, { serverVersion: getClientVersion() ?? '0.0.0', dashboardBuildId: 'new-build' })
    expect(reload).toHaveBeenCalledTimes(1)
    expect(useConnectionStore.getState().staleBundle).not.toBeNull()
  })
})
