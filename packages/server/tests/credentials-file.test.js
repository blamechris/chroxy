import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, chmodSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { readCredentialJsonField } from '../src/credentials-file.js'

/**
 * Unit coverage for the shared 0600-gated credentials reader (#4144 security
 * boundary). Temp files live under tmpdir(), never the real ~/.chroxy (the
 * tests/_setup.mjs sandbox guard would block that). The mode check reads the
 * file's permission BITS (stat.mode & 0o777), not an access attempt, so it
 * behaves identically as root — no POSIX_PERM_SKIP needed.
 */

describe('readCredentialJsonField', () => {
  let dir
  let path

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-cred-test-'))
    path = join(dir, 'credentials.json')
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('returns code:enoent when the file does not exist', () => {
    const res = readCredentialJsonField(join(dir, 'nope.json'), 'anthropicApiKey')
    assert.equal(res.key, null)
    assert.equal(res.code, 'enoent')
    assert.match(res.reason, /does not exist/)
  })

  it('refuses a file more permissive than 0600 (code:mode) with a chmod hint', () => {
    writeFileSync(path, JSON.stringify({ anthropicApiKey: 'sk-secret' }))
    chmodSync(path, 0o644)
    const res = readCredentialJsonField(path, 'anthropicApiKey')
    assert.equal(res.key, null)
    assert.equal(res.code, 'mode')
    assert.match(res.reason, /mode 644/)
    assert.match(res.reason, /chmod 600/)
  })

  it('returns code:parse for non-JSON at 0600', () => {
    writeFileSync(path, 'not json {{{')
    chmodSync(path, 0o600)
    const res = readCredentialJsonField(path, 'anthropicApiKey')
    assert.equal(res.key, null)
    assert.equal(res.code, 'parse')
    assert.match(res.reason, /not valid JSON/)
  })

  it('returns code:missing when the field is absent or empty at 0600', () => {
    writeFileSync(path, JSON.stringify({ other: 'x', anthropicApiKey: '' }))
    chmodSync(path, 0o600)
    const absent = readCredentialJsonField(path, 'deepseekApiKey')
    assert.equal(absent.code, 'missing')
    const empty = readCredentialJsonField(path, 'anthropicApiKey')
    assert.equal(empty.code, 'missing')
    assert.match(empty.reason, /missing or empty "anthropicApiKey"/)
  })

  it('returns the key on a well-formed 0600 file', () => {
    writeFileSync(path, JSON.stringify({ anthropicApiKey: 'sk-ant-123', noise: 1 }))
    chmodSync(path, 0o600)
    const res = readCredentialJsonField(path, 'anthropicApiKey')
    assert.deepEqual(res, { key: 'sk-ant-123' })
  })
})
