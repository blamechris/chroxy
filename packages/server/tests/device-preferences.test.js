import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, statSync, readFileSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, sep } from 'path'
import { createDevicePreferences } from '../src/device-preferences.js'

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
})
