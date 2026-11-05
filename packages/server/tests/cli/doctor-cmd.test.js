/**
 * E2E coverage for `chroxy doctor`.
 *
 * Covers src/cli/doctor-cmd.js.
 */
import { describe, it, after } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:net'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { resolveConfiguredPort } from '../../src/cli/shared.js'
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

  it('prints --help with -c/--config', async () => {
    const r = await runCli(['doctor', '--help'], { home })
    assert.match(r.stdout, /--config/)
  })
})

// #8233 — doctor must probe the port `start` would bind: flag > env > config > 8765.
//
// No test depends on a real port being free: each one holds an EPHEMERAL port open in
// this process (listen(0)), so "<port> is in use" is deterministic and the port number
// in the Port row proves which tier won. The default tier (8765) is asserted on the
// resolver only — nothing here ever binds or probes 8765.
describe('chroxy doctor — configured port (#8233)', () => {
  const { home, cleanup } = makeTempHome()
  const holders = []
  after(async () => {
    cleanup()
    await Promise.all(holders.map((h) => new Promise((r) => h.close(r))))
  })

  // doctor's probe listens on 127.0.0.1, so hold that exact address.
  async function occupy() {
    const srv = createServer()
    await new Promise((r) => srv.listen(0, '127.0.0.1', r))
    holders.push(srv)
    return srv.address().port
  }
  function writeConfig(dir, cfg) {
    mkdirSync(dir, { recursive: true })
    const file = join(dir, 'config.json')
    writeFileSync(file, JSON.stringify(cfg))
    return file
  }
  const portRow = (stdout) => stdout.split('\n').find((l) => /\bPort\b/.test(l)) || ''
  const doctor = (args, env = {}) =>
    runCli(['doctor', '--provider', 'claude-sdk', ...args], { home, env })

  it('checks the port from config.json when no flag or env is given', async () => {
    const port = await occupy()
    writeConfig(join(home, '.chroxy'), { port })
    const r = await doctor([])
    assert.ok(portRow(r.stdout).includes(`${port} is in use`), r.stdout)
  })

  it('honours the env port over the config file', async () => {
    const fileOnly = await occupy()
    const envPort = await occupy()
    writeConfig(join(home, '.chroxy'), { port: fileOnly })
    const r = await doctor([], { PORT: String(envPort) })
    const row = portRow(r.stdout)
    assert.ok(row.includes(`${envPort} is in use`), r.stdout)
    assert.ok(!row.includes(String(fileOnly)), r.stdout)
  })

  it('lets -p override both env and config file', async () => {
    const fileOnly = await occupy()
    const envPort = await occupy()
    const flagPort = await occupy()
    writeConfig(join(home, '.chroxy'), { port: fileOnly })
    const r = await doctor(['-p', String(flagPort)], { PORT: String(envPort) })
    const row = portRow(r.stdout)
    assert.ok(row.includes(`${flagPort} is in use`), r.stdout)
    assert.ok(!row.includes(String(envPort)) && !row.includes(String(fileOnly)), r.stdout)
  })

  it('honours -c <path> the way start does', async () => {
    const port = await occupy()
    const other = writeConfig(join(home, 'elsewhere'), { port })
    const r = await doctor(['-c', other])
    assert.ok(portRow(r.stdout).includes(`${port} is in use`), r.stdout)
  })

  it('honours CHROXY_CONFIG_DIR', async () => {
    const port = await occupy()
    const dir = join(home, 'relocated')
    writeConfig(dir, { port })
    const r = await doctor([], { CHROXY_CONFIG_DIR: dir })
    assert.ok(portRow(r.stdout).includes(`${port} is in use`), r.stdout)
  })

  const configRow = (stdout) => stdout.split('\n').find((l) => /\bConfig\b/.test(l) && !/state root/.test(l)) || ''

  it('-c pointing at invalid JSON fails the Config row naming that path', async () => {
    const bad = join(home, 'bad.json')
    writeFileSync(bad, '{ not json')
    const r = await doctor(['-c', bad])
    const row = configRow(r.stdout)
    assert.ok(row.includes('FAIL') && row.includes(bad) && row.includes('invalid JSON'), r.stdout)
  })

  it('-c pointing at a missing file fails the Config row naming that path', async () => {
    const missing = join(home, 'nope', 'missing.json')
    const r = await doctor(['-c', missing])
    const row = configRow(r.stdout)
    assert.ok(row.includes('FAIL') && row.includes(missing), r.stdout)
  })

  it('a non-numeric configured port fails the Port row without probing it', async () => {
    writeConfig(join(home, '.chroxy'), { port: 'abc' })
    const r = await doctor([])
    const row = portRow(r.stdout)
    assert.ok(row.includes('FAIL') && row.includes('abc') && !row.includes('is available'), r.stdout)
  })
})

describe('resolveConfiguredPort (#8233)', () => {
  const { home, cleanup } = makeTempHome()
  after(cleanup)
  const file = join(home, 'config.json')
  const withEnvPort = (value, fn) => {
    const prev = process.env.PORT
    if (value === undefined) delete process.env.PORT
    else process.env.PORT = value
    try { return fn() } finally {
      if (prev === undefined) delete process.env.PORT
      else process.env.PORT = prev
    }
  }

  it('defaults to 8765 with no flag, env or config file', () => {
    withEnvPort(undefined, () => {
      assert.equal(resolveConfiguredPort({ config: join(home, 'missing.json') }).port, 8765)
    })
  })

  it('reads the config-file port', () => {
    writeFileSync(file, JSON.stringify({ port: 8794 }))
    withEnvPort(undefined, () => assert.equal(resolveConfiguredPort({ config: file }).port, 8794))
  })

  it('env beats the config file', () => {
    writeFileSync(file, JSON.stringify({ port: 8794 }))
    withEnvPort('8801', () => assert.equal(resolveConfiguredPort({ config: file }).port, 8801))
  })

  it('flag beats env and config file', () => {
    writeFileSync(file, JSON.stringify({ port: 8794 }))
    withEnvPort('8801', () => assert.equal(resolveConfiguredPort({ config: file, port: '8802' }).port, 8802))
  })

  it('ignores an unparseable flag and an unparseable config file', () => {
    writeFileSync(file, '{ not json')
    withEnvPort(undefined, () => assert.equal(resolveConfiguredPort({ config: file, port: 'abc' }).port, 8765))
  })

  it('reports a non-numeric or out-of-range port as a problem instead of a port', () => {
    writeFileSync(file, JSON.stringify({ port: 'abc' }))
    withEnvPort(undefined, () => {
      const r = resolveConfiguredPort({ config: file })
      assert.ok(r.problem && r.problem.includes('abc'), String(r.problem))
    })
    writeFileSync(file, JSON.stringify({ port: 8794 }))
    withEnvPort('abc', () => assert.ok(resolveConfiguredPort({ config: file }).problem))
    withEnvPort('70000', () => assert.ok(resolveConfiguredPort({ config: file }).problem))
  })
})
