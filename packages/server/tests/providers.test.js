import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { registerProvider, getProvider, listProviders, registerDockerProvider } from '../src/providers.js'
import { CliSession } from '../src/cli-session.js'
import { SdkSession } from '../src/sdk-session.js'
import { CodexSession } from '../src/codex-session.js'
import { GeminiSession } from '../src/gemini-session.js'

describe('Provider Registry', () => {
  it('has claude-cli and claude-sdk pre-registered', () => {
    const cli = getProvider('claude-cli')
    const sdk = getProvider('claude-sdk')
    assert.equal(cli, CliSession)
    assert.equal(sdk, SdkSession)
  })

  it('getProvider throws on unknown provider', () => {
    assert.throws(
      () => getProvider('unknown-provider'),
      /Unknown provider "unknown-provider"/
    )
  })

  it('getProvider error message lists available providers', () => {
    try {
      getProvider('nope')
      assert.fail('should have thrown')
    } catch (err) {
      assert.ok(err.message.includes('claude-cli'))
      assert.ok(err.message.includes('claude-sdk'))
    }
  })

  it('registerProvider validates name', () => {
    assert.throws(() => registerProvider('', class {}), /non-empty string/)
    assert.throws(() => registerProvider(null, class {}), /non-empty string/)
  })

  it('registerProvider validates class', () => {
    assert.throws(() => registerProvider('test', 'not-a-class'), /must be a class/)
  })

  it('registerProvider + getProvider round-trip', () => {
    class TestProvider {
      sendMessage() {}
      interrupt() {}
      setModel() {}
      setPermissionMode() {}
      start() {}
      destroy() {}
    }
    registerProvider('test-roundtrip', TestProvider)
    assert.equal(getProvider('test-roundtrip'), TestProvider)
  })

  it('listProviders returns registered providers with capabilities', () => {
    const list = listProviders()
    assert.ok(Array.isArray(list))
    assert.ok(list.length >= 2)

    const cliEntry = list.find(p => p.name === 'claude-cli')
    assert.ok(cliEntry)
    assert.equal(cliEntry.capabilities.permissions, true)
    assert.equal(cliEntry.capabilities.inProcessPermissions, false)
    assert.equal(cliEntry.capabilities.resume, false)

    const sdkEntry = list.find(p => p.name === 'claude-sdk')
    assert.ok(sdkEntry)
    assert.equal(sdkEntry.capabilities.permissions, true)
    assert.equal(sdkEntry.capabilities.inProcessPermissions, true)
    assert.equal(sdkEntry.capabilities.resume, true)
  })

  // #3072: clients gate the "Allow for Session" affordance on this capability
  // so they don't surface a button that the server would reject as
  // "not supported by this provider".
  it('listProviders surfaces sessionRules capability derived from setPermissionRules', () => {
    const list = listProviders()
    const sdkEntry = list.find(p => p.name === 'claude-sdk')
    assert.ok(sdkEntry, 'claude-sdk provider should be registered')
    assert.equal(sdkEntry.capabilities.sessionRules, true,
      'claude-sdk implements setPermissionRules so should report sessionRules: true')

    const cliEntry = list.find(p => p.name === 'claude-cli')
    assert.ok(cliEntry, 'claude-cli provider should be registered')
    assert.equal(cliEntry.capabilities.sessionRules, false,
      'claude-cli does not implement setPermissionRules so should report sessionRules: false')

    const codexEntry = list.find(p => p.name === 'codex')
    if (codexEntry) {
      assert.equal(codexEntry.capabilities.sessionRules, false,
        'codex does not implement setPermissionRules so should report sessionRules: false')
    }

    const geminiEntry = list.find(p => p.name === 'gemini')
    if (geminiEntry) {
      assert.equal(geminiEntry.capabilities.sessionRules, false,
        'gemini does not implement setPermissionRules so should report sessionRules: false')
    }
  })

  // #3404 audit (F1+F5): listProviders must surface auth/credentials state
  // so the dashboard can grey-out unusable providers and show a billing-
  // identity confidence panel without making the user run `chroxy doctor`.
  describe('auth status (#3404 audit)', () => {
    const ENV_KEYS = ['ANTHROPIC_API_KEY', 'CLAUDE_CODE_OAUTH_TOKEN', 'OPENAI_API_KEY', 'GEMINI_API_KEY', 'GOOGLE_API_KEY', 'CHROXY_CLAUDE_HOME', 'CHROXY_CLAUDE_CONFIG']
    const saved = {}
    let _tmpClaudeHome = null

    function clearKeys() {
      for (const k of ENV_KEYS) {
        saved[k] = process.env[k]
        delete process.env[k]
      }
      // #3674: point the OAuth probe at an empty tmpdir so neither the
      // developer's actual ~/.claude state nor a previous test's leftover
      // can satisfy `_hasClaudeOAuthCreds()` and silently keep optional-
      // creds providers reporting ready=true.
      _tmpClaudeHome = mkdtempSync(join(tmpdir(), 'chroxy-claude-home-'))
      process.env.CHROXY_CLAUDE_HOME = _tmpClaudeHome
      process.env.CHROXY_CLAUDE_CONFIG = join(_tmpClaudeHome, '.claude.json')
    }
    function restoreKeys() {
      for (const k of ENV_KEYS) {
        if (saved[k] === undefined) delete process.env[k]
        else process.env[k] = saved[k]
      }
      if (_tmpClaudeHome) {
        try { rmSync(_tmpClaudeHome, { recursive: true, force: true }) } catch {}
        _tmpClaudeHome = null
      }
    }

    it('claude-sdk reports source=env and ready when ANTHROPIC_API_KEY is set', () => {
      clearKeys()
      process.env.ANTHROPIC_API_KEY = 'sk-test'
      try {
        const list = listProviders()
        const sdk = list.find(p => p.name === 'claude-sdk')
        assert.ok(sdk?.auth, 'claude-sdk should expose auth')
        assert.equal(sdk.auth.ready, true)
        assert.equal(sdk.auth.source, 'env')
        assert.equal(sdk.auth.envVar, 'ANTHROPIC_API_KEY')
        assert.match(sdk.auth.detail, /ANTHROPIC_API_KEY/)
      } finally {
        restoreKeys()
      }
    })

    it('claude-sdk reports ready=false when no env var AND no claude login state on disk (#3674)', () => {
      clearKeys()
      try {
        const list = listProviders()
        const sdk = list.find(p => p.name === 'claude-sdk')
        // No env var, empty CHROXY_CLAUDE_HOME → no OAuth probe hit → ready=false
        assert.equal(sdk.auth.ready, false)
        assert.equal(sdk.auth.source, 'none')
        assert.equal(sdk.auth.envVar, null)
        assert.match(sdk.auth.hint, /claude login|ANTHROPIC_API_KEY/)
      } finally {
        restoreKeys()
      }
    })

    it('claude-sdk reports ready=true source=oauth when ~/.claude/auth.json exists (#3674)', () => {
      clearKeys()
      writeFileSync(join(_tmpClaudeHome, 'auth.json'), '{}')
      try {
        const list = listProviders()
        const sdk = list.find(p => p.name === 'claude-sdk')
        assert.equal(sdk.auth.ready, true)
        assert.equal(sdk.auth.source, 'oauth')
        assert.match(sdk.auth.detail, /OAuth from `claude login`/)
      } finally {
        restoreKeys()
      }
    })

    it('claude-sdk reports ready=true source=oauth when ~/.claude/.credentials.json exists (#3674)', () => {
      clearKeys()
      writeFileSync(join(_tmpClaudeHome, '.credentials.json'), '{}')
      try {
        const list = listProviders()
        const sdk = list.find(p => p.name === 'claude-sdk')
        assert.equal(sdk.auth.ready, true)
        assert.equal(sdk.auth.source, 'oauth')
      } finally {
        restoreKeys()
      }
    })

    it('claude-sdk reports ready=true source=oauth when ~/.claude.json has claudeAiOauth block (#3674)', () => {
      clearKeys()
      writeFileSync(
        process.env.CHROXY_CLAUDE_CONFIG,
        JSON.stringify({ claudeAiOauth: { refreshToken: 'fake' }, otherStuff: true }),
      )
      try {
        const list = listProviders()
        const sdk = list.find(p => p.name === 'claude-sdk')
        assert.equal(sdk.auth.ready, true)
        assert.equal(sdk.auth.source, 'oauth')
      } finally {
        restoreKeys()
      }
    })

    it('claude-sdk stays ready=false when ~/.claude.json has no claudeAiOauth block (#3674)', () => {
      clearKeys()
      writeFileSync(process.env.CHROXY_CLAUDE_CONFIG, JSON.stringify({ unrelated: 'config' }))
      try {
        const list = listProviders()
        const sdk = list.find(p => p.name === 'claude-sdk')
        assert.equal(sdk.auth.ready, false)
        assert.equal(sdk.auth.source, 'none')
      } finally {
        restoreKeys()
      }
    })

    it('claude-cli reports source=oauth regardless of env (subscription always)', () => {
      clearKeys()
      process.env.ANTHROPIC_API_KEY = 'sk-test'
      try {
        const list = listProviders()
        const cli = list.find(p => p.name === 'claude-cli')
        // CLI strips ANTHROPIC_API_KEY before spawn — billing is always subscription
        assert.equal(cli.auth.source, 'oauth')
        assert.equal(cli.auth.ready, true)
        assert.match(cli.auth.detail, /subscription/i)
      } finally {
        restoreKeys()
      }
    })

    it('codex reports ready=false and source=none when OPENAI_API_KEY is missing', () => {
      clearKeys()
      try {
        const list = listProviders()
        const codex = list.find(p => p.name === 'codex')
        if (!codex) return // codex registration may be conditional in test env
        assert.equal(codex.auth.ready, false)
        assert.equal(codex.auth.source, 'none')
        assert.match(codex.auth.detail, /OPENAI_API_KEY/)
      } finally {
        restoreKeys()
      }
    })

    it('gemini reports ready when GEMINI_API_KEY is set', () => {
      clearKeys()
      process.env.GEMINI_API_KEY = 'test-key'
      try {
        const list = listProviders()
        const gemini = list.find(p => p.name === 'gemini')
        if (!gemini) return
        assert.equal(gemini.auth.ready, true)
        assert.equal(gemini.auth.source, 'env')
        assert.equal(gemini.auth.envVar, 'GEMINI_API_KEY')
      } finally {
        restoreKeys()
      }
    })

    it('gemini reports ready when GOOGLE_API_KEY is set (without GEMINI_API_KEY)', () => {
      clearKeys()
      process.env.GOOGLE_API_KEY = 'test-key'
      try {
        const list = listProviders()
        const gemini = list.find(p => p.name === 'gemini')
        if (!gemini) return
        assert.equal(gemini.auth.ready, true)
        assert.equal(gemini.auth.source, 'env')
        assert.equal(gemini.auth.envVar, 'GOOGLE_API_KEY')
      } finally {
        restoreKeys()
      }
    })

    it('providers without a preflight credentials block are reported ready (opt-out)', () => {
      class NoPreflightProvider {
        static get capabilities() { return {} }
        // Intentionally no static get preflight() — opts out of credential checks
        sendMessage() {}
        interrupt() {}
        setModel() {}
        setPermissionMode() {}
        start() {}
        destroy() {}
      }
      registerProvider('test-no-preflight', NoPreflightProvider)
      try {
        const list = listProviders()
        const entry = list.find(p => p.name === 'test-no-preflight')
        assert.ok(entry?.auth, 'no-preflight provider should still expose auth')
        assert.equal(entry.auth.ready, true, 'opt-out provider must not be marked unready')
        assert.equal(entry.auth.source, 'none')
        assert.deepEqual(entry.auth.envVars, [])
      } finally {
        // Cleanup: registerProvider mutates the module-level PROVIDERS map.
        // No public unregister, but subsequent tests don't depend on absence.
      }
    })

    // Caught by agent review of #3673: docker-cli/docker-sdk forward
    // ANTHROPIC_API_KEY to the container at `docker run` time, but the
    // container has no ~/.claude OAuth state so they can't fall back when
    // the env var is missing. Earlier code lumped docker-cli into the
    // "always subscription" branch which was the exact misreport F1 was
    // chartered to fix.
    it('docker-cli reports ready=true source=env when ANTHROPIC_API_KEY is set', async () => {
      const { DockerSession } = await import('../src/docker-session.js')
      registerProvider('docker-cli', DockerSession)
      clearKeys()
      process.env.ANTHROPIC_API_KEY = 'sk-test'
      try {
        const list = listProviders()
        const dcli = list.find(p => p.name === 'docker-cli')
        assert.ok(dcli?.auth)
        assert.equal(dcli.auth.ready, true)
        assert.equal(dcli.auth.source, 'env')
        assert.equal(dcli.auth.envVar, 'ANTHROPIC_API_KEY')
        assert.match(dcli.auth.detail, /Anthropic API.*forwarded to container/)
      } finally {
        restoreKeys()
      }
    })

    it('docker-cli reports ready=false source=none when ANTHROPIC_API_KEY is missing', async () => {
      const { DockerSession } = await import('../src/docker-session.js')
      registerProvider('docker-cli', DockerSession)
      clearKeys()
      try {
        const list = listProviders()
        const dcli = list.find(p => p.name === 'docker-cli')
        assert.ok(dcli?.auth)
        assert.equal(dcli.auth.ready, false)
        assert.equal(dcli.auth.source, 'none')
        // Detail must NOT claim subscription billing — that was the bug.
        assert.doesNotMatch(dcli.auth.detail, /subscription/i)
        assert.match(dcli.auth.detail, /no OAuth fallback inside the container/i)
      } finally {
        restoreKeys()
      }
    })

    it('docker-sdk reports ready=true source=env when ANTHROPIC_API_KEY is set', async () => {
      const { DockerSdkSession } = await import('../src/docker-sdk-session.js')
      registerProvider('docker-sdk', DockerSdkSession)
      clearKeys()
      process.env.ANTHROPIC_API_KEY = 'sk-test'
      try {
        const list = listProviders()
        const dsdk = list.find(p => p.name === 'docker-sdk')
        assert.ok(dsdk?.auth)
        assert.equal(dsdk.auth.ready, true)
        assert.equal(dsdk.auth.source, 'env')
        assert.match(dsdk.auth.detail, /Anthropic API/)
      } finally {
        restoreKeys()
      }
    })

    it('docker-sdk reports ready=false when ANTHROPIC_API_KEY is missing (no OAuth fallback in container)', async () => {
      const { DockerSdkSession } = await import('../src/docker-sdk-session.js')
      registerProvider('docker-sdk', DockerSdkSession)
      clearKeys()
      try {
        const list = listProviders()
        const dsdk = list.find(p => p.name === 'docker-sdk')
        assert.ok(dsdk?.auth)
        assert.equal(dsdk.auth.ready, false)
        assert.equal(dsdk.auth.source, 'none')
      } finally {
        restoreKeys()
      }
    })
  })
})

describe('Docker Provider Naming (#2475)', () => {
  it('registerDockerProvider skips when environments not enabled', async () => {
    const before = listProviders().length
    await registerDockerProvider({})
    await registerDockerProvider({ environments: { enabled: false } })
    assert.equal(listProviders().length, before)
  })

  it('docker alias maps to docker-cli (DockerSession)', async () => {
    // Register docker providers manually since Docker may not be available in CI
    const { DockerSession } = await import('../src/docker-session.js')
    registerProvider('docker-cli', DockerSession)
    registerProvider('docker', DockerSession, { alias: true })

    const dockerCli = getProvider('docker-cli')
    const docker = getProvider('docker')
    assert.equal(dockerCli, DockerSession)
    assert.equal(docker, DockerSession, '"docker" should resolve to same class as "docker-cli"')
  })

  it('docker alias is excluded from listProviders()', async () => {
    const list = listProviders()
    const dockerCli = list.find(p => p.name === 'docker-cli')
    const dockerAlias = list.find(p => p.name === 'docker')
    assert.ok(dockerCli, 'docker-cli should appear in listProviders')
    assert.equal(dockerAlias, undefined, 'docker alias should NOT appear in listProviders')
  })

  it('docker-sdk is registered separately', async () => {
    const { DockerSdkSession } = await import('../src/docker-sdk-session.js')
    registerProvider('docker-sdk', DockerSdkSession)

    const dockerSdk = getProvider('docker-sdk')
    assert.equal(dockerSdk, DockerSdkSession)
  })

  it('docker-cli has containerized capability', async () => {
    const { DockerSession } = await import('../src/docker-session.js')
    assert.equal(DockerSession.capabilities.containerized, true)
  })

  it('docker-sdk has containerized capability', async () => {
    const { DockerSdkSession } = await import('../src/docker-sdk-session.js')
    assert.equal(DockerSdkSession.capabilities.containerized, true)
  })
})

describe('Provider Capabilities', () => {
  it('CliSession has static capabilities', () => {
    const caps = CliSession.capabilities
    assert.equal(caps.permissions, true)
    assert.equal(caps.inProcessPermissions, false)
    assert.equal(caps.modelSwitch, true)
    assert.equal(caps.permissionModeSwitch, true)
    assert.equal(caps.planMode, true)
    assert.equal(caps.resume, false)
    assert.equal(caps.terminal, false)
  })

  it('SdkSession has static capabilities', () => {
    const caps = SdkSession.capabilities
    assert.equal(caps.permissions, true)
    assert.equal(caps.inProcessPermissions, true)
    assert.equal(caps.modelSwitch, true)
    assert.equal(caps.permissionModeSwitch, true)
    assert.equal(caps.planMode, false)
    assert.equal(caps.resume, true)
    assert.equal(caps.terminal, false)
  })
})

describe('Provider displayLabel (#2953)', () => {
  it('CliSession exposes a human-readable displayLabel', () => {
    assert.equal(CliSession.displayLabel, 'Claude Code (CLI)')
  })

  it('SdkSession exposes a human-readable displayLabel', () => {
    assert.equal(SdkSession.displayLabel, 'Claude Code (SDK)')
  })

  it('CodexSession exposes a human-readable displayLabel', () => {
    assert.equal(CodexSession.displayLabel, 'OpenAI Codex')
  })

  it('GeminiSession exposes a human-readable displayLabel', () => {
    assert.equal(GeminiSession.displayLabel, 'Google Gemini')
  })

  it('Docker session variants inherit a displayLabel from their base', async () => {
    const { DockerSession } = await import('../src/docker-session.js')
    const { DockerSdkSession } = await import('../src/docker-sdk-session.js')
    // Docker variants derive their label from the underlying provider so the
    // banner stays meaningful without requiring a bespoke override.
    assert.equal(typeof DockerSession.displayLabel, 'string')
    assert.ok(DockerSession.displayLabel.length > 0)
    assert.equal(typeof DockerSdkSession.displayLabel, 'string')
    assert.ok(DockerSdkSession.displayLabel.length > 0)
  })

  it('every built-in provider exposes a non-empty displayLabel', () => {
    // Only assert on the providers shipped with the server — tests earlier in
    // this file register ad-hoc providers that don't need displayLabel.
    const BUILT_IN = ['claude-cli', 'claude-sdk', 'codex', 'gemini']
    for (const name of BUILT_IN) {
      const ProviderClass = getProvider(name)
      assert.equal(
        typeof ProviderClass.displayLabel,
        'string',
        `Provider "${name}" must expose static get displayLabel()`
      )
      assert.ok(
        ProviderClass.displayLabel.length > 0,
        `Provider "${name}" displayLabel must be non-empty`
      )
    }
  })
})

describe('resolveProviderLabel helper (#2953)', () => {
  it('returns the provider class displayLabel for known providers', async () => {
    const { resolveProviderLabel } = await import('../src/providers.js')
    assert.equal(resolveProviderLabel('claude-cli'), 'Claude Code (CLI)')
    assert.equal(resolveProviderLabel('claude-sdk'), 'Claude Code (SDK)')
    assert.equal(resolveProviderLabel('codex'), 'OpenAI Codex')
    assert.equal(resolveProviderLabel('gemini'), 'Google Gemini')
  })

  it('falls back to the raw provider name for unknown providers', async () => {
    const { resolveProviderLabel } = await import('../src/providers.js')
    // Unknown providers should not throw — server-cli should still boot.
    assert.equal(resolveProviderLabel('not-registered-xyz'), 'not-registered-xyz')
  })

  it('handles empty/undefined input without throwing', async () => {
    const { resolveProviderLabel } = await import('../src/providers.js')
    assert.equal(resolveProviderLabel(undefined), 'unknown')
    assert.equal(resolveProviderLabel(null), 'unknown')
    assert.equal(resolveProviderLabel(''), 'unknown')
  })
})
