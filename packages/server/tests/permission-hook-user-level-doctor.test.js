import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { countUserLevelChroxyHooks } from '../src/permission-hook.js'
import { checkUserLevelChroxyHook, runDoctorChecks } from '../src/doctor.js'

/**
 * #8263 — the read-only `chroxy doctor` warning about a chroxy permission-hook
 * entry in the USER-LEVEL settings file. The daemon deliberately does NOT remove
 * such an entry (it may belong to a live claude-cli session of another daemon;
 * see #8350), so the operator is told to. Every test uses a temp settings path.
 */

const ORPHAN_CANONICAL = {
  _chroxy: true,
  matcher: '',
  hooks: [{ type: 'command', command: '/Users/x/Projects/chroxy/packages/server/hooks/permission-hook.sh', timeout: 300 }],
}
// An orphan whose `_chroxy` flag was lost (#3714): matched by path alone.
const ORPHAN_NO_FLAG = {
  matcher: '',
  hooks: [{ type: 'command', command: '/Applications/Chroxy.app/Contents/Resources/server/hooks/permission-hook.sh', timeout: 300 }],
}
const USER_HOOK = {
  matcher: 'Bash',
  hooks: [{ type: 'command', command: '/Users/x/bin/my-own-guard.sh', timeout: 5 }],
}

describe('countUserLevelChroxyHooks (#8263)', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chroxy-8263-count-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('counts chroxy entries, ignores the rest, and never writes', () => {
    const p = join(dir, 'settings.json')
    const raw = JSON.stringify({ hooks: { PreToolUse: [ORPHAN_CANONICAL, USER_HOOK, ORPHAN_NO_FLAG] } })
    writeFileSync(p, raw)
    assert.equal(countUserLevelChroxyHooks({ settingsPath: p }).found, 2)
    assert.equal(readFileSync(p, 'utf-8'), raw)
  })

  it('reports 0 for a missing file and carries the error for an invalid one', () => {
    assert.equal(countUserLevelChroxyHooks({ settingsPath: join(dir, 'none.json') }).found, 0)
    const p = join(dir, 'bad.json')
    writeFileSync(p, '{')
    const r = countUserLevelChroxyHooks({ settingsPath: p })
    assert.equal(r.found, 0)
    assert.ok(r.error)
  })
})

describe('countUserLevelChroxyHooks recognises a shell-quoted registration (#8263)', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chroxy-8263-quoted-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('finds an entry whose script path was quoted, without the _chroxy flag', () => {
    const p = join(dir, 'settings.json')
    const quoted = {
      matcher: '',
      hooks: [{ type: 'command', command: "'/Users/x y/Projects/chroxy/packages/server/hooks/permission-hook.sh'", timeout: 300 }],
    }
    writeFileSync(p, JSON.stringify({ hooks: { PreToolUse: [quoted, ORPHAN_NO_FLAG, USER_HOOK] } }))
    assert.equal(countUserLevelChroxyHooks({ settingsPath: p }).found, 2)
  })
})

describe('chroxy doctor: user-level hook warning (#8263)', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chroxy-8263-doctor-')) })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  it('warns with the one-line fix when an entry is present, and says nothing when not', () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({ hooks: { PreToolUse: [ORPHAN_CANONICAL] } }))
    const check = checkUserLevelChroxyHook({ settingsPath: p })
    assert.equal(check.status, 'warn')
    assert.ok(check.message.includes(p) && check.message.includes('fix:'), check.message)
    // Read-only: it tells the operator to remove the entry by hand, and never
    // claims the daemon will (it does not, #8350).
    assert.ok(/remove .*by hand/.test(check.message), check.message)
    assert.ok(!/restart|at startup/i.test(check.message), check.message)
    writeFileSync(p, JSON.stringify({ hooks: { PreToolUse: [USER_HOOK] } }))
    assert.equal(checkUserLevelChroxyHook({ settingsPath: p }), null)
  })

  it('missing file: no warning (nothing to check is not an error)', () => {
    assert.equal(checkUserLevelChroxyHook({ settingsPath: join(dir, 'none.json') }), null)
  })

  it('invalid JSON: warns that the file could not be read, naming the problem and the path', () => {
    const p = join(dir, 'bad.json')
    writeFileSync(p, '{ not json')
    const check = checkUserLevelChroxyHook({ settingsPath: p })
    assert.ok(check, 'must not read the same as "nothing there"')
    assert.equal(check.status, 'warn')
    assert.equal(check.name, 'User-level permission hook')
    assert.ok(check.message.startsWith('could not read user-level settings:'), check.message)
    assert.ok(check.message.includes(p), check.message)
    assert.ok(/JSON/i.test(check.message), check.message)
  })

  it('unreadable file: warns that the file could not be read', () => {
    // A directory at the settings path makes readFileSync fail with EISDIR on every
    // platform and for root too, unlike a chmod 000 file.
    const p = join(dir, 'settings.json')
    mkdirSync(p)
    const check = checkUserLevelChroxyHook({ settingsPath: p })
    assert.ok(check, 'must not read the same as "nothing there"')
    assert.equal(check.status, 'warn')
    assert.ok(check.message.startsWith('could not read user-level settings:'), check.message)
    assert.ok(/EISDIR/.test(check.message), check.message)
  })

  it('runDoctorChecks surfaces the read-error warning when opted in', async () => {
    const p = join(dir, 'bad.json')
    writeFileSync(p, '{')
    const on = await runDoctorChecks({ providers: [], userHookSettingsPath: p, checkUserLevelHook: true, tunnelProbe: async () => ({ ok: true }) })
    assert.ok(on.checks.some((c) => c.name === 'User-level permission hook' && c.status === 'warn' && c.message.startsWith('could not read')))
  })

  it('runDoctorChecks reads the user file only when opted in', async () => {
    const p = join(dir, 'settings.json')
    writeFileSync(p, JSON.stringify({ hooks: { PreToolUse: [ORPHAN_NO_FLAG] } }))
    const opts = { providers: [], userHookSettingsPath: p, tunnelProbe: async () => ({ ok: true }) }
    const off = await runDoctorChecks(opts)
    assert.ok(!off.checks.some((c) => c.name === 'User-level permission hook'), 'default: not read')
    const on = await runDoctorChecks({ ...opts, checkUserLevelHook: true })
    assert.ok(on.checks.some((c) => c.name === 'User-level permission hook' && c.status === 'warn'))
  })
})
