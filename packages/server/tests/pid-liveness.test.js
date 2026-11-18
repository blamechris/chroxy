/**
 * probePidLiveness (#9074): the three outcomes of `kill(pid, 0)`, by MOCKED errno only.
 * No real process is probed here: every case injects `kill`.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { probePidLiveness, PID_ALIVE, PID_DEAD, PID_UNVERIFIED } from '../src/utils/pid-liveness.js'

const errno = (code) => Object.assign(new Error(code), { code })

describe('probePidLiveness', () => {
  it('a probe that succeeds is alive, and it probes with signal 0 only', () => {
    const calls = []
    assert.equal(probePidLiveness(4242, { kill: (pid, sig) => { calls.push([pid, sig]) } }), PID_ALIVE)
    assert.deepEqual(calls, [[4242, 0]])
  })

  it('ESRCH, and only ESRCH, is dead', () => {
    assert.equal(probePidLiveness(4242, { kill: () => { throw errno('ESRCH') } }), PID_DEAD)
  })

  it('EPERM is unverified: neither alive nor dead', () => {
    // Mutation: treat EPERM as alive (or as dead) -> red.
    assert.equal(probePidLiveness(4242, { kill: () => { throw errno('EPERM') } }), PID_UNVERIFIED)
  })

  it('any other failure is unverified', () => {
    for (const thrown of [errno('EINVAL'), errno('ENOSYS'), new Error('no code'), null, 'string']) {
      assert.equal(probePidLiveness(4242, { kill: () => { throw thrown } }), PID_UNVERIFIED, String(thrown?.code ?? thrown))
    }
  })

  it('a pid that is not a positive safe integer is unverified and never probed', () => {
    // 0 and negatives address process GROUPS (0 = the caller's own), so probing them
    // would report "alive" for a malformed record. Mutation: drop the guard -> red.
    for (const pid of [0, -1, -4242, 1.5, NaN, Infinity, 2 ** 53, '4242', null, undefined, {}, []]) {
      let probed = 0
      assert.equal(probePidLiveness(pid, { kill: () => { probed++ } }), PID_UNVERIFIED, `pid ${String(pid)}`)
      assert.equal(probed, 0, `pid ${String(pid)} must not be probed`)
    }
  })
})
