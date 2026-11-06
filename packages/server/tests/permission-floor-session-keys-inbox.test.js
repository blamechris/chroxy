import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PermissionManager } from '../src/permission-manager.js'
import { evaluateHookFloorRequest } from '../src/ws-permissions.js'
import { isFlooredTarget } from '../src/permission-floor.js'
import { SYMLINK_SUPPORTED, SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

/**
 * Reads of the key files in `<claude config dir>/sessions/` and of anything
 * under `/tmp/cc-socks` (or `/private/tmp/cc-socks`) need a decision in every
 * lenient mode, on both pipelines. Only path strings and temp fixtures are
 * used: the real config dir and the real socket directory are never read.
 */

const silentLog = { info() {}, warn() {} }
const READ_TOOLS = ['Read', 'Grep', 'Glob']

let sandbox
let home
let project
let savedEnv

before(() => {
  sandbox = realpathSync.native(mkdtempSync(join(tmpdir(), 'floor-keys-inbox-')))
  home = join(sandbox, 'home')
  project = join(home, 'work', 'project')
  mkdirSync(project, { recursive: true })
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true })
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

async function inProcessPrompts(tool, input, mode, cwd) {
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
const hookFloors = (tool, input, cwd) => evaluateHookFloorRequest({ tool_name: tool, tool_input: input }, cwd).floor

// The same verdict through the in-process manager (both lenient modes) and the
// function behind the hook's floor probe.
async function assertBoth(tool, input, expected, label, cwd = project) {
  for (const mode of ['auto', 'acceptEdits']) {
    assert.equal(await inProcessPrompts(tool, input, mode, cwd), expected, `${label}: ${tool} in-process ${mode}`)
  }
  assert.equal(hookFloors(tool, input, cwd), expected, `${label}: ${tool} hook`)
}

async function assertAllReadTools(target, expected, label, cwd) {
  for (const tool of READ_TOOLS) {
    await assertBoth(tool, tool === 'Read' ? { file_path: target } : { path: target }, expected, label, cwd)
  }
}

describe('session key files', () => {
  it('floors a direct path under the default config dir', async () => {
    await assertAllReadTools(join(home, '.claude', 'sessions', 'a1.key'), true, 'direct')
  })

  it('floors a relative path', async () => {
    await assertAllReadTools('../../.claude/sessions/a1.key', true, 'relative from project')
    await assertAllReadTools('sessions/a1.key', true, 'relative from config dir', join(home, '.claude'))
    await assertAllReadTools('a1.key', true, 'relative from sessions dir', join(home, '.claude', 'sessions'))
  })

  it('floors a path reached through a symlink', { skip: SYMLINK_SUPPORTED ? false : SKIP_NO_SYMLINK }, async () => {
    const link = join(project, 'keys-link')
    symlinkSync(join(home, '.claude', 'sessions'), link)
    await assertAllReadTools(join(link, 'a1.key'), true, 'via symlinked dir')
    await assertAllReadTools('keys-link/a1.key', true, 'relative via symlinked dir')
    await assertBoth('Grep', { path: link }, true, 'search via symlinked dir')
  })

  it('floors a search rooted at the sessions directory', async () => {
    const dir = join(home, '.claude', 'sessions')
    await assertBoth('Grep', { path: dir }, true, 'grep dir')
    await assertBoth('Grep', { path: dir, glob: '*.key' }, true, 'grep dir glob')
    await assertBoth('Glob', { path: dir, pattern: '*.key' }, true, 'glob dir')
    await assertBoth('Grep', { path: join(home, '.claude', 'sessions', '..', 'sessions') }, true, 'grep dir via ..')
  })

  it('holds under a CLAUDE_CONFIG_DIR override', async () => {
    const root = join(sandbox, 'claude-data')
    mkdirSync(join(root, 'sessions'), { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = realpathSync.native(root)
    const dir = join(realpathSync.native(root), 'sessions')
    await assertAllReadTools(join(dir, 'a1.key'), true, 'override direct')
    await assertAllReadTools('sessions/a1.key', true, 'override relative', realpathSync.native(root))
    await assertBoth('Grep', { path: dir }, true, 'override grep dir')
    await assertBoth('Glob', { path: dir, pattern: '*' }, true, 'override glob dir')
  })

  it('holds under an override reached through a symlink', { skip: SYMLINK_SUPPORTED ? false : SKIP_NO_SYMLINK }, async () => {
    const root = join(sandbox, 'claude-data-real')
    mkdirSync(join(root, 'sessions'), { recursive: true })
    const alias = join(sandbox, 'claude-data-alias')
    symlinkSync(root, alias)
    process.env.CLAUDE_CONFIG_DIR = alias
    await assertBoth('Read', { file_path: join(alias, 'sessions', 'a1.key') }, true, 'alias path')
    await assertBoth('Grep', { path: join(root, 'sessions') }, true, 'real sessions dir')
    await assertBoth('Grep', { path: join(alias, 'sessions') }, true, 'alias sessions dir')
  })

  it('leaves ordinary reads under the config dir alone', async () => {
    const cfg = join(home, '.claude')
    await assertBoth('Read', { file_path: join(cfg, 'sessions', '123.json') }, false, 'session json')
    await assertBoth('Read', { file_path: join(cfg, 'projects', 'p', 'x.jsonl') }, false, 'transcript')
    await assertBoth('Read', { file_path: join(cfg, 'CLAUDE.md') }, false, 'CLAUDE.md')
    await assertBoth('Grep', { path: join(cfg, 'projects') }, false, 'grep projects')
    await assertBoth('Grep', { path: join(cfg, 'sessions-old') }, false, 'sibling prefix')
    await assertBoth('Grep', { path: cfg, glob: '*.md' }, false, 'grep config dir')
  })

  it('does not treat a sessions directory elsewhere as the config one', async () => {
    mkdirSync(join(project, 'sessions'), { recursive: true })
    await assertBoth('Grep', { path: join(project, 'sessions') }, false, 'project sessions dir')
    await assertBoth('Glob', { path: join(project, 'sessions'), pattern: '*.json' }, false, 'project sessions glob')
    await assertBoth('Read', { file_path: join(project, 'sessions', 'a.json') }, false, 'project sessions file')
  })

  it('keeps other .key files as they were (floored by the extension rule)', async () => {
    await assertBoth('Read', { file_path: join(project, 'deploy', 'server.key') }, true, 'project .key')
    await assertBoth('Read', { file_path: join(project, 'notes.keys') }, false, 'near-miss extension')
  })

  it('follows the override: the default sessions dir is not special once it is moved', async () => {
    const root = join(sandbox, 'claude-moved')
    mkdirSync(root, { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = realpathSync.native(root)
    await assertBoth('Grep', { path: join(home, '.claude', 'sessions') }, false, 'old default dir')
  })
})

describe('inbox socket directory', () => {
  const SPELLINGS = ['/tmp/cc-socks', '/private/tmp/cc-socks']

  it('floors a direct path under either spelling, and the directory itself', async () => {
    for (const base of SPELLINGS) {
      await assertAllReadTools(`${base}/a1.sock`, true, `direct ${base}`)
      await assertAllReadTools(`${base}/nested/deeper/a1`, true, `nested ${base}`)
      await assertAllReadTools(base, true, `dir ${base}`)
    }
  })

  it('floors a differently cased spelling', async () => {
    await assertAllReadTools('/TMP/Cc-Socks/a1.sock', true, 'cased')
    await assertAllReadTools('/Private/Tmp/CC-SOCKS/a1.sock', true, 'cased private')
  })

  it('floors a relative path', async () => {
    await assertAllReadTools('cc-socks/a1.sock', true, 'relative from /tmp', '/tmp')
    await assertAllReadTools('cc-socks/a1.sock', true, 'relative from /private/tmp', '/private/tmp')
    await assertAllReadTools('a1.sock', true, 'relative from the dir', '/tmp/cc-socks')
    await assertAllReadTools('../'.repeat(40) + 'tmp/cc-socks/a1.sock', true, 'relative with ..')
    await assertAllReadTools('../cc-socks/a1.sock', true, 'sibling traversal', '/tmp/other')
  })

  it('floors a path reached through a symlink', { skip: SYMLINK_SUPPORTED ? false : SKIP_NO_SYMLINK }, async () => {
    for (const [name, dest] of [['inbox-a', '/tmp/cc-socks/inbox'], ['inbox-b', '/private/tmp/cc-socks/inbox']]) {
      const link = join(project, name)
      symlinkSync(dest, link)
      await assertAllReadTools(join(link, 'a1.sock'), true, `via ${name}`)
      await assertAllReadTools(name, true, `relative ${name}`)
    }
    const dirLink = join(project, 'inbox-dir')
    symlinkSync('/tmp/cc-socks', dirLink)
    await assertAllReadTools(join(dirLink, 'a1.sock'), true, 'via link to the directory')
  })

  it('does not floor unrelated /tmp paths', async () => {
    for (const target of [
      '/tmp/a1.sock', '/tmp/other/a1.sock', '/tmp/cc-socks-other/a1.sock', '/tmp/xcc-socks/a1.sock',
      '/private/tmp/other/a1.sock', '/tmpx/cc-socks/a1.sock', '/var/tmp/cc-socks/a1.sock',
      '/tmp/other/cc-socks/a1.sock', join(project, 'cc-socks', 'a1.sock'),
    ]) {
      await assertAllReadTools(target, false, `control ${target}`)
    }
    await assertAllReadTools('cc-socks/a1.sock', false, 'relative from project')
    await assertAllReadTools('a1.sock', false, 'relative from /tmp/other', '/tmp/other')
  })

  it('does not floor a symlink that leads somewhere else', { skip: SYMLINK_SUPPORTED ? false : SKIP_NO_SYMLINK }, async () => {
    const link = join(project, 'plain-link')
    symlinkSync('/tmp/other-dir/inbox', link)
    await assertAllReadTools(join(link, 'a1.sock'), false, 'control link')
  })
})

describe('the shared predicate', () => {
  it('answers the same way as the pipelines for the new paths', () => {
    const cfgKey = join(home, '.claude', 'sessions', 'a1.key')
    assert.equal(isFlooredTarget('Read', { file_path: cfgKey }, project), true)
    assert.equal(isFlooredTarget('Read', { file_path: '/tmp/cc-socks/s' }, project), true)
    assert.equal(isFlooredTarget('Read', { file_path: '/tmp/other/s' }, project), false)
  })
})
