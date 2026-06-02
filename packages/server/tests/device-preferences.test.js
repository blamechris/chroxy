import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { createDevicePreferences } from '../src/device-preferences.js'
import { WsServer, parseDevicePrefsDuration } from '../src/ws-server.js'

// #4835: device-preferences is a tiny persistence shim used by ws-history.js to
// remember which session a deviceId was viewing across reconnects. Tests
// pin (a) the read/write contract, (b) the on-disk format, and (c) the
// 0600 file mode so other local users can't read which projects a
// developer has open.

describe('device-preferences (#4835)', () => {
  let dir
  let filePath

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-devprefs-'))
    filePath = join(dir, 'device-preferences.json')
  })

  afterEach(() => {
    try { rmSync(dir, { recursive: true, force: true }) } catch {}
  })

  it('returns null when no preference is set for a deviceId', () => {
    const prefs = createDevicePreferences({ filePath })
    assert.equal(prefs.getActiveSessionId('device-A'), null)
  })

  it('returns null for falsy or non-string deviceIds', () => {
    const prefs = createDevicePreferences({ filePath })
    assert.equal(prefs.getActiveSessionId(null), null)
    assert.equal(prefs.getActiveSessionId(undefined), null)
    assert.equal(prefs.getActiveSessionId(''), null)
    assert.equal(prefs.getActiveSessionId(42), null)
  })

  it('round-trips a set/get within the same process', () => {
    const prefs = createDevicePreferences({ filePath })
    prefs.setActiveSessionId('device-A', 'sess-1')
    assert.equal(prefs.getActiveSessionId('device-A'), 'sess-1')
  })

  it('persists across new instances pointed at the same file', () => {
    const a = createDevicePreferences({ filePath })
    a.setActiveSessionId('device-A', 'sess-77')

    const b = createDevicePreferences({ filePath })
    assert.equal(b.getActiveSessionId('device-A'), 'sess-77')
  })

  it('tracks deviceIds independently (laptop A and laptop B do not share)', () => {
    const prefs = createDevicePreferences({ filePath })
    prefs.setActiveSessionId('laptop-A', 'sess-alpha')
    prefs.setActiveSessionId('laptop-B', 'sess-beta')
    assert.equal(prefs.getActiveSessionId('laptop-A'), 'sess-alpha')
    assert.equal(prefs.getActiveSessionId('laptop-B'), 'sess-beta')
  })

  it('overwrites a prior preference for the same deviceId', () => {
    const prefs = createDevicePreferences({ filePath })
    prefs.setActiveSessionId('device-A', 'sess-1')
    prefs.setActiveSessionId('device-A', 'sess-2')
    assert.equal(prefs.getActiveSessionId('device-A'), 'sess-2')
  })

  it('silently ignores set() with missing arguments', () => {
    const prefs = createDevicePreferences({ filePath })
    prefs.setActiveSessionId(null, 'sess-1')
    prefs.setActiveSessionId('device-A', null)
    prefs.setActiveSessionId('', '')
    assert.equal(prefs.getActiveSessionId('device-A'), null)
    // File should not have been created — nothing to persist
    assert.equal(existsSync(filePath), false)
  })

  it('writes the preferences file with 0600 perms (sensitive — local privacy)', () => {
    if (process.platform === 'win32') return // Windows has no 0600 equivalent
    const prefs = createDevicePreferences({ filePath })
    prefs.setActiveSessionId('device-A', 'sess-1')
    assert.equal(existsSync(filePath), true)
    const mode = statSync(filePath).mode & 0o777
    assert.equal(mode, 0o600, `expected 0600, got ${mode.toString(8)}`)
  })

  it('stores the expected on-disk shape', () => {
    const prefs = createDevicePreferences({ filePath })
    prefs.setActiveSessionId('device-A', 'sess-1')
    const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
    assert.equal(raw.version, 1)
    assert.equal(typeof raw.devices, 'object')
    assert.equal(raw.devices['device-A'].activeSessionId, 'sess-1')
    assert.equal(typeof raw.devices['device-A'].updatedAt, 'number')
  })

  it('handles a malformed file by starting fresh', () => {
    writeFileSync(filePath, '{not json')
    const prefs = createDevicePreferences({ filePath })
    assert.equal(prefs.getActiveSessionId('device-A'), null)
    // Writing a new pref should not throw
    prefs.setActiveSessionId('device-A', 'sess-1')
    assert.equal(prefs.getActiveSessionId('device-A'), 'sess-1')
  })

  it('handles a JSON file with no `devices` key by starting fresh', () => {
    writeFileSync(filePath, JSON.stringify({ version: 1 }))
    const prefs = createDevicePreferences({ filePath })
    assert.equal(prefs.getActiveSessionId('device-A'), null)
  })

  it('clear() removes the preference for a deviceId', () => {
    const prefs = createDevicePreferences({ filePath })
    prefs.setActiveSessionId('device-A', 'sess-1')
    prefs.setActiveSessionId('device-B', 'sess-2')
    prefs.clear('device-A')
    assert.equal(prefs.getActiveSessionId('device-A'), null)
    // Other deviceIds untouched
    assert.equal(prefs.getActiveSessionId('device-B'), 'sess-2')
  })

  // Defensive — the file path comes from CHROXY_CONFIG_DIR (handled by the
  // shared test sandbox in tests/_setup.mjs) so a production code path that
  // forgets to thread `filePath` would still land in a tmp dir during tests.
  // This test just pins that constructing without an override doesn't blow
  // up at module-import time.
  it('constructs with the default path (no override) without throwing', () => {
    assert.doesNotThrow(() => createDevicePreferences())
  })

  it('does not rewrite the file when set() is a no-op (same sessionId)', () => {
    const prefs = createDevicePreferences({ filePath })
    prefs.setActiveSessionId('device-A', 'sess-1')
    const firstMtime = statSync(filePath).mtimeMs
    // Sleep briefly so a re-write would produce a measurably different mtime
    const start = Date.now()
    while (Date.now() - start < 20) { /* spin */ }
    prefs.setActiveSessionId('device-A', 'sess-1')
    const secondMtime = statSync(filePath).mtimeMs
    assert.equal(firstMtime, secondMtime, 'no-op set should not touch the file')
  })

  it('uses CHROXY_CONFIG_DIR for the default path', () => {
    // The shared test sandbox in tests/_setup.mjs already pins
    // CHROXY_CONFIG_DIR to a tmp dir, so a default-path construction must
    // resolve under that dir (not the real ~/.chroxy).
    const prefs = createDevicePreferences()
    // Indirect check via the public surface: setting a pref must succeed
    // (real home is sandbox-blocked, so success implies tmp-dir usage).
    assert.doesNotThrow(() => prefs.setActiveSessionId('device-sandbox', 'sess-1'))
    // And it must NOT touch our local `filePath` (different override)
    assert.equal(existsSync(filePath), false)
    // Clean up so we don't pollute other tests sharing the tmp config dir
    prefs.clear('device-sandbox')
  })

  // Sanity check that our test paths sit under a temp dir, not the real
  // user's ~/.chroxy. If this fails the sandbox guard in _setup.mjs has
  // regressed and the test would silently clobber real state.
  it('test fixture path is under the OS tmp dir', () => {
    assert.ok(filePath.includes(sep + 'chroxy-devprefs-'),
      `expected temp path, got ${filePath}`)
  })

  // #4849: stale-entry pruning. Devices that ever connected get an entry
  // that lived forever (no eviction). prune() drops entries whose
  // activeSessionId points at a session that no longer exists, and
  // optionally also drops entries older than a configurable max age.
  describe('prune (#4849)', () => {
    it('removes entries whose activeSessionId no longer exists in SessionManager', () => {
      const prefs = createDevicePreferences({ filePath })
      prefs.setActiveSessionId('device-live', 'sess-live')
      prefs.setActiveSessionId('device-dead', 'sess-destroyed')

      // SessionManager only knows about sess-live
      const liveSessionIds = new Set(['sess-live'])
      const removed = prefs.prune({ sessionExists: (id) => liveSessionIds.has(id) })

      assert.equal(removed, 1, 'one stale entry should be removed')
      assert.equal(prefs.getActiveSessionId('device-live'), 'sess-live')
      assert.equal(prefs.getActiveSessionId('device-dead'), null)
    })

    it('persists the pruned state to disk', () => {
      const prefs = createDevicePreferences({ filePath })
      prefs.setActiveSessionId('device-live', 'sess-live')
      prefs.setActiveSessionId('device-dead', 'sess-destroyed')

      prefs.prune({ sessionExists: (id) => id === 'sess-live' })

      // Reload from disk in a fresh instance — pruned entry must be gone
      const reloaded = createDevicePreferences({ filePath })
      assert.equal(reloaded.getActiveSessionId('device-live'), 'sess-live')
      assert.equal(reloaded.getActiveSessionId('device-dead'), null)
    })

    it('does not write the file when there is nothing to prune (no-op)', () => {
      const prefs = createDevicePreferences({ filePath })
      prefs.setActiveSessionId('device-live', 'sess-live')
      const beforeMtime = statSync(filePath).mtimeMs

      // Spin briefly so a rewrite would produce a different mtime
      const start = Date.now()
      while (Date.now() - start < 20) { /* spin */ }

      const removed = prefs.prune({ sessionExists: () => true })
      assert.equal(removed, 0)
      const afterMtime = statSync(filePath).mtimeMs
      assert.equal(beforeMtime, afterMtime, 'no-op prune should not touch the file')
    })

    it('is a no-op when devices is empty (no file, no write)', () => {
      const prefs = createDevicePreferences({ filePath })
      const removed = prefs.prune({ sessionExists: () => true })
      assert.equal(removed, 0)
      assert.equal(existsSync(filePath), false, 'should not create a file with empty devices')
    })

    it('removes entries older than maxAgeMs regardless of session existence', () => {
      const prefs = createDevicePreferences({ filePath })
      prefs.setActiveSessionId('device-old', 'sess-live')
      prefs.setActiveSessionId('device-new', 'sess-live')

      // Reach into the file to age one entry past the cutoff
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
      raw.devices['device-old'].updatedAt = Date.now() - (100 * 24 * 60 * 60 * 1000)
      writeFileSync(filePath, JSON.stringify(raw, null, 2))

      // Fresh instance so the aged file is reloaded
      const reloaded = createDevicePreferences({ filePath })
      const ninetyDaysMs = 90 * 24 * 60 * 60 * 1000
      const removed = reloaded.prune({
        sessionExists: () => true,
        maxAgeMs: ninetyDaysMs,
      })

      assert.equal(removed, 1)
      assert.equal(reloaded.getActiveSessionId('device-old'), null)
      assert.equal(reloaded.getActiveSessionId('device-new'), 'sess-live')
    })

    it('keeps a recent entry even when its session no longer exists (grace window)', () => {
      const prefs = createDevicePreferences({ filePath })
      prefs.setActiveSessionId('device-A', 'sess-destroyed')

      // Recent updatedAt, stale session — within staleSessionGraceMs
      const removed = prefs.prune({
        sessionExists: () => false,
        staleSessionGraceMs: 30 * 24 * 60 * 60 * 1000, // 30d grace
      })
      assert.equal(removed, 0)
      assert.equal(prefs.getActiveSessionId('device-A'), 'sess-destroyed')
    })

    it('removes stale-session entries past the grace window', () => {
      const prefs = createDevicePreferences({ filePath })
      prefs.setActiveSessionId('device-A', 'sess-destroyed')

      // Age the entry past the 30-day stale grace
      const raw = JSON.parse(readFileSync(filePath, 'utf-8'))
      raw.devices['device-A'].updatedAt = Date.now() - (31 * 24 * 60 * 60 * 1000)
      writeFileSync(filePath, JSON.stringify(raw, null, 2))

      const reloaded = createDevicePreferences({ filePath })
      const removed = reloaded.prune({
        sessionExists: () => false,
        staleSessionGraceMs: 30 * 24 * 60 * 60 * 1000,
      })
      assert.equal(removed, 1)
      assert.equal(reloaded.getActiveSessionId('device-A'), null)
    })

    it('defaults: with no opts, removes only entries whose session is missing AND no grace', () => {
      const prefs = createDevicePreferences({ filePath })
      prefs.setActiveSessionId('device-live', 'sess-live')
      prefs.setActiveSessionId('device-dead', 'sess-gone')

      const removed = prefs.prune({ sessionExists: (id) => id === 'sess-live' })
      assert.equal(removed, 1)
      assert.equal(prefs.getActiveSessionId('device-dead'), null)
    })

    it('treats malformed entries (missing activeSessionId / updatedAt) as prunable', () => {
      writeFileSync(filePath, JSON.stringify({
        version: 1,
        devices: {
          'device-bad-1': {},
          'device-bad-2': { activeSessionId: 'sess-1' /* no updatedAt */ },
          'device-good': { activeSessionId: 'sess-1', updatedAt: Date.now() },
        },
      }))

      const prefs = createDevicePreferences({ filePath })
      const removed = prefs.prune({ sessionExists: (id) => id === 'sess-1' })
      assert.equal(removed, 2, 'two malformed entries should be removed')
      assert.equal(prefs.getActiveSessionId('device-good'), 'sess-1')
    })

    it('tolerates a missing sessionExists callback (treats everything as live)', () => {
      const prefs = createDevicePreferences({ filePath })
      prefs.setActiveSessionId('device-A', 'sess-1')
      // Without sessionExists, the stale-session check is skipped — only the
      // age-based check applies. With no maxAgeMs, this should be a no-op.
      const removed = prefs.prune({})
      assert.equal(removed, 0)
      assert.equal(prefs.getActiveSessionId('device-A'), 'sess-1')
    })
  })

  // #4849: WsServer must invoke prune at construction time so that the
  // server starts clean rather than waiting for the next write to evict
  // stale entries. Validates the full wiring (env-var → constructor →
  // prune call → file rewrite), not just the helper in isolation.
  describe('WsServer startup prune (#4849)', () => {
    let server
    let savedEnvMaxAge
    let savedEnvGrace

    beforeEach(() => {
      savedEnvMaxAge = process.env.CHROXY_DEVICE_PREFS_MAX_AGE_MS
      savedEnvGrace = process.env.CHROXY_DEVICE_PREFS_STALE_GRACE_MS
      delete process.env.CHROXY_DEVICE_PREFS_MAX_AGE_MS
      // Disable the default 30-day stale grace so the test can immediately
      // observe stale-session eviction. We exercise the grace separately
      // via parseDevicePrefsDuration unit tests below.
      process.env.CHROXY_DEVICE_PREFS_STALE_GRACE_MS = '0'
    })

    afterEach(async () => {
      if (server) {
        try { await server.close() } catch {}
        server = null
      }
      if (savedEnvMaxAge === undefined) {
        delete process.env.CHROXY_DEVICE_PREFS_MAX_AGE_MS
      } else {
        process.env.CHROXY_DEVICE_PREFS_MAX_AGE_MS = savedEnvMaxAge
      }
      if (savedEnvGrace === undefined) {
        delete process.env.CHROXY_DEVICE_PREFS_STALE_GRACE_MS
      } else {
        process.env.CHROXY_DEVICE_PREFS_STALE_GRACE_MS = savedEnvGrace
      }
    })

    it('drops device-prefs entries whose session is gone from SessionManager', () => {
      // Pre-populate the on-disk store with a live + a destroyed entry.
      const seed = createDevicePreferences({ filePath })
      seed.setActiveSessionId('device-live', 'sess-live')
      seed.setActiveSessionId('device-dead', 'sess-destroyed')

      // Stub SessionManager: only sess-live exists.
      const sessionManagerStub = {
        getSession: (id) => (id === 'sess-live' ? { id, name: 'live' } : null),
      }
      // Fresh disk-backed store handed to WsServer (cache not warmed).
      const devicePreferences = createDevicePreferences({ filePath })

      server = new WsServer({
        port: 0,
        apiToken: 'test',
        sessionManager: sessionManagerStub,
        authRequired: false,
        devicePreferences,
      })

      // Verify in-memory state after prune
      assert.equal(devicePreferences.getActiveSessionId('device-live'), 'sess-live')
      assert.equal(devicePreferences.getActiveSessionId('device-dead'), null)

      // Verify the prune was persisted to disk (next process boot sees it)
      const reloaded = createDevicePreferences({ filePath })
      assert.equal(reloaded.getActiveSessionId('device-dead'), null,
        'destroyed-session entry must be persisted as removed')
    })

    it('does not touch the disk when there is nothing to prune', () => {
      // Pre-populate with a single live entry
      const seed = createDevicePreferences({ filePath })
      seed.setActiveSessionId('device-live', 'sess-live')
      const beforeMtime = statSync(filePath).mtimeMs

      const sessionManagerStub = {
        getSession: (id) => (id === 'sess-live' ? { id, name: 'live' } : null),
      }
      const devicePreferences = createDevicePreferences({ filePath })

      // Spin so a rewrite would produce a measurable mtime delta
      const start = Date.now()
      while (Date.now() - start < 20) { /* spin */ }

      server = new WsServer({
        port: 0,
        apiToken: 'test',
        sessionManager: sessionManagerStub,
        authRequired: false,
        devicePreferences,
      })

      const afterMtime = statSync(filePath).mtimeMs
      assert.equal(beforeMtime, afterMtime,
        'no stale entries → prune must not rewrite the file')
    })

    it('is a no-op when devicePreferences has no entries', () => {
      const sessionManagerStub = { getSession: () => null }
      const devicePreferences = createDevicePreferences({ filePath })

      assert.doesNotThrow(() => {
        server = new WsServer({
          port: 0,
          apiToken: 'test',
          sessionManager: sessionManagerStub,
          authRequired: false,
          devicePreferences,
        })
      })

      // No file should have been created
      assert.equal(existsSync(filePath), false)
    })

    it('does not crash when sessionManager is omitted (back-compat)', () => {
      const devicePreferences = createDevicePreferences({ filePath })
      assert.doesNotThrow(() => {
        server = new WsServer({
          port: 0,
          apiToken: 'test',
          authRequired: false,
          devicePreferences,
        })
      })
    })
  })

  describe('parseDevicePrefsDuration (#4849)', () => {
    it('returns the default when raw is null / undefined / empty', () => {
      assert.equal(parseDevicePrefsDuration(null, 42), 42)
      assert.equal(parseDevicePrefsDuration(undefined, 42), 42)
      assert.equal(parseDevicePrefsDuration('', 42), 42)
    })

    it('parses a positive integer string', () => {
      assert.equal(parseDevicePrefsDuration('60000', 42), 60000)
    })

    it('accepts 0 as a valid value (callers can disable a cap)', () => {
      assert.equal(parseDevicePrefsDuration('0', 42), 0)
    })

    it('falls back to default on a negative or non-numeric value', () => {
      assert.equal(parseDevicePrefsDuration('-1', 42), 42)
      assert.equal(parseDevicePrefsDuration('not-a-number', 42), 42)
    })

    it('floors fractional values', () => {
      assert.equal(parseDevicePrefsDuration('1.9', 42), 1)
    })
  })
})
