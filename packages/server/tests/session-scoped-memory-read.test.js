import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createFileOps } from '../src/ws-file-ops/index.js'
import { encodeProjectPath } from '../src/jsonl-reader.js'
import { fileHandlers } from '../src/handlers/file-handlers.js'

// A project-confined memory read returns the project's own memory, and nothing
// from the rest of the config tree: not the user-level file, not another
// project's memory, however a project file imports it.
describe('memory_read for a session-scoped connection', () => {
  let root, home, cwd, fileOps, realHome, realProfile, realConfig
  const out = []
  const send = (_ws, msg) => out.push(msg)
  const text = (reply) => JSON.stringify(reply)

  before(() => {
    root = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-memscope-')))
    home = join(root, 'home')
    cwd = join(root, 'work', 'mine')
    const otherCwd = join(root, 'work', 'other')
    const cfg = join(home, '.claude')
    mkdirSync(cwd, { recursive: true })
    mkdirSync(join(cfg, 'projects', encodeProjectPath(cwd), 'memory'), { recursive: true })
    mkdirSync(join(cfg, 'projects', encodeProjectPath(otherCwd), 'memory'), { recursive: true })
    writeFileSync(join(cfg, 'CLAUDE.md'), 'USER-LEVEL-MARKER\n')
    writeFileSync(join(cfg, 'projects', encodeProjectPath(cwd), 'memory', 'MEMORY.md'), 'OWN-PROJECT-MEMORY\n')
    const siblingMemory = join(cfg, 'projects', encodeProjectPath(otherCwd), 'memory', 'MEMORY.md')
    writeFileSync(siblingMemory, 'SIBLING-PROJECT-MEMORY\n')
    writeFileSync(join(cwd, 'CLAUDE.md'), `project rules\n@${siblingMemory}\n@${join(cfg, 'CLAUDE.md')}\n@docs/own.md\n`)
    mkdirSync(join(cwd, 'docs'), { recursive: true })
    writeFileSync(join(cwd, 'docs', 'own.md'), 'OWN-IMPORT-MARKER\n')
    realHome = process.env.HOME; realProfile = process.env.USERPROFILE; realConfig = process.env.CLAUDE_CONFIG_DIR
    process.env.HOME = home; process.env.USERPROFILE = home; delete process.env.CLAUDE_CONFIG_DIR
    fileOps = createFileOps(send, root)
  })
  after(() => {
    if (realHome === undefined) delete process.env.HOME; else process.env.HOME = realHome
    if (realProfile === undefined) delete process.env.USERPROFILE; else process.env.USERPROFILE = realProfile
    if (realConfig !== undefined) process.env.CLAUDE_CONFIG_DIR = realConfig
    rmSync(root, { recursive: true, force: true })
  })

  async function read(opts) {
    out.length = 0
    await fileOps.readMemory({}, cwd, 'r1', opts)
    return out[out.length - 1]
  }

  it('an unconfined read still returns the whole stack (control)', async () => {
    const reply = await read()
    const t = text(reply)
    assert.ok(t.includes('USER-LEVEL-MARKER'))
    assert.ok(t.includes('SIBLING-PROJECT-MEMORY'), 'control: the import is followed under the config tree')
    assert.ok(t.includes('OWN-PROJECT-MEMORY'))
  })

  it('a confined read returns the project\'s own memory and imports, not the rest of the config tree', async () => {
    const reply = await read({ confineToProject: true })
    const t = text(reply)
    assert.equal(reply.error, null)
    assert.ok(t.includes('OWN-PROJECT-MEMORY'))
    assert.ok(t.includes('OWN-IMPORT-MARKER'))
    assert.equal(t.includes('SIBLING-PROJECT-MEMORY'), false)
    assert.equal(t.includes('USER-LEVEL-MARKER'), false)
    assert.equal(reply.entries.some((e) => e.scope === 'global'), false)
  })

  it('the handler asks for a confined read exactly when the connection is session-scoped', () => {
    const calls = []
    const ctx = {
      sessions: { sessionManager: { getSession: () => ({ cwd: '/work/x' }) } },
      services: { fileOps: { readMemory: (...a) => calls.push(a[3]) } },
    }
    fileHandlers.memory_read({}, { activeSessionId: 's', boundSessionId: 's' }, { sessionId: 's' }, ctx)
    fileHandlers.memory_read({}, { activeSessionId: 's' }, { sessionId: 's' }, ctx)
    assert.deepEqual(calls, [{ confineToProject: true }, { confineToProject: false }])
  })
})
