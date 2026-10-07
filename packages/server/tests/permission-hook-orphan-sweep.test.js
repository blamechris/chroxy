import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, chmodSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { sweepOrphanedUserHooks, countUserLevelChroxyHooks } from '../src/permission-hook.js'
import { checkUserLevelChroxyHook, runDoctorChecks } from '../src/doctor.js'

/**
 * #8263 — the daemon-start sweep of chroxy permission-hook entries orphaned in
 * the USER-LEVEL settings file. Every test uses a temp settings path; the test
 * sandbox guard (tests/_setup.mjs) would throw on a write to the real one.
 */

const __dirname = dirname(fileURLToPath(import.meta.url))

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
// Shares the BASENAME of ours but not a chroxy install path: must be kept.
const LOOKALIKE = {
  matcher: '',
  hooks: [{ type: 'command', command: '/Users/x/tools/permission-hook.sh' }],
}

function recordingLogger() {
  const lines = { info: [], warn: [] }
  return { lines, info: (m) => lines.info.push(m), warn: (m) => lines.warn.push(m) }
}

describe('sweepOrphanedUserHooks (#8263)', () => {
  let dir
  let settingsPath
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-8263-sweep-'))
    settingsPath = join(dir, 'settings.json')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  const writeSettings = (obj) => writeFileSync(settingsPath, JSON.stringify(obj, null, 2) + '\n')
  const readSettings = () => JSON.parse(readFileSync(settingsPath, 'utf-8'))

  it('removes every chroxy entry and logs the count, leaving all else untouched', async () => {
    const before = {
      model: 'opus',
      permissions: { allow: ['Bash(ls:*)'], deny: [] },
      hooks: {
        PreToolUse: [ORPHAN_CANONICAL, USER_HOOK, ORPHAN_NO_FLAG, LOOKALIKE],
        Stop: [{ hooks: [{ type: 'command', command: 'echo done' }] }],
      },
      statusLine: { type: 'command', command: 'x' },
    }
    writeSettings(before)
    const logger = recordingLogger()
    const result = await sweepOrphanedUserHooks({ settingsPath, logger })

    assert.equal(result.removed, 2)
    const after = readSettings()
    assert.deepEqual(after.hooks.PreToolUse, [USER_HOOK, LOOKALIKE], 'non-chroxy hooks kept, order preserved')
    assert.deepEqual(after.hooks.Stop, before.hooks.Stop)
    assert.equal(after.model, 'opus')
    assert.deepEqual(after.permissions, before.permissions)
    assert.deepEqual(after.statusLine, before.statusLine)
    assert.ok(logger.lines.info.some((m) => m.includes('Removed 2 orphaned') && m.includes(settingsPath)), `log: ${logger.lines.info}`)
  })

  it('tidies empty shells the way unregister does when only chroxy entries existed', async () => {
    writeSettings({ model: 'opus', hooks: { PreToolUse: [ORPHAN_CANONICAL] } })
    await sweepOrphanedUserHooks({ settingsPath, logger: recordingLogger() })
    assert.deepEqual(readSettings(), { model: 'opus' })
  })

  it('is a no-op that does not rewrite the file when there are none (byte-identical, even unformatted)', async () => {
    const raw = '{"hooks":{"PreToolUse":[{"matcher":"Bash","hooks":[{"type":"command","command":"/u/guard.sh"}]}]},   "model":"opus"}'
    writeFileSync(settingsPath, raw)
    const logger = recordingLogger()
    const result = await sweepOrphanedUserHooks({ settingsPath, logger })
    assert.equal(result.removed, 0)
    assert.equal(readFileSync(settingsPath, 'utf-8'), raw)
    assert.deepEqual(logger.lines.info, [])
  })

  it('does not throw and does not create the file when it is missing', async () => {
    const logger = recordingLogger()
    const result = await sweepOrphanedUserHooks({ settingsPath: join(dir, 'nope', 'settings.json'), logger })
    assert.equal(result.removed, 0)
    assert.throws(() => readFileSync(join(dir, 'nope', 'settings.json')), /ENOENT/)
  })

  it('logs and continues on invalid JSON, leaving the file untouched', async () => {
    writeFileSync(settingsPath, '{ not json')
    const logger = recordingLogger()
    const result = await sweepOrphanedUserHooks({ settingsPath, logger })
    assert.equal(result.removed, 0)
    assert.equal(readFileSync(settingsPath, 'utf-8'), '{ not json')
    assert.ok(logger.lines.warn.some((m) => m.includes('invalid JSON')))
  })

  it('tolerates a settings file whose hooks shape is not what we expect', async () => {
    for (const shape of [{ hooks: null }, { hooks: [] }, { hooks: { PreToolUse: 'x' } }, { hooks: { PreToolUse: [null, 3] } }, []]) {
      writeSettings(shape)
      const result = await sweepOrphanedUserHooks({ settingsPath, logger: recordingLogger() })
      assert.equal(result.removed, 0, JSON.stringify(shape))
    }
  })

  it('logs and continues when the write fails (read-only file)', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    writeSettings({ hooks: { PreToolUse: [ORPHAN_CANONICAL] } })
    chmodSync(settingsPath, 0o444)
    chmodSync(dir, 0o555)
    try {
      const logger = recordingLogger()
      const result = await sweepOrphanedUserHooks({ settingsPath, logger })
      assert.equal(result.removed, 0)
      assert.ok(logger.lines.warn.some((m) => m.includes('sweep failed')), `warn: ${logger.lines.warn}`)
    } finally {
      chmodSync(dir, 0o755)
    }
  })
})

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

describe('server-cli.js boot wiring of the sweep (#8263)', () => {
  // Source-level, and said so: short of booting the daemon nothing separates the
  // call from the same characters behind a false condition (see
  // docs/false-safety-guards.md entry 20). Block comments are stripped and the
  // match uses [ \t], never \s, so a commented-out call does not satisfy it.
  const src = readFileSync(join(__dirname, '../src/server-cli.js'), 'utf-8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
  const lineOf = (re) => {
    const m = re.exec(src)
    return m ? src.slice(0, m.index).split('\n').length : -1
  }

  it('calls the sweep unconditionally (awaited, at statement start) BEFORE the session manager exists or restores', () => {
    const sweep = lineOf(/^[ \t]*await sweepOrphanedUserHooks\(/m)
    const create = lineOf(/^[ \t]*const \{ sessionManager, startupSkillPolicy \} = createDaemonSessionManager\(/m)
    const restore = lineOf(/^[ \t]*defaultSessionId = sessionManager\.restoreState\(\)/m)
    assert.ok(sweep > 0, 'sweep call present')
    assert.ok(create > 0 && restore > 0, 'anchors present')
    assert.ok(sweep < create && sweep < restore, `sweep (${sweep}) must precede create (${create}) and restore (${restore})`)
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
    writeFileSync(p, JSON.stringify({ hooks: { PreToolUse: [USER_HOOK] } }))
    assert.equal(checkUserLevelChroxyHook({ settingsPath: p }), null)
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
