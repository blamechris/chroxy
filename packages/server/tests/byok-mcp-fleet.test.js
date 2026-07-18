import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { MCPFleet, FLEET_KILL_GRACE_MS, DEFAULT_FLEET_START_CAP_MS, parseMcpToolName } from '../src/byok-mcp-fleet.js'
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
    // and contribute zero tools. Use a large startCapMs override (#4456) so
    // fleet.start() waits the full restart budget — keeps this test asserting
    // the "DEAD by start()" invariant without depending on the new wall-clock
    // cap (which would return early and leave broken in RESTARTING).
    const fleet = new MCPFleet([
      cfg('alpha'),
      { name: 'broken', command: process.execPath, args: ['-e', 'process.exit(2)'], env: {} },
    ], { log: silentLog(), startCapMs: 60_000 })
    await fleet.start()
    assert.equal(fleet.clients[0].state, MCP_STATES.READY)
    assert.equal(fleet.clients[1].state, MCP_STATES.DEAD)
    const names = fleet.tools.map((t) => t.name)
    assert.deepEqual(names, ['mcp__alpha__echo'])
    await fleet.destroy()
  })

  describe('start() wall-clock cap (#4456)', () => {
    it('exposes DEFAULT_FLEET_START_CAP_MS as a module export', () => {
      assert.equal(typeof DEFAULT_FLEET_START_CAP_MS, 'number')
      assert.ok(DEFAULT_FLEET_START_CAP_MS > 0)
    })

    it('returns within ~startCapMs even when one server is permanently broken', async () => {
      // One healthy + one perpetually-failing server. Without the cap,
      // start() would wait the full ~7s restart budget on the broken one.
      // With a 300ms cap, we expect start() to return promptly — the broken
      // server is still in STARTING/RESTARTING (not DEAD).
      const fleet = new MCPFleet([
        cfg('alpha'),
        { name: 'broken', command: process.execPath, args: ['-e', 'process.exit(2)'], env: {} },
      ], { log: silentLog(), startCapMs: 300 })
      const t0 = Date.now()
      await fleet.start()
      const elapsed = Date.now() - t0
      assert.ok(elapsed < 800, `start() took ${elapsed}ms, expected <800ms under 300ms cap`)
      // alpha should have stabilized inside the cap (handshake ~50-200ms).
      assert.equal(fleet.clients[0].state, MCP_STATES.READY)
      // broken should NOT be DEAD yet — the restart loop is still running
      // in the background. State will be STARTING or RESTARTING.
      assert.notEqual(fleet.clients[1].state, MCP_STATES.DEAD, 'cap fired before broken server exhausted its restart budget')
      await fleet.destroy()
    })

    it('returns immediately on the happy path (no cap-induced latency)', async () => {
      // All servers healthy — start() should resolve as soon as every
      // handshake completes, well under the default cap.
      const fleet = new MCPFleet([cfg('alpha'), cfg('beta')], { log: silentLog() })
      const t0 = Date.now()
      await fleet.start()
      const elapsed = Date.now() - t0
      // Generous bound — healthy handshakes typically complete in <300ms.
      assert.ok(elapsed < 1200, `happy-path start() took ${elapsed}ms, expected <1200ms`)
      assert.equal(fleet.clients[0].state, MCP_STATES.READY)
      assert.equal(fleet.clients[1].state, MCP_STATES.READY)
      await fleet.destroy()
    })

    it('uses DEFAULT_FLEET_START_CAP_MS when no override is supplied', async () => {
      // The cap default itself bounds the wait — verify the broken-server
      // worst case stays under the default + a generous margin.
      const fleet = new MCPFleet([
        cfg('alpha'),
        { name: 'broken', command: process.execPath, args: ['-e', 'process.exit(2)'], env: {} },
      ], { log: silentLog() })
      const t0 = Date.now()
      await fleet.start()
      const elapsed = Date.now() - t0
      assert.ok(
        elapsed < DEFAULT_FLEET_START_CAP_MS + 500,
        `start() took ${elapsed}ms, expected <${DEFAULT_FLEET_START_CAP_MS + 500}ms under default cap`,
      )
      await fleet.destroy()
    })

    it('bogus startCapMs (NaN, 0, negative) falls back to the default', async () => {
      // Defensive guard — non-positive setTimeout values would otherwise
      // coerce to 0 and break the cap entirely.
      for (const bogus of [NaN, 0, -1, '500', null, undefined]) {
        const fleet = new MCPFleet([cfg('alpha')], { log: silentLog(), startCapMs: bogus })
        assert.equal(fleet._startCapMs, DEFAULT_FLEET_START_CAP_MS, `startCapMs=${String(bogus)} should fall back`)
        await fleet.destroy()
      }
    })
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
      // Same DEAD-by-start invariant as the earlier "excludes tools from dead
      // servers" test — bypass the #4456 wall-clock cap with a large override
      // so the broken server has time to walk through its full restart budget.
      const fleet = new MCPFleet([
        cfg('alpha'),
        { name: 'broken', command: process.execPath, args: ['-e', 'process.exit(2)'], env: {} },
      ], { log: silentLog(), startCapMs: 60_000 })
      await fleet.start()
      const names = fleet.anthropicTools.map((t) => t.name)
      assert.deepEqual(names, ['mcp__alpha__echo'])
      await fleet.destroy()
    })
  })

  describe('enable/disable (#6824)', () => {
    it('disable parks the client — its tools disappear and status becomes disabled', async () => {
      const fleet = new MCPFleet([cfg('alpha'), cfg('beta')], { log: silentLog() })
      await fleet.start()
      assert.deepEqual(fleet.tools.map((t) => t.name).sort(), ['mcp__alpha__echo', 'mcp__beta__echo'])

      const res = await fleet.setEnabled('beta', false)
      assert.deepEqual(res, { found: true, changed: true, status: 'disabled' })
      // beta's tools are gone; alpha remains.
      assert.deepEqual(fleet.tools.map((t) => t.name), ['mcp__alpha__echo'])
      // beta has no live client anymore.
      assert.equal(fleet.clients.find((c) => c.name === 'beta'), undefined)
      // status snapshot reports beta parked.
      const statuses = fleet.getServerStatuses()
      const beta = statuses.find((s) => s.name === 'beta')
      assert.deepEqual(beta, { name: 'beta', status: 'disabled', enabled: false, canToggle: true })
      assert.deepEqual(fleet.disabledServers, ['beta'])
      await fleet.destroy()
    })

    it('re-enable rebuilds + restarts the client — its tools reappear', async () => {
      const fleet = new MCPFleet([cfg('alpha'), cfg('beta')], { log: silentLog() })
      await fleet.start()
      await fleet.setEnabled('beta', false)
      assert.deepEqual(fleet.tools.map((t) => t.name), ['mcp__alpha__echo'])

      const res = await fleet.setEnabled('beta', true)
      assert.equal(res.found, true)
      assert.equal(res.changed, true)
      assert.equal(res.status, 'connected')
      assert.deepEqual(fleet.tools.map((t) => t.name).sort(), ['mcp__alpha__echo', 'mcp__beta__echo'])
      assert.deepEqual(fleet.disabledServers, [])
      await fleet.destroy()
    })

    it('re-enabling an already-trusted server does NOT re-prompt for trust', async () => {
      const tmpStorePath = `/tmp/chroxy-mcp-trust-test-${process.pid}-${Date.now()}-toggle.json`
      const fs = await import('node:fs')
      let prompts = 0
      const fakePermissionManager = { requestMcpTrust: async () => { prompts += 1; return true } }
      const fleet = new MCPFleet([cfg('alpha')], {
        log: silentLog(),
        permissionManager: fakePermissionManager,
        trustStorePath: tmpStorePath,
      })
      await fleet.start()
      assert.equal(prompts, 1, 'first spawn prompts once (untrusted → allowed + recorded)')

      await fleet.setEnabled('alpha', false)
      await fleet.setEnabled('alpha', true)
      // The re-enable rebuilds the client, but the tuple is now in the trust
      // store, so the gate short-circuits without a new prompt.
      assert.equal(prompts, 1, 'already-trusted server reconnects silently on re-enable')
      assert.equal(fleet.clients.find((c) => c.name === 'alpha')?.state, MCP_STATES.READY)
      await fleet.destroy()
      try { fs.rmSync(tmpStorePath) } catch {}
    })

    it('disabledServers seed: a parked server never spawns a client at start', async () => {
      const fleet = new MCPFleet(
        [cfg('alpha'), cfg('beta')],
        { log: silentLog(), disabledServers: ['beta'] },
      )
      await fleet.start()
      // Only alpha has a live client / tools.
      assert.deepEqual(fleet.clients.map((c) => c.name), ['alpha'])
      assert.deepEqual(fleet.tools.map((t) => t.name), ['mcp__alpha__echo'])
      const statuses = fleet.getServerStatuses()
      assert.deepEqual(statuses.find((s) => s.name === 'beta'), { name: 'beta', status: 'disabled', enabled: false, canToggle: true })
      assert.deepEqual(fleet.disabledServers, ['beta'])
      await fleet.destroy()
    })

    it('disabledServers seed filters out names that are not configured', async () => {
      const fleet = new MCPFleet(
        [cfg('alpha')],
        { log: silentLog(), disabledServers: ['ghost', 'alpha'] },
      )
      // 'ghost' isn't configured → dropped; 'alpha' is parked.
      assert.deepEqual(fleet.disabledServers, ['alpha'])
      await fleet.start()
      assert.deepEqual(fleet.tools.map((t) => t.name), [])
      await fleet.destroy()
    })

    it('setEnabled on an unknown server returns found:false', async () => {
      const fleet = new MCPFleet([cfg('alpha')], { log: silentLog() })
      await fleet.start()
      const res = await fleet.setEnabled('nope', false)
      assert.deepEqual(res, { found: false, changed: false, status: null })
      await fleet.destroy()
    })

    it('setEnabled is idempotent — toggling to the current state is a no-op', async () => {
      const fleet = new MCPFleet([cfg('alpha')], { log: silentLog() })
      await fleet.start()
      // Already enabled → enabling again is a no-op.
      const a = await fleet.setEnabled('alpha', true)
      assert.equal(a.changed, false)
      await fleet.setEnabled('alpha', false)
      // Already disabled → disabling again is a no-op.
      const b = await fleet.setEnabled('alpha', false)
      assert.equal(b.changed, false)
      assert.equal(b.status, 'disabled')
      await fleet.destroy()
    })

    it('ignores a churn toggle while the same server\'s park/unpark is in flight', async () => {
      const fleet = new MCPFleet([cfg('alpha')], { log: silentLog() })
      await fleet.start()
      // Fire a disable (enters the latch, awaits the client's destroy grace)
      // and, before awaiting it, a flip-back enable for the SAME server. The
      // second call must be ignored (changed:false) rather than interleaving a
      // start into the in-flight destroy.
      const p1 = fleet.setEnabled('alpha', false)
      const p2 = fleet.setEnabled('alpha', true)
      const [r1, r2] = await Promise.all([p1, p2])
      assert.equal(r1.changed, true, 'first toggle proceeds')
      assert.equal(r1.status, 'disabled')
      assert.equal(r2.found, true)
      assert.equal(r2.changed, false, 'in-flight churn is ignored')
      // The first (in-flight) op is authoritative: server ends parked.
      assert.deepEqual(fleet.disabledServers, ['alpha'])
      assert.deepEqual(fleet.tools, [])
      // The latch releases after settle — a later toggle works normally.
      const r3 = await fleet.setEnabled('alpha', true)
      assert.equal(r3.changed, true, 'latch released after the in-flight op settled')
      assert.equal(r3.status, 'connected')
      await fleet.destroy()
    })
  })

  describe('OAuth surfacing (#6822)', () => {
    // Build a fleet with a remote config, then swap in a fake client so we can
    // exercise getServerStatuses / submitAuthCode without a live OAuth server
    // (the client-level flow is covered in byok-mcp-remote-client.test.js).
    function fleetWithFakeClient(fake) {
      const fleet = new MCPFleet([{ name: 'remote', url: 'https://ex.example/mcp' }], { log: silentLog() })
      fleet._clients = [fake]
      return fleet
    }

    it('getServerStatuses reports oauth-required + authUrl for a client awaiting authorization', () => {
      const fleet = fleetWithFakeClient({
        name: 'remote', state: MCP_STATES.DEAD, needsAuthorization: true, authorizationUrl: 'https://as.example/authorize?x=1',
      })
      const [s] = fleet.getServerStatuses()
      assert.equal(s.status, 'oauth-required')
      assert.equal(s.authUrl, 'https://as.example/authorize?x=1')
      assert.equal(s.enabled, true)
      assert.equal(s.canToggle, true)
    })

    it('submitAuthCode delegates to the client and reports the reconnected status', async () => {
      let received = null
      const fleet = fleetWithFakeClient({
        name: 'remote', state: MCP_STATES.READY, needsAuthorization: false,
        completeAuthorization: async (code) => { received = code; return { ok: true } },
      })
      const res = await fleet.submitAuthCode('remote', 'the-code')
      assert.deepEqual(res, { found: true, ok: true, status: 'connected' })
      assert.equal(received, 'the-code')
    })

    it('submitAuthCode returns found:false for an unknown server', async () => {
      const fleet = fleetWithFakeClient({ name: 'remote', state: MCP_STATES.READY })
      assert.deepEqual(await fleet.submitAuthCode('ghost', 'x'), { found: false })
    })

    it('submitAuthCode surfaces a redemption failure as ok:false with a value-free reason', async () => {
      const fleet = fleetWithFakeClient({
        name: 'remote', state: MCP_STATES.DEAD, needsAuthorization: true,
        completeAuthorization: async () => { throw new Error('token endpoint returned HTTP 400') },
      })
      const res = await fleet.submitAuthCode('remote', 'x')
      assert.equal(res.found, true)
      assert.equal(res.ok, false)
      assert.match(res.error, /HTTP 400/)
    })

    it('submitAuthCode rejects a stdio client that has no completeAuthorization method', async () => {
      const fleet = fleetWithFakeClient({ name: 'remote', state: MCP_STATES.READY })
      const res = await fleet.submitAuthCode('remote', 'x')
      assert.equal(res.found, true)
      assert.equal(res.ok, false)
      assert.match(res.error, /does not use OAuth/)
    })
  })
})
