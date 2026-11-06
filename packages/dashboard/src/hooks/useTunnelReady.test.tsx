import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, waitFor, cleanup } from '@testing-library/react'
import { useTunnelReady } from './useTunnelReady'

// Not running under Tauri, so the hook falls through to probing /connect.
vi.mock('./useTauriIPC', () => ({ getServerInfo: async () => { throw new Error('not tauri') } }))

function setConfig(content: string | null) {
  document.head.querySelectorAll('meta[name="chroxy-config"]').forEach(m => m.remove())
  if (content === null) return
  const m = document.createElement('meta')
  m.setAttribute('name', 'chroxy-config')
  m.setAttribute('content', content)
  document.head.appendChild(m)
}

afterEach(() => { cleanup(); setConfig(null); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/') })

describe('useTunnelReady token handling (#9046)', () => {
  it('probes /connect with no token when the daemon runs --no-auth', async () => {
    setConfig('{"port":1,"noEncrypt":false,"authRequired":false}')
    const fetchMock = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    renderHook(() => useTunnelReady(true))
    await waitFor(() => expect(fetchMock).toHaveBeenCalledWith('/connect', expect.anything()))
  })

  it('does not probe when auth is required and there is no token', async () => {
    const fetchMock = vi.fn(async () => ({ ok: true }))
    vi.stubGlobal('fetch', fetchMock)
    renderHook(() => useTunnelReady(true))
    await new Promise(r => setTimeout(r, 50))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
