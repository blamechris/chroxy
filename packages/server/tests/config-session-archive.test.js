import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { validateConfig, validateSessionArchivePolicy, writeSessionArchiveToConfig } from '../src/config.js'
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

describe('validateSessionArchivePolicy (#8869 setter rules)', () => {
  const ok = { enabled: true, maxEntries: 100, maxAgeDays: 30, maxMegabytes: 256 }
  it('accepts a valid policy including the maximum and fractional age/size', () => {
    assert.equal(validateSessionArchivePolicy(ok), null)
    assert.equal(validateSessionArchivePolicy({ ...ok, maxEntries: SESSION_ARCHIVE_MAX_ENTRIES, maxAgeDays: 0.5, maxMegabytes: 1.5 }), null)
  })
  it('REJECTS maxEntries above the max (config loading clamps; the setter must not), naming the max', () => {
    const p = validateSessionArchivePolicy({ ...ok, maxEntries: SESSION_ARCHIVE_MAX_ENTRIES + 1 })
    assert.equal(p.field, 'maxEntries')
    assert.ok(p.message.includes(String(SESSION_ARCHIVE_MAX_ENTRIES)), p.message)
  })
  it('names the offending field for every bad value, and requires all four', () => {
    for (const [patch, field] of [
      [{ enabled: 'yes' }, 'enabled'], [{ enabled: undefined }, 'enabled'],
      [{ maxEntries: 0 }, 'maxEntries'], [{ maxEntries: 1.5 }, 'maxEntries'], [{ maxEntries: '5' }, 'maxEntries'],
      [{ maxAgeDays: 0 }, 'maxAgeDays'], [{ maxAgeDays: Infinity }, 'maxAgeDays'], [{ maxAgeDays: NaN }, 'maxAgeDays'],
      [{ maxMegabytes: -1 }, 'maxMegabytes'], [{ maxMegabytes: undefined }, 'maxMegabytes'],
    ]) {
      assert.equal(validateSessionArchivePolicy({ ...ok, ...patch })?.field, field, JSON.stringify(patch))
    }
    assert.equal(validateSessionArchivePolicy(null).field, 'policy')
  })
})

describe('writeSessionArchiveToConfig (#8869)', () => {
  const TMP = mkdtempSync(join(tmpdir(), 'chroxy-archive-cfg-'))
  let n = 0
  const path = () => join(TMP, `c${++n}.json`)
  const policy = { enabled: false, maxEntries: 7, maxAgeDays: 2, maxMegabytes: 3 }

  it('creates the file with exactly the four keys', () => {
    const p = path()
    writeSessionArchiveToConfig(policy, p)
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf-8')), { sessionArchive: policy })
  })
  it('preserves unrelated keys and unknown keys inside sessionArchive', () => {
    const p = path()
    writeFileSync(p, JSON.stringify({ port: 9, features: { x: 1 }, sessionArchive: { enabled: true, maxEntries: 1, futureKnob: 'keep' } }))
    writeSessionArchiveToConfig(policy, p)
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf-8')), { port: 9, features: { x: 1 }, sessionArchive: { ...policy, futureKnob: 'keep' } })
  })
  it('repairs a non-object sessionArchive in place', () => {
    const p = path()
    writeFileSync(p, JSON.stringify({ port: 9, sessionArchive: 'oops' }))
    writeSessionArchiveToConfig(policy, p)
    assert.deepEqual(JSON.parse(readFileSync(p, 'utf-8')), { port: 9, sessionArchive: policy })
  })
  it('refuses a malformed existing config and leaves it untouched', () => {
    const p = path()
    writeFileSync(p, '{ not json')
    assert.throws(() => writeSessionArchiveToConfig(policy, p), /Refusing to overwrite/)
    assert.equal(readFileSync(p, 'utf-8'), '{ not json')
  })
  it('cleanup', () => { rmSync(TMP, { recursive: true, force: true }) })
})
