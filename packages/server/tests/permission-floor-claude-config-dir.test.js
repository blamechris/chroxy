import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync, statSync, chmodSync } from 'node:fs'
import path, { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PermissionManager } from '../src/permission-manager.js'
import { evaluateHookFloorRequest } from '../src/ws-permissions.js'
import { pathPiecesUnder, configRootVerdict, floorInternalsForTest } from '../src/permission-floor.js'
import { SessionManager, SessionDirectoryError } from '../src/session-manager.js'
import { validateCwdAllowed, claudeConfigDirCwdDenial } from '../src/handler-utils.js'
import { SYMLINK_SUPPORTED, SKIP_NO_SYMLINK } from './helpers/symlink-support.js'
import { EventEmitter } from 'node:events'
import { registerProvider } from '../src/providers.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'

/**
 * The configured Claude config directory (CLAUDE_CONFIG_DIR) is treated like
 * `.claude` by the permission floor and by the session-cwd check, whatever it
 * is named. Everything lives in temp dirs; HOME is a temp dir too.
 */

const silentLog = { info() {}, warn() {} }

class FloorFakeSession extends EventEmitter {
  constructor(opts = {}) { super(); this.cwd = opts.cwd }
  start() {}
  destroy() {}
  sendMessage() {}
  interrupt() {}
  setModel() { return false }
  setPermissionMode() { return false }
}
declareUnknownCustomization(FloorFakeSession)
registerProvider('test-floor-fake-9027', FloorFakeSession)

let sandbox
let home
let project
let savedEnv

before(() => {
  sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'cfgdir-floor-')))
  home = join(sandbox, 'home')
  project = join(home, 'work', 'project')
  mkdirSync(project, { recursive: true })
})
after(() => rmSync(sandbox, { recursive: true, force: true }))

beforeEach(() => {
  savedEnv = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE }
  delete process.env.CLAUDE_CONFIG_DIR
  process.env.HOME = home
  process.env.USERPROFILE = home
})
afterEach(() => {
  for (const [k, v] of Object.entries(savedEnv)) {
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
})

function mkRoot(name) {
  const dir = join(sandbox, name)
  mkdirSync(dir, { recursive: true })
  return realpathSync.native(dir)
}

// The same verdict through both pipelines: the in-process manager and the
// function behind the hook's floor probe.
async function inProcessPrompts(tool, input, mode, cwd = project) {
  const pm = new PermissionManager({ log: silentLog, cwd })
  const events = []
  pm.on('permission_request', (d) => events.push(d))
  const p = pm.handlePermission(tool, input, null, mode)
  const prompted = events.length === 1
  if (prompted) pm.respondToPermission(events[0].requestId, 'deny')
  await p
  pm.destroy()
  return prompted
}
const hookFloors = (tool, input, cwd = project) => evaluateHookFloorRequest({ tool_name: tool, tool_input: input }, cwd).floor

async function assertBoth(tool, input, expected, label, cwd = project) {
  for (const mode of ['auto', 'acceptEdits']) {
    assert.equal(await inProcessPrompts(tool, input, mode, cwd), expected, `${label} in-process ${mode}`)
  }
  assert.equal(hookFloors(tool, input, cwd), expected, `${label} hook`)
}

describe('an override named differently from .claude', () => {
  it('floors settings and credentials files on every path tool, both pipelines', async () => {
    const root = mkRoot('claude-data')
    process.env.CLAUDE_CONFIG_DIR = root
    for (const file of ['settings.json', 'settings.local.json', '.credentials.json']) {
      const target = join(root, file)
      for (const [tool, input] of [
        ['Read', { file_path: target }],
        ['Write', { file_path: target }],
        ['Edit', { file_path: target }],
        ['Glob', { path: target }],
        ['Grep', { path: target }],
      ]) {
        await assertBoth(tool, input, true, `${tool} ${file}`)
      }
    }
  })

  it('floors writes anywhere inside it, but leaves reads of other files alone', async () => {
    const root = mkRoot('claude-data')
    process.env.CLAUDE_CONFIG_DIR = root
    await assertBoth('Write', { file_path: join(root, 'commands', 'x.md') }, true, 'write inside')
    await assertBoth('Read', { file_path: join(root, 'commands', 'x.md') }, false, 'read inside')
  })

  it('does not floor look-alike paths outside it', async () => {
    const root = mkRoot('claude-data')
    process.env.CLAUDE_CONFIG_DIR = root
    await assertBoth('Read', { file_path: join(sandbox, 'claude-data-other', 'settings.json') }, false, 'sibling prefix')
    await assertBoth('Write', { file_path: join(project, 'src', 'index.js') }, false, 'project file')
  })

  it('floors a Grep glob that selects settings files when the search reaches it', () => {
    const root = mkRoot('claude-data')
    process.env.CLAUDE_CONFIG_DIR = root
    assert.equal(hookFloors('Grep', { path: sandbox, glob: 'claude-data/settings.json' }), true)
    assert.equal(hookFloors('Grep', { path: root, glob: '/settings.local.json' }), true)
    assert.equal(hookFloors('Grep', { path: root, glob: '*.ts' }), false)
    // control: a search elsewhere keeps the ordinary behaviour
    mkdirSync(join(project, 'src'), { recursive: true })
    assert.equal(hookFloors('Grep', { path: join(project, 'src'), glob: 'claude-data/settings.json' }), false)
  })

  it('follows a symlinked spelling of it', { skip: SYMLINK_SUPPORTED ? false : SKIP_NO_SYMLINK }, async () => {
    const root = mkRoot('claude-data')
    const alias = join(sandbox, 'alias-link')
    symlinkSync(root, alias)
    process.env.CLAUDE_CONFIG_DIR = alias
    await assertBoth('Read', { file_path: join(root, 'settings.json') }, true, 'real path')
    await assertBoth('Read', { file_path: join(alias, 'settings.json') }, true, 'link path')
  })

  it('ignores a relative override: the default location still applies', async () => {
    process.env.CLAUDE_CONFIG_DIR = 'claude-data'
    await assertBoth('Read', { file_path: join(project, 'claude-data', 'settings.json') }, false, 'relative')
    await assertBoth('Read', { file_path: join(home, '.claude', 'settings.json') }, true, 'default')
  })

  it('ignores the filesystem root: the default location still applies', async () => {
    process.env.CLAUDE_CONFIG_DIR = path.parse(sandbox).root
    await assertBoth('Read', { file_path: join(sandbox, 'elsewhere', 'settings.json') }, false, 'root override')
    await assertBoth('Read', { file_path: join(home, '.claude', 'settings.json') }, true, 'default')
  })

  it('an override equal to HOME floors only settings and credentials files, not the whole home', async () => {
    process.env.CLAUDE_CONFIG_DIR = home
    await assertBoth('Read', { file_path: join(home, 'settings.json') }, true, 'home settings')
    await assertBoth('Read', { file_path: join(home, '.credentials.json') }, true, 'home credentials')
    await assertBoth('Write', { file_path: join(home, 'settings.json') }, true, 'home settings write')
    await assertBoth('Write', { file_path: join(project, 'src', 'index.js') }, false, 'project write')
    await assertBoth('Write', { file_path: join(home, 'notes.txt') }, false, 'home file write')
  })
})

describe('the default .claude location is unchanged', () => {
  it('floors .claude as before and nothing else', async () => {
    await assertBoth('Read', { file_path: join(home, '.claude', 'settings.json') }, true, 'default settings')
    await assertBoth('Write', { file_path: join(home, '.claude', 'skills', 'a.md') }, true, 'default write')
    await assertBoth('Read', { file_path: join(home, '.claude', 'skills', 'a.md') }, false, 'default read')
    await assertBoth('Read', { file_path: join(home, 'other', 'settings.json') }, false, 'other settings')
  })

  it('an override named .claude elsewhere behaves like the default', async () => {
    const root = mkRoot('data/.claude')
    process.env.CLAUDE_CONFIG_DIR = root
    await assertBoth('Read', { file_path: join(root, 'settings.json') }, true, 'settings')
    await assertBoth('Read', { file_path: join(root, '.credentials.json') }, true, 'credentials')
    await assertBoth('Read', { file_path: join(root, 'skills', 'a.md') }, false, 'other read')
  })
})

describe('session cwd', () => {
  it('refuses a cwd inside the override and accepts an ordinary one', () => {
    const root = mkRoot('claude-data')
    mkdirSync(join(root, 'nested'), { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = root
    const cfg = { homeOverride: home }
    assert.match(validateCwdAllowed(root, cfg) ?? '', /Claude config directory/)
    assert.match(validateCwdAllowed(join(root, 'nested'), cfg) ?? '', /Claude config directory/)
    assert.equal(validateCwdAllowed(project, cfg), null)
  })

  it('refuses a symlinked spelling of the override', { skip: SYMLINK_SUPPORTED ? false : SKIP_NO_SYMLINK }, () => {
    const root = mkRoot('claude-data')
    const alias = join(project, 'via-link')
    symlinkSync(root, alias)
    process.env.CLAUDE_CONFIG_DIR = root
    assert.match(validateCwdAllowed(alias, { homeOverride: home }) ?? '', /Claude config directory/)
  })

  it('does not refuse every directory when the override is HOME', () => {
    process.env.CLAUDE_CONFIG_DIR = home
    assert.equal(validateCwdAllowed(project, { homeOverride: home }), null)
  })

  it('keeps refusing the default ~/.claude', () => {
    mkdirSync(join(home, '.claude'), { recursive: true })
    assert.match(validateCwdAllowed(join(home, '.claude'), { homeOverride: home }) ?? '', /credential\/config directories/)
  })
})

describe('Windows spelling of the config directory', () => {
  const w = path.win32
  it('matches case-insensitively and by drive', () => {
    assert.deepEqual(pathPiecesUnder('C:\\Data\\Claude', 'c:\\data\\CLAUDE\\Settings.json', w), ['settings.json'])
    assert.deepEqual(pathPiecesUnder('C:\\Data\\Claude', 'C:\\Data\\Claude', w), [])
    assert.equal(pathPiecesUnder('C:\\Data\\Claude', 'D:\\Data\\Claude\\settings.json', w), null)
    assert.equal(pathPiecesUnder('C:\\Data\\Claude', 'C:\\Data\\Claude2\\settings.json', w), null)
  })
})

describe('where the override sits relative to HOME', () => {
  it('an override strictly inside HOME is dedicated: writes inside it are floored', async () => {
    const root = join(home, 'claude-data')
    mkdirSync(join(root, 'commands'), { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = realpathSync.native(root)
    await assertBoth('Write', { file_path: join(root, 'commands', 'x.md') }, true, 'inside HOME write')
    await assertBoth('Read', { file_path: join(root, 'settings.json') }, true, 'inside HOME settings')
    await assertBoth('Read', { file_path: join(root, 'commands', 'x.md') }, false, 'inside HOME read')
    await assertBoth('Write', { file_path: join(project, 'src', 'index.js') }, false, 'project write')
  })

  it('an override equal to HOME is broad: not floored wholesale', async () => {
    process.env.CLAUDE_CONFIG_DIR = home
    await assertBoth('Write', { file_path: join(home, 'notes.txt') }, false, 'equal: other file')
    await assertBoth('Write', { file_path: join(home, 'settings.json') }, true, 'equal: settings')
  })

  it('an override that is an ancestor of HOME is broad: not floored wholesale', async () => {
    process.env.CLAUDE_CONFIG_DIR = sandbox
    await assertBoth('Write', { file_path: join(project, 'src', 'index.js') }, false, 'ancestor: project write')
    await assertBoth('Write', { file_path: join(home, 'notes.txt') }, false, 'ancestor: home file')
    await assertBoth('Write', { file_path: join(sandbox, 'settings.json') }, true, 'ancestor: settings')
    await assertBoth('Read', { file_path: join(sandbox, '.credentials.json') }, true, 'ancestor: credentials')
  })

  it('floors a relative target that resolves into the override', async () => {
    const root = join(home, 'claude-data')
    mkdirSync(root, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = realpathSync.native(root)
    await assertBoth('Read', { file_path: '../../claude-data/settings.json' }, true, 'relative settings')
    await assertBoth('Write', { file_path: '../../claude-data/commands/x.md' }, true, 'relative write')
    await assertBoth('Write', { file_path: '../../other/x.md' }, false, 'relative elsewhere')
  })
})

describe('Grep without a glob', () => {
  it('floors a recursive search from the root and from above it, both pipelines', async () => {
    const root = mkRoot('claude-data')
    process.env.CLAUDE_CONFIG_DIR = root
    await assertBoth('Grep', { path: root, pattern: '.' }, true, 'from the root')
    await assertBoth('Grep', { path: sandbox, pattern: '.' }, true, 'from above')
    await assertBoth('Grep', { path: root, pattern: '.', glob: '!*.log' }, true, 'exclusion-only glob')
  })

  it('leaves searches that cannot reach it alone', async () => {
    const root = mkRoot('claude-data')
    mkdirSync(join(root, 'commands'), { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = root
    mkdirSync(join(project, 'src'), { recursive: true })
    await assertBoth('Grep', { path: join(project, 'src'), pattern: '.' }, false, 'elsewhere')
    await assertBoth('Grep', { path: join(root, 'commands'), pattern: '.' }, false, 'below the root')
    await assertBoth('Grep', { path: root, pattern: '.', glob: '*.ts' }, false, 'narrowed glob')
  })

  it('an override equal to HOME is floored only for a search from HOME or above, not from a project', async () => {
    process.env.CLAUDE_CONFIG_DIR = home
    mkdirSync(join(project, 'src'), { recursive: true })
    await assertBoth('Grep', { path: home, pattern: '.' }, true, 'from HOME')
    await assertBoth('Grep', { path: join(project, 'src'), pattern: '.' }, false, 'from a project')
  })
})

describe('names the filesystem treats as the same directory', () => {
  function aliasOrSkip(t, root, alias) {
    try {
      const a = statSync(root, { bigint: true })
      const b = statSync(alias, { bigint: true })
      if (a.ino !== b.ino || a.dev !== b.dev) return false
    } catch { return false }
    return true
  }

  it('recognises a long-s spelling of a path component', async (t) => {
    const root = mkRoot('serverdata')
    const alias = join(sandbox, '\u017Ferverdata')
    if (!aliasOrSkip(t, root, alias)) return t.skip('this filesystem does not fold the long s')
    process.env.CLAUDE_CONFIG_DIR = root
    await assertBoth('Read', { file_path: join(alias, 'settings.json') }, true, 'long s read')
    await assertBoth('Write', { file_path: join(alias, 'commands', 'x.md') }, true, 'long s write')
    await assertBoth('Grep', { path: alias, pattern: '.' }, true, 'long s search from the root')
    mkdirSync(join(root, 'sub'), { recursive: true })
    await assertBoth('Grep', { path: join(sandbox, '\u017Ferverdata', 'sub'), pattern: '.' }, false, 'long s search below the root')
  })

  it('recognises a differently normalised spelling', async (t) => {
    const nfc = 'caf\u00e9data'
    const root = mkRoot(nfc)
    const alias = join(sandbox, nfc.normalize('NFD'))
    if (!aliasOrSkip(t, root, alias)) return t.skip('this filesystem does not fold normalisation forms')
    process.env.CLAUDE_CONFIG_DIR = root
    await assertBoth('Read', { file_path: join(alias, 'settings.json') }, true, 'NFD read')
    await assertBoth('Write', { file_path: join(alias, 'commands', 'x.md') }, true, 'NFD write')
  })

  it('recognises a differently cased spelling', async (t) => {
    const root = mkRoot('ClaudeData')
    const alias = join(sandbox, 'claudedata')
    if (!aliasOrSkip(t, root, alias)) return t.skip('this filesystem is case-sensitive')
    process.env.CLAUDE_CONFIG_DIR = root
    await assertBoth('Write', { file_path: join(alias, 'commands', 'x.md') }, true, 'case write')
  })
})

describe('inside a Claude Code worktree of the session workspace', () => {
  it('still floors a configured override that sits under the workspace worktree directory', async () => {
    const workspace = join(sandbox, 'wsproj')
    const root = join(workspace, '.claude', 'worktrees', 'demo', 'claude-data')
    mkdirSync(root, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = realpathSync.native(root)
    const cwd = realpathSync.native(workspace)
    await assertBoth('Read', { file_path: join(root, 'settings.json') }, true, 'worktree settings', cwd)
    await assertBoth('Write', { file_path: join(root, 'commands', 'x.md') }, true, 'worktree write', cwd)
    await assertBoth('Write', { file_path: join(workspace, '.claude', 'worktrees', 'demo', 'src', 'a.js') }, false, 'worktree ordinary file', cwd)
  })
})

describe('Windows spelling through the verdict', () => {
  const w = path.win32
  const call = { names: new Map(), canonical: { left: 65536 } }
  const verdict = (root, target, broad, secretsOnly) => {
    const inside = pathPiecesUnder(root, target, w)
    return inside !== null && configRootVerdict(inside, broad, secretsOnly, call)
  }
  it('dedicated root: whole tree under the full floor, settings under both', () => {
    assert.equal(verdict('C:\\Data\\Claude', 'c:\\data\\claude\\Commands\\x.md', false, false), true)
    assert.equal(verdict('C:\\Data\\Claude', 'C:\\Data\\Claude\\Commands\\x.md', false, true), false)
    assert.equal(verdict('C:\\Data\\Claude', 'C:\\DATA\\claude\\Settings.Local.json', false, true), true)
    assert.equal(verdict('C:\\Data\\Claude', 'C:\\Data\\Claude\\SETTIN~1.JSO', false, true), true)
    assert.equal(verdict('C:\\Data\\Claude', 'D:\\Data\\Claude\\settings.json', false, false), false)
  })
  it('broad root: only settings directly inside', () => {
    assert.equal(verdict('C:\\Users', 'C:\\Users\\me\\notes.txt', true, false), false)
    assert.equal(verdict('C:\\Users', 'C:\\Users\\settings.json', true, false), true)
    assert.equal(verdict('C:\\Users', 'C:\\Users\\me\\settings.json', true, false), false)
  })
})

describe('session creation boundary', () => {
  let sm
  afterEach(() => { try { sm?.destroy?.() } catch { /* ignore */ } })
  const mk = (extra = {}) => new SessionManager({ stateFilePath: join(sandbox, `state-${Math.random().toString(36).slice(2)}.json`), providerType: 'test-floor-fake-9027', ...extra })

  it('refuses an explicit cwd inside the override', () => {
    const root = mkRoot('claude-data')
    process.env.CLAUDE_CONFIG_DIR = root
    sm = mk()
    assert.throws(() => sm._resolveCreateSessionPlan({ cwd: root }), SessionDirectoryError)
    assert.throws(() => sm._resolveCreateSessionPlan({ cwd: root }), /Claude config directory/)
  })

  it('refuses an omitted cwd when the default is the override', () => {
    const root = mkRoot('claude-data')
    process.env.CLAUDE_CONFIG_DIR = root
    sm = mk({ defaultCwd: root })
    assert.throws(() => sm._resolveCreateSessionPlan({}), SessionDirectoryError)
  })

  it('refuses a restored session whose cwd is now the override', () => {
    const root = mkRoot('claude-data')
    process.env.CLAUDE_CONFIG_DIR = root
    sm = mk()
    const saved = { id: 'a'.repeat(32), name: 'Parked', cwd: root, provider: 'test-floor-fake-9027', history: [] }
    assert.throws(() => sm._attemptRestoreOne(saved, false), SessionDirectoryError)
  })

  it('accepts an ordinary cwd, and any cwd when the override is HOME', () => {
    const root = mkRoot('claude-data')
    process.env.CLAUDE_CONFIG_DIR = root
    assert.equal(claudeConfigDirCwdDenial(project), null)
    process.env.CLAUDE_CONFIG_DIR = home
    assert.equal(claudeConfigDirCwdDenial(project), null)
  })
})

describe('an override directory that does not exist yet', () => {
  it('is still recognised by its spelling', async () => {
    const root = join(realpathSync.native(sandbox), 'not-created-yet')
    process.env.CLAUDE_CONFIG_DIR = root
    await assertBoth('Read', { file_path: join(root, 'settings.json') }, true, 'settings')
    await assertBoth('Write', { file_path: join(root, 'commands', 'x.md') }, true, 'write')
    await assertBoth('Grep', { path: sandbox, pattern: '.' }, true, 'search from above')
    await assertBoth('Grep', { path: join(sandbox, 'home'), pattern: '.' }, false, 'search elsewhere')
  })
})

describe('a location that cannot be checked', () => {
  it('floors a target below an unreadable directory', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, async () => {
    const root = mkRoot('claude-data')
    process.env.CLAUDE_CONFIG_DIR = root
    const locked = join(sandbox, 'locked')
    mkdirSync(join(locked, 'inner'), { recursive: true })
    const target = join(locked, 'inner', 'f.txt')
    await assertBoth('Write', { file_path: target }, false, 'readable control')
    chmodSync(locked, 0o000)
    try {
      await assertBoth('Write', { file_path: target }, true, 'unreadable')
    } finally {
      chmodSync(locked, 0o755)
    }
  })
})

describe('an override directory that is not created yet, reached through an aliased ancestor', () => {
  function aliasPair() {
    const parent = mkRoot('serverparent')
    const alias = join(sandbox, 'ſerverparent')
    try {
      const a = statSync(parent, { bigint: true })
      const b = statSync(alias, { bigint: true })
      if (a.ino !== b.ino || a.dev !== b.dev) return null
    } catch { return null }
    return { parent, alias }
  }

  it('floors through the alias with one missing directory', async (t) => {
    const pair = aliasPair()
    if (!pair) return t.skip('this filesystem does not fold the long s')
    process.env.CLAUDE_CONFIG_DIR = join(pair.parent, 'absent-root')
    await assertBoth('Read', { file_path: join(pair.alias, 'absent-root', 'settings.json') }, true, 'alias settings')
    await assertBoth('Write', { file_path: join(pair.alias, 'absent-root', 'commands', 'x.md') }, true, 'alias write')
    await assertBoth('Grep', { path: pair.alias, pattern: '.' }, true, 'alias search from above')
    await assertBoth('Write', { file_path: join(pair.alias, 'other-name', 'x.md') }, false, 'alias sibling')
  })

  it('floors through the alias with several missing directories', async (t) => {
    const pair = aliasPair()
    if (!pair) return t.skip('this filesystem does not fold the long s')
    process.env.CLAUDE_CONFIG_DIR = join(pair.parent, 'a', 'b', 'c')
    await assertBoth('Read', { file_path: join(pair.alias, 'a', 'b', 'c', 'settings.json') }, true, 'deep settings')
    await assertBoth('Write', { file_path: join(pair.alias, 'a', 'b', 'c', 'x.md') }, true, 'deep write')
    await assertBoth('Grep', { path: join(pair.alias, 'a'), pattern: '.' }, true, 'search from a missing ancestor')
    await assertBoth('Write', { file_path: join(pair.alias, 'a', 'b', 'd', 'x.md') }, false, 'diverging sibling')
  })
})

describe('the identity lookups are bounded and fail closed', () => {
  const eacces = () => Object.assign(new Error('denied'), { code: 'EACCES' })

  it('a lookup that errors floors a Read-path target', () => {
    const root = mkRoot('claude-data')
    process.env.CLAUDE_CONFIG_DIR = root
    const target = join(project, 'trigger-dir', 'f.txt')
    const stat = (p, o) => { if (p.includes('trigger-dir')) throw eacces(); return statSync(p, o) }
    assert.equal(floorInternalsForTest.hitsConfigRoot(target, false, stat), true)
    // positive control: the same target with working lookups is not a hit
    assert.equal(floorInternalsForTest.hitsConfigRoot(target, false, undefined), false)
  })

  it('a lookup that errors counts a Grep search as reaching the root', () => {
    const root = mkRoot('claude-data')
    process.env.CLAUDE_CONFIG_DIR = root
    mkdirSync(join(project, 'trigger-dir'), { recursive: true })
    const stat = (p, o) => { if (p.includes('trigger-dir')) throw eacces(); return statSync(p, o) }
    const input = { path: join(project, 'trigger-dir'), pattern: '.' }
    assert.deepEqual(floorInternalsForTest.searchReach(input, project, stat), { near: true, covers: true })
    assert.deepEqual(floorInternalsForTest.searchReach(input, project, undefined), { near: false, covers: false })
  })

  it('a spent budget floors', () => {
    const root = mkRoot('claude-data')
    process.env.CLAUDE_CONFIG_DIR = root
    const target = join(project, 'src', 'a.js')
    assert.equal(floorInternalsForTest.hitsConfigRoot(target, false, undefined, 2), true)
    assert.equal(floorInternalsForTest.hitsConfigRoot(target, false, undefined, 10_000), false)
  })

  it('many deep targets cost few lookups and stay fast', () => {
    const root = mkRoot('claude-data')
    process.env.CLAUDE_CONFIG_DIR = root
    let calls = 0
    const stat = (p, o) => { calls++; return statSync(p, o) }
    const deep = Array.from({ length: 240 }, (_, i) => `m${i}`)
    const started = Date.now()
    const targets = Array.from({ length: 64 }, (_, k) => join(project, ...deep, `f${k}.txt`))
    floorInternalsForTest.hitsConfigRoot(targets, false, stat, 16384)
    assert.ok(calls < 64, `lookups are shared across the call and stop at the first missing directory; got ${calls}`)
    assert.ok(Date.now() - started < 2000, 'stays fast')
    assert.equal(hookFloors('Read', { file_path: join(project, ...deep, 'f.txt') }), false, 'an ordinary deep read is not floored')
  })
})

describe('a creation path that cannot be checked', () => {
  it('is refused rather than assumed fine', { skip: process.platform === 'win32' || process.getuid?.() === 0 }, () => {
    const root = mkRoot('claude-data')
    process.env.CLAUDE_CONFIG_DIR = root
    const locked = join(sandbox, 'locked-cwd')
    mkdirSync(locked, { recursive: true })
    assert.equal(claudeConfigDirCwdDenial(join(locked, 'wt')), null, 'positive control: a creatable path is fine')
    chmodSync(locked, 0o000)
    try {
      assert.match(claudeConfigDirCwdDenial(join(locked, 'wt')) ?? '', /Claude config directory/)
    } finally {
      chmodSync(locked, 0o755)
    }
  })
})

describe('session creation with a worktree', () => {
  let sm
  afterEach(() => { try { sm?.destroy?.() } catch { /* ignore */ } })
  const mk = () => new SessionManager({ stateFilePath: join(sandbox, `state-${Math.random().toString(36).slice(2)}.json`), providerType: 'test-floor-fake-9027' })

  it('refuses a worktree whose directory is inside the override, before creating it', () => {
    const root = mkRoot('claude-data')
    process.env.CLAUDE_CONFIG_DIR = root
    sm = mk()
    const created = []
    sm._addDetachedWorktree = (repo, dir) => { created.push(dir) }
    sm._worktreeBase = join(root, 'wt')
    assert.throws(() => sm._resolveCreateSessionPlan({ cwd: project, worktree: true }), SessionDirectoryError)
    assert.deepEqual(created, [])
    // positive control: a base outside the override creates it
    sm._worktreeBase = join(sandbox, 'wt-ok')
    const plan = sm._resolveCreateSessionPlan({ cwd: project, worktree: true })
    assert.equal(created.length, 1)
    assert.ok(plan.resolvedCwd.startsWith(join(sandbox, 'wt-ok')))
  })

  it('refuses a missing restored worktree inside the override, before recreating it', () => {
    const root = mkRoot('claude-data')
    process.env.CLAUDE_CONFIG_DIR = root
    sm = mk()
    const id = 'b'.repeat(32)
    const recreated = []
    sm._recreateMissingWorktree = (dir) => { recreated.push(dir) }
    const args = (base) => ({ cwd: join(base, id), restoreWorktreePath: join(base, id), restoreWorktreeRepoDir: project, preserveId: id, isRestore: true })
    sm._worktreeBase = join(root, 'wt')
    assert.throws(() => sm._resolveCreateSessionPlan(args(join(root, 'wt'))), SessionDirectoryError)
    assert.deepEqual(recreated, [])
    // positive control: outside the override it is recreated
    sm._worktreeBase = join(sandbox, 'wt-ok2')
    sm._resolveCreateSessionPlan(args(join(sandbox, 'wt-ok2')))
    assert.equal(recreated.length, 1)
  })
})

describe('a missing tail compared the way the filesystem would', () => {
  const nfc = (n) => n.normalize('NFC')
  const nfd = (n) => n.normalize('NFD')

  it('matches a differently normalised spelling of a missing root', async () => {
    const parent = mkRoot('tailparent')
    process.env.CLAUDE_CONFIG_DIR = join(parent, nfc('caf\u00e9-cfg'))
    await assertBoth('Read', { file_path: join(parent, nfd('caf\u00e9-cfg'), 'settings.json') }, true, 'NFD settings')
    await assertBoth('Write', { file_path: join(parent, nfd('caf\u00e9-cfg'), 'x.md') }, true, 'NFD write')
    await assertBoth('Write', { file_path: join(parent, nfd('caf\u00e9-other'), 'x.md') }, false, 'other name')
  })

  it('matches a differently cased spelling of a missing root', async () => {
    const parent = mkRoot('tailparent')
    process.env.CLAUDE_CONFIG_DIR = join(parent, 'caf\u00e9-cfg')
    await assertBoth('Write', { file_path: join(parent, 'CAF\u00c9-CFG', 'x.md') }, true, 'upper-case write')
  })

  it('matches a search from a differently normalised missing intermediate directory', async () => {
    const parent = mkRoot('tailparent')
    process.env.CLAUDE_CONFIG_DIR = join(parent, nfc('\u00fcn\u00ef'), 'cfg')
    await assertBoth('Grep', { path: join(parent, nfd('\u00fcn\u00ef')), pattern: '.' }, true, 'NFD intermediate')
    await assertBoth('Grep', { path: join(parent, nfd('\u00fcn\u00ef-x')), pattern: '.' }, false, 'other intermediate')
  })

  it('ignores trailing dots and spaces, as Windows does, through the win32 spelling', () => {
    const w = path.win32
    const rest = pathPiecesUnder('C:\\x', 'C:\\x\\cfg.\\settings.json', w)
    assert.deepEqual(rest, ['cfg.', 'settings.json'])
    assert.equal(floorInternalsForTest.sameName(rest[0], 'cfg'), true)
    assert.equal(floorInternalsForTest.sameName('cfg ', 'cfg'), true)
    assert.equal(floorInternalsForTest.sameName('cfg2', 'cfg'), false)
  })
})

describe('the cwd check on a root that does not exist yet', () => {
  it('refuses a worktree base inside it, in any spelling', () => {
    const parent = mkRoot('tailparent')
    process.env.CLAUDE_CONFIG_DIR = join(parent, 'caf\u00e9-cfg'.normalize('NFC'))
    assert.match(claudeConfigDirCwdDenial(join(parent, 'caf\u00e9-cfg', 'wt', 'id')) ?? '', /Claude config directory/)
    assert.match(claudeConfigDirCwdDenial(join(parent, 'caf\u00e9-cfg'.normalize('NFD'), 'wt', 'id')) ?? '', /Claude config directory/)
    assert.match(claudeConfigDirCwdDenial(join(parent, 'CAF\u00c9-CFG', 'wt', 'id')) ?? '', /Claude config directory/)
    assert.equal(claudeConfigDirCwdDenial(join(parent, 'caf\u00e9-other', 'wt', 'id')), null)
  })

  it('refuses a worktree created at a base inside it, before creating anything', () => {
    const parent = mkRoot('tailparent')
    const root = join(parent, 'not-yet-created')
    process.env.CLAUDE_CONFIG_DIR = root
    const sm = new SessionManager({ stateFilePath: join(sandbox, 'state-missing-root.json'), providerType: 'test-floor-fake-9027' })
    try {
      const created = []
      sm._addDetachedWorktree = (repo, dir) => { created.push(dir) }
      sm._worktreeBase = join(root, 'wt')
      assert.throws(() => sm._resolveCreateSessionPlan({ cwd: project, worktree: true }), SessionDirectoryError)
      assert.deepEqual(created, [])
    } finally {
      sm.destroy?.()
    }
  })
})

describe('budgets and failures in the identity lookups', () => {
  it('a large patch below the walk threshold is not floored by the identity budget', async () => {
    const root = mkRoot('claude-data')
    process.env.CLAUDE_CONFIG_DIR = root
    const rel = (k) => join(`p${k}`, 'a', 'b', 'c', 'd', 'e', 'f', 'g.txt')
    for (let k = 0; k < 1000; k++) mkdirSync(join(project, `p${k}`, 'a', 'b', 'c', 'd', 'e', 'f'), { recursive: true })
    const input = { file_path: 'a.txt', changes: Array.from({ length: 1000 }, (_, k) => ({ path: rel(k), kind: 'update', diff: '' })) }
    assert.equal(hookFloors('apply_patch', input), false)
    assert.equal(await inProcessPrompts('apply_patch', input, 'auto'), false)
    delete process.env.CLAUDE_CONFIG_DIR
    assert.equal(hookFloors('apply_patch', input), false, 'control: the same patch without an override')
  })

  it('a resolver that throws floors rather than escaping', () => {
    const target = join(project, 'src', 'a.js')
    const boom = () => { throw new Error('no home') }
    assert.equal(floorInternalsForTest.hitsConfigRoot(target, false, undefined, undefined, boom), true)
    assert.equal(floorInternalsForTest.hitsConfigRoot(target, false, undefined, undefined, undefined), false)
  })
})
