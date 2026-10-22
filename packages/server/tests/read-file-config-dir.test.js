import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, symlink, writeFile, realpath } from 'fs/promises'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { CONFIG_DIR_REFUSAL } from '../src/ws-file-ops/common.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

// Files directly in the daemon's config directory are daemon-managed state, so the
// generic file viewer (`read_file`) treats reads the same way generic writes already
// do (see write-file-config-dir.test.js): the config directory itself and any file
// directly in it answer one refusal, whether or not the name exists. Subtrees stay
// readable on purpose: chroxy's own session worktrees live at <configDir>/worktrees/<id>.
// Everything runs in a temp tree with CHROXY_CONFIG_DIR pointed into it; the real
// config dir is never touched.

describe('generic file reads refuse the config directory and its direct children', () => {
  let root, home, cfg, project, fileOps, savedEnv
  const out = []
  const send = (_ws, msg) => out.push(msg)
  const ws = {}
  const MARKER = 'fixture-marker-7c1d'

  // One read, one reply. Collapse to the reply object so a failing assertion prints
  // a short message instead of a whole fixture.
  async function read(requestedPath, cwd) {
    out.length = 0
    await fileOps.readFile(ws, requestedPath, cwd)
    assert.equal(out.length, 1, 'exactly one file_content reply')
    assert.equal(out[0].type, 'file_content')
    return out[0]
  }

  function assertRefused(reply, label) {
    assert.equal(reply.error, CONFIG_DIR_REFUSAL, `${label}: refusal text`)
    assert.equal(reply.content, null, `${label}: no content`)
    assert.equal(reply.size, null, `${label}: no size`)
    assert.equal(reply.truncated, false, `${label}: not truncated`)
    assert.ok(!JSON.stringify(reply).includes(MARKER), `${label}: fixture text absent from the reply`)
  }

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'chroxy-cfgread-')))
    home = join(root, 'home')
    cfg = join(home, '.chroxy')
    project = join(home, 'project')
    await mkdir(cfg, { recursive: true })
    await mkdir(project, { recursive: true })
    await writeFile(join(cfg, 'state.json'), JSON.stringify({ note: MARKER }))
    await writeFile(join(project, 'ordinary.txt'), `plain ${MARKER}\n`)
    savedEnv = process.env.CHROXY_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = cfg
    fileOps = createFileOps(send)
  })
  after(async () => {
    if (savedEnv === undefined) delete process.env.CHROXY_CONFIG_DIR
    else process.env.CHROXY_CONFIG_DIR = savedEnv
    await rm(root, { recursive: true, force: true })
  })
  beforeEach(() => { out.length = 0 })

  it('a file directly in the config dir is refused from a session whose cwd is the PARENT of the config dir', async () => {
    assertRefused(await read('.chroxy/state.json', home), 'parent cwd')
  })

  it('a session whose cwd IS the config dir is refused', async () => {
    assertRefused(await read('state.json', cfg), 'config dir cwd')
  })

  it('a missing name directly in the config dir answers the same refusal as an existing one, not "File not found"', async () => {
    const reply = await read('.chroxy/absent.json', home)
    assertRefused(reply, 'missing top-level name')
    assert.notEqual(reply.error, 'File not found')
  })

  it('a missing name nested under a NEW top-level name is refused too (absent-dir/x.json)', async () => {
    assertRefused(await read('.chroxy/absent-dir/x.json', home), 'missing nested name')
  })

  it('the config dir itself is refused, rather than reported as a directory', async () => {
    assertRefused(await read('.chroxy', home), 'config dir itself')
  })

  it('a refusal comes before any size or type check: a large file and an image directly in the config dir reveal neither', async () => {
    await writeFile(join(cfg, 'big.log'), Buffer.alloc(600 * 1024, 0x61))
    await writeFile(join(cfg, 'pic.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00]))
    await writeFile(join(cfg, 'blob.bin'), Buffer.from([0x00, 0x01, 0x02]))
    for (const name of ['big.log', 'pic.png', 'blob.bin']) {
      const reply = await read(`.chroxy/${name}`, home)
      assertRefused(reply, name)
      assert.equal(reply.language, null, `${name}: no language`)
    }
  })

  it('a worktree reaching the config root through ../.. never returns the file (the cwd check denies it first)', async () => {
    const wt = join(cfg, 'worktrees', 'sess-up')
    await mkdir(wt, { recursive: true })
    const reply = await read('../../state.json', wt)
    assert.ok(reply.error, 'denied')
    assert.equal(reply.content, null)
    assert.ok(!JSON.stringify(reply).includes(MARKER))
  })

  it('a symlink inside the cwd that points at a file directly in the config dir is refused', { skip: SKIP_NO_SYMLINK }, async () => {
    await symlink(join(cfg, 'state.json'), join(home, 'alias-state.json'))
    assertRefused(await read('alias-state.json', home), 'file symlink')
  })

  it('a symlinked parent that leads into the config dir is refused', { skip: SKIP_NO_SYMLINK }, async () => {
    await symlink(cfg, join(home, 'alias-dir'))
    assertRefused(await read('alias-dir/state.json', home), 'dir symlink, existing name')
    assertRefused(await read('alias-dir/absent.json', home), 'dir symlink, missing name')
  })

  it('a dangling symlink inside the cwd that points at a missing name in the config dir is refused, not "File not found"', { skip: SKIP_NO_SYMLINK }, async () => {
    await symlink(join(cfg, 'absent.json'), join(home, 'dangling-state.json'))
    const reply = await read('dangling-state.json', home)
    assertRefused(reply, 'dangling symlink')
    assert.notEqual(reply.error, 'File not found')
  })

  it('follows a RELOCATED config root (CHROXY_CONFIG_DIR=<cwd>/state/chroxy): its top-level file is refused, a sibling under state/ is not', async () => {
    const relocatedCwd = join(root, 'relocated')
    const relocated = join(relocatedCwd, 'state', 'chroxy')
    await mkdir(relocated, { recursive: true })
    await writeFile(join(relocated, 'data.json'), JSON.stringify({ note: MARKER }))
    await writeFile(join(relocatedCwd, 'state', 'sibling.txt'), 'sibling\n')
    const prev = process.env.CHROXY_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = relocated
    try {
      assertRefused(await read('state/chroxy/data.json', relocatedCwd), 'relocated existing')
      assertRefused(await read('state/chroxy/absent.json', relocatedCwd), 'relocated missing')
      const sibling = await read('state/sibling.txt', relocatedCwd)
      assert.equal(sibling.error, null)
      assert.equal(sibling.content, 'sibling\n')
    } finally { process.env.CHROXY_CONFIG_DIR = prev }
  })

  it('FAILS CLOSED when the config root cannot be resolved: a symlink loop for the config dir refuses an in-cwd read instead of serving it', { skip: SKIP_NO_SYMLINK }, async () => {
    const loopCwd = join(root, 'loop-cwd')
    await mkdir(loopCwd, { recursive: true })
    await writeFile(join(loopCwd, 'plain.txt'), 'plain\n')
    await symlink(join(loopCwd, 'cfg-loop'), join(loopCwd, 'cfg-loop'))
    const prev = process.env.CHROXY_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = join(loopCwd, 'cfg-loop')
    try {
      assertRefused(await read('plain.txt', loopCwd), 'unresolvable config root')
    } finally { process.env.CHROXY_CONFIG_DIR = prev }
  })

  // ── POSITIVE CONTROLS: the rule must not widen into ordinary reads ───────────

  it('CONTROL: an ordinary file in a project cwd returns its content', async () => {
    const reply = await read('ordinary.txt', project)
    assert.equal(reply.error, null)
    assert.equal(reply.content, `plain ${MARKER}\n`)
    assert.equal(typeof reply.size, 'number')
  })

  it('CONTROL: a file in chroxy\'s own session worktree (<cfg>/worktrees/<id>) stays readable, from the worktree and from the home cwd', async () => {
    const wt = join(cfg, 'worktrees', 'w1')
    await mkdir(join(wt, 'src'), { recursive: true })
    await writeFile(join(wt, 'src', 'a.js'), 'export const a = 1\n')
    const fromWorktree = await read('src/a.js', wt)
    assert.equal(fromWorktree.error, null)
    assert.equal(fromWorktree.content, 'export const a = 1\n')
    const fromHome = await read('.chroxy/worktrees/w1/src/a.js', home)
    assert.equal(fromHome.error, null)
    assert.equal(fromHome.content, 'export const a = 1\n')
  })

  it('CONTROL: a worktree reached through a SYMLINK is readable', { skip: SKIP_NO_SYMLINK }, async () => {
    const wt = join(cfg, 'worktrees', 'w2')
    await mkdir(wt, { recursive: true })
    await writeFile(join(wt, 'b.txt'), 'bee\n')
    await symlink(wt, join(home, 'wt-link'))
    const reply = await read('wt-link/b.txt', home)
    assert.equal(reply.error, null)
    assert.equal(reply.content, 'bee\n')
  })

  it('CONTROL: a missing ordinary file still answers "File not found"; so does a missing file in an existing worktree subtree', async () => {
    assert.equal((await read('no-such-file.txt', project)).error, 'File not found')
    assert.equal((await read('missing/deeper/file.txt', project)).error, 'File not found')
    const wt = join(cfg, 'worktrees', 'w3')
    await mkdir(wt, { recursive: true })
    assert.equal((await read('nope.js', wt)).error, 'File not found')
    assert.equal((await read('.chroxy/worktrees/w3/nope.js', home)).error, 'File not found')
  })

  it('CONTROL: a sibling directory that merely shares the config dir\'s name prefix is an ordinary directory', async () => {
    await mkdir(join(home, '.chroxy-other'), { recursive: true })
    await writeFile(join(home, '.chroxy-other', 'x.txt'), 'other\n')
    const reply = await read('.chroxy-other/x.txt', home)
    assert.equal(reply.error, null)
    assert.equal(reply.content, 'other\n')
  })
})
