import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MCPFleet, FLEET_KILL_GRACE_MS } from '../src/byok-mcp-fleet.js'
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
})
