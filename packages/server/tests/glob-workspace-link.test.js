import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { executeBuiltinTool } from '../src/byok-tool-executor.js'

// Kept out of byok-tool-executor.test.js, which the Windows set exempts, so this
// control runs on every platform. A directory link is a junction on Windows,
// which needs no symlink privilege.
describe('Glob in a workspace reached through a directory link', () => {
  let dir
  beforeEach(() => {
    dir = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-glob-link-')))
    mkdirSync(join(dir, 'real', 'x', 'y'), { recursive: true })
    writeFileSync(join(dir, 'real', 'x', 'y', 'f.txt'), '1')
    writeFileSync(join(dir, 'real', 'g.txt'), '1')
    symlinkSync(join(dir, 'real'), join(dir, 'viaLink'), 'junction')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  async function glob(cwd, pattern) {
    const r = await executeBuiltinTool({
      toolName: 'Glob', input: { pattern }, cwd, cwdRealCache: new Map(), cwdCacheTtl: 30_000,
    })
    assert.equal(r.isError, false)
    return r.content.split('\n').map((l) => l.replace(/\\/g, '/')).sort()
  }

  for (const pattern of ['**', '**/*.txt', 'x/*/*']) {
    it(`lists the same entries as the real path for ${pattern}`, async () => {
      const direct = await glob(join(dir, 'real'), pattern)
      const viaLink = await glob(join(dir, 'viaLink'), pattern)
      assert.ok(direct.length > 0 && !direct[0].startsWith('No matches'), `${pattern} must list something`)
      assert.deepEqual(viaLink, direct)
    })
  }
})
