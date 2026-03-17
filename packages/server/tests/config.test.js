import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { validateConfig, mergeConfig, readReposFromConfig, writeReposToConfig } from '../src/config.js'

describe('validateConfig', () => {
  it('accepts valid config with all known keys', () => {
    const config = {
      apiToken: 'abc123',
      port: 8765,
      shell: '/bin/bash',
      cwd: '/home/user',
      model: 'sonnet',
      allowedTools: ['bash', 'read'],
      noAuth: false,
    }
    const result = validateConfig(config)
    assert.equal(result.valid, true)
    assert.equal(result.warnings.length, 0)
  })

  it('warns about unknown keys', () => {
    const config = {
      apiToken: 'abc123',
      unknownKey: 'value',
      anotherUnknown: 123,
    }
    const result = validateConfig(config)
    assert.equal(result.valid, false)
    assert.equal(result.warnings.length, 2)
    assert.ok(result.warnings[0].includes('unknownKey'))
    assert.ok(result.warnings[1].includes('anotherUnknown'))
  })

  it('warns about type mismatches', () => {
    const config = {
      port: '8765',
      allowedTools: 'bash,read',
    }
    const result = validateConfig(config)
    assert.equal(result.valid, false)
    assert.equal(result.warnings.length, 2)
    assert.ok(result.warnings.some(w => w.includes('port') && w.includes('number')))
    assert.ok(result.warnings.some(w => w.includes('allowedTools') && w.includes('array')))
  })

  it('accepts empty config', () => {
    const result = validateConfig({})
    assert.equal(result.valid, true)
    assert.equal(result.warnings.length, 0)
  })

  it('accepts partial config', () => {
    const config = {
      port: 9000,
      apiToken: 'token123',
    }
    const result = validateConfig(config)
    assert.equal(result.valid, true)
    assert.equal(result.warnings.length, 0)
  })

  it('accepts provider key as string', () => {
    const config = { provider: 'claude-sdk' }
    const result = validateConfig(config)
    assert.equal(result.valid, true)
    assert.equal(result.warnings.length, 0)
  })

  it('warns when provider has wrong type', () => {
    const config = { provider: 123 }
    const result = validateConfig(config)
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('provider') && w.includes('string')))
  })

  it('accepts valid provider names', () => {
    const config = { provider: 'claude-sdk' }
    const result = validateConfig(config)
    assert.equal(result.valid, true)
    assert.equal(result.warnings.length, 0)
  })

  it('accepts valid https externalUrl', () => {
    const result = validateConfig({ externalUrl: 'https://example.com' })
    assert.equal(result.valid, true)
    assert.equal(result.warnings.length, 0)
  })

  it('accepts valid http externalUrl', () => {
    const result = validateConfig({ externalUrl: 'http://localhost:8080' })
    assert.equal(result.valid, true)
    assert.equal(result.warnings.length, 0)
  })

  it('warns about non-http protocol in externalUrl', () => {
    const result = validateConfig({ externalUrl: 'ftp://example.com' })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('externalUrl') && w.includes('ftp:')))
  })

  it('warns about malformed externalUrl', () => {
    const result = validateConfig({ externalUrl: 'not-a-url' })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('Invalid URL format') && w.includes('not-a-url')))
  })

  it('skips validation for empty externalUrl', () => {
    const result = validateConfig({ externalUrl: '' })
    assert.equal(result.valid, true)
    assert.equal(result.warnings.length, 0)
  })

  it('warns about wss protocol in externalUrl', () => {
    const result = validateConfig({ externalUrl: 'wss://example.com' })
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('externalUrl') && w.includes('wss:')))
  })

  it('accepts sandbox as an object', () => {
    const config = {
      sandbox: {
        network: { allowedDomains: ['example.com'] },
        filesystem: { allowedPaths: ['/tmp'] },
      },
    }
    const result = validateConfig(config)
    assert.equal(result.valid, true)
    assert.equal(result.warnings.length, 0)
  })

  it('warns when sandbox has wrong type', () => {
    const config = { sandbox: 'enabled' }
    const result = validateConfig(config)
    assert.equal(result.valid, false)
    assert.ok(result.warnings.some(w => w.includes('sandbox') && w.includes('object')))
  })
})

describe('mergeConfig', () => {
  let originalEnv
  const envKeys = ['API_TOKEN', 'PORT', 'SHELL_CMD', 'CHROXY_CWD', 'CHROXY_MODEL', 'CHROXY_ALLOWED_TOOLS', 'CHROXY_NO_AUTH', 'CHROXY_TUNNEL', 'CHROXY_TUNNEL_NAME', 'CHROXY_TUNNEL_HOSTNAME', 'CHROXY_LEGACY_CLI', 'CHROXY_PROVIDER', 'CHROXY_SHOW_TOKEN', 'CHROXY_REPOS']

  beforeEach(() => {
    originalEnv = {}
    for (const key of envKeys) {
      originalEnv[key] = process.env[key]
      delete process.env[key]
    }
  })

  afterEach(() => {
    for (const key of envKeys) {
      if (originalEnv[key] !== undefined) {
        process.env[key] = originalEnv[key]
      } else {
        delete process.env[key]
      }
    }
  })

  it('uses defaults when no other config provided', () => {
    const defaults = { port: 8765, apiToken: 'default-token' }
    const merged = mergeConfig({ defaults })
    assert.equal(merged.port, 8765)
    assert.equal(merged.apiToken, 'default-token')
  })

  it('file config overrides defaults', () => {
    const defaults = { port: 8765, apiToken: 'default-token' }
    const fileConfig = { port: 9000 }
    const merged = mergeConfig({ defaults, fileConfig })
    assert.equal(merged.port, 9000)
    assert.equal(merged.apiToken, 'default-token')
  })

  it('environment variables override file config', () => {
    process.env.PORT = '7777'
    const defaults = { port: 8765 }
    const fileConfig = { port: 9000 }
    const merged = mergeConfig({ defaults, fileConfig })
    assert.equal(merged.port, 7777)
  })

  it('CLI overrides environment variables', () => {
    process.env.PORT = '7777'
    const defaults = { port: 8765 }
    const fileConfig = { port: 9000 }
    const cliOverrides = { port: 5555 }
    const merged = mergeConfig({ defaults, fileConfig, cliOverrides })
    assert.equal(merged.port, 5555)
  })

  it('precedence order: CLI > ENV > file > defaults', () => {
    process.env.SHELL_CMD = '/bin/zsh'
    const defaults = {
      port: 8765,
      apiToken: 'default-token',
      shell: '/bin/bash',
    }
    const fileConfig = {
      port: 9000,
      apiToken: 'file-token',
    }
    const cliOverrides = {
      port: 5555,
      apiToken: 'cli-token',
    }

    const merged = mergeConfig({ defaults, fileConfig, cliOverrides })

    assert.equal(merged.port, 5555)
    assert.equal(merged.apiToken, 'cli-token')
    assert.equal(merged.shell, '/bin/zsh')
  })

  it('parses environment variable types correctly', () => {
    process.env.PORT = '9999'
    process.env.CHROXY_ALLOWED_TOOLS = 'bash,read,write'
    
    const merged = mergeConfig({ defaults: {} })
    
    assert.equal(merged.port, 9999)
    assert.ok(Array.isArray(merged.allowedTools))
    assert.deepEqual(merged.allowedTools, ['bash', 'read', 'write'])
  })

  it('handles boolean environment variables', () => {
    process.env.CHROXY_NO_AUTH = 'true'

    const merged = mergeConfig({ defaults: { noAuth: false } })

    assert.equal(merged.noAuth, true)
  })

  it('handles invalid number in environment variable gracefully', () => {
    process.env.PORT = 'notanumber'
    
    const merged = mergeConfig({ defaults: { port: 8765 } })
    
    // parseEnvValue returns the string if parseInt returns NaN
    // This will be caught by validateConfig which will warn about type mismatch
    assert.equal(merged.port, 'notanumber')
    assert.equal(typeof merged.port, 'string')
  })

  it('does not include undefined values', () => {
    const merged = mergeConfig({
      defaults: { port: 8765 },
      fileConfig: { apiToken: 'token' },
    })

    assert.equal(merged.port, 8765)
    assert.equal(merged.apiToken, 'token')
    assert.equal(merged.shell, undefined)
  })

  it('merges tunnel config from file', () => {
    const fileConfig = {
      tunnel: 'named',
      tunnelName: 'chroxy',
      tunnelHostname: 'chroxy.example.com',
    }
    const merged = mergeConfig({ fileConfig })
    assert.equal(merged.tunnel, 'named')
    assert.equal(merged.tunnelName, 'chroxy')
    assert.equal(merged.tunnelHostname, 'chroxy.example.com')
  })

  it('tunnel config from env vars overrides file', () => {
    process.env.CHROXY_TUNNEL = 'quick'
    const fileConfig = { tunnel: 'named', tunnelName: 'chroxy' }
    const merged = mergeConfig({ fileConfig })
    assert.equal(merged.tunnel, 'quick')
    assert.equal(merged.tunnelName, 'chroxy')
  })

  it('tunnel config from CLI overrides env', () => {
    process.env.CHROXY_TUNNEL = 'named'
    const cliOverrides = { tunnel: 'none' }
    const merged = mergeConfig({ cliOverrides })
    assert.equal(merged.tunnel, 'none')
  })

  it('maps legacyCli to provider when no explicit provider set', () => {
    const merged = mergeConfig({ cliOverrides: { legacyCli: true } })
    assert.equal(merged.provider, 'claude-cli')
  })

  it('does not override explicit provider with legacyCli', () => {
    const merged = mergeConfig({ cliOverrides: { legacyCli: true, provider: 'custom' } })
    assert.equal(merged.provider, 'custom')
  })

  it('does not set provider when legacyCli is false', () => {
    const merged = mergeConfig({ cliOverrides: { legacyCli: false } })
    assert.equal(merged.provider, undefined)
  })

  it('legacyCli from CLI with provider from file - CLI legacyCli wins', () => {
    const fileConfig = { provider: 'claude-sdk' }
    const cliOverrides = { legacyCli: true }
    const merged = mergeConfig({ fileConfig, cliOverrides })
    assert.equal(merged.provider, 'claude-sdk')
  })

  it('legacyCli from ENV with provider from file - file provider wins', () => {
    process.env.CHROXY_LEGACY_CLI = 'true'
    const fileConfig = { provider: 'claude-sdk' }
    const merged = mergeConfig({ fileConfig })
    assert.equal(merged.provider, 'claude-sdk')
    assert.equal(merged.legacyCli, true)
  })

  it('legacyCli from ENV with no provider - legacyCli sets provider', () => {
    process.env.CHROXY_LEGACY_CLI = 'true'
    const merged = mergeConfig({})
    assert.equal(merged.provider, 'claude-cli')
    assert.equal(merged.legacyCli, true)
  })

  it('legacyCli from file with provider from ENV - ENV provider wins', () => {
    process.env.CHROXY_PROVIDER = 'custom'
    const fileConfig = { legacyCli: true }
    const merged = mergeConfig({ fileConfig })
    assert.equal(merged.provider, 'custom')
    assert.equal(merged.legacyCli, true)
  })

  it('reads showToken from CHROXY_SHOW_TOKEN env var (#1924)', () => {
    process.env.CHROXY_SHOW_TOKEN = '1'
    const merged = mergeConfig({ defaults: { showToken: false } })
    assert.equal(merged.showToken, true)
  })

  it('reads repos from CHROXY_REPOS env var as comma-separated (#1924)', () => {
    process.env.CHROXY_REPOS = '/home/user/project1,/home/user/project2'
    const merged = mergeConfig({ defaults: {} })
    assert.ok(Array.isArray(merged.repos))
    assert.deepEqual(merged.repos, ['/home/user/project1', '/home/user/project2'])
  })
})

describe('readReposFromConfig', () => {
  let tempDir

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-config-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('returns empty array when file does not exist', () => {
    const result = readReposFromConfig(join(tempDir, 'nonexistent.json'))
    assert.deepEqual(result, [])
  })

  it('returns empty array when config has no repos key', () => {
    const configPath = join(tempDir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ port: 8765 }))
    const result = readReposFromConfig(configPath)
    assert.deepEqual(result, [])
  })

  it('returns repos array from config', () => {
    const repos = [{ path: '/home/user/project', name: 'my-project' }]
    const configPath = join(tempDir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ repos }))
    const result = readReposFromConfig(configPath)
    assert.deepEqual(result, repos)
  })

  it('returns empty array for invalid JSON', () => {
    const configPath = join(tempDir, 'config.json')
    writeFileSync(configPath, 'NOT JSON')
    const result = readReposFromConfig(configPath)
    assert.deepEqual(result, [])
  })

  it('returns empty array when repos is not an array', () => {
    const configPath = join(tempDir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ repos: 'not-array' }))
    const result = readReposFromConfig(configPath)
    assert.deepEqual(result, [])
  })
})

describe('writeReposToConfig', () => {
  let tempDir

  beforeEach(() => {
    tempDir = mkdtempSync(join(tmpdir(), 'chroxy-config-test-'))
  })

  afterEach(() => {
    rmSync(tempDir, { recursive: true, force: true })
  })

  it('creates config file with repos', () => {
    const configPath = join(tempDir, 'config.json')
    const repos = [{ path: '/tmp/repo', name: 'repo' }]
    writeReposToConfig(repos, configPath)
    const result = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.deepEqual(result.repos, repos)
  })

  it('preserves existing config fields', () => {
    const configPath = join(tempDir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ port: 9000, apiToken: 'abc' }))
    writeReposToConfig([{ path: '/tmp/repo' }], configPath)
    const result = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.equal(result.port, 9000)
    assert.equal(result.apiToken, 'abc')
    assert.deepEqual(result.repos, [{ path: '/tmp/repo' }])
  })

  it('overwrites existing repos', () => {
    const configPath = join(tempDir, 'config.json')
    writeFileSync(configPath, JSON.stringify({ repos: [{ path: '/old' }] }))
    writeReposToConfig([{ path: '/new' }], configPath)
    const result = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.deepEqual(result.repos, [{ path: '/new' }])
  })

  it('creates parent directories if needed', () => {
    const configPath = join(tempDir, 'nested', 'dir', 'config.json')
    writeReposToConfig([{ path: '/tmp' }], configPath)
    const result = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.deepEqual(result.repos, [{ path: '/tmp' }])
  })

  it('handles malformed existing config gracefully', () => {
    const configPath = join(tempDir, 'config.json')
    writeFileSync(configPath, 'NOT JSON')
    writeReposToConfig([{ path: '/tmp' }], configPath)
    const result = JSON.parse(readFileSync(configPath, 'utf-8'))
    assert.deepEqual(result.repos, [{ path: '/tmp' }])
  })
})
