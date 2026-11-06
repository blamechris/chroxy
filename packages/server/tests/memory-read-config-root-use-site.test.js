// The memory read takes the claude config dir's canonical form, then resolves
// the dir again (async). When the second result is a filesystem root or differs
// from the canonical form, the global memory root is unavailable and imports
// from outside the project stay skipped.

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

describe('memory read: second resolution is a filesystem root', () => {
  it('does not use the root as an allowed root', async () => {
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

describe('memory read: second resolution differs from the canonical form (#8975)', () => {
  it('does not use the differing directory as an allowed root', async () => {
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

    // A real, non-root directory that contains the outside import.
    const differing = root
    const handle = mock.module('../src/ws-file-ops/common.js', {
      namedExports: {
        ...common,
        realpathOfDeepestAncestor: async (p) => (p === cfg ? differing : common.realpathOfDeepestAncestor(p)),
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

describe('memory read: canonical form is read before the second resolution (#8975)', () => {
  it('does not use a directory that only the later reads return', async () => {
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

    const differing = root
    let canonicalReads = 0
    let secondResolutionDone = false
    const cfgModule = await import('../src/utils/claude-config-dir.js')
    const cfgHandle = mock.module('../src/utils/claude-config-dir.js', {
      namedExports: {
        ...cfgModule,
        resolveClaudeConfigDirOverride: (raw) => (++canonicalReads && !secondResolutionDone ? cfgModule.resolveClaudeConfigDirOverride(raw) : differing),
      },
    })
    const handle = mock.module('../src/ws-file-ops/common.js', {
      namedExports: {
        ...common,
        realpathOfDeepestAncestor: async (p) => {
          if (p !== cfg) return common.realpathOfDeepestAncestor(p)
          secondResolutionDone = true
          return differing
        },
      },
    })
    try {
      const { createMemoryOps } = await import(`../src/ws-file-ops/memory.js?order=${Date.now()}`)
      const out = []
      const ops = createMemoryOps((_ws, msg) => out.push(msg), (c) => resolveSessionCwd(c, new Map(), 60_000))
      await ops.readMemory({}, cwd)
      const res = out[0]
      assert.equal(res.error, null)
      assert.equal(canonicalReads, 1, 'the canonical form is read once')
      assert.ok(!JSON.stringify(res).includes('outside-markdown-body'), 'content outside both roots is not returned')
      const global = res.entries.find((e) => e.scope === 'global')
      assert.equal(global.content, null, 'global memory root is unavailable')
      const imported = res.entries.find((e) => e.scope === 'import')
      assert.equal(imported.skipped, true)
    } finally {
      handle.restore()
      cfgHandle.restore()
    }
  })
})
