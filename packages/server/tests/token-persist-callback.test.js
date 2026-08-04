import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildTokenPersistCallback } from '../src/server-cli.js'
import { TokenManager } from '../src/token-manager.js'

/**
 * #7055 — the primary-token `onPersist` callback, both limbs.
 *
 * This callback is load-bearing for a security guarantee: #6965 gates the
 * revoke ACK on it settling, and #7045 made it RETHROW so a failed write cannot
 * masquerade as a durable revoke. Until now nothing drove the real thing —
 * #6965's gate tests supply a synthetic `onPersist`, and every local/CI run sets
 * `CHROXY_CRED_DISABLE_KEYCHAIN=1`, so the keychain limb executed NOWHERE.
 *
 * Three couplings are pinned here that no other test can see:
 *
 *   1. `reason` → durability. `'revoke'` is the operator panic button and must
 *      reach `writeFileRestricted` with `durable: true`; a routine `'scheduled'`
 *      rotation is fail-safe and must stay non-durable.
 *
 *   2. The outer `isKeychainAvailable()` guard. `keychain.setToken()` RETURNS
 *      SILENTLY when the keychain is unavailable (keychain.js: `if
 *      (!isKeychainAvailable()) return`) — no throw, no boolean. Without the
 *      outer guard the callback would call it, write NOTHING anywhere, and
 *      resolve as success: a revoke acked for a write that never happened. The
 *      keychain stub below reproduces that silent-return contract exactly, so
 *      deleting the guard makes these tests go red instead of staying green.
 *
 *   3. The seams' DEFAULTS. Injecting all of them pins the callback's shape and
 *      none of the wiring `startServer` actually runs, so the last block drives
 *      `buildTokenPersistCallback({ configFile })` with nothing injected.
 */

/** Records every write the callback performs, by destination. */
function spies({ keychainAvailable, setTokenBehaviour = 'ok', writeResult = { durabilityUnconfirmed: null }, writeThrows = null, writeThrowsRaw = null } = {}) {
  const keychainWrites = []
  const fileWrites = []
  const logged = []
  const available = () => keychainAvailable

  return {
    keychainWrites,
    fileWrites,
    logged,
    seams: {
      logger: { error: (msg) => logged.push(msg) },
      _isKeychainAvailable: available,
      // Mirror of keychain.js `setToken`: it re-checks availability ITSELF and
      // returns silently when unavailable. A stub that always records would
      // hide the very defect this file exists to pin.
      _setToken: (token) => {
        if (setTokenBehaviour === 'throw') throw new Error('keychain add-generic-password failed')
        if (!available()) return
        keychainWrites.push(token)
      },
      _write: (file, body, opts) => {
        // Boxed so a FALSY non-Error (`null`, `undefined`, `''`) is expressible —
        // those are precisely the values that break a bare `err.message`.
        if (writeThrowsRaw) throw writeThrowsRaw.value
        if (writeThrows) throw new Error(writeThrows)
        fileWrites.push({ file, body, opts })
        return writeResult
      },
    },
  }
}

describe('token onPersist callback (#7055)', () => {
  let dir, configFile
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-onpersist-'))
    configFile = join(dir, 'config.json')
    writeFileSync(configFile, JSON.stringify({ apiToken: 'old-token', port: 8765 }, null, 2))
  })
  afterEach(() => { try { rmSync(dir, { recursive: true, force: true }) } catch { /* */ } })

  describe('reason → durability', () => {
    it("a 'revoke' reaches writeFileRestricted with durable: true", () => {
      const s = spies({ keychainAvailable: false })
      buildTokenPersistCallback({ configFile, ...s.seams })('new-token', { reason: 'revoke' })

      assert.equal(s.fileWrites.length, 1, 'the panic button must write the config file')
      assert.equal(s.fileWrites[0].opts.durable, true,
        'a revoke must be fsynced — a power loss inside the writeback window would otherwise resurrect the compromised token')
      assert.equal(JSON.parse(s.fileWrites[0].body).apiToken, 'new-token')
    })

    it("a 'scheduled' rotation stays non-durable", () => {
      const s = spies({ keychainAvailable: false })
      buildTokenPersistCallback({ configFile, ...s.seams })('rotated', { reason: 'scheduled' })

      assert.equal(s.fileWrites.length, 1)
      assert.equal(s.fileWrites[0].opts.durable, false,
        'a scheduled rotation is fail-safe (the old token survives its grace window) — it must not pay the fsync')
    })

    it('an absent reason defaults to non-durable', () => {
      const s = spies({ keychainAvailable: false })
      buildTokenPersistCallback({ configFile, ...s.seams })('rotated')

      assert.equal(s.fileWrites.length, 1)
      assert.equal(s.fileWrites[0].opts.durable, false)
    })
  })

  describe('keychain limb', () => {
    it('an available keychain takes the token and the config file is left alone', () => {
      const s = spies({ keychainAvailable: true })
      buildTokenPersistCallback({ configFile, ...s.seams })('new-token', { reason: 'revoke' })

      assert.deepEqual(s.keychainWrites, ['new-token'])
      assert.equal(s.fileWrites.length, 0, 'the keychain owns the token when it is available')
      assert.equal(JSON.parse(readFileSync(configFile, 'utf-8')).apiToken, 'old-token',
        'and config.json is not rewritten behind the keychain')
    })

    it('a keychain write FAILURE falls back to the config file and still reports success', () => {
      const s = spies({ keychainAvailable: true, setTokenBehaviour: 'throw' })
      assert.doesNotThrow(
        () => buildTokenPersistCallback({ configFile, ...s.seams })('new-token', { reason: 'revoke' }),
        'the file fallback is a real persist — it must not surface as a failed revoke',
      )

      assert.equal(s.keychainWrites.length, 0)
      assert.equal(s.fileWrites.length, 1, 'the fallback must actually write')
      assert.equal(s.fileWrites[0].opts.durable, true, 'the fallback keeps the revoke durable')
      assert.equal(JSON.parse(s.fileWrites[0].body).apiToken, 'new-token')
    })

    it('an UNAVAILABLE keychain never resolves on a write that went nowhere', () => {
      // The whole point: `_setToken` here silently no-ops when unavailable, just
      // like the real one. If the outer availability guard is removed, the
      // callback calls it, nothing is stored ANYWHERE, and it still returns
      // cleanly — a revoke acked for a write that never happened.
      const s = spies({ keychainAvailable: false })
      buildTokenPersistCallback({ configFile, ...s.seams })('new-token', { reason: 'revoke' })

      assert.equal(s.keychainWrites.length, 0, 'nothing can reach an unavailable keychain')
      assert.equal(
        s.keychainWrites.length + s.fileWrites.length, 1,
        'a callback that returns successfully MUST have stored the token somewhere',
      )
      assert.equal(JSON.parse(s.fileWrites[0].body).apiToken, 'new-token')
    })
  })

  describe('failure surfaces (the #7045 rethrow)', () => {
    it('a config-file write failure THROWS rather than returning', () => {
      const s = spies({ keychainAvailable: false, writeThrows: 'EROFS: read-only file system' })
      assert.throws(
        () => buildTokenPersistCallback({ configFile, ...s.seams })('new-token', { reason: 'revoke' }),
        /EROFS/,
        'swallowing this reports a durable revoke that never reached the disk',
      )
      assert.ok(s.logged.some((m) => /Failed to persist token/.test(m)), 'and it is logged for the operator')
    })

    it('a landed-but-durability-unconfirmed revoke THROWS (#7067 caveat reaches the ack gate)', () => {
      const s = spies({ keychainAvailable: false, writeResult: { durabilityUnconfirmed: 'simulated dir fsync EIO' } })
      assert.throws(
        () => buildTokenPersistCallback({ configFile, ...s.seams })('new-token', { reason: 'revoke' }),
        /could not be fsynced|simulated dir fsync/,
      )
    })

    it('a NON-Error failure rethrows the original value instead of a TypeError from the log line', () => {
      // A bare `err.message` on a thrown `null`/`undefined` throws a TypeError
      // from inside the catch: the `Failed to persist token` line never reaches
      // the operator, and the ack gate rejects with a bogus "Cannot read
      // properties of null" instead of the real persist failure.
      const s = spies({ keychainAvailable: false, writeThrowsRaw: { value: null } })
      let thrown = 'nothing was thrown'
      try {
        buildTokenPersistCallback({ configFile, ...s.seams })('new-token', { reason: 'revoke' })
      } catch (err) {
        thrown = err
      }

      assert.equal(thrown, null, 'the ORIGINAL failure must reach the revoke ack gate, not the log line’s own TypeError')
      assert.ok(s.logged.some((m) => /Failed to persist token/.test(m)), 'and the operator still gets the line')
    })

    it('a keychain fallback whose FILE write also fails throws too', () => {
      const s = spies({ keychainAvailable: true, setTokenBehaviour: 'throw', writeThrows: 'ENOSPC' })
      assert.throws(
        () => buildTokenPersistCallback({ configFile, ...s.seams })('new-token', { reason: 'revoke' }),
        /ENOSPC/,
        'the inner keychain catch must not swallow the fallback failure',
      )
    })
  })

  describe('wired into TokenManager (the real revoke path)', () => {
    const managers = []
    afterEach(() => { for (const m of managers.splice(0)) m.destroy() })

    it("revoke()'s `persisted` promise resolves only when the durable write landed", async () => {
      const s = spies({ keychainAvailable: false })
      const manager = new TokenManager({
        token: 'old-token',
        onPersist: buildTokenPersistCallback({ configFile, ...s.seams }),
      })
      managers.push(manager)
      const events = []
      manager.on('token_rotated', (e) => events.push(e))

      const newToken = manager.revoke()
      await events[0].persisted

      assert.equal(s.fileWrites.length, 1)
      assert.equal(s.fileWrites[0].opts.durable, true)
      assert.equal(JSON.parse(s.fileWrites[0].body).apiToken, newToken)
    })

    it("revoke()'s `persisted` promise REJECTS when the write fails", async () => {
      const s = spies({ keychainAvailable: false, writeThrows: 'EIO' })
      const manager = new TokenManager({
        token: 'old-token',
        onPersist: buildTokenPersistCallback({ configFile, ...s.seams }),
      })
      managers.push(manager)
      const events = []
      manager.on('token_rotated', (e) => events.push(e))

      manager.revoke()
      await assert.rejects(events[0].persisted, /EIO/,
        'a rejected persist is what makes WsServer send REVOKE_NOT_DURABLE instead of the success ack')
    })
  })

  describe('production defaults (the seams as `startServer` actually builds them)', () => {
    // Every test above injects ALL of `_isKeychainAvailable`, `_setToken` and
    // `_write`, so it pins the callback's SHAPE and nothing about the wiring the
    // daemon really runs: `onPersist: buildTokenPersistCallback({ configFile })`
    // takes every default. A typo in a default — `_write` bound to a writer that
    // skips the 0600 temp+rename, `_isKeychainAvailable` stuck at `() => true` —
    // would leave all eleven of those tests green while the daemon persisted the
    // rotated token nowhere. Swapping each default for a broken stand-in was
    // confirmed to change no result, which is exactly the false-safety #7055
    // exists to close, so these two drive the defaults directly.
    //
    // `tests/_setup.mjs` sets `CHROXY_DISABLE_KEYCHAIN=1` process-wide and
    // keychain.js reads it lazily; each test re-asserts it so it can never shell
    // out to the developer's real `security`/`secret-tool` even if the harness
    // stops setting it.
    let restoreKeychainEnv
    beforeEach(() => {
      restoreKeychainEnv = process.env.CHROXY_DISABLE_KEYCHAIN
      process.env.CHROXY_DISABLE_KEYCHAIN = '1'
    })
    afterEach(() => {
      if (restoreKeychainEnv === undefined) delete process.env.CHROXY_DISABLE_KEYCHAIN
      else process.env.CHROXY_DISABLE_KEYCHAIN = restoreKeychainEnv
    })

    it('with NO seams injected the real writer lands the token in the real config file', () => {
      buildTokenPersistCallback({ configFile })('defaulted-token', { reason: 'revoke' })

      const cfg = JSON.parse(readFileSync(configFile, 'utf-8'))
      assert.equal(cfg.apiToken, 'defaulted-token',
        'the daemon builds this callback with no seams at all — if the defaults are not the real keychain probe and the real restricted writer, a rotation persists nowhere')
      assert.equal(cfg.port, 8765, 'and the rest of config.json survives the rewrite')
      if (process.platform !== 'win32') {
        assert.equal(statSync(configFile).mode & 0o777, 0o600,
          'the default writer must be writeFileRestricted — config.json holds the primary bearer token')
      }
    })

    it('a defaulted keychain limb returns SILENTLY and stores nothing when the keychain is unavailable', () => {
      // Force the availability probe true while leaving `_setToken` defaulted:
      // the REAL setToken re-checks availability itself and returns without
      // throwing and without storing anything. That silent-return is the premise
      // the stub at the top of this file encodes and the reason the outer guard
      // exists; assert it against the real function so the stub cannot drift
      // from it unnoticed.
      //
      // Honest limit: with the keychain unavailable this cannot tell the real
      // `setToken` apart from any other silent no-op — the available branch
      // needs an actual OS keychain, which is `keychain.test.js`'s opt-in
      // `CHROXY_TEST_REAL_KEYCHAIN=1` territory and must never run by default
      // (it pollutes the developer's login keychain and can pop a modal).
      assert.doesNotThrow(
        () => buildTokenPersistCallback({ configFile, _isKeychainAvailable: () => true })('never-stored', { reason: 'revoke' }),
        'the real setToken does not signal failure — no throw, no boolean',
      )
      assert.equal(JSON.parse(readFileSync(configFile, 'utf-8')).apiToken, 'old-token',
        'nothing reached the keychain and nothing reached the file: a revoke that would have acked a write that never happened, which is what the outer guard prevents')
    })
  })
})
