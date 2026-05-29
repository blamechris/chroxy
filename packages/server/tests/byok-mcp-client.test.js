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
    it('triggers the 1st restart attempt ~1s after child exit (#4453 — first-attempt timing unchanged)', async () => {
      const client = new MCPClient(
        stubConfig({ env: { MCP_STUB_DIE_AFTER_MS: '100' } }),
        { log: silentLog() },
      )
      await client.start()
      // First life: spawns, handshakes, reaches READY, then exits at ~100ms.
      // The client schedules a restart for ~1s later.  Acceptance criterion:
      // the *actual* restart attempt (second spawn → STARTING) happens within
      // ~1s of the death.  Measure between the death (RESTARTING entry) and
      // the next spawn (next STARTING entry). #4453 added exponential backoff
      // but the FIRST attempt's timing is intentionally preserved at 1s so a
      // fast-recovery flake doesn't regress; subsequent attempts back off.
      await waitForState(client, MCP_STATES.READY)
      await waitForState(client, MCP_STATES.RESTARTING, 2000)
      const t0 = Date.now()
      await waitForState(client, MCP_STATES.STARTING, 2000)
      const elapsed = Date.now() - t0
      assert.ok(elapsed >= 800 && elapsed <= 1500, `1st restart fired at ${elapsed}ms after RESTARTING, expected ~1000ms`)
      await client.destroy()
    })

    it('triggers the 2nd restart attempt ~2s after the 2nd failure (#4453 exponential backoff)', async () => {
      // Bad command so each spawn immediately exits — drives the restart loop
      // without depending on the stub fixture's handshake.
      const client = new MCPClient(
        { name: 'bad', command: process.execPath, args: ['-e', 'process.exit(2)'], env: {} },
        { log: silentLog() },
      )
      // Capture every state transition with a timestamp BEFORE start() so we
      // don't miss the first STARTING/RESTARTING (start() resolves only when
      // the client reaches a terminal state — READY or DEAD — so by the time
      // it returns the early transitions are already over).
      const events = []
      client.on('state', ({ next }) => events.push({ state: next, t: Date.now() }))
      await client.start()
      // start() resolves on DEAD. By then we should have observed:
      //   STARTING(1) → RESTARTING(1) → STARTING(2) → RESTARTING(2) →
      //   STARTING(3) → RESTARTING(3) ... → DEAD
      // Pick the 2nd RESTARTING and the 3rd STARTING — the gap is the
      // 2nd backoff delay under the 1/2/4 schedule.
      const restarts = events.filter((e) => e.state === MCP_STATES.RESTARTING)
      const starts = events.filter((e) => e.state === MCP_STATES.STARTING)
      assert.ok(restarts.length >= 2, `expected ≥2 RESTARTINGs, got ${restarts.length} — events=${JSON.stringify(events)}`)
      assert.ok(starts.length >= 3, `expected ≥3 STARTINGs, got ${starts.length} — events=${JSON.stringify(events)}`)
      const secondGap = starts[2].t - restarts[1].t
      assert.ok(
        secondGap >= 1700 && secondGap <= 2500,
        `2nd backoff fired at ${secondGap}ms after RESTARTING#2, expected ~2000ms`,
      )
      await client.destroy()
    })

    it('triggers the 3rd restart attempt ~4s after the 3rd failure (#4453 exponential backoff)', async () => {
      // Same fixture as the 2nd-backoff test, but assert the 3rd gap to lock
      // in the full 1/2/4 schedule. Two tests rather than one combined check
      // so a regression in just one of the steps surfaces clearly.
      const client = new MCPClient(
        { name: 'bad', command: process.execPath, args: ['-e', 'process.exit(2)'], env: {} },
        { log: silentLog() },
      )
      const events = []
      client.on('state', ({ next }) => events.push({ state: next, t: Date.now() }))
      await client.start()
      const restarts = events.filter((e) => e.state === MCP_STATES.RESTARTING)
      assert.ok(restarts.length >= 3, `expected ≥3 RESTARTINGs, got ${restarts.length}`)
      // After the 3rd RESTARTING, the client schedules a 4s timer then DEAD
      // fires on the next exit. We can't observe a 4th STARTING (the loop
      // stops there), so measure RESTARTING(3) → DEAD instead, which is
      // backoff(3) + spawn(~50ms exit) ≈ ~4050ms.
      const deadEvent = events.find((e) => e.state === MCP_STATES.DEAD)
      assert.ok(deadEvent, `expected DEAD transition, got events=${JSON.stringify(events)}`)
      const thirdGap = deadEvent.t - restarts[2].t
      assert.ok(
        thirdGap >= 3700 && thirdGap <= 4800,
        `3rd backoff + final exit took ${thirdGap}ms after RESTARTING#3, expected ~4050ms`,
      )
      await client.destroy()
    })

    it('declares dead after MAX_RESTART_ATTEMPTS (3) consecutive failed restarts', async () => {
      // Use a bad command so spawn succeeds at exec(2) layer but child exits
      // immediately. Three failures + the new 1/2/4s backoff schedule tip
      // the total budget to ~7s, so the deadline is bumped from 8s to 10s
      // to give CI a comfortable margin (#4453).
      const client = new MCPClient(
        { name: 'bad', command: process.execPath, args: ['-e', 'process.exit(2)'], env: {} },
        { log: silentLog() },
      )
      await client.start()
      await waitForState(client, MCP_STATES.DEAD, 10_000)
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
      // an immediately-exiting child after each restart. #4453's 1/2/4s
      // backoff makes this take up to ~7s — bump deadline to 10s.
      client._config = { name: 'stub', command: process.execPath, args: ['-e', 'process.exit(1)'], env: {} }
      // Kill the live child to trigger the first restart on the new (bad) config.
      client._child.kill('SIGKILL')
      await waitForState(client, MCP_STATES.DEAD, 10_000)
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
