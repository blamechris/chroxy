/**
 * Exercise the real Commander action with synthetic preflight and launch boundaries.
 * Every local dependency is replaced before server-cmd.js is imported: importing
 * the real server or doctor would perform unrelated host/provider discovery.
 */
import assert from 'node:assert/strict'
import { after, afterEach, beforeEach, describe, it, mock } from 'node:test'
import { Command } from 'commander'

let fixture
const captureMaxSize = 5 * 1024 * 1024
const captureTailKeep = 1024 * 1024

// Byte-faithful in-memory model of the existing logger's append-style capture:
// keep the last MiB, trim its partial first line, then truncate the active log.
// No logger import, filesystem operation, file descriptor or daemon is involved.
function capSyntheticCapture() {
  const capture = fixture.capture
  if (!capture || capture.platform === 'win32' || capture.active.length <= captureMaxSize) return []
  let tail = capture.active.subarray(capture.active.length - captureTailKeep)
  const newline = tail.indexOf(0x0a)
  if (newline !== -1 && newline < tail.length - 1) tail = tail.subarray(newline + 1)
  capture.archive = Buffer.from(tail)
  capture.active = Buffer.alloc(0)
  return [{ file: '/synthetic/chroxy-stderr.log', archive: '/synthetic/chroxy-stderr.old.log', preservedBytes: tail.length }]
}

function appendSyntheticStderr(message) {
  if (fixture.capture) {
    fixture.capture.active = Buffer.concat([fixture.capture.active, Buffer.from(message + '\n')])
  }
}

function seedCapture(bytes = Buffer.from('old capture café\n'.repeat(330000)), platform = 'linux') {
  fixture.capture = { platform, active: Buffer.from(bytes), archive: null }
  return Buffer.from(bytes)
}

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
        return capSyntheticCapture()
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
    capture: null,
    output: [],
    errors: [],
    events: [],
  }
  t.mock.method(console, 'warn', (...args) => {
    fixture.output.push(args.join(' '))
    appendSyntheticStderr(args.join(' '))
    fixture.events.push('warning')
  })
  t.mock.method(console, 'log', (...args) => {
    fixture.output.push(args.join(' '))
    fixture.events.push('capture-notice')
  })
  t.mock.method(console, 'error', (...args) => {
    fixture.errors.push(args.join(' '))
    appendSyntheticStderr(args.join(' '))
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

  it('prints once after synthetic daemon capture maintenance and before supervisor launch', async () => {
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

  it('retains the hint in the current daemon log after byte-faithful capture capping', async () => {
    process.env.CHROXY_DAEMON = '1'
    const original = seedCapture()
    fixture.checks = [check('credentials', 'warn')]
    await start()
    assert.ok(fixture.capture.active.equals(Buffer.from(hint(1) + '\n')), 'the current boot log must retain the startup hint')
    assert.ok(!fixture.capture.archive.includes(Buffer.from('preflight warning')), 'the archive contains only earlier capture bytes')
    let expectedTail = original.subarray(original.length - captureTailKeep)
    const newline = expectedTail.indexOf(0x0a)
    if (newline !== -1 && newline < expectedTail.length - 1) expectedTail = expectedTail.subarray(newline + 1)
    assert.ok(fixture.capture.archive.equals(expectedTail), 'preserve the exact final byte tail after whole-line adjustment')
    assert.deepEqual(fixture.events, ['doctor', 'capture', 'capture-notice', 'warning', 'supervisor'])
    assert.equal(fixture.output.filter((line) => line === hint(1)).length, 1)
    assert.equal(fixture.captureCalls, 1)
    assertLaunch('supervisor')
  })

  it('does not make a capture at the exact size threshold oversized before capping', async () => {
    process.env.CHROXY_DAEMON = '1'
    const original = seedCapture(Buffer.alloc(captureMaxSize, 0x78))
    fixture.checks = [check('credentials', 'warn')]
    await start()
    assert.ok(fixture.capture.archive === null, 'the existing cap applies only above 5 MiB')
    assert.ok(fixture.capture.active.equals(Buffer.concat([original, Buffer.from(hint(1) + '\n')])))
    assert.deepEqual(fixture.events, ['doctor', 'capture', 'warning', 'supervisor'])
    assertLaunch('supervisor')
  })

  it('preserves the synthetic Windows logger no-op before warning output', async () => {
    process.env.CHROXY_DAEMON = '1'
    const original = seedCapture(undefined, 'win32')
    fixture.checks = [check('credentials', 'warn')]
    await start()
    assert.ok(fixture.capture.archive === null)
    assert.ok(fixture.capture.active.equals(Buffer.concat([original, Buffer.from(hint(1) + '\n')])))
    assert.equal(fixture.captureCalls, 1, 'the command still calls the logger, which excludes Windows itself')
    assert.deepEqual(fixture.events, ['doctor', 'capture', 'warning', 'supervisor'])
    assertLaunch('supervisor')
  })

  for (const supervised of [false, true]) {
    it(`does not cap an oversized synthetic log for ${supervised ? 'a supervised child' : 'a non-daemon start'}`, async () => {
      if (supervised) {
        process.env.CHROXY_DAEMON = '1'
        process.env.CHROXY_SUPERVISED = '1'
      }
      const original = seedCapture()
      fixture.checks = [check('credentials', 'warn')]
      await start()
      assert.equal(fixture.captureCalls, 0)
      assert.ok(fixture.capture.archive === null)
      assert.ok(fixture.capture.active.equals(Buffer.concat([original, Buffer.from(hint(1) + '\n')])))
      assert.deepEqual(fixture.events, ['doctor', 'warning', supervised ? 'direct' : 'supervisor'])
      assertLaunch(supervised ? 'direct' : 'supervisor')
    })
  }

  it('does not cap or launch after failed daemon checks with an oversized capture', async () => {
    process.env.CHROXY_DAEMON = '1'
    seedCapture()
    fixture.checks = [check('provider', 'fail'), check('credentials', 'warn')]
    await start()
    assert.equal(process.exitCode, 1)
    assert.equal(fixture.captureCalls, 0)
    assert.ok(fixture.capture.archive === null)
    assert.deepEqual(fixture.events, ['doctor'])
    assert.deepEqual(fixture.output, [])
    assert.deepEqual(fixture.directCalls, [])
    assert.deepEqual(fixture.supervisorCalls, [])
  })

  it('still caps a daemon capture with skipped checks but emits no warning hint', async () => {
    process.env.CHROXY_DAEMON = '1'
    seedCapture()
    fixture.checks = [check('provider', 'fail'), check('credentials', 'warn')]
    await start('--skip-checks')
    assert.deepEqual(fixture.doctorCalls, [])
    assert.equal(fixture.captureCalls, 1)
    assert.equal(fixture.capture.active.length, 0)
    assert.ok(fixture.capture.archive.length > 0)
    assert.equal(fixture.output.filter((line) => line.includes('preflight warning')).length, 0)
    assert.deepEqual(fixture.events, ['capture', 'capture-notice', 'supervisor'])
    assertLaunch('supervisor')
  })
})
