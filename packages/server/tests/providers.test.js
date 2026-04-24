import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { registerProvider, getProvider, listProviders, registerDockerProvider } from '../src/providers.js'
import { CliSession } from '../src/cli-session.js'
import { SdkSession } from '../src/sdk-session.js'

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
