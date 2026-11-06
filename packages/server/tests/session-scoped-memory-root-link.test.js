import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { projectSlug } from '../src/jsonl-reader.js'
import { SKIP_NO_SYMLINK } from './helpers/symlink-support.js'

// The project's memory directory is `<config>/projects/<slug>`. When that name is
// a link, it is followed only to another directory UNDER `<config>/projects/`;
// a link to the config directory itself (or anything else beside `projects/`)
// is not this project's memory.
describe('the project memory directory when its name is a link', { skip: SKIP_NO_SYMLINK }, () => {
  let root, home, cfg, realHome, realProfile, realConfig
  const out = []
  const send = (_ws, msg) => out.push(msg)

  before(() => {
    root = realpathSync.native(mkdtempSync(join(tmpdir(), 'chroxy-memlink-')))
    home = join(root, 'home')
    cfg = join(home, '.claude')
    mkdirSync(join(cfg, 'projects'), { recursive: true })
    mkdirSync(join(cfg, 'memory'), { recursive: true })
    writeFileSync(join(cfg, 'CLAUDE.md'), 'USER-LEVEL-MARKER\n')
    writeFileSync(join(cfg, 'memory', 'MEMORY.md'), 'USER-LEVEL-MEMORY-MARKER\n')
    realHome = process.env.HOME; realProfile = process.env.USERPROFILE; realConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.CLAUDE_CONFIG_DIR
  })
  after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile
    if (realConfig !== undefined) process.env.CLAUDE_CONFIG_DIR = realConfig
    rmSync(root, { recursive: true, force: true })
  })

  async function confinedRead(cwd) {
    out.length = 0
    await createFileOps(send, root).readMemory({}, cwd, 'r1', { confineToProject: true })
    return JSON.stringify(out[out.length - 1])
  }

  it('a link to the config directory itself is not followed', async () => {
    const cwd = join(root, 'work', 'selflink')
    mkdirSync(cwd, { recursive: true })
    symlinkSync(cfg, join(cfg, 'projects', projectSlug(cwd)))
    const t = await confinedRead(cwd)
    assert.equal(t.includes('USER-LEVEL-MARKER'), false)
    assert.equal(t.includes('USER-LEVEL-MEMORY-MARKER'), false)
  })

  it('a link to another directory under projects/ is followed', async () => {
    const cwd = join(root, 'work', 'moved')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(join(cfg, 'projects', 'real-store', 'memory'), { recursive: true })
    writeFileSync(join(cfg, 'projects', 'real-store', 'memory', 'MEMORY.md'), 'MOVED-PROJECT-MEMORY\n')
    symlinkSync(join(cfg, 'projects', 'real-store'), join(cfg, 'projects', projectSlug(cwd)))
    const t = await confinedRead(cwd)
    assert.ok(t.includes('MOVED-PROJECT-MEMORY'), 'the in-tree link still resolves to the project memory')
  })
})
