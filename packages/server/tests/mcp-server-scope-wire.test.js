/**
 * #7028 — the `mcp_servers` wire entry carries the config `scope` the server is
 * defined in, so a client's remove-confirm can target it.
 *
 * The wire vocabulary is the REMOVE/ADD one (`'user' | 'project'`,
 * `MCP_WRITE_SCOPES`), not the three-valued READ vocabulary
 * (`MCP_SERVER_SOURCE`): the point of the field is to be fed straight back into
 * `remove_mcp_server`, which is scope-exact. A server whose definition cannot
 * be removed through that path (`<cwd>/.mcp.json`) carries NO scope — absent,
 * never guessed.
 */
import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ClaudeByokSession } from '../src/byok-session.js'
import { MCPFleet } from '../src/byok-mcp-fleet.js'
import {
  MCP_SERVER_SOURCE,
  MCP_WRITE_SCOPES,
  mcpSourceToWriteScope,
} from '../src/byok-mcp-config.js'
import { ServerMcpServersSchema } from '@chroxy/protocol'

const __dirname = dirname(fileURLToPath(import.meta.url))
const MCP_STUB = join(__dirname, 'fixtures', 'mcp-stub.mjs')
const QUIET = { info() {}, warn() {}, error() {}, debug() {} }

describe('mcpSourceToWriteScope (#7028)', () => {
  it('maps each READ source onto the write scope that removes it, or undefined', () => {
    assert.equal(mcpSourceToWriteScope(MCP_SERVER_SOURCE.USER), 'user')
    // The READ side calls this "local"; the write side calls the same block 'project'.
    assert.equal(mcpSourceToWriteScope(MCP_SERVER_SOURCE.LOCAL), 'project')
    // .mcp.json is not a writable scope, so there is no scope a remove could name.
    assert.equal(mcpSourceToWriteScope(MCP_SERVER_SOURCE.PROJECT_MCP_JSON), undefined)
    assert.equal(mcpSourceToWriteScope(undefined), undefined)
    assert.equal(mcpSourceToWriteScope('something-else'), undefined)
  })

  it('only ever yields a value remove_mcp_server accepts', () => {
    for (const source of [...Object.values(MCP_SERVER_SOURCE), undefined, 'x']) {
      const scope = mcpSourceToWriteScope(source)
      assert.ok(scope === undefined || MCP_WRITE_SCOPES.includes(scope), `${source} -> ${scope}`)
    }
  })
})

describe('MCPFleet.getServerStatuses scope (#7028)', () => {
  const cfgs = [
    { name: 'u', command: 'a', args: [], env: {}, source: MCP_SERVER_SOURCE.USER },
    { name: 'l', command: 'a', args: [], env: {}, source: MCP_SERVER_SOURCE.LOCAL },
    { name: 'p', command: 'a', args: [], env: {}, source: MCP_SERVER_SOURCE.PROJECT_MCP_JSON },
    { name: 'n', command: 'a', args: [], env: {} },
  ]
  const expected = { u: 'user', l: 'project', p: undefined, n: undefined }

  function fleetFor(opts = {}) {
    const fleet = new MCPFleet(cfgs.map((c) => ({ ...c })), { log: QUIET, ...opts })
    fleet._clients = []
    return fleet
  }

  it('reports scope per entry on the connecting/connected branch, key absent when unknown', () => {
    const statuses = fleetFor().getServerStatuses()
    for (const s of statuses) {
      assert.equal(s.scope, expected[s.name], s.name)
      assert.equal('scope' in s, expected[s.name] !== undefined, `${s.name}: key present only when known`)
    }
  })

  it('reports scope on a parked (disabled) entry', () => {
    const fleet = fleetFor({ disabledServers: ['u', 'l', 'p', 'n'] })
    for (const s of fleet.getServerStatuses()) {
      assert.equal(s.status, 'disabled')
      assert.equal(s.scope, expected[s.name], s.name)
    }
  })

  it('reports scope on an oauth-required entry', () => {
    const fleet = fleetFor()
    fleet._clients = cfgs.map((c) => ({
      name: c.name, state: 'ready', needsAuthorization: true, authorizationUrl: 'https://as.example/a',
    }))
    for (const s of fleet.getServerStatuses()) {
      assert.equal(s.status, 'oauth-required')
      assert.equal(s.scope, expected[s.name], s.name)
    }
  })
})

describe('ClaudeByokSession mcp_servers scope (#7028)', () => {
  let tmpHome
  let projectCwd
  let originalHome
  let originalMcpTrustPath
  let originalApiKey
  const sandboxConfigDir = process.env.CHROXY_CONFIG_DIR

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-mcp-scope-'))
    projectCwd = realpathSync(mkdtempSync(join(tmpdir(), 'chroxy-mcp-scope-cwd-')))
    originalHome = process.env.HOME
    originalMcpTrustPath = process.env.CHROXY_MCP_TRUST_PATH
    originalApiKey = process.env.ANTHROPIC_API_KEY
    process.env.HOME = tmpHome
    process.env.CHROXY_CONFIG_DIR = join(tmpHome, '.chroxy')
    process.env.CHROXY_MCP_TRUST_PATH = join(tmpHome, 'mcp-trust.json')
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-fixture'
  })

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    process.env.CHROXY_CONFIG_DIR = sandboxConfigDir
    if (originalMcpTrustPath) process.env.CHROXY_MCP_TRUST_PATH = originalMcpTrustPath
    else delete process.env.CHROXY_MCP_TRUST_PATH
    if (originalApiKey) process.env.ANTHROPIC_API_KEY = originalApiKey
    else delete process.env.ANTHROPIC_API_KEY
    rmSync(tmpHome, { recursive: true, force: true })
    rmSync(projectCwd, { recursive: true, force: true })
  })

  const entry = (command = 'node') => ({ command, args: [], env: {} })

  function writeConfigs({ user = {}, local = {}, mcpJson = null } = {}) {
    const configPath = join(tmpHome, '.claude.json')
    writeFileSync(configPath, JSON.stringify({
      mcpServers: user,
      projects: { [projectCwd]: { mcpServers: local } },
    }))
    if (mcpJson) writeFileSync(join(projectCwd, '.mcp.json'), JSON.stringify({ mcpServers: mcpJson }))
    return configPath
  }

  function payloadOf(session) {
    const out = session._buildMcpServersPayload()
    return Object.fromEntries(out.map((s) => [s.name, s]))
  }

  it('reports the defining scope per entry, and none for a .mcp.json-defined server', () => {
    const mcpConfigPath = writeConfigs({
      user: { fromUser: entry() },
      local: { fromLocal: entry() },
      mcpJson: { fromRepo: entry() },
    })
    const session = new ClaudeByokSession({ cwd: projectCwd, mcpConfigPath })
    const byName = payloadOf(session)
    assert.equal(byName.fromUser.scope, 'user')
    assert.equal(byName.fromLocal.scope, 'project')
    assert.equal('scope' in byName.fromRepo, false, '.mcp.json is not removable, so no scope is claimed')
  })

  it('a server defined in BOTH scopes is reported once, with the scope of the definition in effect (project)', async () => {
    const mcpConfigPath = writeConfigs({
      user: { both: entry('user-cmd') },
      local: { both: entry('local-cmd') },
    })
    const session = new ClaudeByokSession({ cwd: projectCwd, mcpConfigPath })
    const out = session._buildMcpServersPayload().filter((s) => s.name === 'both')
    assert.equal(out.length, 1, 'one wire entry per name')
    assert.equal(out[0].scope, 'project', 'local/"project" outranks user — the same winner discovery spawns')
    assert.equal(session._mcpServerConfigs[0].command, 'local-cmd')
    // Removing with the reported scope removes ONLY the project definition: the
    // shadowed user definition stays on disk (#7028 review).
    const res = await session.removeMcpServer('both', out[0].scope)
    assert.equal(res.found, true, res.error)
    const onDisk = JSON.parse(readFileSync(mcpConfigPath, 'utf8'))
    assert.equal(onDisk.mcpServers?.both?.command, 'user-cmd', 'the user definition survives')
    const projectBlocks = Object.values(onDisk.projects || {})
    assert.equal(projectBlocks.some((b) => b?.mcpServers?.both), false, 'the project definition is gone')
  })

  it('every reported scope is accepted by removeMcpServer (found: true) — the field is a usable remove target', async () => {
    const mcpConfigPath = writeConfigs({
      user: { fromUser: entry() },
      local: { fromLocal: entry() },
    })
    const session = new ClaudeByokSession({ cwd: projectCwd, mcpConfigPath })
    for (const s of session._buildMcpServersPayload()) {
      assert.ok(s.scope, `${s.name} has a scope`)
      const res = await session.removeMcpServer(s.name, s.scope)
      assert.equal(res.ok, true, res.error)
      assert.equal(res.found, true, `${s.name} found in its reported scope ${s.scope}`)
    }
  })

  it('the emitted payload validates against the wire schema with scope intact', () => {
    const mcpConfigPath = writeConfigs({ user: { a: entry() }, local: { b: entry() } })
    const session = new ClaudeByokSession({ cwd: projectCwd, mcpConfigPath })
    const parsed = ServerMcpServersSchema.parse({ type: 'mcp_servers', servers: session._buildMcpServersPayload() })
    const byName = Object.fromEntries(parsed.servers.map((s) => [s.name, s.scope]))
    assert.deepEqual(byName, { a: 'user', b: 'project' })
  })

  for (const scope of ['user', 'project']) {
    it(`a live addMcpServer into ${scope} scope is emitted with scope '${scope}'`, async () => {
      const mcpConfigPath = writeConfigs({})
      const session = new ClaudeByokSession({ cwd: projectCwd, mcpConfigPath })
      session._permissions.on('permission_request', (data) => {
        session._permissions.respondToPermission(data.requestId, 'allow')
      })
      const emitted = []
      session.on('mcp_servers', (d) => emitted.push(d))
      try {
        await session.start()
        const res = await session.addMcpServer('stub', { command: process.execPath, args: [MCP_STUB], env: {} }, scope)
        assert.equal(res.ok, true, res.error)
        const last = emitted[emitted.length - 1]
        assert.equal(last.servers.find((s) => s.name === 'stub').scope, scope)
      } finally {
        await session.destroy()
      }
    })
  }
})
