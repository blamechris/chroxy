import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readRegistry, recordShell, forgetShell, reapOrphanShells } from '../src/user-shell-registry.js'

describe('user-shell-registry (#6276)', () => {
  let dir
  let sidecar
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-ush-reg-'))
    sidecar = join(dir, 'user-shells.json')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  describe('record / forget', () => {
    it('records a shell and reads it back (shell stored as basename only)', () => {
      recordShell(sidecar, { sessionId: 's1', pid: 4242, shell: '/bin/zsh' })
      assert.deepEqual(readRegistry(sidecar), [{ sessionId: 's1', pid: 4242, shell: 'zsh' }])
    })

    it('replaces the record for the same sessionId (idempotent respawn)', () => {
      recordShell(sidecar, { sessionId: 's1', pid: 1, shell: '/bin/zsh' })
      recordShell(sidecar, { sessionId: 's1', pid: 2, shell: '/bin/zsh' })
      const recs = readRegistry(sidecar)
      assert.equal(recs.length, 1)
      assert.equal(recs[0].pid, 2)
    })

    it('ignores a record with a non-positive / non-integer pid', () => {
      recordShell(sidecar, { sessionId: 's1', pid: 0, shell: 'zsh' })
      recordShell(sidecar, { sessionId: 's2', pid: -5, shell: 'zsh' })
      recordShell(sidecar, { sessionId: 's3', pid: 1.5, shell: 'zsh' })
      assert.deepEqual(readRegistry(sidecar), [])
    })

    it('forget removes one record, keeping the others', () => {
      recordShell(sidecar, { sessionId: 's1', pid: 11, shell: 'zsh' })
      recordShell(sidecar, { sessionId: 's2', pid: 22, shell: 'bash' })
      forgetShell(sidecar, 's1')
      assert.deepEqual(readRegistry(sidecar).map((r) => r.sessionId), ['s2'])
    })

    it('forget deletes the file once empty (clean shutdown leaves no sidecar)', () => {
      recordShell(sidecar, { sessionId: 's1', pid: 11, shell: 'zsh' })
      forgetShell(sidecar, 's1')
      assert.equal(existsSync(sidecar), false)
    })

    it('forget on an unknown sessionId is a no-op', () => {
      recordShell(sidecar, { sessionId: 's1', pid: 11, shell: 'zsh' })
      forgetShell(sidecar, 'nope')
      assert.deepEqual(readRegistry(sidecar).map((r) => r.sessionId), ['s1'])
    })
  })

  describe('readRegistry tolerates bad input', () => {
    it('returns [] for a missing file', () => {
      assert.deepEqual(readRegistry(sidecar), [])
    })
    it('returns [] for corrupt JSON', () => {
      writeFileSync(sidecar, '{not json')
      assert.deepEqual(readRegistry(sidecar), [])
    })
    it('filters out malformed entries', () => {
      writeFileSync(sidecar, JSON.stringify([
        { sessionId: 's1', pid: 5, shell: 'zsh' },
        { pid: 'x' },
        null,
        { sessionId: 's2' },
      ]))
      assert.deepEqual(readRegistry(sidecar).map((r) => r.sessionId), ['s1'])
    })
  })

  describe('reapOrphanShells', () => {
    const seams = (over = {}) => ({ isAlive: () => true, commOf: () => 'zsh', kill: () => true, ...over })

    it('SIGTERMs a live shell whose comm matches, and reports it reaped', () => {
      recordShell(sidecar, { sessionId: 's1', pid: 100, shell: '/bin/zsh' })
      const killed = []
      const { reaped, skipped } = reapOrphanShells(sidecar, seams({ kill: (pid) => { killed.push(pid); return true } }))
      assert.deepEqual(killed, [100])
      assert.equal(reaped.length, 1)
      assert.equal(reaped[0].sessionId, 's1')
      assert.equal(skipped.length, 0)
    })

    it('clears the sidecar after running (this instance starts fresh)', () => {
      recordShell(sidecar, { sessionId: 's1', pid: 100, shell: 'zsh' })
      reapOrphanShells(sidecar, seams())
      assert.equal(existsSync(sidecar), false)
    })

    it('skips a dead pid without killing (never signal a gone process)', () => {
      recordShell(sidecar, { sessionId: 's1', pid: 100, shell: 'zsh' })
      const killed = []
      const { reaped, skipped } = reapOrphanShells(sidecar, seams({ isAlive: () => false, kill: (p) => { killed.push(p); return true } }))
      assert.deepEqual(killed, [])
      assert.equal(reaped.length, 0)
      assert.equal(skipped[0].why, 'dead')
    })

    it('PID-reuse safety: skips a live pid whose comm no longer matches the shell', () => {
      recordShell(sidecar, { sessionId: 's1', pid: 100, shell: 'zsh' })
      const killed = []
      const { reaped, skipped } = reapOrphanShells(sidecar, seams({ commOf: () => 'postgres', kill: (p) => { killed.push(p); return true } }))
      assert.deepEqual(killed, [], 'must NOT signal a reused pid running a different program')
      assert.equal(reaped.length, 0)
      assert.equal(skipped[0].why, 'comm-mismatch')
      assert.equal(skipped[0].comm, 'postgres')
    })

    it('skips when comm is unknown (cannot positively identify the process)', () => {
      recordShell(sidecar, { sessionId: 's1', pid: 100, shell: 'zsh' })
      const { reaped, skipped } = reapOrphanShells(sidecar, seams({
        commOf: () => null,
        kill: () => { throw new Error('must not attempt to kill an unidentifiable pid') },
      }))
      assert.equal(reaped.length, 0)
      assert.equal(skipped[0].why, 'comm-unknown')
    })

    it('records a failed kill as skipped, not reaped', () => {
      recordShell(sidecar, { sessionId: 's1', pid: 100, shell: 'zsh' })
      const { reaped, skipped } = reapOrphanShells(sidecar, seams({ kill: () => false }))
      assert.equal(reaped.length, 0)
      assert.equal(skipped[0].why, 'kill-failed')
    })

    it('matches comm by basename (ps may return a full path)', () => {
      recordShell(sidecar, { sessionId: 's1', pid: 100, shell: '/opt/homebrew/bin/fish' })
      const killed = []
      reapOrphanShells(sidecar, seams({ commOf: () => '/opt/homebrew/bin/fish', kill: (p) => { killed.push(p); return true } }))
      assert.deepEqual(killed, [100])
    })

    it('reaps a record with no recorded shell (no comm gate possible) when alive', () => {
      writeFileSync(sidecar, JSON.stringify([{ sessionId: 's1', pid: 100, shell: null }]))
      const killed = []
      const { reaped } = reapOrphanShells(sidecar, seams({ kill: (p) => { killed.push(p); return true } }))
      assert.deepEqual(killed, [100])
      assert.equal(reaped.length, 1)
    })

    it('no sidecar → empty result, no throw', () => {
      const { reaped, skipped } = reapOrphanShells(sidecar, seams())
      assert.deepEqual(reaped, [])
      assert.deepEqual(skipped, [])
    })
  })
})
