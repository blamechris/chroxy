import { describe, it, expect, vi, beforeEach } from 'vitest'

const mockGetInvoke = vi.fn()
vi.mock('./tauri-bridge', () => ({
  getTauriInvoke: () => mockGetInvoke(),
}))

const { discoverLanServers } = await import('./discovery')

beforeEach(() => {
  vi.clearAllMocks()
})

describe('discoverLanServers', () => {
  it('returns [] outside Tauri (no invoke)', async () => {
    mockGetInvoke.mockReturnValue(null)
    expect(await discoverLanServers()).toEqual([])
  })

  it('returns parsed servers from the command', async () => {
    const invoke = vi.fn().mockResolvedValue([
      { name: 'devbox', host: '192.168.1.9', port: 8765, wsUrl: 'ws://192.168.1.9:8765/ws', version: '0.9.44' },
    ])
    mockGetInvoke.mockReturnValue(invoke)
    const result = await discoverLanServers()
    expect(invoke).toHaveBeenCalledWith('discover_lan_servers')
    expect(result).toHaveLength(1)
    expect(result[0]!.name).toBe('devbox')
    expect(result[0]!.wsUrl).toBe('ws://192.168.1.9:8765/ws')
  })

  it('filters out malformed entries defensively', async () => {
    const invoke = vi.fn().mockResolvedValue([
      { name: 'ok', host: '10.0.0.1', port: 8765, wsUrl: 'ws://10.0.0.1:8765/ws', version: null },
      { name: 'bad-no-host', port: 8765, wsUrl: 'ws://x/ws' },
      'not-an-object',
      null,
    ])
    mockGetInvoke.mockReturnValue(invoke)
    const result = await discoverLanServers()
    expect(result).toHaveLength(1)
    expect(result[0]!.host).toBe('10.0.0.1')
  })

  it('rejects entries with a non-string version or non-finite port', async () => {
    const invoke = vi.fn().mockResolvedValue([
      { name: 'bad-version', host: '10.0.0.1', port: 8765, wsUrl: 'ws://10.0.0.1:8765/ws', version: { x: 1 } },
      { name: 'bad-port', host: '10.0.0.2', port: Number.POSITIVE_INFINITY, wsUrl: 'ws://10.0.0.2/ws', version: null },
      { name: 'ok-null-version', host: '10.0.0.3', port: 8765, wsUrl: 'ws://10.0.0.3:8765/ws', version: null },
    ])
    mockGetInvoke.mockReturnValue(invoke)
    const result = await discoverLanServers()
    expect(result.map(r => r.name)).toEqual(['ok-null-version'])
  })

  it('returns [] when the command yields a non-array', async () => {
    const invoke = vi.fn().mockResolvedValue({ unexpected: true })
    mockGetInvoke.mockReturnValue(invoke)
    expect(await discoverLanServers()).toEqual([])
  })

  it('propagates a command error (distinct from "found nothing")', async () => {
    const invoke = vi.fn().mockRejectedValue(new Error('mDNS init failed'))
    mockGetInvoke.mockReturnValue(invoke)
    await expect(discoverLanServers()).rejects.toThrow('mDNS init failed')
  })
})
