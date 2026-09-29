/**
 * #8116 — `chroxy start`'s dependency checks probe the named-tunnel
 * ROUTABILITY (`checkTunnelRoutability`, doctor.js step 5.6, #5328 WP-5.6)
 * using the MERGED config's tunnel coordinates (`-c <path>`, `--tunnel`,
 * `--tunnel-hostname`, `CHROXY_TUNNEL*` env — the same precedence
 * `loadAndMergeConfig`/`mergeConfig` apply everywhere else), not whichever
 * tunnel doctor's OWN default `config.json` names — `runDoctorChecks`'s
 * fallback file-read (doctor.js ~455-486) when it is handed no explicit
 * `tunnelMode` / `tunnelHostname` override.
 *
 * This is the last member of the defect family #8074 (binary-provenance
 * mode) and #8115/#8075 (provider selection) closed — same defect shape
 * (server-cmd.js resolves the merged config, but doesn't hand doctor.js the
 * piece of it doctor.js needs), same fix shape (an explicit override seam on
 * `runDoctorChecks` that REPLACES the default-file read when supplied).
 *
 * Like #8115's sibling file, this exercises the REAL `start` action
 * (`registerServerCommands`, `src/cli/server-cmd.js`) end-to-end through
 * Commander + the REAL `loadAndMergeConfig` — `-c` / `--tunnel` /
 * `--tunnel-hostname` precedence is exercised for real, never
 * re-implemented here. `doctor.js` is module-mocked, but NOT to fake away
 * the routability-probe logic under test: the mock CAPTURES the exact
 * options `runDoctorChecks` is called with (the precise wiring #8116 fixes),
 * then drives the REAL, unmocked `checkTunnelRoutability` export with
 * whatever `tunnelMode` / `tunnelHostname` were captured, through this
 * test's own injected `tunnelProbe`. That proves two things at once: (1)
 * server-cmd.js hands `runDoctorChecks` the coordinates the MERGED config
 * resolved, and (2) those coordinates, fed through doctor.js's own real
 * probe machinery, actually reach the probe with the right URL — not merely
 * that a raw value was captured.
 *
 * Every OTHER doctor check (cloudflared / provider binary resolution,
 * Dependencies, credentials) is deliberately never exercised here — this
 * file is about the tunnel-coordinate wiring alone, and letting the REST of
 * `runDoctorChecks` run for real would risk resolving and exec'ing a REAL,
 * host-installed `claude`/`cloudflared` (the #8096 real-binary tripwire
 * fires on exactly that; doctor.js's own try/catch would swallow the
 * resulting error into a `fail` row rather than crash, but there's no reason
 * to invite it). `server-cli.js` / `supervisor.js` are also module-mocked so
 * nothing real ever starts — no spawned provider binary, no tunnel, no
 * listening socket — matching #8115's pattern and this repo's "never run
 * chroxy start for real" test-safety rule.
 */
import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'

if (typeof mock.module !== 'function') {
  describe('chroxy start — dependency checks probe the selected tunnel (#8116)', () => {
    it('skipped: mock.module requires --experimental-test-module-mocks', (t) => {
      t.skip('re-run with --experimental-test-module-mocks')
    })
  })
} else {
  // ── module mocks, registered BEFORE server-cmd.js / doctor-cmd.js — both
  // STATIC/dynamic importers of doctor.js — are ever imported, so their
  // `runDoctorChecks` resolves to this fake. `server-cli.js` / `supervisor.js`
  // are imported dynamically inside the `start` action, so mocking them here
  // (ahead of any invocation) is equally sufficient. ─────────────────────────
  const realDoctor = await import('../../src/doctor.js')
  const doctorCalls = []
  const tunnelProbeCalls = []

  mock.module('../../src/doctor.js', {
    namedExports: {
      ...realDoctor,
      runDoctorChecks: async (opts) => {
        doctorCalls.push(opts)
        // Drive the REAL checkTunnelRoutability (never mocked) with exactly
        // the tunnelMode/tunnelHostname this call received — the precise
        // seam #8116 adds to the real runDoctorChecks — through this test's
        // injected probe. Every other doctor check is skipped (see file
        // docblock for why).
        const tunnelCheck = await realDoctor.checkTunnelRoutability({
          mode: opts.tunnelMode,
          hostname: opts.tunnelHostname,
          probe: async (url, timeoutMs) => {
            tunnelProbeCalls.push({ url, timeoutMs })
            return { ok: true, status: 200 }
          },
        })
        return { checks: tunnelCheck ? [tunnelCheck] : [], passed: true, providers: [] }
      },
    },
  })

  const startedCalls = { cli: [], supervisor: [] }
  mock.module('../../src/server-cli.js', {
    namedExports: {
      startCliServer: async (config) => { startedCalls.cli.push(config) },
    },
  })
  mock.module('../../src/supervisor.js', {
    namedExports: {
      startSupervisor: async (config) => { startedCalls.supervisor.push(config) },
    },
  })

  const { registerServerCommands } = await import('../../src/cli/server-cmd.js')
  const { registerDoctorCommand } = await import('../../src/cli/doctor-cmd.js')

  function makeStartProgram() {
    const program = new Command()
    // Convert Commander's own process.exit calls into thrown errors so a
    // parse mistake in a test fails loudly instead of killing the whole
    // test worker. Must run BEFORE registerServerCommands() — copyInherited
    // Settings() (Commander) snapshots _exitCallback onto the `start`
    // subcommand at `.command()` time.
    program.exitOverride()
    registerServerCommands(program)
    return program
  }

  function makeDoctorProgram() {
    const program = new Command()
    program.exitOverride()
    registerDoctorCommand(program)
    return program
  }

  describe('chroxy start — dependency checks probe the selected tunnel (#8116)', () => {
    let _tmpRoot
    before(() => {
      _tmpRoot = mkdtempSync(join(tmpdir(), 'chroxy-8116-tunnel-'))
    })
    after(() => {
      try { rmSync(_tmpRoot, { recursive: true, force: true }) } catch {}
    })

    let configDir
    const savedEnv = {}
    const ENV_KEYS = ['CHROXY_CONFIG_DIR', 'CHROXY_TUNNEL', 'CHROXY_TUNNEL_HOSTNAME', 'CHROXY_SUPERVISED', 'CHROXY_DAEMON']

    beforeEach(() => {
      configDir = mkdtempSync(join(_tmpRoot, 'run-'))
      for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key]
        delete process.env[key]
      }
      process.env.CHROXY_CONFIG_DIR = configDir

      doctorCalls.length = 0
      tunnelProbeCalls.length = 0
      startedCalls.cli.length = 0
      startedCalls.supervisor.length = 0
    })

    afterEach(() => {
      for (const [key, value] of Object.entries(savedEnv)) {
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
    })

    function writeDefaultConfig(obj) {
      writeFileSync(join(configDir, 'config.json'), JSON.stringify(obj))
    }

    it('-c <file> naming a named tunnel probes THAT hostname, not the default config\'s', async () => {
      // The DEFAULT config.json names a DIFFERENT named tunnel — if
      // server-cmd.js (pre-fix) hands runDoctorChecks no override at all,
      // doctor's fallback file-read would find THIS one instead, and the
      // probe would fire against the wrong host (or not at all, since the
      // fallback reads doctor's default file via a plain existsSync/
      // readFileSync — CHROXY_CONFIG_DIR is redirected to `configDir` for
      // both files here, so this really is "the default file names a
      // different tunnel", not merely "no file").
      writeDefaultConfig({ tunnel: 'named', tunnelHostname: 'default.example.test', noAuth: true })
      const otherConfigPath = join(configDir, 'other.json')
      writeFileSync(otherConfigPath, JSON.stringify({
        tunnel: 'named',
        tunnelHostname: 'other.example.test',
        noAuth: true,
      }))
      const program = makeStartProgram()

      await program.parseAsync(['start', '-c', otherConfigPath], { from: 'user' })

      assert.equal(doctorCalls.length, 1, `expected exactly one runDoctorChecks call, got ${doctorCalls.length}`)
      assert.equal(
        doctorCalls[0].tunnelMode,
        'named',
        `expected the "-c other.json" tunnel mode (named) to be passed through — got ${JSON.stringify(doctorCalls[0].tunnelMode)}`,
      )
      assert.equal(
        doctorCalls[0].tunnelHostname,
        'other.example.test',
        `expected the "-c other.json" hostname to be passed through, not the default config's — got ${JSON.stringify(doctorCalls[0].tunnelHostname)}`,
      )
      assert.equal(tunnelProbeCalls.length, 1, `expected exactly one routability probe call, got ${tunnelProbeCalls.length}`)
      assert.equal(
        tunnelProbeCalls[0].url,
        'https://other.example.test/',
        `expected the probe to target the "-c other.json" hostname — got ${JSON.stringify(tunnelProbeCalls[0])}`,
      )
      // Sanity: nothing real ever started.
      assert.equal(startedCalls.cli.length, 1)
      assert.equal(startedCalls.supervisor.length, 0)
    })

    it('--tunnel quick overrides a default config naming a named tunnel — no probe', async () => {
      writeDefaultConfig({ tunnel: 'named', tunnelHostname: 'default.example.test', noAuth: true })
      const program = makeStartProgram()

      await program.parseAsync(['start', '--tunnel', 'quick'], { from: 'user' })

      assert.equal(doctorCalls.length, 1, `expected exactly one runDoctorChecks call, got ${doctorCalls.length}`)
      assert.equal(
        doctorCalls[0].tunnelMode,
        'quick',
        `expected the CLI-overridden tunnel mode (quick) to be passed through, not the default config's (named) — got ${JSON.stringify(doctorCalls[0].tunnelMode)}`,
      )
      assert.equal(tunnelProbeCalls.length, 0, `a quick tunnel has no stable hostname to probe — expected 0 calls, got ${tunnelProbeCalls.length}`)
    })

    it('--tunnel none — no probe', async () => {
      writeDefaultConfig({ tunnel: 'named', tunnelHostname: 'default.example.test', noAuth: true })
      const program = makeStartProgram()

      await program.parseAsync(['start', '--tunnel', 'none', '--no-auth'], { from: 'user' })

      assert.equal(doctorCalls.length, 1, `expected exactly one runDoctorChecks call, got ${doctorCalls.length}`)
      assert.equal(
        doctorCalls[0].tunnelMode,
        null,
        `expected "--tunnel none" to resolve to a null mode override — got ${JSON.stringify(doctorCalls[0].tunnelMode)}`,
      )
      assert.equal(tunnelProbeCalls.length, 0, `no tunnel means no stable hostname to probe — expected 0 calls, got ${tunnelProbeCalls.length}`)
    })

    it('a named tunnel with no configured hostname — no probe (nothing to probe)', async () => {
      writeDefaultConfig({ noAuth: true })
      const program = makeStartProgram()

      await program.parseAsync(['start', '--tunnel', 'named', '--no-auth'], { from: 'user' })

      assert.equal(doctorCalls.length, 1, `expected exactly one runDoctorChecks call, got ${doctorCalls.length}`)
      assert.equal(doctorCalls[0].tunnelMode, 'named')
      assert.equal(
        doctorCalls[0].tunnelHostname,
        null,
        `expected no configured hostname to resolve to a null override — got ${JSON.stringify(doctorCalls[0].tunnelHostname)}`,
      )
      assert.equal(tunnelProbeCalls.length, 0, `no hostname means no stable target to probe — expected 0 calls, got ${tunnelProbeCalls.length}`)
    })

    it('chroxy doctor (no override) still reads the default config file — positive control', async () => {
      writeDefaultConfig({ tunnel: 'named', tunnelHostname: 'default.example.test' })
      const program = makeDoctorProgram()

      await program.parseAsync(['doctor'], { from: 'user' })

      assert.equal(doctorCalls.length, 1, `expected exactly one runDoctorChecks call, got ${doctorCalls.length}`)
      assert.equal(
        doctorCalls[0].tunnelMode,
        undefined,
        `chroxy doctor must never pass a tunnelMode override — got ${JSON.stringify(doctorCalls[0].tunnelMode)}`,
      )
      assert.equal(
        doctorCalls[0].tunnelHostname,
        undefined,
        `chroxy doctor must never pass a tunnelHostname override — got ${JSON.stringify(doctorCalls[0].tunnelHostname)}`,
      )
      // With no override, runDoctorChecks's own real config resolution (not
      // exercised by this file's fake, which only forwards opts.tunnelMode/
      // opts.tunnelHostname straight through) is doctor.test.js's job — see
      // "runDoctorChecks fires the probe for a configured named tunnel" there.
      // This test's job is only to prove doctor-cmd.js itself never grew an
      // override it shouldn't have.
    })
  })
}
