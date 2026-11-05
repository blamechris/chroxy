// #8974 — the settings / global-config paths that still assumed `~/.claude`.
//
// #8973 made chroxy's READS of sessions, transcripts and memory follow
// CLAUDE_CONFIG_DIR. Five more sites joined homedir() themselves:
//   - permission-hook.js     user-level `settings.json` (hook registration)
//   - statusline.js          user-level `settings.json` / `project-settings.json`
//   - auth-probes.js         `.claude.json` (OAuth account metadata)
//   - byok-mcp-config.js     `.claude.json` (MCP servers)
//   - claude-tui/pty-driver  `.claude.json` (workspace-trust pre-write)
// claude derives its global config as
// `join(CLAUDE_CONFIG_DIR || homedir(), '.claude.json')` — note: the HOME
// directory by default, not `~/.claude/`.
//
// Every test points HOME at a mkdtemp dir and CLAUDE_CONFIG_DIR at another, so a
// regression that wrote to the real home would trip the sandbox guard.

import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import '../src/claude-tui-session.js' // fixes the session<->driver import cycle order
import { claudeGlobalConfigPath } from '../src/utils/claude-config-dir.js'
import { createPermissionHookManager, countUserLevelChroxyHooks } from '../src/permission-hook.js'
import { StatusLineManager } from '../src/statusline.js'
import { hasClaudeOAuthCreds, resetCachesForTest } from '../src/auth-probes.js'
import { defaultClaudeConfigPath } from '../src/byok-mcp-config.js'
import { ensureCwdTrusted } from '../src/claude-tui/pty-driver.js'

const ENV_KEYS = ['HOME', 'CLAUDE_CONFIG_DIR', 'CHROXY_CLAUDE_HOME', 'CHROXY_CLAUDE_CONFIG', 'CHROXY_CLAUDE_KEYCHAIN', 'CHROXY_CONFIG_DIR']

let root
let fakeHome
let override
let saved

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'claude-cfg-paths-')))
  fakeHome = join(root, 'home')
  override = join(root, 'profile')
  mkdirSync(fakeHome)
  mkdirSync(override)
  saved = {}
  for (const k of ENV_KEYS) saved[k] = process.env[k]
  process.env.HOME = fakeHome
  process.env.CHROXY_CONFIG_DIR = join(fakeHome, '.chroxy')
  process.env.CHROXY_CLAUDE_KEYCHAIN = '0'
  delete process.env.CLAUDE_CONFIG_DIR
  delete process.env.CHROXY_CLAUDE_HOME
  delete process.env.CHROXY_CLAUDE_CONFIG
  resetCachesForTest()
})

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k]
    else process.env[k] = saved[k]
  }
  resetCachesForTest()
  rmSync(root, { recursive: true, force: true })
})

describe('claudeGlobalConfigPath (#8974)', () => {
  it('is $HOME/.claude.json when CLAUDE_CONFIG_DIR is unset', () => {
    assert.equal(claudeGlobalConfigPath({}), join(fakeHome, '.claude.json'))
    assert.equal(claudeGlobalConfigPath(), join(fakeHome, '.claude.json'))
  })

  it('is <override>/.claude.json when CLAUDE_CONFIG_DIR is usable', () => {
    assert.equal(claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: override }), join(override, '.claude.json'))
  })

  it('follows process.env by default', () => {
    process.env.CLAUDE_CONFIG_DIR = override
    assert.equal(claudeGlobalConfigPath(), join(override, '.claude.json'))
  })

  it('falls back to $HOME/.claude.json for an override the resolver rejects', () => {
    for (const bad of ['', 'relative/dir', '~/x', '/', ` ${override}`]) {
      assert.equal(claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: bad }), join(fakeHome, '.claude.json'), JSON.stringify(bad))
    }
  })
})

describe('permission hook registration (#8974)', () => {
  const hookScript = '/opt/chroxy/hooks/permission-hook.sh'

  it('registers into <CLAUDE_CONFIG_DIR>/settings.json and keeps the existing keys', async () => {
    process.env.CLAUDE_CONFIG_DIR = override
    const target = join(override, 'settings.json')
    writeFileSync(target, JSON.stringify({
      theme: 'dark',
      permissions: { allow: ['Bash(ls)'] },
      hooks: { PreToolUse: [{ matcher: 'Bash', hooks: [{ type: 'command', command: 'echo mine' }] }], Stop: [{ hooks: [] }] },
    }))
    const manager = createPermissionHookManager(new EventEmitter(), { hookScript })
    await manager.register()

    const settings = JSON.parse(readFileSync(target, 'utf-8'))
    assert.equal(settings.theme, 'dark')
    assert.deepEqual(settings.permissions, { allow: ['Bash(ls)'] })
    assert.ok(Array.isArray(settings.hooks.Stop))
    const pre = settings.hooks.PreToolUse
    assert.ok(pre.some((e) => e.hooks?.[0]?.command === 'echo mine'), 'user hook entry survived')
    assert.equal(pre.filter((e) => e._chroxy === true).length, 1, 'exactly one chroxy entry')
    assert.ok(!existsSync(join(fakeHome, '.claude', 'settings.json')), 'default home settings untouched')

    assert.equal(countUserLevelChroxyHooks().found, 1)
    assert.equal(countUserLevelChroxyHooks().settingsPath, target)

    await manager.destroy()
    const after = JSON.parse(readFileSync(target, 'utf-8'))
    assert.equal(after.theme, 'dark')
    assert.equal((after.hooks.PreToolUse || []).filter((e) => e._chroxy === true).length, 0)
    assert.ok(after.hooks.PreToolUse.some((e) => e.hooks?.[0]?.command === 'echo mine'))
  })

  it('registers into ~/.claude/settings.json when CLAUDE_CONFIG_DIR is unset', async () => {
    const manager = createPermissionHookManager(new EventEmitter(), { hookScript })
    await manager.register()
    const target = join(fakeHome, '.claude', 'settings.json')
    assert.equal(JSON.parse(readFileSync(target, 'utf-8')).hooks.PreToolUse.filter((e) => e._chroxy === true).length, 1)
    await manager.destroy()
  })

  it('falls back to ~/.claude/settings.json for an unusable override', async () => {
    process.env.CLAUDE_CONFIG_DIR = 'relative/profile'
    const manager = createPermissionHookManager(new EventEmitter(), { hookScript })
    await manager.register()
    assert.ok(existsSync(join(fakeHome, '.claude', 'settings.json')))
    await manager.destroy()
  })
})

describe('statusline user settings (#8974)', () => {
  const cfg = { statusLine: { type: 'command', command: 'echo hi' } }

  it('reads the statusLine from <CLAUDE_CONFIG_DIR>/settings.json', async () => {
    process.env.CLAUDE_CONFIG_DIR = override
    writeFileSync(join(override, 'settings.json'), JSON.stringify(cfg))
    const mgr = new StatusLineManager()
    const found = await mgr.resolveConfig(join(root, 'no-such-project'))
    assert.equal(found?.command, 'echo hi')
  })

  it('ignores ~/.claude when the override is set', async () => {
    process.env.CLAUDE_CONFIG_DIR = override
    mkdirSync(join(fakeHome, '.claude'))
    writeFileSync(join(fakeHome, '.claude', 'settings.json'), JSON.stringify(cfg))
    const mgr = new StatusLineManager()
    assert.equal(await mgr.resolveConfig(join(root, 'no-such-project')), null)
  })

  it('reads ~/.claude/settings.json when the override is unset', async () => {
    mkdirSync(join(fakeHome, '.claude'))
    writeFileSync(join(fakeHome, '.claude', 'settings.json'), JSON.stringify(cfg))
    const mgr = new StatusLineManager()
    assert.equal((await mgr.resolveConfig(join(root, 'no-such-project')))?.command, 'echo hi')
  })
})

describe('.claude.json readers (#8974)', () => {
  const account = JSON.stringify({ oauthAccount: { emailAddress: 'x@example.com' } })

  it('auth probe reads <CLAUDE_CONFIG_DIR>/.claude.json', () => {
    process.env.CLAUDE_CONFIG_DIR = override
    writeFileSync(join(override, '.claude.json'), account)
    assert.equal(hasClaudeOAuthCreds(), true)
  })

  it('auth probe does not inherit the default account when the override has none', () => {
    process.env.CLAUDE_CONFIG_DIR = override
    writeFileSync(join(fakeHome, '.claude.json'), account)
    assert.equal(hasClaudeOAuthCreds(), false)
  })

  it('auth probe reads $HOME/.claude.json when the override is unset', () => {
    writeFileSync(join(fakeHome, '.claude.json'), account)
    assert.equal(hasClaudeOAuthCreds(), true)
  })

  it('BYOK MCP config path follows the override, and CHROXY_CLAUDE_CONFIG still wins', () => {
    process.env.CLAUDE_CONFIG_DIR = override
    assert.equal(defaultClaudeConfigPath(), join(override, '.claude.json'))
    process.env.CHROXY_CLAUDE_CONFIG = join(root, 'explicit.json')
    assert.equal(defaultClaudeConfigPath(), join(root, 'explicit.json'))
  })

  it('BYOK MCP config path is $HOME/.claude.json when the override is unset', () => {
    assert.equal(defaultClaudeConfigPath(), join(fakeHome, '.claude.json'))
  })
})

describe('workspace trust pre-write (#8974)', () => {
  let project
  beforeEach(() => {
    project = join(root, 'project')
    mkdirSync(project)
  })

  it('writes trust into <override>/.claude.json from the env the child runs with, merging', () => {
    const target = join(override, '.claude.json')
    writeFileSync(target, JSON.stringify({ numStartups: 3, projects: { '/other': { hasTrustDialogAccepted: true } } }))
    ensureCwdTrusted(project, { CLAUDE_CONFIG_DIR: override })
    const written = JSON.parse(readFileSync(target, 'utf8'))
    assert.equal(written.numStartups, 3)
    assert.deepEqual(written.projects['/other'], { hasTrustDialogAccepted: true })
    assert.equal(written.projects[realpathSync(project)].hasTrustDialogAccepted, true)
    assert.ok(!existsSync(join(fakeHome, '.claude.json')), 'home config untouched')
  })

  it('writes to $HOME/.claude.json when the env carries no override', () => {
    ensureCwdTrusted(project, {})
    const written = JSON.parse(readFileSync(join(fakeHome, '.claude.json'), 'utf8'))
    assert.equal(written.projects[realpathSync(project)].hasTrustDialogAccepted, true)
  })

  it('falls back to $HOME/.claude.json for an unusable override', () => {
    ensureCwdTrusted(project, { CLAUDE_CONFIG_DIR: 'relative/profile' })
    assert.ok(existsSync(join(fakeHome, '.claude.json')))
  })
})
