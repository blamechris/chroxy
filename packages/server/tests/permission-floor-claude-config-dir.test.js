import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync, statSync, chmodSync } from 'node:fs'
import path, { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PermissionManager } from '../src/permission-manager.js'
import { evaluateHookFloorRequest } from '../src/ws-permissions.js'
import { pathPiecesUnder, configRootVerdict } from '../src/permission-floor.js'
import { SessionManager, SessionDirectoryError } from '../src/session-manager.js'
import { validateCwdAllowed, claudeConfigDirCwdDenial } from '../src/handler-utils.js'
import { SYMLINK_SUPPORTED, SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

/**
 * The configured Claude config directory (CLAUDE_CONFIG_DIR) is treated like
 * `.claude` by the permission floor and by the session-cwd check, whatever it
 * is named. Everything lives in temp dirs; HOME is a temp dir too.
 */

const silentLog = { info() {}, warn() {} }

let sandbox
let home
let project
let savedEnv

before(() => {
  sandbox = realpathSync(mkdtempSync(join(tmpdir(), 'cfgdir-floor-')))
  home = join(sandbox, 'home')
  project = join(home, 'work', 'project')
  mkdirSync(project, { recursive: true })
})
after(() => rmSync(sandbox, { recursive: true, force: true }))

beforeEach(() => {
  savedEnv = { CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR, HOME: process.env.HOME }
  delete process.env.CLAUDE_CONFIG_DIR
  process.env.HOME = home
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
  return realpathSync(dir)
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
    process.env.CLAUDE_CONFIG_DIR = realpathSync(root)
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
    process.env.CLAUDE_CONFIG_DIR = realpathSync(root)
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
    process.env.CLAUDE_CONFIG_DIR = realpathSync(root)
    const cwd = realpathSync(workspace)
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
  const mk = (extra = {}) => new SessionManager({ stateFilePath: join(sandbox, `state-${Math.random().toString(36).slice(2)}.json`), providerType: 'claude-sdk', ...extra })

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
    const saved = { id: 'a'.repeat(32), name: 'Parked', cwd: root, provider: 'claude-sdk', history: [] }
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
    const root = join(realpathSync(sandbox), 'not-created-yet')
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
