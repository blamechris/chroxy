import { describe, it, expect, vi, afterEach } from 'vitest'
import { renderHook, act, waitFor, cleanup } from '@testing-library/react'
import { useQrModal } from './useQrModal'

function setConfig(content: string | null) {
  document.head.querySelectorAll('meta[name="chroxy-config"]').forEach(m => m.remove())
  if (content === null) return
  const m = document.createElement('meta')
  m.setAttribute('name', 'chroxy-config')
  m.setAttribute('content', content)
  document.head.appendChild(m)
}

afterEach(() => { cleanup(); setConfig(null); vi.unstubAllGlobals(); window.history.replaceState({}, '', '/') })

describe('useQrModal token handling (#9046)', () => {
  it('fetches the QR with no token when the daemon runs --no-auth', async () => {
    setConfig('{"port":1,"noEncrypt":false,"authRequired":false}')
    const fetchMock = vi.fn(async (path: string) => ({
      ok: true,
      text: async () => '<svg/>',
      json: async () => (path === '/pairing-code' ? { code: 'ABC' } : {}),
    }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useQrModal(null, 0))
    act(() => { result.current.handleShowQr() })
    await waitFor(() => expect(result.current.qrSvg).toBe('<svg/>'))
    expect(result.current.qrError).toBeNull()
  })

  it('still reports a missing token when auth is required', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useQrModal(null, 0))
    act(() => { result.current.handleShowQr() })
    await waitFor(() => expect(result.current.qrError).toBe('No auth token available'))
    expect(fetchMock).not.toHaveBeenCalled()
  })
})
