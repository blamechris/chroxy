import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative } from 'node:path'
import { runDoctorChecks, checkBinary, isBundledOrSupervisedContext, parseLeadingSemver, compareSemver, checkClaudeTuiCliVersion, checkClaudeLogin, checkTunnelRoutability } from '../src/doctor.js'
import { TESTED_CLAUDE_TUI_CLI_VERSION } from '../src/claude-tui/tested-cli-version.js'
import { registerProvider, DEFAULT_PROVIDER } from '../src/providers.js'
import { SdkSession } from '../src/sdk-session.js'
import { sdkClaudeCodeVersion, CLAUDE_SDK_MIN_CLI_VERSION } from '../src/utils/agent-sdk-version.js'
import { resolveDeclaredMinVersion } from '../src/utils/binary-version.js'

/**
 * Integration tests for doctor.js.
 * Tests run against the real system — binaries are resolved via PATH.
 *
 * Most tests pin an explicit `providers` array so results do NOT depend
 * on whichever provider is configured in the developer's local
 * ~/.chroxy/config.json (which would otherwise make the suite flaky).
 */

describe('runDoctorChecks', () => {
  it('returns checks array, passed boolean, and providers list', async () => {
    const result = await runDoctorChecks({ providers: ['claude-sdk'] })
    assert.ok(Array.isArray(result.checks))
    assert.equal(typeof result.passed, 'boolean')
    assert.ok(Array.isArray(result.providers))
    assert.ok(result.providers.includes('claude-sdk'))
    assert.ok(result.checks.length >= 6, 'Should have at least 6 checks')
  })

  it('each check has name, status, and message', async () => {
    const { checks } = await runDoctorChecks({ providers: ['claude-sdk'] })
    for (const check of checks) {
      assert.equal(typeof check.name, 'string')
      assert.ok(['pass', 'warn', 'fail'].includes(check.status), `Invalid status: ${check.status}`)
      assert.equal(typeof check.message, 'string')
    }
  })

  it('Node.js version check is present', async () => {
    const { checks } = await runDoctorChecks({ providers: ['claude-sdk'] })
    const nodeCheck = checks.find(c => c.name === 'Node.js')
    assert.ok(nodeCheck)
    assert.ok(nodeCheck.message.includes('v'))
    // Node 22 should pass (our test environment uses Node 22)
    assert.equal(nodeCheck.status, 'pass')
  })

  it('cloudflared check is present', async () => {
    const { checks } = await runDoctorChecks({ providers: ['claude-sdk'] })
    const cfCheck = checks.find(c => c.name === 'cloudflared')
    assert.ok(cfCheck)
    // Status depends on whether cloudflared is in PATH
    assert.ok(['pass', 'fail'].includes(cfCheck.status))
  })

  it('claude CLI check is present when a claude provider is configured', async () => {
    const { checks } = await runDoctorChecks({ providers: ['claude-cli'] })
    const claudeCheck = checks.find(c => c.name === 'claude')
    assert.ok(claudeCheck)
    assert.equal(claudeCheck.provider, 'claude-cli')
  })

  it('config check is present', async () => {
    const { checks } = await runDoctorChecks({ providers: ['claude-sdk'] })
    const configCheck = checks.find(c => c.name === 'Config')
    assert.ok(configCheck)
  })

  describe('resolveProviders honours CHROXY_PROVIDER, and never misreads CHROXY_PROVIDERS as a name list (#8151 S6 / round-2 Critical 2)', () => {
    // Before the S6 fix, `chroxy doctor` (and the image's own preflight) fell
    // straight from "no explicit --provider" to the CONFIG FILE's provider,
    // skipping the env tier entirely — a Docker image with no config file yet
    // written and `CHROXY_PROVIDER=claude-sdk` set still reported/preflighted
    // DEFAULT_PROVIDER (claude-tui), the one provider the image doesn't
    // support. A DEDICATED temp CHROXY_CONFIG_DIR guarantees no config.json is
    // present (the real fix only matters when the file tier has nothing to
    // say), independent of whatever other tests in this file/worker write to
    // the shared sandboxed config dir.
    //
    // The S6 fix was ITSELF a regression (round-2 review, Critical 2): it read
    // `CHROXY_PROVIDERS` (plural) as a comma-separated list of PROVIDER NAMES.
    // But CHROXY_PROVIDERS is a REAL, documented env var for `config.providers`
    // (the anthropic/openai-compatible endpoint registrations — array OR
    // object, see config.js's CONFIG_SCHEMA + parseEnvValue) — not a provider
    // roster. Its documented JSON-object form got comma-split into garbage
    // tokens, and a daemon running CHROXY_PROVIDER=claude-sdk alongside an
    // unrelated CHROXY_PROVIDERS had doctor check the WRONG provider. The
    // tests below pin the CORRECTED behaviour: CHROXY_PROVIDERS is fed through
    // mergeConfig exactly like the real daemon does (parsed as config.providers,
    // never read by resolveDaemonDefaultProvider) and never contributes bogus
    // provider names to what doctor preflights.
    const withIsolatedEnv = async (envOverrides, fn, fileConfig = null) => {
      const configDir = mkdtempSync(join(tmpdir(), 'chroxy-doctor-provider-env-'))
      // CHROXY_CONFIG_DIR is a SIDE EFFECT of this helper (for isolation), not
      // one of the caller's explicit overrides — it must be saved/restored
      // too, or leaving it pointed at the tmpdir this function deletes below
      // would corrupt CHROXY_CONFIG_DIR for every test that runs after this
      // one in the same process (confirmed the hard way: the first version of
      // this helper only saved/restored the override KEYS and broke every
      // later checkTunnelRoutability test in this file with an ENOENT on the
      // now-deleted config.json).
      const savedKeys = [...Object.keys(envOverrides), 'CHROXY_CONFIG_DIR']
      const saved = {}
      for (const k of savedKeys) saved[k] = process.env[k]
      process.env.CHROXY_CONFIG_DIR = configDir
      for (const [k, v] of Object.entries(envOverrides)) {
        if (v === undefined) delete process.env[k]
        else process.env[k] = v
      }
      // #8151 round-2 review (S-d): optional — the FILE tier of
      // resolveProviders' precedence had no coverage at all (only env and
      // bare-default were tested). Written into THIS isolated configDir,
      // never the developer's real ~/.chroxy.
      if (fileConfig) writeFileSync(join(configDir, 'config.json'), JSON.stringify(fileConfig))
      try {
        return await fn()
      } finally {
        for (const k of savedKeys) {
          if (saved[k] === undefined) delete process.env[k]
          else process.env[k] = saved[k]
        }
        rmSync(configDir, { recursive: true, force: true })
      }
    }

    it('CHROXY_PROVIDER=claude-sdk (no config file, no explicit --provider) resolves to claude-sdk, not DEFAULT_PROVIDER', async () => {
      const { providers } = await withIsolatedEnv({ CHROXY_PROVIDER: 'claude-sdk' }, () => runDoctorChecks({}))
      assert.deepEqual(providers, ['claude-sdk'])
    })

    it('an explicit providers option still wins over the env var (CLI > ENV precedence)', async () => {
      const { providers } = await withIsolatedEnv({ CHROXY_PROVIDER: 'claude-sdk' }, () => runDoctorChecks({ providers: ['gemini'] }))
      assert.deepEqual(providers, ['gemini'])
    })

    it('with neither an env var nor a config file, still falls back to DEFAULT_PROVIDER (no regression on the old floor)', async () => {
      const { providers } = await withIsolatedEnv({ CHROXY_PROVIDER: undefined, CHROXY_PROVIDERS: undefined }, () => runDoctorChecks({}))
      assert.deepEqual(providers, [DEFAULT_PROVIDER])
    })

    // --- round-2 Critical 2: CHROXY_PROVIDERS must never be misread as names ---

    it('CHROXY_PROVIDERS set to its documented JSON-object form yields no bogus provider names — claude-sdk is still what gets checked', async () => {
      const { providers } = await withIsolatedEnv(
        { CHROXY_PROVIDER: 'claude-sdk', CHROXY_PROVIDERS: '{"anthropicCompatible":[{"name":"x","baseUrl":"https://x.example.test","apiKey":"k"}]}' },
        () => runDoctorChecks({}),
      )
      // The old (S6) bug comma-split the JSON text itself, producing garbage
      // tokens like '{"anthropicCompatible":[{"name":"x"' as "provider names".
      // The fix must resolve to EXACTLY the one real provider the daemon
      // runs, with the JSON-object value never touched by provider
      // resolution at all.
      assert.deepEqual(providers, ['claude-sdk'])
    })

    it('CHROXY_PROVIDERS set to its legacy comma-separated array form (no CHROXY_PROVIDER) still falls back to DEFAULT_PROVIDER, not the CHROXY_PROVIDERS entries', async () => {
      const { providers } = await withIsolatedEnv(
        { CHROXY_PROVIDER: undefined, CHROXY_PROVIDERS: 'gemini,claude-sdk' },
        () => runDoctorChecks({}),
      )
      // This is the exact shape the old bug got right BY ACCIDENT (a plain
      // csv of provider-shaped strings) — pinned here specifically because a
      // fix that special-cased "looks like provider names" rather than
      // dropping the CHROXY_PROVIDERS read entirely would still pass the
      // JSON-object test above yet reintroduce this one. CHROXY_PROVIDERS
      // has no bearing on which PROVIDER runs, so with no CHROXY_PROVIDER
      // and no config file this must still be the bare DEFAULT_PROVIDER —
      // never ['gemini', 'claude-sdk'].
      assert.deepEqual(providers, [DEFAULT_PROVIDER])
    })

    it('CHROXY_PROVIDER beats CHROXY_PROVIDERS when both are set — they answer different questions, not a precedence tie', async () => {
      const { providers } = await withIsolatedEnv(
        { CHROXY_PROVIDER: 'claude-sdk', CHROXY_PROVIDERS: 'gemini' },
        () => runDoctorChecks({}),
      )
      assert.deepEqual(providers, ['claude-sdk'])
    })

    // #8151 round-2 review (S-d) — the FILE tier of resolveProviders'
    // precedence (CLI > ENV > file > default) had no coverage at all; only
    // the env and bare-default tiers were tested.
    it('a config file with {provider: "gemini"} and no env resolves to [\'gemini\']', async () => {
      const { providers } = await withIsolatedEnv(
        { CHROXY_PROVIDER: undefined, CHROXY_PROVIDERS: undefined },
        () => runDoctorChecks({}),
        { provider: 'gemini' },
      )
      assert.deepEqual(providers, ['gemini'])
    })

    it('CHROXY_PROVIDER beats a config file provider (ENV > file precedence)', async () => {
      const { providers } = await withIsolatedEnv(
        { CHROXY_PROVIDER: 'claude-sdk' },
        () => runDoctorChecks({}),
        { provider: 'gemini' },
      )
      assert.deepEqual(providers, ['claude-sdk'])
    })
  })

  describe('Billing check (#5821)', () => {
    const AFTER = Date.UTC(2026, 5, 16) // one day into the programmatic-credit era
    const BEFORE = Date.UTC(2026, 5, 1) // before the cutover

    // The claude-sdk billing class depends on ANTHROPIC_API_KEY (env → api-key
    // billing). Pin the env per test so results don't depend on the dev/CI shell.
    const withEnv = async (apiKey, fn) => {
      const saved = process.env.ANTHROPIC_API_KEY
      if (apiKey === null) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = apiKey
      try { return await fn() } finally {
        if (saved === undefined) delete process.env.ANTHROPIC_API_KEY
        else process.env.ANTHROPIC_API_KEY = saved
      }
    }

    it('warns when the default provider meters silently, once an operator declares the era (#7333)', async () => {
      // The date alone no longer turns the era on: Anthropic paused the
      // programmatic-credit change on 2026-06-15 and it never shipped, so the
      // doctor was warning about a regime that does not exist. `AFTER` is now
      // necessary but not sufficient — an operator has to declare it.
      const savedEra = process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA
      process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA = '1'
      try {
        const { checks } = await withEnv(null, () => runDoctorChecks({ providers: ['claude-sdk'], now: AFTER }))
        const billing = checks.find(c => c.name === 'Billing')
        assert.ok(billing)
        assert.equal(billing.status, 'warn')
        assert.match(billing.message, /metered programmatic-credit pool/)
      } finally {
        // SAVE/RESTORE, not an unconditional delete: clobbering an ambient
        // value would leave every later assertion in this file depending on
        // machine state.
        if (savedEra === undefined) delete process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA
        else process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA = savedEra
      }
    })

    it('does NOT warn about metering by default, at any date (#7333)', async () => {
      // The user-visible fix: with no operator flag, no date produces billing
      // advice about the paused regime.
      //
      // The flag is forced OFF rather than assumed absent. Relying on the
      // ambient environment would mean this case silently stops testing the
      // default on any machine where an operator has set the flag — the same
      // read-ambient-state class as #7360.
      const savedEra = process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA
      delete process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA
      try {
        for (const now of [AFTER, Date.UTC(2027, 0, 1)]) {
          const { checks } = await withEnv(null, () => runDoctorChecks({ providers: ['claude-sdk'], now }))
          const billing = checks.find(c => c.name === 'Billing')
          assert.ok(billing)
          assert.equal(/metered programmatic-credit pool/.test(billing.message), false, `warned at ${now}`)
        }
      } finally {
        if (savedEra === undefined) delete process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA
        else process.env.CHROXY_PROGRAMMATIC_CREDIT_ERA = savedEra
      }
    })

    it('does NOT warn for claude-sdk when ANTHROPIC_API_KEY is set (BYOK)', async () => {
      const { checks } = await withEnv('sk-test-key', () => runDoctorChecks({ providers: ['claude-sdk'], now: AFTER }))
      const billing = checks.find(c => c.name === 'Billing')
      assert.ok(billing)
      assert.equal(billing.status, 'pass')
      assert.match(billing.message, /API key/) // billingDetailForClass(api-key)
    })

    it('passes for a subscription default (claude-tui) in the era', async () => {
      const { checks } = await withEnv(null, () => runDoctorChecks({ providers: ['claude-tui'], now: AFTER }))
      const billing = checks.find(c => c.name === 'Billing')
      assert.ok(billing)
      assert.equal(billing.status, 'pass')
      assert.match(billing.message, /claude-tui/)
    })

    it('passes before the cutover and surfaces the upcoming date', async () => {
      const { checks } = await withEnv(null, () => runDoctorChecks({ providers: ['claude-sdk'], now: BEFORE }))
      const billing = checks.find(c => c.name === 'Billing')
      assert.ok(billing)
      assert.equal(billing.status, 'pass')
      assert.match(billing.message, /cutover: 2026-06-15/)
    })
  })

  it('dependencies check is present', async () => {
    const { checks } = await runDoctorChecks({ providers: ['claude-sdk'] })
    const depsCheck = checks.find(c => c.name === 'Dependencies')
    assert.ok(depsCheck)
    // In the normal test environment, the server package's own node_modules
    // installation should make this pass independent of the caller's cwd.
    // We still allow 'fail' here as a soft assertion — some packaging
    // contexts (e.g. a pruned bundle) may legitimately lack node_modules.
    assert.ok(['pass', 'fail'].includes(depsCheck.status))
  })

  it('port check is present', async () => {
    const { checks } = await runDoctorChecks({ providers: ['claude-sdk'] })
    const portCheck = checks.find(c => c.name === 'Port')
    assert.ok(portCheck)
  })

  it('accepts custom port', async () => {
    // Use a random high port that's unlikely to be in use
    const { checks } = await runDoctorChecks({ port: 59123, providers: ['claude-sdk'] })
    const portCheck = checks.find(c => c.name === 'Port')
    assert.ok(portCheck)
    assert.ok(portCheck.message.includes('59123'))
    assert.equal(portCheck.status, 'pass')
  })

  it('passed is true when no failures', async () => {
    const { passed, checks } = await runDoctorChecks({ port: 59124, providers: ['claude-sdk'] })
    const failures = checks.filter(c => c.status === 'fail')
    if (failures.length === 0) {
      assert.equal(passed, true)
    } else {
      // On some systems, checks may fail — that's ok for integration tests
      assert.equal(passed, false)
    }
  })

  it('passed is false when any check fails', async () => {
    // Verify the logic: if we had a failing check, passed would be false
    const mockChecks = [
      { name: 'A', status: 'pass', message: 'ok' },
      { name: 'B', status: 'fail', message: 'bad' },
      { name: 'C', status: 'warn', message: 'meh' },
    ]
    const passed = mockChecks.every(c => c.status !== 'fail')
    assert.equal(passed, false)
  })

  it('dependencies check resolves relative to server package by default', async () => {
    // Regression: previously the check used join(process.cwd(), 'node_modules').
    // Tauri launches the server with cwd='/' under launchd, which always
    // failed this check and blocked server startup. The fix resolves
    // node_modules relative to the server package itself. We no longer
    // need to mutate process.cwd() — runDoctorChecks is self-contained
    // and passes regardless of the caller's working directory.
    const { checks } = await runDoctorChecks({ providers: ['claude-sdk'] })
    const depsCheck = checks.find(c => c.name === 'Dependencies')
    assert.ok(depsCheck)
    // With node_modules installed in packages/server/, this must pass
    // regardless of the caller's working directory.
    assert.equal(depsCheck.status, 'pass', `expected pass, got ${depsCheck.status}: ${depsCheck.message}`)
  })

  it('dependencies check fails when pkgDir override has no node_modules', async () => {
    // The pkgDir override lets tests aim the dependency check at an
    // arbitrary directory without touching global process state. An empty
    // temp dir has no node_modules, so the check must fail — proving the
    // override is actually plumbed through to the node_modules lookup.
    const emptyDir = mkdtempSync(join(tmpdir(), 'chroxy-doctor-'))
    try {
      const { checks } = await runDoctorChecks({ providers: ['claude-sdk'], pkgDir: emptyDir })
      const depsCheck = checks.find(c => c.name === 'Dependencies')
      assert.ok(depsCheck)
      assert.equal(depsCheck.status, 'fail', `expected fail, got ${depsCheck.status}: ${depsCheck.message}`)
      assert.ok(depsCheck.message.includes(emptyDir), `message should reference temp dir: ${depsCheck.message}`)
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('relative pkgDir is resolved to absolute, not reinterpreted against cwd later', async () => {
    // A relative `pkgDir` must be normalized to an absolute path at call
    // time. Otherwise a caller passing './foo' would reintroduce
    // cwd-coupling — the very thing this API exists to avoid.
    const emptyDir = mkdtempSync(join(tmpdir(), 'chroxy-doctor-rel-'))
    try {
      const relativePkgDir = relative(process.cwd(), emptyDir) || '.'
      const { checks } = await runDoctorChecks({ providers: ['claude-sdk'], pkgDir: relativePkgDir })
      const depsCheck = checks.find(c => c.name === 'Dependencies')
      assert.ok(depsCheck)
      assert.equal(depsCheck.status, 'fail', `expected fail, got ${depsCheck.status}: ${depsCheck.message}`)
    } finally {
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('throws TypeError when pkgDir is not a non-empty string', async () => {
    // Defensive: an invalid pkgDir should fail loudly rather than silently
    // falling back to process.cwd() via join() quirks.
    await assert.rejects(() => runDoctorChecks({ pkgDir: null }), TypeError)
    await assert.rejects(() => runDoctorChecks({ pkgDir: 123 }), TypeError)
    await assert.rejects(() => runDoctorChecks({ pkgDir: '' }), TypeError)
  })

  it('finds binary via candidate paths when PATH omits the install dir', async () => {
    // Simulates a GUI-launched process (e.g. Tauri on macOS) whose
    // inherited PATH excludes the dir where the binary is actually
    // installed. checkBinary should fall through to the candidate list
    // and still resolve the binary.
    //
    // Cross-platform strategy: use the running Node binary itself
    // (`process.execPath`) as the "candidate". Node supports `--version`
    // on every platform, so no shell-stub file is needed — this works
    // on macOS, Linux, and Windows without branching.
    //
    // Self-contained inside the `it` body because `node --test-name-pattern`
    // skips parent before/after hooks.
    const originalPath = process.env.PATH
    try {
      // Strip PATH so `which`/`where` in resolveBinary cannot find a node
      // binary and the resolver must fall through to the candidate list.
      process.env.PATH = ''

      const result = checkBinary('definitely-not-a-real-binary-xyz', ['--version'], {
        parseVersion: (out) => out.trim().split('\n')[0],
        required: true,
        candidates: [process.execPath],
        installHint: 'install definitely-not-a-real-binary-xyz',
      })

      assert.equal(result.name, 'definitely-not-a-real-binary-xyz')
      assert.equal(
        result.status,
        'pass',
        `expected pass via candidate fallback, got ${result.status}: ${result.message}`,
      )
      // Node prints a version like `v22.x.y` — assert on the shape rather
      // than an exact value so the test survives Node patch upgrades.
      assert.match(result.message, /^v\d+\.\d+\.\d+/)
    } finally {
      // `process.env.PATH = undefined` coerces to the literal string
      // "undefined", so restore correctly when PATH was originally unset.
      if (originalPath === undefined) {
        delete process.env.PATH
      } else {
        process.env.PATH = originalPath
      }
    }
  })
})

// #3953 — provider preflight can declare a minimum binary version (e.g.
// claude-channel needs `claude` ≥ 2.1.80). checkBinary parses the leading
// semver and fails below the floor.
describe('checkBinary minVersion gate (#3953)', () => {
  it('passes when the binary version meets the floor', () => {
    // Node prints `v22.x.y`; any floor at-or-below the running Node passes.
    const result = checkBinary('node', ['--version'], {
      parseVersion: (out) => out.trim(),
      required: true,
      candidates: [process.execPath],
      installHint: 'install node',
      minVersion: '18.0.0',
    })
    assert.equal(result.status, 'pass',
      `expected pass for floor 18.0.0 vs running ${process.versions.node}, got ${result.status}: ${result.message}`)
  })

  it('fails when the binary version is below the floor', () => {
    // A floor far above any plausible Node major forces the fail branch.
    const result = checkBinary('node', ['--version'], {
      parseVersion: (out) => out.trim(),
      required: true,
      candidates: [process.execPath],
      installHint: 'install node ≥ 999.0.0',
      minVersion: '999.0.0',
    })
    assert.equal(result.status, 'fail')
    assert.match(result.message, /requires node ≥ 999\.0\.0/)
    assert.match(result.message, /install node ≥ 999\.0\.0/)
  })

  it('downgrades a below-floor optional binary to warn (not fail)', () => {
    const result = checkBinary('node', ['--version'], {
      parseVersion: (out) => out.trim(),
      required: false,
      candidates: [process.execPath],
      installHint: 'install node',
      minVersion: '999.0.0',
    })
    assert.equal(result.status, 'warn')
  })

  it('warns (does not hard-fail) when the version cannot be parsed', () => {
    const result = checkBinary('node', ['--version'], {
      // Intentionally return an unparseable version string.
      parseVersion: () => 'some weird build identifier',
      required: true,
      candidates: [process.execPath],
      installHint: 'install node',
      minVersion: '2.1.80',
    })
    assert.equal(result.status, 'warn')
    assert.match(result.message, /could not parse version/)
  })

  it('ignores minVersion when not declared (back-compat)', () => {
    const result = checkBinary('node', ['--version'], {
      parseVersion: (out) => out.trim(),
      required: true,
      candidates: [process.execPath],
      installHint: 'install node',
    })
    assert.equal(result.status, 'pass')
  })
})

// #8031 — `recommendedVersion` is a SOFT, advisory floor: below it downgrades
// to `warn` (never `fail`, never aborts `chroxy start`), and it never
// disables the hard `minVersion` gate above.
describe('checkBinary recommendedVersion soft gate (#8031)', () => {
  it('warns (not fails) when the version is below recommendedVersion, with no minVersion declared', () => {
    const result = checkBinary('node', ['--version'], {
      parseVersion: (out) => out.trim(),
      required: true,
      candidates: [process.execPath],
      installHint: 'install node',
      recommendedVersion: '999.0.0',
    })
    assert.equal(result.status, 'warn')
    assert.match(result.message, /older than the recommended node 999\.0\.0/)
  })

  it('passes when the version is at/above recommendedVersion', () => {
    const result = checkBinary('node', ['--version'], {
      parseVersion: (out) => out.trim(),
      required: true,
      candidates: [process.execPath],
      installHint: 'install node',
      recommendedVersion: '1.0.0',
    })
    assert.equal(result.status, 'pass')
  })

  it('prefers updateHint over installHint in the advisory message', () => {
    const result = checkBinary('node', ['--version'], {
      parseVersion: (out) => out.trim(),
      required: true,
      candidates: [process.execPath],
      installHint: 'install node',
      updateHint: 'run `nvm install --lts`',
      recommendedVersion: '999.0.0',
    })
    assert.equal(result.status, 'warn')
    assert.match(result.message, /run `nvm install --lts`/)
  })

  it('falls back to installHint when updateHint is absent', () => {
    const result = checkBinary('node', ['--version'], {
      parseVersion: (out) => out.trim(),
      required: true,
      candidates: [process.execPath],
      installHint: 'install node ≥ 999',
      recommendedVersion: '999.0.0',
    })
    assert.equal(result.status, 'warn')
    assert.match(result.message, /install node ≥ 999/)
  })

  it('a hard minVersion failure still wins (fail) even when recommendedVersion is also declared', () => {
    const result = checkBinary('node', ['--version'], {
      parseVersion: (out) => out.trim(),
      required: true,
      candidates: [process.execPath],
      installHint: 'install node',
      minVersion: '999.0.0',
      recommendedVersion: '1000.0.0',
    })
    assert.equal(result.status, 'fail')
    assert.match(result.message, /requires node ≥ 999\.0\.0/)
  })

  it('when minVersion passes and recommendedVersion is also satisfied, the result is pass', () => {
    const result = checkBinary('node', ['--version'], {
      parseVersion: (out) => out.trim(),
      required: true,
      candidates: [process.execPath],
      installHint: 'install node',
      minVersion: '1.0.0',
      recommendedVersion: '1.0.0',
    })
    assert.equal(result.status, 'pass')
  })

  it('when minVersion passes but recommendedVersion is not met, the result warns', () => {
    const result = checkBinary('node', ['--version'], {
      parseVersion: (out) => out.trim(),
      required: true,
      candidates: [process.execPath],
      installHint: 'install node',
      minVersion: '1.0.0',
      recommendedVersion: '999.0.0',
    })
    assert.equal(result.status, 'warn')
  })

  it('an unparseable version with ONLY recommendedVersion declared just passes (no parse warning for a soft check)', () => {
    const result = checkBinary('node', ['--version'], {
      parseVersion: () => 'some weird build identifier',
      required: true,
      candidates: [process.execPath],
      installHint: 'install node',
      recommendedVersion: '999.0.0',
    })
    assert.equal(result.status, 'pass')
  })

  it('an unparseable recommendedVersion is ignored (pass), not failed closed into a warn', () => {
    // compareSemver fails closed on a malformed floor — correct for minVersion,
    // wrong for a soft advisory, which preflight silently ignores when it
    // does not parse. Doctor must agree.
    for (const recommendedVersion of ['not-a-version', '>=999.0.0', '999.0']) {
      const result = checkBinary('node', ['--version'], {
        parseVersion: (out) => out.trim(),
        required: true,
        candidates: [process.execPath],
        installHint: 'install node',
        recommendedVersion,
      })
      assert.equal(result.status, 'pass', `recommendedVersion ${JSON.stringify(recommendedVersion)} must be ignored`)
    }
  })

  it('ignores recommendedVersion when not declared (back-compat)', () => {
    const result = checkBinary('node', ['--version'], {
      parseVersion: (out) => out.trim(),
      required: true,
      candidates: [process.execPath],
      installHint: 'install node',
    })
    assert.equal(result.status, 'pass')
  })
})

// #7986 — `preflight.binary.minVersion` may be a THUNK (claude-sdk derives its
// floor from the installed SDK's claudeCodeVersion). doctor read the field raw
// and handed the function itself to compareSemver, so every claude-sdk install
// failed `chroxy doctor` — and `chroxy start`, which runs the same checks — with
// "requires claude ≥ () => sdkClaudeCodeVersion()". These drive the real
// runDoctorChecks → checkProvider path with `node` standing in for the binary.
describe('provider minVersion declared as a thunk (#7986)', () => {
  function registerThunkFloorProvider(name, floor) {
    class ThunkFloorSession extends SdkSession {
      static get preflight() {
        return {
          label: name,
          binary: { name: 'node', args: ['--version'], candidates: [process.execPath], minVersion: () => floor },
        }
      }
    }
    registerProvider(name, ThunkFloorSession)
  }

  function binaryRow(checks, provider) {
    return checks.find((c) => c.provider === provider && c.name === 'node')
  }

  it('passes when the thunk resolves to a floor the binary meets', async () => {
    registerThunkFloorProvider('test-7986-thunk-floor-ok', '18.0.0')
    const { checks } = await runDoctorChecks({ providers: ['test-7986-thunk-floor-ok'] })
    const row = binaryRow(checks, 'test-7986-thunk-floor-ok')
    assert.ok(row, 'the provider binary row must be present')
    assert.equal(row.status, 'pass', `expected pass, got ${row.status}: ${row.message}`)
  })

  it('fails naming the RESOLVED floor, not the function source, when the binary is older', async () => {
    registerThunkFloorProvider('test-7986-thunk-floor-high', '999.0.0')
    const { checks } = await runDoctorChecks({ providers: ['test-7986-thunk-floor-high'] })
    const row = binaryRow(checks, 'test-7986-thunk-floor-high')
    assert.ok(row, 'the provider binary row must be present')
    assert.equal(row.status, 'fail')
    assert.ok(row.message.includes('requires node ≥ 999.0.0'), row.message)
    assert.ok(!row.message.includes('=>'), `the thunk's source leaked into the message: ${row.message}`)
  })

  // #8031: claude-sdk's HARD floor is now the hand-kept CLAUDE_SDK_MIN_CLI_VERSION
  // constant, not the installed SDK's own claudeCodeVersion — that field moves on
  // every SDK bump and is no longer treated as a minimum. It is instead the SOFT,
  // advisory `recommendedVersion`.
  it("claude-sdk's declared minVersion resolves to CLAUDE_SDK_MIN_CLI_VERSION, and recommendedVersion resolves to the installed SDK's claudeCodeVersion", () => {
    const minFloor = resolveDeclaredMinVersion(SdkSession.preflight.binary.minVersion)
    assert.equal(minFloor, CLAUDE_SDK_MIN_CLI_VERSION)
    assert.ok(/^\d+\.\d+\.\d+/.test(minFloor || ''), `expected a semver floor, got ${JSON.stringify(minFloor)}`)

    const recommendedFloor = resolveDeclaredMinVersion(SdkSession.preflight.binary.recommendedVersion)
    assert.equal(recommendedFloor, sdkClaudeCodeVersion())
    assert.ok(/^\d+\.\d+\.\d+/.test(recommendedFloor || ''), `expected a semver recommended floor, got ${JSON.stringify(recommendedFloor)}`)
  })

  // #8031: doctor's checkProvider must actually WIRE spec.binary.recommendedVersion
  // through to checkBinary (resolved via the same resolveDeclaredMinVersion helper
  // minVersion uses) — a provider whose binary is below the recommended floor
  // must report `warn` with the updateHint and the recommended version in the
  // message, whether recommendedVersion is declared as a plain string or a thunk.
  function registerRecommendedVersionProvider(name, recommendedVersion) {
    class RecommendedVersionSession extends SdkSession {
      static get preflight() {
        return {
          label: name,
          binary: {
            name: 'node',
            args: ['--version'],
            candidates: [process.execPath],
            recommendedVersion,
            updateHint: 'UPDATE-HINT-MARKER',
          },
        }
      }
    }
    registerProvider(name, RecommendedVersionSession)
  }

  it('warns with the updateHint and the recommended version when recommendedVersion is a plain string', async () => {
    registerRecommendedVersionProvider('test-8031-recommended-string', '999.0.0')
    const { checks } = await runDoctorChecks({ providers: ['test-8031-recommended-string'] })
    const row = binaryRow(checks, 'test-8031-recommended-string')
    assert.ok(row, 'the provider binary row must be present')
    assert.equal(row.status, 'warn', `expected warn, got ${row.status}: ${row.message}`)
    assert.ok(row.message.includes('UPDATE-HINT-MARKER'), row.message)
    assert.ok(row.message.includes('999.0.0'), row.message)
  })

  it('warns the same way when recommendedVersion is declared as a thunk', async () => {
    registerRecommendedVersionProvider('test-8031-recommended-thunk', () => '999.0.0')
    const { checks } = await runDoctorChecks({ providers: ['test-8031-recommended-thunk'] })
    const row = binaryRow(checks, 'test-8031-recommended-thunk')
    assert.ok(row, 'the provider binary row must be present')
    assert.equal(row.status, 'warn', `expected warn, got ${row.status}: ${row.message}`)
    assert.ok(row.message.includes('UPDATE-HINT-MARKER'), row.message)
    assert.ok(row.message.includes('999.0.0'), row.message)
  })
})

// #7986 review S2 — `chroxy start`'s preflight refuses a `requiresDirectExec`
// provider's Windows npm shim via ProviderBinaryUnsupportedError, but doctor
// runs its own binary check (checkBinary) rather than runProviderPreflight —
// without a matching guard here, `chroxy doctor` would report a `.cmd` shim
// as a healthy "pass" while `chroxy start` refuses to boot on the same binary.
describe('doctor requiresDirectExec shim refusal (#7986 review S2)', () => {
  // Named "node" (not "claude"), with process.execPath as the sole candidate,
  // matching the thunk-floor fixtures above — deterministic regardless of
  // whether a real `claude` happens to be on this test host's PATH.
  function registerDirectExecProvider(name, resolvedBinary) {
    class DirectExecSession extends SdkSession {
      static get resolvedBinary() { return resolvedBinary }
      static get preflight() {
        return {
          label: name,
          binary: { name: 'node', args: ['--version'], candidates: [process.execPath], requiresDirectExec: true },
        }
      }
    }
    registerProvider(name, DirectExecSession)
  }

  function binaryRow(checks, provider) {
    return checks.find((c) => c.provider === provider && c.name === 'node')
  }

  it('fails the binary row on win32 when the resolved path is a .cmd shim, without exec-ing it', async () => {
    registerDirectExecProvider('test-7986-direct-exec-cmd', 'C:\\npm\\node.cmd')
    const { checks } = await runDoctorChecks({ providers: ['test-7986-direct-exec-cmd'], platform: 'win32' })
    const row = binaryRow(checks, 'test-7986-direct-exec-cmd')
    assert.ok(row, 'the provider binary row must be present')
    assert.equal(row.status, 'fail')
    assert.match(row.message, /node\.cmd/)
    assert.match(row.message, /without a shell/)
  })

  it('passes on win32 when the resolved path is the native executable, not a shim', async () => {
    registerDirectExecProvider('test-7986-direct-exec-exe', process.execPath)
    const { checks } = await runDoctorChecks({ providers: ['test-7986-direct-exec-exe'], platform: 'win32' })
    const row = binaryRow(checks, 'test-7986-direct-exec-exe')
    assert.ok(row, 'the provider binary row must be present')
    assert.equal(row.status, 'pass', `expected pass, got ${row.status}: ${row.message}`)
  })

  it('off win32 (the default platform), a .cmd-suffixed resolved path is not refused', async () => {
    registerDirectExecProvider('test-7986-direct-exec-darwin', 'C:\\npm\\node.cmd')
    // resolvedBinary is a .cmd path (as it might be, hypothetically, on a
    // non-Windows host), but the resolved value is only ever a REAL shim
    // concern on win32 — off win32, isShellShim is false regardless of
    // suffix, so this must fall through to the real checkBinary exec, which
    // resolves 'node' via the candidate (process.execPath) and passes.
    const { checks } = await runDoctorChecks({ providers: ['test-7986-direct-exec-darwin'], platform: 'darwin' })
    const row = binaryRow(checks, 'test-7986-direct-exec-darwin')
    assert.ok(row, 'the provider binary row must be present')
    assert.equal(row.status, 'pass')
  })

  it('a provider without requiresDirectExec is unaffected on win32', async () => {
    class NoDirectExecSession extends SdkSession {
      static get resolvedBinary() { return 'C:\\npm\\node.cmd' }
      static get preflight() {
        return {
          label: 'no-direct-exec',
          binary: { name: 'node', args: ['--version'], candidates: [process.execPath] },
        }
      }
    }
    registerProvider('test-7986-no-direct-exec', NoDirectExecSession)
    const { checks } = await runDoctorChecks({ providers: ['test-7986-no-direct-exec'], platform: 'win32' })
    const row = binaryRow(checks, 'test-7986-no-direct-exec')
    assert.ok(row, 'the provider binary row must be present')
    // Falls through to the real checkBinary exec (which ignores
    // resolvedBinary and resolves via name+candidates) — not a shim
    // refusal, so it must NOT carry the shim-specific wording.
    assert.doesNotMatch(row.message, /without a shell/)
  })
})

// #6708 — doctor must distinguish "quarantined/blocked by Gatekeeper" from
// "not installed" so an operator can preflight the exact failure XProtect
// caused. The verify seam is injected so no real quarantined binary is needed.
describe('checkBinary quarantine detection (#6708)', () => {
  it('reports a quarantined binary as fail with an xattr remediation hint', () => {
    const result = checkBinary('codex', ['--version'], {
      parseVersion: (out) => out.trim(),
      required: true,
      candidates: [process.execPath],
      installHint: 'install Codex CLI',
      verify: (path) => ({ ok: false, status: 'quarantined', path, quarantine: '0081;a;b;c' }),
    })
    assert.equal(result.status, 'fail')
    assert.match(result.message, /Gatekeeper/)
    assert.match(result.message, /xattr -d com\.apple\.quarantine/)
    // Must NOT mislabel a quarantined binary as "Not found — install …".
    assert.doesNotMatch(result.message, /Not found/)
  })

  it('downgrades a quarantined optional binary to warn (not fail)', () => {
    const result = checkBinary('cloudflared', ['--version'], {
      parseVersion: (out) => out.trim(),
      required: false,
      candidates: [process.execPath],
      installHint: 'brew install cloudflared',
      verify: (path) => ({ ok: false, status: 'quarantined', path, quarantine: '0081;a;b;c' }),
    })
    assert.equal(result.status, 'warn')
    assert.match(result.message, /Gatekeeper/)
  })

  it('reports a present-but-not-executable binary distinctly (not "Not found")', () => {
    const result = checkBinary('codex', ['--version'], {
      parseVersion: (out) => out.trim(),
      required: true,
      candidates: [process.execPath],
      installHint: 'install Codex CLI',
      verify: (path) => ({ ok: false, status: 'not_executable', path, quarantine: null }),
    })
    assert.equal(result.status, 'fail')
    assert.match(result.message, /not executable/)
    assert.match(result.message, /chmod \+x/)
    // A non-executable binary must not be mislabeled as missing.
    assert.doesNotMatch(result.message, /Not found/)
  })

  it('still runs the version probe when the binary is clean (verify=ok)', () => {
    const result = checkBinary('node', ['--version'], {
      parseVersion: (out) => out.trim(),
      required: true,
      candidates: [process.execPath],
      installHint: 'install node',
      verify: (path) => ({ ok: true, status: 'ok', path, quarantine: null }),
    })
    assert.equal(result.status, 'pass')
    assert.match(result.message, /^v\d+\.\d+\.\d+/)
  })
})

describe('parseLeadingSemver / compareSemver helpers (#3953)', () => {
  it('parses a leading semver out of a decorated version string', () => {
    assert.deepEqual(parseLeadingSemver('2.1.163 (Claude Code)'), [2, 1, 163])
    assert.deepEqual(parseLeadingSemver('v22.14.0'), [22, 14, 0])
  })

  it('returns null for unparseable input', () => {
    assert.equal(parseLeadingSemver('not a version'), null)
    assert.equal(parseLeadingSemver(''), null)
    assert.equal(parseLeadingSemver(null), null)
  })

  it('orders versions correctly', () => {
    assert.ok(compareSemver('2.1.79', '2.1.80') < 0)
    assert.ok(compareSemver('2.1.80', '2.1.80') === 0)
    assert.ok(compareSemver('2.1.163', '2.1.80') > 0)
    assert.ok(compareSemver('3.0.0', '2.9.9') > 0)
    assert.ok(compareSemver('2.0.0', '2.1.0') < 0)
  })

  it('sorts an unparseable found-version as less-than the floor', () => {
    assert.ok(compareSemver('garbage', '2.1.80') < 0)
  })

  // Copilot review on #3953: a malformed `required` floor must also fail
  // closed, otherwise a provider that supplies ">=2.1.80" / "2.1.80-beta"
  // would silently disable minVersion enforcement (compareSemver returning
  // positive → "satisfied").
  it('fails closed when the required floor has no parseable leading semver', () => {
    // No leading `major.minor.patch` → parseLeadingSemver returns null →
    // fail closed (less-than), so the floor is never silently satisfied.
    assert.ok(compareSemver('2.1.163', '>=2.1.80') < 0)
    assert.ok(compareSemver('2.1.163', 'v2') < 0)
    assert.ok(compareSemver('2.1.163', 'not-a-version') < 0)
    // Both sides invalid is still less-than.
    assert.ok(compareSemver('garbage', 'also-garbage') < 0)
  })

  it('still satisfies a floor that carries a pre-release/build suffix after a valid core', () => {
    // "2.1.80-beta" HAS a parseable leading core (2.1.80), so a higher
    // found version legitimately satisfies it — the suffix is ignored, not
    // treated as unparseable.
    assert.ok(compareSemver('2.1.163', '2.1.80-beta') > 0)
    assert.ok(compareSemver('2.1.80', '2.1.80-beta') === 0)
  })
})

describe('runDoctorChecks — bundled .app context (issue #2897)', () => {
  it('Dependencies check is warn (not fail) when CHROXY_BUNDLED=1 and node_modules is missing', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'chroxy-doctor-bundled-'))
    const originalBundled = process.env.CHROXY_BUNDLED
    try {
      process.env.CHROXY_BUNDLED = '1'
      const { checks } = await runDoctorChecks({ providers: ['claude-sdk'], pkgDir: emptyDir })
      const depsCheck = checks.find(c => c.name === 'Dependencies')
      assert.ok(depsCheck)
      assert.equal(depsCheck.status, 'warn',
        `expected warn in bundled context, got ${depsCheck.status}: ${depsCheck.message}`)
      assert.ok(
        depsCheck.message.includes('reinstall') || depsCheck.message.includes('rebuild'),
        `expected actionable bundled message, got: ${depsCheck.message}`,
      )
    } finally {
      if (originalBundled === undefined) delete process.env.CHROXY_BUNDLED
      else process.env.CHROXY_BUNDLED = originalBundled
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('Dependencies check is warn (not fail) when CHROXY_SUPERVISED=1 and node_modules is missing', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'chroxy-doctor-supervised-'))
    const originalSupervised = process.env.CHROXY_SUPERVISED
    try {
      process.env.CHROXY_SUPERVISED = '1'
      const { checks } = await runDoctorChecks({ providers: ['claude-sdk'], pkgDir: emptyDir })
      const depsCheck = checks.find(c => c.name === 'Dependencies')
      assert.ok(depsCheck)
      assert.equal(depsCheck.status, 'warn',
        `expected warn in supervised context, got ${depsCheck.status}: ${depsCheck.message}`)
    } finally {
      if (originalSupervised === undefined) delete process.env.CHROXY_SUPERVISED
      else process.env.CHROXY_SUPERVISED = originalSupervised
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('Dependencies check still fails in dev context when node_modules is missing', async () => {
    const emptyDir = mkdtempSync(join(tmpdir(), 'chroxy-doctor-dev-'))
    const originalBundled = process.env.CHROXY_BUNDLED
    const originalSupervised = process.env.CHROXY_SUPERVISED
    try {
      delete process.env.CHROXY_BUNDLED
      delete process.env.CHROXY_SUPERVISED
      const { checks } = await runDoctorChecks({ providers: ['claude-sdk'], pkgDir: emptyDir })
      const depsCheck = checks.find(c => c.name === 'Dependencies')
      assert.ok(depsCheck)
      assert.equal(depsCheck.status, 'fail',
        `expected fail in dev context, got ${depsCheck.status}: ${depsCheck.message}`)
      assert.ok(
        depsCheck.message.includes('npm install'),
        `expected "npm install" hint in dev message, got: ${depsCheck.message}`,
      )
    } finally {
      if (originalBundled === undefined) delete process.env.CHROXY_BUNDLED
      else process.env.CHROXY_BUNDLED = originalBundled
      if (originalSupervised === undefined) delete process.env.CHROXY_SUPERVISED
      else process.env.CHROXY_SUPERVISED = originalSupervised
      rmSync(emptyDir, { recursive: true, force: true })
    }
  })

  it('Dependencies check passes in bundled context when deps are found normally', async () => {
    // When deps ARE present, bundled context should still pass (not affect pass case)
    const originalBundled = process.env.CHROXY_BUNDLED
    try {
      process.env.CHROXY_BUNDLED = '1'
      const { checks } = await runDoctorChecks({ providers: ['claude-sdk'] })
      const depsCheck = checks.find(c => c.name === 'Dependencies')
      assert.ok(depsCheck)
      assert.equal(depsCheck.status, 'pass',
        `expected pass when deps found in bundled context, got ${depsCheck.status}: ${depsCheck.message}`)
    } finally {
      if (originalBundled === undefined) delete process.env.CHROXY_BUNDLED
      else process.env.CHROXY_BUNDLED = originalBundled
    }
  })
})

describe('runDoctorChecks — provider awareness (issue #2951)', () => {
  it('gemini-only config does not include claude binary check', async () => {
    const { checks } = await runDoctorChecks({ providers: ['gemini'] })
    const claudeCheck = checks.find(c => c.name === 'claude')
    assert.equal(claudeCheck, undefined, 'claude check must not run when provider is gemini')
  })

  it('gemini-only config does not include codex binary check', async () => {
    const { checks } = await runDoctorChecks({ providers: ['gemini'] })
    const codexCheck = checks.find(c => c.name === 'codex')
    assert.equal(codexCheck, undefined, 'codex check must not run when provider is gemini')
  })

  it('claude-only config does not include codex or gemini binary checks', async () => {
    const { checks } = await runDoctorChecks({ providers: ['claude-sdk'] })
    const codexCheck = checks.find(c => c.name === 'codex')
    const geminiCheck = checks.find(c => c.name === 'gemini')
    assert.equal(codexCheck, undefined, 'codex check must not run for claude-only')
    assert.equal(geminiCheck, undefined, 'gemini check must not run for claude-only')
  })

  it('gemini-only config does not fail because claude is missing from PATH', async () => {
    // Strip PATH so `claude` cannot be resolved. The doctor result must
    // still pass its provider checks — that is the whole point of #2951.
    const originalPath = process.env.PATH
    try {
      process.env.PATH = '/nonexistent-bin-dir'
      const { checks } = await runDoctorChecks({ providers: ['gemini'] })
      // No check named 'claude' should contribute a failure.
      const claudeFail = checks.find(c => c.name === 'claude' && c.status === 'fail')
      assert.equal(claudeFail, undefined, 'claude-not-found must not be reported for gemini config')
    } finally {
      process.env.PATH = originalPath
    }
  })

  it('multiple providers in the same config each contribute their own checks', async () => {
    const { checks } = await runDoctorChecks({ providers: ['claude-cli', 'gemini'] })
    const claudeCheck = checks.find(c => c.name === 'claude')
    const geminiCheck = checks.find(c => c.name === 'gemini')
    assert.ok(claudeCheck, 'claude check expected for claude-cli provider')
    assert.ok(geminiCheck, 'gemini check expected for gemini provider')
    assert.equal(claudeCheck.provider, 'claude-cli')
    assert.equal(geminiCheck.provider, 'gemini')
  })

  it('gemini provider reports credential status via GEMINI_API_KEY', async () => {
    const originalKey = process.env.GEMINI_API_KEY
    try {
      delete process.env.GEMINI_API_KEY
      const { checks } = await runDoctorChecks({ providers: ['gemini'] })
      const credCheck = checks.find(c => c.provider === 'gemini' && c.name.toLowerCase().includes('credentials'))
      assert.ok(credCheck, 'gemini credentials check must exist')
      assert.equal(credCheck.status, 'fail', 'missing GEMINI_API_KEY must fail (required)')
      assert.ok(credCheck.message.includes('GEMINI_API_KEY'))

      process.env.GEMINI_API_KEY = 'test-key-value'
      const { checks: checks2 } = await runDoctorChecks({ providers: ['gemini'] })
      const credCheck2 = checks2.find(c => c.provider === 'gemini' && c.name.toLowerCase().includes('credentials'))
      assert.equal(credCheck2.status, 'pass')
    } finally {
      if (originalKey === undefined) delete process.env.GEMINI_API_KEY
      else process.env.GEMINI_API_KEY = originalKey
    }
  })

  it('codex provider reports credential status via OPENAI_API_KEY', async () => {
    const originalKey = process.env.OPENAI_API_KEY
    const originalAuthHome = process.env.CHROXY_CODEX_HOME
    const authHome = mkdtempSync(join(tmpdir(), 'doctor-no-native-auth-'))
    try {
      delete process.env.OPENAI_API_KEY
      process.env.CHROXY_CODEX_HOME = authHome
      const { checks } = await runDoctorChecks({ providers: ['codex'] })
      const credCheck = checks.find(c => c.provider === 'codex' && c.name.toLowerCase().includes('credentials'))
      assert.ok(credCheck)
      assert.equal(credCheck.status, 'fail')
      assert.ok(credCheck.message.includes('OPENAI_API_KEY'))
    } finally {
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = originalKey
      if (originalAuthHome === undefined) delete process.env.CHROXY_CODEX_HOME
      else process.env.CHROXY_CODEX_HOME = originalAuthHome
      rmSync(authHome, { recursive: true, force: true })
    }
  })

  it('claude credential check is optional (warn, not fail)', async () => {
    const originalAnthropic = process.env.ANTHROPIC_API_KEY
    const originalOauth = process.env.CLAUDE_CODE_OAUTH_TOKEN
    try {
      delete process.env.ANTHROPIC_API_KEY
      delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      const { checks } = await runDoctorChecks({ providers: ['claude-sdk'] })
      const credCheck = checks.find(c => c.provider === 'claude-sdk' && c.name.toLowerCase().includes('credentials'))
      assert.ok(credCheck)
      // Optional: user may be logged in via `claude login` instead.
      assert.equal(credCheck.status, 'warn', `expected warn, got ${credCheck.status}`)
    } finally {
      if (originalAnthropic === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = originalAnthropic
      if (originalOauth === undefined) delete process.env.CLAUDE_CODE_OAUTH_TOKEN
      else process.env.CLAUDE_CODE_OAUTH_TOKEN = originalOauth
    }
  })

  it('unknown provider yields a fail check rather than silently dropping it', async () => {
    const { checks } = await runDoctorChecks({ providers: ['nonexistent-provider'] })
    const providerCheck = checks.find(c => c.name.startsWith('Provider:') || c.provider === 'nonexistent-provider')
    assert.ok(providerCheck)
    assert.equal(providerCheck.status, 'fail')
  })

  it('provider check entries include a `provider` field for per-provider output grouping', async () => {
    const { checks } = await runDoctorChecks({ providers: ['gemini'] })
    const providerChecks = checks.filter(c => c.provider === 'gemini')
    assert.ok(providerChecks.length > 0, 'expected at least one gemini-tagged check')
    for (const c of providerChecks) {
      assert.equal(c.provider, 'gemini')
    }
  })
})

describe('isBundledOrSupervisedContext (issue #3023)', () => {
  // Save/restore env vars per test so the suite never leaks state — these
  // values affect any other check that adopts the helper.
  const originalBundled = process.env.CHROXY_BUNDLED
  const originalSupervised = process.env.CHROXY_SUPERVISED

  function restoreEnv() {
    if (originalBundled === undefined) delete process.env.CHROXY_BUNDLED
    else process.env.CHROXY_BUNDLED = originalBundled
    if (originalSupervised === undefined) delete process.env.CHROXY_SUPERVISED
    else process.env.CHROXY_SUPERVISED = originalSupervised
  }

  it('returns false when neither env var is set', () => {
    try {
      delete process.env.CHROXY_BUNDLED
      delete process.env.CHROXY_SUPERVISED
      assert.equal(isBundledOrSupervisedContext(), false)
    } finally {
      restoreEnv()
    }
  })

  it('returns true when CHROXY_BUNDLED=1', () => {
    try {
      delete process.env.CHROXY_SUPERVISED
      process.env.CHROXY_BUNDLED = '1'
      assert.equal(isBundledOrSupervisedContext(), true)
    } finally {
      restoreEnv()
    }
  })

  it('returns true when CHROXY_SUPERVISED=1', () => {
    try {
      delete process.env.CHROXY_BUNDLED
      process.env.CHROXY_SUPERVISED = '1'
      assert.equal(isBundledOrSupervisedContext(), true)
    } finally {
      restoreEnv()
    }
  })

  it('returns true when both env vars are set', () => {
    try {
      process.env.CHROXY_BUNDLED = '1'
      process.env.CHROXY_SUPERVISED = '1'
      assert.equal(isBundledOrSupervisedContext(), true)
    } finally {
      restoreEnv()
    }
  })

  it('only treats the literal string "1" as truthy (not "0", "true", or empty)', () => {
    try {
      delete process.env.CHROXY_SUPERVISED
      for (const val of ['0', 'true', 'yes', '', '2']) {
        process.env.CHROXY_BUNDLED = val
        assert.equal(
          isBundledOrSupervisedContext(),
          false,
          `expected false for CHROXY_BUNDLED=${JSON.stringify(val)}`,
        )
      }
    } finally {
      restoreEnv()
    }
  })
})

// audit P1-3 / #5821: claude-tui CLI-version pin — the backstop against silent
// AskUserQuestion mis-drive after a claude CLI UI change.
describe('checkClaudeTuiCliVersion', () => {
  it('passes when the installed claude matches the tested baseline (major.minor)', () => {
    const tested = '2.1.177'
    const check = checkClaudeTuiCliVersion({ tested, exec: () => '2.1.177 (Claude Code)' })
    assert.equal(check.status, 'pass')
    assert.match(check.message, /matches the tested TUI-driving baseline/)
  })

  it('passes on a patch-only difference (same major.minor)', () => {
    const check = checkClaudeTuiCliVersion({ tested: '2.1.177', exec: () => '2.1.200 (Claude Code)' })
    assert.equal(check.status, 'pass')
  })

  it('warns on a major.minor drift (a UI change may mis-drive forms)', () => {
    const check = checkClaudeTuiCliVersion({ tested: '2.1.177', exec: () => '2.2.0 (Claude Code)' })
    assert.equal(check.status, 'warn')
    assert.match(check.message, /differs from the tested TUI-driving baseline/)
    assert.match(check.message, /mis-drive AskUserQuestion forms silently/)
  })

  it('warns (does not throw) when claude --version is unparseable', () => {
    const check = checkClaudeTuiCliVersion({ tested: '2.1.177', exec: () => 'some unexpected output' })
    assert.equal(check.status, 'warn')
    assert.match(check.message, /Could not parse/)
  })

  it('returns null when claude cannot be run (provider check covers a missing claude)', () => {
    const check = checkClaudeTuiCliVersion({ exec: () => { throw new Error('ENOENT') } })
    assert.equal(check, null)
  })

  it('the shipped baseline constant is a parseable semver', () => {
    assert.notEqual(parseLeadingSemver(TESTED_CLAUDE_TUI_CLI_VERSION), null)
  })
})

// #8223 — the "Claude login" row: `claude auth status --json`, so a logged-out host
// shows up in `chroxy doctor` instead of only when a session fails to start.
describe('checkClaudeLogin (#8223)', () => {
  // Every case injects the resolver, the health check and the exec, so no real
  // `claude` is ever resolved or run.
  const base = { resolveBinary: () => '/fixture/claude', candidates: [] }
  const withStdout = (stdout) => ({ ...base, exec: () => stdout })
  // `claude auth status` exits 1 when logged out and still prints its JSON.
  const exitsWith = (status, stdout) => ({
    ...base,
    exec: () => { throw Object.assign(new Error(`Command failed (exit ${status})`), { status, stdout }) },
  })

  it('passes with the auth method and subscription type when logged in', () => {
    const check = checkClaudeLogin(withStdout(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', apiProvider: 'firstParty', subscriptionType: 'max' })))
    assert.equal(check.name, 'Claude login')
    assert.equal(check.status, 'pass')
    assert.equal(check.message, 'Logged in (claude.ai, max)')
  })

  it('passes with just the auth method when there is no subscription type', () => {
    assert.equal(checkClaudeLogin(withStdout(JSON.stringify({ loggedIn: true, authMethod: 'claude.ai' }))).message, 'Logged in (claude.ai)')
  })

  it('passes with a bare "Logged in" when claude names neither', () => {
    assert.equal(checkClaudeLogin(withStdout(JSON.stringify({ loggedIn: true }))).message, 'Logged in')
  })

  it('warns on an explicit loggedIn:false, reading the JSON off a non-zero exit', () => {
    const check = checkClaudeLogin(exitsWith(1, JSON.stringify({ loggedIn: false, authMethod: 'none' })))
    assert.equal(check.status, 'warn')
    assert.match(check.message, /^Not logged in — run `claude auth login` on this host\./)
    assert.match(check.message, /claude-tui needs it; claude-sdk needs it unless ANTHROPIC_API_KEY is set\.$/)
  })

  it('warns on an explicit loggedIn:false even when claude exits 0', () => {
    assert.equal(checkClaudeLogin(withStdout(JSON.stringify({ loggedIn: false }))).status, 'warn')
  })

  for (const [name, deps] of [
    ['the probe times out (no exit status)', { ...base, exec: () => { throw Object.assign(new Error('spawnSync claude ETIMEDOUT'), { code: 'ETIMEDOUT' }) } }],
    ['stdout is not JSON', withStdout('error: unknown command auth')],
    ['stdout is empty', withStdout('')],
    ['a non-zero exit carries no stdout', { ...base, exec: () => { throw Object.assign(new Error('boom'), { status: 2 }) } }],
    ['the JSON has no loggedIn field', withStdout(JSON.stringify({ authMethod: 'none' }))],
    ['loggedIn is not a boolean', withStdout(JSON.stringify({ loggedIn: 'yes' }))],
  ]) {
    it(`warns that the state cannot be read when ${name}`, () => {
      const check = checkClaudeLogin(deps)
      assert.equal(check.status, 'warn')
      assert.match(check.message, /^Could not read the login state from `claude auth status --json`/)
    })
  }

  it('returns no row when claude is not installed (the binary row covers it)', () => {
    assert.equal(checkClaudeLogin({ ...base, exec: () => { throw Object.assign(new Error('spawnSync claude ENOENT'), { code: 'ENOENT' }) } }), null)
  })

  it('never reports a fail — a doctor failure would block `chroxy start`', () => {
    const statuses = new Set()
    for (const deps of [
      withStdout(JSON.stringify({ loggedIn: true })), exitsWith(1, JSON.stringify({ loggedIn: false })),
      withStdout('garbage'), { ...base, exec: () => { throw new Error('x') } },
    ]) statuses.add(checkClaudeLogin(deps).status)
    assert.ok(!statuses.has('fail'), [...statuses].join(','))
  })

  it('runs exactly `auth status --json` with ANTHROPIC_API_KEY removed, without touching the caller\'s env', () => {
    const calls = []
    const env = { PATH: '/usr/bin', ANTHROPIC_API_KEY: 'sk-test-not-real', CLAUDE_CODE_OAUTH_TOKEN: 'keep-me' }
    checkClaudeLogin({ ...base, env, exec: (bin, args, opts) => { calls.push({ bin, args, opts }); return JSON.stringify({ loggedIn: true }) } })
    assert.equal(calls.length, 1)
    assert.equal(calls[0].bin, '/fixture/claude')
    assert.deepEqual(calls[0].args, ['auth', 'status', '--json'])
    assert.equal(calls[0].opts.env.ANTHROPIC_API_KEY, undefined, 'the API key must not reach the probe')
    assert.equal(calls[0].opts.env.CLAUDE_CODE_OAUTH_TOKEN, 'keep-me', 'the rest of the env is untouched')
    assert.equal(env.ANTHROPIC_API_KEY, 'sk-test-not-real', 'the caller\'s env object is not mutated')
  })

  it('returns no row, and never execs, when the provenance gate blocks the binary', () => {
    let execed = false
    const check = checkClaudeLogin({
      ...base,
      exec: () => { execed = true; return '{}' },
      provenance: { mode: 'block', signatureGate: false, ledger: null },
      verify: (p) => ({ ok: true, path: p }),
      verifyProvenance: () => ({ blocked: true, status: 'hash_mismatch', message: 'changed' }),
    })
    assert.equal(check, null)
    assert.equal(execed, false, 'a provenance-blocked claude is never exec\'d')
  })

  it('returns no row when the binary health check fails', () => {
    let execed = false
    const check = checkClaudeLogin({
      ...base,
      exec: () => { execed = true; return '{}' },
      provenance: { mode: 'warn', signatureGate: false, ledger: null },
      verify: () => ({ ok: false }),
    })
    assert.equal(check, null)
    assert.equal(execed, false)
  })
})

describe('runDoctorChecks — Claude login row (#8223)', () => {
  const loggedOut = () => { throw Object.assign(new Error('exit 1'), { status: 1, stdout: JSON.stringify({ loggedIn: false }) }) }
  const loggedIn = () => JSON.stringify({ loggedIn: true, authMethod: 'claude.ai', subscriptionType: 'max' })
  const loginRow = async (providers, exec, env = {}) => {
    const prev = process.env.ANTHROPIC_API_KEY
    delete process.env.ANTHROPIC_API_KEY
    if (env.ANTHROPIC_API_KEY) process.env.ANTHROPIC_API_KEY = env.ANTHROPIC_API_KEY
    try {
      const { checks, passed } = await runDoctorChecks({
        providers,
        claudeLoginDeps: { exec, resolveBinary: () => '/fixture/claude', candidates: [] },
      })
      return { row: checks.find((c) => c.name === 'Claude login'), passed, checks }
    } finally {
      if (prev === undefined) delete process.env.ANTHROPIC_API_KEY
      else process.env.ANTHROPIC_API_KEY = prev
    }
  }

  it('adds the row for claude-tui', async () => {
    const { row } = await loginRow(['claude-tui'], loggedIn)
    assert.equal(row.status, 'pass')
    assert.match(row.message, /^Logged in \(claude\.ai, max\)$/)
  })

  it('adds a warn row for a logged-out claude-sdk host with no API key, and does not fail doctor on its own account', async () => {
    const { row, checks } = await loginRow(['claude-sdk'], loggedOut)
    assert.equal(row.status, 'warn')
    assert.match(row.message, /claude auth login/)
    assert.ok(checks.every((c) => c.name === 'Claude login' ? c.status !== 'fail' : true))
  })

  it('does not warn a claude-sdk host that authenticates with ANTHROPIC_API_KEY about a login it does not use', async () => {
    const { row } = await loginRow(['claude-sdk'], loggedOut, { ANTHROPIC_API_KEY: 'sk-test-not-real' })
    assert.equal(row, undefined)
  })

  it('still adds the row for claude-tui when ANTHROPIC_API_KEY is set (claude-tui never uses it)', async () => {
    const { row } = await loginRow(['claude-tui'], loggedOut, { ANTHROPIC_API_KEY: 'sk-test-not-real' })
    assert.equal(row.status, 'warn')
  })

  it('adds no row when no claude login provider is configured', async () => {
    let execed = false
    const { row } = await loginRow(['gemini'], () => { execed = true; return loggedIn() })
    assert.equal(row, undefined)
    assert.equal(execed, false, 'no claude is exec\'d for a Gemini-only install')
  })
})

describe('checkTunnelRoutability (#5328 WP-5.6)', () => {
  it('returns null when no named tunnel is configured (quick / none / no hostname)', async () => {
    assert.equal(await checkTunnelRoutability({ mode: 'quick', hostname: 'x.example.com' }), null)
    assert.equal(await checkTunnelRoutability({ mode: 'none', hostname: null }), null)
    assert.equal(await checkTunnelRoutability({ mode: 'named', hostname: '' }), null)
    assert.equal(await checkTunnelRoutability({}), null)
  })

  it('passes when the probe reaches the hostname (any HTTP response is routable)', async () => {
    const check = await checkTunnelRoutability({
      mode: 'named',
      hostname: 'chroxy.example.com',
      probe: async () => ({ ok: true, status: 426 }),
    })
    assert.equal(check.status, 'pass')
    assert.match(check.message, /chroxy\.example\.com is reachable/)
    assert.match(check.message, /HTTP 426/)
  })

  it('warns when the probe cannot reach the hostname (DNS/route down)', async () => {
    const check = await checkTunnelRoutability({
      mode: 'named',
      hostname: 'chroxy.example.com',
      probe: async () => ({ ok: false, error: 'getaddrinfo ENOTFOUND chroxy.example.com' }),
    })
    assert.equal(check.status, 'warn')
    assert.match(check.message, /did not respond \(getaddrinfo ENOTFOUND/)
    assert.match(check.message, /chroxy tunnel setup/)
  })

  it('warns (never throws) when the probe itself rejects', async () => {
    const check = await checkTunnelRoutability({
      mode: 'named',
      hostname: 'chroxy.example.com',
      probe: async () => { throw new Error('boom') },
    })
    assert.equal(check.status, 'warn')
    assert.match(check.message, /did not respond \(boom\)/)
  })

  it('trims surrounding whitespace from the hostname before probing', async () => {
    let seenUrl = null
    const check = await checkTunnelRoutability({
      mode: 'named',
      hostname: '  chroxy.example.com  ',
      probe: async (url) => { seenUrl = url; return { ok: true, status: 200 } },
    })
    assert.equal(seenUrl, 'https://chroxy.example.com/')
    assert.equal(check.status, 'pass')
  })

  it('warns (without probing) when the hostname is not a bare host', async () => {
    for (const bad of ['https://chroxy.example.com', 'evil.com/@chroxy.example.com', 'a b.example.com', 'chroxy.example.com/path']) {
      let probed = false
      const check = await checkTunnelRoutability({
        mode: 'named',
        hostname: bad,
        probe: async () => { probed = true; return { ok: true } },
      })
      assert.equal(probed, false, `should not probe a malformed host: ${bad}`)
      assert.equal(check.status, 'warn')
      assert.match(check.message, /is not a bare host/)
    }
  })

  it('returns null for a whitespace-only hostname', async () => {
    assert.equal(await checkTunnelRoutability({ mode: 'named', hostname: '   ' }), null)
  })

  it('passes the hostname URL and a numeric timeout to the probe', async () => {
    let seenUrl = null
    let seenTimeout = null
    await checkTunnelRoutability({
      mode: 'named',
      hostname: 'chroxy.example.com',
      timeoutMs: 1234,
      probe: async (url, timeoutMs) => { seenUrl = url; seenTimeout = timeoutMs; return { ok: true } },
    })
    assert.equal(seenUrl, 'https://chroxy.example.com/')
    assert.equal(seenTimeout, 1234)
  })

  it('runDoctorChecks omits the routability check by default (no named tunnel) and never calls the real network', async () => {
    let probed = false
    const { checks } = await runDoctorChecks({
      providers: ['claude-sdk'],
      tunnelProbe: async () => { probed = true; return { ok: true } },
    })
    // CHROXY_CONFIG_DIR is redirected to a tmp dir by _setup.mjs and has no
    // named tunnel, so the probe must not fire and no routability check is added.
    assert.equal(probed, false)
    assert.equal(checks.find(c => c.name === 'Tunnel routability'), undefined)
  })

  it('runDoctorChecks fires the probe for a configured named tunnel, incl. the cloudflare:named alias', async () => {
    const { writeFileSync, rmSync } = await import('node:fs')
    // _setup.mjs points CHROXY_CONFIG_DIR at a writable tmp dir and doctor's
    // configFile() now honors it (the hermeticity fix), so this lands in the
    // sandbox, not the real ~/.chroxy.
    const cfgPath = join(process.env.CHROXY_CONFIG_DIR, 'config.json')
    writeFileSync(cfgPath, JSON.stringify({ tunnel: 'cloudflare:named', tunnelHostname: 'chroxy.example.com' }))
    try {
      let probedUrl = null
      const { checks } = await runDoctorChecks({
        providers: ['claude-sdk'],
        tunnelProbe: async (url) => { probedUrl = url; return { ok: true, status: 200 } },
      })
      // The `cloudflare:named` alias must normalize to mode 'named' (not be
      // skipped), and the probe must receive the configured hostname URL.
      assert.equal(probedUrl, 'https://chroxy.example.com/')
      const routability = checks.find(c => c.name === 'Tunnel routability')
      assert.ok(routability)
      assert.equal(routability.status, 'pass')
    } finally {
      rmSync(cfgPath, { force: true })
    }
  })

  it('#8116: an explicit tunnelMode/tunnelHostname override REPLACES the default file\'s tunnel, even when the file names a different one', async () => {
    const { writeFileSync, rmSync } = await import('node:fs')
    const cfgPath = join(process.env.CHROXY_CONFIG_DIR, 'config.json')
    // The DEFAULT file names a DIFFERENT named tunnel — if runDoctorChecks
    // (pre-#8116) ignored the override and fell through to its own file
    // read, the probe would fire against THIS hostname instead.
    writeFileSync(cfgPath, JSON.stringify({ tunnel: 'named', tunnelHostname: 'file.example.test' }))
    try {
      let probedUrl = null
      const { checks } = await runDoctorChecks({
        providers: ['claude-sdk'],
        tunnelMode: 'named',
        tunnelHostname: 'override.example.test',
        tunnelProbe: async (url) => { probedUrl = url; return { ok: true, status: 200 } },
      })
      assert.equal(
        probedUrl,
        'https://override.example.test/',
        `expected the override's hostname to win over the default file's — got ${JSON.stringify(probedUrl)}`,
      )
      const routability = checks.find(c => c.name === 'Tunnel routability')
      assert.ok(routability)
      assert.equal(routability.status, 'pass')
    } finally {
      rmSync(cfgPath, { force: true })
    }
  })

  it('#8116: an explicit tunnelMode override of \'quick\' skips the probe even when the default file names a named tunnel', async () => {
    const { writeFileSync, rmSync } = await import('node:fs')
    const cfgPath = join(process.env.CHROXY_CONFIG_DIR, 'config.json')
    writeFileSync(cfgPath, JSON.stringify({ tunnel: 'named', tunnelHostname: 'file.example.test' }))
    try {
      let probed = false
      const { checks } = await runDoctorChecks({
        providers: ['claude-sdk'],
        tunnelMode: 'quick',
        tunnelHostname: null,
        tunnelProbe: async () => { probed = true; return { ok: true } },
      })
      assert.equal(probed, false, 'a quick-mode override must skip the probe regardless of the default file')
      assert.equal(checks.find(c => c.name === 'Tunnel routability'), undefined)
    } finally {
      rmSync(cfgPath, { force: true })
    }
  })

  it('#8116: omitting the override falls back to the default file, unchanged (chroxy doctor)', async () => {
    // No override supplied at all (both keys absent, i.e. undefined) — the
    // two tests above this one already prove the no-named-tunnel and
    // configured-named-tunnel default-file-read paths still work with
    // `tunnelMode`/`tunnelHostname` simply never passed; this test pins that
    // "never passed" is treated identically to "explicitly undefined" so a
    // future refactor of the destructuring default can't quietly change it.
    const { writeFileSync, rmSync } = await import('node:fs')
    const cfgPath = join(process.env.CHROXY_CONFIG_DIR, 'config.json')
    writeFileSync(cfgPath, JSON.stringify({ tunnel: 'named', tunnelHostname: 'file.example.test' }))
    try {
      let probedUrl = null
      const { checks } = await runDoctorChecks({
        providers: ['claude-sdk'],
        tunnelMode: undefined,
        tunnelHostname: undefined,
        tunnelProbe: async (url) => { probedUrl = url; return { ok: true, status: 200 } },
      })
      assert.equal(probedUrl, 'https://file.example.test/')
      assert.ok(checks.find(c => c.name === 'Tunnel routability'))
    } finally {
      rmSync(cfgPath, { force: true })
    }
  })
})
