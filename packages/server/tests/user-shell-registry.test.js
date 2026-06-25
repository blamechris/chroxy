import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { readRegistry, recordShell, forgetShell, reapOrphanShells } from '../src/user-shell-registry.js'

describe('user-shell-registry (#6276 / #6327)', () => {
  let dir
  let sidecar
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-ush-reg-'))
    sidecar = join(dir, 'user-shells.json')
  })
  afterEach(() => { rmSync(dir, { recursive: true, force: true }) })

  // Deterministic record: never spawn real `ps` in tests. Default to no
  // start-time (the comm-only-fallback path); start-time tests pass their own.
  const rec = (fields, startTimeOf = () => null) => recordShell(sidecar, fields, { startTimeOf })

  describe('record / forget', () => {
    it('records a shell and reads it back (shell stored as basename only)', () => {
      rec({ sessionId: 's1', pid: 4242, shell: '/bin/zsh' })
      assert.deepEqual(readRegistry(sidecar), [{ sessionId: 's1', pid: 4242, shell: 'zsh' }])
    })

    it('replaces the record for the same sessionId (idempotent respawn)', () => {
      rec({ sessionId: 's1', pid: 1, shell: '/bin/zsh' })
      rec({ sessionId: 's1', pid: 2, shell: '/bin/zsh' })
      const recs = readRegistry(sidecar)
      assert.equal(recs.length, 1)
      assert.equal(recs[0].pid, 2)
    })

    it('ignores a record with a non-positive / non-integer pid', () => {
      rec({ sessionId: 's1', pid: 0, shell: 'zsh' })
      rec({ sessionId: 's2', pid: -5, shell: 'zsh' })
      rec({ sessionId: 's3', pid: 1.5, shell: 'zsh' })
      assert.deepEqual(readRegistry(sidecar), [])
    })

    it('forget removes one record, keeping the others', () => {
      rec({ sessionId: 's1', pid: 11, shell: 'zsh' })
      rec({ sessionId: 's2', pid: 22, shell: 'bash' })
      forgetShell(sidecar, 's1')
      assert.deepEqual(readRegistry(sidecar).map((r) => r.sessionId), ['s2'])
    })

    it('forget deletes the file once empty (clean shutdown leaves no sidecar)', () => {
      rec({ sessionId: 's1', pid: 11, shell: 'zsh' })
      forgetShell(sidecar, 's1')
      assert.equal(existsSync(sidecar), false)
    })

    it('forget on an unknown sessionId is a no-op', () => {
      rec({ sessionId: 's1', pid: 11, shell: 'zsh' })
      forgetShell(sidecar, 'nope')
      assert.deepEqual(readRegistry(sidecar).map((r) => r.sessionId), ['s1'])
    })

    it('captures the start-time when one is available (#6327)', () => {
      rec({ sessionId: 's1', pid: 100, shell: 'zsh' }, () => 'Wed Jun 25 01:30:00 2026')
      assert.equal(readRegistry(sidecar)[0].startTime, 'Wed Jun 25 01:30:00 2026')
    })

    it('omits the start-time key when none is captured (comm-only fallback)', () => {
      rec({ sessionId: 's1', pid: 100, shell: 'zsh' }, () => null)
      assert.ok(!('startTime' in readRegistry(sidecar)[0]))
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

  describe('reapOrphanShells — comm gate (#6276)', () => {
    const seams = (over = {}) => ({ isAlive: () => true, commOf: () => 'zsh', startTimeOf: () => null, kill: () => true, ...over })

    it('SIGTERMs a live shell whose comm matches, and reports it reaped', () => {
      rec({ sessionId: 's1', pid: 100, shell: '/bin/zsh' })
      const killed = []
      const { reaped, skipped } = reapOrphanShells(sidecar, seams({ kill: (pid) => { killed.push(pid); return true } }))
      assert.deepEqual(killed, [100])
      assert.equal(reaped.length, 1)
      assert.equal(reaped[0].sessionId, 's1')
      assert.equal(skipped.length, 0)
    })

    it('clears the sidecar after running (this instance starts fresh)', () => {
      rec({ sessionId: 's1', pid: 100, shell: 'zsh' })
      reapOrphanShells(sidecar, seams())
      assert.equal(existsSync(sidecar), false)
    })

    it('skips a dead pid without killing (never signal a gone process)', () => {
      rec({ sessionId: 's1', pid: 100, shell: 'zsh' })
      const killed = []
      const { reaped, skipped } = reapOrphanShells(sidecar, seams({ isAlive: () => false, kill: (p) => { killed.push(p); return true } }))
      assert.deepEqual(killed, [])
      assert.equal(reaped.length, 0)
      assert.equal(skipped[0].why, 'dead')
    })

    it('PID-reuse safety: skips a live pid whose comm no longer matches the shell', () => {
      rec({ sessionId: 's1', pid: 100, shell: 'zsh' })
      const killed = []
      const { reaped, skipped } = reapOrphanShells(sidecar, seams({ commOf: () => 'postgres', kill: (p) => { killed.push(p); return true } }))
      assert.deepEqual(killed, [], 'must NOT signal a reused pid running a different program')
      assert.equal(reaped.length, 0)
      assert.equal(skipped[0].why, 'comm-mismatch')
      assert.equal(skipped[0].comm, 'postgres')
    })

    it('skips when comm is unknown (cannot positively identify the process)', () => {
      rec({ sessionId: 's1', pid: 100, shell: 'zsh' })
      const { reaped, skipped } = reapOrphanShells(sidecar, seams({
        commOf: () => null,
        kill: () => { throw new Error('must not attempt to kill an unidentifiable pid') },
      }))
      assert.equal(reaped.length, 0)
      assert.equal(skipped[0].why, 'comm-unknown')
    })

    it('records a failed kill as skipped, not reaped', () => {
      rec({ sessionId: 's1', pid: 100, shell: 'zsh' })
      const { reaped, skipped } = reapOrphanShells(sidecar, seams({ kill: () => false }))
      assert.equal(reaped.length, 0)
      assert.equal(skipped[0].why, 'kill-failed')
    })

    it('matches comm by basename (ps may return a full path)', () => {
      rec({ sessionId: 's1', pid: 100, shell: '/opt/homebrew/bin/fish' })
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

  describe('reapOrphanShells — start-time gate (#6327)', () => {
    const seams = (over = {}) => ({ isAlive: () => true, commOf: () => 'zsh', startTimeOf: () => 'T1', kill: () => true, ...over })

    it('reaps when the live start-time still matches the recorded one', () => {
      rec({ sessionId: 's1', pid: 100, shell: 'zsh' }, () => 'T1')
      const killed = []
      const { reaped } = reapOrphanShells(sidecar, seams({ startTimeOf: () => 'T1', kill: (p) => { killed.push(p); return true } }))
      assert.deepEqual(killed, [100])
      assert.equal(reaped.length, 1)
    })

    it('PID-reuse safety: skips a same-binary pid whose start-time differs (recycled)', () => {
      rec({ sessionId: 's1', pid: 100, shell: 'zsh' }, () => 'recorded-earlier')
      const killed = []
      const { reaped, skipped } = reapOrphanShells(sidecar, seams({
        startTimeOf: () => 'recycled-later',
        kill: (p) => { killed.push(p); return true },
      }))
      assert.deepEqual(killed, [], 'a recycled pid running the same shell binary must NOT be signalled')
      assert.equal(reaped.length, 0)
      assert.equal(skipped[0].why, 'starttime-mismatch')
    })

    it('skips when the live start-time is unreadable (cannot confirm identity)', () => {
      rec({ sessionId: 's1', pid: 100, shell: 'zsh' }, () => 'T1')
      const { reaped, skipped } = reapOrphanShells(sidecar, seams({
        startTimeOf: () => null,
        kill: () => { throw new Error('must not kill an unverifiable pid') },
      }))
      assert.equal(reaped.length, 0)
      assert.equal(skipped[0].why, 'starttime-unknown')
    })

    it('falls back to the comm-only gate for a legacy record with no start-time', () => {
      writeFileSync(sidecar, JSON.stringify([{ sessionId: 's1', pid: 100, shell: 'zsh' }]))
      const killed = []
      reapOrphanShells(sidecar, seams({
        startTimeOf: () => { throw new Error('start-time must not be consulted when none was recorded') },
        kill: (p) => { killed.push(p); return true },
      }))
      assert.deepEqual(killed, [100])
    })
  })
})
