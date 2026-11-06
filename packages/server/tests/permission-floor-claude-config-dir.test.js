import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import path, { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PermissionManager } from '../src/permission-manager.js'
import { evaluateHookFloorRequest } from '../src/ws-permissions.js'
import { pathPiecesUnder } from '../src/permission-floor.js'
import { validateCwdAllowed } from '../src/handler-utils.js'
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
async function inProcessPrompts(tool, input, mode) {
  const pm = new PermissionManager({ log: silentLog, cwd: project })
  const events = []
  pm.on('permission_request', (d) => events.push(d))
  const p = pm.handlePermission(tool, input, null, mode)
  const prompted = events.length === 1
  if (prompted) pm.respondToPermission(events[0].requestId, 'deny')
  await p
  pm.destroy()
  return prompted
}
const hookFloors = (tool, input) => evaluateHookFloorRequest({ tool_name: tool, tool_input: input }, project).floor

async function assertBoth(tool, input, expected, label) {
  for (const mode of ['auto', 'acceptEdits']) {
    assert.equal(await inProcessPrompts(tool, input, mode), expected, `${label} in-process ${mode}`)
  }
  assert.equal(hookFloors(tool, input), expected, `${label} hook`)
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
