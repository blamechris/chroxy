import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { spawn } from 'node:child_process'
import { EventEmitter } from 'node:events'
import { recordTimerArms, waitFor } from './test-helpers.js'
import { MCPClient, MCP_STATES, MCP_PROTOCOL_VERSION, MCP_CLIENT_VERSION, DEFAULT_HANDSHAKE_TIMEOUT_MS } from '../src/byok-mcp-client.js'

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

// Captured at module load, BEFORE any test installs a recordTimerArms() spy on
// global.setTimeout, so nextState()'s own ceiling is never recorded as one of the
// client's timers.
const realSetTimeout = setTimeout

// Wait for a state transition without arming a recorded timer. waitForState()
// arms through global.setTimeout, which a recordTimerArms() spy would record
// alongside the client's own timers. The ceiling is generous and REJECTS: the
// server suite runs with no --test-timeout, so a transition that never comes
// (e.g. a restart delay mutated to 600000ms) must print `not ok`, not hang.
function nextState(client, target, ceilingMs = 15_000) {
  return new Promise((resolve, reject) => {
    const timer = realSetTimeout(() => {
      client.off('state', onState)
      reject(new Error(`timeout waiting for state=${target}, got=${client.state}`))
    }, ceilingMs)
    function onState({ next }) {
      if (next !== target) return
      clearTimeout(timer)
      client.off('state', onState)
      resolve()
    }
    client.on('state', onState)
  })
}

// Bound a promise that only settles on a terminal client state (start() resolves
// on READY or DEAD). With no --test-timeout on this suite, a restart delay that
// regresses to minutes would otherwise HANG the run instead of failing it.
function withCeiling(promise, ceilingMs, label) {
  return new Promise((resolve, reject) => {
    const timer = realSetTimeout(() => reject(new Error(`timeout (${ceilingMs}ms) waiting for ${label}`)), ceilingMs)
    promise.then(
      (v) => { clearTimeout(timer); resolve(v) },
      (e) => { clearTimeout(timer); reject(e) },
    )
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

    it('per-instance opts.handshakeTimeoutMs overrides the default (#4454)', async (t) => {
      // The stub never replies to tools/list. A 200ms override on the
      // client should expire well before the 5s default, surfacing the
      // restart loop quickly. End-to-end success: client reaches DEAD via
      // the timeout → kill → restart → repeat path.
      const client = new MCPClient(
        stubConfig({ env: { MCP_STUB_TOOLS_LIST_HANG: '1' } }),
        { log: silentLog(), handshakeTimeoutMs: 200 },
      )
      // The override is what this test is about, so assert the value the client
      // resolved rather than how long the run took (#7041): an elapsed-time
      // ceiling only passes on a quiet machine, the resolved field does not.
      // Checked BEFORE start() so a wrong precedence fails here, not after a
      // 5s-per-handshake wait.
      assert.equal(client._handshakeTimeoutMs, 200)
      const arms = recordTimerArms(t)
      t.after(() => client.destroy()) // a failed wait must not leak a pending restart timer
      await withCeiling(client.start(), 20_000, 'DEAD after repeated handshake timeouts')
      // start() resolves on DEAD. We DID hit DEAD via handshake timeouts, not
      // via spawn-failure (the stub spawns fine and just never answers).
      assert.equal(client.state, MCP_STATES.DEAD)
      // ...and the 200ms override reached the wire: each handshake armed it.
      assert.ok(arms.some((a) => a.ms === 200 && a.fired), 'a 200ms handshake timer must have been armed and fired')
      await client.destroy()
    })

    it('per-config handshakeTimeoutMs overrides the default (#4454)', async (t) => {
      // Same shape as above but the override lives on `config` (the path
      // ~/.claude.json → byok-mcp-config will use).
      const cfg = { ...stubConfig({ env: { MCP_STUB_TOOLS_LIST_HANG: '1' } }), handshakeTimeoutMs: 200 }
      const client = new MCPClient(cfg, { log: silentLog() })
      assert.equal(client._handshakeTimeoutMs, 200, 'config.handshakeTimeoutMs must be the resolved value')
      const arms = recordTimerArms(t)
      t.after(() => client.destroy()) // a failed wait must not leak a pending restart timer
      await withCeiling(client.start(), 20_000, 'DEAD after repeated handshake timeouts')
      assert.equal(client.state, MCP_STATES.DEAD)
      assert.ok(arms.some((a) => a.ms === 200 && a.fired), 'a 200ms handshake timer must have been armed and fired')
      await client.destroy()
    })

    it('opts.handshakeTimeoutMs takes precedence over config.handshakeTimeoutMs (#4454)', async (t) => {
      // opts=200, config=60_000 — assert the resolved value so reversed
      // precedence fails immediately instead of hanging for a minute.
      const cfg = { ...stubConfig({ env: { MCP_STUB_TOOLS_LIST_HANG: '1' } }), handshakeTimeoutMs: 60_000 }
      const client = new MCPClient(cfg, { log: silentLog(), handshakeTimeoutMs: 200 })
      assert.equal(client._handshakeTimeoutMs, 200, 'opts override should have won over config')
      const arms = recordTimerArms(t)
      t.after(() => client.destroy()) // a failed wait must not leak a pending restart timer
      await withCeiling(client.start(), 20_000, 'DEAD after repeated handshake timeouts')
      assert.equal(client.state, MCP_STATES.DEAD)
      assert.ok(arms.some((a) => a.ms === 200 && a.fired), 'a 200ms handshake timer must have been armed and fired')
      assert.ok(!arms.some((a) => a.ms === 60_000), 'the losing 60s config value must never be armed')
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

    it('handshake-timeout path: initialize hang → DEAD with no leaked timers (#4454)', async (t) => {
      // Stub accepts the spawn but never replies to initialize. The client
      // must hit its handshake timeout, kill the child, restart, eventually
      // declare DEAD. Verifies the negative branch of _handshake() that the
      // existing tests never exercised. Use a short override so the test
      // doesn't add ~15s to the suite (3 × default 5s).
      const client = new MCPClient(
        stubConfig({ env: { MCP_STUB_INITIALIZE_HANG: '1' } }),
        { log: silentLog(), handshakeTimeoutMs: 200 },
      )
      t.after(() => client.destroy()) // a failed wait must not leak a pending restart timer
      await withCeiling(client.start(), 20_000, 'DEAD after repeated handshake timeouts')
      assert.equal(client.state, MCP_STATES.DEAD)
      assert.equal(client.tools.length, 0)
      // The restart timer should have been cleared (DEAD path never schedules
      // a follow-up). _pending must be empty (every request settled). Verify
      // no internal handles linger before destroy.
      assert.equal(client._restartTimer, null, 'restart timer should be cleared on DEAD')
      assert.equal(client._pending.size, 0, '_pending should be drained when child exits')
      await client.destroy()
    })

    it('handshake-timeout path: tools/list hang → DEAD (#4454)', async (t) => {
      // Same flow as initialize-hang but the timeout fires on the SECOND
      // handshake request (tools/list). Asserts the catch-around-handshake
      // path correctly kills the child after the partially-completed
      // initialize.
      const client = new MCPClient(
        stubConfig({ env: { MCP_STUB_TOOLS_LIST_HANG: '1' } }),
        { log: silentLog(), handshakeTimeoutMs: 200 },
      )
      t.after(() => client.destroy()) // a failed wait must not leak a pending restart timer
      await withCeiling(client.start(), 20_000, 'DEAD after repeated handshake timeouts')
      assert.equal(client.state, MCP_STATES.DEAD)
      assert.equal(client._restartTimer, null)
      assert.equal(client._pending.size, 0)
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
      // Wait on the CONDITION, not the clock (#7041): the stub echoes the params
      // to stderr as soon as it has read the request, and a fixed 200ms sleep
      // followed by SIGKILL destroyed that evidence whenever the runner was slow
      // to schedule the child. Poll for a COMPLETE echo line (newline-terminated,
      // so we never parse half a chunk) under a generous ceiling that still fails
      // loudly, and kill only afterwards.
      const echoed = /MCP_STUB_INITIALIZE_PARAMS=(.+)\n/
      try {
        await waitFor(() => echoed.test(stderr), { timeoutMs: 15_000, label: 'stub to echo initialize params on stderr' })
      } finally {
        child.kill('SIGKILL')
      }
      const match = stderr.match(echoed)
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

  describe('orphan responses (#4455)', () => {
    it('logs orphan JSON-RPC response at debug level', async () => {
      const debugs = []
      const log = { info: () => {}, warn: () => {}, debug: (m) => debugs.push(m), error: () => {} }
      const client = new MCPClient(
        stubConfig({ env: { MCP_STUB_EMIT_ORPHAN: '1' } }),
        { log },
      )
      await client.start()
      await waitForState(client, MCP_STATES.READY)
      // The stub emits an orphan response with id=999999 alongside the
      // real initialize reply. Give the buffer a tick to flush.
      await new Promise((r) => setTimeout(r, 100))
      const orphanLog = debugs.find((m) => /orphan JSON-RPC response/i.test(m))
      assert.ok(orphanLog, `expected an orphan-response debug log, got debugs=${JSON.stringify(debugs)}`)
      assert.match(orphanLog, /id=999999/, 'orphan log must name the unmatched id')
      assert.match(orphanLog, /shape=result/, 'orphan log must surface the response shape (result|error)')
      await client.destroy()
    })

    it('does NOT log on the happy path — no orphan, no notification', async () => {
      const debugs = []
      const log = { info: () => {}, warn: () => {}, debug: (m) => debugs.push(m), error: () => {} }
      const client = new MCPClient(stubConfig(), { log })
      await client.start()
      await waitForState(client, MCP_STATES.READY)
      await new Promise((r) => setTimeout(r, 100))
      const orphanLog = debugs.find((m) => /orphan JSON-RPC response/i.test(m))
      assert.equal(orphanLog, undefined, `unexpected orphan-response log on happy path: ${orphanLog}`)
      await client.destroy()
    })

    it('silently drops notifications (id == null) without an orphan log', async () => {
      const debugs = []
      const log = { info: () => {}, warn: () => {}, debug: (m) => debugs.push(m), error: () => {} }
      const client = new MCPClient(
        stubConfig({ env: { MCP_STUB_EMIT_NOTIFICATION: '1' } }),
        { log },
      )
      await client.start()
      await waitForState(client, MCP_STATES.READY)
      await new Promise((r) => setTimeout(r, 100))
      // Notifications are a normal part of the JSON-RPC protocol — they
      // must not surface as orphan responses (would be noise).
      const orphanLog = debugs.find((m) => /orphan JSON-RPC response/i.test(m))
      assert.equal(orphanLog, undefined, `notifications must not log as orphans, got: ${orphanLog}`)
      await client.destroy()
    })
  })

  describe('crash + restart', () => {
    it('arms the 1st restart attempt at 1s after child exit (#4453 — first-attempt timing unchanged)', async (t) => {
      const client = new MCPClient(
        stubConfig({ env: { MCP_STUB_DIE_AFTER_MS: '100' } }),
        { log: silentLog() },
      )
      // #7041: assert the delay the client ARMED, not the wall-clock gap between
      // two state events. The restart timer is the only timer armed while the
      // client is RESTARTING, so tagging by state isolates it from the handshake
      // and request timers.
      t.after(() => client.destroy()) // clears a pending restart timer even when an assertion throws
      const arms = recordTimerArms(t, { tag: () => client.state })
      await client.start()
      // First life: spawns, handshakes, reaches READY, then exits at ~100ms.
      // The client schedules a restart. Acceptance criterion: that restart is
      // armed at 1s and, when it fires, the second spawn (STARTING) follows.
      // #4453 added exponential backoff but the FIRST attempt's timing is
      // intentionally preserved at 1s so a fast-recovery flake doesn't regress;
      // subsequent attempts back off.
      const restarting = nextState(client, MCP_STATES.RESTARTING)
      const restarted = nextState(client, MCP_STATES.STARTING)
      restarted.catch(() => {}) // surfaced by the await below; no unhandled rejection if an earlier await throws first
      await waitForState(client, MCP_STATES.READY)
      await restarting
      await restarted
      const restartArms = arms.filter((a) => a.state === MCP_STATES.RESTARTING)
      assert.deepEqual(restartArms.map((a) => a.ms), [1000], 'the 1st restart must be armed once, at 1000ms')
      assert.equal(restartArms[0].fired, true, 'the armed restart timer is what led to the 2nd spawn')
    })

    it('arms the 2nd restart attempt at 2s after the 2nd failure (#4453 exponential backoff)', async (t) => {
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
      // #7041: assert the delays the client ARMED while RESTARTING (the restart
      // timer is the only timer armed in that state), not the wall-clock gap
      // between state events — that gap is what flaked on a loaded runner.
      const events = []
      client.on('state', ({ next }) => events.push(next))
      t.after(() => client.destroy())
      const arms = recordTimerArms(t, { tag: () => client.state })
      await withCeiling(client.start(), 20_000, 'DEAD after the 1/2/4 restart schedule')
      // start() resolves on DEAD. By then we should have observed:
      //   STARTING(1) → RESTARTING(1) → STARTING(2) → RESTARTING(2) →
      //   STARTING(3) → RESTARTING(3) ... → DEAD
      // so the 2nd backoff is the 2nd RESTARTING-armed timer under the 1/2/4
      // schedule, and its firing is what produced the 3rd STARTING.
      const restartArms = arms.filter((a) => a.state === MCP_STATES.RESTARTING)
      assert.ok(restartArms.length >= 2, `expected ≥2 restart timers, got ${restartArms.length} — events=${JSON.stringify(events)}`)
      assert.equal(restartArms[1].ms, 2000, '2nd backoff must be armed at 2000ms')
      assert.equal(restartArms[1].fired, true)
      assert.ok(events.filter((e) => e === MCP_STATES.STARTING).length >= 3, `expected ≥3 STARTINGs — events=${JSON.stringify(events)}`)
    })

    it('arms the 3rd restart attempt at 4s after the 3rd failure (#4453 exponential backoff)', async (t) => {
      // Same fixture as the 2nd-backoff test, but assert the 3rd gap to lock
      // in the full 1/2/4 schedule. Two tests rather than one combined check
      // so a regression in just one of the steps surfaces clearly.
      const client = new MCPClient(
        { name: 'bad', command: process.execPath, args: ['-e', 'process.exit(2)'], env: {} },
        { log: silentLog() },
      )
      const events = []
      client.on('state', ({ next }) => events.push(next))
      t.after(() => client.destroy())
      const arms = recordTimerArms(t, { tag: () => client.state })
      await withCeiling(client.start(), 20_000, 'DEAD after the 1/2/4 restart schedule')
      // After the 3rd RESTARTING, the client arms the 4s timer; when it fires the
      // 4th spawn exits and DEAD follows. Assert the full armed schedule, the
      // 3rd entry having fired, and that DEAD came after it (#7041: no gap
      // measured, so a slow runner cannot move the verdict).
      const restartArms = arms.filter((a) => a.state === MCP_STATES.RESTARTING)
      assert.deepEqual(restartArms.map((a) => a.ms), [1000, 2000, 4000], `full 1/2/4 schedule, events=${JSON.stringify(events)}`)
      assert.equal(restartArms[2].fired, true, 'the 4s timer fired — that is what led to the final exit')
      assert.ok(events.includes(MCP_STATES.DEAD), `expected DEAD transition, got events=${JSON.stringify(events)}`)
    })

    it('declares dead after MAX_RESTART_ATTEMPTS (3) consecutive failed restarts', async (t) => {
      // Use a bad command so spawn succeeds at exec(2) layer but child exits
      // immediately. Three failures + the new 1/2/4s backoff schedule tip
      // the total budget to ~7s, so the deadline is bumped from 8s to 10s
      // to give CI a comfortable margin (#4453).
      const client = new MCPClient(
        { name: 'bad', command: process.execPath, args: ['-e', 'process.exit(2)'], env: {} },
        { log: silentLog() },
      )
      t.after(() => client.destroy()) // a failing wait must not leak a pending restart timer
      await withCeiling(client.start(), 20_000, 'DEAD after the 1/2/4 restart schedule')
      await waitForState(client, MCP_STATES.DEAD, 10_000)
      assert.equal(client.state, MCP_STATES.DEAD)
      assert.equal(client.tools.length, 0)
      await client.destroy()
    })

    it('clears tools when entering DEAD state', async (t) => {
      const client = new MCPClient(stubConfig(), { log: silentLog() })
      t.after(() => client.destroy())
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

    it('destroy() while the trust gate is pending must not spawn a child (#7906)', async () => {
      let resolveGate
      const gate = new Promise((resolve) => { resolveGate = resolve })
      let spawned = false
      const client = new MCPClient(stubConfig(), {
        log: silentLog(),
        trustGate: () => gate,
      })
      // Hook spawn detection — the seam, not timing.
      const origSpawnAndHandshake = client._spawnAndHandshake.bind(client)
      client._spawnAndHandshake = (...a) => { spawned = true; return origSpawnAndHandshake(...a) }

      const startPromise = client.start()
      // start() is now suspended awaiting the trust gate. No child exists
      // yet, so destroy() takes the `!child` fast path and resolves
      // immediately (byok-mcp-client.js's destroy()).
      await client.destroy()
      assert.equal(client.state, MCP_STATES.DESTROYED)

      // Let the trust gate resolve — allowed=true — and let the suspended
      // start() resume.
      resolveGate(true)
      await startPromise

      assert.equal(spawned, false, 'a destroyed client must not spawn after the trust gate resolves')
      assert.equal(client._child, null, 'no child process handle was ever recorded')
      assert.equal(client.state, MCP_STATES.DESTROYED, 'destroy() owns the terminal state, not the resumed start()')
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

    it('SIGTERM then SIGKILL grace — escalates after KILL_GRACE_MS for a hung child', async (t) => {
      const client = new MCPClient(
        stubConfig({ env: { MCP_STUB_HANG: '1' } }),
        { log: silentLog() },
      )
      await client.start()
      await waitForState(client, MCP_STATES.READY)
      // #7041: record the signals the child receives, in order, and the grace
      // timer destroy() armed — instead of bounding destroy()'s wall-clock time
      // (a two-sided window that failed whenever the runner overshot it).
      const child = client._child
      const signals = []
      const realKill = child.kill.bind(child)
      child.kill = (sig) => { signals.push(sig); return realKill(sig) }
      const arms = recordTimerArms(t)
      await client.destroy()
      // SIGTERM is swallowed by the hung child, so only the escalation timer can
      // end it: SIGTERM first, SIGKILL second, the timer armed at 1000ms and fired.
      assert.deepEqual(signals, ['SIGTERM', 'SIGKILL'])
      const grace = arms.filter((a) => a.ms === 1000)
      assert.equal(grace.length, 1, 'destroy() arms exactly one 1000ms kill-grace timer')
      assert.equal(grace[0].fired, true, 'the grace timer fired — it is what delivered SIGKILL')
      assert.equal(child.signalCode, 'SIGKILL', 'the child ended by SIGKILL, not by SIGTERM')
    })

    it('destroy() while the handshake is in flight must not resurrect a destroyed client as READY (#7906)', async () => {
      // A fake but well-behaved child — real _onExit()/destroy() wiring,
      // no real subprocess/pipe involved (a real child's stdin can EPIPE
      // non-deterministically once SIGTERM lands, which is environmental
      // noise unrelated to the defect under test). The JSON-RPC seam
      // (_request) is hooked so the initialize/tools-list RESPONSES arrive
      // under test control — simulating a child whose already-buffered
      // reply is processed AFTER destroy() sends SIGTERM but BEFORE the
      // process has actually exited.
      const client = new MCPClient(stubConfig(), { log: silentLog() })
      const fakeChild = new EventEmitter()
      fakeChild.kill = () => { /* pretend SIGTERM was sent; exit fires later, explicitly, below */ }
      fakeChild.stdin = { writable: true, write: () => {} }
      client._child = fakeChild
      fakeChild.on('exit', (code, signal) => client._onExit(code, signal))
      client._setState(MCP_STATES.STARTING)

      let resolveInit, resolveTools
      let initCalled, toolsCalled
      const initCalledPromise = new Promise((resolve) => { initCalled = resolve })
      const toolsCalledPromise = new Promise((resolve) => { toolsCalled = resolve })
      client._request = (method) => {
        if (method === 'initialize') {
          initCalled()
          return new Promise((resolve) => { resolveInit = resolve })
        }
        if (method === 'tools/list') {
          toolsCalled()
          return new Promise((resolve) => { resolveTools = resolve })
        }
        return Promise.resolve({})
      }

      let readyEmitted = false
      client.on('ready', () => { readyEmitted = true })

      // Exactly what _spawnAndHandshake() does after spawning: fire the
      // handshake without awaiting it.
      const handshakeDone = client._handshake().catch(() => {})
      await initCalledPromise

      // destroy() lands while `initialize` is still pending. The fake
      // child hasn't "exited" yet (we fire that explicitly below), so
      // destroy() takes the kill-and-wait-for-exit branch, matching a real
      // child that hasn't actually terminated yet either.
      const destroyPromise = client.destroy()
      assert.notEqual(client.state, MCP_STATES.READY, 'must not be READY while destroy() is in flight')

      // The already-buffered `initialize` response arrives AFTER SIGTERM
      // but before the process has actually exited.
      resolveInit({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} })
      await toolsCalledPromise
      resolveTools({ tools: [{ name: 'evil-tool' }] })
      await handshakeDone

      assert.equal(readyEmitted, false, 'a destroyed client must not emit a stray ready event')
      assert.equal(client.state, MCP_STATES.STARTING, 'state must not regress to READY while the (still-alive) fake child has not exited yet')

      // Now the process actually exits (fires late, as a real SIGTERM
      // would) — _onExit forces the terminal DESTROYED transition.
      fakeChild.emit('exit', null, 'SIGTERM')
      await destroyPromise
      assert.equal(client.state, MCP_STATES.DESTROYED, 'destroy() owns the terminal state; a late-arriving handshake must not resurrect it as READY')
    })

    it('client.start() resolves (not hang) when destroy() lands mid-handshake (#7906)', async () => {
      // End-to-end acceptance for the wrapper fix in start(): a real child
      // is used here (unlike the test above) because the point is to prove
      // the PUBLIC start() promise settles via the real _spawnAndHandshake
      // -> _onExit machinery, not just that _handshake() itself behaves.
      const client = new MCPClient(stubConfig(), { log: silentLog() })
      let resolveInit
      const origRequest = client._request.bind(client)
      let initCalled
      const initCalledPromise = new Promise((resolve) => { initCalled = resolve })
      client._request = (method, params, timeoutMs) => {
        if (method === 'initialize') {
          initCalled()
          return new Promise((resolve) => { resolveInit = resolve })
        }
        return origRequest(method, params, timeoutMs)
      }

      const startPromise = client.start()
      await initCalledPromise
      const destroyPromise = client.destroy()
      // Release the handshake only after destroy() has been issued —
      // without the #7906 wrapper fix (adding DESTROYED to start()'s
      // state-settle listener), start() would hang here forever, since
      // this race never reaches READY/DEAD.
      resolveInit({ protocolVersion: MCP_PROTOCOL_VERSION, capabilities: {} })

      await Promise.all([startPromise, destroyPromise])
      assert.equal(client.state, MCP_STATES.DESTROYED)
    })

    it('spawned child stdin has an error listener so a write-race EPIPE does not crash the process (#7906)', async () => {
      // A write can race the child's actual death (destroy() sends SIGTERM,
      // but stdin.writable can still read true for a brief window before the
      // OS pipe fully tears down). A stream write failure surfaces as an
      // async 'error' event, not a catchable exception at the write() call
      // site — with zero listeners, Node's EventEmitter throws synchronously
      // on emit (generating an uncaught exception in real use, since nothing
      // is inside a try/catch when the real internal write machinery emits
      // it). Prove the listener _spawnAndHandshake() attaches is really
      // there — not just that the constructor ran without error — by
      // emitting 'error' directly on the real child's real stdin stream and
      // confirming it does not throw.
      const client = new MCPClient(stubConfig(), { log: silentLog() })
      try {
        await client.start()
        await waitForState(client, MCP_STATES.READY)
        const stdin = client._child.stdin
        assert.ok(stdin.listenerCount('error') > 0, 'the spawned child stdin must have at least one error listener attached')
        assert.doesNotThrow(
          () => stdin.emit('error', new Error('EPIPE (simulated write race)')),
          'an EPIPE-shaped stdin error must not propagate as an uncaught exception',
        )
      } finally {
        // Always tear the real spawned child down, even on assertion
        // failure — otherwise a red run here leaks a live stub process that
        // keeps the test file's event loop (and the whole suite run) alive.
        await client.destroy()
      }
    })
  })

  describe('_buildChildEnv secret stripping (#6311)', () => {
    it('strips the primary API_TOKEN from the MCP server child env', () => {
      const prev = process.env.API_TOKEN
      process.env.API_TOKEN = 'primary-bearer-token'
      try {
        const client = new MCPClient(stubConfig({ env: { MY_MCP_OPT: 'keep-me' } }), { log: silentLog() })
        const env = client._buildChildEnv()
        assert.equal(env.API_TOKEN, undefined,
          'the full-authority API_TOKEN must never reach an MCP server subprocess')
        assert.equal(env.MY_MCP_OPT, 'keep-me',
          'user-configured _config.env entries are still forwarded')
        assert.equal(env.PATH, process.env.PATH,
          'the operator process env still passes through (minus secrets)')
      } finally {
        if (prev === undefined) delete process.env.API_TOKEN
        else process.env.API_TOKEN = prev
      }
    })

    it('strips API_TOKEN even when _config.env tries to set it', () => {
      const prev = process.env.API_TOKEN
      delete process.env.API_TOKEN
      try {
        const client = new MCPClient(stubConfig({ env: { API_TOKEN: 'sneaky' } }), { log: silentLog() })
        const env = client._buildChildEnv()
        assert.equal(env.API_TOKEN, undefined,
          'a reserved chroxy secret name in _config.env is stripped, not honoured')
      } finally {
        if (prev === undefined) delete process.env.API_TOKEN
        else process.env.API_TOKEN = prev
      }
    })

    // #7360: an MCP server subprocess has no legitimate use for the daemon's
    // permission-hook secret (it is not a hook-consuming child), so any
    // CHROXY_PORT/CHROXY_HOOK_SECRET present is necessarily AMBIENTLY
    // inherited — e.g. this daemon was itself launched from inside another
    // chroxy session — and must be stripped. Ambient-proof regardless of the
    // shell running the suite.
    it('strips an ambiently-inherited CHROXY_PORT/CHROXY_HOOK_SECRET from the MCP server child env', () => {
      const prevPort = process.env.CHROXY_PORT
      const prevSecret = process.env.CHROXY_HOOK_SECRET
      process.env.CHROXY_PORT = '19999'
      process.env.CHROXY_HOOK_SECRET = 'ambient-foreign-session-secret'
      try {
        const client = new MCPClient(stubConfig({ env: { MY_MCP_OPT: 'keep-me' } }), { log: silentLog() })
        const env = client._buildChildEnv()
        assert.equal(env.CHROXY_PORT, undefined,
          'an ambiently-inherited CHROXY_PORT must not reach an MCP server subprocess')
        assert.equal(env.CHROXY_HOOK_SECRET, undefined,
          'an ambiently-inherited CHROXY_HOOK_SECRET must not reach an MCP server subprocess')
        assert.equal(env.MY_MCP_OPT, 'keep-me',
          'user-configured _config.env entries are still forwarded')
      } finally {
        if (prevPort === undefined) delete process.env.CHROXY_PORT
        else process.env.CHROXY_PORT = prevPort
        if (prevSecret === undefined) delete process.env.CHROXY_HOOK_SECRET
        else process.env.CHROXY_HOOK_SECRET = prevSecret
      }
    })
  })
})
