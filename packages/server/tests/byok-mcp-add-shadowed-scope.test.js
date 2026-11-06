/**
 * #7962: adding an MCP server whose name already resolves from a
 * higher-precedence scope (Local > .mcp.json > User) must be refused with an
 * error that names the winning scope, and must write nothing.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, realpathSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { addMcpServerToConfig, planAddMcpServerToConfig } from '../src/byok-mcp-config.js'

let dir
let cwd
let configPath

beforeEach(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-mcp-shadow-')))
  cwd = join(dir, 'repo')
  mkdirSync(cwd, { recursive: true })
  configPath = join(dir, '.claude.json')
})

afterEach(() => {
  try { rmSync(dir, { recursive: true, force: true }) } catch { /* best effort */ }
})

const writeConfig = (obj) => writeFileSync(configPath, JSON.stringify(obj))
const writeMcpJson = (obj) => writeFileSync(join(cwd, '.mcp.json'), JSON.stringify(obj))

const add = (scope, name = 'foo') =>
  addMcpServerToConfig({ name, config: { command: 'node' }, scope, cwd, configPath })

describe('#7962 add into a scope shadowed by a higher-precedence one', () => {
  it('user add is refused when Local scope already defines the name', () => {
    writeConfig({ projects: { [cwd]: { mcpServers: { foo: { command: 'local' } } } } })
    const before = readFileSync(configPath, 'utf8')
    const res = add('user')
    assert.equal(res.ok, false)
    assert.equal(res.code, 'EXISTS')
    assert.ok(/local scope/.test(res.error), res.error)
    assert.equal(readFileSync(configPath, 'utf8'), before, 'nothing may be written')
  })

  it('user add is refused when .mcp.json already defines the name', () => {
    writeMcpJson({ mcpServers: { foo: { command: 'repo' } } })
    writeConfig({})
    const res = add('user')
    assert.equal(res.ok, false)
    assert.equal(res.code, 'EXISTS')
    assert.ok(/\.mcp\.json/.test(res.error), res.error)
    assert.equal(JSON.parse(readFileSync(configPath, 'utf8')).mcpServers, undefined)
  })

  it('the dry-run plan refuses too, so no trust prompt precedes a doomed add', () => {
    writeMcpJson({ mcpServers: { foo: { command: 'repo' } } })
    writeConfig({})
    const res = planAddMcpServerToConfig({ name: 'foo', config: { command: 'node' }, scope: 'user', cwd, configPath })
    assert.equal(res.ok, false)
    assert.equal(res.code, 'EXISTS')
  })

  it('local (project) add is NOT blocked by .mcp.json or user scope (it outranks them)', () => {
    writeMcpJson({ mcpServers: { foo: { command: 'repo' } } })
    writeConfig({ mcpServers: { foo: { command: 'user' } } })
    assert.equal(add('project').ok, true)
  })

  it('user add succeeds when the name is unique to user scope', () => {
    writeMcpJson({ mcpServers: { other: { command: 'repo' } } })
    writeConfig({})
    assert.equal(add('user').ok, true)
  })
})
