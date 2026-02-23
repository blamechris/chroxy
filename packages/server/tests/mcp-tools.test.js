import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseMcpToolName, formatToolDisplay } from '../src/mcp-tools.js'

describe('parseMcpToolName', () => {
  it('returns null for built-in tools', () => {
    assert.equal(parseMcpToolName('Bash'), null)
    assert.equal(parseMcpToolName('Read'), null)
    assert.equal(parseMcpToolName('Edit'), null)
    assert.equal(parseMcpToolName('Write'), null)
    assert.equal(parseMcpToolName('Task'), null)
    assert.equal(parseMcpToolName('Glob'), null)
  })

  it('parses standard MCP tool names', () => {
    const result = parseMcpToolName('mcp__filesystem__read_file')
    assert.deepEqual(result, { serverName: 'filesystem', toolName: 'read_file' })
  })

  it('parses MCP tool with multi-word server name', () => {
    const result = parseMcpToolName('mcp__my-server__list_resources')
    assert.deepEqual(result, { serverName: 'my-server', toolName: 'list_resources' })
  })

  it('handles tool names with extra underscores', () => {
    const result = parseMcpToolName('mcp__github__create_pull_request')
    assert.deepEqual(result, { serverName: 'github', toolName: 'create_pull_request' })
  })

  it('returns null for empty or falsy input', () => {
    assert.equal(parseMcpToolName(''), null)
    assert.equal(parseMcpToolName(null), null)
    assert.equal(parseMcpToolName(undefined), null)
  })

  it('returns null for mcp__ prefix without proper separator', () => {
    assert.equal(parseMcpToolName('mcp__'), null)
    assert.equal(parseMcpToolName('mcp__server'), null)
  })

  it('returns null for mcp__ prefix with empty server name', () => {
    assert.equal(parseMcpToolName('mcp____tool'), null)
  })
})

describe('formatToolDisplay', () => {
  it('formats MCP tools as server:tool', () => {
    assert.equal(formatToolDisplay('mcp__filesystem__read_file'), 'filesystem:read_file')
  })

  it('returns built-in tools unchanged', () => {
    assert.equal(formatToolDisplay('Bash'), 'Bash')
    assert.equal(formatToolDisplay('Read'), 'Read')
  })

  it('handles falsy input', () => {
    assert.equal(formatToolDisplay(''), '')
    assert.equal(formatToolDisplay(null), null)
    assert.equal(formatToolDisplay(undefined), undefined)
  })
})
