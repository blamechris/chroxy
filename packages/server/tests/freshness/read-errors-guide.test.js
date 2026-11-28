import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { FILE_LEVEL_READ_ERRORS, isFileLevelReadError, isSourceLevelError } from '../../src/freshness/read-errors.js'

const GUIDE = fileURLToPath(new URL('../../../../docs/guides/freshness-reconciler.md', import.meta.url))
const HEADING = '#### Read errors: the source or one file'

/** The codes the guide lists as file-level: the bullets after the "File-level codes" line of its section. */
function guideFileLevelCodes(text) {
  const lines = text.split('\n')
  const start = lines.indexOf(HEADING)
  assert.ok(start >= 0, 'guide section heading is missing')
  let end = lines.findIndex((l, i) => i > start && /^#{1,6} /.test(l))
  if (end < 0) end = lines.length
  const section = lines.slice(start + 1, end)
  const at = section.findIndex((l) => l.startsWith('File-level codes'))
  assert.ok(at >= 0, 'guide has no File-level codes line')
  const codes = []
  for (const l of section.slice(at + 1)) {
    if (l.trim() === '' && codes.length === 0) continue
    const m = /^- `([a-z_]+)`$/.exec(l)
    if (!m) break
    codes.push(m[1])
  }
  return codes
}

const diff = (a, b) => a.filter((x) => !b.includes(x))

describe('file-level read errors: the guide and the code agree', () => {
  it('every code in the guide is in the set and every code in the set is in the guide', () => {
    const doc = guideFileLevelCodes(readFileSync(GUIDE, 'utf8'))
    assert.equal(new Set(doc).size, doc.length, 'a code is listed twice')
    const set = [...FILE_LEVEL_READ_ERRORS]
    assert.deepEqual(diff(doc, set), [], 'in the guide, not in the set')
    assert.deepEqual(diff(set, doc), [], 'in the set, not in the guide')
    assert.ok(doc.length > 0)
  })

  it('the comparison goes red when a code is added to only one side', () => {
    const text = readFileSync(GUIDE, 'utf8')
    const doc = guideFileLevelCodes(text)
    const set = [...FILE_LEVEL_READ_ERRORS]
    const withExtra = guideFileLevelCodes(text.replace('- `shape_changed`\n', '- `shape_changed`\n- `invented_code`\n'))
    assert.deepEqual(diff(withExtra, set), ['invented_code'])
    assert.deepEqual(diff(set, doc.filter((c) => c !== 'corrupt')), ['corrupt'])
  })

  it('the predicates fail safe', () => {
    for (const c of FILE_LEVEL_READ_ERRORS) assert.ok(isFileLevelReadError(c))
    for (const c of ['unreadable', 'source_missing', 'unsupported', 'adapter_fault', 'timeout', 'future_code', null, undefined, 7]) assert.equal(isFileLevelReadError(c), false)
    assert.equal(isSourceLevelError({ outcome: 'error', errorCode: 'window_exhausted' }), false)
    assert.equal(isSourceLevelError({ outcome: 'error', errorCode: 'unreadable' }), true)
    assert.equal(isSourceLevelError({ outcome: 'error', errorCode: null }), true)
    assert.equal(isSourceLevelError({ outcome: 'ok', errorCode: 'unreadable' }), false)
    assert.equal(isSourceLevelError(null), false)
  })
})
