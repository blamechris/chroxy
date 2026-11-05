// #8270 review: the memory read validates the claude config dir, but it resolves
// that dir AGAIN (async) before installing it as a containment root. If that
// second resolution lands on a filesystem root (a path swapped in between the
// two steps), the root must not become an allowed root: the global memory root
// is treated as unavailable and imports from outside the project stay skipped.

import { describe, it, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse } from 'node:path'
import * as common from '../src/ws-file-ops/common.js'
import { resolveSessionCwd } from '../src/ws-file-ops/common.js'

let root
let savedEnv

beforeEach(() => {
  root = realpathSync.native(mkdtempSync(join(tmpdir(), 'memory-root-use-site-')))
  savedEnv = process.env.CLAUDE_CONFIG_DIR
})

afterEach(() => {
  if (savedEnv === undefined) delete process.env.CLAUDE_CONFIG_DIR
  else process.env.CLAUDE_CONFIG_DIR = savedEnv
  rmSync(root, { recursive: true, force: true })
})

describe('memory read: config dir re-resolved to a filesystem root (#8270)', () => {
  it('does not install the root as an allowed root', async () => {
    const cfg = join(root, 'cfg')
    const cwd = join(root, 'work')
    const outside = join(root, 'outside')
    mkdirSync(cfg, { recursive: true })
    mkdirSync(cwd, { recursive: true })
    mkdirSync(outside, { recursive: true })
    writeFileSync(join(outside, 'note.md'), 'outside-markdown-body')
    writeFileSync(join(cfg, 'CLAUDE.md'), 'global-body')
    writeFileSync(join(cwd, 'CLAUDE.md'), `see @${join(outside, 'note.md')}`)
    process.env.CLAUDE_CONFIG_DIR = cfg

    const fsRoot = parse(root).root
    const handle = mock.module('../src/ws-file-ops/common.js', {
      namedExports: {
        ...common,
        realpathOfDeepestAncestor: async (p) => (p === cfg ? fsRoot : common.realpathOfDeepestAncestor(p)),
      },
    })
    try {
      const { createMemoryOps } = await import(`../src/ws-file-ops/memory.js?usesite=${Date.now()}`)
      const out = []
      const ops = createMemoryOps((_ws, msg) => out.push(msg), (c) => resolveSessionCwd(c, new Map(), 60_000))
      await ops.readMemory({}, cwd)
      const res = out[0]
      assert.equal(res.error, null)
      assert.ok(!JSON.stringify(res).includes('outside-markdown-body'), 'content outside both roots is not returned')
      const global = res.entries.find((e) => e.scope === 'global')
      assert.equal(global.content, null, 'global memory root is unavailable')
      const imported = res.entries.find((e) => e.scope === 'import')
      assert.equal(imported.skipped, true)
    } finally {
      handle.restore()
    }
  })
})
