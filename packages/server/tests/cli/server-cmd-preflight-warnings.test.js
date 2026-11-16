/**
 * Exercise the real Commander action with synthetic preflight and launch boundaries.
 * Every local dependency is replaced before server-cmd.js is imported: importing
 * the real server or doctor would perform unrelated host/provider discovery.
 * The capture-log cap is stubbed to record only that and when it was called; its
 * byte behaviour belongs to the logger's own tests.
 */
import assert from 'node:assert/strict'
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test'
import { Command } from 'commander'

let fixture
const moduleMocks = [
  mock.module('../../src/cli/shared.js', {
    namedExports: {
      addServerOptions: (command) => command,
      parseExtraOverrides: () => ({}),
      loadAndMergeConfig: (_options, overrides) => {
        fixture.launchConfig = { ...fixture.config, ...overrides }
        return fixture.launchConfig
      },
    },
  }),
  mock.module('../../src/doctor.js', {
    namedExports: {
      runDoctorChecks: async (options) => {
        fixture.doctorCalls.push(options)
        fixture.events.push('doctor')
        return { checks: fixture.checks }
      },
    },
  }),
  mock.module('../../src/tunnel/index.js', {
    namedExports: { parseTunnelArg: (tunnel) => tunnel === 'none' ? null : { mode: tunnel } },
  }),
  mock.module('../../src/config.js', {
    namedExports: {
      resolveBinaryProvenanceMode: () => 'warn',
      isBinarySignatureGateEnabled: () => false,
    },
  }),
  mock.module('../../src/providers.js', {
    namedExports: { resolveDaemonDefaultProvider: (config) => config.provider },
  }),
  mock.module('../../src/server-cli.js', {
    namedExports: {
      startCliServer: async (config) => {
        fixture.directCalls.push(config)
        fixture.events.push('direct')
      },
    },
  }),
  mock.module('../../src/supervisor.js', {
    namedExports: {
      startSupervisor: async (config) => {
        fixture.supervisorCalls.push(config)
        fixture.events.push('supervisor')
      },
    },
  }),
  mock.module('../../src/logger.js', {
    namedExports: {
      capStdioCaptureLogs: () => {
        fixture.captureCalls++
        fixture.events.push('capture')
        return []
      },
    },
  }),
]

const { registerServerCommands } = await import('../../src/cli/server-cmd.js')
after(() => moduleMocks.forEach((handle) => handle.restore()))

const hint = (count) => `${count} preflight warning${count === 1 ? '' : 's'} — run \`chroxy doctor\` for details.`
const check = (name, status) => ({ name, status, message: `${name} detail` })
const envKeys = ['CHROXY_DAEMON', 'CHROXY_SUPERVISED']
let previousEnv
let previousExitCode

beforeEach((t) => {
  previousEnv = Object.fromEntries(envKeys.map((key) => [key, process.env[key]]))
  previousExitCode = process.exitCode
  envKeys.forEach((key) => delete process.env[key])
  process.exitCode = undefined
  fixture = {
    checks: [],
    config: { tunnel: 'quick', provider: 'synthetic-provider', port: 9876 },
    doctorCalls: [],
    directCalls: [],
    supervisorCalls: [],
    captureCalls: 0,
    output: [],
    errors: [],
    events: [],
  }
  t.mock.method(console, 'warn', (...args) => {
    fixture.output.push(args.join(' '))
    fixture.events.push('warning')
  })
  t.mock.method(console, 'log', (...args) => {
    fixture.output.push(args.join(' '))
    fixture.events.push('log')
  })
  t.mock.method(console, 'error', (...args) => {
    fixture.errors.push(args.join(' '))
  })
})

afterEach(() => {
  for (const [key, value] of Object.entries(previousEnv)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
  process.exitCode = previousExitCode
})

async function start(...args) {
  const program = new Command().exitOverride()
  registerServerCommands(program)
  await program.parseAsync(['node', 'chroxy', 'start', ...args])
}

function assertLaunch(branch) {
  assert.equal(fixture.directCalls.length, branch === 'direct' ? 1 : 0)
  assert.equal(fixture.supervisorCalls.length, branch === 'supervisor' ? 1 : 0)
  assert.equal([...fixture.directCalls, ...fixture.supervisorCalls][0], fixture.launchConfig)
  assert.equal(process.exitCode, undefined)
  assert.deepEqual(fixture.errors, [])
}

describe('start preflight warning hint (#8234)', () => {
  it('prints one warning once before direct launch', async () => {
    fixture.checks = [check('credentials', 'warn')]
    await start('--no-supervisor')
    assert.deepEqual(fixture.output, [hint(1)])
    assert.deepEqual(fixture.events, ['doctor', 'warning', 'direct'])
    assertLaunch('direct')
  })

  it('counts only warnings and emits one hint before supervisor launch', async () => {
    fixture.checks = [check('runtime', 'pass'), check('credentials', 'warn'), check('hostname', 'warn')]
    await start()
    assert.deepEqual(fixture.output, [hint(2)])
    assert.deepEqual(fixture.events, ['doctor', 'warning', 'supervisor'])
    assert.equal(fixture.doctorCalls.length, 1)
    assert.deepEqual(fixture.doctorCalls[0], {
      port: 9876,
      providers: ['synthetic-provider'],
      binaryProvenanceMode: 'warn',
      binarySignatureGate: false,
      tunnelMode: 'quick',
      tunnelHostname: null,
    })
    assertLaunch('supervisor')
  })

  for (const [label, checks] of [
    ['pass-only', [check('runtime', 'pass')]],
    ['empty', []],
    ['non-warning status', [check('optional', 'skip')]],
  ]) {
    it(`prints no hint for ${label} results`, async () => {
      fixture.checks = checks
      await start()
      assert.deepEqual(fixture.output, [])
      assert.deepEqual(fixture.events, ['doctor', 'supervisor'])
      assertLaunch('supervisor')
    })
  }

  for (const mixed of [false, true]) {
    it(`${mixed ? 'mixed failures and warnings' : 'failures'} retain failure output, exit code and no launch`, async () => {
      fixture.checks = [check('provider', 'fail')]
      if (mixed) fixture.checks.push(check('credentials', 'warn'), check('runtime', 'pass'))
      await start()
      assert.deepEqual(fixture.errors, [
        '\nPreflight checks failed:\n',
        '  ✗ provider: provider detail',
        '\nRun `chroxy doctor` for details, or `--skip-checks` to bypass.\n',
      ])
      assert.equal(process.exitCode, 1)
      assert.deepEqual(fixture.directCalls, [])
      assert.deepEqual(fixture.supervisorCalls, [])
      assert.deepEqual(fixture.output, [])
      assert.equal(fixture.captureCalls, 0)
    })
  }

  for (const direct of [false, true]) {
    it(`--skip-checks avoids doctor and warning output for ${direct ? 'direct' : 'supervisor'} startup`, async () => {
      fixture.checks = [check('provider', 'fail'), check('credentials', 'warn')]
      await start('--skip-checks', ...(direct ? ['--no-supervisor'] : []))
      assert.deepEqual(fixture.doctorCalls, [])
      assert.deepEqual(fixture.output, [])
      assertLaunch(direct ? 'direct' : 'supervisor')
    })
  }

  for (const [label, config] of [
    ['noAuth', { noAuth: true }],
    ['external URL', { externalUrl: 'https://synthetic.invalid' }],
    ['disabled tunnel', { tunnel: 'none' }],
  ]) {
    it(`preserves ignored cloudflared failures with ${label} and still counts warnings`, async () => {
      Object.assign(fixture.config, config)
      fixture.checks = [check('cloudflared', 'fail'), check('credentials', 'warn')]
      await start()
      assert.deepEqual(fixture.output, [hint(1)])
      assertLaunch('direct')
    })
  }

  it('still blocks cloudflared failure when a tunnel is required', async () => {
    fixture.checks = [check('cloudflared', 'fail'), check('credentials', 'warn')]
    await start()
    assert.equal(process.exitCode, 1)
    assert.ok(fixture.errors.includes('  ✗ cloudflared: cloudflared detail'))
    assert.deepEqual(fixture.output, [])
    assert.deepEqual(fixture.directCalls, [])
    assert.deepEqual(fixture.supervisorCalls, [])
  })

  it('prints once after the daemon capture cap and before supervisor launch', async () => {
    process.env.CHROXY_DAEMON = '1'
    fixture.checks = [check('credentials', 'warn'), check('hostname', 'warn')]
    await start()
    assert.deepEqual(fixture.output, [hint(2)])
    assert.equal(fixture.captureCalls, 1)
    assert.deepEqual(fixture.events, ['doctor', 'capture', 'warning', 'supervisor'])
    assertLaunch('supervisor')
  })

  it('preserves the supervised-child direct branch without repeating the hint', async () => {
    process.env.CHROXY_DAEMON = '1'
    process.env.CHROXY_SUPERVISED = '1'
    fixture.checks = [check('credentials', 'warn')]
    await start()
    assert.deepEqual(fixture.output, [hint(1)])
    assert.equal(fixture.captureCalls, 0)
    assert.deepEqual(fixture.events, ['doctor', 'warning', 'direct'])
    assertLaunch('direct')
  })

  it('does not cap or launch after failed daemon checks', async () => {
    process.env.CHROXY_DAEMON = '1'
    fixture.checks = [check('provider', 'fail'), check('credentials', 'warn')]
    await start()
    assert.equal(process.exitCode, 1)
    assert.equal(fixture.captureCalls, 0)
    assert.deepEqual(fixture.events, ['doctor'])
    assert.deepEqual(fixture.output, [])
    assert.deepEqual(fixture.directCalls, [])
    assert.deepEqual(fixture.supervisorCalls, [])
  })

  it('still calls the capture cap with skipped checks but emits no warning hint', async () => {
    process.env.CHROXY_DAEMON = '1'
    fixture.checks = [check('provider', 'fail'), check('credentials', 'warn')]
    await start('--skip-checks')
    assert.deepEqual(fixture.doctorCalls, [])
    assert.equal(fixture.captureCalls, 1)
    assert.equal(fixture.output.filter((line) => line.includes('preflight warning')).length, 0)
    assert.deepEqual(fixture.events, ['capture', 'supervisor'])
    assertLaunch('supervisor')
  })
})
