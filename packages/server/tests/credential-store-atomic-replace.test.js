import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  replaceFileAtomically,
  setStoredCredential,
  getStoredCredential,
} from '../src/credential-store.js'

/**
 * #5243 — credential-store atomic replace.
 *
 * The win32 write path used to `unlinkSync(target)` immediately BEFORE the
 * rename, so a crash in that window destroyed the live `credentials.json`
 * before the replacement was moved in (data loss). `replaceFileAtomically`
 * now relies on `renameSync`'s atomic replace and never pre-deletes the live
 * file. These tests pin:
 *   - a real overwrite replaces the target's content via a single rename
 *   - a FAILED replace leaves the live target intact (no pre-delete) — the
 *     core data-loss guarantee, platform-independent
 *   - the end-to-end set path overwrites an existing credentials file safely
 *
 * HOME points at a tmpdir so the real ~/.chroxy/credentials.json is untouched.
 */

describe('credential-store — replaceFileAtomically (#5243)', () => {
  let dir
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), 'chroxy-cred-atomic-')) })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ } })

  it('replaces an existing target with the temp file content via one rename', () => {
    const target = join(dir, 'creds.json')
    const tmp = join(dir, 'creds.json.tmp')
    writeFileSync(target, 'OLD')
    writeFileSync(tmp, 'NEW')

    let renameCalls = 0
    replaceFileAtomically(tmp, target, {
      rename: (from, to) => { renameCalls++; assert.equal(from, tmp); assert.equal(to, target); renameSync(from, to) },
    })
    assert.equal(renameCalls, 1, 'exactly one rename')
    assert.equal(readFileSync(target, 'utf8'), 'NEW')
    assert.ok(!existsSync(tmp), 'temp file moved away')
  })

  it('uses the real fs by default (no injected deps)', () => {
    const target = join(dir, 'd.json')
    const tmp = join(dir, 'd.json.tmp')
    writeFileSync(target, 'OLD')
    writeFileSync(tmp, 'NEW')
    replaceFileAtomically(tmp, target)
    assert.equal(readFileSync(target, 'utf8'), 'NEW')
  })

  it('a failed replace leaves the live target intact — never pre-deletes it (#5243 core guarantee)', () => {
    const target = join(dir, 'creds.json')
    const tmp = join(dir, 'creds.json.tmp')
    writeFileSync(target, 'LIVE-CREDENTIALS')
    writeFileSync(tmp, 'REPLACEMENT')

    // Simulate the rename failing (a lock, a crash-equivalent). The old code
    // would have already unlinked `target` by this point; the new code must
    // not have touched it.
    assert.throws(() => {
      replaceFileAtomically(tmp, target, {
        rename: () => { throw new Error('EBUSY: target locked') },
      })
    }, /EBUSY/)

    assert.ok(existsSync(target), 'live target must still exist after a failed replace')
    assert.equal(readFileSync(target, 'utf8'), 'LIVE-CREDENTIALS', 'live content must be preserved')
  })
})

describe('credential-store — set overwrites an existing file safely (#5243)', () => {
  let tmpHome, originalHome
  const CRED_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'OPENAI_API_KEY']
  const saved = {}

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-cred-set-'))
    originalHome = process.env.HOME
    process.env.HOME = tmpHome
    for (const k of CRED_ENV_VARS) { saved[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    process.env.HOME = originalHome
    for (const k of CRED_ENV_VARS) { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }
    try { rmSync(tmpHome, { recursive: true, force: true }) } catch { /* */ }
  })

  it('overwriting a credential preserves a readable store at every step', () => {
    setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-first')
    assert.equal(getStoredCredential('ANTHROPIC_API_KEY'), 'sk-ant-first')
    // Overwrite — exercises writeStoreAtomically → replaceFileAtomically over an
    // existing file. The store must end up with the new value and stay readable.
    setStoredCredential('ANTHROPIC_API_KEY', 'sk-ant-second')
    assert.equal(getStoredCredential('ANTHROPIC_API_KEY'), 'sk-ant-second')
  })
})
