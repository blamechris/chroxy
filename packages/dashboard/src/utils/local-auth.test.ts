/**
 * #9033 — the token a same-origin ("this machine") dashboard connects with.
 * A page token wins; with none, only a daemon that says it does not require auth
 * (via the chroxy-config meta) yields an empty token. Anything else is null so the
 * normal disconnected state is unchanged.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { getLocalConnectionToken } from './local-auth'

function setConfig(content: string | null) {
  document.head.querySelectorAll('meta[name="chroxy-config"]').forEach(m => m.remove())
  if (content === null) return
  const m = document.createElement('meta')
  m.setAttribute('name', 'chroxy-config')
  m.setAttribute('content', content)
  document.head.appendChild(m)
}

describe('getLocalConnectionToken', () => {
  beforeEach(() => {
    setConfig(null)
    window.history.replaceState({}, '', '/dashboard')
  })
  afterEach(() => {
    setConfig(null)
    window.history.replaceState({}, '', '/dashboard')
  })

  it('returns the page token when present', () => {
    window.history.replaceState({}, '', '/dashboard?token=abc')
    setConfig('{"port":1,"noEncrypt":false,"authRequired":true}')
    expect(getLocalConnectionToken()).toBe('abc')
  })

  it('returns an empty token when no token and the server says auth is off', () => {
    setConfig('{"port":1,"noEncrypt":false,"authRequired":false}')
    expect(getLocalConnectionToken()).toBe('')
  })

  it('returns null when no token and auth is required', () => {
    setConfig('{"port":1,"noEncrypt":false,"authRequired":true}')
    expect(getLocalConnectionToken()).toBeNull()
  })

  it('returns null when no token and the config is missing, malformed, or lacks the flag', () => {
    expect(getLocalConnectionToken()).toBeNull()
    setConfig('not json')
    expect(getLocalConnectionToken()).toBeNull()
    setConfig('{"port":1,"noEncrypt":false}')
    expect(getLocalConnectionToken()).toBeNull()
  })

  it('does not treat a non-boolean falsy flag as auth off', () => {
    setConfig('{"authRequired":0}')
    expect(getLocalConnectionToken()).toBeNull()
    setConfig('{"authRequired":"false"}')
    expect(getLocalConnectionToken()).toBeNull()
  })
})
