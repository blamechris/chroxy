/**
 * #7973 — `chroxy_respond_permission` must refuse `allow` for tools that are
 * never delegable to an external planner (`mcp_spawn`, codex
 * `request_permissions`) WHATEVER the protected-path floor's `floored`
 * verdict says (#7968's floored gate only ever narrows an ordinary prompt —
 * it says nothing about these two, which are high-authority independent of
 * any path field). Separately, command-style tools (`Bash`, codex `shell`)
 * carry an arbitrary command string the path floor cannot see through
 * (`floored:false` on a `Bash` prompt means "no path field looked
 * protected", not "this command is safe") — `allow` for one of these is
 * refused by default and only permitted when the operator opts in with
 * `--allow-command-approvals`, and even then the floored/ownership gates
 * still apply on top.
 *
 * Most cases here are LIGHTWEIGHT fixtures (no real WsServer): these are pure
 * client-side gates keyed off `_observedPermissions`/`_ownedSessions`/
 * `allowCommandApprovals`, already proven to reach the real server-side
 * resolver for the ownership/floored gates in client-guards.test.js — a real
 * socket buys nothing extra here. `_state` is set to 'ready' directly and
 * `_send` is stubbed, mirroring the "create_session serial-op correlation
 * scoping" fixtures at the bottom of that file. The CLI-flag/startup-warning
 * cases at the bottom DO spawn the real `chroxy agent-control --stdio`
 * subprocess (mirroring mcp-stdio.test.js) because those are genuinely about
 * argv parsing and process-level logging, not client-side gating logic.
 */
import { describe, it, before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { once } from 'node:events'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { Client } from '@modelcontextprotocol/sdk/client/index.js'
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js'
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js'
import { WsServer as _WsServer } from '../../src/ws-server.js'
import { AgentControlClient, NOT_DELEGABLE_TOOLS, COMMAND_TOOLS } from '../../src/agent-control/client.js'
import { createAgentControlMcpServer } from '../../src/agent-control/mcp-server.js'
import {
  NOT_DELEGABLE_TOOLS as CANONICAL_NOT_DELEGABLE_TOOLS,
  COMMAND_TOOLS as CANONICAL_COMMAND_TOOLS,
} from '../../src/permission-manager.js'
import { createMockSessionManager, createMockSession, createSpy } from '../test-helpers.js'

const __dirname = dirname(fileURLToPath(import.meta.url))
const cliPath = join(__dirname, '..', '..', 'src', 'cli.js')

class EncryptedWsServer extends _WsServer {
  constructor(opts = {}) {
    super({ localhostBypass: false, ...opts })
  }
}

async function startServerAndGetPort(server) {
  server.start('127.0.0.1')
  await once(server.httpServer, 'listening')
  return server.httpServer.address().port
}

/**
 * A client wired straight to 'ready' with `_send` stubbed to capture wire
 * sends — no socket, no handshake. `requestTimeoutMs` defaults small so a
 * call that legitimately reaches `_send` (i.e. was NOT refused) settles
 * quickly with `status: 'uncertain'` instead of waiting out the real
 * (15s) default; nothing here is testing ack correlation, which
 * client-guards.test.js already covers against a real server.
 */
function readyClient(opts = {}) {
  const client = new AgentControlClient({
    url: 'ws://127.0.0.1:1',
    token: 'fixture-token-only',
    silent: true,
    requestTimeoutMs: 30,
    ...opts,
  })
  client._state = 'ready'
  const sent = []
  client._send = (msg) => { sent.push(msg) }
  return { client, sent }
}

function observe(client, { requestId, sessionId, tool, floored }) {
  client._trackPermissionObservation({ type: 'permission_request', requestId, sessionId, tool, floored })
}

describe('shared exclusion-set identity (#7973)', () => {
  it('agent-control/client.js re-exports the EXACT Set objects permission-manager.js exports — no hand-rolled second list', () => {
    assert.equal(NOT_DELEGABLE_TOOLS, CANONICAL_NOT_DELEGABLE_TOOLS, 'NOT_DELEGABLE_TOOLS must be the SAME object (import identity), not an equal-valued copy')
    assert.equal(COMMAND_TOOLS, CANONICAL_COMMAND_TOOLS, 'COMMAND_TOOLS must be the SAME object (import identity), not an equal-valued copy')
  })

  it('NOT_DELEGABLE_TOOLS contains exactly mcp_spawn and request_permissions', () => {
    assert.deepEqual([...NOT_DELEGABLE_TOOLS].sort(), ['mcp_spawn', 'request_permissions'])
  })

  // The roster is sourced from what each provider actually hands
  // handlePermission / POST /permission, not from a guess:
  //   - Bash: Claude Code (SDK, CLI, TUI, channel) and BYOK's executor;
  //   - PowerShell: Claude Code's Windows shell tool (the ONLY shell tool on a
  //     Windows host without Git Bash), checked with Bash's rules;
  //   - Monitor: Claude Code's background-script tool — its input is a bash
  //     `command`, permission-checked by the same function as Bash;
  //   - shell: codex app-server's commandExecution approval.
  // PowerShell and Monitor were missing, so a planner could approve an
  // arbitrary command without --allow-command-approvals.
  it('COMMAND_TOOLS contains exactly the command-executing tool names the providers emit (Bash, PowerShell, Monitor — Claude Code / BYOK; shell — codex app-server)', () => {
    assert.deepEqual([...COMMAND_TOOLS].sort(), ['Bash', 'Monitor', 'PowerShell', 'shell'])
  })
})

describe('not-delegable tools: mcp_spawn / request_permissions refused regardless of floored (#7973)', () => {
  let client
  afterEach(async () => { if (client) { await client.close(); client = null } })

  for (const tool of ['mcp_spawn', 'request_permissions']) {
    it(`refuses allow for ${tool} even when floored:false and the session is owned`, async () => {
      ;({ client } = readyClient({ ownedSessions: new Set(['sess-a']) }))
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'not_delegable')
    })

    it(`refuses allow for ${tool} even when floored is ABSENT (would otherwise be floor_unknown — not_delegable must win regardless)`, async () => {
      ;({ client } = readyClient({ ownedSessions: new Set(['sess-a']) }))
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: undefined })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'not_delegable')
    })

    it(`deny is still permitted for ${tool} (deny is never gated)`, async () => {
      const fixture = readyClient({ ownedSessions: new Set(['sess-a']) })
      client = fixture.client
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'deny')
      assert.equal(fixture.sent.length, 1, 'deny must reach _send — proves it was not refused')
      assert.equal(fixture.sent[0].decision, 'deny')
      assert.equal(result.status, 'uncertain', 'no fabricated ack arrives in this fixture — this only proves the call proceeded past every refusal gate')
    })

    it(`ownership still applies first: ${tool} in a session this process did not create is refused not_owned, not not_delegable`, async () => {
      ;({ client } = readyClient({})) // no ownedSessions
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'not_owned')
    })
  }
})

describe('command-tool policy: deny-only by default, opt-in via allowCommandApprovals (#7973)', () => {
  let client
  afterEach(async () => { if (client) { await client.close(); client = null } })

  for (const tool of ['Bash', 'shell', 'PowerShell', 'Monitor']) {
    it(`refuses allow for ${tool} by default (floored:false, owned) — reason command_approval_disabled`, async () => {
      ;({ client } = readyClient({ ownedSessions: new Set(['sess-a']) }))
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'command_approval_disabled')
    })

    it(`allows allow for ${tool} when allowCommandApprovals:true (floored:false, owned)`, async () => {
      const fixture = readyClient({ ownedSessions: new Set(['sess-a']), allowCommandApprovals: true })
      client = fixture.client
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(fixture.sent.length, 1, 'allow must reach _send once the flag is set and floored/ownership pass')
      assert.equal(fixture.sent[0].decision, 'allow')
      assert.equal(result.status, 'uncertain')
    })

    it(`STILL refuses ${tool} when allowCommandApprovals:true but floored:true — the flag never overrides the floor`, async () => {
      ;({ client } = readyClient({ ownedSessions: new Set(['sess-a']), allowCommandApprovals: true }))
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: true })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'floored')
    })

    it(`STILL refuses ${tool} when allowCommandApprovals:true but floored is ABSENT — fail-closed, same as an ordinary tool`, async () => {
      ;({ client } = readyClient({ ownedSessions: new Set(['sess-a']), allowCommandApprovals: true }))
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: undefined })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'floor_unknown')
    })

    it(`STILL refuses ${tool} when allowCommandApprovals:true but the session is not owned — the flag never overrides ownership`, async () => {
      ;({ client } = readyClient({ allowCommandApprovals: true })) // no ownedSessions
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'allow')
      assert.equal(result.status, 'rejected', JSON.stringify(result))
      assert.equal(result.reason, 'not_owned')
    })

    it(`deny is always permitted for ${tool}, flag or not`, async () => {
      const fixture = readyClient({ ownedSessions: new Set(['sess-a']) })
      client = fixture.client
      observe(client, { requestId: 'r1', sessionId: 'sess-a', tool, floored: false })
      const result = await client.respondPermission('sess-a', 'r1', 'deny')
      assert.equal(fixture.sent.length, 1)
      assert.equal(fixture.sent[0].decision, 'deny')
      void result
    })
  }

  it('allowCommandApprovals defaults to false when not passed', () => {
    const { client: c } = readyClient({})
    assert.equal(c.allowCommandApprovals, false)
  })
})

describe('read-only mode refuses chroxy_respond_permission regardless of allowCommandApprovals (#7973)', () => {
  it('read-only + allowCommandApprovals:true still hard-refuses the mutation tool before any connection I/O', async () => {
    let calls = 0
    const manager = { get: async () => { calls++; throw Object.assign(new Error('fixture connection attempted'), { code: 'CONNECT_ATTEMPTED' }) } }
    const { mcp } = createAgentControlMcpServer({ readOnly: true, allowCommandApprovals: true, clientManager: manager })
    const sdk = new Client({ name: 'fixture', version: '1' })
    const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair()
    try {
      await mcp.connect(serverTransport)
      await sdk.connect(clientTransport)
      const result = await sdk.callTool({ name: 'chroxy_respond_permission', arguments: { sessionId: 's', requestId: 'r', decision: 'allow' } })
      assert.equal(result.structuredContent.code, 'READ_ONLY_MODE')
      assert.equal(calls, 0, 'read-only must refuse before any connection I/O, flag or not')
    } finally {
      await sdk.close()
      await mcp.close()
    }
  })
})

describe('CLI: --allow-command-approvals end to end (real subprocess, #7973)', () => {
  let server
  let port
  let sessionsMap
  let manager
  let nextId

  // Ownership (`_ownedSessions`) is per-MCP-process and populated only by
  // actually calling `chroxy_create_session` — unlike the lightweight fixtures
  // above, a real CLI subprocess has no seam to pre-inject ownership, so
  // `manager.createSession` is mocked here (same shape as client-guards.test.js's
  // "createSession positive fixture" test) and every test below creates its own
  // session first, then drives a permission_request/respond_permission round
  // trip against THAT session id.
  before(async () => {
    const homeCwd = homedir()
    const created = createMockSessionManager([])
    sessionsMap = created.sessionsMap
    manager = created.manager
    nextId = 0
    manager.createSession = createSpy((opts) => {
      nextId += 1
      const id = `sess-cli-${nextId}`
      const mockSession = createMockSession()
      mockSession.cwd = opts.cwd || homeCwd
      sessionsMap.set(id, { session: mockSession, name: opts.name || 'New', cwd: opts.cwd || homeCwd, type: 'cli', isBusy: false })
      return id
    })
    manager.listSessions = () => [...sessionsMap.entries()].map(([sessionId, entry]) => ({
      sessionId, name: entry.name, cwd: entry.cwd, type: entry.type, isBusy: entry.isBusy, model: entry.session.model,
    }))
    server = new EncryptedWsServer({ port: 0, apiToken: 'fixture-token-only', sessionManager: manager, authRequired: true })
    port = await startServerAndGetPort(server)
  })

  after(() => { if (server) server.close() })

  async function connectSdkClient(extraArgs = [], spawnOpts = {}) {
    const transport = new StdioClientTransport({
      command: process.execPath,
      args: [cliPath, 'agent-control', '--stdio', '--url', `ws://127.0.0.1:${port}`, ...extraArgs],
      env: { ...process.env, CHROXY_AGENT_CONTROL_TOKEN: 'fixture-token-only' },
      stderr: 'pipe',
      ...spawnOpts,
    })
    const client = new Client({ name: 'test-harness', version: '0.0.0' }, { capabilities: {} })
    await client.connect(transport)
    return { client, transport }
  }

  async function readStderrUntil(transport, predicate, timeoutMs = 3000) {
    const stream = transport.stderr
    let buf = ''
    return new Promise((resolve, reject) => {
      const onData = (chunk) => {
        buf += chunk.toString('utf8')
        if (predicate(buf)) { cleanup(); resolve(buf) }
      }
      const timer = setTimeout(() => { cleanup(); reject(new Error(`stderr predicate not satisfied within ${timeoutMs}ms; captured: ${buf}`)) }, timeoutMs)
      function cleanup() { clearTimeout(timer); stream.off('data', onData) }
      stream.on('data', onData)
    })
  }

  it('absent by default: a Bash permission_request is refused command_approval_disabled, the provider never sees it, and no startup warning is printed', async () => {
    const { client, transport } = await connectSdkClient()
    try {
      // Assert the command-approval warning specifically never appears in
      // stderr, alongside the real refusal below.
      let stderrSoFar = ''
      const onData = (chunk) => { stderrSoFar += chunk.toString('utf8') }
      transport.stderr.on('data', onData)

      const createdResult = await client.callTool({ name: 'chroxy_create_session', arguments: { name: 'fixture-default', cwd: homedir() } })
      const sessionId = createdResult.structuredContent.sessionId
      const calls = []
      sessionsMap.get(sessionId).session.respondToPermission = (requestId, decision) => {
        calls.push([requestId, decision])
        return true
      }

      const first = await client.callTool({ name: 'chroxy_get_events', arguments: { sessionId } })
      const cursor = first.structuredContent.cursor
      const waitingPromise = client.callTool({ name: 'chroxy_get_events', arguments: { sessionId, cursor, waitMs: 1000 } })
      manager.emit('session_event', { sessionId, event: 'permission_request', data: { requestId: 'bash-pending-default', tool: 'Bash', input: { command: 'ls' }, remainingMs: 5000, floored: false } })
      const seen = await waitingPromise
      assert.ok(JSON.stringify(seen.structuredContent).includes('bash-pending-default'))

      const result = await client.callTool({
        name: 'chroxy_respond_permission',
        arguments: { sessionId, requestId: 'bash-pending-default', decision: 'allow' },
      })
      assert.equal(result.structuredContent.reason, 'command_approval_disabled', JSON.stringify(result.structuredContent))
      assert.equal(calls.length, 0, 'the provider must never see an allow decision for a command tool without the flag')

      transport.stderr.off('data', onData)
      assert.ok(!/allow-command-approvals/i.test(stderrSoFar), `no command-approval warning expected without the flag; captured: ${stderrSoFar}`)
    } finally {
      await transport.close().catch(() => {})
    }
  })

  it('present: --allow-command-approvals logs a startup warning and lets chroxy_respond_permission allow a Bash prompt through to the provider', async () => {
    const { client, transport } = await connectSdkClient(['--allow-command-approvals'])
    try {
      await readStderrUntil(transport, (buf) => /allow-command-approvals/i.test(buf))

      const createdResult = await client.callTool({ name: 'chroxy_create_session', arguments: { name: 'fixture-flagged', cwd: homedir() } })
      const sessionId = createdResult.structuredContent.sessionId
      const calls = []
      sessionsMap.get(sessionId).session.respondToPermission = (requestId, decision) => {
        calls.push([requestId, decision])
        manager.emit('session_event', { sessionId, event: 'permission_resolved', data: { requestId, decision, reason: 'user' } })
        return true
      }

      const first = await client.callTool({ name: 'chroxy_get_events', arguments: { sessionId } })
      const cursor = first.structuredContent.cursor
      const waitingPromise = client.callTool({ name: 'chroxy_get_events', arguments: { sessionId, cursor, waitMs: 1000 } })
      manager.emit('session_event', { sessionId, event: 'permission_request', data: { requestId: 'bash-pending', tool: 'Bash', input: { command: 'ls' }, remainingMs: 5000, floored: false } })
      const seen = await waitingPromise
      assert.ok(JSON.stringify(seen.structuredContent).includes('bash-pending'))

      const answered = await client.callTool({ name: 'chroxy_respond_permission', arguments: { sessionId, requestId: 'bash-pending', decision: 'allow' } })
      assert.equal(answered.structuredContent.status, 'resolved', JSON.stringify(answered.structuredContent))
      assert.deepEqual(calls, [['bash-pending', 'allow']], 'the flag must let an allow decision reach the provider for a command tool')
    } finally {
      await transport.close().catch(() => {})
    }
  })
})
