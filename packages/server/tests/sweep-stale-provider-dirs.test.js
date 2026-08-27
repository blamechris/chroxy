/**
 * Behavioural cover for the boot-time stale-dir sweep (#7374).
 *
 * This replaces a source-level grep of `server-cli.js`. That guard asserted the
 * text `sweepStaleSinkDirs(log)` appeared inside an anchored `import(...)`
 * slice, and mutation testing during #7371's review found two bypasses that
 * kept it green: wrapping the boot block in `if (process.env.__NEVER_SET__)`,
 * and replacing the call with `.then(({CliSession}) => void CliSession)` while
 * leaving the expected string in a comment inside the anchored window.
 *
 * Nothing here greps anything — every test RUNS the sweep.
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'

import {
  sweepStaleProviderDirs,
  DEFAULT_SWEEP_LOADERS,
} from '../src/sweep-stale-provider-dirs.js'

function recordingLog() {
  const warns = []
  const infos = []
  return { warns, infos, warn: (m) => warns.push(String(m)), info: (m) => infos.push(String(m)) }
}

describe('sweepStaleProviderDirs (#7374)', () => {
  it('invokes EVERY provider sweep, and hands each one the logger', async () => {
    const called = []
    const log = recordingLog()
    await sweepStaleProviderDirs(log, {
      alpha: async () => (l) => called.push(['alpha', l]),
      beta: async () => (l) => called.push(['beta', l]),
    })
    assert.deepEqual(called.map(([n]) => n).sort(), ['alpha', 'beta'])
    for (const [name, l] of called) assert.equal(l, log, `${name} must receive the logger`)
  })

  it('a loader that rejects is warned, and does not stop the others', async () => {
    const called = []
    const log = recordingLog()
    await sweepStaleProviderDirs(log, {
      'broken-provider': async () => {
        throw new Error('import blew up')
      },
      healthy: async () => () => called.push('healthy'),
    })
    assert.deepEqual(called, ['healthy'], 'a failing loader must not prevent the other sweep')
    assert.ok(
      log.warns.some((w) => w.includes('broken-provider') && w.includes('import blew up')),
      `the failure must be warned with its label; got ${JSON.stringify(log.warns)}`,
    )
  })

  it('a sweep that throws is warned, and does not stop the others', async () => {
    const called = []
    const log = recordingLog()
    await sweepStaleProviderDirs(log, {
      'throwing-sweep': async () => () => {
        throw new Error('reaper blew up')
      },
      healthy: async () => () => called.push('healthy'),
    })
    assert.deepEqual(called, ['healthy'])
    assert.ok(log.warns.some((w) => w.includes('throwing-sweep') && w.includes('reaper blew up')))
  })

  it('never rejects — boot must not be able to fail on a sweep', async () => {
    const log = recordingLog()
    await assert.doesNotReject(() =>
      sweepStaleProviderDirs(log, {
        a: async () => {
          throw new Error('x')
        },
        b: async () => () => {
          throw new Error('y')
        },
      }),
    )
  })

  // The real loaders, exercised for real. This is what makes the default
  // wiring behavioural rather than a claim: it imports the actual provider
  // modules and reaches the actual static sweep methods.
  describe('DEFAULT_SWEEP_LOADERS — the real wiring', () => {
    it('covers both providers', () => {
      assert.deepEqual(Object.keys(DEFAULT_SWEEP_LOADERS).sort(), [
        'claude-cli sidecar-dir',
        'claude-tui sink-dir',
      ])
    })

    for (const label of ['claude-tui sink-dir', 'claude-cli sidecar-dir']) {
      it(`${label}: resolves to a callable sweep on the real provider module`, async () => {
        const sweep = await DEFAULT_SWEEP_LOADERS[label]()
        assert.equal(typeof sweep, 'function', 'the loader must resolve to the provider sweep')
      })
    }

    it('running the REAL default loaders sweeps without throwing', async () => {
      // End-to-end over the actual provider modules. Only dirs with a DEAD
      // owner pid are removed, so this is safe to run: this process is alive,
      // and the fs sandbox in _setup.mjs blocks any write outside the tmp tree.
      const log = recordingLog()
      await assert.doesNotReject(() => sweepStaleProviderDirs(log))
    })
  })
})
