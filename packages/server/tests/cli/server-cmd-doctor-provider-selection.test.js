/**
 * #8075 — `chroxy start`'s dependency checks preflight the PROVIDER THE
 * MERGED CONFIG SELECTED (`--provider`, `-c <file>`, `CHROXY_PROVIDER` — the
 * same precedence `loadAndMergeConfig`/`mergeConfig` apply everywhere else),
 * not whichever provider the DEFAULT `config.json` names (or DEFAULT_PROVIDER
 * when that file is missing/unset) — `runDoctorChecks`'s own fallback
 * (`resolveProviders` in doctor.js) when it is handed no explicit `providers`
 * override.
 *
 * Found while reviewing #8074 (closes #8041): that PR fixed the
 * binary-provenance MODE half of "chroxy start -c <path> gates from the
 * wrong file" (see `server-cmd.test.js`'s "#8074 review C1" describe block,
 * which explicitly notes this gap and works around it). This is the
 * remaining half — the PROVIDER SELECTION itself.
 *
 * These tests exercise the REAL `start` action (`registerServerCommands`,
 * `src/cli/server-cmd.js`) end-to-end through Commander + the REAL
 * `loadAndMergeConfig` (so `-c` / `--provider` / `CHROXY_PROVIDER` precedence
 * is exercised for real, never re-implemented here) — with `doctor.js`
 * mocked to CAPTURE the exact options `runDoctorChecks` is called with. That
 * capture is the "injected doctor seam": it is the precise defect surface
 * #8075 names (the WIRING between server-cmd.js and doctor.js), not
 * doctor.js's own already-tested `resolveProviders` precedence or its
 * billing-canary / claude-tui version-pin probes (both key off the same
 * `resolvedProviders[0]`, already covered by doctor.test.js /
 * doctor-binary-provenance.test.js for an explicit `providers` array — this
 * file only has to prove server-cmd.js hands `runDoctorChecks` the RIGHT
 * array). `server-cli.js` / `supervisor.js` are mocked too, so nothing real
 * ever starts — no spawned provider binary, no tunnel, no listening socket —
 * matching this repo's "never run chroxy start for real" test-safety rule.
 *
 * Never depends on real provider binaries/credentials being installed on the
 * machine running the suite: the observable asserted on is the `providers`
 * ARRAY handed to `runDoctorChecks`, never a pass/fail binary resolution.
 */
import { describe, it, before, after, beforeEach, afterEach, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { Command } from 'commander'

if (typeof mock.module !== 'function') {
  describe('chroxy start — dependency checks preflight the selected provider (#8075)', () => {
    it('skipped: mock.module requires --experimental-test-module-mocks', (t) => {
      t.skip('re-run with --experimental-test-module-mocks')
    })
  })
} else {
  // ── module mocks, registered BEFORE server-cmd.js — a STATIC importer of
  // doctor.js — is ever imported, so its `import { runDoctorChecks } from
  // '../doctor.js'` resolves to this fake. `server-cli.js` / `supervisor.js`
  // are imported DYNAMICALLY inside the action, so mocking them here (ahead
  // of any invocation) is equally sufficient. ──────────────────────────────
  const realDoctor = await import('../../src/doctor.js')
  const doctorCalls = []
  let doctorResult = { checks: [], passed: true, providers: [] }
  mock.module('../../src/doctor.js', {
    namedExports: {
      ...realDoctor,
      runDoctorChecks: async (opts) => {
        doctorCalls.push(opts)
        return doctorResult
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

  function makeProgram() {
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

  describe('chroxy start — dependency checks preflight the selected provider (#8075)', () => {
    let _tmpRoot
    before(() => {
      _tmpRoot = mkdtempSync(join(tmpdir(), 'chroxy-8075-provider-'))
    })
    after(() => {
      try { rmSync(_tmpRoot, { recursive: true, force: true }) } catch {}
    })

    let configDir
    const savedEnv = {}
    const ENV_KEYS = ['CHROXY_CONFIG_DIR', 'CHROXY_PROVIDER', 'CHROXY_SUPERVISED', 'CHROXY_DAEMON']

    beforeEach(() => {
      configDir = mkdtempSync(join(_tmpRoot, 'run-'))
      for (const key of ENV_KEYS) {
        savedEnv[key] = process.env[key]
        delete process.env[key]
      }
      process.env.CHROXY_CONFIG_DIR = configDir

      doctorCalls.length = 0
      doctorResult = { checks: [], passed: true, providers: [] }
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

    it('--provider codex overrides a default config naming claude-sdk', async () => {
      writeDefaultConfig({ provider: 'claude-sdk' })
      const program = makeProgram()

      await program.parseAsync(['start', '--provider', 'codex', '--no-auth'], { from: 'user' })

      assert.equal(doctorCalls.length, 1, `expected exactly one runDoctorChecks call, got ${doctorCalls.length}`)
      assert.deepEqual(
        doctorCalls[0].providers,
        ['codex'],
        `expected the SELECTED provider (codex) to be preflighted, not the default config's provider (claude-sdk) — got ${JSON.stringify(doctorCalls[0].providers)}`,
      )
      // Sanity: nothing real ever started.
      assert.equal(startedCalls.cli.length, 1)
      assert.equal(startedCalls.supervisor.length, 0)
    })

    it('-c <file> naming gemini overrides a default config naming claude-sdk', async () => {
      writeDefaultConfig({ provider: 'claude-sdk' })
      const otherConfigPath = join(configDir, 'other.json')
      writeFileSync(otherConfigPath, JSON.stringify({ provider: 'gemini', noAuth: true }))
      const program = makeProgram()

      await program.parseAsync(['start', '-c', otherConfigPath], { from: 'user' })

      assert.equal(doctorCalls.length, 1, `expected exactly one runDoctorChecks call, got ${doctorCalls.length}`)
      assert.deepEqual(
        doctorCalls[0].providers,
        ['gemini'],
        `expected the "-c other.json" provider (gemini) to be preflighted, not the default config's provider (claude-sdk) — got ${JSON.stringify(doctorCalls[0].providers)}`,
      )
    })

    it('CHROXY_PROVIDER=gemini overrides a default config naming claude-sdk', async () => {
      writeDefaultConfig({ provider: 'claude-sdk', noAuth: true })
      process.env.CHROXY_PROVIDER = 'gemini'
      const program = makeProgram()

      await program.parseAsync(['start'], { from: 'user' })

      assert.equal(doctorCalls.length, 1, `expected exactly one runDoctorChecks call, got ${doctorCalls.length}`)
      assert.deepEqual(
        doctorCalls[0].providers,
        ['gemini'],
        `expected CHROXY_PROVIDER (gemini) to be preflighted, not the default config's provider (claude-sdk) — got ${JSON.stringify(doctorCalls[0].providers)}. A regression that reads only the parsed CLI \`--provider\` flag (never set here) instead of the MERGED config would ignore this env var and fall through to claude-sdk.`,
      )
    })
  })
}
