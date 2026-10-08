/** #8268 — the stale-bundle verdict and the reload-or-banner decision. */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  detectStaleBundle, handleStaleBundle, getClientBuildId, setPageReloader, RELOAD_GUARD_WINDOW_MS,
  type StaleBundleInfo,
} from './stale-bundle'
import { registerUnsavedWorkProbe } from './unsaved-work'

const info = (over: Partial<StaleBundleInfo> = {}): StaleBundleInfo => ({
  clientVersion: '0.11.4', clientBuildId: 'old1', serverVersion: '0.11.4', serverBuildId: 'new2', ...over,
})

describe('detectStaleBundle', () => {
  it('different build ids are stale even at the same version (a rebuilt dist)', () => {
    expect(detectStaleBundle(info())).not.toBeNull()
  })

  it('equal build ids are current, whatever the versions say', () => {
    expect(detectStaleBundle(info({ clientBuildId: 'x', serverBuildId: 'x', clientVersion: '0.1.0' }))).toBeNull()
  })

  it('falls back to versions when either id is missing (older daemon, dev server)', () => {
    expect(detectStaleBundle(info({ serverBuildId: null, clientVersion: '0.11.2' }))).not.toBeNull()
    expect(detectStaleBundle(info({ clientBuildId: null, clientVersion: '0.11.2' }))).not.toBeNull()
    expect(detectStaleBundle(info({ serverBuildId: null }))).toBeNull()
  })

  it('cannot tell without ids or versions, so it does not claim staleness', () => {
    expect(detectStaleBundle({ clientVersion: null, clientBuildId: null, serverVersion: null, serverBuildId: null })).toBeNull()
  })
})

describe('getClientBuildId', () => {
  afterEach(() => { document.head.innerHTML = '' })
  it('reads the daemon-injected meta', () => {
    document.head.innerHTML = '<meta name="chroxy-build" content="abc123">'
    expect(getClientBuildId()).toBe('abc123')
  })
  it('is null without it', () => {
    expect(getClientBuildId()).toBeNull()
  })
})

describe('handleStaleBundle', () => {
  let reload: ReturnType<typeof vi.fn<() => void>>
  let restore: () => void
  beforeEach(() => {
    window.sessionStorage.clear()
    document.body.innerHTML = ''
    reload = vi.fn<() => void>()
    restore = setPageReloader(reload)
  })
  afterEach(() => { restore() })

  it('reloads when nothing would be lost', () => {
    expect(handleStaleBundle(info())).toBe('reloaded')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('leaves the banner when a textarea holds a draft', () => {
    document.body.innerHTML = '<textarea>half a thought</textarea>'
    expect(handleStaleBundle(info())).toBe('banner')
    expect(reload).not.toHaveBeenCalled()
  })

  it('an empty or whitespace-only textarea is not unsaved work', () => {
    document.body.innerHTML = '<textarea>   </textarea>'
    expect(handleStaleBundle(info())).toBe('reloaded')
  })

  it('leaves the banner when a registered probe reports unsaved work (attachments, other tabs\' drafts)', () => {
    const unregister = registerUnsavedWorkProbe(() => true)
    try {
      expect(handleStaleBundle(info())).toBe('banner')
      expect(reload).not.toHaveBeenCalled()
    } finally { unregister() }
    expect(handleStaleBundle(info())).toBe('reloaded')
  })

  it('a probe that throws counts as unsaved work (fail safe)', () => {
    const unregister = registerUnsavedWorkProbe(() => { throw new Error('boom') })
    try {
      expect(handleStaleBundle(info())).toBe('banner')
    } finally { unregister() }
  })

  it('does not loop: a reload that came back stale for the same target shows the banner', () => {
    const t = 1_000_000
    expect(handleStaleBundle(info(), t)).toBe('reloaded')
    expect(handleStaleBundle(info(), t + 5_000)).toBe('banner')
    expect(reload).toHaveBeenCalledTimes(1)
  })

  it('reloads again for a NEWER update, or once the guard window has passed', () => {
    const t = 1_000_000
    expect(handleStaleBundle(info(), t)).toBe('reloaded')
    expect(handleStaleBundle(info({ serverBuildId: 'newer3' }), t + 5_000)).toBe('reloaded')
    expect(handleStaleBundle(info({ serverBuildId: 'newer3' }), t + 5_000 + RELOAD_GUARD_WINDOW_MS + 1)).toBe('reloaded')
    expect(reload).toHaveBeenCalledTimes(3)
  })

  it('without usable sessionStorage it cannot guard against a loop, so it does not reload', () => {
    const spy = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    try {
      expect(handleStaleBundle(info())).toBe('banner')
      expect(reload).not.toHaveBeenCalled()
    } finally { spy.mockRestore() }
  })
})
