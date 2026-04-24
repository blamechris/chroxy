import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parse as parsePath } from 'node:path'
import { runDoctorChecks, checkBinary } from '../src/doctor.js'

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

  it('dependencies check is present', async () => {
    const { checks } = await runDoctorChecks({ providers: ['claude-sdk'] })
    const depsCheck = checks.find(c => c.name === 'Dependencies')
    assert.ok(depsCheck)
    // Status depends on whether node_modules exists in cwd (may vary in CI)
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

  it('dependencies check resolves relative to server package, not process.cwd()', async () => {
    // Regression: previously the check used join(process.cwd(), 'node_modules').
    // Tauri launches the server with cwd='/' under launchd, which always
    // failed this check and blocked server startup. The fix resolves
    // node_modules relative to the server package itself.
    const originalCwd = process.cwd()
    // Use the filesystem root from the CURRENT cwd so the chdir works on
    // any platform (POSIX root '/' or a Windows drive root like 'C:\\').
    const fsRoot = parsePath(originalCwd).root
    try {
      process.chdir(fsRoot)
      const { checks } = await runDoctorChecks({ providers: ['claude-sdk'] })
      const depsCheck = checks.find(c => c.name === 'Dependencies')
      assert.ok(depsCheck)
      // With node_modules installed in packages/server/, this must pass
      // even when process.cwd() is a directory with no node_modules.
      assert.equal(depsCheck.status, 'pass', `expected pass, got ${depsCheck.status}: ${depsCheck.message}`)
    } finally {
      process.chdir(originalCwd)
    }
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
