import { describe, it, before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, symlinkSync, rmSync, realpathSync, readFileSync, writeFileSync, chmodSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import { PermissionManager } from '../src/permission-manager.js'
import { evaluateHookFloorRequest } from '../src/ws-permissions.js'
import { isFlooredTarget, SEARCH_ROOT_TOOLS, floorInternalsForTest } from '../src/permission-floor.js'
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

describe('a search with no path starts from the session cwd', () => {
  const SEARCHES = [['Grep', { pattern: '.' }], ['Glob', { pattern: '*' }]]

  it('floors when the cwd is an inbox socket directory', async () => {
    for (const cwd of ['/tmp/cc-socks', '/private/tmp/cc-socks', '/tmp/cc-socks/nested']) {
      for (const [tool, input] of SEARCHES) await assertBoth(tool, input, true, `cwd ${cwd}`, cwd)
    }
  })

  it('floors when the cwd is the sessions directory', async () => {
    const dir = join(home, '.claude', 'sessions')
    for (const [tool, input] of SEARCHES) await assertBoth(tool, input, true, 'default sessions cwd', dir)
    const root = join(sandbox, 'claude-data-cwd')
    mkdirSync(join(root, 'sessions'), { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = realpathSync.native(root)
    for (const [tool, input] of SEARCHES) await assertBoth(tool, input, true, 'override sessions cwd', join(realpathSync.native(root), 'sessions'))
  })

  it('leaves a search from an ordinary cwd alone', async () => {
    for (const cwd of [project, '/tmp', '/tmp/other', '/tmp/cc-socks-other']) {
      for (const [tool, input] of SEARCHES) await assertBoth(tool, input, false, `ordinary cwd ${cwd}`, cwd)
    }
  })

  it('does not floor a pathless Glob from the config dir (names only)', async () => {
    await assertBoth('Glob', { pattern: '*' }, false, 'glob from config dir', join(home, '.claude'))
  })
})

describe('protected roots that are links, or not created yet', () => {
  it('recognises the physical sessions directory when sessions is a link', { skip: SYMLINK_SUPPORTED ? false : SKIP_NO_SYMLINK }, async () => {
    const root = join(sandbox, 'claude-linked')
    const physical = join(sandbox, 'physical-sessions')
    mkdirSync(root, { recursive: true })
    mkdirSync(physical, { recursive: true })
    symlinkSync(physical, join(root, 'sessions'))
    process.env.CLAUDE_CONFIG_DIR = realpathSync.native(root)
    await assertBoth('Grep', { path: physical }, true, 'physical path')
    await assertBoth('Glob', { path: physical, pattern: '*' }, true, 'physical path glob')
    await assertBoth('Grep', { pattern: '.' }, true, 'cwd is the physical path', physical)
    const alias = join(sandbox, 'second-alias')
    symlinkSync(physical, alias)
    await assertBoth('Grep', { path: alias }, true, 'another alias')
    await assertBoth('Grep', { path: join(sandbox, 'physical-other') }, false, 'control')
  })

  it('recognises the default config dir when it is a link', { skip: SYMLINK_SUPPORTED ? false : SKIP_NO_SYMLINK }, async () => {
    const realHome = join(sandbox, 'home-linked')
    const physical = join(sandbox, 'physical-claude')
    mkdirSync(join(physical, 'sessions'), { recursive: true })
    mkdirSync(realHome, { recursive: true })
    symlinkSync(physical, join(realHome, '.claude'))
    process.env.HOME = realHome
    process.env.USERPROFILE = realHome
    await assertBoth('Grep', { path: join(physical, 'sessions') }, true, 'physical sessions')
    await assertBoth('Grep', { path: join(realHome, '.claude', 'sessions') }, true, 'link spelling')
    await assertBoth('Grep', { path: physical }, true, 'physical config dir')
  })

  it('resolves an inbox directory that is a link, and one that does not exist', { skip: SYMLINK_SUPPORTED ? false : SKIP_NO_SYMLINK }, () => {
    const hits = (target, dirs) => floorInternalsForTest.hitsInboxSocketDir(target, dirs)
    const elsewhere = join(sandbox, 'elsewhere-socks')
    mkdirSync(elsewhere, { recursive: true })
    const parent = join(sandbox, 'fake-tmp')
    mkdirSync(parent, { recursive: true })
    const link = join(parent, 'cc-socks')
    symlinkSync(elsewhere, link)
    assert.equal(hits(join(elsewhere, 'a1.sock'), [link]), true, 'physical path of a linked root')
    assert.equal(hits(join(sandbox, 'elsewhere-other', 'a1.sock'), [link]), false, 'control')
    const missing = join(sandbox, 'not-yet', 'cc-socks')
    assert.equal(hits(join(missing, 'a1.sock'), [missing]), true, 'a root not created yet names itself')
    assert.equal(hits(join(sandbox, 'not-yet', 'other', 'a1.sock'), [missing]), false, 'and floors nothing else')
    assert.equal(hits(join(sandbox, 'unrelated', 'a1.sock'), [missing]), false, 'control')
  })

  it('does not floor everything when the config dir does not exist yet', async () => {
    process.env.CLAUDE_CONFIG_DIR = join(sandbox, 'not-created-yet')
    await assertBoth('Grep', { path: project }, false, 'project search')
    await assertBoth('Grep', { pattern: '.' }, false, 'pathless search')
    await assertBoth('Read', { file_path: join(project, 'a.txt') }, false, 'project read')
    await assertBoth('Grep', { path: join(sandbox, 'not-created-yet', 'sessions') }, true, 'the missing sessions dir itself')
  })
})

describe('a Grep from the config dir or above', () => {
  it('floors from the config dir itself', async () => {
    const cfg = join(home, '.claude')
    await assertBoth('Grep', { path: cfg }, true, 'default config dir')
    await assertBoth('Grep', { pattern: '.' }, true, 'cwd is the config dir', cfg)
    await assertBoth('Grep', { path: cfg, glob: '*.md' }, false, 'narrowing glob')
    await assertBoth('Glob', { path: cfg, pattern: '*' }, false, 'glob names only')
    await assertBoth('Grep', { path: join(cfg, 'projects') }, false, 'sibling directory')
  })

  it('floors from $HOME and from any ancestor of the default config dir', async () => {
    await assertBoth('Grep', { path: home }, true, 'home search')
    await assertBoth('Grep', { pattern: '.' }, true, 'cwd is home', home)
    await assertBoth('Grep', { path: sandbox }, true, 'directory above home')
    await assertBoth('Grep', { path: home, glob: '*.js' }, false, 'fixed other extension')
    await assertBoth('Glob', { path: home, pattern: '**/*' }, false, 'glob names only')
    await assertBoth('Grep', { path: project }, false, 'project search')
  })

  it('is only switched off by a glob that cannot select a .key file', async () => {
    const cfg = join(home, '.claude')
    for (const glob of ['*.js', 'src/**/*.{js,ts}', '*.md, *.txt', '*.JS']) {
      await assertBoth('Grep', { path: cfg, glob }, false, `glob ${glob}`)
      await assertBoth('Grep', { path: home, glob }, false, `glob ${glob} from home`)
    }
    for (const glob of ['sessions/123*', '*', '**', '**/*.key', 'sessions/**', '*.{js,key}', '{sessions/1*,*.js}',
      '*.js sessions/12*', '*.js,sessions/12*', '!*.key', '*.k*', '*.?ey', 'sessions/', '[a]*.js', '*.KEY', '*.js\\', '']) {
      await assertBoth('Grep', { path: cfg, glob }, true, `glob ${JSON.stringify(glob)}`)
      await assertBoth('Grep', { path: home, glob }, true, `glob ${JSON.stringify(glob)} from home`)
    }
  })

  it('classifies globs the same way directly', () => {
    const avoids = (g) => floorInternalsForTest.globAvoidsKeyFiles(g)
    assert.equal(avoids('*.js'), true)
    assert.equal(avoids('sessions/123*'), false)
    assert.equal(avoids('!*.js'), false)
    assert.equal(avoids(undefined), false)
    assert.equal(avoids(5), false)
  })

  it('floors from a directory above a non-hidden override, but not from elsewhere', async () => {
    const root = join(sandbox, 'claude-visible')
    mkdirSync(join(root, 'sessions'), { recursive: true })
    process.env.CLAUDE_CONFIG_DIR = realpathSync.native(root)
    await assertBoth('Grep', { path: root }, true, 'override dir')
    await assertBoth('Grep', { path: sandbox }, true, 'ancestor')
    await assertBoth('Grep', { pattern: '.' }, true, 'cwd is an ancestor', sandbox)
    await assertBoth('Grep', { path: sandbox, glob: '*.md' }, false, 'narrowing glob')
    await assertBoth('Glob', { path: sandbox, pattern: '**/*' }, false, 'glob names only')
    await assertBoth('Grep', { path: project }, false, 'project does not contain the config dir')
    await assertBoth('Grep', { path: join(sandbox, 'claude-visible-other') }, false, 'sibling prefix')
  })

  it('follows a link to the config dir', { skip: SYMLINK_SUPPORTED ? false : SKIP_NO_SYMLINK }, async () => {
    const link = join(project, 'cfg-link')
    symlinkSync(join(home, '.claude'), link)
    await assertBoth('Grep', { path: link }, true, 'linked config dir')
  })
})

describe('the hook pre-filter', () => {
  it('probes every tool the search-root rule covers (drift fails this)', () => {
    const hook = readFileSync(new URL('../hooks/permission-hook.sh', import.meta.url), 'utf8')
    for (const tool of SEARCH_ROOT_TOOLS) {
      assert.ok(hook.includes(`*'"${tool}"'*`), `permission-hook.sh must match "${tool}"`)
    }
  })
})

describe('a root at a shallow resolved path', () => {
  it('matches a root that resolves to a single component', () => {
    const v = (target) => floorInternalsForTest.protectedRootVerdicts(target, {
      configDirFn: () => '/cfg', inboxDirs: ['/tmp/cc-socks'], resolveRootFn: (p) => (p === '/tmp/cc-socks' ? '/sockets' : p),
    })
    assert.equal(v('/sockets').inbox, true, 'the root itself')
    assert.equal(v('/sockets/a1.sock').inbox, true, 'below it')
    assert.equal(v('/other').inbox, false, 'control')
    assert.equal(v('/').inbox, false, 'the filesystem root')
  })
})

describe('a config dir that cannot be resolved does not floor ordinary access', () => {
  const posix = process.platform !== 'win32'
  const root = posix && process.getuid?.() !== 0

  async function assertOrdinaryUnaffected(label) {
    await assertBoth('Read', { file_path: join(project, 'src', 'a.js') }, false, `${label}: read`)
    await assertBoth('Edit', { file_path: join(project, 'src', 'a.js') }, false, `${label}: edit`)
    await assertBoth('Grep', { path: project }, false, `${label}: grep`)
    await assertBoth('Grep', { pattern: '.' }, false, `${label}: pathless grep`)
    await assertBoth('Glob', { path: project, pattern: '*' }, false, `${label}: glob`)
    await assertBoth('Glob', { pattern: '*' }, false, `${label}: pathless glob`)
  }

  it('.claude is a regular file', async () => {
    const fileHome = join(sandbox, 'home-file')
    mkdirSync(fileHome, { recursive: true })
    writeFileSync(join(fileHome, '.claude'), 'x')
    process.env.HOME = fileHome
    process.env.USERPROFILE = fileHome
    await assertOrdinaryUnaffected('file')
    await assertBoth('Grep', { path: join(fileHome, '.claude', 'sessions') }, true, 'the sessions path under it still floors')
  })

  it('CLAUDE_CONFIG_DIR is a regular file', async () => {
    const file = join(sandbox, 'cfg-is-a-file')
    writeFileSync(file, 'x')
    process.env.CLAUDE_CONFIG_DIR = file
    await assertOrdinaryUnaffected('override file')
    await assertBoth('Grep', { path: join(file, 'sessions') }, true, 'the sessions path under it still floors')
  })

  it('.claude is unreadable (mode 000)', { skip: root ? false : 'needs a non-root POSIX user' }, async () => {
    const lockedHome = join(sandbox, 'home-locked')
    mkdirSync(join(lockedHome, '.claude', 'sessions'), { recursive: true })
    chmodSync(join(lockedHome, '.claude'), 0o000)
    process.env.HOME = lockedHome
    process.env.USERPROFILE = lockedHome
    try {
      await assertOrdinaryUnaffected('locked')
      await assertBoth('Grep', { path: join(lockedHome, '.claude', 'sessions') }, true, 'the sessions path under it floors')
    } finally {
      chmodSync(join(lockedHome, '.claude'), 0o700)
    }
  })

  it('a sessions root that fails to resolve floors only at or under its written path', () => {
    const fail = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
    const v = (target, extra = {}) => floorInternalsForTest.protectedRootVerdicts(target, {
      configDirFn: () => '/cfg', inboxDirs: ['/tmp/cc-socks'], resolveRootFn: (p) => (p === '/cfg/sessions' ? fail() : p), ...extra,
    })
    assert.equal(v('/cfg/sessions').sessionsDir, true, 'the directory')
    assert.equal(v('/cfg/sessions/123.json').sessionsDir, true, 'a file inside it')
    assert.equal(v('/cfg').reaches, true, 'a search reaching it')
    assert.equal(v('/cfg/projects/x').sessionsDir, false, 'control: elsewhere in the config dir')
    assert.equal(v('/work/project/a.js').sessionsDir, false, 'control: an ordinary target')
    assert.equal(v('/work/project').reaches, false, 'control: an ordinary search')
    assert.equal(v('/tmp/cc-socks/a').inbox, true, 'the inbox root is unaffected')
    assert.equal(v('/work/project/a.js').inbox, false, 'and floors nothing else')
  })

  it('an inbox root that fails to resolve does not affect the sessions rule', () => {
    const fail = () => { throw Object.assign(new Error('denied'), { code: 'EACCES' }) }
    const v = (target) => floorInternalsForTest.protectedRootVerdicts(target, {
      configDirFn: () => '/cfg', inboxDirs: ['/tmp/cc-socks'], resolveRootFn: (p) => (p === '/tmp/cc-socks' ? fail() : p),
    })
    assert.equal(v('/cfg/sessions').sessionsDir, true)
    assert.equal(v('/cfg/sessions/123.json').sessionsDir, false, 'a file there is judged by its name')
    assert.equal(v('/tmp/cc-socks/a').inbox, true, 'the failed inbox root still floors at or under its written path')
    assert.equal(v('/work/project/a.js').inbox, false)
  })

  it('a path under a non-directory resolves like a missing one', () => {
    const v = (target) => floorInternalsForTest.protectedRootVerdicts(target, {
      configDirFn: () => join(sandbox, 'cfg-is-a-file', 'nested'), inboxDirs: [],
    })
    assert.equal(v(join(sandbox, 'cfg-is-a-file', 'nested', 'sessions')).sessionsDir, true)
    assert.equal(v(join(sandbox, 'cfg-is-a-file', 'nested', 'sessions', 'x')).sessionsDir, false, 'resolved, not failed')
  })
})
