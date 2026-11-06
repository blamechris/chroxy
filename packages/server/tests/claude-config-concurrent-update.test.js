/**
 * #8983 — a concurrent writer's update to claude's config files must survive
 * chroxy's read-merge-write.
 *
 * Chroxy used to read `settings.json` / `.claude.json`, merge its change into
 * that snapshot and atomically replace the whole file. The replace was atomic but
 * the MERGE was not: anything claude (or a second daemon) wrote between the read
 * and the rename was silently overwritten. `claude` takes no lock of ours, so the
 * fix is detection — re-read the destination just before the rename and re-merge
 * if it changed — in ONE choke point (`updateClaudeConfig`).
 *
 * The race is made deterministic with `claudeConfigTestHooks.beforeVerify`, which
 * fires after the temp file is written and before the compare-and-swap: exactly
 * where the lost update used to happen. The per-caller tests drive the REAL
 * callers (hook register/unregister, trust pre-write, MCP add/remove) through
 * that seam, so a caller that bypassed the choke point would lose the injected
 * write and go red. All paths are temp dirs (the sandbox guard protects the real
 * ~/.claude and ~/.chroxy).
 */
import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  ClaudeConfigConflictError,
  CLAUDE_CONFIG_MAX_ATTEMPTS,
  addMcpServerToConfig,
  claudeConfigTestHooks,
  removeMcpServerFromConfig,
  updateClaudeConfig,
} from '../src/byok-mcp-config.js'
import { createPermissionHookManager, describeSettingsModeWarning } from '../src/permission-hook.js'
import { stampWindowsAclStrict } from '../src/platform.js'
// Import order matters (see claude-tui-ensure-cwd-trusted-write.test.js): the
// session module first, then the driver.
import '../src/claude-tui-session.js'
import { ensureCwdTrusted } from '../src/claude-tui/pty-driver.js'

let dir

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'chroxy-cfg-race-'))
})

afterEach(() => {
  claudeConfigTestHooks.beforeVerify = null
  rmSync(dir, { recursive: true, force: true })
})

const readJson = (p) => JSON.parse(readFileSync(p, 'utf8'))
const leftovers = (d) => readdirSync(d).filter((n) => n.includes('.chroxy.') && n.endsWith('.tmp'))

/** Make `path` gain `{ [key]: value }` exactly once, at the next CAS point (a concurrent claude write). */
function injectOnce(path, key, value) {
  let fired = false
  claudeConfigTestHooks.beforeVerify = () => {
    if (fired) return
    fired = true
    const current = JSON.parse(readFileSync(path, 'utf8'))
    current[key] = value
    writeFileSync(path, JSON.stringify(current, null, 2))
  }
}

describe('#8983 updateClaudeConfig — lost-update protection', () => {
  it('preserves a write that lands between the read and the replace, and merges on top of it', () => {
    const file = join(dir, 'c.json')
    writeFileSync(file, JSON.stringify({ base: 1 }))
    injectOnce(file, 'claudeWrote', 'x')
    const calls = []
    const out = updateClaudeConfig(file, (raw, info) => {
      calls.push(info.attempt)
      raw.chroxyWrote = 'y'
    })
    assert.equal(out.ok, true)
    assert.equal(out.attempts, 2)
    assert.deepEqual(calls, [1, 2], 'the merge re-ran against the new content')
    assert.deepEqual(readJson(file), { base: 1, claudeWrote: 'x', chroxyWrote: 'y' })
    assert.deepEqual(leftovers(dir), [])
  })

  it('treats a file created by another writer (first-write case) as a conflict', () => {
    const file = join(dir, 'new.json')
    claudeConfigTestHooks.beforeVerify = () => {
      claudeConfigTestHooks.beforeVerify = null
      writeFileSync(file, JSON.stringify({ theirs: true }))
    }
    const out = updateClaudeConfig(file, (raw) => { raw.mine = true })
    assert.equal(out.attempts, 2)
    assert.deepEqual(readJson(file), { theirs: true, mine: true })
  })

  it('treats a file deleted by another writer as a conflict, not a silent resurrection of the old snapshot', () => {
    const file = join(dir, 'gone.json')
    writeFileSync(file, JSON.stringify({ old: 1 }))
    claudeConfigTestHooks.beforeVerify = () => {
      claudeConfigTestHooks.beforeVerify = null
      rmSync(file)
    }
    const out = updateClaudeConfig(file, (raw) => { raw.mine = true })
    assert.equal(out.attempts, 2)
    assert.deepEqual(readJson(file), { mine: true })
  })

  it('does not rewrite when nothing changed (no-op mutate), and never invokes the CAS', () => {
    const file = join(dir, 'noop.json')
    writeFileSync(file, '{"a":1}')
    let hookCalls = 0
    claudeConfigTestHooks.beforeVerify = () => { hookCalls++ }
    const before = statSync(file).mtimeMs
    const out = updateClaudeConfig(file, () => ({ write: false, result: 'skip' }))
    assert.equal(out.wrote, false)
    assert.equal(out.result, 'skip')
    assert.equal(hookCalls, 0)
    assert.equal(statSync(file).mtimeMs, before)
  })

  it('FAILS LOUD when the file keeps changing: bounded retries, then throws, and never overwrites', () => {
    const file = join(dir, 'churn.json')
    writeFileSync(file, JSON.stringify({ n: 0 }))
    let n = 0
    claudeConfigTestHooks.beforeVerify = () => {
      n++
      writeFileSync(file, JSON.stringify({ n }))
    }
    let mutateCalls = 0
    assert.throws(
      () => updateClaudeConfig(file, (raw) => { mutateCalls++; raw.mine = true }),
      (err) => err instanceof ClaudeConfigConflictError && err.exhausted === true && err.code === 'CLAUDE_CONFIG_CONFLICT',
    )
    assert.equal(mutateCalls, CLAUDE_CONFIG_MAX_ATTEMPTS)
    assert.equal(readJson(file).mine, undefined, 'the stale merge was never published')
    assert.deepEqual(readJson(file), { n }, 'the other writer\'s last write is intact')
    assert.deepEqual(leftovers(dir), [])
  })

  it('honours a smaller maxAttempts', () => {
    const file = join(dir, 'churn2.json')
    writeFileSync(file, '{}')
    let n = 0
    claudeConfigTestHooks.beforeVerify = () => { n++; writeFileSync(file, JSON.stringify({ n })) }
    let mutateCalls = 0
    assert.throws(() => updateClaudeConfig(file, () => { mutateCalls++ }, { maxAttempts: 2 }), ClaudeConfigConflictError)
    assert.equal(mutateCalls, 2)
  })

  it('a thrown error mid-write (fsync of the temp throws) leaves the original byte-for-byte and cleans the sidecar (a process kill can still orphan a sidecar, never truncate the file)', () => {
    const file = join(dir, 'atomic.json')
    const original = '{\n  "keep": "me"\n}\n'
    writeFileSync(file, original)
    assert.throws(
      () => updateClaudeConfig(file, (raw) => { raw.x = 1 }, { _fsync: () => { throw new Error('simulated crash') } }),
      /simulated crash/,
    )
    assert.equal(readFileSync(file, 'utf8'), original)
    assert.deepEqual(leftovers(dir), [])
  })

  it('a rename failure leaves the original intact and removes the sidecar', () => {
    const file = join(dir, 'atomic2.json')
    const original = '{"keep":"me"}'
    writeFileSync(file, original)
    assert.throws(
      () => updateClaudeConfig(file, (raw) => { raw.x = 1 }, { _rename: () => { throw Object.assign(new Error('boom'), { code: 'EXDEV' }) } }),
      /boom/,
    )
    assert.equal(readFileSync(file, 'utf8'), original)
    assert.deepEqual(leftovers(dir), [])
  })

  it('refuses (does not overwrite) a malformed file — fail-closed read', () => {
    const file = join(dir, 'bad.json')
    writeFileSync(file, '{ not json')
    const out = updateClaudeConfig(file, (raw) => { raw.x = 1 })
    assert.equal(out.ok, false)
    assert.equal(readFileSync(file, 'utf8'), '{ not json')
  })

  it('preserves the destination file mode across a retried write', { skip: process.platform === 'win32' }, () => {
    const file = join(dir, 'mode.json')
    writeFileSync(file, '{}')
    chmodSync(file, 0o640)
    injectOnce(file, 'other', 1)
    updateClaudeConfig(file, (raw) => { raw.mine = 1 })
    assert.equal(statSync(file).mode & 0o777, 0o640)
  })

  it('writes THROUGH a symlink (link survives) and still merges a concurrent write to the target', { skip: process.platform === 'win32' }, () => {
    const real = join(dir, 'real.json')
    const link = join(dir, 'link.json')
    writeFileSync(real, JSON.stringify({ base: 1 }))
    symlinkSync(real, link)
    injectOnce(real, 'claudeWrote', 'x')
    updateClaudeConfig(link, (raw) => { raw.mine = 'y' })
    assert.equal(lstatSync(link).isSymbolicLink(), true)
    assert.equal(readlinkSync(link), real)
    assert.deepEqual(readJson(real), { base: 1, claudeWrote: 'x', mine: 'y' })
  })

  it('refuses a dangling symlink instead of materializing its target', { skip: process.platform === 'win32' }, () => {
    const link = join(dir, 'dangling.json')
    symlinkSync(join(dir, 'nowhere.json'), link)
    assert.throws(() => updateClaudeConfig(link, (raw) => { raw.x = 1 }), /cannot be resolved/)
    assert.equal(lstatSync(link).isSymbolicLink(), true)
  })

  it('Windows: a transient EBUSY on rename is retried (and the CAS re-runs); a persistent one throws and cleans up', () => {
    const file = join(dir, 'win.json')
    writeFileSync(file, '{"a":1}')
    let failures = 2
    let verifies = 0
    claudeConfigTestHooks.beforeVerify = () => { verifies++ }
    const slept = []
    updateClaudeConfig(file, (raw) => { raw.b = 2 }, {
      _isWindowsOverride: true,
      _sleep: (ms) => slept.push(ms),
      _rename: (from, to) => {
        if (failures-- > 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        renameSync(from, to)
      },
    })
    assert.deepEqual(readJson(file), { a: 1, b: 2 })
    assert.equal(verifies, 3, 'CAS ran before every rename attempt')
    assert.equal(slept.length, 2)

    const file2 = join(dir, 'win2.json')
    writeFileSync(file2, '{"a":1}')
    assert.throws(
      () => updateClaudeConfig(file2, (raw) => { raw.b = 2 }, {
        _isWindowsOverride: true,
        _sleep: () => {},
        _rename: () => { throw Object.assign(new Error('still busy'), { code: 'EBUSY' }) },
      }),
      /still busy/,
    )
    assert.equal(readFileSync(file2, 'utf8'), '{"a":1}')
    assert.deepEqual(leftovers(dir), [])
  })

  it('a link retargeted after the read is a conflict: the merge lands on the NEW target and the old one is untouched', { skip: process.platform === 'win32' }, () => {
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    const link = join(dir, 'link.json')
    writeFileSync(a, JSON.stringify({ from: 'A' }))
    writeFileSync(b, JSON.stringify({ from: 'B' }))
    symlinkSync(a, link)
    claudeConfigTestHooks.beforeVerify = () => {
      claudeConfigTestHooks.beforeVerify = null
      rmSync(link)
      symlinkSync(b, link)
    }
    const out = updateClaudeConfig(link, (raw) => { raw.mine = 1 })
    assert.equal(out.attempts, 2)
    assert.deepEqual(readJson(a), { from: 'A' }, 'the stale target was not modified')
    assert.deepEqual(readJson(b), { from: 'B', mine: 1 })
    assert.equal(readlinkSync(link), b)
  })

  it('a regular file swapped for a symlink with IDENTICAL bytes is a conflict: the link is not destroyed', { skip: process.platform === 'win32' }, () => {
    const real = join(dir, 'real.json')
    const link = join(dir, 'cfg.json')
    const bytes = JSON.stringify({ same: 1 })
    writeFileSync(link, bytes)
    writeFileSync(real, bytes)
    claudeConfigTestHooks.beforeVerify = () => {
      claudeConfigTestHooks.beforeVerify = null
      rmSync(link)
      symlinkSync(real, link)
    }
    const out = updateClaudeConfig(link, (raw) => { raw.mine = 1 })
    assert.equal(out.attempts, 2)
    assert.equal(lstatSync(link).isSymbolicLink(), true, 'the symlink survived')
    assert.deepEqual(readJson(real), { same: 1, mine: 1 })
  })

  it('a concurrent chmod with no content change is a conflict; the tightened mode is kept', { skip: process.platform === 'win32' }, () => {
    const file = join(dir, 'perm.json')
    writeFileSync(file, '{"a":1}')
    chmodSync(file, 0o644)
    claudeConfigTestHooks.beforeVerify = () => {
      claudeConfigTestHooks.beforeVerify = null
      chmodSync(file, 0o600)
    }
    const out = updateClaudeConfig(file, (raw) => { raw.b = 2 })
    assert.equal(out.attempts, 2)
    assert.equal(statSync(file).mode & 0o777, 0o600)
    assert.deepEqual(readJson(file), { a: 1, b: 2 })
  })

  for (const name of ['settings.json', '.claude.json']) {
    it(`Windows: the owner-only ACL is stamped on the EMPTY temp before any content is written (${name})`, () => {
      const file = join(dir, name)
      writeFileSync(file, '{"env":{"ANTHROPIC_API_KEY":"x"}}')
      const events = []
      updateClaudeConfig(file, (raw) => { raw.b = 2 }, {
        _isWindowsOverride: true,
        _stampAcl: (tmp) => { events.push(statSync(tmp).size) },
      })
      assert.deepEqual(events, [0], 'stamped once, with no content bytes present yet')
      assert.deepEqual(readJson(file), { env: { ANTHROPIC_API_KEY: 'x' }, b: 2 })
    })
  }

  it('Windows: a retarget DURING the EBUSY backoff is caught (the check re-runs after the sleep)', { skip: process.platform === 'win32' }, () => {
    const a = join(dir, 'a.json')
    const b = join(dir, 'b.json')
    const link = join(dir, 'link.json')
    writeFileSync(a, JSON.stringify({ from: 'A' }))
    writeFileSync(b, JSON.stringify({ from: 'B' }))
    symlinkSync(a, link)
    let renames = 0
    updateClaudeConfig(link, (raw) => { raw.mine = 1 }, {
      _isWindowsOverride: true,
      _stampAcl: () => {},
      _rename: (from, to) => {
        if (renames++ === 0) throw Object.assign(new Error('busy'), { code: 'EBUSY' })
        renameSync(from, to)
      },
      _sleep: (ms) => {
        // only the first backoff retargets; later pauses (conflict jitter) must not
        if (ms === 25) { rmSync(link); symlinkSync(b, link) }
      },
    })
    assert.deepEqual(readJson(a), { from: 'A' }, 'the stale target was not modified')
    assert.deepEqual(readJson(b), { from: 'B', mine: 1 })
    assert.equal(readlinkSync(link), b)
    assert.deepEqual(leftovers(dir), [])
  })

  describe('Windows ACL stamp fails CLOSED (real helper, command runner mocked)', () => {
    const run = (execImpl, file) => {
      const calls = []
      const stamped = []
      let fsyncs = 0
      let renames = 0
      return {
        calls,
        stamped,
        counts: () => ({ fsyncs, renames }),
        go: () => updateClaudeConfig(file, (raw) => { raw.b = 2 }, {
          _isWindowsOverride: true,
          _fsync: () => { fsyncs++ },
          _rename: (f, t) => { renames++; renameSync(f, t) },
          _stampAcl: (tmp) => {
            stamped.push(statSync(tmp).size)
            return stampWindowsAclStrict(tmp, { _onWindows: true, _exec: (cmd, args) => { calls.push(cmd); return execImpl(cmd, args) } })
          },
        }),
      }
    }
    for (const [label, execImpl, re] of [
      ['whoami fails', (cmd) => { if (cmd.includes('whoami')) throw new Error('whoami boom'); return '' }, /current-user SID.*whoami boom/],
      ['whoami output has no SID', (cmd) => (cmd.includes('whoami') ? 'garbage' : ''), /current-user SID/],
      ['icacls fails', (cmd) => { if (cmd.includes('icacls')) throw new Error('icacls boom'); return '"u","S-1-5-21-1-2-3-1001"' }, /icacls could not stamp the owner-only ACL.*icacls boom/],
    ]) {
      it(`${label}: throws naming the ACL step, no payload write, no rename, destination untouched, temp cleaned`, () => {
        const file = join(dir, 'settings.json')
        const original = '{"env":{"ANTHROPIC_API_KEY":"x"}}'
        writeFileSync(file, original)
        const r = run(execImpl, file)
        assert.throws(() => r.go(), re)
        assert.equal(readFileSync(file, 'utf8'), original)
        assert.deepEqual(leftovers(dir), [])
        assert.deepEqual(r.counts(), { fsyncs: 0, renames: 0 }, 'payload never fsynced, nothing renamed')
        assert.deepEqual(r.stamped, [0], 'the stamp ran on the empty temp')
      })
    }

    it('success path: whoami then icacls with the owner + SYSTEM grants, content written afterwards', () => {
      const file = join(dir, '.claude.json')
      writeFileSync(file, '{"a":1}')
      const seen = []
      const r = run((cmd, args) => { seen.push(args); return cmd.includes('whoami') ? '"u","S-1-5-21-1-2-3-1001"' : '' }, file)
      r.go()
      assert.deepEqual(readJson(file), { a: 1, b: 2 })
      assert.ok(seen.some((a) => a.includes('/inheritance:r')))
    })
  })

  it('a torn read (truncate-then-write editor caught mid-write) is re-read once after a pause, then merged', () => {
    const file = join(dir, 'torn.json')
    writeFileSync(file, '{"a":')
    const pauses = []
    const out = updateClaudeConfig(file, (raw) => { raw.mine = 1 }, {
      _sleep: (ms) => { pauses.push(ms); writeFileSync(file, '{"a":1}') },
    })
    assert.equal(out.ok, true)
    assert.equal(pauses.length, 1)
    assert.deepEqual(readJson(file), { a: 1, mine: 1 })
  })

  it('a file that is STILL invalid after the re-read fails closed and is never overwritten', () => {
    const file = join(dir, 'torn2.json')
    writeFileSync(file, '{"a":')
    const pauses = []
    const out = updateClaudeConfig(file, (raw) => { raw.mine = 1 }, { _sleep: (ms) => pauses.push(ms) })
    assert.equal(out.ok, false)
    assert.equal(pauses.length, 1, 'exactly one re-read')
    assert.equal(readFileSync(file, 'utf8'), '{"a":')
  })

  it('conflict retries pause with a small jittered delay (not after the last attempt)', () => {
    const file = join(dir, 'pace.json')
    writeFileSync(file, '{}')
    let n = 0
    claudeConfigTestHooks.beforeVerify = () => { n++; writeFileSync(file, JSON.stringify({ n })) }
    const pauses = []
    assert.throws(() => updateClaudeConfig(file, () => {}, { maxAttempts: 3, _sleep: (ms) => pauses.push(ms) }), ClaudeConfigConflictError)
    assert.equal(pauses.length, 2)
    for (const ms of pauses) assert.ok(ms >= 1 && ms <= 8, `jitter ${ms} in 1..8ms`)
  })

  it('foreign-uid symlink target is refused, including when it appears on the re-resolve before the rename', { skip: process.platform === 'win32' || typeof process.getuid !== 'function' }, () => {
    const real = join(dir, 'real.json')
    const link = join(dir, 'link.json')
    writeFileSync(real, '{"a":1}')
    symlinkSync(real, link)
    const uid = process.getuid()
    const stub = mock.method(process, 'getuid', () => uid + 1)
    try {
      assert.throws(() => updateClaudeConfig(link, (raw) => { raw.x = 1 }), /owned by uid/)
    } finally {
      stub.mock.restore()
    }
    assert.equal(readFileSync(real, 'utf8'), '{"a":1}')
    // re-resolve path: acceptable at read time, foreign by the time of the rename
    let stub2
    claudeConfigTestHooks.beforeVerify = () => {
      claudeConfigTestHooks.beforeVerify = null
      stub2 = mock.method(process, 'getuid', () => uid + 1)
    }
    try {
      assert.throws(() => updateClaudeConfig(link, (raw) => { raw.x = 1 }), /owned by uid/)
    } finally {
      stub2?.mock.restore()
    }
    assert.equal(readFileSync(real, 'utf8'), '{"a":1}')
    assert.deepEqual(leftovers(dir), [])
  })

  for (const [label, preMode] of [['a new file', null], ['an existing 0600 file', 0o600], ['an existing 0640 file', 0o640]]) {
    it(`the temp is never wider than the target mode at the verify point (${label})`, { skip: process.platform === 'win32' }, () => {
      const file = join(dir, 'm.json')
      if (preMode !== null) { writeFileSync(file, '{}'); chmodSync(file, preMode) }
      const target = preMode ?? 0o600
      const seen = []
      claudeConfigTestHooks.beforeVerify = () => {
        for (const n of leftovers(dir)) seen.push(statSync(join(dir, n)).mode & 0o777)
      }
      updateClaudeConfig(file, (raw) => { raw.x = 1 })
      assert.ok(seen.length >= 1, 'a temp existed at the verify point')
      for (const m of seen) assert.equal(m & ~target & 0o777, 0, `temp mode ${m.toString(8)} wider than ${target.toString(8)}`)
      assert.equal(statSync(file).mode & 0o777, target)
    })
  }

  it('settings.json mode warning: group/world-readable warns, owner-only and Windows do not', () => {
    assert.match(describeSettingsModeWarning({ filePath: '/x/settings.json', mode: 0o644 }), /chmod 600 \/x\/settings\.json/)
    assert.equal(describeSettingsModeWarning({ filePath: '/x', mode: 0o600 }), null)
    assert.equal(describeSettingsModeWarning({ filePath: '/x', mode: null }), null)
  })

  it('hook register on a 0644 settings.json preserves the mode and warns', { skip: process.platform === 'win32' }, async () => {
    const settingsPath = join(dir, 'settings.json')
    writeFileSync(settingsPath, '{}')
    chmodSync(settingsPath, 0o644)
    const warns = []
    const m = mock.method(console, 'warn', (line) => warns.push(String(line)))
    try {
      await createPermissionHookManager(new EventEmitter(), { settingsPath }).register()
    } finally {
      m.mock.restore()
    }
    assert.equal(statSync(settingsPath).mode & 0o777, 0o644)
    assert.ok(warns.some((l) => l.includes('readable beyond its owner')), 'warned')
  })

  it('POSIX does not retry EBUSY (only Windows has the held-handle semantics)', () => {
    const file = join(dir, 'posix.json')
    writeFileSync(file, '{}')
    let calls = 0
    assert.throws(() => updateClaudeConfig(file, () => {}, {
      _isWindowsOverride: false,
      _rename: () => { calls++; throw Object.assign(new Error('busy'), { code: 'EBUSY' }) },
    }), /busy/)
    assert.equal(calls, 1)
  })
})

describe('#8983 every caller goes through the choke point', () => {
  it('permission-hook register(): a concurrent settings.json write survives', async () => {
    const settingsPath = join(dir, 'settings.json')
    writeFileSync(settingsPath, JSON.stringify({ theme: 'dark' }))
    injectOnce(settingsPath, 'claudeAdded', { k: 1 })
    const manager = createPermissionHookManager(new EventEmitter(), { settingsPath })
    await manager.register()
    const s = readJson(settingsPath)
    assert.deepEqual(s.claudeAdded, { k: 1 })
    assert.equal(s.theme, 'dark')
    assert.equal(s.hooks.PreToolUse.length, 1)
    assert.equal(s.hooks.PreToolUse[0]._chroxy, true)
  })

  it('permission-hook unregister(): a concurrent settings.json write survives', async () => {
    const settingsPath = join(dir, 'settings.json')
    writeFileSync(settingsPath, '{}')
    const manager = createPermissionHookManager(new EventEmitter(), { settingsPath })
    await manager.register()
    injectOnce(settingsPath, 'claudeAdded', 'z')
    await manager.unregister()
    const s = readJson(settingsPath)
    assert.equal(s.claudeAdded, 'z')
    assert.equal(s.hooks, undefined, 'our hook is gone')
  })

  it('permission-hook register(): a corrupt settings.json is still refused with the invalid-JSON error', async () => {
    const settingsPath = join(dir, 'settings.json')
    writeFileSync(settingsPath, '{ broken')
    const emitter = new EventEmitter()
    const errors = []
    emitter.on('error', (e) => errors.push(e.message))
    const manager = createPermissionHookManager(emitter, { settingsPath })
    await manager.register()
    assert.equal(readFileSync(settingsPath, 'utf8'), '{ broken')
    assert.ok(errors.some((m) => m.includes('invalid JSON')))
  })

  it('trust pre-write (ensureCwdTrusted): a concurrent .claude.json write survives', () => {
    const configDir = join(dir, 'cc')
    mkdirSync(configDir)
    const cfg = join(configDir, '.claude.json')
    writeFileSync(cfg, JSON.stringify({ numStartups: 3 }))
    injectOnce(cfg, 'claudeCounter', 42)
    const cwd = join(dir, 'proj')
    mkdirSync(cwd)
    ensureCwdTrusted(cwd, { CLAUDE_CONFIG_DIR: configDir, HOME: dir })
    const c = readJson(cfg)
    assert.equal(c.claudeCounter, 42)
    assert.equal(c.numStartups, 3)
    const key = Object.keys(c.projects)[0]
    assert.equal(c.projects[key].hasTrustDialogAccepted, true)
  })

  it('trust pre-write: exhausted retries warn and skip, leaving the other writer\'s file untouched', () => {
    const configDir = join(dir, 'cc')
    mkdirSync(configDir)
    const cfg = join(configDir, '.claude.json')
    writeFileSync(cfg, '{"n":0}')
    let n = 0
    claudeConfigTestHooks.beforeVerify = () => { n++; writeFileSync(cfg, JSON.stringify({ n })) }
    const cwd = join(dir, 'proj')
    mkdirSync(cwd)
    ensureCwdTrusted(cwd, { CLAUDE_CONFIG_DIR: configDir, HOME: dir })
    assert.deepEqual(readJson(cfg), { n })
  })

  it('MCP add: a concurrent .claude.json write survives', () => {
    const cfg = join(dir, '.claude.json')
    writeFileSync(cfg, JSON.stringify({ history: ['a'] }))
    injectOnce(cfg, 'claudeCounter', 7)
    const res = addMcpServerToConfig({ name: 'srv', config: { command: 'node', args: ['x.js'] }, configPath: cfg })
    assert.equal(res.ok, true)
    const c = readJson(cfg)
    assert.equal(c.claudeCounter, 7)
    assert.deepEqual(c.history, ['a'])
    assert.equal(c.mcpServers.srv.command, 'node')
  })

  it('MCP add: a concurrent writer adding the SAME name turns the retry into an EXISTS refusal, not an overwrite', () => {
    const cfg = join(dir, '.claude.json')
    writeFileSync(cfg, '{}')
    claudeConfigTestHooks.beforeVerify = () => {
      claudeConfigTestHooks.beforeVerify = null
      writeFileSync(cfg, JSON.stringify({ mcpServers: { srv: { command: 'theirs' } } }))
    }
    const res = addMcpServerToConfig({ name: 'srv', config: { command: 'node' }, configPath: cfg })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'EXISTS')
    assert.equal(readJson(cfg).mcpServers.srv.command, 'theirs')
  })

  it('MCP remove: a concurrent .claude.json write survives', () => {
    const cfg = join(dir, '.claude.json')
    writeFileSync(cfg, JSON.stringify({ mcpServers: { srv: { command: 'node' }, keep: { command: 'k' } } }))
    injectOnce(cfg, 'claudeCounter', 9)
    const res = removeMcpServerFromConfig({ name: 'srv', configPath: cfg })
    assert.deepEqual({ ok: res.ok, found: res.found }, { ok: true, found: true })
    const c = readJson(cfg)
    assert.equal(c.claudeCounter, 9)
    assert.deepEqual(Object.keys(c.mcpServers), ['keep'])
  })

  it('MCP remove: a concurrent writer that already removed the name makes the retry a no-op (found:false), not a resurrect', () => {
    const cfg = join(dir, '.claude.json')
    writeFileSync(cfg, JSON.stringify({ mcpServers: { srv: { command: 'node' } } }))
    claudeConfigTestHooks.beforeVerify = () => {
      claudeConfigTestHooks.beforeVerify = null
      writeFileSync(cfg, JSON.stringify({ mcpServers: {}, theirs: 1 }))
    }
    const res = removeMcpServerFromConfig({ name: 'srv', configPath: cfg })
    assert.equal(res.found, false)
    assert.deepEqual(readJson(cfg), { mcpServers: {}, theirs: 1 })
  })
})
