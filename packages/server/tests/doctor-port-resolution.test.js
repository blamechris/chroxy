import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { runDoctorChecks } from '../src/doctor.js'

/**
 * `chroxy doctor` must check the same port `chroxy start` would bind:
 * flag > env PORT > config.json `port` > 8765 (mergeConfig precedence).
 * Every case runs against a temp CHROXY_CONFIG_DIR so the real ~/.chroxy is
 * never read or written.
 */

async function portRow({ env = {}, config, port }) {
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
    return checks.find(c => c.name === 'Port').message
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
    const msg = await portRow({ config: { port: 48794 } })
    assert.ok(msg.startsWith('48794 '), msg)
  })

  it('the explicit port option beats the config file', async () => {
    const msg = await portRow({ config: { port: 48794 }, port: 48795 })
    assert.ok(msg.startsWith('48795 '), msg)
  })

  it('env PORT beats the config file, like start', async () => {
    const msg = await portRow({ config: { port: 48794 }, env: { PORT: '48796' } })
    assert.ok(msg.startsWith('48796 '), msg)
  })

  it('the explicit port option beats env PORT', async () => {
    const msg = await portRow({ env: { PORT: '48796' }, port: 48795 })
    assert.ok(msg.startsWith('48795 '), msg)
  })

  it('falls back to 8765 with no flag, env or config port', async () => {
    const msg = await portRow({ config: {} })
    assert.ok(msg.startsWith('8765 '), msg)
  })
})
