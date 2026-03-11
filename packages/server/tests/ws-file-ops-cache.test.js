import { describe, it, before, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtemp, mkdir, writeFile, symlink, rm, realpath } from 'node:fs/promises'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

describe('#1931 — CWD real path cache TTL', () => {
  let tmpDir
  let realDir
  let linkDir

  before(async () => {
    tmpDir = await mkdtemp(join(tmpdir(), 'cache-test-'))
    realDir = join(tmpDir, 'real')
    linkDir = join(tmpDir, 'link')
    await mkdir(realDir)
    await writeFile(join(realDir, 'test.txt'), 'hello')
    await symlink(realDir, linkDir)
  })

  after(async () => {
    await rm(tmpDir, { recursive: true, force: true })
  })

  it('resolves symlinked session CWD to real path via browseFiles', async () => {
    const { createFileOps } = await import('../src/ws-file-ops.js')

    const results = []
    const sendFn = (_ws, msg) => results.push(msg)
    const ops = createFileOps(sendFn)

    // Call browseFiles through the symlink path
    await ops.browseFiles({}, linkDir, linkDir)

    assert.ok(results.length > 0, 'should return a result')
    assert.equal(results[0].type, 'file_listing')
    assert.equal(results[0].error, null, 'should not return an error')
    const expectedRealPath = await realpath(linkDir)
    assert.equal(results[0].path, expectedRealPath, 'path should resolve to real path')
    const names = results[0].entries.map(e => e.name)
    assert.ok(names.includes('test.txt'), 'entries should contain test.txt')
  })

  it('returns consistent results on repeated calls (cache hit)', async () => {
    const { createFileOps } = await import('../src/ws-file-ops.js')

    const results = []
    const sendFn = (_ws, msg) => results.push(msg)
    const ops = createFileOps(sendFn)

    // Call browseFiles twice — second call should use cached CWD resolution
    await ops.browseFiles({}, linkDir, linkDir)
    await ops.browseFiles({}, linkDir, linkDir)

    assert.equal(results.length, 2, 'should return two results')
    assert.equal(results[0].type, 'file_listing')
    assert.equal(results[1].type, 'file_listing')
    assert.deepEqual(results[0].entries, results[1].entries)
  })

  it('cache implementation uses TTL-based expiry', async () => {
    const { readFile } = await import('node:fs/promises')
    const source = await readFile(
      new URL('../src/ws-file-ops.js', import.meta.url),
      'utf8'
    )

    // Verify structural requirements
    assert.ok(source.includes('_cwdRealCache'), 'should have CWD real path cache')
    assert.ok(source.includes('CWD_CACHE_TTL'), 'should have TTL constant')
    assert.ok(source.includes('60_000'), 'TTL should be 60 seconds')
    assert.match(source, /cached\.ts/, 'should check cached timestamp for expiry')
    assert.match(source, /Date\.now\(\)\s*-\s*cached\.ts/, 'should compare current time against cached timestamp')
  })
})
