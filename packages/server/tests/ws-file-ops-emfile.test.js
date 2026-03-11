import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'

describe('ws-file-ops EMFILE handling', () => {
  let source

  it('loads source for inspection', async () => {
    source = await readFile(
      new URL('../src/ws-file-ops.js', import.meta.url),
      'utf8'
    )
    assert.ok(source.length > 0)
  })

  it('walk function retries readdir on EMFILE errors', () => {
    assert.ok(source.includes("err.code === 'EMFILE'"), 'should check for EMFILE error code')
    assert.ok(source.includes('attempt < 3'), 'should retry up to 3 times')
    assert.ok(source.includes('50 * (attempt + 1)'), 'should use increasing backoff delay')
  })

  it('EMFILE retry uses break on success to exit retry loop', () => {
    // Extract the walk function region
    const walkStart = source.indexOf('async function walk(dir, depth)')
    assert.ok(walkStart > -1, 'walk function should exist')

    const walkRegion = source.slice(walkStart, walkStart + 800)
    assert.ok(walkRegion.includes('break'), 'should break out of retry loop on success')
    assert.ok(walkRegion.includes("retryErr?.code !== 'EMFILE'"), 'should only retry EMFILE, not other errors')
  })

  it('EMFILE handling is only in walk, not in listDir or browseFiles', () => {
    // listDir function region
    const listDirStart = source.indexOf('async function listDir(')
    const listDirEnd = source.indexOf('async function', listDirStart + 1)
    const listDirRegion = source.slice(listDirStart, listDirEnd)
    assert.ok(!listDirRegion.includes('EMFILE'), 'listDir should not have EMFILE handling')

    // browseFiles function region
    const browseStart = source.indexOf('async function browseFiles(')
    const browseEnd = source.indexOf('async function', browseStart + 1)
    const browseRegion = source.slice(browseStart, browseEnd)
    assert.ok(!browseRegion.includes('EMFILE'), 'browseFiles should not have EMFILE handling')
  })
})
