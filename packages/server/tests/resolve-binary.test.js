import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { resolveBinary } from '../src/utils/resolve-binary.js'

describe('resolveBinary', () => {
  it('returns an absolute path for a binary that is on PATH', () => {
    // `node` is always on PATH when running these tests
    const result = resolveBinary('node', [])
    assert.ok(result.startsWith('/'), `expected absolute path, got: ${result}`)
  })

  it('returns the binary name as-is when not found anywhere', () => {
    const result = resolveBinary('__chroxy_nonexistent_binary__', [])
    assert.equal(result, '__chroxy_nonexistent_binary__')
  })

  it('falls back to a candidate path when binary is not on PATH', () => {
    // Use a binary unlikely to be named exactly this on PATH but whose
    // absolute path we can supply via the candidates list.
    // We resolve `node` via which first to get its real path, then pass
    // a mangled name with the real path as a candidate.
    const nodePath = resolveBinary('node', [])
    assert.ok(nodePath.startsWith('/'), 'precondition: node must be findable')

    // Now ask for the same binary via a fake name but its known path
    const result = resolveBinary('__fake_name_for_test__', [nodePath])
    assert.equal(result, nodePath)
  })

  it('returns the first matching candidate when multiple are provided', () => {
    const nodePath = resolveBinary('node', [])

    // Prepend a non-existent path so the function advances to the second
    const result = resolveBinary('__fake_name_for_test__', [
      '/does/not/exist/at/all',
      nodePath,
      '/another/nonexistent',
    ])
    assert.equal(result, nodePath)
  })

  it('skips candidate paths that do not exist', () => {
    const result = resolveBinary('__fake_name_for_test__', [
      '/does/not/exist/a',
      '/does/not/exist/b',
    ])
    // No candidates matched, so bare name is returned
    assert.equal(result, '__fake_name_for_test__')
  })

  it('returns a string in all cases', () => {
    const r1 = resolveBinary('node', [])
    const r2 = resolveBinary('__definitely_missing__', [])
    const r3 = resolveBinary('__definitely_missing__', ['/nonexistent'])
    assert.equal(typeof r1, 'string')
    assert.equal(typeof r2, 'string')
    assert.equal(typeof r3, 'string')
  })

  it('handles an empty candidates array gracefully', () => {
    const result = resolveBinary('__missing__', [])
    assert.equal(result, '__missing__')
  })
})
