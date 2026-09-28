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
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, relative } from 'node:path'
import { fileURLToPath } from 'node:url'

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

  // The routing table the two describes below both use — the LOADERS roster
  // (checked in both directions, #8047 review S5) and the per-loader
  // "routes to the real static" spy tests. One list, so it cannot drift
  // between the two checks that read it.
  const ROUTING_TABLE = [
    ['claude-tui sink-dir', '../src/claude-tui-session.js', 'ClaudeTuiSession', 'sweepStaleSinkDirs'],
    ['claude-cli sidecar-dir', '../src/cli-session.js', 'CliSession', 'sweepStaleSidecarDirs'],
    ['codex attach-dir', '../src/codex-app-server-session.js', 'CodexAppServerSession', 'sweepStaleAttachDirs'],
    ['docker-byok env-file-dir', '../src/docker-byok-session.js', 'DockerByokSession', 'sweepStaleEnvDirs'],
  ]

  // The real loaders, exercised for real. This is what makes the default
  // wiring behavioural rather than a claim: it imports the actual provider
  // modules and reaches the actual static sweep methods.
  describe('DEFAULT_SWEEP_LOADERS — the real wiring', () => {
    // #8047 review S5 — renamed from "covers every provider": that title
    // claimed a two-directional check this test never performed. It only
    // ever asked "are these four IN the roster" — a fifth site that forgets
    // to register a loader would stay green here forever. Renamed to say
    // exactly what it checks; the reverse direction is the next test.
    it('is exactly these four loaders', () => {
      assert.deepEqual(Object.keys(DEFAULT_SWEEP_LOADERS).sort(), [
        'claude-cli sidecar-dir',
        'claude-tui sink-dir',
        'codex attach-dir',
        'docker-byok env-file-dir',
      ])
    })

    // #8047 review S5 — the OTHER direction. `OWNER_PID_FILE` is written
    // only by a module that creates an owned, swept per-session dir (the
    // constant's own home, utils/stale-session-dirs.js, is excluded — it
    // defines the name, it doesn't write it). Scan `src/` for every such
    // writer and assert that set equals the modules named in ROUTING_TABLE
    // (and so, transitively, in DEFAULT_SWEEP_LOADERS). A module that starts
    // stamping OWNER_PID_FILE but is never added to the routing table would
    // leak forever with no boot sweep, and the test above alone would never
    // catch it — this is the "roster diffs must read both directions" shape
    // documented in project memory, applied to this file's own roster.
    it('every module that stamps OWNER_PID_FILE is named in the routing table (reverse check)', () => {
      const srcDir = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
      const writers = []
      const walk = (dir) => {
        for (const entry of readdirSync(dir, { withFileTypes: true })) {
          if (entry.isDirectory()) {
            if (entry.name === 'utils') continue // OWNER_PID_FILE's own home, not a writer
            walk(join(dir, entry.name))
            continue
          }
          if (!entry.name.endsWith('.js')) continue
          const full = join(dir, entry.name)
          const src = readFileSync(full, 'utf8')
          if (src.includes('OWNER_PID_FILE')) {
            writers.push(`../src/${relative(srcDir, full).split('\\').join('/')}`)
          }
        }
      }
      walk(srcDir)
      const routed = ROUTING_TABLE.map(([, modulePath]) => modulePath)
      assert.deepEqual(
        writers.sort(),
        routed.sort(),
        'a module that stamps OWNER_PID_FILE but is missing from ROUTING_TABLE/DEFAULT_SWEEP_LOADERS would leak forever with no boot sweep',
      )
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
    for (const [label, modulePath, className, method] of ROUTING_TABLE) {
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
