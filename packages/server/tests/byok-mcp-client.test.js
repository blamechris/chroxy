import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MCPClient, MCP_STATES } from '../src/byok-mcp-client.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const STUB = join(__dirname, 'fixtures', 'mcp-stub.mjs')

function silentLog() {
  return { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }
}

function stubConfig({ name = 'stub', env = {} } = {}) {
  return { name, command: process.execPath, args: [STUB], env }
}

async function waitForState(client, target, timeoutMs = 4000) {
  if (client.state === target) return
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      cleanup()
      reject(new Error(`timeout waiting for state=${target}, got=${client.state}`))
    }, timeoutMs)
    const onState = ({ next }) => {
      if (next === target) {
        cleanup()
        resolve()
      }
    }
    function cleanup() {
      clearTimeout(t)
      client.off('state', onState)
    }
    client.on('state', onState)
  })
}

describe('MCPClient', () => {
  describe('handshake', () => {
    it('initializes, fetches tools/list, and reaches READY', async () => {
      const client = new MCPClient(stubConfig(), { log: silentLog() })
      await client.start()
      await waitForState(client, MCP_STATES.READY)
      assert.equal(client.state, MCP_STATES.READY)
      assert.equal(client.tools.length, 1)
      assert.equal(client.tools[0].name, 'echo')
      await client.destroy()
    })

    it('exposes server-supplied tools verbatim (test fixture override)', async () => {
      const customTools = [
        { name: 'one', description: 'first', inputSchema: { type: 'object' } },
        { name: 'two', description: 'second', inputSchema: { type: 'object' } },
      ]
      const client = new MCPClient(stubConfig({ env: { MCP_STUB_TOOLS: JSON.stringify(customTools) } }), { log: silentLog() })
      await client.start()
      await waitForState(client, MCP_STATES.READY)
      assert.deepEqual(client.tools.map((t) => t.name), ['one', 'two'])
      await client.destroy()
    })
  })

  describe('crash + restart', () => {
    it('triggers exactly 1 restart attempt within 1s after child exit (acceptance criterion)', async () => {
      const client = new MCPClient(
        stubConfig({ env: { MCP_STUB_DIE_AFTER_MS: '100' } }),
        { log: silentLog() },
      )
      await client.start()
      // First life: spawns, handshakes, reaches READY, then exits at ~100ms.
      // The client schedules a restart for ~1s later.  Acceptance criterion:
      // the *actual* restart attempt (second spawn → STARTING) happens within
      // ~1s of the death.  Measure between the death (RESTARTING entry) and
      // the next spawn (next STARTING entry).
      await waitForState(client, MCP_STATES.READY)
      await waitForState(client, MCP_STATES.RESTARTING, 2000)
      const t0 = Date.now()
      await waitForState(client, MCP_STATES.STARTING, 2000)
      const elapsed = Date.now() - t0
      assert.ok(elapsed >= 800 && elapsed <= 1500, `2nd spawn fired at ${elapsed}ms after RESTARTING, expected ~1000ms`)
      await client.destroy()
    })

    it('declares dead after MAX_RESTART_ATTEMPTS (3) consecutive failed restarts', async () => {
      // Use a bad command so spawn succeeds at exec(2) layer but child exits
      // immediately. Three rapid failures should trip the dead state.
      const client = new MCPClient(
        { name: 'bad', command: process.execPath, args: ['-e', 'process.exit(2)'], env: {} },
        { log: silentLog() },
      )
      await client.start()
      await waitForState(client, MCP_STATES.DEAD, 8000)
      assert.equal(client.state, MCP_STATES.DEAD)
      assert.equal(client.tools.length, 0)
      await client.destroy()
    })

    it('clears tools when entering DEAD state', async () => {
      const client = new MCPClient(stubConfig(), { log: silentLog() })
      await client.start()
      await waitForState(client, MCP_STATES.READY)
      assert.equal(client.tools.length, 1)
      // Force three exits in rapid succession by replacing the child with
      // an immediately-exiting child after each restart.
      client._config = { name: 'stub', command: process.execPath, args: ['-e', 'process.exit(1)'], env: {} }
      // Kill the live child to trigger the first restart on the new (bad) config.
      client._child.kill('SIGKILL')
      await waitForState(client, MCP_STATES.DEAD, 8000)
      assert.equal(client.tools.length, 0)
      await client.destroy()
    })
  })

  describe('trust gate (#4457)', () => {
    it('denies → state=DEAD with no child spawned', async () => {
      let spawned = false
      const client = new MCPClient(stubConfig(), {
        log: silentLog(),
        trustGate: async () => false,
      })
      // Hook spawn detection — child should never be created.
      const origSpawnAndHandshake = client._spawnAndHandshake.bind(client)
      client._spawnAndHandshake = (...a) => { spawned = true; return origSpawnAndHandshake(...a) }
      await client.start()
      assert.equal(client.state, MCP_STATES.DEAD)
      assert.equal(spawned, false, 'trust-denied client must not spawn')
      assert.equal(client.tools.length, 0)
      await client.destroy()
    })

    it('allows → spawns and reaches READY normally', async () => {
      const client = new MCPClient(stubConfig(), {
        log: silentLog(),
        trustGate: async () => true,
      })
      await client.start()
      assert.equal(client.state, MCP_STATES.READY)
      assert.equal(client.tools.length, 1)
      await client.destroy()
    })

    it('treats trust gate throw as deny (fail-closed)', async () => {
      const client = new MCPClient(stubConfig(), {
        log: silentLog(),
        trustGate: async () => { throw new Error('store unreadable') },
      })
      await client.start()
      assert.equal(client.state, MCP_STATES.DEAD)
      await client.destroy()
    })
  })

  describe('destroy()', () => {
    it('cancels a pending restart timer (no spawn after destroy)', async () => {
      const client = new MCPClient(
        stubConfig({ env: { MCP_STUB_DIE_AFTER_MS: '50' } }),
        { log: silentLog() },
      )
      await client.start()
      await waitForState(client, MCP_STATES.READY)
      await waitForState(client, MCP_STATES.RESTARTING, 2000)
      await client.destroy()
      // Wait past the restart timer; state should remain DESTROYED.
      await new Promise((r) => setTimeout(r, 1500))
      assert.equal(client.state, MCP_STATES.DESTROYED)
    })

    it('SIGTERM then SIGKILL grace — escalates within KILL_GRACE_MS for a hung child', async () => {
      const client = new MCPClient(
        stubConfig({ env: { MCP_STUB_HANG: '1' } }),
        { log: silentLog() },
      )
      await client.start()
      await waitForState(client, MCP_STATES.READY)
      const t0 = Date.now()
      await client.destroy()
      const elapsed = Date.now() - t0
      // SIGTERM is swallowed; SIGKILL fires at 1000ms; child exits ~immediately.
      assert.ok(elapsed >= 900 && elapsed <= 2000, `destroy took ${elapsed}ms, expected ~1000ms (SIGTERM grace before SIGKILL)`)
    })
  })
})
