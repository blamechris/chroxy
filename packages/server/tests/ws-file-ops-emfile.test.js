import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'fs'
import { fileURLToPath } from 'url'
import { dirname, join } from 'path'

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

describe('listFiles EMFILE handling (#1970)', () => {
  const src = readFileSync(join(__dirname, '../src/ws-file-ops.js'), 'utf-8')

  it('walk function handles EMFILE with retry', () => {
    const walkStart = src.indexOf('async function walk(dir, depth)')
    assert.ok(walkStart > 0, 'walk function should exist')

    const walkBody = src.slice(walkStart, walkStart + 800)
    assert.ok(walkBody.includes('EMFILE'),
      'walk should check for EMFILE error code')
    assert.ok(walkBody.includes('attempt') || walkBody.includes('retry'),
      'walk should have retry logic for EMFILE')
  })

  it('uses backoff delay between EMFILE retries', () => {
    const walkStart = src.indexOf('async function walk(dir, depth)')
    const walkBody = src.slice(walkStart, walkStart + 800)
    assert.ok(walkBody.includes('setTimeout'),
      'Should use setTimeout for backoff between retries')
  })
})
