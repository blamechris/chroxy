import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import net from 'node:net'
import { runDoctorChecks } from '../src/doctor.js'

/**
 * `chroxy doctor` must check the same port `chroxy start` would bind:
 * flag > env PORT > config.json `port` > 8765 (mergeConfig precedence).
 * Every case runs against a temp CHROXY_CONFIG_DIR so the real ~/.chroxy is
 * never read or written.
 */

// OS-assigned free port: bind 0 on loopback, read it, release it.
async function freePort() {
  const srv = net.createServer()
  await new Promise(r => srv.listen(0, '127.0.0.1', r))
  const { port } = srv.address()
  await new Promise(r => srv.close(r))
  return port
}

async function portRow({ env = {}, config, port, full = false }) {
  const dir = mkdtempSync(join(tmpdir(), 'chroxy-doctor-port-'))
  if (config !== undefined) writeFileSync(join(dir, 'config.json'), JSON.stringify(config))
  const saved = {}
  const overrides = { CHROXY_CONFIG_DIR: dir, PORT: undefined, ...env }
  for (const [k, v] of Object.entries(overrides)) {
    saved[k] = process.env[k]
    if (v === undefined) delete process.env[k]
    else process.env[k] = v
  }
  try {
    const { checks } = await runDoctorChecks({ providers: ['claude-sdk'], port })
    const row = checks.find(c => c.name === 'Port')
    return full ? row : row.message
  } finally {
    for (const [k, v] of Object.entries(saved)) {
      if (v === undefined) delete process.env[k]
      else process.env[k] = v
    }
    rmSync(dir, { recursive: true, force: true })
  }
}

describe('runDoctorChecks port resolution', () => {
  it('uses the config file port when no flag or env is given', async () => {
    const p = await freePort()
    const msg = await portRow({ config: { port: p } })
    assert.ok(msg.startsWith(`${p} `), msg)
  })

  it('the explicit port option beats the config file', async () => {
    const [a, b] = [await freePort(), await freePort()]
    const msg = await portRow({ config: { port: a }, port: b })
    assert.ok(msg.startsWith(`${b} `), msg)
  })

  it('env PORT beats the config file, like start', async () => {
    const [a, b] = [await freePort(), await freePort()]
    const msg = await portRow({ config: { port: a }, env: { PORT: String(b) } })
    assert.ok(msg.startsWith(`${b} `), msg)
  })

  it('the explicit port option beats env PORT', async () => {
    const [a, b] = [await freePort(), await freePort()]
    const msg = await portRow({ env: { PORT: String(a) }, port: b })
    assert.ok(msg.startsWith(`${b} `), msg)
  })

  it('falls back to 8765 with no flag, env or config port', async () => {
    const msg = await portRow({ config: {} })
    assert.ok(msg.startsWith('8765 '), msg)
  })

  it('blank PORT falls through to 8765 like start', async () => {
    const msg = await portRow({ config: {}, env: { PORT: '' } })
    assert.ok(msg.startsWith('8765 '), msg)
  })

  for (const [label, opts] of [
    ['PORT=abc', { env: { PORT: 'abc' }, config: {} }],
    ['config port 0', { config: { port: 0 } }],
    ['config port 70000', { config: { port: 70000 } }],
    ['-p abc', { config: {}, port: 'abc' }],
  ]) {
    it(`${label} fails as an invalid port`, async () => {
      const row = await portRow({ ...opts, full: true })
      assert.equal(row.status, 'fail', row.message)
      assert.ok(row.message.startsWith('Invalid port'), row.message)
    })
  }
})
