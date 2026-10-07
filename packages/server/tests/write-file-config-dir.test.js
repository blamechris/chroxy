import { describe, it, before, after, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, rm, mkdir, symlink, readdir, realpath } from 'fs/promises'
import { existsSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { isConfigDirOrDirectChild, CONFIG_DIR_REFUSAL } from '../src/ws-file-ops/common.js'

// #8331 — generic file writes refuse the daemon's config directory ITSELF and any file
// DIRECTLY in it, so the deploy control files (deploy-request.json, deploy-postpone.json)
// can only be written through `daemon_update_action`. Subtrees stay writable: chroxy's own
// session worktrees live at <configDir>/worktrees/<id>. Everything runs in a temp tree with
// CHROXY_CONFIG_DIR pointed into it; the real config dir is never touched.

describe('generic file writes refuse the config directory and its direct children (#8331)', () => {
  let root, home, cfg, project, fileOps, savedEnv
  const out = []
  const send = (_ws, msg) => out.push(msg)
  const ws = {}

  before(async () => {
    root = await realpath(await mkdtemp(join(tmpdir(), 'chroxy-cfgguard-')))
    home = join(root, 'home')
    cfg = join(home, '.chroxy')
    project = join(home, 'project')
    await mkdir(cfg, { recursive: true })
    await mkdir(project, { recursive: true })
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

  const forged = JSON.stringify({ action: 'restart-now', target: 'b'.repeat(40), force: true })

  it('a session whose cwd is the PARENT of the config dir is refused, and nothing appears', async () => {
    await fileOps.writeFile(ws, '.chroxy/deploy-request.json', forged, home)
    assert.equal(out[0].type, 'write_file_result')
    assert.equal(out[0].error, CONFIG_DIR_REFUSAL)
    assert.equal(existsSync(join(cfg, 'deploy-request.json')), false)
  })

  it('a session whose cwd IS the config dir is refused', async () => {
    await fileOps.writeFile(ws, 'deploy-postpone.json', '{}', cfg)
    assert.equal(out[0].error, CONFIG_DIR_REFUSAL)
    assert.deepEqual(await readdir(cfg), [])
  })

  it('a file directly in the config dir is refused even when it does not exist yet, and nothing is created', async () => {
    await fileOps.writeFile(ws, 'brand-new-state.json', '{}', cfg)
    assert.equal(out[0].error, CONFIG_DIR_REFUSAL)
    assert.deepEqual(await readdir(cfg), [])
  })

  it('a worktree reaching the config root through ../.. is refused (the cwd check also denies it, but never writes)', async () => {
    const wt = join(cfg, 'worktrees', 'sess-1')
    await mkdir(wt, { recursive: true })
    await fileOps.writeFile(ws, '../../deploy-request.json', forged, wt)
    assert.ok(out[0].error)
    assert.equal(existsSync(join(cfg, 'deploy-request.json')), false)
  })

  it('a symlinked parent that leads into the config dir is refused (the link sits inside the session cwd, so only this guard stops it)', async () => {
    await symlink(cfg, join(home, 'alias'))
    await fileOps.writeFile(ws, 'alias/deploy-request.json', forged, home)
    assert.equal(out[0].error, CONFIG_DIR_REFUSAL)
    assert.equal(existsSync(join(cfg, 'deploy-request.json')), false)
    await rm(join(home, 'alias'))
  })

  it('a dangling symlink inside the cwd that points at a config file is refused, and nothing is created', async () => {
    await symlink(join(cfg, 'deploy-request.json'), join(home, 'dangling.json'))
    await fileOps.writeFile(ws, 'dangling.json', forged, home)
    assert.ok(out[0].error)
    assert.equal(existsSync(join(cfg, 'deploy-request.json')), false)
    await rm(join(home, 'dangling.json'))
  })

  it('quick-append into a config-dir cwd is refused too', async () => {
    await fileOps.appendMemory(ws, 'a note', cfg)
    assert.equal(out[0].type, 'append_memory_result')
    assert.equal(out[0].error, CONFIG_DIR_REFUSAL)
    assert.equal(existsSync(join(cfg, 'CLAUDE.md')), false)
  })

  it('chroxy\'s OWN session worktree (<cfg>/worktrees/<id>) stays writable, for write_file and quick-append', async () => {
    const wt = join(cfg, 'worktrees', 'sess-2')
    await mkdir(wt, { recursive: true })
    await fileOps.writeFile(ws, 'src/a.js', 'x', wt)
    assert.equal(out[0].error, null)
    assert.ok(existsSync(join(wt, 'src/a.js')))
    out.length = 0
    await fileOps.appendMemory(ws, 'a note', wt)
    assert.equal(out[0].error, null)
  })

  it('an orchestration worktree (<cfg>/orchestration/worktrees/<id>) stays writable', async () => {
    const wt = join(cfg, 'orchestration', 'worktrees', 'run-1')
    await mkdir(wt, { recursive: true })
    await fileOps.writeFile(ws, 'x', 'ok', wt)
    assert.equal(out[0].error, null)
    assert.ok(existsSync(join(wt, 'x')))
  })

  it('a worktree reached through a SYMLINK is writable', async () => {
    const wt = join(cfg, 'worktrees', 'sess-3')
    await mkdir(wt, { recursive: true })
    await symlink(wt, join(home, 'wt-link'))
    await fileOps.writeFile(ws, 'wt-link/ok.txt', 'fine', home)
    assert.equal(out[0].error, null)
    await rm(join(home, 'wt-link'))
  })

  it('a normal project write still works, as does quick-append', async () => {
    await fileOps.writeFile(ws, 'src/ok.txt', 'fine', project)
    assert.equal(out[0].error, null)
    assert.ok(existsSync(join(project, 'src/ok.txt')))
    out.length = 0
    await fileOps.appendMemory(ws, 'a note', project)
    assert.equal(out[0].error, null)
  })

  it('only the root and its DIRECT children count; a sibling sharing the name prefix does not', async () => {
    await mkdir(join(home, '.chroxy-other'), { recursive: true })
    assert.equal(await isConfigDirOrDirectChild(join(home, '.chroxy-other', 'x.txt')), false)
    assert.equal(await isConfigDirOrDirectChild(join(cfg, 'worktrees', 'id', 'x')), false, 'a subtree')
    assert.equal(await isConfigDirOrDirectChild(join(cfg, 'a', 'b')), false, 'a grandchild')
    assert.equal(await isConfigDirOrDirectChild(join(cfg, 'a')), true, 'a direct child')
    assert.equal(await isConfigDirOrDirectChild(cfg), true, 'the root')
  })

  it('FAILS CLOSED: a path that cannot be resolved (a symlink loop) counts as inside', async () => {
    await symlink(join(home, 'loop'), join(home, 'loop'))
    assert.equal(await isConfigDirOrDirectChild(join(home, 'loop', 'x.json')), true)
    await rm(join(home, 'loop'))
  })

  it('follows a RELOCATED config dir (CHROXY_CONFIG_DIR), not the default location', async () => {
    const elsewhere = join(root, 'elsewhere-state')
    await mkdir(elsewhere, { recursive: true })
    const prev = process.env.CHROXY_CONFIG_DIR
    process.env.CHROXY_CONFIG_DIR = elsewhere
    try {
      assert.equal(await isConfigDirOrDirectChild(join(elsewhere, 'deploy-request.json')), true)
      assert.equal(await isConfigDirOrDirectChild(join(cfg, 'deploy-request.json')), false, 'the old location is an ordinary directory now')
    } finally { process.env.CHROXY_CONFIG_DIR = prev }
  })
})
