import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig } from '../src/config.js'
import { SESSION_ARCHIVE_MAX_ENTRIES } from '../src/session-archive-limits.js'

/**
 * `sessionArchive` config block: shapes are validated, and `maxEntries` is bounded
 * (the roster is one frame and retention is linear in it) with a warning rather
 * than silently honouring a huge value. The SessionArchive constructor clamps it
 * too (tests/session-archive.test.js); this pins the validator's side.
 */
describe('config.sessionArchive', () => {
  it('accepts a well-formed block, including the maximum', () => {
    const r = validateConfig({ sessionArchive: { enabled: true, maxEntries: SESSION_ARCHIVE_MAX_ENTRIES, maxAgeDays: 7, maxMegabytes: 64 } })
    assert.deepEqual(r.warnings, [])
  })

  it('warns when maxEntries is above the maximum, naming the clamp', () => {
    const r = validateConfig({ sessionArchive: { maxEntries: SESSION_ARCHIVE_MAX_ENTRIES + 1 } })
    assert.ok(r.warnings.some((w) => w.includes('sessionArchive.maxEntries') && w.includes(String(SESSION_ARCHIVE_MAX_ENTRIES)) && w.includes('clamped')), JSON.stringify(r.warnings))
  })

  it('still rejects a non-integer / non-positive maxEntries and an unknown key', () => {
    assert.ok(validateConfig({ sessionArchive: { maxEntries: 1.5 } }).warnings.some((w) => w.includes('positive integer')))
    assert.ok(validateConfig({ sessionArchive: { maxEntries: 0 } }).warnings.some((w) => w.includes('positive integer')))
    assert.ok(validateConfig({ sessionArchive: { maxEntrys: 5 } }).warnings.some((w) => w.includes('unknown key')))
  })
})
