import { describe, it, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'

/**
 * Spawn-time binary backstop on a DEFAULT provider (#6708).
 *
 * codex-app-server is a default provider whose child is spawned inside
 * `initialize()`, so a missing/quarantined binary surfaces as an initialize
 * rejection ("codex app-server exited (code=…)") rather than the synchronous
 * ENOENT the exec-path providers throw. `start()` must re-verify the binary and
 * reject with a LABELED, actionable error naming the cause + fix instead of that
 * opaque transport message.
 *
 * This drives the REAL `start()` / client spawn with a deterministically-missing
 * binary path (no real quarantined binary, no module mock). The QUARANTINED
 * branch of the shared labeling helper is proven with an injected verify seam in
 * verify-binary.test.js; here we prove the default-provider WIRING end-to-end.
 *
 * `resolvedBinary` is referenced by the hardcoded class name inside start(), so
 * the override is applied to `CodexAppServerSession` itself and restored after
 * each test. This is the only test file that touches that static, so there is no
 * cross-file race (node runs test files in separate processes).
 */
describe('codex-app-server start() — spawn-time binary backstop (#6708)', () => {
  let restore = null
  const cleanupDirs = []

  afterEach(() => {
    if (restore) { restore(); restore = null }
    while (cleanupDirs.length) rmSync(cleanupDirs.pop(), { recursive: true, force: true })
  })

  function overrideResolvedBinary(path) {
    const original = Object.getOwnPropertyDescriptor(CodexAppServerSession, 'resolvedBinary')
    Object.defineProperty(CodexAppServerSession, 'resolvedBinary', { get: () => path, configurable: true })
    restore = () => Object.defineProperty(CodexAppServerSession, 'resolvedBinary', original)
  }

  function mkSession() {
    const sk = mkdtempSync(join(tmpdir(), 'chroxy-backstop-'))
    cleanupDirs.push(sk)
    return new CodexAppServerSession({ cwd: tmpdir(), skillsDir: sk, repoSkillsDir: null })
  }

  it('rejects with a labeled "not found" error, not the opaque "app-server exited"', async () => {
    // A guaranteed-missing absolute path — verifyBinary → NOT_FOUND on every OS.
    overrideResolvedBinary('/var/empty/__chroxy_missing_codex_6708__')
    const s = mkSession()
    // The client's exit fires a concurrent session `error` event (the mid-session
    // channel). Capture it so Node's unhandled-'error' throw doesn't fail the
    // test, and so we can assert it is ALSO labeled (not the raw ENOENT).
    const errorEvents = []
    s.on('error', (e) => errorEvents.push(e))
    await assert.rejects(
      s.start(),
      (err) => {
        assert.match(err.message, /Failed to start codex app-server/)
        assert.match(err.message, /not found/i)
        // Must NOT surface the raw transport error the operator can't act on.
        assert.doesNotMatch(err.message, /app-server exited \(spawn/)
        return true
      },
    )
    // The concurrent exit-channel error is relabeled too.
    assert.ok(errorEvents.length > 0, 'expected a session error event from the exit channel')
    assert.match(errorEvents[0].message, /not found/i)
    try { s.destroy() } catch { /* best effort */ }
  })
})
