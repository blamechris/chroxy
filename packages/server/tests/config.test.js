import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { validateConfig, mergeConfig } from '../src/config.js'

describe('validateConfig', () => {
  it('accepts valid config with all known keys', () => {
    const config = {
      apiToken: 'abc123',
      port: 8765,
      tmuxSession: 'my-session',
      shell: '/bin/bash',
      cwd: '/home/user',
      model: 'sonnet',
      allowedTools: ['bash', 'read'],
      resume: true,
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
      resume: 'yes',
      allowedTools: 'bash,read',
    }
    const result = validateConfig(config)
    assert.equal(result.valid, false)
    assert.equal(result.warnings.length, 3)
    assert.ok(result.warnings.some(w => w.includes('port') && w.includes('number')))
    assert.ok(result.warnings.some(w => w.includes('resume') && w.includes('boolean')))
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
})

describe('mergeConfig', () => {
  let originalEnv
  const envKeys = ['API_TOKEN', 'PORT', 'TMUX_SESSION', 'SHELL_CMD', 'CHROXY_CWD', 'CHROXY_MODEL', 'CHROXY_ALLOWED_TOOLS', 'CHROXY_RESUME', 'CHROXY_TUNNEL', 'CHROXY_TUNNEL_NAME', 'CHROXY_TUNNEL_HOSTNAME']

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
    process.env.TMUX_SESSION = 'env-session'
    const defaults = { 
      port: 8765, 
      tmuxSession: 'default-session',
      apiToken: 'default-token',
      shell: '/bin/bash',
    }
    const fileConfig = { 
      port: 9000,
      tmuxSession: 'file-session',
      apiToken: 'file-token',
    }
    const cliOverrides = { 
      port: 5555,
      apiToken: 'cli-token',
    }
    
    const merged = mergeConfig({ defaults, fileConfig, cliOverrides })
    
    assert.equal(merged.port, 5555)
    assert.equal(merged.apiToken, 'cli-token')
    assert.equal(merged.tmuxSession, 'env-session')
    assert.equal(merged.shell, '/bin/bash')
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
    process.env.CHROXY_RESUME = 'true'
    
    const merged = mergeConfig({ defaults: { resume: false } })
    
    assert.equal(merged.resume, true)
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
    assert.equal(merged.tmuxSession, undefined)
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
})
