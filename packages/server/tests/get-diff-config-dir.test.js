import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, realpathSync, unlinkSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { createReaderOps } from '../src/ws-file-ops/reader.js'
import { resolveSessionCwd, validatePathWithinCwd } from '../src/ws-file-ops/common.js'
import { GIT, disableRepoAutoGc, rmDirRobust } from './test-helpers.js'

// Files directly in the daemon's config directory are daemon-managed state, so the diff
// view treats them the way the file viewer and generic writes do (see
// read-file-config-dir.test.js, write-file-config-dir.test.js): neither the preview of an
// untracked one nor the hunks of a tracked one reach the reply. They are OMITTED rather
// than listed by name: a name-only entry would still say which top-level names exist, and
// an out-of-project untracked file is omitted the same way today. Ordinary files, and
// files in subtrees such as <configDir>/worktrees/<id>, keep their content.
// Everything runs in a temp git repo with CHROXY_CONFIG_DIR relocated into it.

const MARKER = 'fixture-marker-5e2a'

describe('get_diff leaves files directly in the config directory out of the reply', () => {
  let root, repo, cfg, fileOps, savedEnv
  const out = []
  const send = (_ws, msg) => out.push(msg)
  const ws = {}

  const git = (...args) => execFileSync(GIT, args, { cwd: repo, stdio: 'pipe' })
  const put = (rel, text) => {
    const abs = join(repo, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, text)
  }

  async function diff(cwd = repo) {
    out.length = 0
    await fileOps.getDiff(ws, undefined, cwd)
    assert.equal(out.length, 1, 'exactly one diff_result reply')
    assert.equal(out[0].type, 'diff_result')
    assert.equal(out[0].error, null)
    return out[0]
  }
  const paths = (reply) => reply.files.map((f) => f.path)
  const body = (reply) => JSON.stringify(reply)

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-cfgdiff-')))
    repo = join(root, 'repo')
    cfg = join(repo, 'state', 'chroxy')
    mkdirSync(repo, { recursive: true })
    git('init')
    disableRepoAutoGc(repo)
    git('config', 'user.email', 'test@test.com')
    git('config', 'user.name', 'Test')
    put('file.txt', 'initial content\n')
    put('state/chroxy/tracked.json', 'tracked v1\n')
    put('state/chroxy/staged.json', 'staged v1\n')
    put('state/chroxy/gone.json', `${MARKER} gone\n`)
    put('state/chroxy/moving.json', Array.from({ length: 12 }, (_, i) => `${MARKER} line ${i}`).join('\n') + '\n')
    put('state/chroxy/worktrees/w1/tracked.js', 'export const a = 1\n')
    put('docs/readme.md', 'readme\n')
    git('add', '.')
    git('commit', '-m', 'initial')
    savedEnv = process.env.CHROXY_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = cfg
    fileOps = createFileOps(send)
  })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CHROXY_CONFIG_DIR
    else process.env.CHROXY_CONFIG_DIR = savedEnv
    rmDirRobust(root)
  })

  it('an UNTRACKED file directly in the config dir is omitted; an ordinary untracked file and a subtree one keep their preview', async () => {
    put('state/chroxy/untracked.json', `${MARKER} untracked\n`)
    put('notes.txt', 'ordinary note\n')
    put('state/chroxy/worktrees/w1/new.js', 'export const b = 2\n')
    const reply = await diff()
    assert.ok(!paths(reply).includes('state/chroxy/untracked.json'), 'config-dir file is not listed')
    assert.ok(!body(reply).includes(MARKER), 'config-dir file content is not in the reply')
    const notes = reply.files.find((f) => f.path === 'notes.txt')
    assert.ok(notes, 'CONTROL: an ordinary untracked file is still listed')
    assert.equal(notes.status, 'untracked')
    assert.equal(notes.hunks[0].lines[0].content, 'ordinary note')
    const sub = reply.files.find((f) => f.path === 'state/chroxy/worktrees/w1/new.js')
    assert.ok(sub, 'CONTROL: a file in a subtree of the config dir is still listed')
    assert.equal(sub.hunks[0].lines[0].content, 'export const b = 2')
  })

  it('a TRACKED file directly in the config dir that is then modified is omitted; an ordinary modified file keeps its hunks', async () => {
    put('state/chroxy/tracked.json', `tracked v2 ${MARKER}\n`)
    put('file.txt', 'modified content\n')
    const reply = await diff()
    assert.ok(!paths(reply).includes('state/chroxy/tracked.json'), 'config-dir file is not listed')
    assert.ok(!body(reply).includes(MARKER) && !body(reply).includes('tracked v'), 'neither side of the config-dir file is in the reply')
    const ordinary = reply.files.find((f) => f.path === 'file.txt')
    assert.ok(ordinary, 'CONTROL: an ordinary modified file is still listed')
    assert.ok(ordinary.hunks.length > 0)
    assert.ok(ordinary.hunks[0].lines.some((l) => l.content === 'modified content'))
  })

  it('a STAGED change to a file directly in the config dir is omitted too', async () => {
    put('state/chroxy/staged.json', `staged v2 ${MARKER}\n`)
    git('add', 'state/chroxy/staged.json')
    const reply = await diff()
    assert.deepEqual(paths(reply), [])
    assert.ok(!body(reply).includes(MARKER))
  })

  it('a DELETED tracked file directly in the config dir is omitted, so its removed lines do not appear', async () => {
    unlinkSync(join(cfg, 'gone.json'))
    const reply = await diff()
    assert.deepEqual(paths(reply), [])
    assert.ok(!body(reply).includes(MARKER))
  })

  it('a rename OUT of the config dir is omitted, and so is a rename INTO it', async () => {
    // Commit the file that will move INTO the config dir first, so the rename below is not committed with it.
    put('docs/incoming.json', Array.from({ length: 12 }, (_, i) => `${MARKER} incoming ${i}`).join('\n') + '\n')
    git('add', 'docs/incoming.json')
    git('commit', '-m', 'add incoming')
    // Edit each renamed file a little so git reports a rename WITH hunks (a pure rename has none).
    git('mv', 'state/chroxy/moving.json', 'docs/moved.json')
    put('docs/moved.json', Array.from({ length: 12 }, (_, i) => `${MARKER} line ${i === 3 ? 'changed' : i}`).join('\n') + '\n')
    git('mv', 'docs/incoming.json', 'state/chroxy/incoming.json')
    put('state/chroxy/incoming.json', Array.from({ length: 12 }, (_, i) => `${MARKER} incoming ${i === 5 ? 'changed' : i}`).join('\n') + '\n')
    const reply = await diff()
    assert.ok(!body(reply).includes(MARKER), 'no line of either renamed file is in the reply')
    assert.ok(!paths(reply).some((p) => p.endsWith('moved.json') || p.endsWith('incoming.json')), `paths: ${paths(reply)}`)
  })

  it('a non-ASCII file name directly in the config dir (git C-quotes it in the header) is omitted; an ordinary one is still shown', async () => {
    put('state/chroxy/café.json', 'accent v1\n')
    put('café.txt', 'accent ordinary v1\n')
    git('add', '.')
    git('commit', '-m', 'accents')
    put('state/chroxy/café.json', `accent v2 ${MARKER}\n`)
    put('café.txt', 'accent ordinary v2\n')
    const reply = await diff()
    assert.ok(!body(reply).includes(MARKER), 'the quoted config-dir header is still recognised')
    assert.ok(body(reply).includes('accent ordinary v2'), 'CONTROL: the ordinary non-ASCII file keeps its hunks')
  })

  it('from a cwd that is a SUBDIRECTORY of the repo (git names files from the repo root), a changed config-dir file is omitted', async () => {
    put('state/chroxy/tracked.json', `tracked v2 ${MARKER}\n`)
    put('state/other.txt', 'beside the config dir\n')
    put('docs/readme.md', 'readme changed\n')
    const reply = await diff(join(repo, 'state'))
    assert.ok(!body(reply).includes(MARKER))
    assert.ok(!paths(reply).includes('state/chroxy/tracked.json'))
    assert.ok(body(reply).includes('readme changed'), 'CONTROL: an ordinary change elsewhere in the repo still shows')
    // `ls-files --others` names files relative to the cwd, `git diff` relative to the repo root.
    assert.ok(paths(reply).includes('other.txt'), 'CONTROL: an untracked file beside the config dir still shows')
  })

  it('a session whose cwd IS the config dir: its untracked top-level file is omitted', async () => {
    put('state/chroxy/untracked.json', `${MARKER} untracked\n`)
    const reply = await diff(cfg)
    assert.ok(!body(reply).includes(MARKER))
    assert.ok(!paths(reply).includes('untracked.json'))
  })

  it('CONTROL: with the config dir elsewhere, the same files are ordinary and keep their content', async () => {
    process.env.CHROXY_CONFIG_DIR = join(root, 'elsewhere')
    put('state/chroxy/tracked.json', `tracked v2 ${MARKER}\n`)
    put('state/chroxy/untracked.json', `${MARKER} untracked\n`)
    const reply = await diff()
    assert.ok(paths(reply).includes('state/chroxy/tracked.json'))
    assert.ok(paths(reply).includes('state/chroxy/untracked.json'))
    assert.ok(body(reply).includes(MARKER))
  })
})

// A user's or repo's git config can change the header form `git diff` prints
// (`diff.noprefix`, `diff.mnemonicPrefix`, `diff.srcPrefix`, `diff.dstPrefix`). getDiff pins the
// default `a/` / `b/` form on the command line so the paths it reads, and therefore the
// config-dir rule above, hold whatever the config says.
describe('get_diff reads the same paths whatever diff prefix settings are configured', () => {
  const settings = [
    ['diff.noprefix', 'true'],
    ['diff.mnemonicPrefix', 'true'],
    ['diff.srcPrefix', 'SRC/'],
    ['diff.dstPrefix', 'DST/'],
  ]
  let root, repo, cfg, fileOps, savedEnv
  const out = []
  const send = (_ws, msg) => out.push(msg)
  const git = (...args) => execFileSync(GIT, args, { cwd: repo, stdio: 'pipe' })
  const put = (rel, text) => {
    const abs = join(repo, rel)
    mkdirSync(join(abs, '..'), { recursive: true })
    writeFileSync(abs, text)
  }

  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-cfgdiff-pfx-')))
    repo = join(root, 'repo')
    cfg = join(repo, 'state', 'chroxy')
    mkdirSync(repo, { recursive: true })
    git('init')
    disableRepoAutoGc(repo)
    git('config', 'user.email', 'test@test.com')
    git('config', 'user.name', 'Test')
    put('file.txt', 'initial content\n')
    put('docs/readme.md', 'readme\n')
    put('state/chroxy/tracked.json', 'tracked v1\n')
    git('add', '.')
    git('commit', '-m', 'initial')
    savedEnv = process.env.CHROXY_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = cfg
    fileOps = createFileOps(send)
  })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CHROXY_CONFIG_DIR
    else process.env.CHROXY_CONFIG_DIR = savedEnv
    rmDirRobust(root)
  })

  for (const [key, value] of settings) {
    it(`with ${key}=${value}: an ordinary modified file keeps its path and hunks, and a modified file directly in the config dir is still dropped`, async () => {
      git('config', key, value)
      put('file.txt', 'modified content\n')
      put('state/chroxy/tracked.json', `tracked v2 ${MARKER}\n`)
      put('docs/readme.md', 'readme staged change\n')
      git('add', 'docs/readme.md')
      out.length = 0
      await fileOps.getDiff({}, undefined, repo)
      assert.equal(out.length, 1)
      const reply = out[0]
      assert.equal(reply.error, null)
      const paths = reply.files.map((f) => f.path).sort()
      assert.deepEqual(paths, ['docs/readme.md', 'file.txt'], `paths: ${paths}`)
      const ordinary = reply.files.find((f) => f.path === 'file.txt')
      assert.ok(ordinary.hunks[0].lines.some((l) => l.content === 'modified content'), 'unstaged hunk content')
      const staged = reply.files.find((f) => f.path === 'docs/readme.md')
      assert.ok(staged.hunks[0].lines.some((l) => l.content === 'readme staged change'), 'staged hunk content')
      assert.ok(!JSON.stringify(reply).includes(MARKER), 'the config-dir file is not in the reply')
    })
  }
})

// Drives getDiff through the injectable exec so the two fail-closed branches can be hit
// deterministically (a real git never produces them).
describe('get_diff fails closed when it cannot tell whether a changed file is in the config directory', () => {
  let root, savedEnv
  beforeEach(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-cfgdiff-fc-')))
    savedEnv = process.env.CHROXY_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = join(root, 'cfg')
  })
  afterEach(() => {
    if (savedEnv === undefined) delete process.env.CHROXY_CONFIG_DIR
    else process.env.CHROXY_CONFIG_DIR = savedEnv
    rmDirRobust(root)
  })

  function seamReader(route) {
    const calls = []
    const sent = []
    const execImpl = async (file, args, opts) => {
      calls.push(args.slice(0, 2).join(' '))
      return route(args, opts)
    }
    const boundResolve = (cwd) => resolveSessionCwd(cwd, new Map(), 60_000)
    const boundValidate = (absPath, cwd) => validatePathWithinCwd(absPath, cwd, new Map(), 60_000)
    const reader = createReaderOps((_ws, msg) => sent.push(msg), boundResolve, boundValidate, execImpl)
    return { reader, sent, calls }
  }
  const FAKE_OID = 'a'.repeat(40)
  const diffText = (header, text) => `${header}\nindex 111..222 100644\n--- a/x\n+++ b/x\n@@ -1 +1 @@\n-old\n+${text}\n`
  function route({ diff, toplevel }) {
    return (args) => {
      if (args[0] === 'rev-parse' && args[1] === '--git-dir') return { stdout: '.git\n' }
      if (args[0] === 'rev-parse' && args[1] === '--verify') return { stdout: FAKE_OID + '\n' }
      if (args[0] === 'rev-parse' && args[1] === '--show-toplevel') return toplevel()
      if (args[0] === 'diff' && args[1] === '--cached') return { stdout: '' }
      if (args[0] === 'diff') return { stdout: diff }
      if (args[0] === 'ls-files') return { stdout: '' }
      throw new Error(`unexpected exec: ${args.join(' ')}`)
    }
  }

  it('a failure to locate the repository root answers the usual error and no files', async () => {
    const { reader, sent } = seamReader(route({
      diff: diffText('diff --git a/ok.txt b/ok.txt', `ordinary ${MARKER}`),
      toplevel: () => { throw new Error('boom') },
    }))
    await reader.getDiff({}, undefined, root)
    assert.equal(sent[0].error, 'Failed to run git diff')
    assert.deepEqual(sent[0].files, [])
    assert.ok(!JSON.stringify(sent[0]).includes(MARKER))
  })

  it('an entry whose header names no path git-style (cannot be placed) is not shown, while a parseable entry beside it is', async () => {
    const { reader, sent } = seamReader(route({
      diff: diffText('diff --git i/odd.txt w/odd.txt', `odd ${MARKER}`) + diffText('diff --git a/ok.txt b/ok.txt', 'fine'),
      toplevel: () => ({ stdout: root + '\n' }),
    }))
    await reader.getDiff({}, undefined, root)
    assert.equal(sent[0].error, null)
    assert.deepEqual(sent[0].files.map((f) => f.path), ['ok.txt'])
    assert.ok(!JSON.stringify(sent[0]).includes(MARKER))
  })

  it('every `git diff` call pins the default header form, in each shape: against a commit, in a repo with no commits yet, and staged', async () => {
    const pinned = ['--src-prefix=a/', '--dst-prefix=b/']
    const diffCalls = (verify) => {
      const argvs = []
      const base = route({ diff: '', toplevel: () => ({ stdout: root + '\n' }) })
      const { reader, sent } = seamReader((args, opts) => {
        if (args[0] === 'diff') argvs.push(args)
        if (args[0] === 'rev-parse' && args[1] === '--verify') return verify()
        return base(args, opts)
      })
      return reader.getDiff({}, undefined, root).then(() => { assert.equal(sent[0].error, null); return argvs })
    }
    assert.deepEqual(await diffCalls(() => ({ stdout: FAKE_OID + '\n' })), [
      ['diff', ...pinned, FAKE_OID],
      ['diff', ...pinned, '--cached', 'HEAD'],
    ])
    assert.deepEqual(await diffCalls(() => { throw new Error('no commits') }), [
      ['diff', ...pinned],
      ['diff', ...pinned, '--cached', 'HEAD'],
    ])
  })

  it('CONTROL: the repository root is only looked up when the diff has files (an empty diff costs no extra git call)', async () => {
    const empty = seamReader(route({ diff: '', toplevel: () => { throw new Error('must not be called') } }))
    await empty.reader.getDiff({}, undefined, root)
    assert.equal(empty.sent[0].error, null)
    assert.ok(!empty.calls.includes('rev-parse --show-toplevel'))
    const some = seamReader(route({ diff: diffText('diff --git a/ok.txt b/ok.txt', 'fine'), toplevel: () => ({ stdout: root + '\n' }) }))
    await some.reader.getDiff({}, undefined, root)
    assert.ok(some.calls.includes('rev-parse --show-toplevel'))
  })
})
