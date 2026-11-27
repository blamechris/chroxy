import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  ERROR_HISTORY_KEY,
  peekErrorHistory,
  __resetErrorHistoryForTests,
  __setModuleUrlForTests,
  pruneErrorHistory,
  clearErrorHistory,
  currentAssetBasenames,
  formatHistoryEntry,
  readErrorHistory,
  recordDashboardError,
  subscribeErrorHistory,
} from './error-history'
import { formatErrorReport } from './error-report'
import { failStorage, restoreStorage } from './storage-fault.testSupport'

const BUNDLE = 'index-Dvf46w8T.js'
const ASSETS = '/dashboard/assets'

// Two distinct messages whose 6-char local ids collide at the fixed time below (found by search).
const collidingError = (prop: string): Error => Object.assign(
  new TypeError(`Cannot read properties of undefined (reading '${prop}')`), { stack: '' })

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
  e.stack = `TypeError: x\n    at renderChart (${location.origin}${ASSETS}/${BUNDLE}:10:20)`
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
  __setModuleUrlForTests(`${location.origin}${ASSETS}/${BUNDLE}`)
  addScript(`${location.origin}${ASSETS}/${BUNDLE}`)
})

afterEach(() => {
  restoreStorage()
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
      `    at renderChart (${location.origin}${ASSETS}/${BUNDLE}:3:4)`,
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
    expect(localStorage.length).toBe(1)
    expect(localStorage.key(0)).toBe(ERROR_HISTORY_KEY)
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
    failStorage('setItem', 'quota')
    failStorage('getItem', 'denied')
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
    failStorage('setItem', 'quota')
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
  const entry = (name: string, initiatorType: string) => ({ name: `${location.origin}${name}`, initiatorType })

  it('keeps real hashed assets in the own assets directory, from scripts and script/link resources', () => {
    addScript(`${location.origin}${ASSETS}/chunk-2Q5K7J3B-yng0oyO0.js`)
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      entry(`${ASSETS}/cose-bilkent-JH36ORCC-ywTmjP-W.js?v=2`, 'script'),
      entry(`${ASSETS}/mod-AbCd1234.mjs`, 'script'),
    ] as unknown as PerformanceEntryList)
    expect([...currentAssetBasenames()].sort()).toEqual(
      [BUNDLE, 'chunk-2Q5K7J3B-yng0oyO0.js', 'cose-bilkent-JH36ORCC-ywTmjP-W.js', 'mod-AbCd1234.mjs'].sort())
  })

  it('rejects an IMAGE resource named like a script (the provenance repro)', () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      entry(`${ASSETS}/PatientAlice-HIVPosit.js`, 'img'),
      entry(`${ASSETS}/PatientAlice-HIVPosit.js`, 'fetch'),
      entry(`${ASSETS}/PatientAlice-HIVPosit.js`, 'xmlhttprequest'),
    ] as unknown as PerformanceEntryList)
    expect(currentAssetBasenames().has('PatientAlice-HIVPosit.js')).toBe(false)
    const e = Object.assign(new TypeError("Cannot read properties of undefined (reading 'x')"), {
      stack: `TypeError: x\n    at fn (${location.origin}${ASSETS}/PatientAlice-HIVPosit.js:1:2)`,
    })
    recordDashboardError({ category: 'window-error', error: e })
    expect(localStorage.getItem(ERROR_HISTORY_KEY)!.includes('PatientAlice')).toBe(false)
  })

  it('also rejects the unhashed image repro name', () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      entry(`${ASSETS}/PatientAliceHIVPositive.js`, 'img'),
    ] as unknown as PerformanceEntryList)
    expect(currentAssetBasenames().has('PatientAliceHIVPositive.js')).toBe(false)
  })

  it('rejects scripts and resources outside the own assets directory, unhashed names, other origins', () => {
    addScript(`${location.origin}/other/dir/index-AbCd1234.js`)
    addScript(`${location.origin}${ASSETS}/sub/index-AbCd1234.js`)
    addScript(`${location.origin}${ASSETS}/PatientAliceHIVPositive.js`)
    addScript(`${location.origin}${ASSETS}/short-AbCd12.js`)
    addScript('https://evil.example.com/dashboard/assets/index-AbCd1234.js')
    addScript('file:///Users/alice/dashboard/assets/index-AbCd1234.js')
    addScript('data:text/javascript,alert(1)')
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      entry('/other/dir/chunk-AbCd1234.js', 'script'),
      entry(`${ASSETS}/style-AbCd1234.css`, 'link'),
    ] as unknown as PerformanceEntryList)
    expect([...currentAssetBasenames()]).toEqual([BUNDLE])
  })

  it('does not admit a link-initiated resource entry', () => {
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue([
      entry(`${ASSETS}/pre-AbCd1234.js`, 'link'),
    ] as unknown as PerformanceEntryList)
    expect(currentAssetBasenames().has('pre-AbCd1234.js')).toBe(false)
  })

  it('admits only module or untyped script elements', () => {
    const typed = addScript(`${location.origin}${ASSETS}/text-AbCd1234.js`)
    typed.setAttribute('type', 'text/plain')
    const mod = addScript(`${location.origin}${ASSETS}/mod-AbCd1234.js`)
    mod.setAttribute('type', 'module')
    const set = currentAssetBasenames()
    expect(set.has('text-AbCd1234.js')).toBe(false)
    expect(set.has('mod-AbCd1234.js')).toBe(true)
  })

  it('inspects at most 200 script elements', () => {
    document.head.querySelectorAll('script').forEach(s => s.remove())
    for (let i = 0; i < 205; i++) addScript(`${location.origin}${ASSETS}/s${i}-AbCd${String(1000 + i)}.js`)
    const set = currentAssetBasenames()
    expect(set.has('s199-AbCd1199.js')).toBe(true)
    expect(set.has('s200-AbCd1200.js')).toBe(false)
  })

  it('inspects at most 200 resource entries', () => {
    const many = Array.from({ length: 300 }, (_, i) => entry(`${ASSETS}/c${i}-AbCd${String(1000 + i)}.js`, 'script'))
    vi.spyOn(performance, 'getEntriesByType').mockReturnValue(many as unknown as PerformanceEntryList)
    const set = currentAssetBasenames()
    expect(set.has('c199-AbCd1199.js')).toBe(true)
    expect(set.has('c200-AbCd1200.js')).toBe(false)
  })

  it('is empty (fail closed) outside a built bundle, and frame locations become <unknown>', () => {
    __setModuleUrlForTests('file:///Users/alice/src/utils/error-history.ts')
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

describe('in-memory ring semantics', () => {
  const err = (p: string) => new TypeError(`Cannot read properties of undefined (reading '${p}')`)

  it('does not resurrect entries after another tab clears the key', () => {
    recordDashboardError({ category: 'window-error', error: err('first') })
    expect(readErrorHistory()).toHaveLength(1)
    localStorage.removeItem(ERROR_HISTORY_KEY) // the other tab
    window.dispatchEvent(new StorageEvent('storage', { key: ERROR_HISTORY_KEY }))
    expect(readErrorHistory()).toEqual([])
    recordDashboardError({ category: 'window-error', error: err('second') })
    const list = readErrorHistory()
    expect(list).toHaveLength(1)
    expect(list[0]!.text).toContain('second')
  })

  it('returns [] and drops the ring when the key is absent even without a storage event', () => {
    recordDashboardError({ category: 'window-error', error: err('first') })
    localStorage.removeItem(ERROR_HISTORY_KEY)
    expect(readErrorHistory()).toEqual([])
  })

  it('notifies subscribers on a storage event for the key only', () => {
    const listener = vi.fn()
    subscribeErrorHistory(listener)
    window.dispatchEvent(new StorageEvent('storage', { key: 'something_else' }))
    expect(listener).not.toHaveBeenCalled()
    window.dispatchEvent(new StorageEvent('storage', { key: ERROR_HISTORY_KEY }))
    expect(listener).toHaveBeenCalledTimes(1)
  })

  it('after a quota failure on an existing key, the newest error is visible (dirty ring wins)', () => {
    recordDashboardError({ category: 'window-error', error: err('first') })
    failStorage('setItem', 'quota')
    recordDashboardError({ category: 'window-error', error: err('second') })
    const list = readErrorHistory()
    expect(list).toHaveLength(2)
    expect(list[0]!.text).toContain('second')
    restoreStorage()
    // a later successful write ends the dirty state and persists everything
    recordDashboardError({ category: 'window-error', error: err('third') })
    const stored = JSON.parse(localStorage.getItem(ERROR_HISTORY_KEY)!) as unknown[]
    expect(stored).toHaveLength(3)
    expect(readErrorHistory()[0]!.text).toContain('third')
  })
})

describe('expiry deletes, bounded work', () => {
  const err = (p: string) => new TypeError(`Cannot read properties of undefined (reading '${p}')`)

  it('a read at +31 days removes the stored value', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
    recordDashboardError({ category: 'window-error', error: err('first') })
    expect(localStorage.getItem(ERROR_HISTORY_KEY)).not.toBeNull()
    vi.setSystemTime(new Date('2026-11-01T00:00:01.000Z'))
    expect(readErrorHistory()).toEqual([])
    expect(localStorage.getItem(ERROR_HISTORY_KEY)).toBeNull()
  })

  it('pruneErrorHistory rewrites a partly expired list', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
    recordDashboardError({ category: 'window-error', error: err('old') })
    vi.setSystemTime(new Date('2026-10-30T00:00:00.000Z'))
    recordDashboardError({ category: 'window-error', error: err('newer') })
    vi.setSystemTime(new Date('2026-11-05T00:00:00.000Z'))
    pruneErrorHistory()
    const stored = JSON.parse(localStorage.getItem(ERROR_HISTORY_KEY)!) as { text: string }[]
    expect(stored).toHaveLength(1)
    expect(stored[0]!.text).toContain('newer')
  })

  it('clamps a future-dated entry to now so it ages out', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
    localStorage.setItem(ERROR_HISTORY_KEY, JSON.stringify([{
      id: 'abc123', time: '2099-01-01T00:00:00.000Z', firstTime: '2099-01-01T00:00:00.000Z', count: 1,
      category: 'render', platform: 'web', version: '1.0.0', name: 'Error', template: null,
      text: '[message omitted]', stack: [], componentStack: [],
    }]))
    expect(readErrorHistory()[0]!.time).toBe('2026-10-01T00:00:00.000Z')
    vi.setSystemTime(new Date('2026-11-05T00:00:00.000Z'))
    expect(readErrorHistory()).toEqual([])
  })

  it('resets a stored value over 64 KB', () => {
    localStorage.setItem(ERROR_HISTORY_KEY, JSON.stringify([{ pad: 'x'.repeat(70 * 1024) }]))
    expect(readErrorHistory()).toEqual([])
    expect(localStorage.getItem(ERROR_HISTORY_KEY)).toBeNull()
  })

  it('cuts each stored stack line before it is parsed', () => {
    const now = new Date().toISOString()
    const huge = `ok @ ${'a'.repeat(5000)}.js:1:1`
    localStorage.setItem(ERROR_HISTORY_KEY, JSON.stringify([{
      id: 'abc123', time: now, firstTime: now, count: 1, category: 'render', platform: 'web', version: '1.0.0',
      name: 'Error', template: null, text: '[message omitted]', stack: [huge], componentStack: [],
    }]))
    expect(readErrorHistory()[0]!.stack.join('').length).toBeLessThan(400)
  })

  it('drops REPEATS beyond 10 per second, then resumes', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T00:00:00.000Z'))
    for (let i = 0; i < 15; i++) recordDashboardError({ category: 'window-error', error: err('same') })
    expect(readErrorHistory()[0]!.count).toBe(10)
    vi.advanceTimersByTime(1001)
    recordDashboardError({ category: 'window-error', error: err('same') })
    expect(readErrorHistory()[0]!.count).toBe(11)
  })

  it('never drops the first occurrence of a new key, even over budget', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T00:00:00.000Z'))
    for (let i = 0; i < 10; i++) recordDashboardError({ category: 'window-error', error: err('same') })
    recordDashboardError({ category: 'window-error', error: err('real') })
    const list = readErrorHistory()
    expect(list.some(e => e.text.includes('real'))).toBe(true)
    expect(list.some(e => e.text.includes('same') && e.count === 10)).toBe(true)
  })

  it('lets render errors bypass the budget', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T00:00:00.000Z'))
    for (let i = 0; i < 14; i++) recordDashboardError({ category: 'render', error: err('same') })
    expect(readErrorHistory()[0]!.count).toBe(14)
  })

  it('gives colliding hashes distinct ids', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T00:00:00.000Z'))
    recordDashboardError({ category: 'window-error', error: collidingError('ludibaba') })
    recordDashboardError({ category: 'window-error', error: collidingError('sadobaba') })
    const list = readErrorHistory()
    expect(list).toHaveLength(2)
    expect(list.map(e => e.text).join(' ')).toMatch(/ludibaba[\s\S]*sadobaba|sadobaba[\s\S]*ludibaba/)
    expect(new Set(list.map(e => e.id)).size).toBe(2)
  })

  it('drops a stored duplicate id on read', () => {
    const now = new Date().toISOString()
    const e = (text: string) => ({
      id: 'dup123', time: now, firstTime: now, count: 1, category: 'render', platform: 'web', version: '1.0.0',
      name: 'Error', template: null, text, stack: [], componentStack: [],
    })
    localStorage.setItem(ERROR_HISTORY_KEY, JSON.stringify([e('[message omitted]'), e('[message omitted]')]))
    expect(readErrorHistory()).toHaveLength(1)
  })
})

describe('write-side size budget', () => {
  it('twenty maximum-shape entries round-trip: the newest survive and nothing is wiped', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-11-20T00:00:00.000Z'))
    // Long identifier-shaped component paths and 12 frames: the largest shape the normalisers admit.
    const seg = 'Alpha'.repeat(8) // the longest word-shaped identifier the normalisers keep
    const path = `${seg}.${seg}.${seg}.${seg}` // a 4-segment member path: the longest name shape
    const comp = Array.from({ length: 15 }, (_, k) => `    at ${path.slice(0, -1)}${'abcdefghijklmno'[k]}`).join('\n')
    const frames = Array.from({ length: 12 }, (_, k) => `    at ${path.slice(0, -1)}${'abcdefghijkl'[k]} (${location.origin}${ASSETS}/${BUNDLE}:${100 + k}:${200 + k})`).join('\n')
    for (let i = 0; i < 20; i++) {
      vi.advanceTimersByTime(1500)
      const e = Object.assign(new TypeError(`Cannot read properties of undefined (reading '${'abcdefghijklmnopqrst'[i]}ender')`), {
        stack: `TypeError: x\n${frames}`,
      })
      recordDashboardError({ category: 'render', error: e, componentStack: `\n${comp}` })
      // never a wipe: once the budget bites, the retained count must hold, not drop to one
      expect(readErrorHistory().length).toBeGreaterThanOrEqual(Math.min(i + 1, 8))
    }
    const stored = localStorage.getItem(ERROR_HISTORY_KEY)!
    expect(stored.length).toBeLessThanOrEqual(48 * 1024)
    const list = readErrorHistory()
    expect(list.length).toBeGreaterThan(0)
    expect(list.length).toBeLessThan(20) // the budget evicted the oldest rather than the read wiping all
    expect(list[0]!.text).toContain('tender') // the newest survived
    expect(localStorage.getItem(ERROR_HISTORY_KEY)).not.toBeNull() // and the read did not reset it
  })
})

describe('external clear versus the dirty ring', () => {
  const err = (p: string) => new TypeError(`Cannot read properties of undefined (reading '${p}')`)

  it('the user clear wins over a dirty ring (record, failed write, external remove, record)', () => {
    recordDashboardError({ category: 'window-error', error: err('first') })
    failStorage('setItem', 'quota')
    recordDashboardError({ category: 'window-error', error: err('second') })
    localStorage.removeItem(ERROR_HISTORY_KEY) // the other tab clears
    window.dispatchEvent(new StorageEvent('storage', { key: ERROR_HISTORY_KEY, newValue: null }))
    restoreStorage()
    recordDashboardError({ category: 'window-error', error: err('third') })
    const stored = JSON.parse(localStorage.getItem(ERROR_HISTORY_KEY)!) as { text: string }[]
    expect(stored).toHaveLength(1)
    expect(stored[0]!.text).toContain('third')
  })

  it('a storage clear() (key null) also wins over a dirty ring', () => {
    failStorage('setItem', 'quota')
    recordDashboardError({ category: 'window-error', error: err('first') })
    window.dispatchEvent(new StorageEvent('storage', { key: null }))
    restoreStorage()
    expect(readErrorHistory()).toEqual([])
  })

  it('merges our unsaved entries into another tab\'s new value and stays dirty until a write succeeds', () => {
    failStorage('setItem', 'quota')
    recordDashboardError({ category: 'window-error', error: err('mine') })
    const now = new Date().toISOString()
    const theirs = [{
      id: 'oth123', time: now, firstTime: now, count: 1, category: 'window-error', platform: 'web',
      version: '1.0.0', name: 'TypeError', template: 'read-props-of',
      text: "Cannot read properties of undefined (reading 'theirs')", stack: [], componentStack: [],
    }]
    window.dispatchEvent(new StorageEvent('storage', { key: ERROR_HISTORY_KEY, newValue: JSON.stringify(theirs) }))
    const merged = readErrorHistory()
    expect(merged.map(e => e.text).join(' ')).toMatch(/mine/)
    expect(merged.map(e => e.text).join(' ')).toMatch(/theirs/)
    expect(merged).toHaveLength(2)
    restoreStorage()
    // the next successful write persists the merged list
    recordDashboardError({ category: 'window-error', error: err('later') })
    const stored = JSON.parse(localStorage.getItem(ERROR_HISTORY_KEY)!) as unknown[]
    expect(stored).toHaveLength(3)
  })
})

describe('dirty-ring expiry', () => {
  it('quota failure, +31 days, storage restored, prune: the key is gone', () => {
    vi.useFakeTimers()
    vi.setSystemTime(new Date('2026-10-01T00:00:00.000Z'))
    recordDashboardError({ category: 'window-error', error: new TypeError("Cannot read properties of undefined (reading 'first')") })
    failStorage('setItem', 'quota')
    vi.setSystemTime(new Date('2026-10-02T00:00:00.000Z'))
    recordDashboardError({ category: 'window-error', error: new TypeError("Cannot read properties of undefined (reading 'second')") })
    expect(localStorage.getItem(ERROR_HISTORY_KEY)).not.toBeNull()
    restoreStorage()
    vi.setSystemTime(new Date('2026-11-05T00:00:00.000Z'))
    pruneErrorHistory()
    expect(localStorage.getItem(ERROR_HISTORY_KEY)).toBeNull()
    expect(readErrorHistory()).toEqual([])
  })
})

describe('peekErrorHistory (first paint)', () => {
  it('never writes, while readErrorHistory deletes what expired', () => {
    const now = new Date().toISOString()
    const mk = (time: string, id: string) => ({
      id, time, firstTime: time, count: 1, category: 'render', platform: 'web', version: '1.0.0',
      name: 'Error', template: null, text: '[message omitted]', stack: [], componentStack: [],
    })
    const value = JSON.stringify([mk(now, 'new123'), mk('2020-01-01T00:00:00.000Z', 'old123')])
    localStorage.setItem(ERROR_HISTORY_KEY, value)
    expect(peekErrorHistory()).toHaveLength(1)
    expect(localStorage.getItem(ERROR_HISTORY_KEY)).toBe(value)
    expect(readErrorHistory()).toHaveLength(1)
    expect(localStorage.getItem(ERROR_HISTORY_KEY)).not.toBe(value)
  })
})
