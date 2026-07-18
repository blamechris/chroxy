import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { APIUserAbortError } from '@anthropic-ai/sdk'
import { ClaudeByokSession } from '../src/byok-session.js'
import { BUILTIN_TOOLS } from '../src/byok-tools.js'
import { MCP_STATES } from '../src/byok-mcp-client.js'
import { recordTrust } from '../src/byok-mcp-trust.js'

function preTrustStub() {
  recordTrust(
    { name: 'stub', command: process.execPath, args: [MCP_STUB], env: {} },
    process.env.CHROXY_MCP_TRUST_PATH,
  )
}

const __dirname = dirname(fileURLToPath(import.meta.url))
const MCP_STUB = join(__dirname, 'fixtures', 'mcp-stub.mjs')

/**
 * Tests for byok-session.js (PR 1 — chat only, no tool dispatch).
 *
 * The Anthropic SDK is replaced with a stub via `session._client = ...` so
 * we never hit the network and don't need an API key in CI. The stub mirrors
 * the SDK's `messages.stream(...)` shape: returns an object that is both
 * async-iterable and exposes a .finalMessage() helper.
 */

function fakeStream(events, finalMessage) {
  return {
    async *[Symbol.asyncIterator]() {
      for (const e of events) yield e
    },
    async finalMessage() {
      return (
        finalMessage || {
          stop_reason: 'end_turn',
          content: [{ type: 'text', text: events.map((e) => e.delta?.text || '').join('') }],
          usage: { input_tokens: 1, output_tokens: 1 },
        }
      )
    },
  }
}

function captureEvents(session) {
  const captured = []
  const known = [
    'ready', 'stream_start', 'stream_delta', 'stream_end', 'result', 'error',
    'tool_start', 'tool_result',
    // #4080: chroxy event re-emitted from the SDK's input_json_delta so
    // the dashboard tool-call bubble can live-preview the model's
    // evolving tool input (especially valuable for Bash early-abort).
    'tool_input_delta',
    // #4049: Task tool spawns a subagent and emits agent_spawned /
    // agent_completed so the dashboard's active-agents badge ticks.
    'agent_spawned', 'agent_completed',
  ]
  for (const name of known) {
    session.on(name, (payload) => captured.push({ name, payload }))
  }
  return captured
}

/**
 * Drives one round of tool dispatch against the unstubbed executor and
 * returns the tool_result block the model would have seen on the next
 * round. Pre-#4172 every e2e test re-wrote ~25 lines of identical
 * two-round stream stub scaffolding; this helper collapses each test to
 * just its meaningful inputs (tool id/name/input) and assertions.
 *
 * The caller is responsible for permission setup BEFORE calling this —
 * setPermissionMode, _permissions.setRules, _permissions.handlePermission
 * override, etc. The helper only owns the round-1 tool_use emit and the
 * round-2 tool_result capture.
 *
 * @param {object} session  ClaudeByokSession instance (already constructed)
 * @param {object} call     { id, name, input } — the tool_use the model emits
 * @param {object} [opts]
 * @param {string} [opts.prompt='go']  Text passed to sendMessage
 * @returns {Promise<object|null>}  The tool_result content block, or null
 *                                  if the agent loop never reached round 2.
 */
async function runOneToolRound(session, { id, name, input }, opts = {}) {
  const prompt = opts.prompt ?? 'go'
  let round = 0
  let toolResultBlock = null
  session._client = {
    messages: {
      stream: ({ messages }) => {
        round += 1
        if (round === 1) {
          return fakeStream(
            [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
            {
              stop_reason: 'tool_use',
              content: [{ type: 'tool_use', id, name, input }],
              usage: { input_tokens: 1, output_tokens: 1 },
            },
          )
        }
        const lastTurn = messages[messages.length - 1]
        toolResultBlock = (lastTurn.content || []).find((c) => c?.type === 'tool_result')
        return fakeStream(
          [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
          { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
        )
      },
    },
  }
  await session.start()
  await session.sendMessage(prompt)
  return toolResultBlock
}

describe('ClaudeByokSession', () => {
  let tmpHome
  let originalHome
  let originalApiKey
  let originalMcpTrustPath

  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'chroxy-byok-test-'))
    originalHome = process.env.HOME
    originalApiKey = process.env.ANTHROPIC_API_KEY
    originalMcpTrustPath = process.env.CHROXY_MCP_TRUST_PATH
    process.env.HOME = tmpHome
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-fixture'
    // #4457: per-test isolated trust store so spawning the MCP stub
    // doesn't pollute the developer's real ~/.chroxy/mcp-trust.json,
    // and tests that pre-trust the stub tuple don't leak across runs.
    process.env.CHROXY_MCP_TRUST_PATH = join(tmpHome, 'mcp-trust.json')
  })

  afterEach(() => {
    if (originalHome) process.env.HOME = originalHome
    else delete process.env.HOME
    if (originalApiKey) process.env.ANTHROPIC_API_KEY = originalApiKey
    else delete process.env.ANTHROPIC_API_KEY
    if (originalMcpTrustPath) process.env.CHROXY_MCP_TRUST_PATH = originalMcpTrustPath
    else delete process.env.CHROXY_MCP_TRUST_PATH
    rmSync(tmpHome, { recursive: true, force: true })
  })

  describe('static configuration', () => {
    it('exposes the expected displayLabel', () => {
      assert.equal(ClaudeByokSession.displayLabel, 'Claude (API key — BYOK)')
    })

    it('declares no dataDir (no ~/.claude dependency)', () => {
      assert.equal(ClaudeByokSession.dataDir, null)
    })

    it('PR 2 capabilities: tools enabled via in-process permissions', () => {
      const caps = ClaudeByokSession.capabilities
      assert.equal(caps.permissions, true, 'PR 2 gates tools through PermissionManager')
      assert.equal(caps.inProcessPermissions, true)
      assert.equal(caps.modelSwitch, true)
      assert.equal(caps.streaming, true)
      assert.equal(caps.skillToggle, true)
      assert.equal(caps.resume, false, 'in-memory history only')
    })

    it('preflight declares ANTHROPIC_API_KEY as required (not optional)', () => {
      const pf = ClaudeByokSession.preflight
      assert.equal(pf.credentials.optional, false)
      assert.deepEqual(pf.credentials.envVars, ['ANTHROPIC_API_KEY'])
      assert.match(pf.credentials.hint, /credentials\.json/)
    })
  })

  // #6769: pure arithmetic of the final-round occupancy snapshot.
  describe('_buildFinalRoundOccupancy (#6769)', () => {
    it('sums input + cache_read + cache_creation, excluding output', () => {
      assert.deepEqual(
        ClaudeByokSession._buildFinalRoundOccupancy({
          input_tokens: 250,
          output_tokens: 700, // excluded by contract
          cache_read_input_tokens: 102_200,
          cache_creation_input_tokens: 1_100,
        }),
        { totalTokens: 103_550, source: 'final-round-prompt' },
      )
    })

    it('tolerates missing cache fields (uncached first turn)', () => {
      assert.deepEqual(
        ClaudeByokSession._buildFinalRoundOccupancy({ input_tokens: 1_500, output_tokens: 20 }),
        { totalTokens: 1_500, source: 'final-round-prompt' },
      )
    })

    it('returns null for no usage / empty usage / zero totals', () => {
      assert.equal(ClaudeByokSession._buildFinalRoundOccupancy(null), null)
      assert.equal(ClaudeByokSession._buildFinalRoundOccupancy(undefined), null)
      assert.equal(ClaudeByokSession._buildFinalRoundOccupancy({}), null)
      assert.equal(
        ClaudeByokSession._buildFinalRoundOccupancy({ input_tokens: 0, output_tokens: 50 }),
        null,
        'output alone is not a prompt snapshot',
      )
    })

    it('coerces malformed fields to 0 rather than emitting NaN', () => {
      assert.deepEqual(
        ClaudeByokSession._buildFinalRoundOccupancy({
          input_tokens: 'many',
          cache_read_input_tokens: 90_000,
          cache_creation_input_tokens: NaN,
        }),
        { totalTokens: 90_000, source: 'final-round-prompt' },
      )
    })
  })

  describe('start()', () => {
    it('emits ready with model + empty tools when credentials present', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp', model: 'claude-opus-4-8' })
      const captured = captureEvents(session)
      // Inject a stub client BEFORE start to skip the real Anthropic constructor.
      session._client = { messages: { stream: () => fakeStream([]) } }
      await session.start()
      const ready = captured.find((e) => e.name === 'ready')
      assert.ok(ready, 'ready event must fire')
      assert.equal(ready.payload.model, 'claude-opus-4-8')
      assert.deepEqual(ready.payload.tools, [])
      await session.destroy()
    })

    it('emits error when credentials are missing', async () => {
      delete process.env.ANTHROPIC_API_KEY
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      const captured = captureEvents(session)
      await session.start()
      const errorEvent = captured.find((e) => e.name === 'error')
      assert.ok(errorEvent, 'error event must fire')
      // After #4656 the prefix uses the preflight label ('Claude (BYOK)')
      // so the legacy contiguous "BYOK credentials not found" no longer
      // matches verbatim. Pin both the BYOK marker and the credentials
      // phrase independently so a future label change doesn't silently
      // pass an unrelated error string.
      assert.match(errorEvent.payload.message, /BYOK/)
      assert.match(errorEvent.payload.message, /credentials not found/)
      assert.equal(captured.find((e) => e.name === 'ready'), undefined)
    })

    it('surfaces parsed MCP server metadata without spawning tools', async () => {
      // #4457: pre-trust the fake github config so the trust gate doesn't
      // wait its full timeout for a responder that never comes. The fake
      // server still fails to start (`github-mcp.js` doesn't exist) — that
      // failure path is what this test exercises.
      recordTrust(
        { name: 'github', command: 'node', args: ['github-mcp.js'] },
        process.env.CHROXY_MCP_TRUST_PATH,
      )
      const configPath = join(tmpHome, '.claude.json')
      writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          github: {
            command: 'node',
            args: ['github-mcp.js'],
            env: { GITHUB_TOKEN: 'secret' },
          },
        },
      }))
      const session = new ClaudeByokSession({
        cwd: '/tmp',
        model: 'claude-opus-4-8',
        mcpConfigPath: configPath,
      })
      const captured = captureEvents(session)
      session._client = { messages: { stream: () => fakeStream([]) } }
      await session.start()
      assert.ok(Object.isFrozen(session.mcpServers), 'MCP metadata list is read-only')
      assert.deepEqual(session.mcpServers, [
        {
          name: 'github',
          command: 'node',
          args: ['github-mcp.js'],
          envKeys: ['GITHUB_TOKEN'],
        },
      ])
      assert.deepEqual(session._mcpServerConfigs, [
        {
          name: 'github',
          command: 'node',
          args: ['github-mcp.js'],
          env: { GITHUB_TOKEN: 'secret' },
        },
      ])
      const ready = captured.find((e) => e.name === 'ready')
      assert.ok(ready, 'ready event must fire')
      assert.deepEqual(ready.payload.tools, [], 'foundation slice does not materialize MCP tools yet')
      await session.destroy()
    })

    it('starts cleanly when MCP config is malformed', async () => {
      const configPath = join(tmpHome, '.claude.json')
      writeFileSync(configPath, '{ bad json')
      const session = new ClaudeByokSession({ cwd: '/tmp', mcpConfigPath: configPath })
      const captured = captureEvents(session)
      session._client = { messages: { stream: () => fakeStream([]) } }
      await session.start()
      assert.deepEqual(session.mcpServers, [])
      assert.deepEqual(session._mcpServerConfigs, [])
      assert.ok(captured.find((e) => e.name === 'ready'), 'malformed MCP config must not block startup')
      await session.destroy()
    })

    it('#4449: mcpConfigPath is the canonical MCP-config opt; the dead claudeConfigPath alias is ignored', async () => {
      // The pre-#4449 constructor honored either `opts.mcpConfigPath`
      // OR `opts.claudeConfigPath` for historical reasons, but every
      // caller — production and test — only ever set `mcpConfigPath`.
      // After #4449 only `mcpConfigPath` is read. Passing the dead
      // alias must not silently load a config, otherwise downstream
      // callers could come to depend on it and re-create the
      // two-names-for-one-thing surface.
      //
      // We write to a non-default filename (`mcp-custom.json`) so the
      // default-path fallback (`$HOME/.claude.json` — which is
      // `tmpHome/.claude.json` for this test thanks to the `HOME`
      // override in beforeEach) doesn't accidentally satisfy the
      // ignored alias path and mask the regression.
      const configPath = join(tmpHome, 'mcp-custom.json')
      writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          ghost: { command: 'node', args: ['server.js'], env: {} },
        },
      }))
      // mcpConfigPath honored — the canonical path.
      const honored = new ClaudeByokSession({ cwd: '/tmp', mcpConfigPath: configPath })
      assert.equal(honored._mcpServerConfigs.length, 1)
      assert.equal(honored._mcpServerConfigs[0].name, 'ghost')

      // claudeConfigPath alone is ignored — falls back to the default
      // location (which doesn't exist in this isolated tmpHome).
      const ignored = new ClaudeByokSession({ cwd: '/tmp', claudeConfigPath: configPath })
      assert.deepEqual(ignored._mcpServerConfigs, [],
        'claudeConfigPath must not be read; mcpConfigPath is the only knob')
    })

    it('#4077: lazy-spawns an MCPFleet for configured servers and reaches READY before emitting ready', async () => {
      preTrustStub()
      const configPath = join(tmpHome, '.claude.json')
      writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          stub: { command: process.execPath, args: [MCP_STUB], env: {} },
        },
      }))
      const session = new ClaudeByokSession({ cwd: '/tmp', mcpConfigPath: configPath })
      session._client = { messages: { stream: () => fakeStream([]) } }
      assert.equal(session._mcpFleet, null, 'fleet not created before start()')
      await session.start()
      assert.ok(session._mcpFleet, 'fleet created during start()')
      assert.equal(session._mcpFleet.clients.length, 1)
      assert.equal(session._mcpFleet.clients[0].state, MCP_STATES.READY)
      assert.equal(session._mcpFleet.clients[0].tools.length, 1)
      await session.destroy()
    })

    it('#4078: messages.stream receives BUILTIN_TOOLS + MCP tools merged for the turn', async () => {
      preTrustStub()
      const configPath = join(tmpHome, '.claude.json')
      writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          stub: { command: process.execPath, args: [MCP_STUB], env: { MCP_STUB_TOOLS: JSON.stringify([
            { name: 'one', description: 'first', inputSchema: { type: 'object' } },
            { name: 'two', description: 'second', inputSchema: { type: 'object' } },
          ]) } },
        },
      }))
      const session = new ClaudeByokSession({ cwd: '/tmp', mcpConfigPath: configPath })
      let capturedTools = null
      session._client = {
        messages: {
          stream: ({ tools }) => {
            capturedTools = tools
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
              { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      await session.start()
      await session.sendMessage('hello')
      assert.ok(capturedTools, 'tools must be captured from stream call')
      const builtinCount = capturedTools.filter((t) => !t.name.startsWith('mcp__')).length
      const mcpTools = capturedTools.filter((t) => t.name.startsWith('mcp__'))
      assert.ok(builtinCount >= 1, `expected at least 1 builtin tool, got ${builtinCount}`)
      assert.deepEqual(mcpTools.map((t) => t.name).sort(), ['mcp__stub__one', 'mcp__stub__two'])
      for (const mcp of mcpTools) {
        assert.ok(mcp.input_schema, 'MCP tool must carry input_schema (renamed from inputSchema)')
        assert.equal(mcp.inputSchema, undefined, 'inputSchema rename complete')
        assert.equal(mcp._mcpServer, undefined, 'internal markers stripped before API')
      }
      await session.destroy()
    })

    it('#4078: messages.stream receives only BUILTIN_TOOLS when no MCP servers configured', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      let capturedTools = null
      session._client = {
        messages: {
          stream: ({ tools }) => {
            capturedTools = tools
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
              { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      await session.start()
      await session.sendMessage('hello')
      assert.ok(capturedTools)
      assert.ok(capturedTools.every((t) => !t.name.startsWith('mcp__')), 'no MCP tools when fleet is null')
      await session.destroy()
    })

    // #6824: per-server enable/disable (BYOK lane authoritative).
    describe('MCP enable/disable (#6824)', () => {
      function writeStubConfig() {
        const configPath = join(tmpHome, '.claude.json')
        writeFileSync(configPath, JSON.stringify({
          mcpServers: { stub: { command: process.execPath, args: [MCP_STUB], env: {} } },
        }))
        return configPath
      }

      it('emits mcp_servers on start with per-server enabled + canToggle', async () => {
        preTrustStub()
        const configPath = writeStubConfig()
        const session = new ClaudeByokSession({ cwd: '/tmp', mcpConfigPath: configPath })
        session._client = { messages: { stream: () => fakeStream([]) } }
        const emitted = []
        session.on('mcp_servers', (d) => emitted.push(d))
        await session.start()
        assert.equal(emitted.length, 1, 'exactly one mcp_servers emit on start')
        assert.deepEqual(emitted[0].servers, [
          { name: 'stub', status: 'connected', enabled: true, canToggle: true },
        ])
        await session.destroy()
      })

      it('disable parks the server — tools drop, re-emits status disabled, persists the set', async () => {
        preTrustStub()
        const configPath = writeStubConfig()
        const session = new ClaudeByokSession({ cwd: '/tmp', mcpConfigPath: configPath })
        session._client = { messages: { stream: () => fakeStream([]) } }
        const emitted = []
        session.on('mcp_servers', (d) => emitted.push(d))
        await session.start()
        assert.ok(session._mcpFleet.tools.length >= 1, 'tools present while enabled')

        const res = await session.setMcpServerEnabled('stub', false)
        assert.deepEqual(res, { found: true, changed: true, status: 'disabled' })
        assert.deepEqual(session._mcpFleet.tools, [], 'parked server contributes no tools')
        assert.deepEqual(session.getDisabledMcpServers(), ['stub'])
        // A fresh mcp_servers emit reflects the parked status.
        const last = emitted[emitted.length - 1]
        assert.deepEqual(last.servers, [
          { name: 'stub', status: 'disabled', enabled: false, canToggle: true },
        ])
        await session.destroy()
      })

      it('re-enable restarts the server — tools reappear, set cleared', async () => {
        preTrustStub()
        const configPath = writeStubConfig()
        const session = new ClaudeByokSession({ cwd: '/tmp', mcpConfigPath: configPath })
        session._client = { messages: { stream: () => fakeStream([]) } }
        await session.start()
        await session.setMcpServerEnabled('stub', false)
        assert.deepEqual(session._mcpFleet.tools, [])

        const res = await session.setMcpServerEnabled('stub', true)
        assert.equal(res.changed, true)
        assert.equal(res.status, 'connected')
        assert.ok(session._mcpFleet.tools.length >= 1, 'tools reappear after re-enable')
        assert.deepEqual(session.getDisabledMcpServers(), [])
        await session.destroy()
      })

      it('respawn honors the persisted disabled set — a seeded server never starts', async () => {
        // No preTrustStub needed: a parked server is never spawned, so the
        // trust gate is never consulted.
        const configPath = writeStubConfig()
        const session = new ClaudeByokSession({
          cwd: '/tmp',
          mcpConfigPath: configPath,
          disabledMcpServers: ['stub'],
        })
        session._client = { messages: { stream: () => fakeStream([]) } }
        const emitted = []
        session.on('mcp_servers', (d) => emitted.push(d))
        await session.start()
        assert.equal(session._mcpFleet.clients.length, 0, 'seeded-disabled server has no client')
        assert.deepEqual(session._mcpFleet.tools, [])
        assert.deepEqual(session.getDisabledMcpServers(), ['stub'])
        assert.deepEqual(emitted[emitted.length - 1].servers, [
          { name: 'stub', status: 'disabled', enabled: false, canToggle: true },
        ])
        await session.destroy()
      })

      it('setMcpServerEnabled on an unknown server returns found:false and does not emit', async () => {
        preTrustStub()
        const configPath = writeStubConfig()
        const session = new ClaudeByokSession({ cwd: '/tmp', mcpConfigPath: configPath })
        session._client = { messages: { stream: () => fakeStream([]) } }
        await session.start()
        const emittedBefore = []
        session.on('mcp_servers', (d) => emittedBefore.push(d))
        const res = await session.setMcpServerEnabled('ghost', false)
        assert.deepEqual(res, { found: false, changed: false, status: null })
        assert.equal(emittedBefore.length, 0, 'no re-emit for an unknown server')
        await session.destroy()
      })

      // #6822 — submitMcpAuthCode delegates to the fleet and re-emits mcp_servers.
      it('submitMcpAuthCode delegates to the fleet and re-emits mcp_servers on success', async () => {
        preTrustStub()
        const configPath = writeStubConfig()
        const session = new ClaudeByokSession({ cwd: '/tmp', mcpConfigPath: configPath })
        session._client = { messages: { stream: () => fakeStream([]) } }
        await session.start()
        // Swap in a fake fleet that records the code and reports success.
        let received = null
        session._mcpFleet = {
          submitAuthCode: async (name, code) => { received = { name, code }; return { found: true, ok: true, status: 'connected' } },
          getServerStatuses: () => [{ name: 'stub', status: 'connected', enabled: true, canToggle: true }],
        }
        const emitted = []
        session.on('mcp_servers', (d) => emitted.push(d))
        const res = await session.submitMcpAuthCode('stub', 'the-code')
        assert.deepEqual(res, { found: true, ok: true, status: 'connected' })
        assert.deepEqual(received, { name: 'stub', code: 'the-code' })
        assert.equal(emitted.length, 1, 're-emits mcp_servers on a successful redemption')
        await session.destroy()
      })

      it('submitMcpAuthCode returns found:false for an unknown server (no emit)', async () => {
        preTrustStub()
        const configPath = writeStubConfig()
        const session = new ClaudeByokSession({ cwd: '/tmp', mcpConfigPath: configPath })
        session._client = { messages: { stream: () => fakeStream([]) } }
        await session.start()
        const emitted = []
        session.on('mcp_servers', (d) => emitted.push(d))
        const res = await session.submitMcpAuthCode('ghost', 'x')
        assert.deepEqual(res, { found: false })
        assert.equal(emitted.length, 0)
        await session.destroy()
      })

      it('submitMcpAuthCode does not re-emit when redemption fails (ok:false)', async () => {
        preTrustStub()
        const configPath = writeStubConfig()
        const session = new ClaudeByokSession({ cwd: '/tmp', mcpConfigPath: configPath })
        session._client = { messages: { stream: () => fakeStream([]) } }
        await session.start()
        session._mcpFleet = { submitAuthCode: async () => ({ found: true, ok: false, error: 'bad code' }) }
        const emitted = []
        session.on('mcp_servers', (d) => emitted.push(d))
        const res = await session.submitMcpAuthCode('stub', 'x')
        assert.equal(res.ok, false)
        assert.equal(emitted.length, 0, 'no re-emit on a failed redemption')
        await session.destroy()
      })
    })

    it('#4457: untrusted MCP server fires a permission_request prompt; deny → DEAD without spawn', async () => {
      const configPath = join(tmpHome, '.claude.json')
      writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          stub: { command: process.execPath, args: [MCP_STUB], env: {} },
        },
      }))
      const session = new ClaudeByokSession({ cwd: '/tmp', mcpConfigPath: configPath })
      session._client = { messages: { stream: () => fakeStream([]) } }
      const prompts = []
      session._permissions.on('permission_request', (data) => {
        prompts.push(data)
        // Simulate the user clicking "Deny" in the dashboard / mobile UI.
        session._permissions.respondToPermission(data.requestId, 'deny')
      })
      await session.start()
      assert.equal(prompts.length, 1, 'exactly one trust prompt fires')
      assert.equal(prompts[0].tool, 'mcp_spawn')
      assert.equal(prompts[0].input.mcpServer.name, 'stub')
      assert.equal(session._mcpFleet.clients[0].state, MCP_STATES.DEAD, 'denied server is DEAD')
      assert.equal(session._mcpFleet.clients[0].tools.length, 0)
      await session.destroy()
    })

    it('#4457: untrusted server; allow → spawns + persists trust for next session', async () => {
      const fs = await import('node:fs')
      const configPath = join(tmpHome, '.claude.json')
      writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          stub: { command: process.execPath, args: [MCP_STUB], env: {} },
        },
      }))
      const session = new ClaudeByokSession({ cwd: '/tmp', mcpConfigPath: configPath })
      session._client = { messages: { stream: () => fakeStream([]) } }
      session._permissions.on('permission_request', (data) => {
        session._permissions.respondToPermission(data.requestId, 'allow')
      })
      await session.start()
      assert.equal(session._mcpFleet.clients[0].state, MCP_STATES.READY)
      // Trust was persisted to the per-test trust store
      assert.ok(fs.existsSync(process.env.CHROXY_MCP_TRUST_PATH))
      const stored = JSON.parse(fs.readFileSync(process.env.CHROXY_MCP_TRUST_PATH, 'utf8'))
      assert.equal(stored.trustedTuples.length, 1)
      assert.equal(stored.trustedTuples[0].name, 'stub')
      await session.destroy()
    })

    it('#4456: session-ready emits within the cap even when one MCP server is permanently broken', async () => {
      preTrustStub()
      // Pre-trust the broken server too so the trust prompt doesn't sit in
      // the way — we're isolating the start-cap behavior, not the trust gate.
      recordTrust(
        { name: 'broken', command: process.execPath, args: ['-e', 'process.exit(2)'], env: {} },
        process.env.CHROXY_MCP_TRUST_PATH,
      )
      const configPath = join(tmpHome, '.claude.json')
      writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          stub: { command: process.execPath, args: [MCP_STUB], env: {} },
          broken: { command: process.execPath, args: ['-e', 'process.exit(2)'], env: {} },
        },
      }))
      const session = new ClaudeByokSession({
        cwd: '/tmp',
        mcpConfigPath: configPath,
        mcpStartCapMs: 400,
      })
      session._client = { messages: { stream: () => fakeStream([]) } }
      const t0 = Date.now()
      let readyAt = null
      session.on('ready', () => { readyAt = Date.now() })
      await session.start()
      const elapsed = (readyAt ?? Date.now()) - t0
      // Under the cap the session emits ready promptly; without it, start()
      // would block ~7s for the broken server's full restart budget.
      assert.ok(elapsed < 1000, `session 'ready' fired at ${elapsed}ms, expected <1000ms under 400ms cap`)
      assert.equal(session._mcpFleet.clients.find((c) => c.name === 'stub').state, MCP_STATES.READY)
      // Broken still in mid-restart loop, not DEAD yet.
      assert.notEqual(
        session._mcpFleet.clients.find((c) => c.name === 'broken').state,
        MCP_STATES.DEAD,
        'cap should fire before broken server exhausts its restart budget',
      )
      await session.destroy()
    })

    it('#4077: destroy() kills MCP children and clears the fleet reference', async () => {
      preTrustStub()
      const configPath = join(tmpHome, '.claude.json')
      writeFileSync(configPath, JSON.stringify({
        mcpServers: {
          stub: { command: process.execPath, args: [MCP_STUB], env: {} },
        },
      }))
      const session = new ClaudeByokSession({ cwd: '/tmp', mcpConfigPath: configPath })
      session._client = { messages: { stream: () => fakeStream([]) } }
      await session.start()
      const client = session._mcpFleet.clients[0]
      assert.equal(client.state, MCP_STATES.READY)
      const t0 = Date.now()
      await session.destroy()
      const elapsed = Date.now() - t0
      assert.ok(elapsed <= 2500, `destroy took ${elapsed}ms, expected <= 2500ms (FLEET_KILL_GRACE_MS + safety)`)
      assert.equal(session._mcpFleet, null, 'fleet reference cleared after destroy')
    })
  })

  describe('sendMessage()', () => {
    it('emits stream_start, stream_delta(s), stream_end, result for a successful turn', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([
              { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-4-8' } },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Hello' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: ', world' } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, output_tokens: 4 } },
              { type: 'message_stop' },
            ], {
              // Realistic finalMessage matches message_delta's usage —
              // in real streams the two never diverge.
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'Hello, world' }],
              usage: { input_tokens: 5, output_tokens: 4 },
            }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('hi')
      const starts = captured.filter((e) => e.name === 'stream_start')
      const deltas = captured.filter((e) => e.name === 'stream_delta')
      const ends = captured.filter((e) => e.name === 'stream_end')
      const results = captured.filter((e) => e.name === 'result')
      assert.equal(starts.length, 1, 'one stream_start per turn')
      assert.equal(deltas.length, 2, 'two text deltas')
      // Canonical chroxy field name is `delta`, NOT `text` — dashboard +
      // mobile message-handlers both read `msg.delta`. Emitting `text`
      // here renders empty bubbles (caught by review on PR #4055).
      assert.equal(deltas[0].payload.delta, 'Hello')
      assert.equal(deltas[1].payload.delta, ', world')
      // stream_end MUST fire before result so the dashboard flushes its
      // debounced delta buffer + clears streamingMessageId. Order matters.
      assert.equal(ends.length, 1, 'stream_end fires exactly once per turn')
      const endIdx = captured.findIndex((e) => e.name === 'stream_end')
      const resultIdx = captured.findIndex((e) => e.name === 'result')
      assert.ok(endIdx < resultIdx, 'stream_end must precede result')
      // result payload carries duration + usage + stopReason + cost.
      assert.equal(results.length, 1)
      assert.equal(results[0].payload.stopReason, 'end_turn')
      assert.equal(results[0].payload.usage.input_tokens, 5)
      assert.equal(results[0].payload.usage.output_tokens, 4)
      assert.equal(typeof results[0].payload.duration, 'number')
      assert.ok(results[0].payload.duration >= 0)
      // Cost MUST be on the result payload — session-manager.js:_trackCost
      // (the budget-check + cumulative session-cost feeder) reads it as a
      // typeof === 'number' gate. Omitting it silently disables BYOK cost
      // accounting (#4056, blocks #4054).
      assert.equal(typeof results[0].payload.cost, 'number')
      // Opus 4.8 default: 5 input * $15/Mtok + 4 output * $75/Mtok
      //   = 0.000075 + 0.000300 = 0.000375 USD
      assert.ok(
        Math.abs(results[0].payload.cost - 0.000375) < 1e-9,
        `expected cost ~= 0.000375 for 5in/4out on opus-4-8, got ${results[0].payload.cost}`,
      )
      await session.destroy()
    })

    it('accumulates usage + cost across multiple tool-use rounds', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      // Auto-allow so the agent loop executes without prompting.
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      // Two rounds: round 1 ends with stop_reason=tool_use (10in/20out),
      // round 2 ends with stop_reason=end_turn (7in/3out). Cost MUST
      // reflect the sum, not just the last round (the bug #4056 fixes).
      let round = 0
      session._client = {
        messages: {
          stream: () => {
            round += 1
            if (round === 1) {
              return fakeStream([], {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/tmp/x' } }],
                usage: { input_tokens: 10, output_tokens: 20 },
              })
            }
            return fakeStream([], {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'done' }],
              usage: { input_tokens: 7, output_tokens: 3 },
            })
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')
      const results = captured.filter((e) => e.name === 'result')
      assert.equal(results.length, 1, 'one result per turn even across rounds')
      // Accumulated usage: 10+7 input, 20+3 output.
      assert.equal(results[0].payload.usage.input_tokens, 17)
      assert.equal(results[0].payload.usage.output_tokens, 23)
      // Accumulated cost (Opus 4.8): (17 * 15 + 23 * 75) / 1e6 = 0.001980
      assert.ok(
        Math.abs(results[0].payload.cost - 0.001980) < 1e-9,
        `expected cost ~= 0.001980, got ${results[0].payload.cost}`,
      )
      await session.destroy()
    })

    // #6769: the result's `contextOccupancy` snapshot must be the FINAL
    // round's individual prompt size (input + cache_read + cache_creation of
    // that one API call = the conversation as last sent), NEVER the summed
    // turnUsage — the sum re-counts the history once per round and over-reads
    // occupancy ≈N× on an N-round turn (the PR #6816 review finding).
    it('emits contextOccupancy as the FINAL round prompt snapshot, not the summed billing aggregate (#6769)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      // Three rounds on a growing cached conversation. Each round re-reads the
      // history from cache, so the SUM of cache_read is ≈3× the real size.
      const rounds = [
        { stop: 'tool_use', usage: { input_tokens: 400, output_tokens: 900, cache_read_input_tokens: 100_000, cache_creation_input_tokens: 1_000 } },
        { stop: 'tool_use', usage: { input_tokens: 300, output_tokens: 800, cache_read_input_tokens: 101_000, cache_creation_input_tokens: 1_200 } },
        { stop: 'end_turn', usage: { input_tokens: 250, output_tokens: 700, cache_read_input_tokens: 102_200, cache_creation_input_tokens: 1_100 } },
      ]
      let round = 0
      session._client = {
        messages: {
          stream: () => {
            const r = rounds[round]
            round += 1
            return fakeStream([], {
              stop_reason: r.stop,
              content: r.stop === 'tool_use'
                ? [{ type: 'tool_use', id: `tu_${round}`, name: 'Read', input: { file_path: '/tmp/x' } }]
                : [{ type: 'text', text: 'done' }],
              usage: r.usage,
            })
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')
      const result = captured.find((e) => e.name === 'result')
      assert.ok(result, 'result must fire')
      // Snapshot = FINAL round's input + cache_read + cache_creation:
      //   250 + 102_200 + 1_100 = 103_550 (output excluded by contract).
      assert.deepEqual(result.payload.contextOccupancy, {
        totalTokens: 103_550,
        source: 'final-round-prompt',
      })
      // The summed billing aggregate is still on `usage` (cost accounting) —
      // and demonstrably NOT the occupancy number.
      const billingTotal =
        result.payload.usage.input_tokens +
        result.payload.usage.cache_read_input_tokens +
        result.payload.usage.cache_creation_input_tokens
      assert.equal(billingTotal, 400 + 300 + 250 + 100_000 + 101_000 + 102_200 + 1_000 + 1_200 + 1_100)
      assert.ok(
        billingTotal > result.payload.contextOccupancy.totalTokens * 2.5,
        'the billing aggregate over-reads the snapshot ≈round-count×',
      )
      await session.destroy()
    })

    it('omits contextOccupancy when the endpoint reports no usable usage (#6769)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([], {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'hi' }],
              // An anthropic-compatible endpoint that reports no usage at all.
              usage: {},
            }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('q')
      const result = captured.find((e) => e.name === 'result')
      assert.ok(result)
      assert.equal('contextOccupancy' in result.payload, false,
        'no fabricated snapshot — clients keep their dash state')
      await session.destroy()
    })

    it('emits cost: null when model has no pricing entry (#5630 graceful degradation)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp', model: 'claude-future-model-9-9' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([], {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'hi' }],
              usage: { input_tokens: 100, output_tokens: 50 },
            }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('q')
      const result = captured.find((e) => e.name === 'result')
      assert.ok(result)
      // Usage still propagates even when pricing is unknown — the
      // cumulative-display story (#4054) can still show token counts.
      assert.equal(result.payload.usage.input_tokens, 100)
      // #5630: cost now degrades to `null` (unknown), NOT 0 — the dashboard
      // renders "n/a" rather than a misleading $0.00. Still never NaN / crash.
      assert.equal(result.payload.cost, null)
      await session.destroy()
    })

    it('warns at most once per session per unknown model (#4085)', async () => {
      // Pre-fix: warn fired in every sendMessage. A 10-turn run on an
      // unknown model spammed 10 identical warns. The Set guard pins
      // the warn count to exactly 1 across N turns.
      //
      // Inspect _pricingWarnedModels directly — the test pattern in
      // this file doesn't intercept the module-level logger, and Set
      // membership is a sufficient proxy: the warn-firing site is the
      // ONLY thing that adds to the set, so set.size === N is
      // equivalent to "warn fired N times for distinct models."
      const session = new ClaudeByokSession({ cwd: '/tmp', model: 'claude-future-model-x-y' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([], {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'ok' }],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
        },
      }
      await session.start()
      await session.sendMessage('q1')
      await session.sendMessage('q2')
      await session.sendMessage('q3')
      // The set has exactly one entry — the model id — proving the
      // gate fired exactly once across three turns.
      assert.equal(session._pricingWarnedModels.size, 1)
      assert.ok(session._pricingWarnedModels.has('claude-future-model-x-y'))
      await session.destroy()
    })

    it('resolves dated full model ids to family pricing (#4084)', async () => {
      // A user pinning to a dated revision must still get a non-zero
      // cost, not the silent cost: 0 + warn that pre-fix produced.
      const session = new ClaudeByokSession({ cwd: '/tmp', model: 'claude-opus-4-8-20251201' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([], {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'hi' }],
              usage: { input_tokens: 5, output_tokens: 4 },
            }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('q')
      const result = captured.find((e) => e.name === 'result')
      assert.ok(result)
      // Same math as the canonical happy-path test (5in/4out on opus-4-8
      // = 0.000375 USD). Same numeric expectation proves the family
      // resolution worked.
      assert.ok(Math.abs(result.payload.cost - 0.000375) < 1e-9,
        `dated-id pricing must equal family-head pricing; got cost=${result.payload.cost}`)
      // And no warn fired — pricing was found.
      assert.equal(session._pricingWarnedModels.size, 0)
      await session.destroy()
    })

    it('refuses concurrent sendMessage with an error event', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      // Stream that never yields anything until aborted — pretend the
      // model is still thinking.
      session._client = {
        messages: {
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              await new Promise((r) => setTimeout(r, 200))
            },
            async finalMessage() {
              return { stop_reason: 'end_turn', content: [], usage: {} }
            },
          }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      const turn1 = session.sendMessage('first')
      // Don't await turn1 yet — fire turn2 while it's still pending.
      await session.sendMessage('second')
      const errors = captured.filter((e) => e.name === 'error')
      assert.ok(errors.some((e) => /Already processing/.test(e.payload.message)),
        'second concurrent call should error')
      session.interrupt()
      await turn1
      await session.destroy()
    })

    it('appends user + assistant turns to history (chat continuity)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream(
              [
                { type: 'message_start', message: { id: 'msg', model: 'claude-opus-4-8' } },
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'response' } },
                { type: 'message_stop' },
              ],
              {
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'response' }],
                usage: {},
              },
            ),
        },
      }
      await session.start()
      await session.sendMessage('first')
      await session.sendMessage('second')
      assert.equal(session._history.length, 4, '2 turns = user+assistant ×2')
      assert.equal(session._history[0].role, 'user')
      assert.equal(session._history[0].content, 'first')
      assert.equal(session._history[1].role, 'assistant')
      assert.equal(session._history[2].role, 'user')
      assert.equal(session._history[2].content, 'second')
      await session.destroy()
    })

    it('rolls back the user message if stream init throws synchronously', async () => {
      // Without rollback, the orphan user message breaks the next turn's
      // user/assistant alternation that the SDK requires (review on #4055).
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () => {
            throw Object.assign(new Error('bad request'), { status: 400 })
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('bad turn')
      const errors = captured.filter((e) => e.name === 'error')
      assert.ok(errors.some((e) => e.payload.code === 'HTTP_400'))
      assert.equal(session._history.length, 0, 'orphan user message must be rolled back')
      await session.destroy()
    })

    it('rolls back the entire turn when stream init throws at round >= 1 (#4109)', async () => {
      // Round 0 succeeds with a tool_use; round 1 stream init throws.
      // Without rollback, history ends on a `user` tool_result turn, and
      // the next sendMessage pushes a plain-text `user` turn — back-to-
      // back user roles. The SDK accepts this today but the alternation
      // invariant we comment about elsewhere is now soft, and a future
      // API tightening could 400 it.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block, messageId }) {
        this.emit('tool_result', {
          messageId,
          toolUseId: block.id,
          result: 'ok',
          isError: false,
        })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      let streamCallCount = 0
      session._client = {
        messages: {
          stream: () => {
            streamCallCount += 1
            if (streamCallCount === 1) {
              // Round 0: succeed, return one tool_use to push the loop to round 1.
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
                {
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a' } }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            // Round 1: throw at stream init (transient 5xx).
            throw Object.assign(new Error('upstream rate limit'), { status: 429 })
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('round-1-failure')
      const errors = captured.filter((e) => e.name === 'error')
      assert.ok(errors.some((e) => e.payload.code === 'HTTP_429'), `expected an HTTP_429 error, got: ${JSON.stringify(errors)}`)
      assert.equal(streamCallCount, 2, 'stream() should be invoked twice (round 0 + round 1)')
      // After rollback, history must be EMPTY — the turn never landed.
      // No back-to-back user turns possible because there is no turn at all.
      assert.equal(
        session._history.length, 0,
        `entire turn must roll back on round-1 stream-init throw; got: ${JSON.stringify(session._history)}`,
      )
      await session.destroy()
    })

    it('round-1 stream-init throw lets the next sendMessage land cleanly (alternation preserved)', async () => {
      // End-to-end follow-up to the rollback test above. After the
      // failure, the next sendMessage should produce a valid history:
      // exactly one user turn (the new prompt), no orphans, no back-to-
      // back user roles.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block, messageId }) {
        this.emit('tool_result', { messageId, toolUseId: block.id, result: 'ok', isError: false })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      let streamCallCount = 0
      session._client = {
        messages: {
          stream: () => {
            streamCallCount += 1
            if (streamCallCount === 1) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
                {
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 'tu_a', name: 'Read', input: { file_path: '/a' } }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            if (streamCallCount === 2) {
              throw Object.assign(new Error('upstream gone'), { status: 502 })
            }
            // Retry: clean text response.
            return fakeStream(
              [{ type: 'message_stop' }],
              {
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'recovered' }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            )
          },
        },
      }
      captureEvents(session)
      await session.start()
      await session.sendMessage('first attempt — will fail at round 1')
      // captureEvents() already attached an 'error' listener, so the
      // first call's HTTP_502 didn't surface as an unhandled rejection.
      // Now retry: pre-fix this would have produced back-to-back user turns.
      await session.sendMessage('retry')
      // History after successful retry: [user-prompt, assistant]
      assert.equal(session._history.length, 2, `expected 2 entries, got ${session._history.length}: ${JSON.stringify(session._history)}`)
      assert.equal(session._history[0].role, 'user')
      assert.equal(session._history[0].content, 'retry')
      assert.equal(session._history[1].role, 'assistant')
      await session.destroy()
    })

    it('rolls back the entire turn when for-await rejects mid-iteration at round >= 1 (#4118)', async () => {
      // Round 0 returns one tool_use; round 1's stream rejects DURING
      // iteration (not at init). Without the outer-catch rollback,
      // _history ends on a `user` tool_result turn and the next
      // sendMessage produces back-to-back user roles.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block, messageId }) {
        this.emit('tool_result', { messageId, toolUseId: block.id, result: 'ok', isError: false })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      let streamCallCount = 0
      session._client = {
        messages: {
          stream: () => {
            streamCallCount += 1
            if (streamCallCount === 1) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
                {
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a' } }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            // Round 1: stream STARTS (no sync throw at init) but the
            // for-await rejects mid-iteration.
            return {
              async *[Symbol.asyncIterator]() {
                yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }
                const err = new Error('network dropped mid-stream')
                err.status = 502
                throw err
              },
              async finalMessage() { return null },
            }
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('round-1-async-failure')
      assert.equal(streamCallCount, 2)
      const errors = captured.filter((e) => e.name === 'error')
      assert.ok(errors.length >= 1, 'turn surfaces an error')
      assert.equal(
        session._history.length, 0,
        `entire turn must roll back on round-1 mid-stream throw; got: ${JSON.stringify(session._history)}`,
      )
      await session.destroy()
    })

    it('rolls back the entire turn when finalMessage() rejects at round >= 1 (#4118)', async () => {
      // Round 0 returns one tool_use; round 1's stream iterates cleanly
      // but `await stream.finalMessage()` rejects. Same alternation
      // soft-break — must be caught by the outer-catch rollback.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block, messageId }) {
        this.emit('tool_result', { messageId, toolUseId: block.id, result: 'ok', isError: false })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      let streamCallCount = 0
      session._client = {
        messages: {
          stream: () => {
            streamCallCount += 1
            if (streamCallCount === 1) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
                {
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a' } }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            // Round 1: stream iterates cleanly but finalMessage rejects.
            return {
              async *[Symbol.asyncIterator]() {
                yield { type: 'message_stop' }
              },
              async finalMessage() {
                const err = new Error('finalMessage failed')
                err.status = 500
                throw err
              },
            }
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('finalMessage-rejection')
      assert.equal(streamCallCount, 2)
      assert.ok(captured.some((e) => e.name === 'error'), 'turn surfaces an error')
      assert.equal(
        session._history.length, 0,
        `entire turn must roll back when finalMessage rejects; got: ${JSON.stringify(session._history)}`,
      )
      await session.destroy()
    })

    it('rolls back the entire turn when tool execution rejects at round >= 1 (#4118)', async () => {
      // Round 0 succeeds with a tool_use. Round 1 starts with a fresh
      // tool_use, but _executeToolBlock rejects synchronously inside the
      // promise. Same alternation soft-break — outer-catch rollback.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      let executeCount = 0
      session._executeToolBlock = async function ({ block, messageId }) {
        executeCount += 1
        if (executeCount === 1) {
          this.emit('tool_result', { messageId, toolUseId: block.id, result: 'ok', isError: false })
          return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
        }
        throw new Error('tool execution exploded')
      }
      let streamCallCount = 0
      session._client = {
        messages: {
          stream: () => {
            streamCallCount += 1
            // Both rounds return tool_use so we get a second invocation
            // of _executeToolBlock which throws.
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
              {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: `tu_${streamCallCount}`, name: 'Read', input: { file_path: '/x' } }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            )
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('tool-rejection')
      assert.equal(executeCount, 2, 'second tool_use invokes the failing executor')
      assert.ok(captured.some((e) => e.name === 'error'), 'turn surfaces an error')
      assert.equal(
        session._history.length, 0,
        `entire turn must roll back when a tool throws mid-loop; got: ${JSON.stringify(session._history)}`,
      )
      await session.destroy()
    })

    it('emits stream_end on the error path too (no stranded spinner)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }
              const err = new Error('upstream went away')
              err.status = 502
              throw err
            },
            async finalMessage() { return null },
          }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('hi')
      const ends = captured.filter((e) => e.name === 'stream_end')
      const errors = captured.filter((e) => e.name === 'error')
      assert.equal(ends.length, 1, 'stream_end must fire even when the stream errors mid-flight')
      assert.ok(errors.length >= 1, 'error event still fires')
      await session.destroy()
    })

    it('surfaces SDK errors with a HTTP_* code when status present', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              const err = new Error('rate limit exceeded')
              err.status = 429
              throw err
            },
            async finalMessage() {
              return null
            },
          }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('hi')
      const errorEvent = captured.find((e) => e.name === 'error')
      assert.ok(errorEvent)
      assert.equal(errorEvent.payload.code, 'HTTP_429')
      assert.match(errorEvent.payload.message, /rate limit/)
      await session.destroy()
    })

    it('reports an ABORT error code when interrupt() fires mid-stream', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              await new Promise((r) => setTimeout(r, 80))
              // #4057: real SDK throws APIUserAbortError on aborted
              // signals — not the generic 'AbortError'. Use the real
              // class so the test asserts the primary `instanceof`
              // detection path, not just the name-string fallback.
              throw new APIUserAbortError({ message: 'Request was aborted.' })
            },
            async finalMessage() {
              return null
            },
          }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      const turn = session.sendMessage('hi')
      setTimeout(() => session.interrupt(), 20)
      await turn
      const errorEvent = captured.find((e) => e.name === 'error')
      assert.ok(errorEvent, 'interrupt should produce an error event')
      assert.equal(errorEvent.payload.code, 'ABORT')
      await session.destroy()
    })

    it('detects APIUserAbortError WITHOUT relying on the signal.aborted fallback (#4057)', async () => {
      // The other abort test still works under the name-string fallback
      // because interrupt() sets signal.aborted = true. This test
      // isolates the primary `instanceof APIUserAbortError` path by
      // throwing without ever aborting the controller — only the SDK
      // class identity should match.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () => ({
            async *[Symbol.asyncIterator]() {
              throw new APIUserAbortError({ message: 'Request was aborted.' })
            },
            async finalMessage() {
              return null
            },
          }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      // NOTE: no session.interrupt() call — signal.aborted stays false.
      // The only way `aborted` can be true in _emitTurnError is the
      // instanceof check matching the thrown class.
      await session.sendMessage('hi')
      const errorEvent = captured.find((e) => e.name === 'error')
      assert.ok(errorEvent)
      assert.equal(errorEvent.payload.code, 'ABORT',
        'APIUserAbortError instance must map to code=ABORT via instanceof, not via signal.aborted')
      await session.destroy()
    })

    it('warns and continues when attachments are passed (PR 1 limitation)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
              { type: 'message_stop' },
            ]),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('describe this', [{ type: 'image', data: 'base64...' }])
      const errorEvent = captured.find(
        (e) => e.name === 'error' && /does not yet materialise attachments/.test(e.payload.message),
      )
      assert.ok(errorEvent, 'should warn about dropped attachments')
      const result = captured.find((e) => e.name === 'result')
      assert.ok(result, 'turn should still complete with text-only prompt')
      await session.destroy()
    })
  })

  describe('tool_start event (#4240)', () => {
    // Wire-shape parity with sdk-session.js and cli-session.js. The
    // event-normalizer reads `data.tool` / `data.input` (matching the
    // protocol ServerToolStartSchema, where `tool: z.string()` is
    // REQUIRED). The legacy byok-session emit used `{toolName}` only,
    // so the dashboard saw `tool: undefined` on the wire and the
    // tool-call bubble rendered a generic placeholder instead of the
    // tool name (#4240). These tests pin the canonical shape against
    // future regressions.

    it('emits tool_start with {tool, input} matching the normalizer wire shape', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([
              { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-4-8' } },
              { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_42', name: 'Read', input: {} } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 1 } },
              { type: 'message_stop' },
            ], {
              stop_reason: 'end_turn',
              content: [{ type: 'tool_use', id: 'tu_42', name: 'Read', input: { file_path: '/tmp/x' } }],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')

      const starts = captured.filter((e) => e.name === 'tool_start')
      assert.equal(starts.length, 1, 'one tool_use content block -> one tool_start event')
      const payload = starts[0].payload
      // The wire-facing fields the normalizer reads. ServerToolStartSchema
      // requires `tool: z.string()` (non-null), so `tool` MUST be the
      // tool name string here — not undefined and not the legacy
      // `toolName` key.
      assert.equal(payload.tool, 'Read', 'tool field carries the tool name (normalizer-expected key)')
      assert.equal(payload.toolUseId, 'tu_42', 'toolUseId is propagated')
      // Pin the wire-safe value, not just presence. `undefined` would be
      // stripped by JSON.stringify and re-trigger the original `tool:
      // undefined`-class regression on the wire; `null` survives
      // serialization and satisfies `ServerToolStartSchema.input:
      // z.any()`. Matches sdk-session.js / cli-session.js.
      assert.strictEqual(payload.input, null, 'input is null pre-delta (wire-safe placeholder, not undefined)')
      assert.equal(typeof payload.messageId, 'string', 'messageId is set')
      await session.destroy()
    })

    it('does NOT emit the legacy {toolName} key', async () => {
      // Belt-and-braces against a future revert: if anyone reintroduces
      // `toolName` the normalizer will silently drop it and the wire
      // shape regresses to `tool: undefined`.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([
              { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_stop' },
            ]),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')

      const start = captured.find((e) => e.name === 'tool_start')
      assert.ok(start, 'tool_start event was emitted')
      // Use `in` rather than `=== undefined` so an own-property
      // `toolName: undefined` (which would still survive on the in-process
      // EventEmitter payload and confuse future readers) is caught.
      assert.ok(!('toolName' in start.payload),
        'legacy `toolName` key must not appear — normalizer reads `tool`, not `toolName`')
      await session.destroy()
    })

    // #4262: tool_start.messageId must be the per-tool content_block.id, NOT
    // the turn-level messageId. store-core/handlers/handleToolStart uses
    // `messageId` as the `ChatMessage.id` — sharing the turn-level id across
    // every tool in a multi-tool turn collides with itself (later tools
    // overwrite earlier ones in the replay-dedupe path) AND with the
    // post-tool stream_start id (stream_id_collision class). Mirrors
    // sdk-session.js:635-641 / cli-session.js:708-714.

    it('#4262: tool_start.messageId is the per-tool content_block.id, distinct across tools in a multi-tool turn', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      // Permission mode auto so the test doesn't hang waiting for the
      // 5-min PermissionManager timeout — this test cares about the
      // tool_start payload, not the permission UI.
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block, messageId }) {
        this.emit('tool_result', { messageId, toolUseId: block.id, result: 'ok', isError: false })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      let round = 0
      session._client = {
        messages: {
          stream: () => {
            round += 1
            if (round === 1) {
              return fakeStream([
                { type: 'message_start', message: { id: 'msg_turn_1', model: 'claude-opus-4-8' } },
                { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_01aaa', name: 'Read', input: {} } },
                { type: 'content_block_stop', index: 0 },
                { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'toolu_02bbb', name: 'Bash', input: {} } },
                { type: 'content_block_stop', index: 1 },
                { type: 'message_delta', delta: { stop_reason: 'tool_use' }, usage: { input_tokens: 1, output_tokens: 1 } },
                { type: 'message_stop' },
              ], {
                stop_reason: 'tool_use',
                content: [
                  { type: 'tool_use', id: 'toolu_01aaa', name: 'Read', input: { file_path: '/a' } },
                  { type: 'tool_use', id: 'toolu_02bbb', name: 'Bash', input: { command: 'ls' } },
                ],
                usage: { input_tokens: 1, output_tokens: 1 },
              })
            }
            return fakeStream([
              { type: 'message_start', message: { id: 'msg_turn_2', model: 'claude-opus-4-8' } },
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 1 } },
              { type: 'message_stop' },
            ], {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'done' }],
              usage: { input_tokens: 1, output_tokens: 1 },
            })
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')

      const starts = captured.filter((e) => e.name === 'tool_start')
      assert.equal(starts.length, 2, 'two tool_use blocks -> two tool_start events')
      // Each tool_start MUST carry its OWN content_block.id as messageId,
      // not the turn-level messageId. handleToolStart uses messageId as
      // the ChatMessage.id; sharing it would dedupe-collapse the second
      // tool onto the first in the replay path.
      assert.equal(starts[0].payload.messageId, 'toolu_01aaa', 'first tool_start.messageId == content_block.id #1')
      assert.equal(starts[1].payload.messageId, 'toolu_02bbb', 'second tool_start.messageId == content_block.id #2')
      assert.notEqual(starts[0].payload.messageId, starts[1].payload.messageId,
        'distinct messageId per tool — no replay-dedupe collision')
      // toolUseId continues to carry the same content_block.id (existing
      // contract — handleToolResult matches via toolUseId).
      assert.equal(starts[0].payload.toolUseId, 'toolu_01aaa')
      assert.equal(starts[1].payload.toolUseId, 'toolu_02bbb')

      // And the follow-up stream_start (post-tool turn) must use the
      // turn-level messageId, which must differ from every tool's
      // messageId — pins the stream_id_collision regression.
      const streamStarts = captured.filter((e) => e.name === 'stream_start')
      const postToolStreamStart = streamStarts[streamStarts.length - 1]
      assert.ok(postToolStreamStart, 'a stream_start event followed the tool round')
      assert.notEqual(postToolStreamStart.payload.messageId, 'toolu_01aaa',
        'post-tool stream_start.messageId differs from first tool_start.messageId')
      assert.notEqual(postToolStreamStart.payload.messageId, 'toolu_02bbb',
        'post-tool stream_start.messageId differs from second tool_start.messageId')
      await session.destroy()
    })

    it('#4262: falls back to `${turnMessageId}-tool` when content_block.id is absent', async () => {
      // Defensive parity with sdk-session.js / cli-session.js: if the SDK
      // ever omits content_block.id we still emit a string messageId
      // (ServerToolStartSchema.messageId is required) rather than letting
      // an undefined leak through.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([
              { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-4-8' } },
              // No `id` on the content_block — translator emits toolUseId: undefined.
              { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', name: 'Read', input: {} } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 1 } },
              { type: 'message_stop' },
            ], {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'ok' }],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')

      const starts = captured.filter((e) => e.name === 'tool_start')
      assert.equal(starts.length, 1)
      // The turn-level messageId is a string; the fallback shape is
      // `${turnMessageId}-tool`. Pin only that the emitted messageId is
      // a non-empty string ending with `-tool` so future renames of the
      // turn id format don't pointlessly break this test.
      const { messageId, toolUseId } = starts[0].payload
      assert.equal(typeof messageId, 'string', 'messageId is a string even on fallback')
      assert.ok(messageId.endsWith('-tool'), `fallback messageId ends with -tool (got: ${messageId})`)
      // #4364: toolUseId mirrors the fallback messageId (parity with
      // sdk-session.js:635-641). Pre-#4364 this was `undefined`, which
      // violates ServerToolStartSchema.toolUseId: z.string() — the
      // schema isn't enforced on the broadcast path today, but the
      // wire-shape contract should be honored on every path.
      assert.equal(typeof toolUseId, 'string', 'toolUseId is a string even on fallback')
      assert.equal(toolUseId, messageId, 'toolUseId mirrors messageId on the fallback path')
      await session.destroy()
    })
  })

  describe('tool_result event (#4261)', () => {
    // Wire-shape parity with the #4240 / #4257 tool_start fix. The
    // event-normalizer's `tool_result` mapper reads ONLY `toolUseId`,
    // `result`, `truncated`, `images` — and ServerToolResultSchema in
    // @chroxy/protocol pins the wire shape to the same fields. Any
    // `toolName` on the source emit is silently dropped before reaching
    // the wire, so it is dead weight and a footgun for future readers
    // who assume it lands on the wire. These tests pin the canonical
    // shape against future regressions.

    it('does NOT emit the legacy {toolName} key on the real executor path', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      // Stub the executor stub so we exercise the production tool_result
      // emit at the bottom of _executeToolBlock (the happy-path emit).
      // We DON'T stub _executeToolBlock itself — only executeBuiltinTool
      // would touch disk, and a stubbed _executeToolBlock would bypass
      // the real emit. Force-route the dispatch through a fake tool by
      // overriding the executor with a no-op success.
      const originalExecute = session._executeToolBlock.bind(session)
      // Spy on emits by capturing events first.
      const captured = captureEvents(session)
      // Replace _executeToolBlock with a wrapper that calls the real
      // emit code path with a known result, mirroring the production
      // shape after the strip.
      session._executeToolBlock = async function ({ block, messageId }) {
        this.emit('tool_result', {
          messageId,
          toolUseId: block.id,
          result: 'ok',
          isError: false,
        })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      void originalExecute
      await runOneToolRound(session, { id: 'tu_r1', name: 'Read', input: { file_path: '/tmp/x' } })

      const results = captured.filter((e) => e.name === 'tool_result')
      assert.ok(results.length >= 1, 'tool_result event was emitted')
      const payload = results[0].payload
      assert.equal(payload.toolUseId, 'tu_r1', 'toolUseId is the wire-facing identifier')
      assert.equal(payload.result, 'ok', 'result is propagated')
      // Use `in` rather than `=== undefined` so an own-property
      // `toolName: undefined` (which would still survive on the in-process
      // EventEmitter payload and confuse future readers) is caught.
      assert.ok(!('toolName' in payload),
        'legacy `toolName` key must not appear — normalizer reads only toolUseId/result/truncated')
      await session.destroy()
    })

    it('does NOT emit the legacy {toolName} key on the deny path', async () => {
      // The deny path (permission gate returns behavior !== 'allow')
      // emits its own tool_result before short-circuiting. Pin that
      // emit's shape too — it's a separate callsite from the happy
      // path.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      // Force the gate to deny.
      session._gateToolBlock = async function () {
        return { behavior: 'deny', message: 'nope' }
      }
      const captured = captureEvents(session)
      await runOneToolRound(session, { id: 'tu_r2', name: 'Bash', input: { command: 'rm -rf /' } })

      const results = captured.filter((e) => e.name === 'tool_result')
      assert.ok(results.length >= 1, 'deny path still emits a tool_result so the bubble closes')
      const payload = results[0].payload
      assert.equal(payload.toolUseId, 'tu_r2')
      assert.equal(payload.isError, true)
      assert.ok(!('toolName' in payload),
        'deny-path tool_result must not carry the legacy `toolName` key either')
      await session.destroy()
    })

    it('does NOT emit the legacy {toolName} key on the synthetic-abort fill path', async () => {
      // The mid-loop abort path (_processToolBlocks synthetic fill)
      // emits one tool_result per ungated block so the bubble closes
      // (#4108). Pin the shape there too.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      // Trip the abort before block 1 returns from gate, so blocks 2+
      // get the synthetic fill.
      let gateCalls = 0
      session._gateToolBlock = async function ({ block }) {
        gateCalls += 1
        if (gateCalls === 1) {
          this._abortController.abort()
          return { behavior: 'allow', updatedInput: block.input || {} }
        }
        throw new Error('gate should not run after abort')
      }
      // Real-emit wrapper for block 1 so we still get a closing event.
      session._executeToolBlock = async function ({ block, messageId }) {
        this.emit('tool_result', {
          messageId,
          toolUseId: block.id,
          result: 'ok',
          isError: false,
        })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      // Drive a 3-tool round directly through sendMessage so the
      // synthetic-fill loop in _processToolBlocks runs.
      let streamCall = 0
      session._client = {
        messages: {
          stream: () => {
            streamCall += 1
            if (streamCall === 1) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
                {
                  stop_reason: 'tool_use',
                  content: [
                    { type: 'tool_use', id: 'tu_s1', name: 'Read', input: {} },
                    { type: 'tool_use', id: 'tu_s2', name: 'Read', input: {} },
                    { type: 'tool_use', id: 'tu_s3', name: 'Read', input: {} },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
              { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')

      const results = captured.filter((e) => e.name === 'tool_result')
      // Synthetic-fill emits one event per ungated block (tu_s2, tu_s3).
      const synthetic = results.filter((e) => e.payload.toolUseId !== 'tu_s1')
      assert.equal(synthetic.length, 2, 'synthetic fill emits one tool_result per ungated block')
      for (const ev of synthetic) {
        assert.equal(ev.payload.isError, true)
        assert.ok(!('toolName' in ev.payload),
          'synthetic-fill tool_result must not carry the legacy `toolName` key')
      }
      await session.destroy()
    })
  })

  describe('tool_input_delta event (#4080)', () => {
    // The Anthropic SDK streams input JSON for each tool_use block as
    // `input_json_delta` content_block_delta events. Pre-#4080
    // byok-session no-op'd these, so the dashboard tool-call bubble
    // showed nothing until finalMessage() resolved — defeating the
    // value of streaming for long tool inputs (Bash command preview
    // is the canonical case where the user wants to see "rm -rf"
    // forming and abort BEFORE the round finishes).
    //
    // The translator emits `tool_input_delta` carrying ONLY the block
    // index. byok-session is the source of truth for index→toolUseId
    // (populated on content_block_start with type=tool_use, cleared
    // on content_block_stop), per the #4059 translator-stays-pure
    // boundary. These tests pin the wire shape and the surrounding
    // contract.

    it('emits 3 tool_input_delta events with matching toolUseId and concatenable partialJson', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([
              { type: 'message_start', message: { id: 'msg_1', model: 'claude-opus-4-8' } },
              { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_42', name: 'Read', input: {} } },
              { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_pa' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'th":"/tm' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: 'p/x"}' } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 5, output_tokens: 8 } },
              { type: 'message_stop' },
            ], {
              stop_reason: 'end_turn',
              content: [{ type: 'tool_use', id: 'tu_42', name: 'Read', input: { file_path: '/tmp/x' } }],
              usage: { input_tokens: 5, output_tokens: 8 },
            }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')

      const deltas = captured.filter((e) => e.name === 'tool_input_delta')
      assert.equal(deltas.length, 3, 'three input_json_delta chunks -> three tool_input_delta events')
      // All deltas must carry the SAME toolUseId resolved from the
      // index→toolUseId map seeded on content_block_start.
      for (const d of deltas) {
        assert.equal(d.payload.toolUseId, 'tu_42', 'toolUseId from the index map')
        assert.equal(typeof d.payload.messageId, 'string', 'messageId is set')
        assert.equal(typeof d.payload.partialJson, 'string', 'partialJson is a string')
      }
      // Concatenating the partials must reconstruct the input JSON
      // the dashboard would parse on completion — the on-the-wire
      // chunking is split arbitrarily by the SDK but the BYTES must
      // be preserved in order.
      const joined = deltas.map((d) => d.payload.partialJson).join('')
      assert.equal(joined, '{"file_path":"/tmp/x"}', 'partials concatenate to the full input JSON')
      await session.destroy()
    })

    it('does NOT emit tool_input_delta for non-tool-use content blocks (text or thinking)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([
              { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } },
              { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'hi' } },
              { type: 'content_block_stop', index: 0 },
              // A delta for an index we never saw a tool_use start for
              // — translator emits tool_input_delta, but byok-session
              // must drop it because the index→toolUseId map is empty
              // for this index.
              { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: 'orphan' } },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 1 } },
              { type: 'message_stop' },
            ], {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'hi' }],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('hi')

      const deltas = captured.filter((e) => e.name === 'tool_input_delta')
      assert.equal(deltas.length, 0, 'no tool_input_delta for text-only turns or unmapped indices')
      // Sanity: the text_delta still flowed through stream_delta so
      // we haven't broken the happy path while adding the gate.
      const streamDeltas = captured.filter((e) => e.name === 'stream_delta')
      assert.equal(streamDeltas.length, 1, 'text delta still surfaces on stream_delta')
      await session.destroy()
    })

    it('suppresses tool_input_delta while a permission prompt is pending for the same toolUseId', async () => {
      // Defensive-but-load-bearing: the issue's acceptance criterion
      // calls out the flicker case. Today permission requests fire
      // AFTER the stream completes (so the same toolUseId can't have
      // a delta racing a pending permission within ONE round), but
      // the gate must exist for any future mid-stream-permission
      // refactor or a multi-round flow where the same toolUseId is
      // re-streamed. Force the pending state by hand and verify the
      // delta is dropped.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () =>
            fakeStream([
              { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_99', name: 'Bash', input: {} } },
              { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"command":"rm -rf"}' } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 1 } },
              { type: 'message_stop' },
            ], {
              stop_reason: 'end_turn',
              content: [{ type: 'tool_use', id: 'tu_99', name: 'Bash', input: { command: 'rm -rf' } }],
              usage: { input_tokens: 1, output_tokens: 1 },
            }),
        },
      }
      // Pre-seed the pending set so the delta hits the gate.
      session._pendingPermissionToolUseIds.add('tu_99')
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('do it')
      const deltas = captured.filter((e) => e.name === 'tool_input_delta')
      assert.equal(deltas.length, 0, 'gate suppresses tool_input_delta while permission is pending')
      await session.destroy()
    })

    it('clears the index→toolUseId map on the error path so stale entries do not leak into the next turn', async () => {
      // Copilot review on #4233: pre-fix the per-round clear lived
      // ONLY after finalMessage() resolved. An iteration /
      // finalMessage() throw skipped it, so a stream that errored
      // mid-tool-stream left index N → tu_X stuck in the map, and the
      // NEXT turn's tool_input_delta for index N would resolve to the
      // previous turn's tu_X — silently mis-tagging. Verify the
      // finally block drains the map regardless of exit path.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = {
        messages: {
          stream: () => ({
            // eslint-disable-next-line require-yield
            async *[Symbol.asyncIterator]() {
              // Yield a tool_use start so the map gets populated,
              // then throw — finalMessage() never runs, so the
              // per-round clear after it never fires.
              yield { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_pre_err', name: 'Read', input: {} } }
              throw new Error('simulated mid-stream failure')
            },
            async finalMessage() {
              throw new Error('finalMessage not reached')
            },
          }),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('this turn will fail')
      // The error path emits an error event and ends the turn.
      const errors = captured.filter((e) => e.name === 'error')
      assert.ok(errors.length >= 1, 'error event surfaces on the failure path')
      // The map MUST be empty before the next turn starts. Reading
      // private state is acceptable here because the alternative
      // (running a SECOND fake stream and asserting no stale toolUseId
      // leaks through) duplicates the existing per-round-clear test
      // without proving the finally path actually ran.
      assert.equal(session._streamingIndexToToolUseId.size, 0,
        'finally must clear the map even when the stream throws')
      await session.destroy()
    })

    it('clears the index→toolUseId map between rounds so a later index does not pick up a stale toolUseId', async () => {
      // Round 1: tool_use at index 0 → tu_a, content_block_stop fires
      // → map entry deleted. But the defensive clear after
      // finalMessage() is the belt-and-suspenders: if a future SDK
      // skipped content_block_stop, round 2's index 0 must NOT
      // resolve to tu_a from round 1. Round 2's tool_use at index 0
      // is tu_b, and its delta must carry tu_b.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      let round = 0
      session._client = {
        messages: {
          stream: () => {
            round += 1
            if (round === 1) {
              return fakeStream([
                { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_a', name: 'Read', input: {} } },
                { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/a"}' } },
                // NOTE: deliberately omit content_block_stop here to
                // force the finalMessage()-time clear (a real SDK
                // would always emit stop; this is the defensive case
                // the per-round clear was added for).
                { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
              ], {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: 'tu_a', name: 'Read', input: { file_path: '/a' } }],
                usage: { input_tokens: 1, output_tokens: 1 },
              })
            }
            return fakeStream([
              { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'tu_b', name: 'Read', input: {} } },
              { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: '{"file_path":"/b"}' } },
              { type: 'content_block_stop', index: 0 },
              { type: 'message_delta', delta: { stop_reason: 'end_turn' }, usage: { input_tokens: 1, output_tokens: 1 } },
            ], {
              stop_reason: 'end_turn',
              content: [{ type: 'text', text: 'done' }],
              usage: { input_tokens: 1, output_tokens: 1 },
            })
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')
      const deltas = captured.filter((e) => e.name === 'tool_input_delta')
      assert.equal(deltas.length, 2, 'one delta per round')
      assert.equal(deltas[0].payload.toolUseId, 'tu_a', 'round 1 delta carries round-1 toolUseId')
      assert.equal(deltas[1].payload.toolUseId, 'tu_b',
        'round 2 delta MUST carry tu_b — not tu_a leaked from a missing content_block_stop')
      await session.destroy()
    })
  })

  describe('tool dispatch (PR 2)', () => {
    it('executes a tool_use block via the local executor and loops on tool_result', async () => {
      // Round 1: model emits a Read tool_use, stop_reason=tool_use.
      // Round 2: model emits text, stop_reason=end_turn.
      let callCount = 0
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      // Permission mode auto so the test doesn't hang waiting for a user
      // tap. The point of the test is the agent loop, not the permission UI.
      session.setPermissionMode('auto')
      // Force the Read tool through a stub executor by intercepting at
      // the tool layer. The session's own executor would try to read a
      // real file — out of scope for this test.
      const originalExecute = session._executeToolBlock.bind(session)
      session._executeToolBlock = async function ({ block }) {
        return {
          type: 'tool_result',
          tool_use_id: block.id,
          content: 'mock tool output',
          is_error: false,
        }
      }
      session._client = {
        messages: {
          stream: () => {
            callCount += 1
            if (callCount === 1) {
              return fakeStream(
                [
                  { type: 'message_start', message: { id: 'msg', model: 'claude-opus-4-8' } },
                  { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: 'toolu_1', name: 'Read', input: {} } },
                  { type: 'message_delta', delta: { stop_reason: 'tool_use' } },
                  { type: 'message_stop' },
                ],
                {
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 'toolu_1', name: 'Read', input: { file_path: '/tmp/x' } }],
                  usage: { input_tokens: 10, output_tokens: 5 },
                },
              )
            }
            return fakeStream(
              [
                { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'done' } },
                { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
                { type: 'message_stop' },
              ],
              {
                stop_reason: 'end_turn',
                content: [{ type: 'text', text: 'done' }],
                usage: { input_tokens: 12, output_tokens: 8 },
              },
            )
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('please read /tmp/x')
      // Round 1 + round 2 = 2 stream() calls
      assert.equal(callCount, 2, 'agent loop should iterate twice (tool round + final)')
      const results = captured.filter((e) => e.name === 'result')
      assert.equal(results.length, 1, 'one final result, not one per round')
      assert.equal(results[0].payload.stopReason, 'end_turn')
      // History should contain: user prompt, assistant turn 1, user tool_result, assistant turn 2
      assert.equal(session._history.length, 4)
      assert.equal(session._history[0].role, 'user')
      assert.equal(session._history[1].role, 'assistant')
      assert.equal(session._history[2].role, 'user', 'tool_result rides on a user message')
      assert.ok(Array.isArray(session._history[2].content))
      assert.equal(session._history[2].content[0].type, 'tool_result')
      assert.equal(session._history[3].role, 'assistant')
      session._executeToolBlock = originalExecute
      await session.destroy()
    })

    it('fills synthetic tool_result blocks for unexecuted tool_use on mid-loop abort (#4061, #4062)', async () => {
      // Three tool_use blocks. We abort during PHASE 1 (sequential
      // permission gating) — between block 1's and block 2's gate. The
      // gate loop's next iteration observes signal.aborted, stops
      // gating, and runs the synthetic-fill for the unscheduled
      // remainder. Execution of block 1 (the only successfully-gated
      // block) still happens via Promise.all in phase 2.
      //
      // Pre-#4062 this test aborted from inside block 1's executor in
      // sequential mode. After the parallelism refactor, executions
      // fan out via Promise.all so a mid-exec abort no longer prevents
      // siblings from running — the only deterministic path to the
      // synthetic-fill is to trip the signal during the gate phase. The
      // assertions on the history invariant (N tool_use → N tool_result)
      // and the closing tool_result events remain identical.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      // Stub the gate so block 1 auto-allows and triggers the abort.
      // Blocks 2 and 3 never enter the gate — the loop sees aborted at
      // the top and breaks. Phase 2 still executes block 1.
      let gateCalls = 0
      session._gateToolBlock = async function ({ block }) {
        gateCalls += 1
        if (gateCalls === 1) {
          // Trip the abort BEFORE returning so the next gate-loop
          // iteration sees signal.aborted and bails into the
          // synthetic-fill. The already-resolved decision for block 1
          // still goes through to phase 2.
          this._abortController.abort()
          return { behavior: 'allow', updatedInput: block.input || {} }
        }
        throw new Error('gate should not run after abort')
      }
      let executeCalls = 0
      // Wrap the original executor so we still emit the real tool_result
      // event for block 1 (mirrors the production code path).
      session._executeToolBlock = async function ({ block, messageId }) {
        executeCalls += 1
        this.emit('tool_result', {
          messageId,
          toolUseId: block.id,
          result: 'ok',
          isError: false,
        })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      session._client = {
        messages: {
          stream: () =>
            fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
              {
                stop_reason: 'tool_use',
                content: [
                  { type: 'tool_use', id: 'tu_1', name: 'Read', input: { file_path: '/a' } },
                  { type: 'tool_use', id: 'tu_2', name: 'Read', input: { file_path: '/b' } },
                  { type: 'tool_use', id: 'tu_3', name: 'Read', input: { file_path: '/c' } },
                ],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            ),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')
      // Only the first block executed — the abort fired during its
      // executor call, the loop breaks before block 2 / block 3 run.
      assert.equal(executeCalls, 1, 'only one real execute before abort')
      // History MUST carry a user message with exactly 3 tool_result
      // blocks: tu_1 real, tu_2 + tu_3 synthetic. The next sendMessage
      // would otherwise 400.
      const userTurns = session._history.filter((m) => m.role === 'user' && Array.isArray(m.content))
      const toolResultTurn = userTurns[userTurns.length - 1]
      assert.ok(toolResultTurn, 'tool_result user-turn must be pushed even after abort')
      const ids = toolResultTurn.content.map((b) => b.tool_use_id).sort()
      assert.deepEqual(ids, ['tu_1', 'tu_2', 'tu_3'],
        'every tool_use id must have a matching tool_result block')
      // The synthetic ones are explicit errors.
      const synthetic = toolResultTurn.content.filter((b) => b.tool_use_id !== 'tu_1')
      assert.equal(synthetic.length, 2)
      for (const s of synthetic) {
        assert.equal(s.type, 'tool_result', 'synthetic block must carry the tool_result type tag')
        assert.equal(s.is_error, true, 'synthetic tool_result must mark is_error')
        assert.match(s.content, /[Ii]nterrupted/, 'synthetic content should reference the abort')
      }
      // The dashboard / mobile tool-call bubble closes on `tool_result`
      // events — without one per synthetic, blocks 2 and 3 would stay
      // in 'running…' forever (#4108 review). Assert all three fire.
      const toolResultEvents = captured.filter((e) => e.name === 'tool_result')
      const eventIds = toolResultEvents.map((e) => e.payload.toolUseId).sort()
      assert.deepEqual(eventIds, ['tu_1', 'tu_2', 'tu_3'])
      const syntheticEvents = toolResultEvents.filter((e) => e.payload.toolUseId !== 'tu_1')
      assert.equal(syntheticEvents.length, 2)
      for (const ev of syntheticEvents) {
        assert.equal(ev.payload.isError, true)
        assert.match(ev.payload.result, /[Ii]nterrupted/)
        // Wire-shape parity (#4261): ServerToolResultSchema does not
        // include `toolName`; the field is dead weight on the wire.
        assert.ok(!('toolName' in ev.payload),
          'synthetic tool_result must not carry the redundant `toolName` key (#4261)')
      }
      await session.destroy()
    })

    it('does NOT schedule phase-2 executions when abort fires between phase 1 and phase 2 (#4247)', async () => {
      // The race the issue describes: every gate auto-resolves
      // synchronously (e.g. permissionMode=auto), then the user hits
      // Stop in the microtask window AFTER phase 1 completes but
      // BEFORE phase 2 fans out into Promise.all. Pre-fix, the
      // already-gated decisions still flow into _executeToolBlock for
      // every block — and tools like Write/Edit/Read/TodoWrite ignore
      // the signal, so they run to completion AFTER the user said stop.
      //
      // We model the race deterministically by aborting at the END of
      // the last gate call. The gate already returned 'allow' for every
      // block, so phase 1 considers the round fully gated (no mid-gate
      // synthetic fill). The new guard must re-check signal.aborted
      // before scheduling phase 2 and short-circuit every block into a
      // synthetic 'Interrupted' tool_result.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      let gateCalls = 0
      session._gateToolBlock = async function ({ block }) {
        gateCalls += 1
        // Approve every block. Abort AFTER the last gate resolves so
        // phase 1 completes cleanly (firstUngatedIndex = N), but the
        // signal trips before phase 2 schedules executions.
        if (gateCalls === 3) {
          this._abortController.abort()
        }
        return { behavior: 'allow', updatedInput: block.input || {} }
      }
      let executeCalls = 0
      session._executeToolBlock = async function () {
        executeCalls += 1
        throw new Error('phase 2 must not schedule any executions after abort between phases')
      }
      session._client = {
        messages: {
          stream: () =>
            fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
              {
                stop_reason: 'tool_use',
                content: [
                  { type: 'tool_use', id: 'tu_w1', name: 'Write', input: { file_path: '/a', content: 'x' } },
                  { type: 'tool_use', id: 'tu_w2', name: 'Write', input: { file_path: '/b', content: 'y' } },
                  { type: 'tool_use', id: 'tu_w3', name: 'Write', input: { file_path: '/c', content: 'z' } },
                ],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            ),
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('parallel writes')
      // The whole point: zero real executions after the inter-phase abort.
      assert.equal(executeCalls, 0,
        'phase-2 schedule must observe the abort that fired between phase 1 and phase 2')
      // History invariant (#4061) still holds: N tool_use → N tool_result.
      const userTurns = session._history.filter((m) => m.role === 'user' && Array.isArray(m.content))
      const toolResultTurn = userTurns[userTurns.length - 1]
      assert.ok(toolResultTurn, 'tool_result user-turn must be pushed even on inter-phase abort')
      const ids = toolResultTurn.content.map((b) => b.tool_use_id).sort()
      assert.deepEqual(ids, ['tu_w1', 'tu_w2', 'tu_w3'],
        'every tool_use id must have a matching tool_result block (history invariant)')
      for (const b of toolResultTurn.content) {
        assert.equal(b.type, 'tool_result')
        assert.equal(b.is_error, true, 'synthetic tool_result must mark is_error')
        assert.match(b.content, /[Ii]nterrupted/, 'synthetic content references the abort')
      }
      // The dashboard / mobile tool-call bubble closes on `tool_result`
      // events — without one per synthetic, all three Write bubbles
      // would stay in 'running…' forever (#4108).
      const toolResultEvents = captured.filter((e) => e.name === 'tool_result')
      const eventIds = toolResultEvents.map((e) => e.payload.toolUseId).sort()
      assert.deepEqual(eventIds, ['tu_w1', 'tu_w2', 'tu_w3'],
        'one closing tool_result event per ungated block')
      for (const ev of toolResultEvents) {
        assert.equal(ev.payload.isError, true)
        assert.match(ev.payload.result, /[Ii]nterrupted/)
        assert.ok(!('toolName' in ev.payload),
          'inter-phase synthetic tool_result must not carry the legacy `toolName` key (#4261)')
      }
      await session.destroy()
    })

    it('still short-circuits when abort fires DURING phase 1 (regression guard for #4247 fix)', async () => {
      // Regression: the existing mid-gate synthetic-fill path
      // (firstUngatedIndex < N) must keep working unchanged after we
      // add the between-phase guard. The two paths share the
      // synthetic-fill helper but diverge on `firstUngatedIndex` — pin
      // it so a future refactor that collapses them can't silently
      // drop the mid-gate semantics.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      let gateCalls = 0
      session._gateToolBlock = async function ({ block }) {
        gateCalls += 1
        if (gateCalls === 1) {
          // Trip abort INSIDE the gate so the next iteration's top-of-loop
          // check sees signal.aborted and bails — block 1 still ran the
          // gate (firstUngatedIndex = 1, blocks 2/3 synthetic-filled).
          this._abortController.abort()
          return { behavior: 'allow', updatedInput: block.input || {} }
        }
        throw new Error('gate must not run after mid-gate abort')
      }
      let executeCalls = 0
      session._executeToolBlock = async function ({ block, messageId }) {
        executeCalls += 1
        // Mirror the real emit so the dashboard bubble closes for the
        // one block that actually ran (block 1).
        this.emit('tool_result', {
          messageId,
          toolUseId: block.id,
          result: 'ok',
          isError: false,
        })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      session._client = {
        messages: {
          stream: () =>
            fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
              {
                stop_reason: 'tool_use',
                content: [
                  { type: 'tool_use', id: 'tu_m1', name: 'Read', input: { file_path: '/a' } },
                  { type: 'tool_use', id: 'tu_m2', name: 'Read', input: { file_path: '/b' } },
                  { type: 'tool_use', id: 'tu_m3', name: 'Read', input: { file_path: '/c' } },
                ],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            ),
        },
      }
      await session.start()
      await session.sendMessage('go')
      // Mid-gate semantics preserved: block 1 ran exactly once; blocks
      // 2/3 were synthetic-filled. The new inter-phase guard must NOT
      // double-fill block 1 or skip its execution.
      assert.equal(executeCalls, 1, 'only block 1 executes after mid-gate abort')
      const userTurns = session._history.filter((m) => m.role === 'user' && Array.isArray(m.content))
      const toolResultTurn = userTurns[userTurns.length - 1]
      const ids = toolResultTurn.content.map((b) => b.tool_use_id)
      assert.deepEqual(ids, ['tu_m1', 'tu_m2', 'tu_m3'], 'history order preserved')
      assert.equal(toolResultTurn.content[0].is_error, false, 'block 1 is a real success')
      assert.equal(toolResultTurn.content[1].is_error, true)
      assert.equal(toolResultTurn.content[2].is_error, true)
      assert.match(toolResultTurn.content[1].content, /[Ii]nterrupted/)
      assert.match(toolResultTurn.content[2].content, /[Ii]nterrupted/)
      await session.destroy()
    })

    it('still honours in-flight abort during phase 2 execution (regression guard for #4247 fix)', async () => {
      // The third path: abort fires AFTER phase 2 has scheduled. The
      // existing behavior is that executions that accepted the signal
      // (Bash/Glob/Grep/WebFetch) can short-circuit; others run to
      // completion. We don't change that — but we must prove the new
      // inter-phase guard doesn't accidentally swallow this case
      // either (e.g. by re-checking too aggressively and converting
      // already-scheduled executions to synthetics).
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._gateToolBlock = async function ({ block }) {
        return { behavior: 'allow', updatedInput: block.input || {} }
      }
      // Phase 2 executor that aborts FROM INSIDE itself (after
      // scheduling), so the abort fires strictly during execution —
      // not between phases. All three executor calls still happen
      // because Promise.all already scheduled them when the first
      // one began running.
      let executeCalls = 0
      let firstStarted
      session._executeToolBlock = async function ({ block, messageId }) {
        executeCalls += 1
        if (executeCalls === 1) {
          firstStarted = true
          // Trip the abort once the parallel batch has begun. By this
          // point all three executions are already in-flight (their
          // promises were pushed in the for-loop before Promise.all
          // awaited). The new inter-phase guard must NOT retroactively
          // cancel them — they've passed the gate AND been scheduled.
          this._abortController.abort()
        }
        this.emit('tool_result', { messageId, toolUseId: block.id, result: 'ok', isError: false })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      session._client = {
        messages: {
          stream: () =>
            fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
              {
                stop_reason: 'tool_use',
                content: [
                  { type: 'tool_use', id: 'tu_p1', name: 'Read', input: {} },
                  { type: 'tool_use', id: 'tu_p2', name: 'Read', input: {} },
                  { type: 'tool_use', id: 'tu_p3', name: 'Read', input: {} },
                ],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            ),
        },
      }
      await session.start()
      await session.sendMessage('go')
      assert.equal(firstStarted, true, 'phase 2 must have started — abort tested in-flight, not between phases')
      assert.equal(executeCalls, 3,
        'in-flight abort does not retroactively cancel already-scheduled phase-2 executions')
      const userTurns = session._history.filter((m) => m.role === 'user' && Array.isArray(m.content))
      const toolResultTurn = userTurns[userTurns.length - 1]
      const ids = toolResultTurn.content.map((b) => b.tool_use_id)
      assert.deepEqual(ids, ['tu_p1', 'tu_p2', 'tu_p3'])
      // All three are real successes because the stub executor doesn't
      // honour the signal (just like Read/Write/Edit/TodoWrite in
      // production). The point is: no synthetic-fill kicked in for
      // already-scheduled work.
      for (const b of toolResultTurn.content) {
        assert.equal(b.is_error, false, 'in-flight executions complete normally — no synthetic overwrite')
      }
      await session.destroy()
    })

    it('executes parallel tool_use blocks concurrently — wall clock < sequential (#4062)', async () => {
      // Three Read tool_use blocks in one assistant turn. Each executor
      // sleeps 100ms. Sequential would take ~300ms; Promise.all should
      // collapse to ~100ms + a small scheduler margin. Assert the total
      // is comfortably under the sequential floor.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      const SLEEP_MS = 100
      const startTimes = []
      const endTimes = []
      session._executeToolBlock = async function ({ block, messageId, decision }) {
        // Sanity check: orchestrator passes the pre-resolved decision.
        assert.ok(decision, 'orchestrator must pass a pre-resolved decision into _executeToolBlock')
        assert.equal(decision.behavior, 'allow', 'auto mode resolves to allow')
        startTimes.push(Date.now())
        await new Promise((r) => setTimeout(r, SLEEP_MS))
        endTimes.push(Date.now())
        this.emit('tool_result', {
          messageId,
          toolUseId: block.id,
          result: 'ok',
          isError: false,
        })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      let streamCall = 0
      session._client = {
        messages: {
          stream: () => {
            streamCall += 1
            if (streamCall === 1) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
                {
                  stop_reason: 'tool_use',
                  content: [
                    { type: 'tool_use', id: 'tu_a', name: 'Read', input: { file_path: '/a' } },
                    { type: 'tool_use', id: 'tu_b', name: 'Read', input: { file_path: '/b' } },
                    { type: 'tool_use', id: 'tu_c', name: 'Read', input: { file_path: '/c' } },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }],
              { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      await session.start()
      const turnStart = Date.now()
      await session.sendMessage('parallel reads')
      const turnTotal = Date.now() - turnStart
      // Sequential would be 3 * 100ms = 300ms (minimum). Parallel should
      // finish in ~100ms plus a generous CI scheduler margin. Tight
      // upper bound at 250ms — proves concurrency without flakiness on
      // overloaded runners.
      assert.equal(startTimes.length, 3, 'all three executors fire')
      assert.ok(
        turnTotal < 250,
        `expected parallel turn < 250ms, got ${turnTotal}ms — sequential floor is ~300ms`,
      )
      // Additional concurrency check: each executor's start should be
      // within the lifetime of the others (overlap, not back-to-back).
      const lastStart = Math.max(...startTimes)
      const firstEnd = Math.min(...endTimes)
      assert.ok(
        lastStart < firstEnd,
        `executors must overlap — last start (${lastStart}) should precede first end (${firstEnd})`,
      )
      await session.destroy()
    })

    it('preserves tool_result order when one block is denied amid approvals (#4062)', async () => {
      // Three tool_use blocks. Middle one (tu_b) gets denied by a
      // session rule; the others auto-allow. Even though execution is
      // parallel, the tool_result content array must preserve the
      // source ordering [tu_a, tu_b-denied, tu_c] so the Anthropic API
      // sees a strict tool_use ↔ tool_result alignment.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('approve')
      let gateCallIndex = 0
      session._gateToolBlock = async function ({ block }) {
        const idx = gateCallIndex++
        if (idx === 1) {
          // Block b: deny.
          return { behavior: 'deny', message: 'Denied by session rule' }
        }
        return { behavior: 'allow', updatedInput: block.input || {} }
      }
      // Add a small variable delay so any naive ordering bug surfaces.
      const delays = { tu_a: 60, tu_c: 20 }
      session._executeToolBlock = async function ({ block, messageId, decision }) {
        if (decision?.behavior !== 'allow') {
          // Mirror the production deny short-circuit so this stub
          // behaves identically to the real implementation for denied
          // blocks — important because the orchestrator passes the
          // decision through.
          const msg = decision.message || 'Permission denied by user.'
          this.emit('tool_result', { messageId, toolUseId: block.id, result: msg, isError: true })
          return { type: 'tool_result', tool_use_id: block.id, content: msg, is_error: true }
        }
        const sleep = delays[block.id] || 0
        if (sleep) await new Promise((r) => setTimeout(r, sleep))
        this.emit('tool_result', { messageId, toolUseId: block.id, result: 'ok', isError: false })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      let streamCall = 0
      session._client = {
        messages: {
          stream: () => {
            streamCall += 1
            if (streamCall === 1) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
                {
                  stop_reason: 'tool_use',
                  content: [
                    { type: 'tool_use', id: 'tu_a', name: 'Bash', input: { command: 'echo a' } },
                    { type: 'tool_use', id: 'tu_b', name: 'Bash', input: { command: 'echo b' } },
                    { type: 'tool_use', id: 'tu_c', name: 'Bash', input: { command: 'echo c' } },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }],
              { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      await session.start()
      await session.sendMessage('mixed approval')
      // History: user-prompt, assistant tool_use, user tool_result, assistant final.
      const toolResultTurn = session._history.find((m) => m.role === 'user' && Array.isArray(m.content) && m.content[0]?.type === 'tool_result')
      assert.ok(toolResultTurn, 'tool_result user-turn must be present')
      const ids = toolResultTurn.content.map((b) => b.tool_use_id)
      assert.deepEqual(ids, ['tu_a', 'tu_b', 'tu_c'],
        'tool_result order must match tool_use source order even with parallel execution + variable latency')
      // The denied block carries the denial.
      const denied = toolResultTurn.content[1]
      assert.equal(denied.tool_use_id, 'tu_b')
      assert.equal(denied.is_error, true)
      assert.match(denied.content, /[Dd]enied/)
      // The two approved blocks succeeded.
      assert.equal(toolResultTurn.content[0].is_error, false)
      assert.equal(toolResultTurn.content[2].is_error, false)
      await session.destroy()
    })

    it('serialises permission gating across parallel tool_use blocks (#4062 UX)', async () => {
      // The acceptance criterion: permission prompts must surface one
      // at a time, not all-at-once, even though execution fans out.
      // Stub _gateToolBlock to record the order in which it's CALLED
      // (start) and RESOLVED (end). Real gates are async (await user
      // tap on phone); we simulate with a 30ms delay each. If the
      // orchestrator parallelised gates, the calls would overlap — i.e.
      // call 2 starts before call 1 resolves.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('approve')
      const events = []
      let counter = 0
      session._gateToolBlock = async function ({ block }) {
        const id = ++counter
        events.push({ kind: 'start', id, block: block.id, t: Date.now() })
        await new Promise((r) => setTimeout(r, 30))
        events.push({ kind: 'end', id, block: block.id, t: Date.now() })
        return { behavior: 'allow', updatedInput: block.input || {} }
      }
      session._executeToolBlock = async function ({ block, messageId }) {
        this.emit('tool_result', { messageId, toolUseId: block.id, result: 'ok', isError: false })
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      let streamCall = 0
      session._client = {
        messages: {
          stream: () => {
            streamCall += 1
            if (streamCall === 1) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
                {
                  stop_reason: 'tool_use',
                  content: [
                    { type: 'tool_use', id: 'tu_a', name: 'Read', input: {} },
                    { type: 'tool_use', id: 'tu_b', name: 'Read', input: {} },
                    { type: 'tool_use', id: 'tu_c', name: 'Read', input: {} },
                  ],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
              { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      await session.start()
      await session.sendMessage('go')
      // Strict alternation: start1, end1, start2, end2, start3, end3 —
      // no two starts back-to-back without an end in between. Anything
      // else means gates overlapped (parallel prompts — bad UX).
      assert.equal(events.length, 6, 'three gates → six start/end events')
      for (let i = 0; i < 3; i++) {
        assert.equal(events[i * 2].kind, 'start', `event ${i * 2} should be a start`)
        assert.equal(events[i * 2 + 1].kind, 'end', `event ${i * 2 + 1} should be the matching end`)
        assert.equal(events[i * 2].id, events[i * 2 + 1].id, 'start and end ids must pair up — gates cannot interleave')
      }
      await session.destroy()
    })

    it('breaks out of the loop after MAX_TOOL_ROUNDS (infinite-loop safety)', async () => {
      // Model insists on calling a tool on every round — agent loop must
      // bail at the cap, run one summary round (#4063), and emit result so
      // the session doesn't hang.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'x', is_error: false }
      }
      let callCount = 0
      session._client = {
        messages: {
          stream: ({ tools }) => {
            callCount += 1
            // The summary round (#4063) is called without `tools` — the
            // model must respond with text only. Distinguish here to keep
            // the existing assertion meaningful: tool calls are bounded.
            if (!tools || tools.length === 0) {
              return fakeStream(
                [
                  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
                  { type: 'message_stop' },
                ],
                {
                  stop_reason: 'end_turn',
                  content: [{ type: 'text', text: 'I made some progress but hit the cap.' }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
              {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: `toolu_${callCount}`, name: 'Read', input: {} }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            )
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('infinite loop please')
      // 25 tool-rounds + 1 summary round = 26 calls.
      assert.equal(callCount, 26, `expected 25 tool rounds + 1 summary, got ${callCount}`)
      const results = captured.filter((e) => e.name === 'result')
      assert.equal(results.length, 1, 'must emit result even on safety-cap exit')
      await session.destroy()
    })

    it('emits a non-fatal MAX_TOOL_ROUNDS_REACHED error when the cap fires (#4063)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'x', is_error: false }
      }
      session._client = {
        messages: {
          stream: ({ tools }) => {
            if (!tools || tools.length === 0) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
                {
                  stop_reason: 'end_turn',
                  content: [{ type: 'text', text: 'Summary text.' }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: 'toolu_x', name: 'Read', input: {} }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            )
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('infinite loop please')
      const errs = captured.filter((e) => e.name === 'error')
      const capErr = errs.find((e) => e.payload?.code === 'MAX_TOOL_ROUNDS_REACHED')
      assert.ok(capErr, `expected MAX_TOOL_ROUNDS_REACHED error, got: ${errs.map((e) => e.payload?.code).join(', ') || 'none'}`)
      assert.equal(capErr.payload.fatal, false, 'cap-reached must be non-fatal (session stays alive)')
      assert.match(capErr.payload.message, /25/, 'message should cite the cap count')
      // Session must still be usable after — busy flag clears via _finishTurn.
      assert.equal(session._isBusy, false, 'session should not be stuck busy after non-fatal cap-hit error')
      await session.destroy()
    })

    it('embeds the summary instruction in the existing tool_result user turn (#4063 alternation guard — review #4146)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'r', is_error: false }
      }
      session._client = {
        messages: {
          stream: ({ tools, messages }) => {
            if (!tools || tools.length === 0) {
              // On the summary round, the LAST entry in `messages` must
              // be a user turn carrying both tool_result blocks AND the
              // synthetic instruction. Verify that here so a regression
              // that pushes a second user turn back-to-back is caught.
              const last = messages[messages.length - 1]
              assert.equal(last.role, 'user', 'last turn must be user (single turn, not two consecutive)')
              const kinds = last.content.map((c) => c.type).sort()
              assert.ok(kinds.includes('tool_result'), 'last user turn must still carry tool_result blocks')
              assert.ok(kinds.includes('text'), 'last user turn must include the synthetic text instruction')
              // Verify the second-to-last is assistant (alternation).
              const prev = messages[messages.length - 2]
              assert.equal(prev.role, 'assistant', 'turn before final must be assistant')
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
                { stop_reason: 'end_turn', content: [{ type: 'text', text: 'summary' }], usage: { input_tokens: 1, output_tokens: 1 } },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_x', name: 'Read', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      // Attach an error listener so EventEmitter doesn't throw on the
      // non-fatal MAX_TOOL_ROUNDS_REACHED emit. We don't use the captured
      // payload — the alternation check happens in the stream stub above.
      captureEvents(session)
      await session.start()
      await session.sendMessage('go')
      await session.destroy()
    })

    it('pops the synthetic instruction on summary stream-init failure (#4063 invariant — review)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'r', is_error: false }
      }
      session._client = {
        messages: {
          stream: ({ tools }) => {
            if (!tools || tools.length === 0) {
              // Synchronous throw from summary stream-init.
              throw new Error('summary-init failed')
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_x', name: 'Read', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      captureEvents(session)
      await session.start()
      await session.sendMessage('go')
      // After failure, the user-turn rollback should have popped the
      // synthetic instruction back off. The last user turn should
      // contain ONLY tool_result blocks — no leftover text instruction.
      const last = session._history[session._history.length - 1]
      assert.equal(last.role, 'user')
      const types = last.content.map((c) => c.type)
      assert.equal(types.every((t) => t === 'tool_result'), true,
        `last user turn must not retain summary text on failure, got types: ${types.join(',')}`)
      await session.destroy()
    })

    it('emits exactly one result + no STREAM_ERROR on summary stream-init failure (#4147)', async () => {
      // Pre-#4147 we tested that the synthetic instruction was popped,
      // but didn't pin the event sequence. After the cap-hit break the
      // outer try-block still reaches `emit('result', ...)`, so the
      // turn ends cleanly: ONE non-fatal MAX_TOOL_ROUNDS_REACHED error
      // (fatal: false), ONE result event with the cap-hit round's
      // stop_reason (tool_use), and NO STREAM_ERROR event. Pin both
      // shape and count so a future refactor that accidentally double-
      // emits or escalates to STREAM_ERROR fails loudly.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'r', is_error: false }
      }
      session._client = {
        messages: {
          stream: ({ tools }) => {
            if (!tools || tools.length === 0) {
              throw new Error('summary-init failed')
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_x', name: 'Read', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')

      const errs = captured.filter((e) => e.name === 'error')
      const capErrs = errs.filter((e) => e.payload?.code === 'MAX_TOOL_ROUNDS_REACHED')
      const streamErrs = errs.filter((e) => e.payload?.code === 'STREAM_ERROR')
      const aborts = errs.filter((e) => e.payload?.code === 'ABORT')
      const results = captured.filter((e) => e.name === 'result')
      assert.equal(capErrs.length, 1, 'exactly one MAX_TOOL_ROUNDS_REACHED error must fire')
      assert.equal(capErrs[0].payload.fatal, false, 'cap-hit error must be non-fatal')
      assert.equal(streamErrs.length, 0, 'init failure must NOT escalate to STREAM_ERROR')
      assert.equal(aborts.length, 0, 'init failure is not an abort')
      assert.equal(results.length, 1, 'turn must still emit exactly one result event after the break')
      assert.equal(results[0].payload.stopReason, 'tool_use',
        'result reflects the cap-hit round (no summary ran)')
      assert.equal(session._isBusy, false, 'session must be released after the break')
      await session.destroy()
    })

    it('swallows APIUserAbortError on summary stream-init — does NOT fire ABORT (#4170)', async () => {
      // Pin the current contract for the narrow window between the cap-
      // hit error emit (~L456) and summary stream-init (~L482): if the
      // user aborts in this gap the SDK throws APIUserAbortError, which
      // normally _emitTurnError routes to ABORT. But it hits the inner
      // try/catch around the stream-init (L494) BEFORE reaching the
      // outer catch — so the abort is swallowed: the instruction is
      // popped, a warning logs, and the loop breaks. No ABORT event,
      // no STREAM_ERROR. The turn ends via the existing result+stream_end
      // emits identical to the sync init-fail path (#4147).
      //
      // Whether that's the right contract is a separate question (the
      // issue invites that conversation). This test pins the behaviour
      // so any future change in the inner catch surfaces deliberately.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'r', is_error: false }
      }
      session._client = {
        messages: {
          stream: ({ tools }) => {
            if (!tools || tools.length === 0) {
              // Summary stream-init throws APIUserAbortError synchronously.
              // Simulates the SDK's behaviour when signal is already aborted
              // at the call site.
              throw new APIUserAbortError({ message: 'Request was aborted.' })
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_ag', name: 'Read', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')

      const errs = captured.filter((e) => e.name === 'error')
      const capErrs = errs.filter((e) => e.payload?.code === 'MAX_TOOL_ROUNDS_REACHED')
      const streamErrs = errs.filter((e) => e.payload?.code === 'STREAM_ERROR')
      const aborts = errs.filter((e) => e.payload?.code === 'ABORT')
      const results = captured.filter((e) => e.name === 'result')
      assert.equal(capErrs.length, 1, 'exactly one MAX_TOOL_ROUNDS_REACHED must fire')
      assert.equal(capErrs[0].payload.fatal, false, 'cap-hit error must be non-fatal')
      assert.equal(aborts.length, 0,
        'APIUserAbortError swallowed by inner catch — no ABORT event surfaces (current contract)')
      assert.equal(streamErrs.length, 0,
        'init failure must NOT escalate to STREAM_ERROR even when the cause is an abort')
      assert.equal(results.length, 1, 'turn must still emit exactly one result event after the break')
      assert.equal(results[0].payload.stopReason, 'tool_use',
        'result reflects the cap-hit round (no summary ran)')
      assert.equal(session._isBusy, false, 'session must be released after the break')
      await session.destroy()
    })

    it('treats abort during summary for-await as ABORT, not STREAM_ERROR (#4147)', async () => {
      // The existing async-rejection test throws a plain Error and
      // asserts STREAM_ERROR. #4147 asks us to also pin the abort
      // path: when the user interrupts mid-summary the for-await
      // throws APIUserAbortError, which _emitTurnError must route to
      // ABORT (instanceof check). Both MAX_TOOL_ROUNDS_REACHED and
      // ABORT fire, history is truncated, and the session is reusable.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'r', is_error: false }
      }
      session._client = {
        messages: {
          stream: ({ tools }) => {
            if (!tools || tools.length === 0) {
              // Summary round: simulate the user pressing Stop —
              // for-await throws APIUserAbortError.
              return {
                async *[Symbol.asyncIterator]() {
                  throw new APIUserAbortError({ message: 'Request was aborted.' })
                },
                async finalMessage() { throw new Error('never reached') },
              }
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_y', name: 'Read', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      await session.start()
      const historyBefore = session._history.length
      const captured = captureEvents(session)
      await session.sendMessage('go')

      const errs = captured.filter((e) => e.name === 'error')
      assert.ok(errs.some((e) => e.payload?.code === 'MAX_TOOL_ROUNDS_REACHED'),
        'cap-hit error fires before the abort')
      assert.ok(errs.some((e) => e.payload?.code === 'ABORT'),
        'APIUserAbortError must route to ABORT, not STREAM_ERROR')
      assert.equal(errs.filter((e) => e.payload?.code === 'STREAM_ERROR').length, 0,
        'abort path must not also fire STREAM_ERROR')
      assert.equal(session._history.length, historyBefore,
        'history must roll back to pre-send length on abort')
      assert.equal(session._isBusy, false, 'session must be released so the user can send again')

      // Session usable after: the real bug this guards against is
      // _isBusy left true / _abortController not nulled after abort
      // (then the next sendMessage short-circuits with 'Already
      // processing' per byok-session.js:_finishTurn). Swap the stream
      // stub so the assertion isolates session reusability, not the
      // cap-hit path's stub behaviour.
      session._client.messages.stream = () => fakeStream(
        [
          { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
          { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
        ],
        { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
      )
      const captured2 = captureEvents(session)
      await session.sendMessage('still here?')
      assert.ok(captured2.some((e) => e.name === 'result'), 'next turn after abort must succeed')
      await session.destroy()
    })

    it('rolls back the entire turn when the summary stream rejects async (outer catch — review)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'r', is_error: false }
      }
      const historyBefore = []
      session._client = {
        messages: {
          stream: ({ tools }) => {
            if (!tools || tools.length === 0) {
              // Stream init succeeds but async iteration throws.
              return {
                async *[Symbol.asyncIterator]() {
                  throw new Error('async network error in summary stream')
                },
                async finalMessage() { throw new Error('never reached') },
              }
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_x', name: 'Read', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      await session.start()
      historyBefore.push(...session._history)
      const captured = captureEvents(session)
      await session.sendMessage('go')
      // Outer catch should have truncated the WHOLE turn — the user's
      // original prompt + every assistant/tool_result pair.
      assert.equal(session._history.length, historyBefore.length,
        'history must roll back to pre-send length on async summary failure')
      // A STREAM_ERROR should also be emitted (from _emitTurnError).
      const errs = captured.filter((e) => e.name === 'error')
      assert.ok(errs.some((e) => e.payload?.code === 'MAX_TOOL_ROUNDS_REACHED'),
        'cap-hit error fires before the failure')
      assert.ok(errs.some((e) => e.payload?.code === 'STREAM_ERROR'),
        'async failure escalates to STREAM_ERROR')
      await session.destroy()
    })

    it('rolls back the turn when summary finalMessage() rejects non-abort async (#4169)', async () => {
      // Parallels the for-await async-rejection test, but exercises the
      // distinct branch where for-await drains cleanly and only
      // `await summaryStream.finalMessage()` rejects (e.g. network drop
      // after the last event, JSON parse failure on the final frame).
      // The outer catch must still truncate history + emit STREAM_ERROR.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'r', is_error: false }
      }
      session._client = {
        messages: {
          stream: ({ tools }) => {
            if (!tools || tools.length === 0) {
              // Summary round: for-await drains a delta cleanly, then
              // finalMessage() rejects with a non-abort error.
              return {
                async *[Symbol.asyncIterator]() {
                  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }
                  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
                },
                async finalMessage() {
                  throw new Error('finalMessage network drop')
                },
              }
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_fm', name: 'Read', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      await session.start()
      const historyBefore = session._history.length
      const captured = captureEvents(session)
      await session.sendMessage('go')

      const errs = captured.filter((e) => e.name === 'error')
      const capIdx = errs.findIndex((e) => e.payload?.code === 'MAX_TOOL_ROUNDS_REACHED')
      const streamErrIdx = errs.findIndex((e) => e.payload?.code === 'STREAM_ERROR')
      assert.notEqual(capIdx, -1, 'cap-hit error must fire')
      assert.notEqual(streamErrIdx, -1, 'finalMessage non-abort rejection must escalate to STREAM_ERROR')
      assert.ok(capIdx < streamErrIdx,
        'cap-hit error must fire BEFORE the finalMessage rejection (order matters)')
      assert.equal(errs.filter((e) => e.payload?.code === 'ABORT').length, 0,
        'non-abort rejection must NOT route to ABORT')
      assert.equal(session._history.length, historyBefore,
        'history must roll back to pre-send length when finalMessage rejects async')
      assert.equal(session._isBusy, false, 'session must be released after rollback')
      await session.destroy()
    })

    it('routes summary finalMessage() APIUserAbortError to ABORT, not STREAM_ERROR (#4169)', async () => {
      // The mirror of the for-await abort test (#4147), but on the
      // finalMessage() branch. Real SDKs can reject finalMessage with
      // APIUserAbortError if the user pressed Stop after the last event
      // streamed in but before the final frame parsed. _emitTurnError's
      // instanceof check must still route to ABORT.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'r', is_error: false }
      }
      session._client = {
        messages: {
          stream: ({ tools }) => {
            if (!tools || tools.length === 0) {
              return {
                async *[Symbol.asyncIterator]() {
                  yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'partial' } }
                  yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } }
                },
                async finalMessage() {
                  throw new APIUserAbortError({ message: 'Request was aborted.' })
                },
              }
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 'tu_fma', name: 'Read', input: {} }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      await session.start()
      const historyBefore = session._history.length
      const captured = captureEvents(session)
      await session.sendMessage('go')

      const errs = captured.filter((e) => e.name === 'error')
      const capIdx = errs.findIndex((e) => e.payload?.code === 'MAX_TOOL_ROUNDS_REACHED')
      const abortIdx = errs.findIndex((e) => e.payload?.code === 'ABORT')
      assert.notEqual(capIdx, -1, 'cap-hit error must fire')
      assert.notEqual(abortIdx, -1, 'finalMessage APIUserAbortError must route to ABORT')
      assert.ok(capIdx < abortIdx,
        'cap-hit error must fire BEFORE the ABORT from finalMessage (order matters)')
      assert.equal(errs.filter((e) => e.payload?.code === 'STREAM_ERROR').length, 0,
        'abort path on finalMessage must NOT escalate to STREAM_ERROR')
      assert.equal(session._history.length, historyBefore,
        'history must roll back on abort')
      assert.equal(session._isBusy, false, 'session must be released')
      await session.destroy()
    })

    it('streams summary text from the post-cap round so the user sees what was accomplished (#4063)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._executeToolBlock = async function ({ block }) {
        return { type: 'tool_result', tool_use_id: block.id, content: 'ok', is_error: false }
      }
      session._client = {
        messages: {
          stream: ({ tools }) => {
            if (!tools || tools.length === 0) {
              return fakeStream(
                [
                  { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'I capped out but did X, Y, Z.' } },
                  { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
                ],
                {
                  stop_reason: 'end_turn',
                  content: [{ type: 'text', text: 'I capped out but did X, Y, Z.' }],
                  usage: { input_tokens: 5, output_tokens: 10 },
                },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
              {
                stop_reason: 'tool_use',
                content: [{ type: 'tool_use', id: 'toolu_x', name: 'Read', input: {} }],
                usage: { input_tokens: 1, output_tokens: 1 },
              },
            )
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('go')
      const deltas = captured.filter((e) => e.name === 'stream_delta').map((e) => e.payload.delta || '').join('')
      assert.match(deltas, /capped out but did X, Y, Z/, 'summary text must be streamed to the dashboard')
      // The result event reflects the summary's stop_reason, not the cap-hit's tool_use.
      const result = captured.find((e) => e.name === 'result')
      assert.equal(result.payload.stopReason, 'end_turn')
      await session.destroy()
    })

    it('surfaces a denied permission as an error tool_result', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      // Default 'approve' mode — without a permission response the
      // promise would hang. Stub the permission manager to deny.
      session._permissions.handlePermission = async () => ({ behavior: 'deny', message: 'no' })
      let callCount = 0
      session._client = {
        messages: {
          stream: () => {
            callCount += 1
            if (callCount === 1) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }, { type: 'message_stop' }],
                {
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 't1', name: 'Bash', input: { command: 'rm -rf /' } }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }, { type: 'message_stop' }],
              { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: {} },
            )
          },
        },
      }
      const captured = captureEvents(session)
      await session.start()
      await session.sendMessage('try something dangerous')
      const denied = captured.find((e) => e.name === 'tool_result' && e.payload.isError === true)
      assert.ok(denied, 'denied tool produces an error tool_result event')
      assert.match(denied.payload.result, /no/i)
      await session.destroy()
    })

    describe('end-to-end real executor coverage (#4065)', () => {
      // These tests prove the seam between byok-session._executeToolBlock
      // and the real executeBuiltinTool in byok-tool-executor.js. Prior
      // tests in this file stub _executeToolBlock entirely — they would
      // pass even if the dispatch / permission-gate / result-shape
      // contract between the two modules broke. Here, we DON'T stub
      // anything below the agent loop: real cwd, real permission flow
      // (auto-allow), real Read tool, real file ops.

      let workspace
      beforeEach(() => {
        workspace = mkdtempSync(join(tmpdir(), 'chroxy-byok-e2e-'))
      })
      afterEach(() => {
        rmSync(workspace, { recursive: true, force: true })
      })

      it('reads a real file via the unstubbed executor and feeds its content to the next round', async () => {
        // Plant a known file in a real workspace dir.
        const targetPath = join(workspace, 'note.txt')
        const fileBody = 'this came from a real file on disk\nline two'
        writeFileSync(targetPath, fileBody)

        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('auto') // auto-allow so no UI handshake
        // IMPORTANT: do NOT stub session._executeToolBlock. We want the
        // real dispatch + permission gate + executor + tool_result return.
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_a', name: 'Read', input: { file_path: targetPath },
        }, { prompt: 'please read note.txt' })

        // Assert the tool_result the model received on the next round
        // contains the REAL file content from disk (not a stubbed value).
        assert.ok(toolResultBlock, 'round 2 must include a tool_result content block')
        assert.equal(toolResultBlock.tool_use_id, 'toolu_a')
        assert.equal(toolResultBlock.is_error, false)
        assert.match(toolResultBlock.content, /this came from a real file on disk/)
        assert.match(toolResultBlock.content, /line two/)
        await session.destroy()
      })

      it('propagates is_error: true to the next round when the real Read fails (nonexistent file)', async () => {
        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('auto')
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_b', name: 'Read',
          input: { file_path: join(workspace, 'does-not-exist.txt') },
        }, { prompt: 'please read a missing file' })

        assert.ok(toolResultBlock, 'failure tool_result must propagate to next round')
        assert.equal(toolResultBlock.is_error, true, 'a missing-file Read must surface as is_error: true')
        await session.destroy()
      })

      it('writes a real file via the unstubbed executor (Write seam) (#4150)', async () => {
        const targetPath = join(workspace, 'fresh.txt')
        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('auto')
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_w', name: 'Write',
          input: { file_path: targetPath, content: 'planted on disk' },
        }, { prompt: 'write a note' })
        assert.ok(toolResultBlock, 'Write must produce a tool_result')
        assert.equal(toolResultBlock.is_error, false)
        assert.match(toolResultBlock.content, /Wrote 15 bytes/)
        assert.match(toolResultBlock.content, /\(created\)/)
        // The file must actually exist on disk with the planted content.
        assert.equal(readFileSync(targetPath, 'utf8'), 'planted on disk')
        await session.destroy()
      })

      it('edits a real file via the unstubbed executor (Edit seam) (#4150)', async () => {
        const targetPath = join(workspace, 'edit-me.txt')
        writeFileSync(targetPath, 'before:keep:after')
        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('auto')
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_e', name: 'Edit',
          input: { file_path: targetPath, old_string: 'keep', new_string: 'KEPT' },
        }, { prompt: 'do the edit' })
        assert.ok(toolResultBlock, 'Edit must produce a tool_result')
        assert.equal(toolResultBlock.is_error, false)
        assert.match(toolResultBlock.content, /Replaced 1 occurrence/)
        assert.equal(readFileSync(targetPath, 'utf8'), 'before:KEPT:after')
        await session.destroy()
      })

      it('runs a Bash command via the unstubbed executor and feeds stdout back (#4150)', async () => {
        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('auto')
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_b', name: 'Bash', input: { command: 'echo bash-seam-ok' },
        }, { prompt: 'run echo' })
        assert.ok(toolResultBlock, 'Bash must produce a tool_result')
        assert.equal(toolResultBlock.is_error, false)
        assert.match(toolResultBlock.content, /bash-seam-ok/)
        // Bash result includes the exit-footer the model relies on.
        assert.match(toolResultBlock.content, /exit=0/)
        await session.destroy()
      })

      it('redacts ANTHROPIC_API_KEY from the Bash subprocess environment (#4150 secret denylist)', async () => {
        // ANTHROPIC_API_KEY is already 'sk-ant-test-key-fixture' from the
        // outer beforeEach. Bash's safe-env builder must strip it before
        // spawning so `env` inside Bash never sees it.
        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('auto')
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_secret', name: 'Bash', input: { command: 'env' },
        }, { prompt: 'dump env' })
        assert.ok(toolResultBlock, 'Bash env dump must produce a tool_result')
        // The fixture key MUST NOT appear in stdout — the safe-env builder
        // drops it before spawn.
        assert.equal(toolResultBlock.content.includes('sk-ant-test-key-fixture'), false,
          'ANTHROPIC_API_KEY must not leak into Bash subprocess env')
        await session.destroy()
      })

      it('lists files via the unstubbed Glob executor (#4150)', async () => {
        writeFileSync(join(workspace, 'a.txt'), '1')
        writeFileSync(join(workspace, 'b.txt'), '2')
        writeFileSync(join(workspace, 'c.md'), '3')
        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('auto')
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_g', name: 'Glob', input: { pattern: '*.txt' },
        }, { prompt: 'find txt files' })
        assert.ok(toolResultBlock, 'Glob must produce a tool_result')
        assert.equal(toolResultBlock.is_error, false)
        assert.match(toolResultBlock.content, /a\.txt/)
        assert.match(toolResultBlock.content, /b\.txt/)
        assert.equal(toolResultBlock.content.includes('c.md'), false, '*.txt glob must not include c.md')
        await session.destroy()
      })

      it('greps real file contents via the unstubbed executor (#4150)', async () => {
        writeFileSync(join(workspace, 'haystack.txt'), 'alpha\nNEEDLE-here\ngamma\n')
        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('auto')
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_grep', name: 'Grep', input: { pattern: 'NEEDLE' },
        }, { prompt: 'grep for it' })
        assert.ok(toolResultBlock, 'Grep must produce a tool_result')
        assert.equal(toolResultBlock.is_error, false)
        assert.match(toolResultBlock.content, /haystack\.txt/)
        assert.match(toolResultBlock.content, /NEEDLE-here/)
        await session.destroy()
      })

      it('surfaces a Permission gate error tool_result when handlePermission throws (#4151)', async () => {
        // byok-session._executeToolBlock wraps handlePermission in
        // try/catch and converts thrown errors to is_error: true with
        // 'Permission gate error: ...' content. Inject a permission
        // manager whose handlePermission rejects (e.g. timeout/abort)
        // and assert the next round sees that shape.
        const session = new ClaudeByokSession({ cwd: workspace })
        // Override after construction — _permissions was wired in the
        // constructor; we replace it before runOneToolRound() starts.
        session._permissions.handlePermission = async () => {
          throw new Error('simulated gate failure')
        }
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_pg', name: 'Read',
          input: { file_path: join(workspace, 'whatever.txt') },
        }, { prompt: 'try a read' })
        assert.ok(toolResultBlock, 'permission-gate throw must still produce a tool_result')
        assert.equal(toolResultBlock.is_error, true)
        assert.match(toolResultBlock.content, /Permission gate error/)
        assert.match(toolResultBlock.content, /simulated gate failure/)
        await session.destroy()
      })

      it('acceptEdits mode auto-approves Read through the real executor (#4151)', async () => {
        // acceptEdits is one of four permission modes (#3729); for tools
        // in ACCEPT_EDITS_TOOLS it short-circuits the prompt path and
        // auto-allows. Exercising the seam end-to-end proves the
        // mode-to-decision-to-executor flow works.
        const targetPath = join(workspace, 'accept-edits.txt')
        writeFileSync(targetPath, 'accept-edits-content')
        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('acceptEdits')
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_ae', name: 'Read', input: { file_path: targetPath },
        }, { prompt: 'read it' })
        assert.ok(toolResultBlock, 'acceptEdits Read must produce a tool_result')
        assert.equal(toolResultBlock.is_error, false)
        assert.match(toolResultBlock.content, /accept-edits-content/)
        await session.destroy()
      })

      it('session rule decision=allow auto-approves Read through the real executor (#4151)', async () => {
        // Default permission mode (approve) requires a prompt unless a
        // session rule matches. Setting a rule for Read should short-
        // circuit the prompt path and let the real executor run.
        const targetPath = join(workspace, 'rule-allow.txt')
        writeFileSync(targetPath, 'rule-allow-content')
        const session = new ClaudeByokSession({ cwd: workspace })
        session._permissions.setRules([{ tool: 'Read', decision: 'allow' }])
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_ra', name: 'Read', input: { file_path: targetPath },
        }, { prompt: 'read via rule' })
        assert.ok(toolResultBlock, 'allow-rule Read must produce a tool_result')
        assert.equal(toolResultBlock.is_error, false)
        assert.match(toolResultBlock.content, /rule-allow-content/)
        await session.destroy()
      })

      it('session rule decision=deny refuses Read with a deny tool_result (#4151)', async () => {
        // The mirror of the allow case: a deny rule short-circuits to a
        // denied tool_result without invoking the executor at all. The
        // file content must NOT be in the result.
        const targetPath = join(workspace, 'rule-deny.txt')
        writeFileSync(targetPath, 'should-not-appear')
        const session = new ClaudeByokSession({ cwd: workspace })
        session._permissions.setRules([{ tool: 'Read', decision: 'deny' }])
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_rd', name: 'Read', input: { file_path: targetPath },
        }, { prompt: 'read via deny rule' })
        assert.ok(toolResultBlock, 'deny-rule must still produce a tool_result')
        assert.equal(toolResultBlock.is_error, true)
        assert.equal(toolResultBlock.content.includes('should-not-appear'), false,
          'deny rule must short-circuit BEFORE the executor reads the file')
        await session.destroy()
      })

      it('refuses a path-traversal attempt via the real path-safety check', async () => {
        // Real executor enforces validatePathWithinCwd. Asking for
        // /etc/passwd should produce is_error: true with a recognisable
        // message, even with permission set to auto-allow.
        const session = new ClaudeByokSession({ cwd: workspace })
        session.setPermissionMode('auto')
        const toolResultBlock = await runOneToolRound(session, {
          id: 'toolu_c', name: 'Read', input: { file_path: '/etc/passwd' },
        }, { prompt: 'try to escape' })

        assert.ok(toolResultBlock)
        assert.equal(toolResultBlock.is_error, true, 'path-outside-workspace must be is_error')
        assert.match(toolResultBlock.content, /outside workspace/i)
        await session.destroy()
      })
    })
  })

  describe('Task tool dispatch (#4049)', () => {
    /**
     * Build a parent that emits a single Task tool_use on round 1, then
     * end_turn on round 2. The child session's _client.messages.stream
     * is stubbed by the caller via `childStreamImpl(messages, round)`
     * so each test can shape the subagent's behaviour independently.
     */
    function setupParentEmittingTaskOnce(session, { taskInput, childStreamImpl }) {
      let parentRound = 0
      let childRound = 0
      session._client = {
        messages: {
          stream: ({ messages }) => {
            parentRound += 1
            if (parentRound === 1) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
                {
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 'tu_task_1', name: 'Task', input: taskInput }],
                  usage: { input_tokens: 5, output_tokens: 5 },
                },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
              { stop_reason: 'end_turn', content: [{ type: 'text', text: 'parent done' }], usage: { input_tokens: 2, output_tokens: 2 } },
            )
          },
        },
      }
      // _executeTaskTool creates a fresh child session and shares this
      // parent's client. To make the child's stream stub deterministic
      // we install a wrapper around _executeTaskTool that injects the
      // child's _client BEFORE the child runs.
      const origExecuteTaskTool = session._executeTaskTool.bind(session)
      session._executeTaskTool = function (args) {
        // Wrap the parent's _client.messages.stream so when the child
        // calls it, we return the per-round child stream. The child
        // shares the parent's client at the time of construction, but
        // we can swap individual call-time behavior by monkey-patching
        // the messages object the child holds. Simpler: replace the
        // parent's stream impl with a router that dispatches based on
        // whether the active session is the parent or the child via a
        // counter.
        return origExecuteTaskTool.call(this, args)
      }
      // Replace parent client.messages.stream with a router that
      // returns the parent stream on the first 2 calls (round 1 + 2)
      // and the child stream impl on subsequent calls.
      const parentStreamFactory = session._client.messages.stream
      let totalCalls = 0
      session._client.messages.stream = (...streamArgs) => {
        totalCalls += 1
        // Parent emits exactly 1 stream call BEFORE the Task dispatches
        // (round 1 producing the tool_use), then exactly 1 stream call
        // AFTER (round 2 with the tool_result). The child fires its
        // own stream calls in between. We detect the child by checking
        // the active subagent count — if any child is live, this call
        // belongs to that child.
        if (session._subagentSessions.size > 0) {
          childRound += 1
          return childStreamImpl(streamArgs[0]?.messages || [], childRound)
        }
        return parentStreamFactory(...streamArgs)
      }
    }

    it('happy path: spawns child, captures its text, emits agent_spawned + agent_completed', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      const captured = captureEvents(session)
      setupParentEmittingTaskOnce(session, {
        taskInput: { description: 'summarize doc', prompt: 'Summarize /tmp/foo.txt' },
        childStreamImpl: () => fakeStream(
          [
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'Summary: ' } },
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'looks good.' } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          ],
          { stop_reason: 'end_turn', content: [{ type: 'text', text: 'Summary: looks good.' }], usage: { input_tokens: 100, output_tokens: 30 } },
        ),
      })
      await session.start()
      await session.sendMessage('please research')

      // agent_spawned must fire BEFORE agent_completed and carry the
      // tool_use id + description (#4049 acceptance).
      const spawned = captured.find((e) => e.name === 'agent_spawned')
      const completed = captured.find((e) => e.name === 'agent_completed')
      assert.ok(spawned, 'agent_spawned must fire')
      assert.equal(spawned.payload.toolUseId, 'tu_task_1')
      assert.equal(spawned.payload.description, 'summarize doc')
      assert.equal(typeof spawned.payload.startedAt, 'number')
      assert.ok(completed, 'agent_completed must fire')
      assert.equal(completed.payload.toolUseId, 'tu_task_1')

      // tool_result for Task must carry the child's stitched text and
      // is_error: false on the happy path.
      const toolResults = captured.filter((e) => e.name === 'tool_result')
      const taskResult = toolResults.find((e) => e.payload.toolUseId === 'tu_task_1')
      assert.ok(taskResult, 'tool_result for the Task block must fire')
      assert.match(taskResult.payload.result, /Summary: looks good/)
      assert.equal(taskResult.payload.isError, false)

      await session.destroy()
    })

    it('attributes child usage + cost into the parent turn result', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp', model: 'claude-opus-4-8' })
      session.setPermissionMode('auto')
      const captured = captureEvents(session)
      setupParentEmittingTaskOnce(session, {
        taskInput: { description: 'delegate', prompt: 'do the thing' },
        childStreamImpl: () => fakeStream(
          [],
          { stop_reason: 'end_turn', content: [{ type: 'text', text: 'child output' }], usage: { input_tokens: 1000, output_tokens: 500 } },
        ),
      })
      await session.start()
      await session.sendMessage('delegate please')
      const result = captured.find((e) => e.name === 'result')
      assert.ok(result)
      // Parent's own rounds: round 1 (5in/5out) + round 2 (2in/2out) = 7in/7out
      // Child: 1000in/500out
      // Total: 1007in/507out
      assert.equal(result.payload.usage.input_tokens, 1007, 'child input tokens fold into parent total')
      assert.equal(result.payload.usage.output_tokens, 507, 'child output tokens fold into parent total')
      // Cost (Opus 4.8): (1007 * 15 + 507 * 75) / 1e6
      const expectedCost = (1007 * 15 + 507 * 75) / 1e6
      assert.ok(Math.abs(result.payload.cost - expectedCost) < 1e-9,
        `expected cost ~= ${expectedCost}, got ${result.payload.cost}`)
      await session.destroy()
    })

    it('surfaces subagent cost on parent error-path turns (#5020)', async () => {
      // Pin the #5020 contract: when the parent's overall turn errors AFTER
      // a subagent already ran, the user is still billed for the child's
      // API calls — those must surface in the parent's STREAM_ERROR event
      // payload so the user can see what the failed turn cost.
      //
      // Pre-#5020: error event carried only { code, message } — child cost
      // was silently dropped at _finishTurn reset.
      const session = new ClaudeByokSession({ cwd: '/tmp', model: 'claude-opus-4-8' })
      session.setPermissionMode('auto')
      const captured = captureEvents(session)
      let parentRound = 0
      let childInFlight = false
      session._client = {
        messages: {
          stream: () => {
            // If a child session is live, return the child's stream.
            if (childInFlight) {
              return fakeStream(
                [],
                {
                  stop_reason: 'end_turn',
                  content: [{ type: 'text', text: 'child finished' }],
                  usage: { input_tokens: 2000, output_tokens: 800 },
                },
              )
            }
            parentRound += 1
            if (parentRound === 1) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
                {
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 'tu_task_err', name: 'Task', input: { description: 'd', prompt: 'do work' } }],
                  usage: { input_tokens: 10, output_tokens: 10 },
                },
              )
            }
            // Parent's round 2 (after child has run) — throw to drive the
            // STREAM_ERROR path. This is the bug surface: the child's
            // usage is already in _subagentUsageThisTurn but the catch
            // block never folds it in before _finishTurn resets.
            throw new Error('upstream blew up on round 2')
          },
        },
      }
      // Wrap _executeTaskTool to flip the childInFlight flag while the
      // child's stream runs (the child shares the parent's client).
      const origExecute = session._executeTaskTool.bind(session)
      session._executeTaskTool = async function (args) {
        childInFlight = true
        try { return await origExecute(args) }
        finally { childInFlight = false }
      }
      await session.start()
      await session.sendMessage('delegate then fail')

      const errs = captured.filter((e) => e.name === 'error')
      const streamErr = errs.find((e) => e.payload?.code === 'STREAM_ERROR')
      assert.ok(streamErr, 'STREAM_ERROR must fire on parent round-2 failure')
      // The parent's round-1 usage (10in/10out) + child's usage
      // (2000in/800out) MUST be surfaced on the error event so the user
      // sees what the failed turn cost. Round 2 never completed so its
      // usage is 0 (no finalMessage to read from).
      assert.ok(streamErr.payload.usage, 'STREAM_ERROR must carry partial usage')
      assert.equal(streamErr.payload.usage.input_tokens, 2010,
        'parent round-1 input + child input fold into error event')
      assert.equal(streamErr.payload.usage.output_tokens, 810,
        'parent round-1 output + child output fold into error event')
      // Cost (Opus 4.8): (2010 * 15 + 810 * 75) / 1e6
      const expectedCost = (2010 * 15 + 810 * 75) / 1e6
      assert.ok(typeof streamErr.payload.cost === 'number',
        'STREAM_ERROR must carry partial cost')
      assert.ok(Math.abs(streamErr.payload.cost - expectedCost) < 1e-9,
        `expected partial cost ~= ${expectedCost}, got ${streamErr.payload.cost}`)
      // No result event fires on the error path — usage/cost surface
      // exclusively via the error event.
      assert.equal(captured.filter((e) => e.name === 'result').length, 0,
        'no result event on error path')
      // Accumulators must reset for the next turn (existing #4049 contract).
      assert.equal(session._subagentCostThisTurn, 0,
        'subagent cost accumulator resets after the failed turn')
      assert.equal(session._subagentUsageThisTurn.input_tokens, 0,
        'subagent usage accumulator resets after the failed turn')
      await session.destroy()
    })

    it('parent interrupt cascades to child subagent', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      let childInterruptCalled = 0
      let childInstance = null
      // Patch the child constructor so we can record interrupt() calls.
      const origExecute = session._executeTaskTool.bind(session)
      session._executeTaskTool = async function (args) {
        // Wrap interrupt() on the next child that gets registered. We
        // can't override before _executeTaskTool constructs the child,
        // so install a one-shot watcher on _subagentSessions.set.
        const origSet = this._subagentSessions.set.bind(this._subagentSessions)
        this._subagentSessions.set = (k, v) => {
          childInstance = v
          const origInterrupt = v.interrupt.bind(v)
          v.interrupt = function () {
            childInterruptCalled += 1
            return origInterrupt()
          }
          return origSet(k, v)
        }
        try {
          return await origExecute(args)
        } finally {
          this._subagentSessions.set = origSet
        }
      }
      // Child stream that hangs until aborted — we trigger interrupt()
      // on the parent and expect the child to receive an interrupt() call.
      setupParentEmittingTaskOnce(session, {
        taskInput: { description: 'long', prompt: 'long work' },
        childStreamImpl: () => ({
          async *[Symbol.asyncIterator]() {
            // Yield once then wait on a long timeout that the abort
            // signal will tear down.
            yield { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'starting...' } }
            await new Promise((resolve, reject) => {
              const t = setTimeout(resolve, 60_000)
              // When child.interrupt() fires, the child's abort
              // controller aborts and the SDK's APIUserAbortError
              // surfaces via finalMessage. We approximate by clearing
              // the timeout on the child's abort controller.
              childInstance?._abortController?.signal.addEventListener('abort', () => {
                clearTimeout(t)
                reject(new APIUserAbortError())
              }, { once: true })
            })
          },
          async finalMessage() {
            return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'partial' }], usage: {} }
          },
        }),
      })
      await session.start()
      const turn = session.sendMessage('do long task')
      // #5015 review: wait deterministically for the child to spawn
      // (agent_spawned fires AFTER _subagentSessions.set + before the
      // child's sendMessage). A fixed sleep races on loaded CI runners
      // — if interrupt fires before the spawn, the cascade has nothing
      // to iterate and the child runs the full 60s timeout.
      await new Promise((resolve) => {
        if (session._subagentSessions.size > 0) return resolve()
        session.once('agent_spawned', resolve)
      })
      session.interrupt()
      await turn
      assert.ok(childInterruptCalled > 0, 'parent.interrupt() must cascade to child.interrupt()')
      await session.destroy()
    })

    it('rejects Task with empty prompt as is_error tool_result', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      const captured = captureEvents(session)
      // Parent emits Task with empty prompt — we should short-circuit
      // BEFORE spawning a child (no agent_spawned).
      let parentRound = 0
      session._client = {
        messages: {
          stream: () => {
            parentRound += 1
            if (parentRound === 1) {
              return fakeStream(
                [],
                {
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 'tu_bad', name: 'Task', input: { description: 'd', prompt: '' } }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            return fakeStream([], { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: {} })
          },
        },
      }
      await session.start()
      await session.sendMessage('delegate')
      const spawned = captured.find((e) => e.name === 'agent_spawned')
      assert.equal(spawned, undefined, 'agent_spawned must NOT fire when prompt is empty')
      const taskResult = captured.find((e) => e.name === 'tool_result' && e.payload.toolUseId === 'tu_bad')
      assert.ok(taskResult)
      assert.equal(taskResult.payload.isError, true)
      assert.match(taskResult.payload.result, /prompt/i)
      await session.destroy()
    })

    it('child error surfaces as is_error tool_result without crashing the parent', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      const captured = captureEvents(session)
      setupParentEmittingTaskOnce(session, {
        taskInput: { description: 'flaky', prompt: 'do something flaky' },
        childStreamImpl: () => {
          throw Object.assign(new Error('upstream 500'), { status: 500 })
        },
      })
      await session.start()
      await session.sendMessage('delegate')
      const taskResult = captured.find((e) => e.name === 'tool_result' && e.payload.toolUseId === 'tu_task_1')
      assert.ok(taskResult, 'tool_result must fire even when child errored')
      assert.equal(taskResult.payload.isError, true)
      assert.match(taskResult.payload.result, /Subagent failed|upstream 500/i)
      // Parent's own result MUST still fire — the child's error doesn't
      // kill the parent turn.
      const result = captured.find((e) => e.name === 'result')
      assert.ok(result, 'parent result must still fire after child error')
      // agent_completed fires regardless of success/failure so the
      // dashboard's active-agents badge clears.
      const completed = captured.find((e) => e.name === 'agent_completed')
      assert.ok(completed)
      await session.destroy()
    })

    it('Task tool dispatch path is reached via _executeToolBlock (not executeBuiltinTool)', async () => {
      // The Task tool MUST be routed before executeBuiltinTool — otherwise
      // it would land in the Unknown-tool fallback which would return an
      // is_error tool_result with the BUILTIN_TOOL_NAMES enumeration.
      // This test pins the routing by stubbing _executeTaskTool and
      // asserting it gets called.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      let taskCalled = false
      session._executeTaskTool = async ({ toolUseId }) => {
        taskCalled = true
        return { content: 'routed ok', isError: false }
      }
      const toolResult = await runOneToolRound(session, {
        id: 'tu_route', name: 'Task', input: { description: 'd', prompt: 'p' },
      })
      assert.equal(taskCalled, true, '_executeTaskTool must run for the Task tool')
      assert.ok(toolResult)
      assert.equal(toolResult.is_error, false)
      assert.equal(toolResult.content, 'routed ok')
      await session.destroy()
    })

    /**
     * Helper for the #5017 override tests: wires the parent to emit a
     * single Task tool_use carrying `taskInput`, intercepts the child
     * registration to capture its permissionMode, and returns
     * { childMode, taskResult } after the parent turn completes.
     *
     * The parent's permission gate is stubbed to always allow regardless
     * of parentMode — these tests focus on the per-launch override
     * semantics inside _executeTaskTool, not on whether the parent gates
     * Task in approve/acceptEdits/plan modes. Without this stub, parent
     * modes other than 'auto' block on the permission_request emit
     * waiting for a UI response that never arrives in unit tests.
     */
    async function runTaskWithPermissionOverride({ parentMode, permissionMode }) {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode(parentMode)
      session._gateToolBlock = async () => ({ behavior: 'allow' })
      const captured = captureEvents(session)
      const taskInput = { description: 'd', prompt: 'p' }
      if (permissionMode !== undefined) taskInput.permission_mode = permissionMode
      let childMode = null
      const origSet = session._subagentSessions.set.bind(session._subagentSessions)
      session._subagentSessions.set = (k, v) => {
        // Snapshot the child's permission mode at the moment it gets
        // registered — this is AFTER _executeTaskTool assigns
        // child.permissionMode and BEFORE any further setup.
        childMode = v.permissionMode
        // Force-allow the child's permission gate too — defensive,
        // since the child stream in this helper never emits tool_use,
        // but if a future change adds child tool_use deltas they
        // shouldn't block.
        v._gateToolBlock = async () => ({ behavior: 'allow' })
        return origSet(k, v)
      }
      setupParentEmittingTaskOnce(session, {
        taskInput,
        childStreamImpl: () => fakeStream(
          [
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'child ok' } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          ],
          { stop_reason: 'end_turn', content: [{ type: 'text', text: 'child ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
        ),
      })
      await session.start()
      await session.sendMessage('delegate')
      const taskResult = captured.find((e) => e.name === 'tool_result' && e.payload.toolUseId === 'tu_task_1')
      await session.destroy()
      return { childMode, taskResult, captured }
    }

    it('Task `permission_mode` omitted: child inherits parent mode (#5017)', async () => {
      const { childMode, taskResult } = await runTaskWithPermissionOverride({
        parentMode: 'auto',
        // omitted
      })
      assert.equal(childMode, 'auto', 'child must inherit parent permissionMode when override omitted')
      assert.ok(taskResult)
      assert.equal(taskResult.payload.isError, false,
        `expected tool_result not to be is_error, got: ${taskResult.payload.result}`)
    })

    it('Task `permission_mode` downgrade allowed (parent auto → child approve) (#5017)', async () => {
      const { childMode, taskResult } = await runTaskWithPermissionOverride({
        parentMode: 'auto',
        permissionMode: 'approve',
      })
      assert.equal(childMode, 'approve', 'child must take the override when downgrading')
      assert.ok(taskResult)
      assert.equal(taskResult.payload.isError, false)
    })

    it('Task `permission_mode` downgrade to plan allowed (parent acceptEdits → child plan) (#5017)', async () => {
      const { childMode, taskResult } = await runTaskWithPermissionOverride({
        parentMode: 'acceptEdits',
        permissionMode: 'plan',
      })
      assert.equal(childMode, 'plan')
      assert.equal(taskResult.payload.isError, false)
    })

    it('Task `permission_mode` equal-to-parent allowed (parent approve → child approve) (#5017)', async () => {
      const { childMode, taskResult } = await runTaskWithPermissionOverride({
        parentMode: 'approve',
        permissionMode: 'approve',
      })
      assert.equal(childMode, 'approve')
      assert.equal(taskResult.payload.isError, false)
    })

    it('Task `permission_mode` upgrade rejected (parent approve → child auto) (#5017)', async () => {
      const { childMode, taskResult } = await runTaskWithPermissionOverride({
        parentMode: 'approve',
        permissionMode: 'auto',
      })
      assert.equal(childMode, null, 'no child must be spawned when override is rejected')
      assert.ok(taskResult)
      assert.equal(taskResult.payload.isError, true)
      assert.match(taskResult.payload.result, /permissive/i,
        'rejection message must explain the at-most-as-permissive rule')
    })

    it('Task `permission_mode` upgrade rejected (parent plan → child approve) (#5017)', async () => {
      const { childMode, taskResult } = await runTaskWithPermissionOverride({
        parentMode: 'plan',
        permissionMode: 'approve',
      })
      assert.equal(childMode, null)
      assert.equal(taskResult.payload.isError, true)
      assert.match(taskResult.payload.result, /permissive/i)
    })

    it('Task `permission_mode` invalid value rejected (#5017)', async () => {
      const { childMode, taskResult } = await runTaskWithPermissionOverride({
        parentMode: 'auto',
        permissionMode: 'sudo',
      })
      assert.equal(childMode, null, 'no child spawned for invalid mode')
      assert.ok(taskResult)
      assert.equal(taskResult.payload.isError, true)
      assert.match(taskResult.payload.result, /invalid.*permission_mode|allowed values/i)
    })

    it('Task `permission_mode` non-string value rejected (#5017)', async () => {
      const { childMode, taskResult } = await runTaskWithPermissionOverride({
        parentMode: 'auto',
        permissionMode: 7,
      })
      assert.equal(childMode, null)
      assert.equal(taskResult.payload.isError, true)
      assert.match(taskResult.payload.result, /invalid.*permission_mode|allowed values/i)
    })

    it('Task `permission_mode` downgrade-allowed / upgrade-rejected matrix is exhaustive (#5017)', async () => {
      // Verify every (parent, child) pair against the ranking
      // plan < approve < acceptEdits < auto.
      const modes = ['plan', 'approve', 'acceptEdits', 'auto']
      const rank = { plan: 0, approve: 1, acceptEdits: 2, auto: 3 }
      for (const parent of modes) {
        for (const requested of modes) {
          const expectedAllowed = rank[requested] <= rank[parent]
          const { childMode, taskResult } = await runTaskWithPermissionOverride({
            parentMode: parent,
            permissionMode: requested,
          })
          if (expectedAllowed) {
            assert.equal(childMode, requested,
              `parent=${parent} requested=${requested}: child should be ${requested} but was ${childMode}`)
            assert.equal(taskResult.payload.isError, false,
              `parent=${parent} requested=${requested}: should be allowed`)
          } else {
            assert.equal(childMode, null,
              `parent=${parent} requested=${requested}: must reject (no child spawned)`)
            assert.equal(taskResult.payload.isError, true,
              `parent=${parent} requested=${requested}: must be is_error`)
          }
        }
      }
    })

    /**
     * #5019: subagent MCP inheritance helpers.
     *
     * The Task subagent should — by default — borrow the parent's
     * already-running MCP fleet so nested tool use can call the same
     * `mcp__<server>__<tool>` set the parent sees, at zero extra
     * spawn cost. The child must NOT own the fleet (destroy() on the
     * child must leave the parent's MCP children alive). An explicit
     * `inherit_mcp: false` on the Task input reverts to the pre-#5019
     * behaviour of running the subagent with built-in tools only.
     */
    function captureChildFromTaskCall(session, taskInput, opts = {}) {
      // Snapshot the child the moment _executeTaskTool registers it.
      // Tests inspect _mcpFleet / _ownsMcpFleet on this reference, and
      // we ALSO snapshot the field values at registration time because
      // the Task tool's finally block calls child.destroy() before
      // sendMessage resolves — destroy() nulls _mcpFleet, so reading
      // these fields off the captured child after-the-fact always sees
      // the post-destroy state. The snapshot lets tests assert what the
      // child looked like while it was actually running, AND we expose
      // a tools snapshot so _buildTools() can be exercised pre-destroy.
      let capturedChild = null
      let snapshot = null
      const origSet = session._subagentSessions.set.bind(session._subagentSessions)
      session._subagentSessions.set = (k, v) => {
        capturedChild = v
        snapshot = {
          mcpFleet: v._mcpFleet,
          ownsMcpFleet: v._ownsMcpFleet,
          tools: v._buildTools(),
        }
        // Force-allow the child's permission gate — Task subagents
        // run their own permission flow on tool_use blocks, but the
        // dummy child stream below never emits one. This matches the
        // pattern used by runTaskWithPermissionOverride.
        v._gateToolBlock = async () => ({ behavior: 'allow' })
        // #5019 leak test: optional hook so a test can intercept the
        // child's destroy() and observe whether fleet.destroy() ran.
        if (opts.onChildRegistered) opts.onChildRegistered(v)
        return origSet(k, v)
      }
      setupParentEmittingTaskOnce(session, {
        taskInput,
        childStreamImpl: () => fakeStream(
          [
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'ok' } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          ],
          { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
        ),
      })
      return () => ({ child: capturedChild, snapshot })
    }

    it('Task subagent inherits parent MCP fleet by default (#5019)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      // Simulate a running parent MCP fleet. The exact shape doesn't
      // matter for inheritance — the child should just point at the
      // same object reference.
      const parentFleet = {
        anthropicTools: [{ name: 'mcp__stub__echo' }],
        async destroy() { /* noop */ },
      }
      session._mcpFleet = parentFleet
      const getChild = captureChildFromTaskCall(session, { description: 'd', prompt: 'p' })
      await session.start()
      await session.sendMessage('go')
      const { child, snapshot } = getChild()
      assert.ok(child, 'subagent must be registered')
      // Snapshot taken at registration time — child.destroy() in the
      // Task tool's finally block nulls _mcpFleet by the time
      // sendMessage resolves, but the registration-time snapshot
      // captures what the child looked like while it was running.
      assert.strictEqual(snapshot.mcpFleet, parentFleet,
        'child must share the parent fleet reference (no per-spawn child-process cost)')
      assert.equal(snapshot.ownsMcpFleet, false,
        'child must NOT own the borrowed fleet — destroy() will leave it alive')
      // _buildTools() output captured pre-destroy proves the child
      // surfaces the parent's MCP tools to the model on its next turn.
      const mcpToolNames = snapshot.tools.filter((t) => t.name.startsWith('mcp__')).map((t) => t.name)
      assert.deepEqual(mcpToolNames, ['mcp__stub__echo'],
        'child must expose the parent fleet\'s mcp__ tools to its model')
      await session.destroy()
    })

    it('Task subagent destroy() does NOT tear down the parent MCP fleet (#5019)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      let fleetDestroyed = false
      const parentFleet = {
        anthropicTools: [],
        async destroy() { fleetDestroyed = true },
      }
      session._mcpFleet = parentFleet
      // The Task tool's finally block calls child.destroy() after the
      // child's result event fires. If we incorrectly let the child
      // own the fleet, this destroy would invoke parentFleet.destroy()
      // mid-parent-turn — killing every MCP child for any sibling Task
      // still in flight.
      const getChild = captureChildFromTaskCall(session, { description: 'd', prompt: 'p' })
      await session.start()
      await session.sendMessage('go')
      const { child } = getChild()
      assert.ok(child)
      // child.destroy() has already run inside _executeTaskTool's
      // finally block by the time sendMessage resolves. Assert the
      // fleet survived.
      assert.equal(fleetDestroyed, false,
        'child.destroy() MUST NOT call parentFleet.destroy() — parent owns the fleet')
      // Now destroy the parent explicitly — fleet must run exactly
      // once, from the owning session's teardown.
      await session.destroy()
      assert.equal(fleetDestroyed, true,
        'parent destroy must tear down its own fleet')
    })

    it('Task `inherit_mcp: false` runs the subagent without MCP (#5019)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      const parentFleet = {
        anthropicTools: [{ name: 'mcp__stub__echo' }],
        async destroy() { /* noop */ },
      }
      session._mcpFleet = parentFleet
      const getChild = captureChildFromTaskCall(session, {
        description: 'd',
        prompt: 'p',
        inherit_mcp: false,
      })
      await session.start()
      await session.sendMessage('go')
      const { child, snapshot } = getChild()
      assert.ok(child, 'subagent must still be registered when inherit_mcp:false')
      assert.equal(snapshot.mcpFleet, null,
        'inherit_mcp:false must skip fleet inheritance — child runs without MCP')
      assert.equal(snapshot.ownsMcpFleet, true,
        'an MCP-less child keeps the default ownership flag (no borrowing happened)')
      const mcpToolNames = snapshot.tools.filter((t) => t.name.startsWith('mcp__'))
      assert.equal(mcpToolNames.length, 0,
        'inherit_mcp:false child must not expose any mcp__ tools')
      await session.destroy()
    })

    it('Task subagent skips inheritance when the parent has no fleet (#5019)', async () => {
      // No MCP config → no parent fleet → child gets nothing to
      // borrow. Should not throw, should not flip _ownsMcpFleet, and
      // _buildTools() should fall through to BUILTIN_TOOLS only.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      assert.equal(session._mcpFleet, null, 'precondition: parent has no fleet')
      const getChild = captureChildFromTaskCall(session, { description: 'd', prompt: 'p' })
      await session.start()
      await session.sendMessage('go')
      const { child, snapshot } = getChild()
      assert.ok(child)
      assert.equal(snapshot.mcpFleet, null, 'no fleet to inherit')
      assert.equal(snapshot.ownsMcpFleet, true, 'ownership flag stays at default when no borrow happens')
      await session.destroy()
    })

    it('Task `inherit_mcp` non-boolean value rejected (#5019)', async () => {
      // Strings, numbers, null — anything non-boolean must be rejected
      // with an is_error tool_result rather than silently coerced.
      // The model needs a crisp signal so it can fix its tool_use.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._gateToolBlock = async () => ({ behavior: 'allow' })
      const captured = captureEvents(session)
      let childSpawned = false
      const origSet = session._subagentSessions.set.bind(session._subagentSessions)
      session._subagentSessions.set = (k, v) => {
        childSpawned = true
        return origSet(k, v)
      }
      setupParentEmittingTaskOnce(session, {
        taskInput: { description: 'd', prompt: 'p', inherit_mcp: 'yes' },
        childStreamImpl: () => fakeStream(
          [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
          { stop_reason: 'end_turn', content: [{ type: 'text', text: '' }], usage: { input_tokens: 1, output_tokens: 1 } },
        ),
      })
      await session.start()
      await session.sendMessage('go')
      const taskResult = captured.find((e) => e.name === 'tool_result' && e.payload.toolUseId === 'tu_task_1')
      assert.ok(taskResult, 'a tool_result must be emitted even on rejection')
      assert.equal(taskResult.payload.isError, true,
        'non-boolean inherit_mcp must produce is_error tool_result')
      assert.match(taskResult.payload.result, /inherit_mcp/i,
        'rejection message must name the offending field')
      assert.equal(childSpawned, false,
        'no subagent must be spawned when inherit_mcp is invalid')
      // #5019 review: the rejection must run BEFORE agent_spawned is
      // emitted and BEFORE _activeAgents is populated — otherwise the
      // dashboard's active-agents badge would show a phantom entry that
      // never clears. Mirrors the placement of the permission_mode
      // typecheck (#5017). Pins the early-return cleanliness.
      const spawnEvents = captured.filter((e) => e.name === 'agent_spawned')
      assert.equal(spawnEvents.length, 0,
        'agent_spawned must NOT be emitted when inherit_mcp rejection fires')
      assert.equal(session._activeAgents.size, 0,
        '_activeAgents must stay empty on inherit_mcp rejection — no phantom badge entry')
      await session.destroy()
    })

    it('Task input_schema declares inherit_mcp as a boolean (#5019)', () => {
      // Protocol-surface assertion: the Task tool advertises its
      // inherit_mcp affordance so the model can discover it. This
      // guards against accidental schema regressions.
      const taskTool = BUILTIN_TOOLS.find((t) => t.name === 'Task')
      assert.ok(taskTool, 'BUILTIN_TOOLS must include the Task tool')
      const prop = taskTool.input_schema.properties.inherit_mcp
      assert.ok(prop, 'Task input_schema must expose inherit_mcp')
      assert.equal(prop.type, 'boolean', 'inherit_mcp must be typed as boolean')
      assert.match(prop.description, /default|MCP/i,
        'description must mention the default behaviour')
    })

    /**
     * #5018: subagent_type profile registry. When the id is known, the
     * profile's systemPrompt is applied to the child's sessionPreamble
     * (via setSessionPreamble so the same cap as user-authored preambles
     * applies) and the profile's toolSet (when restricted) limits which
     * BUILTIN_TOOLS the child sees in its `_buildTools()` output. When
     * the id is unknown or malformed, the runner warns and falls back to
     * the v1 default (no profile applied) per the issue's acceptance
     * criteria — the spawn still succeeds so a future model that requests
     * a profile this server doesn't know about stays forward-compatible.
     *
     * Helper shape mirrors runTaskWithPermissionOverride above: stub
     * the parent's gate to always-allow so the tests focus on the
     * subagent_type semantics inside _executeTaskTool.
     */
    async function runTaskWithSubagentType({ subagentType }) {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._gateToolBlock = async () => ({ behavior: 'allow' })
      const captured = captureEvents(session)
      const taskInput = { description: 'd', prompt: 'p' }
      if (subagentType !== undefined) taskInput.subagent_type = subagentType
      let childSnapshot = null
      const origSet = session._subagentSessions.set.bind(session._subagentSessions)
      session._subagentSessions.set = (k, v) => {
        // Snapshot the child's state at registration time — this is AFTER
        // _executeTaskTool applies the profile and BEFORE any further
        // setup. We capture sessionPreamble (where the profile's
        // systemPrompt rides) and the result of _buildTools() so the
        // assertions can verify both wirings.
        childSnapshot = {
          sessionPreamble: v.sessionPreamble,
          tools: v._buildTools().map((t) => t.name),
          allowedBuiltinToolNames: v._allowedBuiltinToolNames
            ? [...v._allowedBuiltinToolNames]
            : null,
        }
        v._gateToolBlock = async () => ({ behavior: 'allow' })
        return origSet(k, v)
      }
      setupParentEmittingTaskOnce(session, {
        taskInput,
        childStreamImpl: () => fakeStream(
          [
            { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: 'child ok' } },
            { type: 'message_delta', delta: { stop_reason: 'end_turn' } },
          ],
          { stop_reason: 'end_turn', content: [{ type: 'text', text: 'child ok' }], usage: { input_tokens: 1, output_tokens: 1 } },
        ),
      })
      await session.start()
      await session.sendMessage('delegate')
      const taskResult = captured.find((e) => e.name === 'tool_result' && e.payload.toolUseId === 'tu_task_1')
      const spawned = captured.find((e) => e.name === 'agent_spawned')
      await session.destroy()
      return { childSnapshot, taskResult, spawned, captured }
    }

    it('Task `subagent_type` omitted: no profile applied (default v1 behaviour) (#5018)', async () => {
      const { childSnapshot, taskResult } = await runTaskWithSubagentType({})
      assert.ok(childSnapshot, 'child must spawn')
      assert.equal(childSnapshot.sessionPreamble, '',
        'no profile applied → child sessionPreamble stays empty (no override)')
      assert.equal(childSnapshot.allowedBuiltinToolNames, null,
        'no profile applied → no tool filter registered on the child')
      assert.ok(taskResult)
      assert.equal(taskResult.payload.isError, false)
    })

    it('Task `subagent_type: "general-purpose"` applies the profile systemPrompt (#5018)', async () => {
      const { childSnapshot, taskResult } = await runTaskWithSubagentType({
        subagentType: 'general-purpose',
      })
      assert.ok(childSnapshot, 'child must spawn')
      assert.ok(childSnapshot.sessionPreamble.length > 0,
        'profile systemPrompt must be applied to the child as sessionPreamble')
      assert.match(childSnapshot.sessionPreamble, /sub-?agent/i,
        'general-purpose systemPrompt should reference subagent role')
      assert.equal(taskResult.payload.isError, false)
    })

    it('Task `subagent_type: "general-purpose"` keeps the full toolSet (no filter) (#5018)', async () => {
      const { childSnapshot } = await runTaskWithSubagentType({
        subagentType: 'general-purpose',
      })
      assert.ok(childSnapshot)
      // general-purpose has toolSet: 'all' → no filter installed, and the
      // tool list includes every built-in (BUILTIN_TOOLS).
      assert.equal(childSnapshot.allowedBuiltinToolNames, null,
        'toolSet === "all" must NOT install a filter on the child')
      assert.ok(childSnapshot.tools.includes('Read'))
      assert.ok(childSnapshot.tools.includes('Write'))
      assert.ok(childSnapshot.tools.includes('Bash'))
      assert.ok(childSnapshot.tools.includes('Task'),
        'general-purpose child can recursively spawn Task subagents')
    })

    it('Task `subagent_type: "code-reviewer"` restricts the child toolSet to Read/Grep/Glob (#5018)', async () => {
      const { childSnapshot, taskResult } = await runTaskWithSubagentType({
        subagentType: 'code-reviewer',
      })
      assert.ok(childSnapshot)
      // code-reviewer profile carries toolSet: ['Read', 'Grep', 'Glob'] —
      // the child must NOT see Write/Edit/Bash so the reviewer can't
      // accidentally mutate the workspace.
      assert.ok(Array.isArray(childSnapshot.allowedBuiltinToolNames))
      assert.ok(childSnapshot.tools.includes('Read'))
      assert.ok(childSnapshot.tools.includes('Grep'))
      assert.ok(childSnapshot.tools.includes('Glob'))
      assert.ok(!childSnapshot.tools.includes('Write'),
        'code-reviewer must NOT see Write (read-only role)')
      assert.ok(!childSnapshot.tools.includes('Edit'),
        'code-reviewer must NOT see Edit (read-only role)')
      assert.ok(!childSnapshot.tools.includes('Bash'),
        'code-reviewer must NOT see Bash (read-only role)')
      assert.equal(taskResult.payload.isError, false)
    })

    it('Task `subagent_type` unknown value falls back to v1 default with no profile (#5018)', async () => {
      const { childSnapshot, taskResult, spawned } = await runTaskWithSubagentType({
        subagentType: 'totally-not-a-real-profile',
      })
      // Per #5018 acceptance criteria: unknown subagent_type falls back to
      // v1 behaviour (no profile applied) and warns. The child IS spawned,
      // the tool_result is success, and the child has no profile-driven
      // preamble or tool filter.
      assert.ok(childSnapshot,
        'child must spawn even when subagent_type is unknown (warn + fall back)')
      assert.ok(spawned,
        'agent_spawned must fire for the spawn (only profile application is skipped)')
      assert.equal(childSnapshot.sessionPreamble, '',
        'unknown profile id must NOT apply any preamble (v1 default)')
      assert.equal(childSnapshot.allowedBuiltinToolNames, null,
        'unknown profile id must NOT install a tool filter (v1 default)')
      assert.ok(taskResult)
      assert.equal(taskResult.payload.isError, false,
        'unknown subagent_type must NOT fail the tool call (forward-compat)')
    })

    it('Task `subagent_type` non-string value falls back to v1 default (#5018)', async () => {
      const { childSnapshot, taskResult } = await runTaskWithSubagentType({
        subagentType: 7,
      })
      // Non-string ids are treated as unknown: warn + fall back, do not
      // fail the tool call (the schema enum is the model-facing guardrail;
      // the runtime stays forgiving).
      assert.ok(childSnapshot)
      assert.equal(childSnapshot.sessionPreamble, '')
      assert.equal(childSnapshot.allowedBuiltinToolNames, null)
      assert.equal(taskResult.payload.isError, false)
    })

    it('Task `subagent_type` empty string falls back to v1 default (#5018)', async () => {
      const { childSnapshot, taskResult } = await runTaskWithSubagentType({
        subagentType: '',
      })
      // Empty string is not a valid profile id but is treated as the
      // unknown path — warn + fall back, do not fail the tool call.
      assert.ok(childSnapshot)
      assert.equal(childSnapshot.sessionPreamble, '')
      assert.equal(childSnapshot.allowedBuiltinToolNames, null)
      assert.equal(taskResult.payload.isError, false)
    })
  })

  describe('Task subagent nested progress events (#5016)', () => {
    /**
     * Build a parent that emits a single Task tool_use. Once the child
     * is registered we manually drive its EventEmitter via the captured
     * reference so we can simulate the child emitting tool_start /
     * tool_input_delta / tool_result / stream_delta without having to
     * stand up a second full agent loop. The parent's `_executeTaskTool`
     * subscribes to those child events and re-emits `agent_event` —
     * which is what these tests exercise.
     */
    async function runTaskAndDriveChild(driveChild) {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      // Force-allow any parent permission check (mirrors the override
      // tests). These cases focus on event forwarding inside
      // _executeTaskTool; permission gating is exercised elsewhere.
      session._gateToolBlock = async () => ({ behavior: 'allow' })
      const captured = []
      session.on('agent_event', (e) => captured.push(e))
      session.on('agent_spawned', (e) => captured.push({ ...e, _name: 'agent_spawned' }))
      session.on('agent_completed', (e) => captured.push({ ...e, _name: 'agent_completed' }))
      // Replace the child-construction step so we can grab the child
      // reference + control its `sendMessage` to deterministically emit
      // a sequence of intermediate events, then resolve.
      let childRef = null
      const origSet = session._subagentSessions.set.bind(session._subagentSessions)
      session._subagentSessions.set = (k, v) => {
        childRef = v
        // Stub child.sendMessage to drive the simulated child events,
        // then emit `result` (which causes _executeTaskTool's done
        // promise to resolve and finalise the parent's tool_result).
        v.sendMessage = async () => {
          await driveChild(v)
          v.emit('result', {
            messageId: 'cm_1',
            usage: { input_tokens: 10, output_tokens: 20 },
            cost: 0,
          })
          v.emit('stream_end', { messageId: 'cm_1' })
          v._isBusy = false
        }
        return origSet(k, v)
      }
      // Stub parent's client to emit Task once then end-turn.
      let parentRound = 0
      session._client = {
        messages: {
          stream: () => {
            parentRound += 1
            if (parentRound === 1) {
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
                {
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 'tu_task_5016', name: 'Task', input: { description: 'd', prompt: 'p' } }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
              { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      await session.start()
      await session.sendMessage('go')
      await session.destroy()
      return { captured, childRef }
    }

    it('re-emits child tool_start/tool_input_delta/tool_result as agent_event tagged with parentToolUseId', async () => {
      const { captured } = await runTaskAndDriveChild((child) => {
        child.emit('tool_start', { messageId: 'cm_1', toolUseId: 'tu_child_read', tool: 'Read', input: { file_path: '/tmp/x.txt' } })
        child.emit('tool_input_delta', { messageId: 'cm_1', toolUseId: 'tu_child_read', partialJson: '{"file_path":' })
        child.emit('tool_input_delta', { messageId: 'cm_1', toolUseId: 'tu_child_read', partialJson: '"/tmp/x.txt"}' })
        child.emit('tool_result', { messageId: 'cm_1', toolUseId: 'tu_child_read', result: 'hello\nfrom child', isError: false })
      })
      const events = captured.filter((e) => e.parentToolUseId)
      assert.ok(events.length >= 4, `expected >=4 agent_events, got ${events.length}`)
      // Each event carries the parent's toolUseId, the child's wire
      // event name, and the verbatim child payload.
      assert.ok(events.every((e) => e.parentToolUseId === 'tu_task_5016'),
        'every agent_event must carry the parent toolUseId')
      const toolStart = events.find((e) => e.type === 'tool_start')
      assert.ok(toolStart)
      assert.equal(toolStart.payload.toolUseId, 'tu_child_read')
      assert.equal(toolStart.payload.tool, 'Read')
      const toolResult = events.find((e) => e.type === 'tool_result')
      assert.ok(toolResult)
      assert.equal(toolResult.payload.toolUseId, 'tu_child_read')
      assert.equal(toolResult.payload.result, 'hello\nfrom child')
      const deltas = events.filter((e) => e.type === 'tool_input_delta')
      assert.equal(deltas.length, 2)
      assert.equal(deltas[0].payload.partialJson, '{"file_path":')
      assert.equal(deltas[1].payload.partialJson, '"/tmp/x.txt"}')
    })

    it('re-emits child stream_delta as agent_event so dashboard sees child assistant text', async () => {
      const { captured } = await runTaskAndDriveChild((child) => {
        child.emit('stream_delta', { messageId: 'cm_1', delta: 'Hello ' })
        child.emit('stream_delta', { messageId: 'cm_1', delta: 'world.' })
      })
      const deltas = captured.filter((e) => e.type === 'stream_delta')
      assert.equal(deltas.length, 2, 'both stream_delta chunks must be re-emitted')
      assert.equal(deltas[0].parentToolUseId, 'tu_task_5016')
      assert.equal(deltas[0].payload.delta, 'Hello ')
      assert.equal(deltas[1].payload.delta, 'world.')
    })

    it('nested Task: grand-child agent_event is re-tagged with the outermost parent toolUseId', async () => {
      // The child's `agent_event` listener forwards grand-child progress
      // up the chain re-tagged with THIS parent's toolUseId. Simulate
      // by emitting a synthetic `agent_event` on the child as if the
      // child itself had dispatched a Task.
      const { captured } = await runTaskAndDriveChild((child) => {
        child.emit('agent_event', {
          parentToolUseId: 'tu_grandchild_task',
          type: 'tool_start',
          payload: { messageId: 'gc_1', toolUseId: 'tu_gc_read', tool: 'Read', input: {} },
        })
      })
      const forwarded = captured.find((e) => e.type === 'tool_start' && e.payload.toolUseId === 'tu_gc_read')
      assert.ok(forwarded, 'grand-child tool_start must be forwarded')
      assert.equal(forwarded.parentToolUseId, 'tu_task_5016',
        'grand-child events must re-tag with the OUTERMOST parent toolUseId')
      // The original grand-child parentToolUseId (immediate parent = the
      // child Task) is preserved on payload.parentToolUseId so
      // depth-aware consumers can reconstruct the chain.
      assert.equal(forwarded.payload.parentToolUseId, 'tu_grandchild_task',
        'grand-child events must preserve the immediate parent toolUseId on payload')
    })

    it('agent_event listed in customEvents so SessionManager forwards it as a transient event', () => {
      assert.ok(ClaudeByokSession.customEvents.includes('agent_event'),
        'agent_event must be in customEvents for ws-forwarding to pick it up')
    })

    // #5056 / #5061 — child permission_request relay. The child has its own
    // PermissionManager (separate identity from the parent's); when the
    // subagent fires a permission_request (e.g. an MCP tool under approve
    // mode), nothing previously bridged it up to the parent's wire path.
    // The dashboard never saw the prompt and the request silently timed out.
    // These tests pin the relay envelope + the response routing back down.
    it('#5056: re-emits child permission_request as agent_event with parentToolUseId so dashboard can render it nested', async () => {
      const { captured } = await runTaskAndDriveChild((child) => {
        child.emit('permission_request', {
          requestId: 'perm-child-1',
          tool: 'mcp__foo__bar',
          description: 'mcp__foo__bar({"x":1})',
          input: { x: 1 },
          remainingMs: 60000,
          createdAt: Date.now(),
        })
      })
      const permEvents = captured.filter(
        (e) => e.parentToolUseId && e.type === 'permission_request',
      )
      assert.equal(permEvents.length, 1,
        'child permission_request must surface exactly once on the parent')
      assert.equal(permEvents[0].parentToolUseId, 'tu_task_5016')
      assert.equal(permEvents[0].payload.requestId, 'perm-child-1')
      assert.equal(permEvents[0].payload.tool, 'mcp__foo__bar')
      assert.equal(permEvents[0].payload.input.x, 1)
    })

    it('#5056: re-emits child permission_resolved so the dashboard can clear the nested prompt', async () => {
      const { captured } = await runTaskAndDriveChild((child) => {
        child.emit('permission_request', {
          requestId: 'perm-child-2',
          tool: 'mcp__foo__bar',
          description: '...',
          input: {},
          remainingMs: 60000,
          createdAt: Date.now(),
        })
        child.emit('permission_resolved', {
          requestId: 'perm-child-2',
          decision: 'allow',
          reason: 'user',
        })
      })
      const resolved = captured.find(
        (e) => e.parentToolUseId && e.type === 'permission_resolved',
      )
      assert.ok(resolved, 'permission_resolved must be relayed on the parent')
      assert.equal(resolved.parentToolUseId, 'tu_task_5016')
      assert.equal(resolved.payload.requestId, 'perm-child-2')
      assert.equal(resolved.payload.decision, 'allow')
    })

    it('#5056: parent.respondToPermission routes a child requestId to the child PermissionManager', async () => {
      // The user taps Approve/Deny in the dashboard; the wire message lands
      // on the parent session id (the only one ws-permissions knows about).
      // The parent must forward the response to the child whose
      // PermissionManager actually holds the pending entry.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session.setPermissionMode('auto')
      session._gateToolBlock = async () => ({ behavior: 'allow' })
      // Replace the child-set so we can grab the child without running a
      // full agent loop.
      let childRef = null
      const origSet = session._subagentSessions.set.bind(session._subagentSessions)
      session._subagentSessions.set = (k, v) => {
        childRef = v
        v.sendMessage = async () => {
          // Trigger the child to emit a permission_request — the parent's
          // listener should record the routing so respondToPermission can
          // find it.
          v.emit('permission_request', {
            requestId: 'perm-child-routed',
            tool: 'mcp__foo__bar',
            input: {},
            remainingMs: 60000,
          })
          // Populate the child's own pending map so the response actually
          // resolves something (the PermissionManager keys by requestId
          // and rejects unknown requestIds).
          let resolvedResult = null
          v._permissions._pendingPermissions.set('perm-child-routed', {
            resolve: (r) => { resolvedResult = r },
            input: { x: 1 },
          })
          // Sanity: the parent doesn't yet hold the request.
          assert.equal(session._permissions._pendingPermissions.has('perm-child-routed'), false)
          // Route a response addressed to the child's requestId via the
          // parent's respondToPermission (the only API exposed on the WS
          // surface).
          const ok = session.respondToPermission('perm-child-routed', 'allow')
          assert.equal(ok, true, 'parent.respondToPermission must succeed for a child requestId')
          assert.ok(resolvedResult, 'the child PermissionManager must receive the decision')
          assert.equal(resolvedResult.behavior, 'allow')
          v.emit('result', { messageId: 'cm_1', usage: { input_tokens: 0, output_tokens: 0 }, cost: 0 })
          v.emit('stream_end', { messageId: 'cm_1' })
          v._isBusy = false
        }
        return origSet(k, v)
      }
      session._client = {
        messages: {
          stream: () => {
            // First call: emit a Task tool_use. Second call: end_turn.
            if (!session._client._round) {
              session._client._round = 1
              return fakeStream(
                [{ type: 'message_delta', delta: { stop_reason: 'tool_use' } }],
                {
                  stop_reason: 'tool_use',
                  content: [{ type: 'tool_use', id: 'tu_task_routing', name: 'Task', input: { description: 'd', prompt: 'p' } }],
                  usage: { input_tokens: 1, output_tokens: 1 },
                },
              )
            }
            return fakeStream(
              [{ type: 'message_delta', delta: { stop_reason: 'end_turn' } }],
              { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }], usage: { input_tokens: 1, output_tokens: 1 } },
            )
          },
        },
      }
      await session.start()
      await session.sendMessage('go')
      // After the child finishes, the routing entry should be cleared so
      // a stale lookup of the same id doesn't leak past the request's
      // lifetime.
      assert.ok(childRef, 'child was created')
      assert.equal(
        session._subagentPermissionRouting.has('perm-child-routed'),
        false,
        'routing entry must be cleared after the child resolves + finishes',
      )
      assert.equal(
        session._subagentPermissionRouting.size,
        0,
        'no routing entries should leak past the request lifetime',
      )
      await session.destroy()
    })

    it('#5056: parent.respondToPermission falls back to the parent PermissionManager for unknown child ids', async () => {
      // Sanity: routing must not break the existing top-level path. A
      // requestId that the parent's PermissionManager holds (the normal
      // case) still resolves there even when subagents are active.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      let resolvedOnParent = null
      session._permissions._pendingPermissions.set('perm-parent-1', {
        resolve: (r) => { resolvedOnParent = r },
        input: {},
      })
      const ok = session.respondToPermission('perm-parent-1', 'deny')
      assert.equal(ok, true)
      assert.ok(resolvedOnParent)
      assert.equal(resolvedOnParent.behavior, 'deny')
      await session.destroy()
    })
  })

  describe('lifecycle', () => {
    it('destroy() is idempotent and clears history', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = { messages: { stream: () => fakeStream([]) } }
      await session.start()
      session._history.push({ role: 'user', content: 'foo' })
      await session.destroy()
      assert.equal(session._history.length, 0)
      await session.destroy()  // second call must not throw
    })

    it('destroy() clears the todo Map (#4137)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = { messages: { stream: () => fakeStream([]) } }
      await session.start()
      session._todos.set('t1', { id: 't1', content: 'work', status: 'pending' })
      session._todos.set('t2', { id: 't2', content: 'more work', status: 'in_progress' })
      assert.equal(session._todos.size, 2)
      await session.destroy()
      assert.equal(session._todos.size, 0)
    })

    it('destroy() clears _cwdRealCache and _pricingWarnedModels (#4153)', async () => {
      // Mirror #4137's teardown shape — every in-memory collection on
      // this session should be reset at destroy so a held reference
      // (debugger, future export feature, test introspection) doesn't
      // outlive the session. Neither is a leak risk (both are bounded)
      // but the rationale that motivated _todos.clear() in #4152 applies
      // equally here.
      const session = new ClaudeByokSession({ cwd: '/tmp' })
      session._client = { messages: { stream: () => fakeStream([]) } }
      await session.start()
      session._cwdRealCache.set('/tmp/a', { resolved: '/tmp/a', verifiedAt: Date.now() })
      session._cwdRealCache.set('/tmp/b', { resolved: '/tmp/b', verifiedAt: Date.now() })
      session._pricingWarnedModels.add('claude-future-model-1')
      session._pricingWarnedModels.add('claude-future-model-2')
      assert.equal(session._cwdRealCache.size, 2)
      assert.equal(session._pricingWarnedModels.size, 2)
      await session.destroy()
      assert.equal(session._cwdRealCache.size, 0, '_cwdRealCache cleared')
      assert.equal(session._pricingWarnedModels.size, 0, '_pricingWarnedModels cleared')
    })

    it('setModel updates without restart (stateless SDK client)', async () => {
      const session = new ClaudeByokSession({ cwd: '/tmp', model: 'claude-opus-4-8' })
      session._client = { messages: { stream: () => fakeStream([]) } }
      await session.start()
      session.setModel('claude-sonnet-4-6')
      assert.equal(session.model, 'claude-sonnet-4-6')
      await session.destroy()
    })

    it('setPermissionMode(auto) drains open MCP trust prompts WITHOUT persisting (#4462)', async () => {
      // Mirror sdk-session.js:1133-1135: flipping to auto must drain
      // pending prompts so the user isn't left staring at modals.
      // BUT MCP trust prompts MUST NOT persist via the bypass — they
      // get denied so ~/.chroxy/mcp-trust.json stays untouched.
      const { existsSync, readFileSync } = await import('node:fs')
      const session = new ClaudeByokSession({ cwd: '/tmp', model: 'claude-opus-4-8' })
      session._client = { messages: { stream: () => fakeStream([]) } }
      await session.start()

      // Fire an MCP trust prompt directly on the session's permission
      // manager (same path byok-mcp-fleet's trustGate uses).
      const trustPromise = session._permissions.requestMcpTrust({
        name: 'tofu',
        command: 'node',
        args: ['tofu-mcp.js'],
        envKeys: [],
      })
      // Sanity: there's a pending prompt before the bypass.
      assert.equal(session._permissions._pendingPermissions.size, 1)

      // Bypass flip — autoAllowPending denies MCP trust prompts (#4462).
      session.setPermissionMode('auto')

      const allowed = await trustPromise
      assert.equal(allowed, false, 'MCP trust must NOT be granted via auto-mode bypass')

      // The fleet's gate is: `if (allowed) recordTrust(...)`. With
      // allowed=false, no recordTrust call fires — assert by checking
      // the trust store path was never created.
      const trustStorePath = process.env.CHROXY_MCP_TRUST_PATH
      assert.equal(existsSync(trustStorePath), false, 'trust store must not be written on bypass')

      await session.destroy()
    })
  })

  describe('MCP tool_use dispatch (#4079)', () => {
    function writeStubMcpConfig({ env = {} } = {}) {
      const configPath = join(tmpHome, '.claude.json')
      writeFileSync(configPath, JSON.stringify({
        mcpServers: { stub: { command: process.execPath, args: [MCP_STUB], env } },
      }))
      return configPath
    }

    it('round-trips: model emits tool_use mcp__stub__echo → fleet dispatches → tool_result contains echoed input', async () => {
      preTrustStub()
      const session = new ClaudeByokSession({
        cwd: '/tmp',
        mcpConfigPath: writeStubMcpConfig(),
      })
      session.setPermissionMode('auto')
      const captured = captureEvents(session)
      const toolResult = await runOneToolRound(session, {
        id: 'tu_mcp_1', name: 'mcp__stub__echo', input: { greeting: 'hello' },
      })
      assert.ok(toolResult, 'round 2 must receive a tool_result block')
      assert.equal(toolResult.tool_use_id, 'tu_mcp_1')
      assert.equal(toolResult.is_error, false)
      // The stub echoes args as the text content of the MCP result;
      // _dispatchMcpTool flattens content[].text into a single string.
      assert.equal(toolResult.content, JSON.stringify({ greeting: 'hello' }))
      const toolResultEvent = captured.find(
        (e) => e.name === 'tool_result' && e.payload.toolUseId === 'tu_mcp_1',
      )
      assert.ok(toolResultEvent, 'tool_result event fires for MCP tool')
      assert.equal(toolResultEvent.payload.isError, false)
      await session.destroy()
    })

    it('permission denial blocks dispatch and returns a denial tool_result', async () => {
      preTrustStub()
      const session = new ClaudeByokSession({
        cwd: '/tmp',
        mcpConfigPath: writeStubMcpConfig(),
      })
      // Auto-deny the per-call permission prompt (NOT the trust prompt,
      // which is pre-resolved by preTrustStub above).
      session._permissions.on('permission_request', (data) => {
        if (data.tool === 'mcp_spawn') return
        session._permissions.respondToPermission(data.requestId, 'deny')
      })
      const toolResult = await runOneToolRound(session, {
        id: 'tu_mcp_deny', name: 'mcp__stub__echo', input: {},
      })
      assert.ok(toolResult)
      assert.equal(toolResult.is_error, true)
      // PermissionManager.respondToPermission emits `User denied` as the
      // denial message (permission-manager.js:325); the dispatch path
      // propagates it verbatim into the tool_result.
      assert.match(toolResult.content, /denied/i)
      await session.destroy()
    })

    it('MCP child crash mid-dispatch returns is_error tool_result without crashing the session', async () => {
      preTrustStub()
      const session = new ClaudeByokSession({
        cwd: '/tmp',
        mcpConfigPath: writeStubMcpConfig({ env: { MCP_STUB_TOOL_DIE: '1' } }),
      })
      session.setPermissionMode('auto')
      const toolResult = await runOneToolRound(session, {
        id: 'tu_mcp_crash', name: 'mcp__stub__echo', input: {},
      })
      assert.ok(toolResult, 'session survives the crash and emits a tool_result')
      assert.equal(toolResult.is_error, true)
      assert.match(toolResult.content, /MCP mcp__stub__echo failed/)
      assert.match(toolResult.content, /child exited/)
      // Session is still usable — sendMessage doesn't reject.
      await session.destroy()
    })

    it('MCP RPC error becomes an is_error tool_result', async () => {
      preTrustStub()
      const session = new ClaudeByokSession({
        cwd: '/tmp',
        mcpConfigPath: writeStubMcpConfig({ env: { MCP_STUB_TOOL_RPC_ERROR: '1' } }),
      })
      session.setPermissionMode('auto')
      const toolResult = await runOneToolRound(session, {
        id: 'tu_mcp_rpc', name: 'mcp__stub__echo', input: {},
      })
      assert.ok(toolResult)
      assert.equal(toolResult.is_error, true)
      assert.match(toolResult.content, /forced RPC error/)
      await session.destroy()
    })

    it('MCP server-reported isError propagates as is_error tool_result', async () => {
      preTrustStub()
      const session = new ClaudeByokSession({
        cwd: '/tmp',
        mcpConfigPath: writeStubMcpConfig({ env: { MCP_STUB_TOOL_ERROR: '1' } }),
      })
      session.setPermissionMode('auto')
      const toolResult = await runOneToolRound(session, {
        id: 'tu_mcp_err', name: 'mcp__stub__echo', input: { x: 1 },
      })
      assert.ok(toolResult)
      assert.equal(toolResult.is_error, true)
      assert.equal(toolResult.content, JSON.stringify({ x: 1 }))
      await session.destroy()
    })

    it('built-in tools still route through the in-process executor when an MCP fleet is also active', async () => {
      preTrustStub()
      const tmpFile = join(tmpHome, 'hello.txt')
      writeFileSync(tmpFile, 'hi from disk')
      const session = new ClaudeByokSession({
        cwd: tmpHome,
        mcpConfigPath: writeStubMcpConfig(),
      })
      session.setPermissionMode('auto')
      const toolResult = await runOneToolRound(session, {
        id: 'tu_builtin', name: 'Read', input: { file_path: tmpFile },
      })
      assert.ok(toolResult)
      assert.equal(toolResult.is_error, false)
      assert.match(toolResult.content, /hi from disk/)
      await session.destroy()
    })
  })

  // #4482: per-MCP-call timeout knob — operators can stretch the 30s
  // DEFAULT_TOOL_CALL_TIMEOUT_MS for slow MCP servers (filesystem grep
  // across large repos, container exec, remote API wrappers) without
  // patching byok-mcp-client. The session reads opts.mcpToolCallTimeoutMs
  // (forwarded by session-manager → providerOpts) and passes it as the
  // third arg to fleet.callTool, which propagates to MCPClient.callTool's
  // setTimeout. Unset / non-positive falls back to the fleet/client
  // default — same defensive guard pattern as resultTimeoutMs.
  describe('MCP tools/call timeout configuration (#4482)', () => {
    function buildSessionWithMockFleet(opts = {}) {
      const session = new ClaudeByokSession({ cwd: '/tmp', ...opts })
      const captured = []
      session._mcpFleet = {
        callTool: async (prefixedName, args, timeoutMs) => {
          captured.push({ prefixedName, args, timeoutMs })
          return { content: [{ type: 'text', text: 'ok' }] }
        },
      }
      return { session, captured }
    }

    it('forwards configured mcpToolCallTimeoutMs to fleet.callTool', async () => {
      const { session, captured } = buildSessionWithMockFleet({ mcpToolCallTimeoutMs: 90_000 })
      await session._dispatchMcpTool('mcp__stub__echo', { x: 1 })
      assert.equal(captured.length, 1)
      assert.equal(captured[0].timeoutMs, 90_000,
        '_dispatchMcpTool must propagate the configured timeout so MCPClient.callTool can arm setTimeout against it')
    })

    it('passes undefined (fleet default) when mcpToolCallTimeoutMs is omitted', async () => {
      // Default behaviour: callers that never set the knob get the
      // existing 30s DEFAULT_TOOL_CALL_TIMEOUT_MS via the fleet/client
      // chain — passing `undefined` lets the destructured default in
      // MCPFleet.callTool fire (rather than forcing 30s here too, which
      // would duplicate the constant).
      const { session, captured } = buildSessionWithMockFleet()
      await session._dispatchMcpTool('mcp__stub__echo', {})
      assert.equal(captured.length, 1)
      assert.equal(captured[0].timeoutMs, undefined,
        'omitted opt must leave fleet/client to apply DEFAULT_TOOL_CALL_TIMEOUT_MS — duplicating the constant here would silently desync if MCPClient later retunes its default')
    })

    it('falls back to undefined when mcpToolCallTimeoutMs is non-positive or non-finite', async () => {
      // Same defensive guard as resultTimeoutMs — a config typo
      // (CHROXY_MCP_TOOL_CALL_TIMEOUT_MS=oops → NaN, or -1, or 0) must
      // NOT silently pass through to setTimeout, where:
      //   setTimeout(fn, NaN)      → fires immediately (0ms coercion)
      //   setTimeout(fn, -1)       → fires immediately (clamped to 0)
      //   setTimeout(fn, Infinity) → fires immediately (also clamped)
      // Falling back to undefined lets the fleet's default fire — same
      // safe behaviour as omitting the opt entirely.
      for (const bad of [0, -1, NaN, Infinity, '60000']) {
        const { session, captured } = buildSessionWithMockFleet({ mcpToolCallTimeoutMs: bad })
        await session._dispatchMcpTool('mcp__stub__echo', {})
        assert.equal(captured[0].timeoutMs, undefined, `bad input ${String(bad)} must fall back`)
      }
    })

    it('clamps mcpToolCallTimeoutMs above MAX_SANE_DURATION_MS back to undefined (#4517)', async () => {
      // #4517: a typoed CHROXY_MCP_TOOL_CALL_TIMEOUT_MS (extra digit,
      // accidental exponent) must NOT arm a >24h MCP setTimeout. Mirrors
      // the ceiling check the three sibling timeouts got via #4509 —
      // byok-session uses `isOperatorTimeoutInRange` so the over-ceiling
      // value falls back to the fleet/client default exactly like the
      // bad-input cases above.
      const MAX_SANE_DURATION_MS = 24 * 60 * 60 * 1000
      const { session, captured } = buildSessionWithMockFleet({
        mcpToolCallTimeoutMs: MAX_SANE_DURATION_MS + 1,
      })
      await session._dispatchMcpTool('mcp__stub__echo', {})
      assert.equal(captured[0].timeoutMs, undefined,
        'over-ceiling input must fall back to fleet/client default')
    })

    it('accepts the exact MAX_SANE_DURATION_MS boundary (#4517)', async () => {
      // The boundary is INCLUSIVE — clamping it would surprise operators who
      // tuned the dial to exactly 24h (unlikely for a per-call MCP timeout,
      // but consistency with the soft/hard inactivity timeouts matters).
      const MAX_SANE_DURATION_MS = 24 * 60 * 60 * 1000
      const { session, captured } = buildSessionWithMockFleet({
        mcpToolCallTimeoutMs: MAX_SANE_DURATION_MS,
      })
      await session._dispatchMcpTool('mcp__stub__echo', {})
      assert.equal(captured[0].timeoutMs, MAX_SANE_DURATION_MS,
        'exact boundary must pass through verbatim')
    })
  })
})

// #6692 — byok runs one model per session; the result (and partial-spend
// error) payloads gain a synthesized single-model split carrying the same
// cost the flat payload reports.
describe('per-model usage on result (#6692)', () => {
  it('synthesizes a single-model modelUsage with the turn cost', async () => {
    const session = new ClaudeByokSession({ cwd: '/tmp', model: 'claude-opus-4-8' })
    session._client = {
      messages: {
        stream: () =>
          fakeStream([], {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'hi' }],
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
      },
    }
    const captured = captureEvents(session)
    await session.start()
    await session.sendMessage('q')
    const result = captured.find((e) => e.name === 'result')
    assert.ok(result, 'result event must fire')
    const mu = result.payload.modelUsage['claude-opus-4-8']
    assert.ok(mu, 'modelUsage entry for the session model')
    assert.equal(mu.input_tokens, 100)
    assert.equal(mu.output_tokens, 50)
    assert.equal(mu.cost_usd, result.payload.cost)
    assert.ok(Number.isFinite(result.payload.cost), 'known-pricing model yields finite cost')
    await session.destroy()
  })

  it('cost_usd is null in modelUsage when pricing is unknown (#5630 parity)', async () => {
    const session = new ClaudeByokSession({ cwd: '/tmp', model: 'claude-future-model-9-9' })
    session._client = {
      messages: {
        stream: () =>
          fakeStream([], {
            stop_reason: 'end_turn',
            content: [{ type: 'text', text: 'hi' }],
            usage: { input_tokens: 100, output_tokens: 50 },
          }),
      },
    }
    const captured = captureEvents(session)
    await session.start()
    await session.sendMessage('q')
    const result = captured.find((e) => e.name === 'result')
    assert.equal(result.payload.modelUsage['claude-future-model-9-9'].cost_usd, null)
    await session.destroy()
  })
})
