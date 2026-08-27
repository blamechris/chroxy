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

  it('never rejects even when the LOGGER throws', async () => {
    // The one path that used to escape: `log.warn` itself throwing would
    // reject Promise.all, which nothing awaits, so it arrives as an
    // unhandledRejection — and server-orchestrator treats that as fatal.
    const hostileLog = {
      info() {},
      warn() {
        throw new Error('logger is broken')
      },
    }
    await assert.doesNotReject(() =>
      sweepStaleProviderDirs(hostileLog, {
        exploding: async () => {
          throw new Error('boom')
        },
      }),
    )
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

    for (const label of Object.keys(DEFAULT_SWEEP_LOADERS)) {
      it(`${label}: resolves to a callable sweep on the real provider module`, async () => {
        const sweep = await DEFAULT_SWEEP_LOADERS[label]()
        assert.equal(typeof sweep, 'function', 'the loader must resolve to the provider sweep')
      })
    }

    // NOT `assert.doesNotReject(() => sweepStaleProviderDirs(log))`. That was
    // the first version and it is vacuous: the function is DESIGNED never to
    // reject, so it would pass with both real loaders resolving to no-ops —
    // the exact defect class this PR exists to fix, reproduced inside its own
    // fix.
    //
    // Nor does this INVOKE the real sweeps. The second version did, and that
    // was worse: the sweeps `rm -rf` dead-owner dirs under
    // /tmp/chroxy-claude-tui and CliSession.PERMISSION_MODE_SIDECAR_BASE, which
    // are the fixture spaces of claude-tui-session.test.js and this file's own
    // sibling — and `node --test` runs files in PARALLEL. Measured: a planted
    // dead-pid dir in each base was deleted by this file. That is a
    // cross-file flake, manufactured by a test whose only job was to prove
    // wiring.
    //
    // Spy the real static method instead: it proves the loader reaches the
    // real class and threads the logger and the tally through, and it touches
    // no filesystem.
    for (const [label, modulePath, className, method] of [
      ['claude-tui sink-dir', '../src/claude-tui-session.js', 'ClaudeTuiSession', 'sweepStaleSinkDirs'],
      ['claude-cli sidecar-dir', '../src/cli-session.js', 'CliSession', 'sweepStaleSidecarDirs'],
    ]) {
      it(`${label}: routes to ${className}.${method} and returns its tally`, async () => {
        const ns = await import(modulePath)
        const Klass = ns[className]
        const original = Klass[method]
        assert.equal(typeof original, 'function', `positive control: ${className}.${method} must exist`)

        const seen = []
        const tally = { swept: 0, kept: 0 }
        Klass[method] = (l) => {
          seen.push(l)
          return tally
        }
        try {
          const log = recordingLog()
          const sweep = await DEFAULT_SWEEP_LOADERS[label]()
          const result = sweep(log)
          assert.deepEqual(seen, [log], `${label} must call ${className}.${method} with the logger`)
          assert.equal(result, tally, "the provider's tally must be returned through the loader")
        } finally {
          Klass[method] = original
        }
      })
    }
  })
})
