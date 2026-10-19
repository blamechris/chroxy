/**
 * E2E coverage for `chroxy doctor`.
 *
 * Covers src/cli/doctor-cmd.js.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { once } from 'node:events'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { stripVTControlCharacters } from 'node:util'
import { pickPort, runCli, makeTempHome } from './__helpers/spawn-cli.js'

describe('chroxy doctor', () => {
  const { home, cleanup } = makeTempHome()
  after(cleanup)

  it('prints the Chroxy Doctor banner and a summary line', async () => {
    // Pass a high random port (not reserved, just unlikely-to-be-bound)
    // so the "port in use" probe doesn't flag the default 8765 when a
    // local dev server is already listening there.
    const r = await runCli(['doctor', '--port', String(pickPort())], { home })
    // Exit code can be 0 or 1 depending on whether cloudflared/other
    // optional deps are installed on the test machine, so don't assert
    // on it directly.
    assert.match(r.stdout, /Chroxy Doctor/)
    // Final summary line is one of these two messages.
    assert.match(r.stdout, /(All checks passed\.|Some checks failed\.)/)
  })

  it('prints --help with the expected flags', async () => {
    const r = await runCli(['doctor', '--help'], { home })
    assert.equal(r.code, 0)
    assert.match(r.stdout, /--port/)
    assert.match(r.stdout, /--provider/)
  })
})

// Run the real command with a private HOME; no ambient PORT/config can affect it.
async function doctorWithConfig(t, { config, env, args = [] } = {}) {
  const { home, cleanup } = makeTempHome()
  t.after(cleanup)
  if (config !== undefined) {
    mkdirSync(join(home, '.chroxy'), { recursive: true })
    writeFileSync(join(home, '.chroxy', 'config.json'), typeof config === 'string' ? config : JSON.stringify(config))
  }
  const result = await runCli(['doctor', '--provider', 'claude-sdk', ...args], { home, env })
  assert.equal(result.timedOut, false, 'doctor must finish normally')
  assert.equal(result.signal, null)
  assert.ok([0, 1].includes(result.code), 'doctor reports diagnostic success or failure')
  assert.ok(result.stdout.includes('Chroxy Doctor'))
  return stripVTControlCharacters(result.stdout)
}

async function heldPort(t) {
  const server = createServer()
  const listening = once(server, 'listening')
  server.listen(0, '127.0.0.1')
  await listening
  t.after(() => new Promise((resolve, reject) => {
    server.close(error => error ? reject(error) : resolve())
  }))
  return server.address().port
}

function diagnosticRow(output, name) {
  const row = output.split('\n').find(line => new RegExp(`\\]\\s+${name}\\s+`).test(line))
  assert.ok(row, `${name} diagnostic must be present`)
  return row.trim()
}

function assertOccupiedPort(output, port) {
  const row = diagnosticRow(output, 'Port')
  assert.ok(row.startsWith('[WARN]'))
  assert.ok(row.endsWith(`${port} is in use (server may already be running)`), row)
}

describe('chroxy doctor port precedence', () => {
  it('checks the configured port when no override is supplied', async (t) => {
    const port = await heldPort(t)
    assertOccupiedPort(await doctorWithConfig(t, { config: { port } }), port)
  })

  it('PORT overrides the configured port', async (t) => {
    const filePort = await heldPort(t)
    const port = await heldPort(t)
    assertOccupiedPort(await doctorWithConfig(t, { config: { port: filePort }, env: { PORT: String(port) } }), port)
  })

  it('--port overrides PORT and the configured port', async (t) => {
    const filePort = await heldPort(t)
    const envPort = await heldPort(t)
    const port = await heldPort(t)
    assertOccupiedPort(await doctorWithConfig(t, {
      config: { port: filePort }, env: { PORT: String(envPort) }, args: ['--port', String(port)],
    }), port)
  })

  it('defaults to 8765 and retains missing-config advice', async (t) => {
    const output = await doctorWithConfig(t)
    assert.ok(diagnosticRow(output, 'Port').includes('8765 is '))
    const config = diagnosticRow(output, 'Config')
    assert.ok(config.startsWith('[WARN]'))
    assert.ok(config.includes("Not found — run 'chroxy init' to create"))
  })

  it('retains invalid-JSON diagnostics and falls back to the default port', async (t) => {
    const output = await doctorWithConfig(t, { config: '{broken' })
    assert.ok(diagnosticRow(output, 'Port').includes('8765 is '))
    const config = diagnosticRow(output, 'Config')
    assert.ok(config.startsWith('[FAIL]'))
    assert.ok(config.includes('invalid JSON'))
  })

  for (const port of ['doctor.sock', '8766', null, false, 0, -1, 65536, 1.5]) {
    it(`reports an invalid configured port ${JSON.stringify(port)} without probing a socket path`, async (t) => {
      const output = await doctorWithConfig(t, { config: { port } })
      const row = diagnosticRow(output, 'Port')
      assert.ok(row.startsWith('[FAIL]'), row)
      assert.ok(row.endsWith('Invalid port — expected an integer from 1 to 65535'), row)
    })
  }
})
