import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
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
