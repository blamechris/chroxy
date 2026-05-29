import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  CLAUDE_CONFIG_MAX_BYTES,
  loadClaudeMcpConfig,
  parseClaudeMcpConfig,
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
