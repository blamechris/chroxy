import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { writeFileSync, mkdtempSync, rmSync, readFileSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { validateConfig, mergeConfig, readReposFromConfig, writeReposToConfig, sanitizeConfig, isFatalConfigWarning, resolveSemanticTitleTimeoutMs } from '../src/config.js'
import { DEFAULT_SEMANTIC_TITLE_TIMEOUT_MS } from '../src/session-title.js'

// audit P1-9: fatality must come from the single isFatalConfigWarning policy,
// and the wording convention (type=fatal, value=non-fatal) must hold — a typo
// in a value should never abort startup.
describe('isFatalConfigWarning (config fatal-vs-warn policy)', () => {
  it('treats "Invalid type" warnings as fatal and "Invalid value" as non-fatal', () => {
    assert.equal(isFatalConfigWarning("Invalid type for 'port': expected number, got string"), true)
    assert.equal(isFatalConfigWarning("Invalid value for 'environments.k8s.connectMode': 'x'"), false)
    assert.equal(isFatalConfigWarning('Unknown config key: foo'), false)
    assert.equal(isFatalConfigWarning(''), false)
    assert.equal(isFatalConfigWarning(undefined), false)
  })

  it('INVARIANT: no "Invalid value" warning validateConfig produces is ever fatal', () => {
    // A config that trips many value-level checks at once (range + format +
    // enum + unknown key). None must be classified fatal.
    const bad = validateConfig({
      port: 70000,                                   // out of range (Invalid value)
      maxSessions: 0,                                // < 1 (Invalid value)
      totallyUnknownKey: true,                       // Unknown config key
      environments: { k8s: { imagePullPolicy: 'Sometimes', connectMode: 'telepathy' } }, // enum (Invalid value)
    })
    const fatalValueWarnings = bad.warnings.filter(
      (w) => w.startsWith('Invalid value') && isFatalConfigWarning(w),
    )
    assert.deepEqual(fatalValueWarnings, [], `no "Invalid value" warning may be fatal; got: ${JSON.stringify(fatalValueWarnings)}`)
    // And a genuine type error IS fatal.
    const typed = validateConfig({ port: { nested: true } }) // wrong type for port
    assert.ok(typed.warnings.some(isFatalConfigWarning), 'a type mismatch must be fatal')
  })
})

describe('validateConfig', () => {
  it('accepts valid config with all known keys', () => {
    const config = {
      apiToken: 'abc123',
      port: 8765,
      host: '127.0.0.1',
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

  it('accepts worktreeGc with autoReap + valid reapIntervalMs (#5326)', () => {
    const result = validateConfig({ worktreeGc: { autoReap: true, reapIntervalMs: 60000 } })
    assert.equal(result.valid, true)
    assert.equal(result.warnings.length, 0)
  })

  it('accepts worktreeGc.autoReap with no reapIntervalMs (#5326)', () => {
    const result = validateConfig({ worktreeGc: { autoReap: true } })
    assert.equal(result.warnings.length, 0)
  })

  it('warns when worktreeGc.reapIntervalMs is not a positive number (#5326)', () => {
    for (const bad of [0, -1, 'fast', null]) {
      const result = validateConfig({ worktreeGc: { autoReap: true, reapIntervalMs: bad } })
      assert.ok(
        result.warnings.some(w => w.includes('reapIntervalMs') && w.includes('positive')),
        `expected a reapIntervalMs warning for ${JSON.stringify(bad)}, got: ${JSON.stringify(result.warnings)}`,
      )
    }
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

  describe('resultTimeoutMs (#3749)', () => {
    it('accepts a value within the allowed range', () => {
      const result = validateConfig({ resultTimeoutMs: 600_000 })
      assert.equal(result.valid, true)
    })

    it('rejects values below the 30s minimum', () => {
      const result = validateConfig({ resultTimeoutMs: 1000 })
      assert.equal(result.valid, false)
      assert.ok(result.warnings.some(w => w.includes('resultTimeoutMs') && w.includes('minimum')))
    })

    it('rejects values above the 24h maximum', () => {
      const result = validateConfig({ resultTimeoutMs: 25 * 60 * 60 * 1000 })
      assert.equal(result.valid, false)
      assert.ok(result.warnings.some(w => w.includes('resultTimeoutMs') && w.includes('maximum')))
    })

    it('warns when value is not a number', () => {
      const result = validateConfig({ resultTimeoutMs: '5m' })
      assert.equal(result.valid, false)
      assert.ok(result.warnings.some(w => w.includes('resultTimeoutMs') && w.includes('number')))
    })
  })

  describe('streamStallTimeoutMs (#4467)', () => {
    it('accepts a value within the allowed range', () => {
      const result = validateConfig({ streamStallTimeoutMs: 300_000 })
      assert.equal(result.valid, true)
    })

    it('accepts 0 as an explicit disable', () => {
      const result = validateConfig({ streamStallTimeoutMs: 0 })
      assert.equal(result.valid, true)
    })

    it('rejects values below the 5s minimum', () => {
      const result = validateConfig({ streamStallTimeoutMs: 1000 })
      assert.equal(result.valid, false)
      assert.ok(result.warnings.some(w => w.includes('streamStallTimeoutMs') && w.includes('minimum')))
    })

    it('rejects values above the 24h maximum', () => {
      const result = validateConfig({ streamStallTimeoutMs: 25 * 60 * 60 * 1000 })
      assert.equal(result.valid, false)
      assert.ok(result.warnings.some(w => w.includes('streamStallTimeoutMs') && w.includes('maximum')))
    })

    it('warns when value is not a number', () => {
      const result = validateConfig({ streamStallTimeoutMs: '5m' })
      assert.equal(result.valid, false)
      assert.ok(result.warnings.some(w => w.includes('streamStallTimeoutMs') && w.includes('number')))
    })
  })

  // #4601: per-provider override map for streamStallTimeoutMs. Keys are
  // provider ids (claude-sdk, codex, gemini, …); values are stall windows
  // in ms with the same 5s-24h-or-0 validation as the global setting.
  // Default behaviour is unchanged when the map is omitted.
  describe('providerStreamStallTimeoutMs (#4601)', () => {
    it('accepts a valid per-provider map', () => {
      const result = validateConfig({
        providerStreamStallTimeoutMs: {
          codex: 900_000,
          gemini: 600_000,
        },
      })
      assert.equal(result.valid, true)
      assert.equal(result.warnings.length, 0)
    })

    it('accepts an empty object', () => {
      const result = validateConfig({ providerStreamStallTimeoutMs: {} })
      assert.equal(result.valid, true)
    })

    it('accepts 0 as an explicit per-provider disable', () => {
      const result = validateConfig({
        providerStreamStallTimeoutMs: { codex: 0 },
      })
      assert.equal(result.valid, true)
    })

    it('rejects array values (type mismatch)', () => {
      const result = validateConfig({ providerStreamStallTimeoutMs: [1, 2, 3] })
      assert.equal(result.valid, false)
      assert.ok(result.warnings.some(w => w.includes('providerStreamStallTimeoutMs') && w.includes('object')))
    })

    it('warns when a non-number value is supplied for a provider entry', () => {
      const result = validateConfig({
        providerStreamStallTimeoutMs: { codex: '15m' },
      })
      assert.equal(result.valid, false)
      assert.ok(result.warnings.some(w => w.includes("providerStreamStallTimeoutMs.codex") && w.includes('number')))
    })

    it('warns when a per-provider value is below the 5s minimum', () => {
      const result = validateConfig({
        providerStreamStallTimeoutMs: { gemini: 1000 },
      })
      assert.equal(result.valid, false)
      assert.ok(result.warnings.some(w => w.includes("providerStreamStallTimeoutMs.gemini") && w.includes('minimum')))
    })

    it('warns when a per-provider value is above the 24h maximum', () => {
      const result = validateConfig({
        providerStreamStallTimeoutMs: { codex: 25 * 60 * 60 * 1000 },
      })
      assert.equal(result.valid, false)
      assert.ok(result.warnings.some(w => w.includes("providerStreamStallTimeoutMs.codex") && w.includes('maximum')))
    })
  })

  // #4482: per-call MCP tools/call timeout. Defaults to 30s (matches
  // byok-mcp-client's DEFAULT_TOOL_CALL_TIMEOUT_MS). Allowed range
  // 1s-10min — below 1s every realistic MCP server times out, above
  // 10min the model conversation is already lost.
  describe('mcpToolCallTimeoutMs (#4482)', () => {
    it('accepts a value within the allowed range', () => {
      const result = validateConfig({ mcpToolCallTimeoutMs: 60_000 })
      assert.equal(result.valid, true)
    })

    it('rejects values below the 1s minimum', () => {
      const result = validateConfig({ mcpToolCallTimeoutMs: 500 })
      assert.equal(result.valid, false)
      assert.ok(result.warnings.some(w => w.includes('mcpToolCallTimeoutMs') && w.includes('minimum')))
    })

    it('rejects values above the 10min maximum', () => {
      const result = validateConfig({ mcpToolCallTimeoutMs: 11 * 60 * 1000 })
      assert.equal(result.valid, false)
      assert.ok(result.warnings.some(w => w.includes('mcpToolCallTimeoutMs') && w.includes('maximum')))
    })

    it('warns when value is not a number', () => {
      const result = validateConfig({ mcpToolCallTimeoutMs: '60s' })
      assert.equal(result.valid, false)
      assert.ok(result.warnings.some(w => w.includes('mcpToolCallTimeoutMs') && w.includes('number')))
    })
  })

  describe('billing egress check (#5828)', () => {
    it('accepts egressCheck boolean + datacenterPrefixes array', () => {
      const result = validateConfig({ billing: { egressCheck: true, datacenterPrefixes: ['203.0.113.'] } })
      assert.equal(result.valid, true)
      assert.equal(result.warnings.length, 0)
    })

    it('accepts a billing block with neither egress field (default off)', () => {
      const result = validateConfig({ billing: { creditTier: 'pro' } })
      assert.equal(result.valid, true)
    })

    it('warns when egressCheck is not a boolean', () => {
      const result = validateConfig({ billing: { egressCheck: 'yes' } })
      assert.equal(result.valid, false)
      assert.ok(result.warnings.some(w => w.includes('billing.egressCheck') && w.includes('boolean')))
    })

    it('warns when datacenterPrefixes is not an array', () => {
      const result = validateConfig({ billing: { datacenterPrefixes: '203.0.113.' } })
      assert.equal(result.valid, false)
      assert.ok(result.warnings.some(w => w.includes('billing.datacenterPrefixes')))
    })

    it('warns when datacenterPrefixes contains a non-string or empty entry', () => {
      const result = validateConfig({ billing: { datacenterPrefixes: ['203.0.113.', ''] } })
      assert.equal(result.valid, false)
      assert.ok(result.warnings.some(w => w.includes('billing.datacenterPrefixes')))
    })
  })
})

describe('mergeConfig', () => {
  let originalEnv
  const envKeys = ['API_TOKEN', 'PORT', 'CHROXY_HOST', 'CHROXY_CWD', 'CHROXY_MODEL', 'CHROXY_ALLOWED_TOOLS', 'CHROXY_NO_AUTH', 'CHROXY_TUNNEL', 'CHROXY_TUNNEL_NAME', 'CHROXY_TUNNEL_HOSTNAME', 'CHROXY_LEGACY_CLI', 'CHROXY_PROVIDER', 'CHROXY_PROVIDERS', 'CHROXY_SHOW_TOKEN', 'CHROXY_REPOS', 'CHROXY_RESULT_TIMEOUT_MS', 'CHROXY_STREAM_STALL_TIMEOUT_MS', 'CHROXY_MCP_TOOL_CALL_TIMEOUT_MS', 'CHROXY_PROVIDER_STREAM_STALL_TIMEOUT_MS']

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
    process.env.CHROXY_CWD = '/tmp/env-cwd'
    const defaults = {
      port: 8765,
      apiToken: 'default-token',
      cwd: '/home/user',
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
    assert.equal(merged.cwd, '/tmp/env-cwd')
  })

  it('parses environment variable types correctly', () => {
    process.env.PORT = '9999'
    process.env.CHROXY_ALLOWED_TOOLS = 'bash,read,write'
    
    const merged = mergeConfig({ defaults: {} })
    
    assert.equal(merged.port, 9999)
    assert.ok(Array.isArray(merged.allowedTools))
    assert.deepEqual(merged.allowedTools, ['bash', 'read', 'write'])
  })

  it('CHROXY_PROVIDERS parses the JSON object form (#5419)', () => {
    process.env.CHROXY_PROVIDERS = '{"anthropicCompatible":[{"id":"zai-glm","baseUrl":"https://api.z.ai/api/anthropic","defaultModel":"glm-4.7"}]}'

    const merged = mergeConfig({ defaults: {} })

    assert.ok(merged.providers && !Array.isArray(merged.providers), 'object form must parse as an object')
    assert.equal(merged.providers.anthropicCompatible[0].id, 'zai-glm')
  })

  it('CHROXY_PROVIDERS keeps the legacy comma-split semantics', () => {
    process.env.CHROXY_PROVIDERS = 'claude-sdk, codex'

    const merged = mergeConfig({ defaults: {} })

    assert.deepEqual(merged.providers, ['claude-sdk', 'codex'])
  })

  it('CHROXY_PROVIDERS with malformed JSON falls back to the comma-split list (warned, not silent — #5419)', () => {
    // The log.warn side of this path is exercised at startup; the
    // behavioural contract pinned here is that startup still proceeds on
    // the legacy semantics instead of crashing or dropping the key.
    process.env.CHROXY_PROVIDERS = '{"anthropicCompatible": [oops'

    const merged = mergeConfig({ defaults: {} })

    assert.ok(Array.isArray(merged.providers), 'malformed JSON degrades to the legacy array')
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
    assert.equal(merged.cwd, undefined)
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

  it('reads host from CHROXY_HOST env var', () => {
    process.env.CHROXY_HOST = '127.0.0.1'
    const merged = mergeConfig({ defaults: {} })
    assert.equal(merged.host, '127.0.0.1')
  })

  it('CLI host override beats CHROXY_HOST env var', () => {
    process.env.CHROXY_HOST = '127.0.0.1'
    const merged = mergeConfig({ cliOverrides: { host: '0.0.0.0' }, defaults: {} })
    assert.equal(merged.host, '0.0.0.0')
  })

  it('reads repos from CHROXY_REPOS env var as comma-separated (#1924)', () => {
    process.env.CHROXY_REPOS = '/home/user/project1,/home/user/project2'
    const merged = mergeConfig({ defaults: {} })
    assert.ok(Array.isArray(merged.repos))
    assert.deepEqual(merged.repos, ['/home/user/project1', '/home/user/project2'])
  })

  it('reads resultTimeoutMs from CHROXY_RESULT_TIMEOUT_MS env var as number (#3749)', () => {
    process.env.CHROXY_RESULT_TIMEOUT_MS = '600000'
    const merged = mergeConfig({})
    assert.equal(merged.resultTimeoutMs, 600_000)
  })

  it('reads streamStallTimeoutMs from CHROXY_STREAM_STALL_TIMEOUT_MS env var as number (#4467)', () => {
    process.env.CHROXY_STREAM_STALL_TIMEOUT_MS = '300000'
    const merged = mergeConfig({})
    assert.equal(merged.streamStallTimeoutMs, 300_000)
    delete process.env.CHROXY_STREAM_STALL_TIMEOUT_MS
  })

  it('reads streamStallTimeoutMs=0 from env var as explicit disable (#4467)', () => {
    process.env.CHROXY_STREAM_STALL_TIMEOUT_MS = '0'
    const merged = mergeConfig({})
    assert.equal(merged.streamStallTimeoutMs, 0)
    delete process.env.CHROXY_STREAM_STALL_TIMEOUT_MS
  })

  it('reads providerStreamStallTimeoutMs from CHROXY_PROVIDER_STREAM_STALL_TIMEOUT_MS env var as JSON object (#4601)', () => {
    process.env.CHROXY_PROVIDER_STREAM_STALL_TIMEOUT_MS = JSON.stringify({ codex: 900000, gemini: 600000 })
    const merged = mergeConfig({})
    assert.deepEqual(merged.providerStreamStallTimeoutMs, { codex: 900000, gemini: 600000 })
    delete process.env.CHROXY_PROVIDER_STREAM_STALL_TIMEOUT_MS
  })

  it('reads mcpToolCallTimeoutMs from CHROXY_MCP_TOOL_CALL_TIMEOUT_MS env var as number (#4482)', () => {
    process.env.CHROXY_MCP_TOOL_CALL_TIMEOUT_MS = '90000'
    const merged = mergeConfig({})
    assert.equal(merged.mcpToolCallTimeoutMs, 90_000)
    delete process.env.CHROXY_MCP_TOOL_CALL_TIMEOUT_MS
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

describe('sanitizeConfig', () => {
  it('masks apiToken with ***', () => {
    const config = { apiToken: 'secret-token-123', port: 8765 }
    const safe = sanitizeConfig(config)
    assert.equal(safe.apiToken, '***')
    assert.equal(safe.port, 8765)
  })

  // audit P2-12: `pushToken` is NOT a CONFIG_SCHEMA key — push tokens are
  // runtime device registrations (`prefs.devices`), masked elsewhere — so it
  // was dropped from config's SENSITIVE_KEYS. sanitizeConfig leaves an
  // unrecognized key untouched; only the real config secret `apiToken` is masked.
  it('does not treat pushToken as a config secret (not a CONFIG_SCHEMA key)', () => {
    const config = { pushToken: 'push-secret-abc', port: 8765 }
    const safe = sanitizeConfig(config)
    assert.equal(safe.pushToken, 'push-secret-abc')
    assert.equal(safe.port, 8765)
  })

  it('masks apiToken but not pushToken when both present', () => {
    const config = { apiToken: 'api-secret', pushToken: 'push-secret', model: 'sonnet' }
    const safe = sanitizeConfig(config)
    assert.equal(safe.apiToken, '***')
    assert.equal(safe.pushToken, 'push-secret')
    assert.equal(safe.model, 'sonnet')
  })

  it('does not modify the original config object', () => {
    const config = { apiToken: 'secret-token-123', port: 8765 }
    sanitizeConfig(config)
    assert.equal(config.apiToken, 'secret-token-123')
    assert.equal(config.port, 8765)
  })

  it('leaves non-sensitive fields unchanged', () => {
    const config = { port: 8765, model: 'claude-3', noAuth: false, cwd: '/tmp' }
    const safe = sanitizeConfig(config)
    assert.deepEqual(safe, config)
  })

  it('handles config with no sensitive fields', () => {
    const config = { port: 9000, model: 'sonnet' }
    const safe = sanitizeConfig(config)
    assert.deepEqual(safe, config)
  })

  it('skips masking when apiToken is falsy', () => {
    const config = { apiToken: '', port: 8765 }
    const safe = sanitizeConfig(config)
    assert.equal(safe.apiToken, '')
  })

  it('handles empty config object', () => {
    const safe = sanitizeConfig({})
    assert.deepEqual(safe, {})
  })
})

// #6764 / #6881 — timeout resolver for the fire-and-forget one-shot title call.
describe('resolveSemanticTitleTimeoutMs', () => {
  const ENV = 'CHROXY_SEMANTIC_TITLES_TIMEOUT_MS'
  let saved
  beforeEach(() => { saved = process.env[ENV]; delete process.env[ENV] })
  afterEach(() => {
    if (saved === undefined) delete process.env[ENV]
    else process.env[ENV] = saved
  })

  it('defaults when nothing is configured', () => {
    assert.equal(resolveSemanticTitleTimeoutMs(undefined), DEFAULT_SEMANTIC_TITLE_TIMEOUT_MS)
    assert.equal(resolveSemanticTitleTimeoutMs({}), DEFAULT_SEMANTIC_TITLE_TIMEOUT_MS)
  })

  it('reads a positive summarize.titleTimeoutMs override', () => {
    assert.equal(resolveSemanticTitleTimeoutMs({ summarize: { titleTimeoutMs: 3000 } }), 3000)
  })

  it('ignores a non-positive / non-numeric config value and uses the default', () => {
    assert.equal(resolveSemanticTitleTimeoutMs({ summarize: { titleTimeoutMs: 0 } }), DEFAULT_SEMANTIC_TITLE_TIMEOUT_MS)
    assert.equal(resolveSemanticTitleTimeoutMs({ summarize: { titleTimeoutMs: -5 } }), DEFAULT_SEMANTIC_TITLE_TIMEOUT_MS)
    assert.equal(resolveSemanticTitleTimeoutMs({ summarize: { titleTimeoutMs: 'nope' } }), DEFAULT_SEMANTIC_TITLE_TIMEOUT_MS)
  })

  it('lets the env override win over config', () => {
    process.env[ENV] = '5000'
    assert.equal(resolveSemanticTitleTimeoutMs({ summarize: { titleTimeoutMs: 3000 } }), 5000)
  })

  it('ignores an invalid env value and falls through', () => {
    process.env[ENV] = 'abc'
    assert.equal(resolveSemanticTitleTimeoutMs({ summarize: { titleTimeoutMs: 3000 } }), 3000)
    process.env[ENV] = '0'
    assert.equal(resolveSemanticTitleTimeoutMs({}), DEFAULT_SEMANTIC_TITLE_TIMEOUT_MS)
  })
})
