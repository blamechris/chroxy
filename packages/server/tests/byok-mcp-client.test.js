import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { MCPClient, MCP_STATES, MCP_PROTOCOL_VERSION, MCP_CLIENT_VERSION } from '../src/byok-mcp-client.js'

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

    it('exposes MCP_PROTOCOL_VERSION + MCP_CLIENT_VERSION as module constants (#4452)', () => {
      assert.equal(typeof MCP_PROTOCOL_VERSION, 'string')
      assert.match(MCP_PROTOCOL_VERSION, /^\d{4}-\d{2}-\d{2}$/, 'protocol version must be an MCP spec date')
      assert.equal(typeof MCP_CLIENT_VERSION, 'string')
      assert.notEqual(MCP_CLIENT_VERSION, '1', 'clientInfo.version must derive from package.json, not the legacy "1" placeholder')
      assert.match(MCP_CLIENT_VERSION, /^\d+\.\d+\.\d+/, 'clientInfo.version must be semver from package.json')
    })

    it('sends MCP_PROTOCOL_VERSION + MCP_CLIENT_VERSION on the initialize wire (#4452)', async () => {
      // Spawn the stub directly + drive one initialize round-trip via raw
      // stdin/stdout JSON-RPC so we can assert on the wire shape via the
      // stderr-echoed params. Bypassing MCPClient lets us isolate the
      // initialize message before tools/list noise.
      const child = spawn(process.execPath, [STUB], {
        env: { ...process.env, MCP_STUB_ECHO_INITIALIZE: '1' },
        stdio: ['pipe', 'pipe', 'pipe'],
      })
      let stderr = ''
      child.stderr.on('data', (c) => { stderr += c.toString() })
      child.stdout.on('data', () => {})
      child.stdin.write(JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'initialize',
        params: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: {},
          clientInfo: { name: 'chroxy-byok', version: MCP_CLIENT_VERSION },
        },
      }) + '\n')
      await new Promise((r) => setTimeout(r, 200))
      child.kill('SIGKILL')
      const match = stderr.match(/MCP_STUB_INITIALIZE_PARAMS=(.+)/)
      assert.ok(match, `expected echoed initialize params on stderr, got: ${JSON.stringify(stderr)}`)
      const params = JSON.parse(match[1])
      assert.equal(params.protocolVersion, MCP_PROTOCOL_VERSION)
      assert.equal(params.clientInfo.name, 'chroxy-byok')
      assert.equal(params.clientInfo.version, MCP_CLIENT_VERSION)
    })

    it('warns when the server replies with a different protocolVersion (#4452)', async () => {
      const warns = []
      const log = { info: () => {}, warn: (m) => warns.push(m), debug: () => {}, error: () => {} }
      const client = new MCPClient(
        stubConfig({ env: { MCP_STUB_PROTOCOL_VERSION: '2099-01-01' } }),
        { log },
      )
      await client.start()
      await waitForState(client, MCP_STATES.READY)
      const protocolWarn = warns.find((m) => /protocolVersion/i.test(m))
      assert.ok(protocolWarn, `expected a protocolVersion mismatch warn, got: ${JSON.stringify(warns)}`)
      assert.match(protocolWarn, /2099-01-01/)
      assert.match(protocolWarn, new RegExp(MCP_PROTOCOL_VERSION))
      await client.destroy()
    })

    it('does NOT warn when the server reports the matching protocolVersion (#4452)', async () => {
      const warns = []
      const log = { info: () => {}, warn: (m) => warns.push(m), debug: () => {}, error: () => {} }
      const client = new MCPClient(stubConfig(), { log })
      await client.start()
      await waitForState(client, MCP_STATES.READY)
      const protocolWarn = warns.find((m) => /protocolVersion/i.test(m))
      assert.equal(protocolWarn, undefined, `unexpected protocolVersion warn: ${protocolWarn}`)
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

  describe('callTool (#4079)', () => {
    it('echoes args via JSON-RPC tools/call when READY', async () => {
      const client = new MCPClient(stubConfig(), { log: silentLog() })
      await client.start()
      await waitForState(client, MCP_STATES.READY)
      const result = await client.callTool('echo', { msg: 'hi' })
      assert.equal(result.isError, undefined)
      assert.equal(result.content[0].type, 'text')
      assert.equal(result.content[0].text, JSON.stringify({ msg: 'hi' }))
      await client.destroy()
    })

    it('throws when client is not READY', async () => {
      const client = new MCPClient(stubConfig(), { log: silentLog() })
      await assert.rejects(client.callTool('echo', {}), /not ready/)
      await client.destroy()
    })

    it('surfaces JSON-RPC errors from the server', async () => {
      const client = new MCPClient(
        stubConfig({ env: { MCP_STUB_TOOL_RPC_ERROR: '1' } }),
        { log: silentLog() },
      )
      await client.start()
      await waitForState(client, MCP_STATES.READY)
      await assert.rejects(client.callTool('echo', {}), /forced RPC error/)
      await client.destroy()
    })

    it('times out a hung tools/call', async () => {
      const client = new MCPClient(
        stubConfig({ env: { MCP_STUB_TOOL_HANG: '1' } }),
        { log: silentLog() },
      )
      await client.start()
      await waitForState(client, MCP_STATES.READY)
      await assert.rejects(client.callTool('echo', {}, 200), /timeout/)
      await client.destroy()
    })

    it('mid-call child crash rejects the pending call with "MCP child exited"', async () => {
      const client = new MCPClient(
        stubConfig({ env: { MCP_STUB_TOOL_DIE: '1' } }),
        { log: silentLog() },
      )
      await client.start()
      await waitForState(client, MCP_STATES.READY)
      await assert.rejects(client.callTool('echo', {}), /child exited/)
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
