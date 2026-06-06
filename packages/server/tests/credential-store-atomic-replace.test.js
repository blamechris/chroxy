import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, readFileSync, existsSync, rmSync, renameSync, unlinkSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  replaceFileAtomically,
  setStoredCredential,
  getStoredCredential,
  _setCredentialLoggerForTests,
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

  it('#5258: win32 retries once after a held-handle lock (EEXIST) and succeeds', () => {
    const target = join(dir, 'c.json')
    const tmp = join(dir, 'c.json.tmp')
    writeFileSync(target, 'OLD')
    writeFileSync(tmp, 'NEW')
    let attempts = 0
    let unlinkedTarget = false
    replaceFileAtomically(tmp, target, {
      platform: 'win32',
      rename: (from, to) => {
        attempts++
        if (attempts === 1) { const e = new Error('EEXIST: handle held'); e.code = 'EEXIST'; throw e }
        renameSync(from, to)
      },
      unlink: (p) => { if (p === target) unlinkedTarget = true; unlinkSync(p) },
    })
    assert.equal(attempts, 2, 'exactly one retry')
    assert.ok(unlinkedTarget, 'target unlinked before the retry (after the atomic attempt, not before)')
    assert.equal(readFileSync(target, 'utf8'), 'NEW')
  })

  it('#5258: win32 restores the live file if the retry also fails', () => {
    const target = join(dir, 'c.json')
    const tmp = join(dir, 'c.json.tmp')
    writeFileSync(target, 'LIVE')
    writeFileSync(tmp, 'NEW')
    // Both the atomic attempt and the post-unlink retry fail (handle never
    // releases). Default unlink/readFile/writeFile are real fs, so this
    // exercises the snapshot → unlink → restore path end-to-end.
    assert.throws(() => {
      replaceFileAtomically(tmp, target, {
        platform: 'win32',
        rename: () => { const e = new Error('EBUSY: locked'); e.code = 'EBUSY'; throw e },
      })
    }, /EBUSY/)
    assert.ok(existsSync(target), 'live file restored after retry failure')
    assert.equal(readFileSync(target, 'utf8'), 'LIVE', 'prior credentials survive a doubly-failed replace')
  })

  it('#5258: win32 does NOT unlink when the snapshot read fails but the target still exists', () => {
    const target = join(dir, 'c.json')
    const tmp = join(dir, 'c.json.tmp')
    writeFileSync(target, 'LIVE')
    writeFileSync(tmp, 'NEW')
    // The held handle also blocks the snapshot read (readFile throws EACCES) while
    // the file is still present on disk. Unlinking it here would destroy the only
    // copy with no restore possible — so we must surface the ORIGINAL lock error
    // and leave the live file untouched (no unlink, no retry).
    let unlinkCalled = false
    let retryAttempts = 0
    assert.throws(() => {
      replaceFileAtomically(tmp, target, {
        platform: 'win32',
        rename: () => { retryAttempts++; const e = new Error('EPERM: locked'); e.code = 'EPERM'; throw e },
        readFile: () => { const e = new Error('EACCES: read blocked'); e.code = 'EACCES'; throw e },
        unlink: () => { unlinkCalled = true },
      })
    }, /EPERM/)
    assert.equal(retryAttempts, 1, 'only the initial atomic attempt — no destructive retry')
    assert.equal(unlinkCalled, false, 'must not unlink a present target it could not snapshot')
    assert.ok(existsSync(target), 'live file untouched')
    assert.equal(readFileSync(target, 'utf8'), 'LIVE', 'prior credentials survive when the snapshot fails')
  })

  it('#5258: win32 does NOT retry a non-lock error (e.g. ENOSPC) — surfaces immediately', () => {
    const target = join(dir, 'c.json')
    const tmp = join(dir, 'c.json.tmp')
    writeFileSync(target, 'LIVE')
    writeFileSync(tmp, 'NEW')
    let unlinkCalled = false
    assert.throws(() => {
      replaceFileAtomically(tmp, target, {
        platform: 'win32',
        rename: () => { const e = new Error('ENOSPC: disk full'); e.code = 'ENOSPC'; throw e },
        unlink: () => { unlinkCalled = true },
      })
    }, /ENOSPC/)
    assert.equal(unlinkCalled, false, 'a non-lock error must not trigger the destructive retry')
    assert.ok(existsSync(target), 'live file untouched')
  })
})

describe('credential-store — set overwrites an existing file safely (#5243)', () => {
  // os.homedir() reads HOME on POSIX but USERPROFILE on win32, so point both at
  // the tmp dir (and restore both) to keep the suite off the real home on every
  // platform. Save/restore must delete a var that was originally unset rather
  // than assign `undefined` (which would set the literal string "undefined").
  let tmpHome
  const HOME_ENV_VARS = ['HOME', 'USERPROFILE']
  const CRED_ENV_VARS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'GEMINI_API_KEY', 'OPENAI_API_KEY']
  const saved = {}
  const restoreEnv = (k) => { if (saved[k] === undefined) delete process.env[k]; else process.env[k] = saved[k] }

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-cred-set-'))
    for (const k of HOME_ENV_VARS) { saved[k] = process.env[k]; process.env[k] = tmpHome }
    for (const k of CRED_ENV_VARS) { saved[k] = process.env[k]; delete process.env[k] }
  })
  afterEach(() => {
    for (const k of HOME_ENV_VARS) restoreEnv(k)
    for (const k of CRED_ENV_VARS) restoreEnv(k)
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

describe('credential-store — replaceFileAtomically win32 warn logging (#5264)', () => {
  let dir
  let warnings
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-cred-warn-'))
    warnings = []
    // Capture-only logger. warn() records the message so we can assert on it;
    // the other levels are no-ops. The credential value must never appear here.
    _setCredentialLoggerForTests({
      warn: (m) => warnings.push(m),
      info: () => {},
      error: () => {},
      debug: () => {},
    })
  })
  afterEach(() => {
    _setCredentialLoggerForTests(null)
    try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ }
  })

  it('warns once on entering the retry after a held-handle lock, then succeeds (no value leaked)', () => {
    const target = join(dir, 'c.json')
    const tmp = join(dir, 'c.json.tmp')
    writeFileSync(target, 'LIVE-SECRET-VALUE')
    writeFileSync(tmp, 'NEW')
    let attempts = 0
    replaceFileAtomically(tmp, target, {
      platform: 'win32',
      rename: (from, to) => {
        attempts++
        if (attempts === 1) { const e = new Error('EBUSY: handle held'); e.code = 'EBUSY'; throw e }
        renameSync(from, to)
      },
    })
    assert.equal(attempts, 2, 'one retry')
    const retryWarns = warnings.filter((w) => /one-shot retry/.test(w))
    assert.equal(retryWarns.length, 1, 'exactly one retry warn')
    assert.match(retryWarns[0], /EBUSY/, 'logs the error code')
    // No restore warn on the success path.
    assert.equal(warnings.filter((w) => /restore/.test(w)).length, 0)
    // The credential value must never reach the logger.
    assert.ok(!warnings.some((w) => w.includes('LIVE-SECRET-VALUE')), 'credential value never logged')
  })

  it('warns on the refuse-to-unlink safety stop when the snapshot read fails', () => {
    const target = join(dir, 'c.json')
    const tmp = join(dir, 'c.json.tmp')
    writeFileSync(target, 'LIVE')
    writeFileSync(tmp, 'NEW')
    assert.throws(() => {
      replaceFileAtomically(tmp, target, {
        platform: 'win32',
        rename: () => { const e = new Error('EPERM: locked'); e.code = 'EPERM'; throw e },
        readFile: () => { const e = new Error('EACCES: read blocked'); e.code = 'EACCES'; throw e },
        unlink: () => { throw new Error('unlink must not be called') },
      })
    }, /EPERM/)
    assert.equal(warnings.filter((w) => /could not snapshot/.test(w)).length, 1, 'one refuse-to-unlink warn')
    assert.match(warnings.find((w) => /could not snapshot/.test(w)), /EPERM/)
  })

  it('warns when the restore also fails after a failed retry (codes only)', () => {
    const target = join(dir, 'c.json')
    const tmp = join(dir, 'c.json.tmp')
    writeFileSync(target, 'LIVE')
    writeFileSync(tmp, 'NEW')
    assert.throws(() => {
      replaceFileAtomically(tmp, target, {
        platform: 'win32',
        rename: () => { const e = new Error('EBUSY: locked'); e.code = 'EBUSY'; throw e },
        // Snapshot succeeds (captures live bytes), unlink succeeds, retry fails,
        // and the restore write fails too — the worst-case silent path.
        readFile: () => Buffer.from('LIVE'),
        unlink: () => {},
        writeFile: () => { const e = new Error('ENOSPC: disk full'); e.code = 'ENOSPC'; throw e },
      })
    }, /EBUSY/)
    const restoreWarns = warnings.filter((w) => /failed to restore/.test(w))
    assert.equal(restoreWarns.length, 1, 'one failed-restore warn')
    assert.match(restoreWarns[0], /ENOSPC/, 'logs the restore error code')
  })

  it('does not warn at all on a clean non-win32 failure (no retry path entered)', () => {
    const target = join(dir, 'c.json')
    const tmp = join(dir, 'c.json.tmp')
    writeFileSync(target, 'LIVE')
    writeFileSync(tmp, 'NEW')
    assert.throws(() => {
      replaceFileAtomically(tmp, target, {
        platform: 'linux',
        rename: () => { const e = new Error('EBUSY: locked'); e.code = 'EBUSY'; throw e },
      })
    }, /EBUSY/)
    assert.equal(warnings.length, 0, 'no win32 retry warns on a non-win32 platform')
  })
})
