import { afterEach, beforeEach, describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// Exercise runDoctorChecks itself, including its real config reader and port
// probe. Replace only the socket boundary so even the default-port case never
// binds or probes a developer's running server.
const listenCalls = []
const realNet = await import('node:net')
mock.module('net', {
  namedExports: {
    ...realNet,
    createServer: () => {
      const server = new EventEmitter()
      server.listen = (port, host) => {
        listenCalls.push({ port, host })
        queueMicrotask(() => server.emit('listening'))
      }
      server.close = (callback) => callback()
      return server
    },
  },
})

// Port precedence does not require any installed provider/tunnel binaries.
// Keep both PATH and fixed-candidate resolution away from real host binaries.
const realBinaryResolver = await import('../src/utils/resolve-binary.js')
mock.module('../src/utils/resolve-binary.js', {
  namedExports: { ...realBinaryResolver, resolveBinary: () => '/nonexistent/chroxy-doctor-port-binary' },
})

const { registerProvider } = await import('../src/providers.js')
const { SdkSession } = await import('../src/sdk-session.js')
const { runDoctorChecks } = await import('../src/doctor.js')
class PortTestProvider extends SdkSession {
  static get preflight() { return null }
}
const PROVIDER = 'doctor-port-test-provider'
registerProvider(PROVIDER, PortTestProvider)

describe('doctor port uses the daemon config precedence', () => {
  let configDir
  let savedEnv
  const envKeys = ['CHROXY_CONFIG_DIR', 'PORT']

  beforeEach(() => {
    savedEnv = Object.fromEntries(envKeys.map(key => [key, process.env[key]]))
    configDir = mkdtempSync(join(tmpdir(), 'chroxy-doctor-port-'))
    process.env.CHROXY_CONFIG_DIR = configDir
    delete process.env.PORT
    listenCalls.length = 0
  })

  afterEach(() => {
    for (const [key, value] of Object.entries(savedEnv)) {
      if (value === undefined) delete process.env[key]
      else process.env[key] = value
    }
    rmSync(configDir, { recursive: true, force: true })
  })

  function writeConfig(config) {
    writeFileSync(join(configDir, 'config.json'), JSON.stringify(config))
  }

  async function checkPort(expectedPort, port) {
    const result = await runDoctorChecks({
      port,
      providers: [PROVIDER],
      binaryProvenanceMode: 'off',
      binarySignatureGate: false,
      detectStranded: () => ({ relocated: false, source: configDir, target: configDir, stranded: [] }),
    })
    assert.deepEqual(listenCalls, [{ port: expectedPort, host: '127.0.0.1' }])
    assert.deepEqual(result.checks.find(check => check.name === 'Port'), {
      name: 'Port', status: 'pass', message: `${expectedPort} is available`,
    })
    return result
  }

  it('uses an explicit CLI port ahead of PORT and the config file', async () => {
    writeConfig({ port: 18431 })
    process.env.PORT = '18432'
    await checkPort(18433, 18433)
  })

  it('uses PORT ahead of the config file and parses it as a number', async () => {
    writeConfig({ port: 18431 })
    process.env.PORT = '18432'
    await checkPort(18432)
  })

  it('uses the config file port when neither CLI nor PORT overrides it', async () => {
    writeConfig({ port: 18431 })
    await checkPort(18431)
  })

  it('uses the default when the config has no port', async () => {
    writeConfig({})
    await checkPort(8765)
  })

  it('still checks the default on first run without a config file', async () => {
    const result = await checkPort(8765)
    const configCheck = result.checks.find(check => check.name === 'Config')
    assert.equal(configCheck.status, 'warn')
    assert.ok(configCheck.message.includes("run 'chroxy init' to create"))
  })

  it('uses PORT even without a config file', async () => {
    process.env.PORT = '18432'
    await checkPort(18432)
  })

  it('uses an explicit CLI port even without a config file', async () => {
    process.env.PORT = '18432'
    await checkPort(18433, 18433)
  })
})
