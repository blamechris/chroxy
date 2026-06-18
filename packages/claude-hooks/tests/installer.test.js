// #5413 Phase 4: installer pins.
//
//   - fresh install registers all eight hook events (Notification carries
//     the idle_prompt + permission_prompt matchers; UserPromptSubmit and
//     Stop are the #5541 matcher-less turn edges)
//   - IDEMPOTENT: re-running converges (deep-equal settings, no dupes)
//   - never clobbers unrelated hooks: foreign commands in our events,
//     foreign matcher groups, and foreign event keys all survive
//     install AND uninstall byte-for-byte
//   - stale-path migration: re-install with a new bin path replaces the
//     old entries instead of accumulating
//   - uninstall removes ONLY our entries; events we emptied are dropped
//   - unparseable settings.json → throws, file NOT overwritten
//
// Every test operates on a temp settings.json (never the real one — the
// _setup.mjs sandbox would throw anyway).

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync, symlinkSync, lstatSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  installHooks,
  uninstallHooks,
  removeOwnHooks,
  addOwnHooks,
  buildHookCommand,
  defaultSettingsPath,
  HOOK_EVENTS,
  TYPE_FOR_HOOK_EVENT,
  COMMAND_MARKER,
} from '../src/installer.js'

const BIN = '/opt/somewhere/chroxy/packages/claude-hooks/bin/chroxy-hooks.js'
const NODE = '/usr/local/bin/node'

function tempSettingsPath(initial) {
  const dir = mkdtempSync(join(tmpdir(), 'hooks-install-'))
  const path = join(dir, 'settings.json')
  if (initial !== undefined) writeFileSync(path, initial)
  return path
}

function read(path) {
  return JSON.parse(readFileSync(path, 'utf-8'))
}

function ourEntries(settings, event) {
  return (settings.hooks?.[event] || [])
    .flatMap((g) => g.hooks || [])
    .filter((h) => h.command?.includes(COMMAND_MARKER))
}

describe('buildHookCommand', () => {
  it('embeds quoted absolute node + bin paths and the emit type', () => {
    const cmd = buildHookCommand('SessionStart', { nodePath: '/path with space/node', binPath: BIN })
    assert.equal(cmd, `'/path with space/node' '${BIN}' emit session_start`)
  })

  it('throws on unknown events', () => {
    assert.throws(() => buildHookCommand('Nope', { nodePath: NODE, binPath: BIN }))
  })
})

describe('installHooks', () => {
  it('creates settings.json with all eight events on fresh install', () => {
    const path = tempSettingsPath()
    installHooks({ settingsPath: path, nodePath: NODE, binPath: BIN })
    const settings = read(path)
    for (const event of HOOK_EVENTS) {
      const entries = ourEntries(settings, event)
      assert.ok(entries.length >= 1, `missing ${event}`)
      for (const entry of entries) {
        assert.equal(entry.type, 'command')
        assert.ok(entry.command.includes(`'${BIN}' emit `), entry.command)
      }
    }
    const matchers = settings.hooks.Notification.map((g) => g.matcher).sort()
    assert.deepEqual(matchers, ['idle_prompt', 'permission_prompt'])
    assert.equal(ourEntries(settings, 'SessionStart').length, 1)
  })

  it('is idempotent — re-running converges with no duplicates', () => {
    const path = tempSettingsPath()
    installHooks({ settingsPath: path, nodePath: NODE, binPath: BIN })
    const first = read(path)
    installHooks({ settingsPath: path, nodePath: NODE, binPath: BIN })
    installHooks({ settingsPath: path, nodePath: NODE, binPath: BIN })
    assert.deepEqual(read(path), first)
  })

  it('upgrades a legacy 6-event install to 8 events idempotently (#5541)', () => {
    // Simulate a settings.json written by a PRE-#5541 installer: the old six
    // events registered with our exact command shape, no UserPromptSubmit/Stop.
    const LEGACY_EVENTS = ['SessionStart', 'SessionEnd', 'SubagentStart', 'SubagentStop', 'Notification', 'PostToolUse']
    const legacyHooks = {}
    for (const event of LEGACY_EVENTS) {
      const entry = { type: 'command', command: `'${NODE}' '${BIN}' emit ${TYPE_FOR_HOOK_EVENT[event]}` }
      legacyHooks[event] = event === 'Notification'
        ? [{ matcher: 'idle_prompt', hooks: [entry] }, { matcher: 'permission_prompt', hooks: [entry] }]
        : [{ hooks: [entry] }]
    }
    const path = tempSettingsPath(JSON.stringify({ hooks: legacyHooks }))

    installHooks({ settingsPath: path, nodePath: NODE, binPath: BIN })
    const upgraded = read(path)

    // The two new turn edges are now present, matcher-less, exactly once each.
    for (const event of ['UserPromptSubmit', 'Stop']) {
      const entries = ourEntries(upgraded, event)
      assert.equal(entries.length, 1, `${event} should be registered once`)
      assert.ok(upgraded.hooks[event][0].matcher === undefined, `${event} must be matcher-less`)
      assert.ok(entries[0].command.endsWith(`emit ${TYPE_FOR_HOOK_EVENT[event]}`), entries[0].command)
    }
    // The legacy six did not duplicate.
    for (const event of LEGACY_EVENTS) {
      assert.equal(ourEntries(upgraded, event).length, event === 'Notification' ? 2 : 1, `${event} duplicated on upgrade`)
    }
    // All eight present.
    for (const event of HOOK_EVENTS) {
      assert.ok(event in upgraded.hooks, `missing ${event} after upgrade`)
    }
    // Re-running on the upgraded file is a no-op (idempotent).
    installHooks({ settingsPath: path, nodePath: NODE, binPath: BIN })
    assert.deepEqual(read(path), upgraded)
  })

  it('preserves unrelated hooks in shared and foreign events', () => {
    const foreign = {
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: '/Users/x/skill-check.sh' }] },
        ],
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '/Users/x/guard.sh' }] },
        ],
      },
      permissions: { allow: ['Bash(ls:*)'] },
    }
    const path = tempSettingsPath(JSON.stringify(foreign))
    installHooks({ settingsPath: path, nodePath: NODE, binPath: BIN })
    const settings = read(path)
    assert.deepEqual(settings.permissions, foreign.permissions)
    assert.deepEqual(settings.hooks.PreToolUse, foreign.hooks.PreToolUse)
    const sessionStartCommands = settings.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command))
    assert.ok(sessionStartCommands.includes('/Users/x/skill-check.sh'))
    assert.equal(ourEntries(settings, 'SessionStart').length, 1)
  })

  it('migrates stale bin paths instead of accumulating', () => {
    const path = tempSettingsPath()
    installHooks({ settingsPath: path, nodePath: NODE, binPath: '/old/checkout/bin/chroxy-hooks.js' })
    installHooks({ settingsPath: path, nodePath: NODE, binPath: BIN })
    const settings = read(path)
    for (const event of HOOK_EVENTS) {
      const entries = ourEntries(settings, event)
      for (const entry of entries) {
        assert.ok(!entry.command.includes('/old/checkout/'), entry.command)
      }
      assert.equal(entries.length, event === 'Notification' ? 2 : 1)
    }
  })

  it('refuses to clobber a managed event key with an unexpected shape', () => {
    const malformed = JSON.stringify({ hooks: { SessionStart: 'not-an-array' } })
    const path = tempSettingsPath(malformed)
    assert.throws(() => installHooks({ settingsPath: path, nodePath: NODE, binPath: BIN }), /unexpected shape/)
    assert.equal(readFileSync(path, 'utf-8'), malformed)
  })

  it('preserves the settings file mode across the atomic rewrite', () => {
    const path = tempSettingsPath(JSON.stringify({ model: 'opus' }))
    chmodSync(path, 0o600)
    installHooks({ settingsPath: path, nodePath: NODE, binPath: BIN })
    assert.equal(statSync(path).mode & 0o777, 0o600)
  })

  it('rewrites a read-only (0o444) settings file and preserves that mode', () => {
    // A read-only source mode must not break the atomic write: the temp file
    // is created writable, fsync'd, then chmod'd to 0o444 AFTER the data is
    // durable (reopening a 0o444 file with r+ would fail EACCES).
    const path = tempSettingsPath(JSON.stringify({ model: 'opus' }))
    chmodSync(path, 0o444)
    installHooks({ settingsPath: path, nodePath: NODE, binPath: BIN })
    assert.equal(statSync(path).mode & 0o777, 0o444)
    assert.ok(read(path).hooks.SessionStart, 'install did not write through a read-only file')
  })

  it('refuses to overwrite an unparseable settings.json', () => {
    const path = tempSettingsPath('{not valid json')
    assert.throws(() => installHooks({ settingsPath: path, nodePath: NODE, binPath: BIN }), /not valid JSON/)
    assert.equal(readFileSync(path, 'utf-8'), '{not valid json')
  })

  it('treats an empty file as empty settings', () => {
    const path = tempSettingsPath('')
    installHooks({ settingsPath: path, nodePath: NODE, binPath: BIN })
    assert.ok(read(path).hooks.SessionEnd)
  })

  it('preserves a symlinked settings.json (writes through to the link target)', () => {
    // Simulate a dotfile manager (stow/chezmoi/yadm): settings.json is a
    // symlink into a managed store. Install must write through the link, not
    // clobber it with a regular file.
    const storeDir = mkdtempSync(join(tmpdir(), 'hooks-store-'))
    const targetPath = join(storeDir, 'real-settings.json')
    writeFileSync(targetPath, JSON.stringify({ model: 'opus' }))
    const linkDir = mkdtempSync(join(tmpdir(), 'hooks-link-'))
    const linkPath = join(linkDir, 'settings.json')
    // Best-effort: symlink creation is disallowed on some platforms (Windows
    // CI without Developer Mode / admin, restricted sandboxes). Skip rather
    // than fail the whole suite — repo precedent, see e.g.
    // packages/server/tests/skills-loader.test.js:486.
    try { symlinkSync(targetPath, linkPath) } catch { return }

    installHooks({ settingsPath: linkPath, nodePath: NODE, binPath: BIN })

    // The path is still a symlink…
    assert.equal(lstatSync(linkPath).isSymbolicLink(), true, 'settings.json link was clobbered')
    // …pointing at the same target…
    assert.equal(realpathSync(linkPath), realpathSync(targetPath))
    // …and the install landed in the target file.
    const viaLink = read(linkPath)
    const viaTarget = read(targetPath)
    assert.equal(viaLink.model, 'opus')
    assert.ok(viaTarget.hooks.SessionStart, 'install did not reach the link target')
    assert.deepEqual(viaLink, viaTarget)
  })

  it('preserves a hook whose command merely contains the marker (compound wrapper)', () => {
    // A user-authored compound command that wraps our emitter must NOT be
    // pruned on install — the installer only owns commands of the exact shape
    // it writes.
    const wrapper = `'${NODE}' '${BIN}' emit session_start && afplay /System/Library/Sounds/Glass.aiff`
    const settings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: wrapper }] }],
      },
    }
    const path = tempSettingsPath(JSON.stringify(settings))
    installHooks({ settingsPath: path, nodePath: NODE, binPath: BIN })
    const after = read(path)
    const commands = after.hooks.SessionStart.flatMap((g) => g.hooks.map((h) => h.command))
    assert.ok(commands.includes(wrapper), 'compound wrapper command was pruned on install')
    // Our own entry (exact shape) is still added exactly once alongside it.
    const exact = `'${NODE}' '${BIN}' emit session_start`
    assert.equal(commands.filter((c) => c === exact).length, 1)
    // Two SessionStart commands total: the wrapper + our one exact entry.
    assert.equal(commands.length, 2)
  })

  it('aborts install when top-level hooks is an array', () => {
    const malformed = JSON.stringify({ hooks: [{ matcher: 'x', hooks: [] }] })
    const path = tempSettingsPath(malformed)
    assert.throws(() => installHooks({ settingsPath: path, nodePath: NODE, binPath: BIN }), /hooks/)
    assert.equal(readFileSync(path, 'utf-8'), malformed)
  })

  it('aborts install when top-level hooks is a string', () => {
    const malformed = JSON.stringify({ hooks: 'nope' })
    const path = tempSettingsPath(malformed)
    assert.throws(() => installHooks({ settingsPath: path, nodePath: NODE, binPath: BIN }), /hooks/)
    assert.equal(readFileSync(path, 'utf-8'), malformed)
  })
})

describe('uninstallHooks', () => {
  it('removes only our entries; foreign hooks and settings survive', () => {
    const path = tempSettingsPath(JSON.stringify({
      hooks: {
        SessionStart: [
          { hooks: [{ type: 'command', command: '/Users/x/skill-check.sh' }] },
        ],
        PreToolUse: [
          { matcher: 'Bash', hooks: [{ type: 'command', command: '/Users/x/guard.sh' }] },
        ],
      },
      model: 'opus',
    }))
    installHooks({ settingsPath: path, nodePath: NODE, binPath: BIN })
    uninstallHooks({ settingsPath: path })
    const settings = read(path)
    assert.equal(settings.model, 'opus')
    assert.deepEqual(settings.hooks.SessionStart, [
      { hooks: [{ type: 'command', command: '/Users/x/skill-check.sh' }] },
    ])
    assert.deepEqual(settings.hooks.PreToolUse, [
      { matcher: 'Bash', hooks: [{ type: 'command', command: '/Users/x/guard.sh' }] },
    ])
    // Events that only contained our entries are gone entirely
    for (const event of ['SessionEnd', 'SubagentStart', 'SubagentStop', 'Notification', 'PostToolUse', 'UserPromptSubmit', 'Stop']) {
      assert.equal(event in settings.hooks, false, `${event} should be removed`)
    }
  })

  it('removes our command from a shared matcher group without dropping the group', () => {
    const shared = {
      hooks: {
        SessionEnd: [
          {
            hooks: [
              { type: 'command', command: '/Users/x/other.sh' },
              { type: 'command', command: `'${NODE}' '${BIN}' emit session_end` },
            ],
          },
        ],
      },
    }
    const path = tempSettingsPath(JSON.stringify(shared))
    const settings = removeOwnHooks(read(path))
    assert.deepEqual(settings.hooks.SessionEnd, [
      { hooks: [{ type: 'command', command: '/Users/x/other.sh' }] },
    ])
  })

  it('is a no-op on a missing settings file', () => {
    const path = join(mkdtempSync(join(tmpdir(), 'hooks-none-')), 'settings.json')
    uninstallHooks({ settingsPath: path })
    assert.equal(existsSync(path), false)
  })

  it('does NOT remove a compound wrapper command that merely contains the marker', () => {
    const wrapper = `'${NODE}' '${BIN}' emit session_start && afplay /System/Library/Sounds/Glass.aiff`
    const settings = {
      hooks: {
        SessionStart: [{ hooks: [{ type: 'command', command: wrapper }] }],
      },
    }
    const path = tempSettingsPath(JSON.stringify(settings))
    uninstallHooks({ settingsPath: path })
    const after = read(path)
    const commands = (after.hooks?.SessionStart || []).flatMap((g) => g.hooks.map((h) => h.command))
    assert.ok(commands.includes(wrapper), 'compound wrapper command was removed on uninstall')
  })

  it('install → uninstall on a fresh file round-trips to no chroxy-hooks entries', () => {
    const path = tempSettingsPath()
    installHooks({ settingsPath: path, nodePath: NODE, binPath: BIN })
    uninstallHooks({ settingsPath: path })
    const settings = read(path)
    for (const event of HOOK_EVENTS) {
      assert.equal(ourEntries(settings, event).length, 0)
    }
  })
})

describe('defaultSettingsPath', () => {
  it('honors CHROXY_HOOKS_SETTINGS_PATH', () => {
    assert.equal(defaultSettingsPath({ CHROXY_HOOKS_SETTINGS_PATH: '/tmp/x/settings.json' }), '/tmp/x/settings.json')
  })

  it('defaults under the (sandboxed) home', () => {
    const path = defaultSettingsPath({})
    assert.ok(path.endsWith(join('.claude', 'settings.json')))
  })
})

describe('addOwnHooks / removeOwnHooks purity', () => {
  it('does not mutate the input settings object', () => {
    const input = { hooks: { SessionStart: [{ hooks: [{ type: 'command', command: '/x.sh' }] }] } }
    const snapshot = JSON.parse(JSON.stringify(input))
    addOwnHooks(input, { nodePath: NODE, binPath: BIN })
    removeOwnHooks(input)
    assert.deepEqual(input, snapshot)
  })
})
