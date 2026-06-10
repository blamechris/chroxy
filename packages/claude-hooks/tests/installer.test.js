// #5413 Phase 4: installer pins.
//
//   - fresh install registers all six hook events (Notification carries
//     the idle_prompt + permission_prompt matchers)
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
import { chmodSync, mkdtempSync, readFileSync, statSync, writeFileSync, existsSync } from 'node:fs'
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
  it('creates settings.json with all six events on fresh install', () => {
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
    for (const event of ['SessionEnd', 'SubagentStart', 'SubagentStop', 'Notification', 'PostToolUse']) {
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
