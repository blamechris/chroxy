import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MCPClient, MCP_STATES, DEFAULT_HANDSHAKE_TIMEOUT_MS } from '../src/byok-mcp-client.js'

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

    it('exposes DEFAULT_HANDSHAKE_TIMEOUT_MS for downstream tuning (#4454)', () => {
      assert.equal(typeof DEFAULT_HANDSHAKE_TIMEOUT_MS, 'number')
      assert.ok(DEFAULT_HANDSHAKE_TIMEOUT_MS > 0, 'default must be a positive ms count')
    })

    it('per-instance opts.handshakeTimeoutMs overrides the default (#4454)', async () => {
      // The stub never replies to tools/list. A 200ms override on the
      // client should expire well before the 5s default, surfacing the
      // restart loop quickly. End-to-end success: client reaches DEAD via
      // the timeout → kill → restart → repeat path.
      const client = new MCPClient(
        stubConfig({ env: { MCP_STUB_TOOLS_LIST_HANG: '1' } }),
        { log: silentLog(), handshakeTimeoutMs: 200 },
      )
      const t0 = Date.now()
      await client.start()
      // start() resolves on DEAD. Three handshakes × 200ms timeout + 3
      // restart backoffs + spawn overhead → comfortably under 12s for the
      // test deadline. The point is just that we DID hit DEAD via timeouts,
      // not via spawn-failure.
      assert.equal(client.state, MCP_STATES.DEAD)
      const elapsed = Date.now() - t0
      assert.ok(elapsed < 12_000, `DEAD took ${elapsed}ms, expected <12s`)
      await client.destroy()
    })

    it('per-config handshakeTimeoutMs overrides the default (#4454)', async () => {
      // Same shape as above but the override lives on `config` (the path
      // ~/.claude.json → byok-mcp-config will use).
      const cfg = { ...stubConfig({ env: { MCP_STUB_TOOLS_LIST_HANG: '1' } }), handshakeTimeoutMs: 200 }
      const client = new MCPClient(cfg, { log: silentLog() })
      const t0 = Date.now()
      await client.start()
      assert.equal(client.state, MCP_STATES.DEAD)
      const elapsed = Date.now() - t0
      assert.ok(elapsed < 12_000, `DEAD took ${elapsed}ms via config override, expected <12s`)
      await client.destroy()
    })

    it('opts.handshakeTimeoutMs takes precedence over config.handshakeTimeoutMs (#4454)', async () => {
      // opts=200, config=60_000 — if precedence is reversed we'd hang for
      // a minute. A successful 12s-bounded DEAD asserts opts won.
      const cfg = { ...stubConfig({ env: { MCP_STUB_TOOLS_LIST_HANG: '1' } }), handshakeTimeoutMs: 60_000 }
      const client = new MCPClient(cfg, { log: silentLog(), handshakeTimeoutMs: 200 })
      const t0 = Date.now()
      await client.start()
      assert.equal(client.state, MCP_STATES.DEAD)
      const elapsed = Date.now() - t0
      assert.ok(elapsed < 12_000, `DEAD took ${elapsed}ms, expected <12s — opts override should have won`)
      await client.destroy()
    })

    it('non-finite / non-positive timeouts fall back to the default (#4454)', () => {
      // Defensive guard: NaN, Infinity, 0, -1, strings — setTimeout coerces
      // those to 0ms and would make every handshake look broken. Verified
      // by reading the resolved field rather than running a handshake.
      for (const bogus of [NaN, Infinity, 0, -1, '5s', null, undefined]) {
        const client = new MCPClient(stubConfig(), { log: silentLog(), handshakeTimeoutMs: bogus })
        assert.equal(
          client._handshakeTimeoutMs,
          DEFAULT_HANDSHAKE_TIMEOUT_MS,
          `opts=${String(bogus)} should fall back to DEFAULT_HANDSHAKE_TIMEOUT_MS`,
        )
      }
    })

    it('handshake-timeout path: initialize hang → DEAD with no leaked timers (#4454)', async () => {
      // Stub accepts the spawn but never replies to initialize. The client
      // must hit its handshake timeout, kill the child, restart, eventually
      // declare DEAD. Verifies the negative branch of _handshake() that the
      // existing tests never exercised. Use a short override so the test
      // doesn't add ~15s to the suite (3 × default 5s).
      const client = new MCPClient(
        stubConfig({ env: { MCP_STUB_INITIALIZE_HANG: '1' } }),
        { log: silentLog(), handshakeTimeoutMs: 200 },
      )
      await client.start()
      assert.equal(client.state, MCP_STATES.DEAD)
      assert.equal(client.tools.length, 0)
      // The restart timer should have been cleared (DEAD path never schedules
      // a follow-up). _pending must be empty (every request settled). Verify
      // no internal handles linger before destroy.
      assert.equal(client._restartTimer, null, 'restart timer should be cleared on DEAD')
      assert.equal(client._pending.size, 0, '_pending should be drained when child exits')
      await client.destroy()
    })

    it('handshake-timeout path: tools/list hang → DEAD (#4454)', async () => {
      // Same flow as initialize-hang but the timeout fires on the SECOND
      // handshake request (tools/list). Asserts the catch-around-handshake
      // path correctly kills the child after the partially-completed
      // initialize.
      const client = new MCPClient(
        stubConfig({ env: { MCP_STUB_TOOLS_LIST_HANG: '1' } }),
        { log: silentLog(), handshakeTimeoutMs: 200 },
      )
      await client.start()
      assert.equal(client.state, MCP_STATES.DEAD)
      assert.equal(client._restartTimer, null)
      assert.equal(client._pending.size, 0)
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
