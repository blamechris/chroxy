import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, parse as parsePath, relative } from 'node:path'
import { runDoctorChecks, checkBinary, isBundledOrSupervisedContext, parseLeadingSemver, compareSemver, checkClaudeTuiCliVersion, checkTunnelRoutability } from '../src/doctor.js'
import { TESTED_CLAUDE_TUI_CLI_VERSION } from '../src/claude-tui/tested-cli-version.js'

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

    it('warns when the default provider meters silently on/after the cutover', async () => {
      const { checks } = await withEnv(null, () => runDoctorChecks({ providers: ['claude-sdk'], now: AFTER }))
      const billing = checks.find(c => c.name === 'Billing')
      assert.ok(billing)
      assert.equal(billing.status, 'warn')
      assert.match(billing.message, /metered programmatic-credit pool/)
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
    try {
      delete process.env.OPENAI_API_KEY
      const { checks } = await runDoctorChecks({ providers: ['codex'] })
      const credCheck = checks.find(c => c.provider === 'codex' && c.name.toLowerCase().includes('credentials'))
      assert.ok(credCheck)
      assert.equal(credCheck.status, 'fail')
      assert.ok(credCheck.message.includes('OPENAI_API_KEY'))
    } finally {
      if (originalKey === undefined) delete process.env.OPENAI_API_KEY
      else process.env.OPENAI_API_KEY = originalKey
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
    // CONFIG_FILE now honors it (the hermeticity fix), so this lands in the
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
})
