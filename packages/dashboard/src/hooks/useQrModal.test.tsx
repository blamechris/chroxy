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
    for (const call of fetchMock.mock.calls as unknown as unknown[][]) {
      expect((call[1] as { headers?: unknown }).headers).toBeUndefined()
    }
  })

  it('posts the Discord pairing link with no Authorization header under --no-auth', async () => {
    setConfig('{"port":1,"noEncrypt":false,"authRequired":false}')
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => ({ posted: true, expiresInSeconds: 60 }) }))
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useQrModal(null, 0))
    let out: unknown
    await act(async () => { out = await result.current.handlePostPairLinkToDiscord() })
    expect(out).toEqual({ posted: true, expiresInSeconds: 60 })
    const init = (fetchMock.mock.calls as unknown as unknown[][])[0]![1] as { headers: Record<string, string> }
    expect(init.headers.Authorization).toBeUndefined()
    expect(init.headers.Accept).toBe('application/json')
  })

  it('refuses the Discord pairing link with no token when auth is required', async () => {
    const fetchMock = vi.fn()
    vi.stubGlobal('fetch', fetchMock)
    const { result } = renderHook(() => useQrModal(null, 0))
    let out: unknown
    await act(async () => { out = await result.current.handlePostPairLinkToDiscord() })
    expect(out).toEqual({ posted: false, reason: 'no_token' })
    expect(fetchMock).not.toHaveBeenCalled()
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
