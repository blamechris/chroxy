import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync, statSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { loadJsonState, saveJsonState } from '../src/json-state-file.js'

/**
 * Unit tests for the #5580 JsonStateFile seam — fail-open load + atomic 0600
 * save with a per-pid temp suffix. The save half delegates to
 * writeFileRestricted (platform.js), so these tests focus on the load fail-open
 * contract, the per-pid tmp suffix, and the atomic-write at-rest properties.
 */

const noopLog = { warn() {}, debug() {} }

describe('JsonStateFile (#5580)', () => {
  let dir
  let filePath

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'jsf-'))
    filePath = join(dir, 'state.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  describe('loadJsonState — fail open', () => {
    it('returns the fallback for a missing file', () => {
      const out = loadJsonState(join(dir, 'nope.json'), () => ({ empty: true }), { log: noopLog })
      assert.deepEqual(out, { empty: true })
    })

    it('returns the fallback for malformed JSON', () => {
      writeFileSync(filePath, '{ broken')
      const out = loadJsonState(filePath, () => ({ empty: true }), { log: noopLog })
      assert.deepEqual(out, { empty: true })
    })

    it('returns the fallback for a non-object root when requireObject is set (default)', () => {
      writeFileSync(filePath, '[1,2,3]')
      const out = loadJsonState(filePath, () => ({ empty: true }), { log: noopLog })
      assert.deepEqual(out, { empty: true })
    })

    it('returns the parsed array when requireObject is false', () => {
      writeFileSync(filePath, '[1,2,3]')
      const out = loadJsonState(filePath, () => null, { requireObject: false, log: noopLog })
      assert.deepEqual(out, [1, 2, 3])
    })

    it('returns the parsed object on a clean read', () => {
      writeFileSync(filePath, JSON.stringify({ a: 1, b: 'two' }))
      const out = loadJsonState(filePath, () => ({}), { log: noopLog })
      assert.deepEqual(out, { a: 1, b: 'two' })
    })

    it('the fallback is a fresh container per call (no shared-mutation leak)', () => {
      const a = loadJsonState(join(dir, 'x.json'), () => ({ items: [] }), { log: noopLog })
      a.items.push('mutated')
      const b = loadJsonState(join(dir, 'y.json'), () => ({ items: [] }), { log: noopLog })
      assert.deepEqual(b.items, [])
    })

    it('invokes onError on a parse failure', () => {
      writeFileSync(filePath, '{ broken')
      let stage = null
      loadJsonState(filePath, () => ({}), { log: noopLog, onError: (s) => { stage = s } })
      assert.equal(stage, 'parse')
    })

    it('does not throw or warn on a missing file (ENOENT is normal)', () => {
      let warned = false
      const out = loadJsonState(join(dir, 'absent.json'), () => ({}), { log: { warn() { warned = true } } })
      assert.deepEqual(out, {})
      assert.equal(warned, false)
    })
  })

  describe('saveJsonState — atomic 0600', () => {
    it('writes pretty JSON with a trailing newline by default', () => {
      saveJsonState(filePath, { a: 1 })
      const raw = readFileSync(filePath, 'utf8')
      assert.ok(raw.endsWith('\n'))
      assert.deepEqual(JSON.parse(raw), { a: 1 })
      assert.ok(raw.includes('\n  '), 'pretty-printed (2-space indent)')
    })

    it('writes compact JSON when pretty is false', () => {
      saveJsonState(filePath, { a: 1, b: 2 }, { pretty: false })
      assert.equal(readFileSync(filePath, 'utf8'), '{"a":1,"b":2}')
    })

    it('writes the file at mode 0600 (POSIX)', { skip: process.platform === 'win32' }, () => {
      saveJsonState(filePath, { a: 1 })
      assert.equal(statSync(filePath).mode & 0o777, 0o600)
    })

    it('creates the parent directory if missing', () => {
      const nested = join(dir, 'deep', 'nested', 'state.json')
      saveJsonState(nested, { a: 1 })
      assert.ok(existsSync(nested))
    })

    it('round-trips through loadJsonState', () => {
      saveJsonState(filePath, { version: 1, items: ['x'] })
      const out = loadJsonState(filePath, () => ({}), { log: noopLog })
      assert.deepEqual(out, { version: 1, items: ['x'] })
    })

    it('uses a per-pid temp suffix by default (no fixed .tmp orphan)', () => {
      saveJsonState(filePath, { a: 1 })
      assert.ok(!existsSync(`${filePath}.tmp`), 'no fixed .tmp orphan')
      assert.ok(!existsSync(`${filePath}.${process.pid}.tmp`), 'per-pid tmp renamed away')
    })

    it('honours a caller-supplied tmpSuffix', () => {
      saveJsonState(filePath, { a: 1 }, { tmpSuffix: `.tmp-${process.pid}` })
      assert.ok(existsSync(filePath))
      assert.ok(!existsSync(`${filePath}.tmp-${process.pid}`), 'custom tmp renamed away')
    })

    it('re-throws on a write failure (target is a directory)', () => {
      assert.throws(() => saveJsonState(dir, { a: 1 }), /EISDIR|illegal operation|EEXIST|EPERM/)
    })
  })
})
