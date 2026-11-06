import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, symlinkSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
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

  async function readOf(cwd, confine) {
    out.length = 0
    await createFileOps(send, root).readMemory({}, cwd, 'r1', { confineToProject: confine })
    return JSON.stringify(out[out.length - 1])
  }
  const confinedRead = (cwd) => readOf(cwd, true)

  it('a link to the config directory itself is not followed', async () => {
    const cwd = join(root, 'work', 'selflink')
    mkdirSync(cwd, { recursive: true })
    symlinkSync(cfg, join(cfg, 'projects', projectSlug(cwd)))
    const t = await confinedRead(cwd)
    assert.equal(t.includes('USER-LEVEL-MARKER'), false)
    assert.equal(t.includes('USER-LEVEL-MEMORY-MARKER'), false)
  })

  it('a link to projects/ itself is not followed: another project\'s memory is not read, imported or not', async () => {
    const cwd = join(root, 'work', 'projlink')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(join(cfg, 'projects', 'other-proj', 'memory'), { recursive: true })
    writeFileSync(join(cfg, 'projects', 'other-proj', 'memory', 'notes.md'), 'OTHER-PROJECT-NOTES\n')
    // A memory file directly under projects/ is what a followed link would read as this project's.
    mkdirSync(join(cfg, 'projects', 'memory'), { recursive: true })
    writeFileSync(join(cfg, 'projects', 'memory', 'MEMORY.md'), 'PROJECTS-LEVEL-MEMORY\n')
    writeFileSync(join(cwd, 'CLAUDE.md'), `rules\n@${relative(cwd, join(cfg, 'projects', 'other-proj', 'memory', 'notes.md')).split(/[\\/]/).join('/')}\n`)
    symlinkSync(join(cfg, 'projects'), join(cfg, 'projects', projectSlug(cwd)))
    assert.equal((await confinedRead(cwd)).includes('PROJECTS-LEVEL-MEMORY'), false, 'the link to projects/ is not the project\'s memory')
    assert.equal((await confinedRead(cwd)).includes('OTHER-PROJECT-NOTES'), false, 'a confined read does not follow the import either')
  })

  it('a confined read does not follow a link to another project\'s directory', async () => {
    const cwd = join(root, 'work', 'moved')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(join(cfg, 'projects', 'real-store', 'memory'), { recursive: true })
    writeFileSync(join(cfg, 'projects', 'real-store', 'memory', 'MEMORY.md'), 'MOVED-PROJECT-MEMORY\n')
    symlinkSync(join(cfg, 'projects', 'real-store'), join(cfg, 'projects', projectSlug(cwd)))
    assert.equal((await readOf(cwd, true)).includes('MOVED-PROJECT-MEMORY'), false)
  })

  it('an unconfined read still follows a link to another directory under projects/', async () => {
    const cwd = join(root, 'work', 'moved')
    assert.ok((await readOf(cwd, false)).includes('MOVED-PROJECT-MEMORY'))
  })
})
