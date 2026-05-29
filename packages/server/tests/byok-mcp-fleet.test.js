import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MCPFleet, FLEET_KILL_GRACE_MS, parseMcpToolName } from '../src/byok-mcp-fleet.js'
import { MCP_STATES } from '../src/byok-mcp-client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STUB = join(__dirname, 'fixtures', 'mcp-stub.mjs')

function silentLog() {
  return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
}

function cfg(name, env = {}) {
  return { name, command: process.execPath, args: [STUB], env }
}

async function waitForReady(client, timeoutMs = 4000) {
  if (client.state === MCP_STATES.READY) return
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`timeout: ${client.name}`)), timeoutMs)
    client.on('state', ({ next }) => {
      if (next === MCP_STATES.READY) { clearTimeout(t); resolve() }
    })
  })
}

describe('MCPFleet', () => {
  it('aggregates tools from multiple ready servers with mcp__<server>__<tool> namespace', async () => {
    const tools = [{ name: 'echo', description: 'e', inputSchema: { type: 'object' } }]
    const fleet = new MCPFleet([
      cfg('alpha', { MCP_STUB_TOOLS: JSON.stringify(tools) }),
      cfg('beta', { MCP_STUB_TOOLS: JSON.stringify(tools) }),
    ], { log: silentLog() })
    await fleet.start()
    const names = fleet.tools.map((t) => t.name).sort()
    assert.deepEqual(names, ['mcp__alpha__echo', 'mcp__beta__echo'])
    await fleet.destroy()
  })

  it('excludes tools from dead servers', async () => {
    // alpha is healthy, broken always exits — broken should die after 3 attempts
    // and contribute zero tools. fleet.start() awaits each client's first
    // stable state, so by the time it returns alpha is READY and broken is
    // DEAD.
    const fleet = new MCPFleet([
      cfg('alpha'),
      { name: 'broken', command: process.execPath, args: ['-e', 'process.exit(2)'], env: {} },
    ], { log: silentLog() })
    await fleet.start()
    assert.equal(fleet.clients[0].state, MCP_STATES.READY)
    assert.equal(fleet.clients[1].state, MCP_STATES.DEAD)
    const names = fleet.tools.map((t) => t.name)
    assert.deepEqual(names, ['mcp__alpha__echo'])
    await fleet.destroy()
  })

  it('destroy() returns within FLEET_KILL_GRACE_MS + safety margin even with hung children', async () => {
    const fleet = new MCPFleet([
      cfg('hung1', { MCP_STUB_HANG: '1' }),
      cfg('hung2', { MCP_STUB_HANG: '1' }),
    ], { log: silentLog() })
    await fleet.start()
    await Promise.all(fleet.clients.map((c) => waitForReady(c)))
    const t0 = Date.now()
    await fleet.destroy()
    const elapsed = Date.now() - t0
    assert.ok(elapsed <= FLEET_KILL_GRACE_MS + 600, `destroy took ${elapsed}ms, expected <= ${FLEET_KILL_GRACE_MS + 600}ms`)
  })

  describe('trust gate (#4457)', () => {
    it('consults trust store first — trusted tuple spawns without prompting', async () => {
      const tmpStorePath = `/tmp/chroxy-mcp-trust-test-${process.pid}-${Date.now()}.json`
      const { recordTrust } = await import('../src/byok-mcp-trust.js')
      const server = { name: 'stub', command: process.execPath, args: [STUB], env: {} }
      recordTrust(server, tmpStorePath)
      let promptedCount = 0
      const fakePermissionManager = {
        requestMcpTrust: async () => { promptedCount += 1; return false },
      }
      const fleet = new MCPFleet([server], {
        log: silentLog(),
        permissionManager: fakePermissionManager,
        trustStorePath: tmpStorePath,
      })
      await fleet.start()
      assert.equal(fleet.clients[0].state, MCP_STATES.READY)
      assert.equal(promptedCount, 0, 'pre-trusted tuple must NOT prompt')
      await fleet.destroy()
      try { (await import('node:fs')).rmSync(tmpStorePath) } catch {}
    })

    it('prompts on untrusted tuple; deny → DEAD, no persistence', async () => {
      const tmpStorePath = `/tmp/chroxy-mcp-trust-test-${process.pid}-${Date.now()}-deny.json`
      const fs = await import('node:fs')
      const fakePermissionManager = { requestMcpTrust: async () => false }
      const fleet = new MCPFleet([cfg('untrusted')], {
        log: silentLog(),
        permissionManager: fakePermissionManager,
        trustStorePath: tmpStorePath,
      })
      await fleet.start()
      assert.equal(fleet.clients[0].state, MCP_STATES.DEAD)
      assert.equal(fs.existsSync(tmpStorePath), false, 'deny must not persist trust')
      await fleet.destroy()
    })

    it('prompts on untrusted tuple; allow → spawns + persists for next session', async () => {
      const tmpStorePath = `/tmp/chroxy-mcp-trust-test-${process.pid}-${Date.now()}-allow.json`
      const fs = await import('node:fs')
      const fakePermissionManager = { requestMcpTrust: async () => true }
      const fleet = new MCPFleet([cfg('newserver')], {
        log: silentLog(),
        permissionManager: fakePermissionManager,
        trustStorePath: tmpStorePath,
      })
      await fleet.start()
      assert.equal(fleet.clients[0].state, MCP_STATES.READY)
      assert.equal(fs.existsSync(tmpStorePath), true, 'allow must persist trust to disk')
      const raw = JSON.parse(fs.readFileSync(tmpStorePath, 'utf8'))
      assert.equal(raw.trustedTuples.length, 1)
      assert.equal(raw.trustedTuples[0].name, 'newserver')
      await fleet.destroy()
      try { fs.rmSync(tmpStorePath) } catch {}
    })

    it('no permissionManager → no trust gate, spawn behaves as in #4077', async () => {
      const fleet = new MCPFleet([cfg('alpha')], { log: silentLog() })
      await fleet.start()
      assert.equal(fleet.clients[0].state, MCP_STATES.READY)
      await fleet.destroy()
    })

    it('serialises concurrent trust prompts across fleet clients (#4460)', async () => {
      // Two untrusted servers in the same fleet start in parallel via
      // Promise.all (MCPFleet.start). Without the per-path lock, both
      // gates' loadTrustStore calls observe an empty store and both
      // call recordTrust — the second write reads stale state and
      // clobbers the first. With the lock, prompts surface one at a
      // time and both allow decisions persist to disk.
      const tmpStorePath = `/tmp/chroxy-mcp-trust-test-${process.pid}-${Date.now()}-serial.json`
      const fs = await import('node:fs')
      let activePrompts = 0
      let maxConcurrentPrompts = 0
      let totalPrompts = 0
      const fakePermissionManager = {
        requestMcpTrust: async () => {
          activePrompts += 1
          totalPrompts += 1
          if (activePrompts > maxConcurrentPrompts) maxConcurrentPrompts = activePrompts
          // Force a yield so a non-serialised implementation would let
          // the other gate's request enter concurrently.
          await new Promise((r) => setTimeout(r, 10))
          activePrompts -= 1
          return true
        },
      }
      const fleet = new MCPFleet(
        [cfg('one'), cfg('two')],
        { log: silentLog(), permissionManager: fakePermissionManager, trustStorePath: tmpStorePath },
      )
      try {
        await fleet.start()
        assert.equal(totalPrompts, 2, 'both untrusted servers must prompt')
        assert.equal(maxConcurrentPrompts, 1, 'prompts must surface one at a time')
        assert.equal(fleet.clients[0].state, MCP_STATES.READY)
        assert.equal(fleet.clients[1].state, MCP_STATES.READY)
        const raw = JSON.parse(fs.readFileSync(tmpStorePath, 'utf8'))
        assert.equal(raw.trustedTuples.length, 2, 'both allow decisions must persist (no lost-write)')
      } finally {
        await fleet.destroy()
        try { fs.rmSync(tmpStorePath) } catch {}
      }
    })
  })

  describe('callTool routing (#4079)', () => {
    it('parseMcpToolName strips the mcp__<server>__ prefix verbatim', () => {
      assert.deepEqual(parseMcpToolName('mcp__alpha__echo'), { serverName: 'alpha', toolName: 'echo' })
      assert.deepEqual(parseMcpToolName('mcp__alpha__nested__tool'), { serverName: 'alpha', toolName: 'nested__tool' })
      assert.equal(parseMcpToolName('Read'), null)
      assert.equal(parseMcpToolName('mcp__alpha'), null)
      assert.equal(parseMcpToolName(''), null)
      assert.equal(parseMcpToolName(null), null)
    })

    it('routes mcp__<server>__<tool> to the matching client', async () => {
      const fleet = new MCPFleet([cfg('alpha'), cfg('beta')], { log: silentLog() })
      await fleet.start()
      const result = await fleet.callTool('mcp__alpha__echo', { greeting: 'hello' })
      assert.equal(result.content[0].text, JSON.stringify({ greeting: 'hello' }))
      await fleet.destroy()
    })

    it('throws on unknown server name', async () => {
      const fleet = new MCPFleet([cfg('alpha')], { log: silentLog() })
      await fleet.start()
      await assert.rejects(fleet.callTool('mcp__ghost__echo', {}), /server not found/)
      await fleet.destroy()
    })

    it('throws on malformed tool name', async () => {
      const fleet = new MCPFleet([cfg('alpha')], { log: silentLog() })
      await fleet.start()
      await assert.rejects(fleet.callTool('Read', {}), /malformed/)
      await fleet.destroy()
    })

    it('throws when target server is not READY', async () => {
      const fleet = new MCPFleet([
        { name: 'broken', command: process.execPath, args: ['-e', 'process.exit(2)'], env: {} },
      ], { log: silentLog() })
      await fleet.start()
      await assert.rejects(fleet.callTool('mcp__broken__anything', {}), /not ready/)
      await fleet.destroy()
    })
  })

  describe('anthropicTools (#4078)', () => {
    it('renames inputSchema → input_schema and strips internal markers', async () => {
      const tools = [{ name: 'echo', description: 'e', inputSchema: { type: 'object', properties: { msg: { type: 'string' } } } }]
      const fleet = new MCPFleet([cfg('alpha', { MCP_STUB_TOOLS: JSON.stringify(tools) })], { log: silentLog() })
      await fleet.start()
      const anth = fleet.anthropicTools
      assert.equal(anth.length, 1)
      assert.equal(anth[0].name, 'mcp__alpha__echo')
      assert.equal(anth[0].description, 'e')
      assert.deepEqual(anth[0].input_schema, { type: 'object', properties: { msg: { type: 'string' } } })
      assert.equal(anth[0].inputSchema, undefined, 'inputSchema renamed away')
      assert.equal(anth[0]._mcpServer, undefined, 'internal marker stripped')
      assert.equal(anth[0]._mcpOriginalName, undefined, 'internal marker stripped')
      await fleet.destroy()
    })

    it('falls back to { type: object } when MCP server omits inputSchema', async () => {
      const tools = [{ name: 'no_schema', description: 'd' }]
      const fleet = new MCPFleet([cfg('alpha', { MCP_STUB_TOOLS: JSON.stringify(tools) })], { log: silentLog() })
      await fleet.start()
      assert.deepEqual(fleet.anthropicTools[0].input_schema, { type: 'object' })
      await fleet.destroy()
    })

    it('excludes anthropicTools from dead servers', async () => {
      const fleet = new MCPFleet([
        cfg('alpha'),
        { name: 'broken', command: process.execPath, args: ['-e', 'process.exit(2)'], env: {} },
      ], { log: silentLog() })
      await fleet.start()
      const names = fleet.anthropicTools.map((t) => t.name)
      assert.deepEqual(names, ['mcp__alpha__echo'])
      await fleet.destroy()
    })
  })
})
