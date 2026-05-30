import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, statSync, readFileSync, existsSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  defaultNotificationPrefsPath,
  loadPrefs,
  savePrefs,
  resolveCategoryDecision,
  isCategoryEnabledIn,
  isInQuietHoursIn,
  CATEGORY_DEFAULTS,
  ALL_CATEGORIES,
} from '../src/notification-prefs.js'

let tmpDir
let prefsPath

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), 'chroxy-notif-prefs-'))
  prefsPath = join(tmpDir, 'notification-prefs.json')
})

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true })
})

describe('notification-prefs', () => {
  describe('defaultNotificationPrefsPath', () => {
    it('respects CHROXY_NOTIFICATION_PREFS_PATH env var when set', () => {
      const prev = process.env.CHROXY_NOTIFICATION_PREFS_PATH
      process.env.CHROXY_NOTIFICATION_PREFS_PATH = '/tmp/forced-prefs.json'
      try {
        assert.equal(defaultNotificationPrefsPath(), '/tmp/forced-prefs.json')
      } finally {
        if (prev) process.env.CHROXY_NOTIFICATION_PREFS_PATH = prev
        else delete process.env.CHROXY_NOTIFICATION_PREFS_PATH
      }
    })
  })

  describe('CATEGORY_DEFAULTS', () => {
    it('enumerates every RATE_LIMITS category', () => {
      // The canonical category list from push.js RATE_LIMITS — categories
      // here MUST match so the per-category UI gates the same set of pushes
      // the server actually fires. Adding a new push category requires
      // adding it to this default map (and consequently to the wire shape).
      for (const cat of ALL_CATEGORIES) {
        assert.equal(typeof CATEGORY_DEFAULTS[cat], 'boolean', `missing default for ${cat}`)
      }
    })

    it('defaults every category to enabled', () => {
      // Backward compatibility: a fresh install with no prefs file behaves
      // exactly like pre-#4541 — every category fires unless the user
      // explicitly mutes it.
      for (const cat of ALL_CATEGORIES) {
        assert.equal(CATEGORY_DEFAULTS[cat], true, `${cat} must default true`)
      }
    })
  })

  describe('loadPrefs', () => {
    it('returns defaults when file is missing (first run)', () => {
      const prefs = loadPrefs(prefsPath)
      assert.deepEqual(prefs.categories, CATEGORY_DEFAULTS)
      assert.deepEqual(prefs.devices, {})
      assert.equal(prefs.quietHours, null)
    })

    it('returns defaults + warns when file is malformed', () => {
      writeFileSync(prefsPath, '{ not json')
      const warned = []
      const prefs = loadPrefs(prefsPath, { log: { warn: (m) => warned.push(m) } })
      assert.deepEqual(prefs.categories, CATEGORY_DEFAULTS)
      assert.equal(warned.length, 1)
      assert.match(warned[0], /unreadable/)
    })

    it('parses a well-formed file and merges over defaults', () => {
      // #4544 tightened the quiet-hours shape to require a timezone — a
      // window without one is dropped on load. The legacy two-field
      // shape (start/end only) is exercised separately below to lock in
      // that defensive behaviour.
      const onDisk = {
        categories: { result: false },
        devices: { 'ExponentPushToken[abc]': { categories: { permission: false } } },
        quietHours: { start: '22:00', end: '07:00', timezone: 'America/Los_Angeles' },
      }
      writeFileSync(prefsPath, JSON.stringify(onDisk))
      const prefs = loadPrefs(prefsPath)
      assert.equal(prefs.categories.result, false)
      // Untouched categories preserve defaults
      assert.equal(prefs.categories.permission, true)
      assert.equal(prefs.devices['ExponentPushToken[abc]'].categories.permission, false)
      assert.equal(prefs.quietHours.start, '22:00')
    })

    it('drops unknown category keys silently', () => {
      writeFileSync(prefsPath, JSON.stringify({ categories: { bogus_category: false, result: false } }))
      const prefs = loadPrefs(prefsPath)
      assert.equal(prefs.categories.bogus_category, undefined)
      assert.equal(prefs.categories.result, false)
    })
  })

  describe('savePrefs', () => {
    it('creates the file with mode 0600', () => {
      savePrefs({ categories: { result: false } }, prefsPath)
      if (process.platform !== 'win32') {
        const mode = statSync(prefsPath).mode & 0o777
        assert.equal(mode, 0o600)
      }
    })

    it('round-trips through loadPrefs', () => {
      // #4544: timezone is required for the window to survive the loader.
      const written = {
        categories: { result: false, permission: true },
        devices: { 'tok-1': { categories: { result: true } } },
        quietHours: { start: '23:00', end: '06:00', timezone: 'America/Los_Angeles' },
      }
      savePrefs(written, prefsPath)
      const reread = loadPrefs(prefsPath)
      assert.equal(reread.categories.result, false)
      assert.equal(reread.categories.permission, true)
      assert.equal(reread.devices['tok-1'].categories.result, true)
      assert.equal(reread.quietHours.start, '23:00')
    })

    it('creates the parent directory if missing', () => {
      const nested = join(tmpDir, 'nested', 'sub', 'notification-prefs.json')
      savePrefs({ categories: {} }, nested)
      assert.ok(statSync(nested).isFile())
    })

    it('uses atomic temp+rename (no .tmp left behind on success)', () => {
      savePrefs({ categories: { result: false } }, prefsPath)
      const dirEntries = readdirSync(tmpDir)
      const leftovers = dirEntries.filter((n) => n.endsWith('.tmp'))
      assert.equal(leftovers.length, 0, 'no .tmp files should remain after a successful save')
    })

    it('overwrites an existing file atomically', () => {
      savePrefs({ categories: { result: false } }, prefsPath)
      savePrefs({ categories: { result: true, permission: false } }, prefsPath)
      const reread = loadPrefs(prefsPath)
      assert.equal(reread.categories.result, true)
      assert.equal(reread.categories.permission, false)
    })
  })

  describe('resolveCategoryDecision', () => {
    it('returns the global default when no per-device override exists', () => {
      const prefs = loadPrefs(prefsPath)
      assert.equal(resolveCategoryDecision(prefs, 'result', 'token-x'), true)
    })

    it('respects global mute', () => {
      const prefs = { categories: { result: false }, devices: {}, quietHours: null }
      assert.equal(resolveCategoryDecision(prefs, 'result', 'token-x'), false)
    })

    it('per-device override beats the global default', () => {
      // Global says "mute permission for everyone"; this specific device
      // explicitly re-enables it — per-device wins.
      const prefs = {
        categories: { permission: false },
        devices: { 'token-a': { categories: { permission: true } } },
        quietHours: null,
      }
      assert.equal(resolveCategoryDecision(prefs, 'permission', 'token-a'), true)
      // Other devices still see the global mute.
      assert.equal(resolveCategoryDecision(prefs, 'permission', 'token-b'), false)
    })

    it('per-device mute beats the global enable', () => {
      const prefs = {
        categories: { result: true },
        devices: { 'phone-1': { categories: { result: false } } },
        quietHours: null,
      }
      assert.equal(resolveCategoryDecision(prefs, 'result', 'phone-1'), false)
      assert.equal(resolveCategoryDecision(prefs, 'result', 'desktop-1'), true)
    })

    it('unknown category defaults true (fail-open, never silently drop a push the server tried to fire)', () => {
      const prefs = loadPrefs(prefsPath)
      assert.equal(resolveCategoryDecision(prefs, 'category_not_in_defaults', 'token'), true)
    })

    it('null pushToken falls back to global default (no per-device branch)', () => {
      const prefs = {
        categories: { result: false },
        devices: { 'tok-a': { categories: { result: true } } },
        quietHours: null,
      }
      assert.equal(resolveCategoryDecision(prefs, 'result', null), false)
      assert.equal(resolveCategoryDecision(prefs, 'result', undefined), false)
    })
  })

  describe('isCategoryEnabledIn (alias for resolveCategoryDecision)', () => {
    it('returns the same decision as resolveCategoryDecision', () => {
      const prefs = { categories: { result: false }, devices: {}, quietHours: null }
      assert.equal(isCategoryEnabledIn(prefs, 'result', 'tok'), resolveCategoryDecision(prefs, 'result', 'tok'))
    })
  })

  describe('isInQuietHoursIn (stub for #4544)', () => {
    // Quiet-hours UI is deferred to sub-issue #4544. The foundation only
    // needs the entry point to exist so callers can wire to it. Returns
    // false when no window is configured.
    it('returns false when quietHours is null', () => {
      assert.equal(isInQuietHoursIn({ quietHours: null }, Date.now(), 'tok'), false)
    })

    it('returns false when quietHours is undefined', () => {
      assert.equal(isInQuietHoursIn({}, Date.now(), 'tok'), false)
    })
  })

  describe('atomic write — rename failure cleanup (#4541, mirrors #4463)', () => {
    if (typeof mock.module !== 'function') {
      it('skipped — mock.module requires --experimental-test-module-mocks', (t) => {
        t.skip('re-run with --experimental-test-module-mocks to exercise these tests')
      })
    } else {
      it('unlinks the leaked .tmp file when renameSync fails', async () => {
        const realFs = await import('node:fs')
        const renameError = new Error('EXDEV cross-device link')
        const unlinkCalls = []
        const mockFs = {
          ...realFs,
          renameSync: () => { throw renameError },
          unlinkSync: (p) => { unlinkCalls.push(p) },
        }
        mock.module('node:fs', { defaultExport: mockFs, namedExports: mockFs })
        try {
          const { savePrefs: sp } = await import(`../src/notification-prefs.js?cacheBust=4541-${Date.now()}`)
          let threw = null
          try {
            sp({ categories: { result: false } }, prefsPath)
          } catch (err) {
            threw = err
          }
          assert.ok(threw, 'savePrefs must re-throw the rename failure')
          assert.match(threw.message, /EXDEV/, 'original error is surfaced')
          assert.ok(unlinkCalls.some((p) => p.endsWith('.tmp')), 'cleanup must target the .tmp file')
        } finally {
          mock.restoreAll()
        }
      })

      it('tolerates the .tmp already being absent during cleanup', async () => {
        const realFs = await import('node:fs')
        const renameError = new Error('original rename failure')
        const mockFs = {
          ...realFs,
          renameSync: () => { throw renameError },
          unlinkSync: () => { throw Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) },
        }
        mock.module('node:fs', { defaultExport: mockFs, namedExports: mockFs })
        try {
          const { savePrefs: sp } = await import(`../src/notification-prefs.js?cacheBust=4541b-${Date.now()}`)
          let threw = null
          try {
            sp({ categories: { result: false } }, prefsPath)
          } catch (err) {
            threw = err
          }
          assert.ok(threw)
          assert.match(threw.message, /original rename failure/, 'original error surfaces, not cleanup ENOENT')
        } finally {
          mock.restoreAll()
        }
      })
    }
  })
})

describe('PushManager prefs surface (#4541)', () => {
  it('exposes getPrefs / setPrefs / isCategoryEnabled / isInQuietHours wired to disk', async () => {
    const { PushManager } = await import('../src/push.js')
    const pm = new PushManager({ prefsPath })

    // Initial state: defaults, file doesn't exist yet
    const initial = pm.getPrefs()
    assert.deepEqual(initial.categories, CATEGORY_DEFAULTS)
    assert.equal(existsSync(prefsPath), false, 'no file written until setPrefs is called')

    // Patch global mute for `result` — persists and round-trips
    pm.setPrefs({ categories: { result: false } })
    assert.equal(existsSync(prefsPath), true, 'setPrefs must persist')
    const afterPatch = pm.getPrefs()
    assert.equal(afterPatch.categories.result, false)
    assert.equal(afterPatch.categories.permission, true, 'unmentioned categories retain defaults')

    // Per-device override
    pm.setPrefs({ devices: { 'tok-a': { categories: { result: true } } } })
    assert.equal(pm.isCategoryEnabled('result', 'tok-a'), true)
    assert.equal(pm.isCategoryEnabled('result', 'tok-b'), false)

    // Quiet hours stub
    assert.equal(pm.isInQuietHours(Date.now(), 'tok-a'), false)
  })

  it('setPrefs is shallow-merge at top level; replaces inner objects passed in patch', async () => {
    const { PushManager } = await import('../src/push.js')
    const pm = new PushManager({ prefsPath })
    pm.setPrefs({ categories: { result: false, permission: false } })
    // Subsequent patch only mentioning `result` should still merge — not wipe `permission`
    pm.setPrefs({ categories: { result: true } })
    const prefs = pm.getPrefs()
    assert.equal(prefs.categories.result, true)
    assert.equal(prefs.categories.permission, false, 'unmentioned category in patch must not be reset')
  })

  it('isCategoryEnabled tolerates missing pushToken (returns global decision)', async () => {
    const { PushManager } = await import('../src/push.js')
    const pm = new PushManager({ prefsPath })
    pm.setPrefs({ categories: { result: false } })
    assert.equal(pm.isCategoryEnabled('result'), false)
    assert.equal(pm.isCategoryEnabled('result', null), false)
  })

  it('PushManager without prefsPath still exposes the surface (in-memory)', async () => {
    const { PushManager } = await import('../src/push.js')
    const pm = new PushManager({}) // no prefsPath, no token storagePath
    assert.deepEqual(pm.getPrefs().categories, CATEGORY_DEFAULTS)
    pm.setPrefs({ categories: { result: false } })
    assert.equal(pm.isCategoryEnabled('result', 'tok'), false)
  })
})

/**
 * #4564: per-device delete semantics.
 *
 * The shallow-merge in setPrefs cannot REMOVE a device entry without an
 * explicit signal — adding/modifying a category under a token is the
 * common path. Convention introduced here: `devices: { [token]: null }`
 * in a patch deletes the entry entirely.
 *
 * Why: per-device entries are keyed by Expo push token (mobile) or
 * `chroxy_device_id` (browser). When Expo refreshes a token, an app is
 * reinstalled, or a browser tab loses its localStorage id, the OLD entry
 * lingers on disk forever with no UI affordance to clear it. The null
 * sentinel pairs with the new "Clear device" buttons in Settings to give
 * the operator a way to drain orphans without hand-editing the prefs file.
 */
describe('PushManager prefs surface — per-device delete (#4564)', () => {
  it('deletes a device entry when patch sets `devices[token] = null`', async () => {
    const { PushManager } = await import('../src/push.js')
    const pm = new PushManager({ prefsPath })
    // Seed two device entries so we can verify the delete is targeted.
    pm.setPrefs({ devices: { 'tok-a': { categories: { result: false } } } })
    pm.setPrefs({ devices: { 'tok-b': { categories: { result: true } } } })
    let snapshot = pm.getPrefs()
    assert.ok(snapshot.devices['tok-a'], 'tok-a seeded')
    assert.ok(snapshot.devices['tok-b'], 'tok-b seeded')

    // Null sentinel deletes only the named device.
    pm.setPrefs({ devices: { 'tok-a': null } })
    snapshot = pm.getPrefs()
    assert.equal(snapshot.devices['tok-a'], undefined, 'tok-a entry removed')
    assert.ok(snapshot.devices['tok-b'], 'tok-b entry untouched')
  })

  it('persists the deletion to disk so the orphan does not resurrect on reload', async () => {
    const { PushManager } = await import('../src/push.js')
    const pm = new PushManager({ prefsPath })
    pm.setPrefs({ devices: { 'orphan-tok': { categories: { result: false } } } })
    pm.setPrefs({ devices: { 'orphan-tok': null } })

    // Round-trip the on-disk file through a fresh loader — if the null
    // sentinel were misinterpreted as a literal value, the loader would
    // either crash or resurrect the entry with an empty body.
    const reloaded = loadPrefs(prefsPath)
    assert.equal(reloaded.devices['orphan-tok'], undefined, 'deletion survives reload')
  })

  it('tolerates deleting a token that was never registered (idempotent)', async () => {
    const { PushManager } = await import('../src/push.js')
    const pm = new PushManager({ prefsPath })
    // No-op delete on an empty map must not throw or write malformed state.
    pm.setPrefs({ devices: { 'never-seen': null } })
    const snapshot = pm.getPrefs()
    assert.deepEqual(snapshot.devices, {}, 'delete-of-nothing is a no-op')
  })

  it('falls back to global decision after a per-device entry is deleted', async () => {
    const { PushManager } = await import('../src/push.js')
    const pm = new PushManager({ prefsPath })
    // Global says muted; per-device override unmutes for `tok-a`.
    pm.setPrefs({ categories: { result: false } })
    pm.setPrefs({ devices: { 'tok-a': { categories: { result: true } } } })
    assert.equal(pm.isCategoryEnabled('result', 'tok-a'), true, 'override active')
    // Drop the override — `tok-a` now falls back to the global mute.
    pm.setPrefs({ devices: { 'tok-a': null } })
    assert.equal(
      pm.isCategoryEnabled('result', 'tok-a'),
      false,
      'after delete, the device follows the global default',
    )
  })

  it('allows mixed add + delete in a single devices patch', async () => {
    const { PushManager } = await import('../src/push.js')
    const pm = new PushManager({ prefsPath })
    pm.setPrefs({ devices: { 'old-tok': { categories: { result: false } } } })
    // One patch drops the orphan and registers the fresh token. This is
    // the shape a UI clicking "Clear old, register new" would emit if the
    // two actions ever batched.
    pm.setPrefs({
      devices: {
        'old-tok': null,
        'new-tok': { categories: { result: true } },
      },
    })
    const snapshot = pm.getPrefs()
    assert.equal(snapshot.devices['old-tok'], undefined)
    assert.deepEqual(snapshot.devices['new-tok'].categories, { result: true })
  })
})
