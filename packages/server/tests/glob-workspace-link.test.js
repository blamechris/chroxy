import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, symlinkSync, realpathSync, rmSync, existsSync } from 'node:fs'
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

  it('a non-string or empty path lists the session root, as when path is omitted', async () => {
    const viaLink = join(dir, 'viaLink')
    const expected = await glob(viaLink, '**')
    for (const path of [123, '', null, {}]) {
      const r = await executeBuiltinTool({
        toolName: 'Glob', input: { pattern: '**', path }, cwd: viaLink, cwdRealCache: new Map(), cwdCacheTtl: 30_000,
      })
      assert.equal(r.isError, false)
      assert.deepEqual(r.content.split('\n').map((l) => l.replace(/\\/g, '/')).sort(), expected, `path ${JSON.stringify(path)}`)
    }
  })

  it('a path spelled with different letter case lists the same entries (case-insensitive filesystems)', async (t) => {
    mkdirSync(join(dir, 'real', 'Sub', 'Deep'), { recursive: true })
    writeFileSync(join(dir, 'real', 'Sub', 'Deep', 'f.txt'), '1')
    if (!existsSync(join(dir, 'real', 'sUB'))) { t.skip('this filesystem is case-sensitive'); return }
    const cwd = join(dir, 'real')
    const run = async (path) => {
      const r = await executeBuiltinTool({ toolName: 'Glob', input: { pattern: '**', path }, cwd, cwdRealCache: new Map(), cwdCacheTtl: 30_000 })
      assert.equal(r.isError, false)
      return r.content.split('\n').map((l) => l.replace(/\\/g, '/')).sort()
    }
    assert.deepEqual(await run('sUB'), await run('Sub'))
    assert.deepEqual(await run('Sub/dEEP'), await run('Sub/Deep'))
    assert.ok((await run('sUB')).some((l) => l.endsWith('f.txt')))
  })

  it('a path that does not exist gives no matches, not an error', async () => {
    const r = await executeBuiltinTool({
      toolName: 'Glob', input: { pattern: '*', path: 'missing' }, cwd: join(dir, 'real'), cwdRealCache: new Map(), cwdCacheTtl: 30_000,
    })
    assert.equal(r.isError, false)
    assert.match(r.content, /^No matches/)
  })
})
