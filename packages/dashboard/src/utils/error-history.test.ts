import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ERROR_HISTORY_KEY,
  __resetErrorHistoryForTests,
  clearErrorHistory,
  currentAssetBasenames,
  formatHistoryEntry,
  readErrorHistory,
  recordDashboardError,
  subscribeErrorHistory,
} from './error-history'
import { formatErrorReport } from './error-report'

const BUNDLE = 'index-abc123.js'

function jsonParseError(): Error {
  try {
    JSON.parse('PRIVATE SESSION CONTENT')
  } catch (e) {
    return e as Error
  }
  throw new Error('JSON.parse did not throw')
}

function propError(): Error {
  const e = new TypeError("Cannot read properties of undefined (reading 'dimensions')")
  e.stack = `TypeError: x\n    at renderChart (${location.origin}/assets/${BUNDLE}:10:20)`
  return e
}

function addScript(src: string): HTMLScriptElement {
  const s = document.createElement('script')
  s.setAttribute('src', src)
  document.head.appendChild(s)
  return s
}

beforeEach(() => {
  localStorage.clear()
  __resetErrorHistoryForTests()
  addScript(`${location.origin}/assets/${BUNDLE}`)
})

afterEach(() => {
  vi.restoreAllMocks()
  document.head.querySelectorAll('script').forEach(s => s.remove())
  vi.useRealTimers()
})

describe('stored data is classifier output only', () => {
  it('never writes raw message, raw stack or opaque URLs', () => {
    const err = jsonParseError()
    err.stack = [
      `${err.name}: ${err.message}`,
      '    at parse (file:///Users/alice/secret/app.js:1:2)',
      '    at leak (data:text/plain,PRIVATE%20DATA:1:1)',
      `    at renderChart (${location.origin}/assets/${BUNDLE}:3:4)`,
    ].join('\n')
    recordDashboardError({ category: 'window-error', error: err })
    const raw = localStorage.getItem(ERROR_HISTORY_KEY)!
    expect(raw).toBeTruthy()
    for (const needle of ['PRIVATE', 'alice', 'data:', 'file:', 'Unexpected token']) {
      expect(raw.includes(needle), needle).toBe(false)
    }
    const [e] = readErrorHistory()
    expect(e!.text).toBe('[message omitted]')
    expect(e!.template).toBeNull()
    expect(e!.stack).toContain(`renderChart @ ${BUNDLE}:3:4`)
  })

  it('stores exactly the documented fields', () => {
    recordDashboardError({ category: 'render', error: propError(), componentStack: '\n    at Chart\n    at App' })
    const stored = JSON.parse(localStorage.getItem(ERROR_HISTORY_KEY)!) as Record<string, unknown>[]
    expect(Object.keys(stored[0]!).sort()).toEqual([
      'category', 'componentStack', 'count', 'firstTime', 'id', 'name', 'platform',
      'stack', 'template', 'text', 'time', 'version',
    ])
    expect(stored[0]!.time).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)
    expect(stored[0]!.componentStack).toEqual(['Chart', 'App'])
    expect(stored[0]!.template).toBe('read-props-of')
  })

  it('records a non-Error value as the category plus [message omitted]', () => {
    recordDashboardError({ category: 'unhandled-rejection', error: 'PRIVATE string reason' })
    recordDashboardError({ category: 'unhandled-rejection', error: { message: 'PRIVATE object' } })
    const raw = localStorage.getItem(ERROR_HISTORY_KEY)!
    expect(raw.includes('PRIVATE')).toBe(false)
    const list = readErrorHistory()
    expect(list).toHaveLength(1) // identical omitted entries dedupe
    expect(list[0]!.text).toBe('[message omitted]')
    expect(list[0]!.count).toBe(2)
  })

  it('never persists the asset set', () => {
    recordDashboardError({ category: 'window-error', error: propError() })
    const raw = localStorage.getItem(ERROR_HISTORY_KEY)!
    // The bundle name appears only inside a validated frame, and no key holds a list of assets.
    expect(raw.toLowerCase().includes('asset')).toBe(false)
    expect(Object.keys(localStorage)).toEqual([ERROR_HISTORY_KEY])
    for (const s of ['assetBasenames', 'assets', 'scripts']) expect(raw.includes(s)).toBe(false)
  })

  it('skips the benign resize-observer-loop template', () => {
    recordDashboardError({
      category: 'window-error',
      error: new Error('ResizeObserver loop completed with undelivered notifications.'),
    })
    expect(readErrorHistory()).toEqual([])
    expect(localStorage.getItem(ERROR_HISTORY_KEY)).toBeNull()
  })

  it('drops a non-semver version', async () => {
    vi.stubGlobal('__APP_VERSION__', '1.2.3-PRIVATE')
    try {
      vi.resetModules()
      const mod = await import('./error-history')
      mod.recordDashboardError({ category: 'window-error', error: propError() })
      expect(mod.readErrorHistory()[0]!.version).toBe('unknown')
      localStorage.clear()
      vi.stubGlobal('__APP_VERSION__', '1.2.3')
      mod.recordDashboardError({ category: 'window-error', error: propError() })
      expect(mod.readErrorHistory()[0]!.version).toBe('1.2.3')
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('bounds and retention', () => {
  it('keeps at most 20 entries, newest first, evicting the oldest', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T00:00:00.000Z'))
    for (let i = 0; i < 21; i++) {
      vi.advanceTimersByTime(1000)
      recordDashboardError({ category: 'window-error', error: new TypeError(`Cannot read properties of undefined (reading 'prop${'abcdefghijklmnopqrstu'[i]}ender')`) })
    }
    const list = readErrorHistory()
    expect(list).toHaveLength(20)
    expect(list[0]!.time > list[19]!.time).toBe(true)
    expect(list.some(e => e.text.includes('propaender'))).toBe(false)
    expect(list.some(e => e.text.includes('propuender'))).toBe(true)
  })

  it('dedupes a repeat into count and time', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T00:00:00.000Z'))
    recordDashboardError({ category: 'window-error', error: propError() })
    vi.advanceTimersByTime(5000)
    recordDashboardError({ category: 'window-error', error: propError() })
    const list = readErrorHistory()
    expect(list).toHaveLength(1)
    expect(list[0]!.count).toBe(2)
    expect(list[0]!.time).toBe('2026-11-20T00:00:05.000Z')
    expect(list[0]!.firstTime).toBe('2026-11-20T00:00:00.000Z')
  })

  it('does not dedupe across categories', () => {
    recordDashboardError({ category: 'window-error', error: propError() })
    recordDashboardError({ category: 'unhandled-rejection', error: propError() })
    expect(readErrorHistory()).toHaveLength(2)
  })

  it('prunes entries older than 30 days on read and write', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
    recordDashboardError({ category: 'window-error', error: propError() })
    expect(readErrorHistory()).toHaveLength(1)
    vi.setSystemTime(new Date('2026-11-15T00:00:00.000Z'))
    expect(readErrorHistory()).toEqual([])
    recordDashboardError({ category: 'render', error: propError() })
    const stored = JSON.parse(localStorage.getItem(ERROR_HISTORY_KEY)!) as unknown[]
    expect(stored).toHaveLength(1)
  })

  it('clearErrorHistory removes the key and notifies subscribers', () => {
    recordDashboardError({ category: 'window-error', error: propError() })
    const listener = vi.fn()
    const off = subscribeErrorHistory(listener)
    clearErrorHistory()
    expect(localStorage.getItem(ERROR_HISTORY_KEY)).toBeNull()
    expect(readErrorHistory()).toEqual([])
    expect(listener).toHaveBeenCalledTimes(1)
    off()
    recordDashboardError({ category: 'window-error', error: propError() })
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('notifies subscribers on record', () => {
    const listener = vi.fn()
    subscribeErrorHistory(listener)
    recordDashboardError({ category: 'window-error', error: propError() })
    expect(listener).toHaveBeenCalledTimes(1)
  })
})

describe('storage failure', () => {
  it('serves from the in-memory ring and never throws when storage throws', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new Error('denied') })
    const spy = vi.spyOn(console, 'error')
    expect(() => recordDashboardError({ category: 'window-error', error: propError() })).not.toThrow()
    expect(() => recordDashboardError({ category: 'window-error', error: propError() })).not.toThrow()
    const list = readErrorHistory()
    expect(list).toHaveLength(1)
    expect(list[0]!.count).toBe(2)
    expect(() => clearErrorHistory()).not.toThrow()
    expect(readErrorHistory()).toEqual([])
    expect(spy).not.toHaveBeenCalled()
  })

  it('keeps serving from memory when only the write fails', () => {
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => { throw new Error('quota') })
    const listener = vi.fn()
    subscribeErrorHistory(listener)
    recordDashboardError({ category: 'window-error', error: propError() })
    expect(readErrorHistory()).toHaveLength(1)
    // a failed write still completes the record: the open Diagnostics view is told
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('resets corrupt JSON to empty', () => {
    localStorage.setItem(ERROR_HISTORY_KEY, '{not json')
    expect(readErrorHistory()).toEqual([])
    expect(localStorage.getItem(ERROR_HISTORY_KEY)).toBeNull()
    recordDashboardError({ category: 'window-error', error: propError() })
    expect(readErrorHistory()).toHaveLength(1)
  })

  it('resets an unexpected shape (an object, not an array)', () => {
    localStorage.setItem(ERROR_HISTORY_KEY, JSON.stringify({ entries: [] }))
    expect(readErrorHistory()).toEqual([])
    expect(localStorage.getItem(ERROR_HISTORY_KEY)).toBeNull()
  })

  it('re-validates a poisoned stored entry before returning it', () => {
    const secret = ['gh', 'p_'].join('') + 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789'
    const now = new Date().toISOString()
    localStorage.setItem(ERROR_HISTORY_KEY, JSON.stringify([
      {
        id: '<img src=x onerror=alert(1)>', time: now, firstTime: 'PRIVATE', count: 'lots',
        category: 'render', platform: 'PRIVATE', version: `1.2.3 ${secret}`,
        name: 'PrivateError', template: 'PRIVATE', text: `Unexpected token PRIVATE ${secret}`,
        stack: [
          `at x (file:///Users/alice/app.js:1:2)`,
          `at y (data:text/plain,PRIVATE:1:1)`,
          'PRIVATE free text',
        ],
        componentStack: ['PRIVATE free text with spaces', 'GoodComponent'],
      },
      'not an object',
      { time: 'nope', category: 'render' },
      { time: now, category: 'PRIVATE' },
    ]))
    const list = readErrorHistory()
    expect(list).toHaveLength(1)
    const e = list[0]!
    expect(e.text).toBe('[message omitted]')
    expect(e.name).toBe('Error')
    expect(e.template).toBeNull()
    expect(e.version).toBe('unknown')
    expect(e.platform).toBe('web')
    expect(e.count).toBe(1)
    expect(e.id).toMatch(/^[a-z0-9]{1,12}$/)
    expect(e.componentStack).toEqual(['GoodComponent'])
    const report = formatHistoryEntry(e)
    const everything = JSON.stringify(list) + report
    for (const needle of ['PRIVATE', 'alice', 'data:', 'file:', secret, 'onerror']) {
      expect(everything.includes(needle), needle).toBe(false)
    }
    // And the formatter over the raw poisoned object is also clean.
    const raw = (JSON.parse(localStorage.getItem(ERROR_HISTORY_KEY)!) as Record<string, unknown>[])[0]!
    const direct = formatErrorReport({ ...(raw as object), message: raw.text } as never)
    expect(direct.includes(secret)).toBe(false)
    expect(direct.includes('PRIVATE')).toBe(false)
  })
})

describe('currentAssetBasenames', () => {
  it('keeps only same-origin http(s) scripts', () => {
    addScript(`${location.origin}/assets/chunk-xyz.js`)
    addScript('https://evil.example.com/assets/evil.js')
    addScript('file:///Users/alice/local.js')
    addScript('data:text/javascript,alert(1)')
    addScript('//evil.example.com/protocol-relative.js')
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      { name: `${location.origin}/assets/dynamic-123.js?v=2` },
      { name: `${location.origin}/assets/style.css` },
      { name: 'https://evil.example.com/other.js' },
      { name: `${location.origin}/assets/mod-9.mjs` },
    ] as unknown as PerformanceEntryList)
    const set = currentAssetBasenames()
    expect([...set].sort()).toEqual([BUNDLE, 'chunk-xyz.js', 'dynamic-123.js', 'mod-9.mjs'].sort())
  })

  it('is empty (fail closed) when nothing qualifies, and frame locations become <unknown>', () => {
    document.head.querySelectorAll('script').forEach(s => s.remove())
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([])
    expect(currentAssetBasenames().size).toBe(0)
    recordDashboardError({ category: 'window-error', error: propError() })
    expect(readErrorHistory()[0]!.stack).toEqual(['renderChart @ <unknown>'])
  })

  it('is never trusted from stored data: a poisoned frame location is dropped', () => {
    const now = new Date().toISOString()
    localStorage.setItem(ERROR_HISTORY_KEY, JSON.stringify([{
      id: 'abc123', time: now, firstTime: now, count: 1, category: 'render', platform: 'web', version: '1.0.0',
      name: 'Error', template: null, text: '[message omitted]',
      stack: ['renderChart @ not-a-loaded-script.js:1:1'], componentStack: [],
    }]))
    expect(readErrorHistory()[0]!.stack).toEqual(['renderChart @ <unknown>'])
  })
})
