/**
 * E2E coverage for `chroxy status`.
 *
 * Covers src/cli/status-cmd.js. We don't start a real server — we just
 * verify the "not running" path and that --json emits parseable JSON.
 *
 * NOTE: status pings 127.0.0.1:<port>/ where <port> comes from connection.json
 * or defaults to 8765. The dev machine running these tests may have its own
 * chroxy listening on 8765, so we plant a fake connection.json pointing at
 * a high random port, and status pings that port instead.
 *
 * #9074: readConnectionInfo() now returns a record only when its pid is verified
 * alive. A pid-less record reads as absent, and status would fall back to 8765. So
 * the spawned CLI runs with a TEST-ONLY preload (__helpers/liveness-preload.mjs,
 * through NODE_OPTIONS) that makes it fully hermetic:
 *   - `kill(SYNTHETIC_PID, 0)` answers alive without a real probe; every other
 *     kill is refused;
 *   - fetch never reaches the network. The planted port gets an ECONNREFUSED
 *     rejection, and every other URL (8765 included) is refused.
 * The preload marks each outcome on stderr, and every test asserts the intended
 * path: probe ok, planted-port fetch, nothing refused. A wrong path, such as a
 * default-port ping or an unexpected probe, therefore fails visibly instead of also
 * printing "Not running". The last test proves those markers catch it.
 */
import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import { pickPort, runCli, makeTempHome } from './__helpers/spawn-cli.js'

const PRELOAD = pathToFileURL(join(fileURLToPath(new URL('.', import.meta.url)), '__helpers', 'liveness-preload.mjs')).href
// A synthetic pid: the preload answers for it, so no real process is ever probed.
const SYNTHETIC_PID = 2_000_000_001

function plantDeadConnectionInfo(home, { pid = SYNTHETIC_PID } = {}) {
  const dir = join(home, '.chroxy')
  mkdirSync(dir, { recursive: true })
  const deadPort = pickPort()
  writeFileSync(
    join(dir, 'connection.json'),
    JSON.stringify({
      pid,
      httpUrl: `http://127.0.0.1:${deadPort}/`,
      wsUrl: `ws://127.0.0.1:${deadPort}`,
      tunnelMode: 'none',
      startedAt: new Date().toISOString(),
    }),
  )
  return deadPort
}

/** The hermetic child environment for a planted record on `deadPort`. */
const hermeticEnv = (deadPort) => ({
  NODE_OPTIONS: `--import=${PRELOAD}`,
  CHROXY_TEST_SYNTHETIC_PID: String(SYNTHETIC_PID),
  CHROXY_TEST_ALLOWED_PORT: String(deadPort),
})

/** The intended path: the planted pid was "probed", only the planted port was asked, nothing was refused. */
function assertIntendedPath(r, deadPort) {
  assert.ok(r.stderr.includes(`LIVENESS_PRELOAD_PROBE_OK pid=${SYNTHETIC_PID}`), `the planted pid was probed (stderr: ${r.stderr.slice(0, 400)})`)
  assert.ok(r.stderr.includes(`LIVENESS_PRELOAD_EXPECTED_FETCH http://127.0.0.1:${deadPort}/`), 'status asked the planted port')
  assert.equal(r.stderr.includes('LIVENESS_PRELOAD_REFUSED'), false, `nothing unexpected was probed or fetched (stderr: ${r.stderr.slice(0, 400)})`)
}

describe('chroxy status', () => {
  const { home, cleanup } = makeTempHome()
  after(cleanup)
  let deadPort

  before(() => {
    deadPort = plantDeadConnectionInfo(home)
  })

  it('reports "Not running" when no server is up (exit 1)', async () => {
    const r = await runCli(['status'], { home, env: hermeticEnv(deadPort) })
    // Exit code is 1 when not running (set via process.exitCode).
    assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.match(r.stdout, /Chroxy v/)
    assert.match(r.stdout, /Not running/)
    assertIntendedPath(r, deadPort)
  })

  it('emits valid JSON with --json', async () => {
    const r = await runCli(['status', '--json'], { home, env: hermeticEnv(deadPort) })
    assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
    const parsed = JSON.parse(r.stdout)
    assert.equal(parsed.running, false)
    assert.ok(typeof parsed.version === 'string')
    assertIntendedPath(r, deadPort)
  })

  it('--help prints --json flag', async () => {
    const r = await runCli(['status', '--help'], { home })
    assert.equal(r.code, 0)
    assert.match(r.stdout, /--json/)
  })

  it('proof: a wrong path (unexpected pid, then a default-port ping) is caught by the markers, not passed as "Not running"', async () => {
    // A record whose pid the preload does not answer for: its probe is refused, the
    // record reads as unverified, and status falls back to the default port. That
    // fetch is refused before any network. The output still says "Not running";
    // only the REFUSED markers expose the wrong path, which is why every test above
    // asserts their absence.
    const proof = makeTempHome()
    try {
      const port = plantDeadConnectionInfo(proof.home, { pid: SYNTHETIC_PID + 1 })
      const r = await runCli(['status'], { home: proof.home, env: hermeticEnv(port) })
      assert.match(r.stdout, /Not running/, 'the wrong path prints the same text')
      assert.ok(r.stderr.includes(`LIVENESS_PRELOAD_REFUSED kill pid=${SYNTHETIC_PID + 1} signal=0`), `the unexpected probe was refused (stderr: ${r.stderr.slice(0, 400)})`)
      assert.ok(r.stderr.includes('LIVENESS_PRELOAD_REFUSED fetch http://127.0.0.1:8765/'), 'the default-port ping was refused before any network')
      assert.equal(r.stderr.includes('LIVENESS_PRELOAD_EXPECTED_FETCH'), false)
    } finally {
      proof.cleanup()
    }
  })
})
