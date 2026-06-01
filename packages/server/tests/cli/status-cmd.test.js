/**
 * E2E coverage for `chroxy status`.
 *
 * Covers src/cli/status-cmd.js. We don't start a real server — we just
 * verify the "not running" path and that --json emits parseable JSON.
 *
 * NOTE: status pings 127.0.0.1:<port>/ where <port> comes from connection.json
 * or defaults to 8765. The dev machine running these tests may have its own
 * chroxy listening on 8765, so we plant a fake connection.json pointing at
 * a high random port — not reserved, just unlikely-to-be-bound — so the
 * ping fails fast and exercises the "not running" path.
 */
import { describe, it, after, before } from 'node:test'
import assert from 'node:assert/strict'
import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'
import { pickPort, runCli, makeTempHome } from './__helpers/spawn-cli.js'

function plantDeadConnectionInfo(home) {
  const dir = join(home, '.chroxy')
  mkdirSync(dir, { recursive: true })
  const deadPort = pickPort()
  // Omit `pid` — readConnectionInfo() only PID-checks if pid is set, so
  // leaving it null means the fake info is returned as-is.
  writeFileSync(
    join(dir, 'connection.json'),
    JSON.stringify({
      httpUrl: `http://127.0.0.1:${deadPort}/`,
      wsUrl: `ws://127.0.0.1:${deadPort}`,
      tunnelMode: 'none',
      startedAt: new Date().toISOString(),
    }),
  )
  return deadPort
}

describe('chroxy status', () => {
  const { home, cleanup } = makeTempHome()
  after(cleanup)

  before(() => {
    plantDeadConnectionInfo(home)
  })

  it('reports "Not running" when no server is up (exit 1)', async () => {
    const r = await runCli(['status'], { home })
    // Exit code is 1 when not running (set via process.exitCode).
    assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
    assert.match(r.stdout, /Chroxy v/)
    assert.match(r.stdout, /Not running/)
  })

  it('emits valid JSON with --json', async () => {
    const r = await runCli(['status', '--json'], { home })
    assert.equal(r.code, 1, `stdout: ${r.stdout}\nstderr: ${r.stderr}`)
    const parsed = JSON.parse(r.stdout)
    assert.equal(parsed.running, false)
    assert.ok(typeof parsed.version === 'string')
  })

  it('--help prints --json flag', async () => {
    const r = await runCli(['status', '--help'], { home })
    assert.equal(r.code, 0)
    assert.match(r.stdout, /--json/)
  })
})
