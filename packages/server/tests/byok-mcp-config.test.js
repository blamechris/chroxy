import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_CONFIG_MAX_BYTES,
  discoverConfiguredMcpServers,
  isBlockedMetadataHost,
  loadClaudeMcpConfig,
  parseClaudeMcpConfig,
  redactMcpUrl,
  toMcpServerMetadata,
} from '../src/byok-mcp-config.js'

describe('byok-mcp-config', () => {
  let dir

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), 'chroxy-byok-mcp-config-'))
  })

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true })
  })

  it('parses one Claude-style MCP server entry', () => {
    const parsed = parseClaudeMcpConfig({
      mcpServers: {
        filesystem: {
          command: 'npx',
          args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/project'],
          env: { API_TOKEN: 'secret', COUNT: 12 },
        },
      },
    })
    assert.equal(parsed.warnings.length, 1)
    assert.match(parsed.warnings[0], /filesystem/)
    assert.match(parsed.warnings[0], /env\.COUNT/)
    assert.match(parsed.warnings[0], /number/)
    assert.deepEqual(parsed.servers, [
      {
        name: 'filesystem',
        command: 'npx',
        args: ['-y', '@modelcontextprotocol/server-filesystem', '/tmp/project'],
        env: { API_TOKEN: 'secret' },
      },
    ])
  })

  it('warns on non-string args entries naming the index and type', () => {
    const parsed = parseClaudeMcpConfig({
      mcpServers: {
        github: {
          command: 'node',
          args: ['server.js', 42, null, '--flag'],
        },
      },
    })
    assert.deepEqual(parsed.servers, [
      { name: 'github', command: 'node', args: ['server.js', '--flag'], env: {} },
    ])
    assert.equal(parsed.warnings.length, 2)
    assert.match(parsed.warnings[0], /github/)
    assert.match(parsed.warnings[0], /args\[1\]/)
    assert.match(parsed.warnings[0], /number/)
    assert.match(parsed.warnings[1], /github/)
    assert.match(parsed.warnings[1], /args\[2\]/)
    assert.match(parsed.warnings[1], /object/)
  })

  it('parses multiple servers and skips malformed entries with warnings', () => {
    const parsed = parseClaudeMcpConfig({
      mcpServers: {
        github: { command: 'node', args: ['server.js'] },
        broken: { args: ['missing-command'] },
        alsoBroken: null,
      },
    })
    assert.deepEqual(parsed.servers.map((s) => s.name), ['github'])
    assert.equal(parsed.warnings.length, 2)
    assert.match(parsed.warnings[0], /broken: command is required/)
    assert.match(parsed.warnings[1], /alsoBroken: entry must be an object/)
  })

  it('returns empty config for missing files', () => {
    const loaded = loadClaudeMcpConfig(join(dir, 'does-not-exist.json'))
    assert.equal(loaded.missing, true)
    assert.deepEqual(loaded.servers, [])
    assert.deepEqual(loaded.warnings, [])
  })

  it('returns a warning and no servers for malformed JSON', () => {
    const path = join(dir, '.claude.json')
    writeFileSync(path, '{ not json')
    const loaded = loadClaudeMcpConfig(path)
    assert.equal(loaded.missing, false)
    assert.deepEqual(loaded.servers, [])
    assert.equal(loaded.warnings.length, 1)
    assert.match(loaded.warnings[0], /Failed to parse MCP config/)
  })

  it('bails out with a warning when the config file exceeds the size cap', () => {
    const path = join(dir, '.claude.json')
    // Write a JSON-shaped payload just over the size cap; content shape does not
    // matter because the loader must bail before parsing.
    const padding = ' '.repeat(CLAUDE_CONFIG_MAX_BYTES + 1)
    writeFileSync(path, `{"mcpServers":{}}${padding}`)
    const loaded = loadClaudeMcpConfig(path)
    assert.equal(loaded.missing, false)
    assert.deepEqual(loaded.servers, [])
    assert.equal(loaded.warnings.length, 1)
    assert.match(loaded.warnings[0], /exceeds size cap/)
    assert.match(loaded.warnings[0], new RegExp(path.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')))
  })

  it('metadata redacts env values but keeps env keys', () => {
    const metadata = toMcpServerMetadata({
      name: 'github',
      command: 'node',
      args: ['server.js'],
      env: { Z_TOKEN: 'secret-z', A_TOKEN: 'secret-a' },
    })
    assert.deepEqual(metadata, {
      name: 'github',
      command: 'node',
      args: ['server.js'],
      envKeys: ['A_TOKEN', 'Z_TOKEN'],
    })
  })
})

// #6821 — remote (streamable-HTTP / SSE) transport parsing. A remote server
// carries a url/type instead of a command; the parser must keep it (not drop
// it as pre-#6821 did) while leaving stdio entries byte-identical.
describe('byok-mcp-config remote transport (#6821)', () => {
  it('parses an explicit http remote server with headers', () => {
    const parsed = parseClaudeMcpConfig({
      mcpServers: {
        remote: {
          type: 'http',
          url: 'https://mcp.example.com/api',
          headers: { Authorization: 'Bearer tok', COUNT: 7 },
        },
      },
    })
    assert.deepEqual(parsed.servers, [
      { name: 'remote', type: 'http', url: 'https://mcp.example.com/api', headers: { Authorization: 'Bearer tok' } },
    ])
    // The non-string header value is dropped with a naming-only warning.
    assert.equal(parsed.warnings.length, 1)
    assert.match(parsed.warnings[0], /headers\.COUNT/)
    assert.ok(!parsed.warnings[0].includes('Bearer'), 'header value must never appear in a warning')
  })

  it('normalizes streamable-http and infers a remote entry from a bare url', () => {
    const parsed = parseClaudeMcpConfig({
      mcpServers: {
        a: { type: 'streamable-http', url: 'https://a/mcp' },
        b: { url: 'https://b/mcp' }, // no command, no type → inferred remote
      },
    })
    assert.deepEqual(parsed.servers, [
      { name: 'a', type: 'http', url: 'https://a/mcp', headers: {} },
      { name: 'b', type: 'http', url: 'https://b/mcp', headers: {} },
    ])
  })

  it('parses an sse remote server (legacy transport)', () => {
    const parsed = parseClaudeMcpConfig({
      mcpServers: { s: { type: 'sse', url: 'https://s/sse' } },
    })
    assert.deepEqual(parsed.servers, [{ name: 's', type: 'sse', url: 'https://s/sse', headers: {} }])
  })

  it('rejects a non-http(s) url and a missing url with warnings, keeps siblings', () => {
    const parsed = parseClaudeMcpConfig({
      mcpServers: {
        good: { type: 'http', url: 'https://good/mcp' },
        badproto: { type: 'http', url: 'file:///etc/passwd' },
        nourl: { type: 'http' },
        stdio: { command: 'node', args: ['x.js'] },
      },
    })
    assert.deepEqual(parsed.servers.map((s) => s.name), ['good', 'stdio'])
    assert.ok(parsed.warnings.some((w) => /badproto.*http/.test(w)))
    assert.ok(parsed.warnings.some((w) => /nourl.*url is required/.test(w)))
    // stdio entry keeps its exact legacy shape.
    assert.deepEqual(parsed.servers.find((s) => s.name === 'stdio'), {
      name: 'stdio', command: 'node', args: ['x.js'], env: {},
    })
  })

  it('toMcpServerMetadata redacts remote url credentials + exposes header keys only', () => {
    const metadata = toMcpServerMetadata({
      name: 'remote',
      type: 'http',
      url: 'https://user:pass@mcp.example.com/api?token=abc#frag',
      headers: { Authorization: 'Bearer secret', 'X-Api-Key': 'k' },
    })
    assert.deepEqual(metadata, {
      name: 'remote',
      type: 'http',
      url: 'https://mcp.example.com/api',
      headerKeys: ['Authorization', 'X-Api-Key'],
    })
    const s = JSON.stringify(metadata)
    assert.ok(!s.includes('secret') && !s.includes('pass') && !s.includes('token=abc'),
      'no credential (header value, url userinfo, or query token) may survive into metadata')
  })

  it('redactMcpUrl strips userinfo, query, and fragment', () => {
    assert.equal(redactMcpUrl('https://u:p@h.example/path?k=v#x'), 'https://h.example/path')
    assert.equal(redactMcpUrl('not a url'), '[unparseable url]')
    assert.equal(redactMcpUrl(''), '')
  })

  // #6834 sharp edge, folded pre-merge: cloud-metadata / link-local block.
  it('rejects a cloud-metadata url at parse time (169.254.169.254), keeps siblings', () => {
    const parsed = parseClaudeMcpConfig({
      mcpServers: {
        imds: { type: 'http', url: 'http://169.254.169.254/latest/meta-data' },
        good: { type: 'http', url: 'https://good/mcp' },
      },
    })
    assert.deepEqual(parsed.servers.map((s) => s.name), ['good'])
    assert.ok(parsed.warnings.some((w) => /imds.*metadata|imds.*link-local/i.test(w)),
      `expected a metadata-block warning for imds, got: ${JSON.stringify(parsed.warnings)}`)
  })

  it('isBlockedMetadataHost catches the metadata endpoint + host-encoding tricks, allows normal + loopback', () => {
    // Blocked: link-local range incl. hex/decimal host tricks (URL parser canonicalizes) + IMDSv6.
    for (const h of ['169.254.169.254', '169.254.1.2', '[fd00:ec2::254]', 'fd00:ec2::254', '[::ffff:169.254.169.254]']) {
      assert.equal(isBlockedMetadataHost(h), true, `${h} must be blocked`)
    }
    for (const trick of ['http://0xa9fea9fe/', 'http://2852039166/']) {
      assert.equal(isBlockedMetadataHost(new URL(trick).hostname), true, `${trick} must canonicalize to a blocked host`)
    }
    // Allowed: NOT blocked here — loopback + RFC1918 stay legitimate (that policy is #6834).
    for (const h of ['127.0.0.1', 'localhost', '10.0.0.5', '192.168.1.10', 'mcp.example.com', '169.253.0.1', '170.254.0.1']) {
      assert.equal(isBlockedMetadataHost(h), false, `${h} must NOT be blocked by the metadata rule`)
    }
  })
})

// #6820 — configured-server discovery used by the claude-tui provider for MCP
// visibility parity. Merges the three sources Claude Code reads (global +
// project-scoped block + project-local .mcp.json), deduped by name.
describe('discoverConfiguredMcpServers (#6820)', () => {
  let cfgDir
  let cwd
  let configPath

  beforeEach(() => {
    cfgDir = mkdtempSync(join(tmpdir(), 'chroxy-mcp-discover-cfg-'))
    cwd = mkdtempSync(join(tmpdir(), 'chroxy-mcp-discover-cwd-'))
    configPath = join(cfgDir, 'claude.json')
  })

  afterEach(() => {
    rmSync(cfgDir, { recursive: true, force: true })
    rmSync(cwd, { recursive: true, force: true })
  })

  it('returns empty (no warnings) when nothing is configured', () => {
    const res = discoverConfiguredMcpServers(cwd, { configPath })
    assert.deepEqual(res.servers, [])
    assert.deepEqual(res.warnings, [])
  })

  it('reads global (user-scope) mcpServers from ~/.claude.json', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { fs: { command: 'npx' }, gh: { command: 'node' } } }),
    )
    const res = discoverConfiguredMcpServers(cwd, { configPath })
    assert.deepEqual(res.servers, [{ name: 'fs' }, { name: 'gh' }])
    assert.deepEqual(res.warnings, [])
  })

  it('includes remote/HTTP servers declared with url/type instead of command', () => {
    // parseClaudeMcpConfig would drop these (no command); visibility keeps them.
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { remote: { type: 'http', url: 'https://example/mcp' } } }),
    )
    const res = discoverConfiguredMcpServers(cwd, { configPath })
    assert.deepEqual(res.servers, [{ name: 'remote' }])
    assert.deepEqual(res.warnings, [])
  })

  it('merges the project-scoped block (projects[realpath(cwd)].mcpServers)', () => {
    const realCwd = realpathSync(cwd)
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { global1: { command: 'npx' } },
        projects: { [realCwd]: { mcpServers: { proj1: { command: 'node' } } } },
      }),
    )
    const res = discoverConfiguredMcpServers(cwd, { configPath })
    assert.deepEqual(res.servers, [{ name: 'global1' }, { name: 'proj1' }])
  })

  it('merges project-local .mcp.json under cwd', () => {
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { local1: { command: 'node' } } }),
    )
    const res = discoverConfiguredMcpServers(cwd, { configPath })
    assert.deepEqual(res.servers, [{ name: 'local1' }])
  })

  it('dedupes by name across all sources (first source wins)', () => {
    const realCwd = realpathSync(cwd)
    writeFileSync(
      configPath,
      JSON.stringify({
        mcpServers: { shared: { command: 'npx' } },
        projects: {
          [realCwd]: { mcpServers: { shared: { command: 'other' }, projonly: { command: 'node' } } },
        },
      }),
    )
    writeFileSync(
      join(cwd, '.mcp.json'),
      JSON.stringify({ mcpServers: { shared: { command: 'z' }, localonly: { command: 'y' } } }),
    )
    const res = discoverConfiguredMcpServers(cwd, { configPath })
    assert.deepEqual(res.servers, [{ name: 'shared' }, { name: 'projonly' }, { name: 'localonly' }])
  })

  it('never throws on corrupt JSON — accumulates a warning, returns empty', () => {
    writeFileSync(configPath, '{ not valid json')
    const res = discoverConfiguredMcpServers(cwd, { configPath })
    assert.deepEqual(res.servers, [])
    assert.equal(res.warnings.length, 1)
    assert.match(res.warnings[0], /failed to read/)
  })

  it('warns and skips a malformed entry but keeps the valid siblings', () => {
    writeFileSync(
      configPath,
      JSON.stringify({ mcpServers: { good: { command: 'npx' }, bad: 'not-an-object' } }),
    )
    const res = discoverConfiguredMcpServers(cwd, { configPath })
    assert.deepEqual(res.servers, [{ name: 'good' }])
    assert.equal(res.warnings.length, 1)
    assert.match(res.warnings[0], /bad/)
  })
})
