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
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, realpathSync, rmSync, writeFileSync, existsSync, symlinkSync, lstatSync } from 'node:fs'
import { tmpdir, homedir, userInfo } from 'node:os'
import { join } from 'node:path'
import '../src/claude-tui-session.js' // fixes the session<->driver import cycle order
import { claudeGlobalConfigPath, claudeConfigDir, claudeHomeDir, sanitizeClaudeConfigDirEnv } from '../src/utils/claude-config-dir.js'
import { createPermissionHookManager, countUserLevelChroxyHooks } from '../src/permission-hook.js'
import { StatusLineManager } from '../src/statusline.js'
import { hasClaudeOAuthCreds, resetCachesForTest } from '../src/auth-probes.js'
import { defaultClaudeConfigPath } from '../src/byok-mcp-config.js'
import { ensureCwdTrusted } from '../src/claude-tui/pty-driver.js'
import { buildSpawnEnv, buildClaudeLaunchEnv } from '../src/utils/spawn-env.js'
import { checkStrandedDefaultHook } from '../src/doctor.js'

const ENV_KEYS = ['HOME', 'USERPROFILE', 'CLAUDE_CONFIG_DIR', 'CHROXY_CLAUDE_HOME', 'CHROXY_CLAUDE_CONFIG', 'CHROXY_CLAUDE_KEYCHAIN', 'CHROXY_CONFIG_DIR']

let root
const withHome = (home, extra = {}) => ({ HOME: home, USERPROFILE: home, ...extra })
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
  // os.homedir() reads USERPROFILE on win32 and HOME elsewhere: fake both.
  process.env.HOME = fakeHome
  process.env.USERPROFILE = fakeHome
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
    assert.equal(claudeGlobalConfigPath(withHome(fakeHome)), join(fakeHome, '.claude.json'))
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
      assert.equal(claudeGlobalConfigPath(withHome(fakeHome, { CLAUDE_CONFIG_DIR: bad })), join(fakeHome, '.claude.json'), JSON.stringify(bad))
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
    ensureCwdTrusted(project, withHome(fakeHome))
    const written = JSON.parse(readFileSync(join(fakeHome, '.claude.json'), 'utf8'))
    assert.equal(written.projects[realpathSync(project)].hasTrustDialogAccepted, true)
  })

  it('falls back to $HOME/.claude.json for an unusable override', () => {
    ensureCwdTrusted(project, withHome(fakeHome, { CLAUDE_CONFIG_DIR: 'relative/profile' }))
    assert.ok(existsSync(join(fakeHome, '.claude.json')))
  })
})

describe('round 1 (#8974)', () => {
  const hookScript = '/opt/chroxy/hooks/permission-hook.sh'
  const chroxyEntries = (file) => (JSON.parse(readFileSync(file, 'utf-8')).hooks?.PreToolUse ?? []).filter((e) => e._chroxy === true).length

  it('uses the CHILD env home, not the daemon home, for the default locations', () => {
    const childHome = join(root, 'child-home')
    mkdirSync(childHome)
    assert.equal(claudeGlobalConfigPath({ HOME: childHome, USERPROFILE: childHome }), join(childHome, '.claude.json'))
    assert.equal(claudeConfigDir({ HOME: childHome, USERPROFILE: childHome }), join(childHome, '.claude'))
    // an override the resolver rejects still falls back to the CHILD home
    assert.equal(claudeGlobalConfigPath({ HOME: childHome, USERPROFILE: childHome, CLAUDE_CONFIG_DIR: 'rel' }), join(childHome, '.claude.json'))
    // no HOME in the env -> the account's passwd home, which a HOME-less child resolves too
    assert.equal(claudeGlobalConfigPath({}), join(userInfo().homedir, '.claude.json'))
  })

  it('on POSIX HOME wins over USERPROFILE', { skip: process.platform === 'win32' }, () => {
    const a = join(root, 'a')
    const b = join(root, 'b')
    assert.equal(claudeGlobalConfigPath({ HOME: a, USERPROFILE: b }), join(a, '.claude.json'))
  })

  it('trust pre-write lands in the child home file when the child HOME differs', () => {
    const childHome = join(root, 'child-home')
    mkdirSync(childHome)
    const project = join(root, 'project')
    mkdirSync(project)
    ensureCwdTrusted(project, { HOME: childHome, USERPROFILE: childHome })
    assert.ok(existsSync(join(childHome, '.claude.json')))
    assert.ok(!existsSync(join(fakeHome, '.claude.json')))
  })

  it('trust pre-write creates a fresh override dir (owner-only) instead of failing', () => {
    const fresh = join(root, 'not', 'yet', 'profile')
    const project = join(root, 'project')
    mkdirSync(project)
    ensureCwdTrusted(project, { CLAUDE_CONFIG_DIR: fresh })
    const written = JSON.parse(readFileSync(join(fresh, '.claude.json'), 'utf8'))
    assert.equal(written.projects[realpathSync(project)].hasTrustDialogAccepted, true)
    assert.equal(lstatSync(fresh).mode & 0o077, 0)
  })

  it('selects the same active global file as claude: non-empty legacy .config.json wins', () => {
    writeFileSync(join(override, '.claude.json'), '{}')
    assert.equal(claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: override }), join(override, '.claude.json'))
    writeFileSync(join(override, '.config.json'), '')
    assert.equal(claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: override }), join(override, '.claude.json'), 'empty writable legacy file is ignored when the modern file exists')
    writeFileSync(join(override, '.config.json'), '{"a":1}')
    assert.equal(claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: override }), join(override, '.config.json'))
    // default location: legacy lives in ~/.claude, current file in $HOME
    mkdirSync(join(fakeHome, '.claude'))
    writeFileSync(join(fakeHome, '.claude', '.config.json'), '{"a":1}')
    assert.equal(claudeGlobalConfigPath(withHome(fakeHome)), join(fakeHome, '.claude', '.config.json'))
  })

  it('trust pre-write targets the active (legacy) file and does not create the other', () => {
    writeFileSync(join(override, '.config.json'), JSON.stringify({ projects: {} }))
    const project = join(root, 'project')
    mkdirSync(project)
    ensureCwdTrusted(project, { CLAUDE_CONFIG_DIR: override })
    assert.equal(JSON.parse(readFileSync(join(override, '.config.json'), 'utf8')).projects[realpathSync(project)].hasTrustDialogAccepted, true)
    assert.ok(!existsSync(join(override, '.claude.json')))
  })

  it('hook registration writes THROUGH a symlinked settings.json and keeps the link', async () => {
    process.env.CLAUDE_CONFIG_DIR = override
    const real = join(root, 'dotfiles-settings.json')
    writeFileSync(real, JSON.stringify({ theme: 'dark' }))
    symlinkSync(real, join(override, 'settings.json'))
    const manager = createPermissionHookManager(new EventEmitter(), { hookScript })
    await manager.register()
    assert.ok(lstatSync(join(override, 'settings.json')).isSymbolicLink(), 'link survived')
    assert.equal(JSON.parse(readFileSync(real, 'utf-8')).theme, 'dark')
    assert.equal(chroxyEntries(real), 1)
    await manager.destroy()
    assert.ok(lstatSync(join(override, 'settings.json')).isSymbolicLink())
  })

  it('hook registration uses a random sidecar, not a fixed settings.json.tmp, and leaves none behind', async () => {
    process.env.CLAUDE_CONFIG_DIR = override
    writeFileSync(join(override, 'settings.json.tmp'), 'other process')
    const manager = createPermissionHookManager(new EventEmitter(), { hookScript })
    await manager.register()
    assert.equal(readFileSync(join(override, 'settings.json.tmp'), 'utf8'), 'other process')
    assert.deepEqual(readdirSync(override).filter((f) => f.endsWith('.tmp') && f !== 'settings.json.tmp'), [])
    await manager.destroy()
  })

  it('cleanup targets the file registration pinned, even after the env changes', async () => {
    const other = join(root, 'other-profile')
    mkdirSync(other)
    process.env.CLAUDE_CONFIG_DIR = override
    const manager = createPermissionHookManager(new EventEmitter(), { hookScript })
    await manager.register()
    process.env.CLAUDE_CONFIG_DIR = other
    writeFileSync(join(other, 'settings.json'), JSON.stringify({ hooks: { PreToolUse: [{ _chroxy: true, hooks: [] }] } }))
    await manager.destroy()
    assert.equal(chroxyEntries(join(override, 'settings.json')), 0, 'pinned file cleaned')
    assert.equal(chroxyEntries(join(other, 'settings.json')), 1, 'other profile untouched')
  })

  it('doctor reports a stranded hook in the default settings only when an override is active', async () => {
    const stranded = join(root, 'default-settings.json')
    writeFileSync(stranded, JSON.stringify({ hooks: { PreToolUse: [{ _chroxy: true, hooks: [] }] } }))
    const warn = checkStrandedDefaultHook({ activePath: join(override, 'settings.json'), defaultPath: stranded })
    assert.equal(warn?.status, 'warn')
    assert.ok(warn.message.includes(stranded))
    assert.equal(checkStrandedDefaultHook({ activePath: stranded, defaultPath: stranded }), null)
    assert.ok(readFileSync(stranded, 'utf8').includes('_chroxy'), 'report only, never removed')
  })
})

describe('round 2 (#8974)', () => {
  const hookScript = '/opt/chroxy/hooks/permission-hook.sh'
  const FLAGS = { hasTrustDialogAccepted: true, hasCompletedProjectOnboarding: true, projectOnboardingSeenCount: 0 }

  const accountHome = userInfo().homedir

  it('one home policy: rejected homes fall back to the account (passwd) home on the reader side', () => {
    for (const bad of ['relative-profile', '', 'a\0b']) {
      assert.equal(claudeHomeDir({ HOME: bad }, 'linux'), accountHome, JSON.stringify(bad))
    }
    assert.equal(claudeHomeDir({}, 'linux'), accountHome)
  })

  it('HOME=/ (a container or service user) is accepted by the reader and kept in the child env', () => {
    assert.equal(claudeHomeDir({ HOME: '/' }, 'linux'), '/')
    assert.equal(claudeGlobalConfigPath({ HOME: '/' }), '/.claude.json')
    const env = { HOME: '/' }
    sanitizeClaudeConfigDirEnv(env, 'linux')
    assert.equal(env.HOME, '/')
  })

  it('the child-env sanitiser removes exactly the rejected homes', () => {
    for (const bad of ['relative-profile', '', 'a\0b']) {
      const env = { HOME: bad, KEEP: '1' }
      sanitizeClaudeConfigDirEnv(env, 'linux')
      assert.ok(!Object.hasOwn(env, 'HOME'), JSON.stringify(bad))
      assert.equal(env.KEEP, '1')
    }
    const good = { HOME: fakeHome }
    sanitizeClaudeConfigDirEnv(good, 'linux')
    assert.equal(good.HOME, fakeHome)
  })

  it('a relative daemon HOME: the reader uses the passwd home and the child HOME is deleted', { skip: process.platform === 'win32' }, () => {
    process.env.HOME = 'relative-profile'
    assert.equal(claudeGlobalConfigPath(), join(accountHome, '.claude.json'))
    assert.ok(!Object.hasOwn(buildSpawnEnv('claude'), 'HOME'))
    assert.ok(!Object.hasOwn(buildClaudeLaunchEnv(), 'HOME'))
    assert.ok(!Object.hasOwn(buildSpawnEnv('claude', { HOME: 'also/relative' }), 'HOME'))
  })

  // Why the reader's fallback (the daemon's os.homedir()) equals what a child with
  // the rejected HOME removed resolves: with HOME unset, os.homedir() (libuv
  // uv_os_homedir) reads the passwd entry of the process uid, and the child runs
  // as the daemon's uid. A spawned-node check of this is not possible here: the
  // test harness's spawn-home sandbox (tests/_setup.mjs, #7269) injects its own
  // HOME into any child whose env lacks one.

  it('on win32 only USERPROFILE counts, falling back to os.homedir() (never HOME)', () => {
    assert.equal(claudeHomeDir({ USERPROFILE: root, HOME: fakeHome }, 'win32'), root)
    assert.equal(claudeHomeDir({ HOME: join(root, 'zzz') }, 'win32'), homedir())
  })

  describe('legacy .config.json selection mirrors claude', () => {
    const modern = () => join(override, '.claude.json')
    const legacy = () => join(override, '.config.json')
    const pick = () => claudeGlobalConfigPath({ CLAUDE_CONFIG_DIR: override })

    it('a non-empty directory named .config.json selects the modern file', () => {
      mkdirSync(legacy())
      writeFileSync(join(legacy(), 'x'), 'y')
      assert.equal(pick(), modern())
    })
    it('an empty writable regular legacy file with no modern file selects legacy', () => {
      writeFileSync(legacy(), '')
      assert.equal(pick(), legacy())
    })
    it('an empty writable legacy file with an existing modern file selects modern', () => {
      writeFileSync(legacy(), '')
      writeFileSync(modern(), '{}')
      assert.equal(pick(), modern())
    })
    it('an empty read-only legacy file with no modern file selects modern', { skip: process.platform === 'win32' }, () => {
      writeFileSync(legacy(), '')
      chmodSync(legacy(), 0o444)
      assert.equal(pick(), modern())
    })
    it('a non-empty legacy file selects legacy', () => {
      writeFileSync(legacy(), '{"a":1}')
      writeFileSync(modern(), '{}')
      assert.equal(pick(), legacy())
    })
  })

  describe('the trust pre-write sets all three flags in the selected file', () => {
    let project
    beforeEach(() => { project = join(root, 'project'); mkdirSync(project) })

    it('override .claude.json', () => {
      ensureCwdTrusted(project, { CLAUDE_CONFIG_DIR: override })
      const got = JSON.parse(readFileSync(join(override, '.claude.json'), 'utf8')).projects[realpathSync(project)]
      assert.deepEqual(got, FLAGS)
    })
    it('legacy .config.json', () => {
      writeFileSync(join(override, '.config.json'), JSON.stringify({ projects: {} }))
      ensureCwdTrusted(project, { CLAUDE_CONFIG_DIR: override })
      const got = JSON.parse(readFileSync(join(override, '.config.json'), 'utf8')).projects[realpathSync(project)]
      assert.deepEqual(got, FLAGS)
      assert.ok(!existsSync(join(override, '.claude.json')))
    })
    it('an empty writable legacy file (no modern file) receives all three flags', () => {
      writeFileSync(join(override, '.config.json'), '')
      ensureCwdTrusted(project, { CLAUDE_CONFIG_DIR: override })
      const got = JSON.parse(readFileSync(join(override, '.config.json'), 'utf8')).projects[realpathSync(project)]
      assert.deepEqual(got, FLAGS)
      assert.ok(!existsSync(join(override, '.claude.json')))
    })
    it('a whitespace-only file is treated as empty, but malformed non-empty JSON is never overwritten', () => {
      writeFileSync(join(override, '.config.json'), '  \n')
      ensureCwdTrusted(project, { CLAUDE_CONFIG_DIR: override })
      assert.equal(JSON.parse(readFileSync(join(override, '.config.json'), 'utf8')).projects[realpathSync(project)].hasTrustDialogAccepted, true)
      writeFileSync(join(override, '.config.json'), '{ not json')
      ensureCwdTrusted(project, { CLAUDE_CONFIG_DIR: override })
      assert.equal(readFileSync(join(override, '.config.json'), 'utf8'), '{ not json')
    })
  })

  it('cleanup acts on the registered target after the settings link is retargeted', async () => {
    process.env.CLAUDE_CONFIG_DIR = override
    const a = join(root, 'a-settings.json')
    const b = join(root, 'b-settings.json')
    writeFileSync(a, '{}')
    writeFileSync(b, JSON.stringify({ hooks: { PreToolUse: [{ _chroxy: true, hooks: [] }] } }))
    const link = join(override, 'settings.json')
    symlinkSync(a, link)
    const manager = createPermissionHookManager(new EventEmitter(), { hookScript })
    await manager.register()
    rmSync(link)
    symlinkSync(b, link)
    await manager.destroy()
    const count = (f) => (JSON.parse(readFileSync(f, 'utf-8')).hooks?.PreToolUse ?? []).filter((e) => e._chroxy === true).length
    assert.equal(count(a), 0, 'registered target cleaned')
    assert.equal(count(b), 1, 'new target untouched')
  })
})
