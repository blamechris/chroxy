import { describe, it, mock } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, existsSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { EventEmitter } from 'node:events'
import { CodexAppServerSession } from '../src/codex-app-server-session.js'
import { CodexAppServerClient } from '../src/codex-app-server-client.js'
import { CodexSession, CODEX_DEFAULT_SANDBOX } from '../src/codex-session.js'
import {
  applyCodexCatalog,
  parseModelListResult,
  stampContextWindows,
  _resetCodexCatalogForTests,
} from '../src/codex-model-catalog.js'
// #7729 — importing providers.js REGISTERS the codex models registry. Without
// it `getRegistryForProvider('codex')` falls through to the default Claude
// registry and the context-window assertions below would be testing the wrong
// registry (and passing for the wrong reason).
import '../src/providers.js'
import { getRegistryForProvider, DEFAULT_CONTEXT_WINDOW } from '../src/models.js'
import { setupForwarding } from '../src/ws-forwarding.js'
import { EventNormalizer } from '../src/event-normalizer.js'

// #7766 — a trimmed `model/list` answer, enough to put the catalog module in
// its POPULATED state. Not one id is in the hand-maintained seed, so an
// allowlist that came from anywhere but the catalog is visibly wrong.
const DELEGATION_MODEL_LIST = Object.freeze({
  data: [{ id: 'gpt-6-astra', model: 'gpt-6-astra', displayName: 'GPT-6-Astra', isDefault: true }],
  nextCursor: null,
})

{
  // Control for the comment above (#7766), mirroring the sibling in
  // codex-model-validation.test.js. Without it, adding `gpt-6-astra` to the
  // hand-maintained seed would make "came from the catalog" and "came from the
  // seed" indistinguishable here while the comment still claimed otherwise.
  const seedIds = CodexSession.getFallbackModels().map((m) => m.id)
  assert.ok(seedIds.length > 0, 'the seed must be non-empty, or the disjointness control asserts nothing')
  const fixtureIds = DELEGATION_MODEL_LIST.data.map((m) => m.id)
  assert.deepEqual(seedIds.filter((id) => fixtureIds.includes(id)), [],
    'the fixture must share no id with the seed, or "came from the catalog" is untestable')
}

// #6605 Phase 1 — the codex app-server DRIVING layer. These pin the JSON-RPC
// transport routing and the app-server-notification → Chroxy-event mapping
// WITHOUT spawning a real `codex app-server` (the live end-to-end round-trip is
// validated separately).

function mkSession(extraOpts = {}) {
  const sk = mkdtempSync(join(tmpdir(), 'chroxy-cas-'))
  const s = new CodexAppServerSession({ cwd: '/tmp', skillsDir: sk, repoSkillsDir: null, ...extraOpts })
  return { s, cleanup: () => rmSync(sk, { recursive: true, force: true }) }
}
function capture(s, events) {
  const out = []
  events.forEach((e) => s.on(e, (p) => out.push([e, p])))
  return out
}

describe('CodexAppServerClient (JSON-RPC transport)', () => {
  it('resolves a pending request when its response arrives', async () => {
    const c = new CodexAppServerClient({})
    c._child = { stdin: { write: () => {} } } // stub the writer, no real child
    const p = c.request('initialize', {})
    c._dispatch({ jsonrpc: '2.0', id: 1, result: { ok: true } })
    assert.deepEqual(await p, { ok: true })
  })

  it('rejects a pending request on an error response', async () => {
    const c = new CodexAppServerClient({})
    c._child = { stdin: { write: () => {} } }
    const p = c.request('x', {})
    c._dispatch({ jsonrpc: '2.0', id: 1, error: { message: 'boom' } })
    await assert.rejects(p, /boom/)
  })

  it('emits serverRequest for a server→client request (approval)', () => {
    const c = new CodexAppServerClient({})
    let got = null
    c.on('serverRequest', (r) => (got = r))
    c._dispatch({ jsonrpc: '2.0', id: 7, method: 'item/commandExecution/requestApproval', params: { reason: 'x' } })
    assert.equal(got.id, 7)
    assert.match(got.method, /requestApproval/)
  })

  it('emits notification for a server notification (no id)', () => {
    const c = new CodexAppServerClient({})
    let got = null
    c.on('notification', (n) => (got = n))
    c._dispatch({ jsonrpc: '2.0', method: 'turn/started', params: { turn: { id: 't' } } })
    assert.equal(got.method, 'turn/started')
  })

  it('buffers newline-delimited JSON split across stdout chunks', () => {
    const c = new CodexAppServerClient({})
    const notes = []
    c.on('notification', (n) => notes.push(n.method))
    c._onData('{"jsonrpc":"2.0","method":"a"}\n{"jsonrpc":"2.0","meth')
    c._onData('od":"b"}\n')
    assert.deepEqual(notes, ['a', 'b'])
  })

  it('parses CRLF-framed lines (a trailing \\r does not break JSON.parse) (#6606)', () => {
    const c = new CodexAppServerClient({})
    const notes = []
    c.on('notification', (n) => notes.push(n.method))
    c._onData('{"jsonrpc":"2.0","method":"crlf"}\r\n')
    assert.deepEqual(notes, ['crlf'])
  })

  it('rejects all in-flight requests on kill()', async () => {
    const c = new CodexAppServerClient({})
    c._child = { stdin: { write: () => {} } }
    const p = c.request('x', {})
    c.kill()
    await assert.rejects(p, /killed/)
  })
})

describe('CodexAppServerSession — app-server → Chroxy event mapping', () => {
  it('maps agentMessage deltas to a single stream_start + stream_delta stream', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['stream_start', 'stream_delta'])
    s._activeTurn = { messageId: 'm1', turnId: null, didStreamStart: false }
    s._onNotification({ method: 'item/agentMessage/delta', params: { delta: 'Hi' } })
    s._onNotification({ method: 'item/agentMessage/delta', params: { delta: '!' } })
    assert.deepEqual(ev.map(([e]) => e), ['stream_start', 'stream_delta', 'stream_delta'])
    assert.equal(ev[1][1].delta, 'Hi')
    assert.equal(ev[1][1].messageId, 'm1')
    cleanup()
  })

  it('maps a commandExecution item to tool_start / tool_result', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['tool_start', 'tool_result'])
    s._activeTurn = { messageId: 'm1', turnId: null, didStreamStart: false }
    s._onNotification({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'c1', command: 'echo hi', cwd: '/tmp' } } })
    s._onNotification({ method: 'item/completed', params: { item: { type: 'commandExecution', id: 'c1', aggregatedOutput: 'hi\n' } } })
    assert.equal(ev[0][0], 'tool_start')
    assert.equal(ev[0][1].tool, 'shell')
    assert.equal(ev[0][1].input.command, 'echo hi')
    assert.equal(ev[1][0], 'tool_result')
    assert.equal(ev[1][1].result, 'hi\n')
    assert.equal(ev[1][1].toolUseId, 'c1')
    cleanup()
  })

  // #6684 part 4 — connector tool EXECUTIONS (mcpToolCall items) surface in the
  // transcript as tool_start/tool_result, like commandExecution/fileChange.
  it('maps an mcpToolCall item to tool_start / tool_result (server/tool label + content)', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['tool_start', 'tool_result'])
    s._activeTurn = { messageId: 'm1', turnId: null, didStreamStart: false }
    s._onNotification({
      method: 'item/started',
      params: { item: { type: 'mcpToolCall', id: 't1', server: 'github', tool: 'create_issue', arguments: { title: 'x' } } },
    })
    s._onNotification({
      method: 'item/completed',
      params: {
        item: {
          type: 'mcpToolCall',
          id: 't1',
          status: 'completed',
          result: { content: [{ type: 'text', text: 'issue #42 created' }] },
        },
      },
    })
    assert.equal(ev[0][0], 'tool_start')
    assert.equal(ev[0][1].tool, 'github/create_issue')
    assert.equal(ev[0][1].toolUseId, 't1')
    assert.equal(ev[0][1].input.server, 'github')
    assert.equal(ev[0][1].input.tool, 'create_issue')
    assert.deepEqual(ev[0][1].input.arguments, { title: 'x' })
    assert.equal(ev[1][0], 'tool_result')
    assert.equal(ev[1][1].toolUseId, 't1')
    assert.equal(ev[1][1].result, 'issue #42 created')
    assert.equal(ev[1][1].truncated, false)
    cleanup()
  })

  it('a failed mcpToolCall surfaces the error message as the result text AND flags isError (#6712)', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['tool_result'])
    s._activeTurn = { messageId: 'm1', turnId: null, didStreamStart: false }
    s._onNotification({ method: 'item/started', params: { item: { type: 'mcpToolCall', id: 't2', server: 'db', tool: 'query' } } })
    s._onNotification({
      method: 'item/completed',
      params: { item: { type: 'mcpToolCall', id: 't2', status: 'failed', error: { message: 'connection refused' } } },
    })
    // #6712: isError now round-trips the wire so clients can style the failure.
    assert.equal(ev[0][1].result, 'connection refused')
    assert.equal(ev[0][1].isError, true)
    cleanup()
  })

  it('a successful mcpToolCall flags isError false', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['tool_result'])
    s._activeTurn = { messageId: 'm1', turnId: null, didStreamStart: false }
    s._onNotification({ method: 'item/started', params: { item: { type: 'mcpToolCall', id: 't3', server: 'db', tool: 'query' } } })
    s._onNotification({
      method: 'item/completed',
      params: { item: { type: 'mcpToolCall', id: 't3', status: 'completed', result: { content: [{ type: 'text', text: 'ok' }] } } },
    })
    assert.equal(ev[0][1].isError, false)
    cleanup()
  })

  it('mcpToolCall label degrades gracefully (tool-only, then generic mcp)', () => {
    const { s, cleanup } = mkSession()
    assert.equal(s._mcpToolLabel({ tool: 'lonely_tool' }), 'lonely_tool')
    assert.equal(s._mcpToolLabel({ server: 'srv' }), 'srv')
    assert.equal(s._mcpToolLabel({}), 'mcp')
    assert.equal(s._mcpToolLabel({ server: ' gh ', tool: ' t ' }), 'gh/t')
    cleanup()
  })

  it('mcpToolCall result joins multiple content parts and marks non-text parts', () => {
    const { s, cleanup } = mkSession()
    const { result, truncated } = s._summarizeMcpResult({
      status: 'completed',
      result: { content: [{ type: 'text', text: 'line one' }, { type: 'image', data: '…' }, { type: 'text', text: 'line two' }] },
    })
    assert.equal(result, 'line one\n[image]\nline two')
    assert.equal(truncated, false)
    cleanup()
  })

  it('mcpToolCall falls back to structuredContent, then status, and caps huge output via the truncated flag', () => {
    const { s, cleanup } = mkSession()
    // structuredContent fallback when there is no content array
    const structured = s._summarizeMcpResult({ status: 'completed', result: { structuredContent: { ok: true } } })
    assert.equal(structured.result, '{"ok":true}')
    assert.equal(structured.truncated, false)
    // status fallback when there is nothing renderable (result {} or null)
    assert.equal(s._summarizeMcpResult({ status: 'completed', result: {} }).result, 'completed')
    assert.equal(s._summarizeMcpResult({ status: 'completed', result: null }).result, 'completed')
    // cap: a >10k text result is sliced to the cap and flagged truncated (no
    // in-band marker — the wire `truncated` field carries the signal, #6684).
    const huge = 'x'.repeat(20_000)
    const capped = s._summarizeMcpResult({ status: 'completed', result: { content: [{ type: 'text', text: huge }] } })
    assert.equal(capped.result.length, 10_000, 'sliced to MAX_MCP_RESULT_CHARS')
    assert.equal(capped.truncated, true, 'truncated flag set')
    cleanup()
  })

  it('an orphan mcpToolCall tool_start is swept with a synthetic tool_result at turn end', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['tool_result'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: true }
    s._onNotification({ method: 'item/started', params: { item: { type: 'mcpToolCall', id: 'orphan-mcp', server: 'x', tool: 'y' } } })
    s._onNotification({ method: 'turn/completed', params: { turn: { durationMs: 1 } } })
    assert.ok(ev.some(([, p]) => p.toolUseId === 'orphan-mcp'), 'orphan mcpToolCall got a synthetic tool_result')
    cleanup()
  })

  it('turn/completed emits stream_end + result and clears busy', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['stream_end', 'result'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: true }
    s._onNotification({ method: 'turn/completed', params: { turn: { durationMs: 42 } } })
    assert.deepEqual(ev.map(([e]) => e), ['stream_end', 'result'])
    assert.equal(ev[1][1].duration, 42)
    assert.equal(s._isBusy, false, 'busy cleared after turn')
    assert.equal(s._activeTurn, null, 'active turn cleared')
    cleanup()
  })

  it('a short agentMessage with no prior deltas still emits its text (fallback)', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['stream_start', 'stream_delta'])
    s._activeTurn = { messageId: 'm1', turnId: null, didStreamStart: false }
    s._onNotification({ method: 'item/completed', params: { item: { type: 'agentMessage', text: 'short' } } })
    assert.deepEqual(ev.map(([e, p]) => [e, p.delta]), [['stream_start', undefined], ['stream_delta', 'short']])
    cleanup()
  })

  it('ignores the userMessage echo item (no spurious events)', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['stream_start', 'stream_delta', 'tool_start', 'tool_result'])
    s._activeTurn = { messageId: 'm1', turnId: null, didStreamStart: false }
    s._onNotification({ method: 'item/started', params: { item: { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'hi' }] } } })
    s._onNotification({ method: 'item/completed', params: { item: { type: 'userMessage', id: 'u1' } } })
    assert.equal(ev.length, 0, 'the input echo produces no Chroxy events')
    cleanup()
  })
})

describe('CodexAppServerSession — lifecycle guards', () => {
  it('sendMessage while busy enqueues instead of starting a turn', async () => {
    const { s, cleanup } = mkSession()
    let queued = null
    s.on('message_queued', (p) => (queued = p))
    s._isBusy = true
    await s.sendMessage('hello')
    assert.ok(queued, 'busy send was queued')
    cleanup()
  })

  it('sendMessage before start() emits a not-started error', async () => {
    const { s, cleanup } = mkSession()
    let err = null
    s.on('error', (e) => (err = e))
    await s.sendMessage('hello')
    assert.match(err.message, /not started/)
    cleanup()
  })

  it('prepends the skills prefix on the FIRST turn only, and the current model (#6606)', async () => {
    const { s, cleanup } = mkSession()
    s._processReady = true
    s._threadId = 't'
    s.model = 'gpt-5-codex'
    const captured = []
    s._client = { request: async (_m, p) => { captured.push(p); return { turn: { id: 'tt' } } } }
    s._buildCombinedSkillsPrefix = () => 'SKILLZ'
    await s.sendMessage('hello')
    s._isBusy = false // simulate turn completion so the next send isn't queued
    s._activeTurn = null
    await s.sendMessage('again')
    assert.match(captured[0].input[0].text, /SKILLZ[\s\S]*hello/, 'first turn carries the skills prefix')
    assert.equal(captured[0].model, 'gpt-5-codex', 'turn/start carries the current model')
    assert.equal(captured[1].input[0].text, 'again', 'second turn has no skills prefix')
    cleanup()
  })

  it('capabilities: streaming + modelSwitch on, approvals surfaced (Phase 2)', () => {
    const c = CodexAppServerSession.capabilities
    assert.equal(c.permissions, true)
    assert.equal(c.inProcessPermissions, true)
    assert.equal(c.streaming, true)
    assert.equal(c.modelSwitch, true)
  })

  it('delegates codex provider identity to CodexSession statics', () => {
    assert.equal(CodexAppServerSession.providerName, 'codex')
    assert.equal(CodexAppServerSession.apiKeyEnv, 'OPENAI_API_KEY')
    assert.ok(CodexAppServerSession.resolvedBinary, 'resolvedBinary delegates')
    // #7727 — getAllowedModels is TRI-STATE (catalog ids, else null =
    // unrestricted), so `Array.isArray` is no longer the invariant; the
    // DELEGATION is.
    //
    // #7766 — and the delegation has to be asserted in a state where the two
    // sides are DISTINGUISHABLE. This file applies no catalog, so both answers
    // were `null` and `deepEqual(null, null)` stayed green even with the
    // delegation replaced by `return null` — strictly WEAKER than the
    // `Array.isArray` check it replaced, under a comment claiming it caught
    // that failure "in BOTH catalog states" (docs/false-safety-guards.md: a
    // check satisfied for the wrong reason). Both states are now actually
    // driven, populated first.
    try {
      const applied = applyCodexCatalog(
        stampContextWindows(parseModelListResult(DELEGATION_MODEL_LIST), new Map()))
      assert.equal(applied, true, 'the fixture must land, or the populated case proves nothing')
      const ids = CodexSession.getAllowedModels()
      assert.ok(Array.isArray(ids) && ids.length > 0,
        'control: with a catalog in hand the answer must be a non-empty array, not null')
      assert.deepEqual(CodexAppServerSession.getAllowedModels(), ids)
    } finally {
      _resetCodexCatalogForTests()
    }
    // ...and the unrestricted state, where both sides are null by contract.
    assert.equal(CodexSession.getAllowedModels(), null, 'control: the catalog reset must have taken')
    assert.deepEqual(CodexAppServerSession.getAllowedModels(), CodexSession.getAllowedModels())
  })
})

describe('CodexAppServerSession — crash / stop paths (#6607)', () => {
  it('a NORMAL completion disarms intentional-stop so a LATER failure reports as error (#6606 C1)', () => {
    const { s, cleanup } = mkSession()
    // interrupt() armed the intentional-stop flag, but the turn then finished cleanly.
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: false }
    s.markIntentionalStop()
    s._onNotification({ method: 'turn/completed', params: { turn: {} } })
    // A subsequent GENUINE failure must surface as `error`, not a stale `stopped`.
    const ev = capture(s, ['error', 'stopped'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm2', turnId: 't2', didStreamStart: false }
    s._failTurn('genuine failure')
    assert.deepEqual(ev.map(([e]) => e), ['error'], 'later failure is error, not a stale stopped')
    cleanup()
  })

  it('client exit during a turn fails the turn and clears busy', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['error'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: false }
    s._onClientExit({ code: 1, signal: null })
    assert.equal(ev[0][0], 'error')
    assert.match(ev[0][1].message, /exited/)
    assert.equal(s._isBusy, false, 'busy cleared after client exit mid-turn')
    assert.equal(s._processReady, false, 'session marked not-ready')
    cleanup()
  })

  it('an error notification during a turn fails the turn', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['error'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: false }
    s._onNotification({ method: 'error', params: { message: 'boom' } })
    assert.equal(ev[0][0], 'error')
    assert.equal(s._isBusy, false, 'busy cleared on error')
    cleanup()
  })

  it('an intentional interrupt that then fails reports stopped (not error)', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['error', 'stopped'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: false }
    s.markIntentionalStop()
    s._failTurn('interrupted')
    assert.deepEqual(ev.map(([e]) => e), ['stopped'], 'intentional stop surfaces as stopped')
    cleanup()
  })

  it('orphan tool_start is swept with a synthetic tool_result at turn end', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['tool_result'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: false }
    // a tool starts but never completes before the turn ends
    s._onNotification({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'orphan', command: 'sleep 999', cwd: '/tmp' } } })
    s._onNotification({ method: 'turn/completed', params: { turn: {} } })
    assert.ok(ev.some(([, p]) => p.toolUseId === 'orphan'), 'orphan tool_start got a synthetic tool_result')
    cleanup()
  })
})

describe('CodexAppServerSession — transient stream reconnect (#6623)', () => {
  // The `error` notification codex emits WHILE its OWN retry loop re-establishes a
  // dropped response stream — commonly right after a permission / escalation
  // round-trip stalls a shell turn. params.error.message is `Reconnecting... N/5`
  // and codexErrorInfo carries responseStreamDisconnected (the exact shape from the
  // #6623 report). This is a retry-in-progress, NOT a terminal failure.
  const reconnectParams = (attempt = 2, max = 5) => ({
    error: {
      message: `Reconnecting... ${attempt}/${max}`,
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      additionalDetails: 'stream disconnected before completion: failed to send websocket frame',
    },
  })

  it('a Reconnecting responseStreamDisconnected error keeps the turn open (does NOT fail it)', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['error', 'stopped', 'stream_end', 'result'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: true }
    s._onNotification({ method: 'error', params: reconnectParams(2, 5) })
    // OLD behavior: case 'error' → _failTurn → emits 'error' + clears the turn.
    // NEW: a reconnect-in-progress is suppressed and the in-flight turn is preserved.
    assert.deepEqual(ev.map(([e]) => e), [], 'no error/stopped/stream_end/result for a reconnect-in-progress')
    assert.equal(s._isBusy, true, 'session stays busy while codex reconnects')
    assert.ok(s._activeTurn, 'the in-flight turn is preserved across the reconnect')
    s._clearResultTimeout() // release the re-armed backstop timer
    s._clearReconnectWatchdog() // #6629 — release the reconnect watchdog armed alongside it
    cleanup()
  })

  it('recovers cleanly: after reconnect notifications the turn still completes normally', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['error', 'stream_end', 'result'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: true }
    s._onNotification({ method: 'error', params: reconnectParams(1, 5) })
    s._onNotification({ method: 'error', params: reconnectParams(2, 5) })
    // codex re-establishes the stream and finishes the turn
    s._onNotification({ method: 'turn/completed', params: { turn: { durationMs: 5 } } })
    assert.deepEqual(ev.map(([e]) => e), ['stream_end', 'result'], 'turn completed cleanly, no error surfaced')
    assert.equal(s._isBusy, false, 'busy cleared after recovery')
    assert.equal(s._activeTurn, null, 'turn cleared after recovery')
    cleanup()
  })

  it('a terminal responseStreamDisconnected (no Reconnecting message) still fails the turn', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['error'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: false }
    // codex gave up: the disconnect surfaces WITHOUT a retry message → terminal.
    s._onNotification({
      method: 'error',
      params: { error: { message: 'stream disconnected before completion', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } } },
    })
    assert.equal(ev[0]?.[0], 'error', 'a terminal disconnect fails the turn')
    assert.equal(s._isBusy, false, 'busy cleared on a terminal failure')
    assert.equal(s._activeTurn, null, 'turn cleared on a terminal failure')
    cleanup()
  })

  it('a Reconnecting message WITHOUT responseStreamDisconnected still fails (conservative gate)', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['error'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: false }
    // Only a responseStreamDisconnected reconnect is suppressed; a bare reconnect
    // string with no disconnect info is not something we trust as recoverable.
    s._onNotification({ method: 'error', params: { error: { message: 'Reconnecting... 1/5' } } })
    assert.equal(ev[0]?.[0], 'error', 'no codexErrorInfo → not suppressed')
    cleanup()
  })

  it('_isTransientReconnect / _errorPayload tolerate both wrapped and bare shapes', () => {
    const { s, cleanup } = mkSession()
    // wrapped { error: {...} } (the shape in the wild)
    assert.equal(s._isTransientReconnect(s._errorPayload(reconnectParams(3, 5))), true)
    // bare { message, codexErrorInfo } (no wrapper)
    assert.equal(
      s._isTransientReconnect(s._errorPayload({ message: 'Reconnecting... 3/5', codexErrorInfo: { responseStreamDisconnected: {} } })),
      true,
    )
    // terminal disconnect (no reconnect text) and plain errors are NOT transient
    assert.equal(s._isTransientReconnect(s._errorPayload({ message: 'boom', codexErrorInfo: { responseStreamDisconnected: {} } })), false)
    assert.equal(s._isTransientReconnect(s._errorPayload({ message: 'boom' })), false)
    assert.equal(s._isTransientReconnect(s._errorPayload(undefined)), false)
    cleanup()
  })
})

describe('CodexAppServerSession — reconnect watchdog / stale-state reconciliation (#6629)', () => {
  // #6623 keeps the turn OPEN on a transient reconnect so codex can recover; the
  // ONLY pre-existing backstop was the 30-min result timeout — and a pending
  // permission PAUSES that timer. #6629: a codex whose response stream wedges
  // mid-reconnect (never recovers, never emits its terminal give-up) left the
  // session stuck "Working..." (and any orphan in-flight tool_start unresolved)
  // for up to 30 min, or indefinitely if a permission had paused the timer. The
  // watchdog reconciles that stale state on a bounded window, independent of the
  // permission pause, surfacing error{code:'stream_stall'} (the existing retry chip).
  const RECONNECT_WATCHDOG_MS = 2 * 60 * 1000
  const reconnectParams = (attempt = 2, max = 5) => ({
    error: {
      message: `Reconnecting... ${attempt}/${max}`,
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      additionalDetails: 'stream disconnected before completion: failed to send websocket frame',
    },
  })

  // A turn mid-shell-task: an in-flight commandExecution tool_start with no
  // matching tool_result yet (the exact stale in-flight tool the issue describes).
  function armBusyTurnWithInflightShell(s) {
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: true }
    s._onNotification({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'shell-1', command: 'npm run desktop:build', cwd: '/tmp' } } })
  }

  it('fires after a non-recovering reconnect: clears busy + sweeps the orphan tool_start with error{code:stream_stall}', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const { s, cleanup } = mkSession()
    try {
      const ev = capture(s, ['error', 'stopped', 'tool_result', 'stream_end'])
      armBusyTurnWithInflightShell(s)
      // Stream drops → codex is reconnecting → #6623 keeps the turn open + arms the watchdog.
      s._onNotification({ method: 'error', params: reconnectParams(2, 5) })
      assert.ok(s._reconnectWatchdog, 'watchdog armed on a transient reconnect')
      assert.equal(s._isBusy, true, 'still busy while codex reconnects')

      // codex never recovers and never emits its terminal give-up.
      mock.timers.tick(RECONNECT_WATCHDOG_MS - 1)
      assert.equal(ev.length, 0, 'watchdog must not fire 1ms before the window')
      mock.timers.tick(1)

      const err = ev.find(([e]) => e === 'error')
      assert.ok(err, 'watchdog fails the turn with an error')
      assert.equal(err[1].code, 'stream_stall', 'error carries stream_stall so the client shows a retry chip')
      assert.ok(ev.some(([e, p]) => e === 'tool_result' && p.toolUseId === 'shell-1'), 'the orphan in-flight shell tool_start is swept with a synthetic tool_result')
      assert.equal(s._isBusy, false, 'stale working state cleared')
      assert.equal(s._activeTurn, null, 'turn cleared')
      assert.equal(s._reconnectWatchdog, null, 'watchdog handle cleared after firing')
    } finally {
      s.destroy()
      mock.timers.reset()
      cleanup()
    }
  })

  it('recovery disarms the watchdog: a forward-progress notification prevents a premature fail', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const { s, cleanup } = mkSession()
    try {
      const ev = capture(s, ['error', 'stream_end', 'result'])
      s._isBusy = true
      s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: true }
      s._onNotification({ method: 'error', params: reconnectParams(1, 5) })
      assert.ok(s._reconnectWatchdog, 'watchdog armed')
      // codex re-establishes the stream and streams a delta → recovery.
      s._onNotification({ method: 'item/agentMessage/delta', params: { delta: 'back online' } })
      assert.equal(s._reconnectWatchdog, null, 'watchdog disarmed on genuine forward progress')

      // Ticking past the window must NOT fail the turn.
      mock.timers.tick(RECONNECT_WATCHDOG_MS * 2)
      assert.ok(!ev.some(([e, p]) => e === 'error' && p?.code === 'stream_stall'), 'no stall error after recovery')

      // …and the turn still completes normally.
      s._onNotification({ method: 'turn/completed', params: { turn: { durationMs: 5 } } })
      assert.equal(s._isBusy, false, 'busy cleared on clean completion')
      assert.equal(s._activeTurn, null, 'turn cleared on clean completion')
    } finally {
      s.destroy()
      mock.timers.reset()
      cleanup()
    }
  })

  it('is the sole backstop when a pending permission cleared the result timeout with no re-arm (the #6629 gap)', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const { s, cleanup } = mkSession()
    try {
      const ev = capture(s, ['error', 'tool_result'])
      armBusyTurnWithInflightShell(s)
      // Stream drops mid-shell → the reconnect arms the watchdog AND, via
      // _resetResultTimeout at the top of _onNotification, re-arms the result timeout.
      s._onNotification({ method: 'error', params: reconnectParams(2, 5) })
      assert.ok(s._reconnectWatchdog, 'watchdog armed on the reconnect')
      assert.ok(s._resultTimeout, 'the reconnect notification re-armed the result timeout')

      // THEN codex's shell-escalation approval lands. That is a server→client
      // REQUEST, not a notification, so it does NOT re-arm the result timeout — it
      // CLEARS it (_pauseResultTimeoutForPermission → _clearResultTimeout). With the
      // stream now wedged (no further notifications), nothing re-arms it: there is
      // NO active result timeout left. Without the watchdog this hangs forever.
      s._pauseResultTimeoutForPermission()
      assert.equal(s._resultTimeout, null, 'result timeout cleared by the pending permission and NOT re-armed (no further notifications)')
      assert.ok(s._reconnectWatchdog, 'watchdog survives the pause — it is independent of the result timeout')

      // The watchdog alone reconciles the stale state.
      mock.timers.tick(RECONNECT_WATCHDOG_MS)
      const err = ev.find(([e]) => e === 'error')
      assert.ok(err && err[1].code === 'stream_stall', 'the watchdog alone reconciles the stale state as the sole backstop')
      assert.equal(s._isBusy, false, 'no longer stuck Working with a pending permission')
      assert.ok(ev.some(([e, p]) => e === 'tool_result' && p.toolUseId === 'shell-1'), 'orphan shell tool_start swept')
    } finally {
      s.destroy()
      mock.timers.reset()
      cleanup()
    }
  })

  it('a reconnect burst re-arms the watchdog so legit N/5 retries do not trip it early', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const { s, cleanup } = mkSession()
    try {
      const ev = capture(s, ['error'])
      s._isBusy = true
      s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: true }

      s._onNotification({ method: 'error', params: reconnectParams(1, 5) })
      mock.timers.tick(RECONNECT_WATCHDOG_MS - 1_000) // almost expired…
      s._onNotification({ method: 'error', params: reconnectParams(2, 5) }) // …then a new retry re-arms it
      mock.timers.tick(RECONNECT_WATCHDOG_MS - 1_000)
      assert.equal(ev.length, 0, 'no fire: each retry within the window re-armed the watchdog')

      // Silence past a full window after the LAST retry → fires.
      mock.timers.tick(1_000)
      assert.ok(ev.some(([e, p]) => e === 'error' && p?.code === 'stream_stall'), 'fires a full window after the last reconnect tick')
      assert.equal(s._isBusy, false, 'busy cleared')
    } finally {
      s.destroy()
      mock.timers.reset()
      cleanup()
    }
  })

  it('a terminal give-up clears the watchdog on its way to _failTurn (no double fail)', () => {
    mock.timers.enable({ apis: ['setTimeout', 'Date'] })
    const { s, cleanup } = mkSession()
    try {
      const ev = capture(s, ['error'])
      s._isBusy = true
      s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: false }
      s._onNotification({ method: 'error', params: reconnectParams(2, 5) }) // arms watchdog
      assert.ok(s._reconnectWatchdog, 'watchdog armed')
      // codex gives up: a disconnect WITHOUT a Reconnecting message → terminal.
      s._onNotification({ method: 'error', params: { error: { message: 'stream disconnected before completion', codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } } } } })
      assert.equal(ev.length, 1, 'exactly one failure surfaced')
      assert.equal(s._reconnectWatchdog, null, 'watchdog cleared by the terminal failure')
      // Ticking must not produce a second (stale) failure.
      mock.timers.tick(RECONNECT_WATCHDOG_MS * 2)
      assert.equal(ev.length, 1, 'no second fail from a stale watchdog after teardown')
    } finally {
      s.destroy()
      mock.timers.reset()
      cleanup()
    }
  })
})

describe('CodexAppServerSession — reconnect suppression deadline (#6856)', () => {
  // #6854 keeps a codex turn OPEN on a transient `responseStreamDisconnected` +
  // `Reconnecting... N/M` error so codex can recover. The #6629 SILENCE watchdog
  // is re-armed on every tick, so a codex that emits reconnect notifications
  // FOREVER (never recovering, never silent) keeps pushing BOTH the 30-min result
  // timeout and the silence watchdog out — the turn stays "Working..." far too
  // long. This deadline is armed ONCE on entering suppression, is NOT re-armed on
  // later ticks, and fails the turn on a fixed bound. It routes through an
  // injectable timer seam so it is exercised with zero wall-clock (and without
  // mock.timers, so the #6629 watchdog's real unref'd global timer never fires
  // inside these synchronous tests).
  const reconnectParams = (attempt = 2, max = 5) => ({
    error: {
      message: `Reconnecting... ${attempt}/${max}`,
      codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: null } },
      additionalDetails: 'stream disconnected before completion: failed to send websocket frame',
    },
  })

  // Minimal deterministic double for the deadline timer: records each scheduled
  // timer and lets a test fire the pending one by hand.
  function fakeReconnectTimers() {
    const scheduled = []
    const setTimer = (fn, ms) => {
      const entry = { fn, ms, cleared: false, unref() { return this } }
      scheduled.push(entry)
      return entry
    }
    const clearTimer = (handle) => { if (handle) handle.cleared = true }
    // Fire the still-pending deadline (no-op if none / already cleared).
    const fire = () => {
      const entry = scheduled.find((e) => !e.cleared)
      if (entry) { entry.cleared = true; entry.fn() }
      return entry
    }
    return { scheduled, setTimer, clearTimer, fire }
  }

  function mkDeadlineSession(extraOpts = {}) {
    const timers = fakeReconnectTimers()
    const { s, cleanup } = mkSession({
      setTimer: timers.setTimer,
      clearTimer: timers.clearTimer,
      // #6967: 3 min — a NON-default value (so these still prove the opt is what
      // arms the timer) that sits inside the supported window (above the 2-min
      // silence watchdog, below the 30-min result timeout). The previous 60_000
      // is now clamped away to the default and would silently stop testing the
      // override.
      reconnectDeadlineMs: 180_000,
      ...extraOpts,
    })
    return { s, cleanup, timers }
  }

  // A busy turn with an in-flight commandExecution tool_start (no matching result
  // yet) — the stale in-flight tool the deadline must sweep when it fires.
  function armBusyTurnWithInflightShell(s) {
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: true }
    s._onNotification({ method: 'item/started', params: { item: { type: 'commandExecution', id: 'shell-1', command: 'npm run build', cwd: '/tmp' } } })
  }

  it('arms the deadline on entering the reconnect-suppressed state', () => {
    const { s, cleanup, timers } = mkDeadlineSession()
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: true }
    s._onNotification({ method: 'error', params: reconnectParams(2, 5) })
    assert.ok(s._reconnectDeadline, 'deadline armed on the first transient reconnect')
    assert.equal(timers.scheduled.length, 1, 'exactly one deadline timer scheduled')
    assert.equal(timers.scheduled[0].ms, 180_000, 'armed with the configured deadline ms')
    assert.equal(timers.scheduled[0].cleared, false, 'the deadline is pending')
    s.destroy()
    cleanup()
  })

  it('a flurry of reconnect notifications does NOT push the deadline out (the #6854 gap)', () => {
    const { s, cleanup, timers } = mkDeadlineSession()
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: true }
    // The exact bug: many reconnect ticks, none of which may re-arm the deadline.
    s._onNotification({ method: 'error', params: reconnectParams(1, 5) })
    const armed = s._reconnectDeadline
    s._onNotification({ method: 'error', params: reconnectParams(2, 5) })
    s._onNotification({ method: 'error', params: reconnectParams(3, 5) })
    s._onNotification({ method: 'error', params: reconnectParams(4, 5) })
    assert.equal(timers.scheduled.length, 1, 'the deadline was armed exactly once across the whole flurry')
    assert.equal(timers.scheduled[0].cleared, false, 'the single deadline was never cleared/re-armed')
    assert.equal(s._reconnectDeadline, armed, 'still the SAME deadline handle — not extended by later ticks')
    s.destroy()
    cleanup()
  })

  it('genuine recovery before the deadline clears it (no fail)', () => {
    const { s, cleanup, timers } = mkDeadlineSession()
    const ev = capture(s, ['error', 'stream_end', 'result'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: true }
    s._onNotification({ method: 'error', params: reconnectParams(1, 5) })
    assert.ok(s._reconnectDeadline, 'deadline armed')
    // codex re-establishes the stream and streams a delta → genuine forward progress.
    s._onNotification({ method: 'item/agentMessage/delta', params: { delta: 'back online' } })
    assert.equal(s._reconnectDeadline, null, 'deadline cleared on forward progress')
    assert.equal(timers.scheduled[0].cleared, true, 'the scheduled deadline timer was cleared')
    // Firing whatever the fake still holds must be a no-op — nothing pending.
    timers.fire()
    assert.ok(!ev.some(([e]) => e === 'error'), 'no stall error after recovery')
    // …and the turn still completes cleanly.
    s._onNotification({ method: 'turn/completed', params: { turn: { durationMs: 5 } } })
    assert.equal(s._isBusy, false, 'busy cleared on clean completion')
    assert.equal(s._activeTurn, null, 'turn cleared on clean completion')
    s.destroy()
    cleanup()
  })

  it('the deadline firing while still suppressed fails the turn with the reconnect error + sweeps the orphan tool_start', () => {
    const { s, cleanup, timers } = mkDeadlineSession()
    const ev = capture(s, ['error', 'stopped', 'tool_result', 'stream_end'])
    armBusyTurnWithInflightShell(s)
    s._onNotification({ method: 'error', params: reconnectParams(2, 5) })
    assert.ok(s._reconnectDeadline, 'deadline armed while suppressed')
    // codex never recovers, never goes silent, never emits a terminal give-up —
    // the deadline is the backstop.
    timers.fire()
    const err = ev.find(([e]) => e === 'error')
    assert.ok(err, 'the deadline fails the turn')
    assert.match(err[1].message, /reconnect exceeded 180s/i, 'a clear "codex reconnect exceeded Ns" error')
    assert.equal(err[1].code, 'stream_stall', 'carries stream_stall so the client shows its retry chip')
    assert.ok(ev.some(([e, p]) => e === 'tool_result' && p.toolUseId === 'shell-1'), 'the orphan in-flight shell tool_start is swept')
    assert.equal(s._isBusy, false, 'stale working state cleared')
    assert.equal(s._activeTurn, null, 'turn cleared')
    assert.equal(s._reconnectDeadline, null, 'deadline handle cleared after firing')
    s.destroy()
    cleanup()
  })

  it('non-reconnect turns are unaffected (no deadline ever armed)', () => {
    const { s, cleanup, timers } = mkDeadlineSession()
    const ev = capture(s, ['error', 'result'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: true }
    s._onNotification({ method: 'item/agentMessage/delta', params: { delta: 'hello' } })
    s._onNotification({ method: 'turn/completed', params: { turn: { durationMs: 5 } } })
    assert.equal(timers.scheduled.length, 0, 'no reconnect deadline armed for a normal turn')
    assert.equal(s._reconnectDeadline, null, 'deadline never armed')
    assert.ok(!ev.some(([e]) => e === 'error'), 'no error surfaced for a clean turn')
    assert.equal(s._isBusy, false, 'turn completed normally')
    s.destroy()
    cleanup()
  })

  it('the deadline is configurable via the opt (with a sensible default)', () => {
    const custom = mkSession({ reconnectDeadlineMs: 240_000 })
    assert.equal(custom.s._reconnectDeadlineMs, 240_000, 'opt overrides the default')
    custom.s.destroy(); custom.cleanup()

    const def = mkSession()
    assert.equal(def.s._reconnectDeadlineMs, 5 * 60 * 1000, 'default is 5 min')
    def.s.destroy(); def.cleanup()

    // A bogus opt (non-positive / non-finite) falls back to the default.
    const bogus = mkSession({ reconnectDeadlineMs: 0 })
    assert.equal(bogus.s._reconnectDeadlineMs, 5 * 60 * 1000, 'a non-positive opt falls back to the default')
    bogus.s.destroy(); bogus.cleanup()
  })

  it('the deadline is configurable via CHROXY_CODEX_RECONNECT_DEADLINE_MS', () => {
    const prev = process.env.CHROXY_CODEX_RECONNECT_DEADLINE_MS
    process.env.CHROXY_CODEX_RECONNECT_DEADLINE_MS = '180000'
    try {
      const { s, cleanup } = mkSession()
      assert.equal(s._reconnectDeadlineMs, 180_000, 'env var sets the deadline')
      s.destroy(); cleanup()
    } finally {
      if (prev === undefined) delete process.env.CHROXY_CODEX_RECONNECT_DEADLINE_MS
      else process.env.CHROXY_CODEX_RECONNECT_DEADLINE_MS = prev
    }
  })

  // #6967 — the operator override is CLAMPED, not merely finite/positive. The
  // whole #6856 design leans on the deadline sitting ABOVE the 2-min #6629
  // silence watchdog (so the faster silence path still wins its own case) and
  // BELOW the 30-min default result timeout (so it stays a strictly-shorter
  // bound). A bespoke `> 0` check let an operator set 1000ms and fire it almost
  // immediately, defeating both invariants.
  describe('operator override clamping (#6967)', () => {
    const DEFAULT = 5 * 60 * 1000
    const WATCHDOG = 2 * 60 * 1000
    const RESULT_TIMEOUT = 30 * 60 * 1000

    const withEnv = (value, fn) => {
      const prev = process.env.CHROXY_CODEX_RECONNECT_DEADLINE_MS
      if (value === undefined) delete process.env.CHROXY_CODEX_RECONNECT_DEADLINE_MS
      else process.env.CHROXY_CODEX_RECONNECT_DEADLINE_MS = value
      try { fn() } finally {
        if (prev === undefined) delete process.env.CHROXY_CODEX_RECONNECT_DEADLINE_MS
        else process.env.CHROXY_CODEX_RECONNECT_DEADLINE_MS = prev
      }
    }

    it('an opt at or below the 2-min silence watchdog falls back to the default', () => {
      for (const tooSmall of [1000, 60_000, WATCHDOG]) {
        const { s, cleanup } = mkSession({ reconnectDeadlineMs: tooSmall })
        assert.equal(s._reconnectDeadlineMs, DEFAULT, `${tooSmall}ms is not above the watchdog — falls back`)
        s.destroy(); cleanup()
      }
    })

    it('an opt at or above the 30-min result timeout falls back to the default', () => {
      for (const tooBig of [RESULT_TIMEOUT, 60 * 60 * 1000, 25 * 60 * 60 * 1000]) {
        const { s, cleanup } = mkSession({ reconnectDeadlineMs: tooBig })
        assert.equal(s._reconnectDeadlineMs, DEFAULT, `${tooBig}ms is not below the result timeout — falls back`)
        s.destroy(); cleanup()
      }
    })

    it('CHROXY_CODEX_RECONNECT_DEADLINE_MS below the floor falls back to the default', () => {
      withEnv('1000', () => {
        const { s, cleanup } = mkSession()
        assert.equal(s._reconnectDeadlineMs, DEFAULT, 'a near-instant env deadline is rejected')
        s.destroy(); cleanup()
      })
    })

    it('CHROXY_CODEX_RECONNECT_DEADLINE_MS above the ceiling falls back to the default', () => {
      withEnv(String(2 * 60 * 60 * 1000), () => {
        const { s, cleanup } = mkSession()
        assert.equal(s._reconnectDeadlineMs, DEFAULT, 'an env deadline past the result timeout is rejected')
        s.destroy(); cleanup()
      })
    })

    it('an out-of-range opt does NOT shadow an in-range env value', () => {
      // The opt is only preferred when it is itself VALID — an operator's
      // in-range env var must still win over a bogus programmatic opt rather
      // than both collapsing to the default.
      withEnv('180000', () => {
        const { s, cleanup } = mkSession({ reconnectDeadlineMs: 1000 })
        assert.equal(s._reconnectDeadlineMs, 180_000, 'the in-range env value is used')
        s.destroy(); cleanup()
      })
    })

    it('in-range values on both edges of the window are honoured', () => {
      for (const ok of [WATCHDOG + 1, 3 * 60 * 1000, RESULT_TIMEOUT - 1]) {
        const { s, cleanup } = mkSession({ reconnectDeadlineMs: ok })
        assert.equal(s._reconnectDeadlineMs, ok, `${ok}ms sits inside the window and is honoured`)
        s.destroy(); cleanup()
      }
    })
  })
})

describe('CodexAppServerSession — approval surfacing (#6605 Phase 2)', () => {
  const tick = () => new Promise((r) => setImmediate(r))
  function mkApprovalSession(mode = 'approve') {
    const { s, cleanup } = mkSession()
    const responded = []
    s._processReady = true
    s.permissionMode = mode
    s._turnAbort = new AbortController()
    s._client = {
      respond: (id, r) => responded.push([id, r]),
      respondError: (id, code, message) => responded.push([id, { error: { code, message } }]),
    }
    return { s, cleanup, responded }
  }

  it('capabilities advertise permissions + inProcessPermissions + permissionModeSwitch', () => {
    const c = CodexAppServerSession.capabilities
    assert.equal(c.permissions, true)
    assert.equal(c.inProcessPermissions, true)
    assert.equal(c.permissionModeSwitch, true)
  })

  it('exposes the in-process permission responders', () => {
    const { s, cleanup } = mkSession()
    assert.equal(typeof s.respondToPermission, 'function')
    assert.equal(typeof s.respondToQuestion, 'function')
    cleanup()
  })

  it('approvalPolicy: auto → never, every other mode → on-request', () => {
    const { s, cleanup } = mkSession()
    s.permissionMode = 'auto'; assert.equal(s._approvalPolicy(), 'never')
    s.permissionMode = 'approve'; assert.equal(s._approvalPolicy(), 'on-request')
    s.permissionMode = 'acceptEdits'; assert.equal(s._approvalPolicy(), 'on-request')
    cleanup()
  })

  it('stores a per-session codexSandbox opt for start() to apply (#6638)', () => {
    const withOverride = mkSession({ codexSandbox: 'read-only' })
    assert.equal(withOverride.s._codexSandbox, 'read-only', 'the per-session sandbox override is captured')
    withOverride.cleanup()
    const without = mkSession()
    assert.equal(without.s._codexSandbox, null, 'no opt → null (start() falls back to env/default)')
    without.cleanup()
  })

  it('commandExecution approval → permission_request; allow → {decision:accept}', async () => {
    const { s, cleanup, responded } = mkApprovalSession()
    const reqs = capture(s, ['permission_request'])
    s._onServerRequest({ id: 5, method: 'item/commandExecution/requestApproval', params: { command: 'rm x', cwd: '/tmp', reason: 'Delete x?' } })
    assert.equal(reqs.length, 1, 'emitted a permission_request')
    assert.equal(reqs[0][1].tool, 'shell')
    s.respondToPermission(reqs[0][1].requestId, 'allow')
    await tick()
    assert.deepEqual(responded, [[5, { decision: 'accept' }]])
    cleanup()
  })

  it('commandExecution deny → {decision:decline}', async () => {
    const { s, cleanup, responded } = mkApprovalSession()
    const reqs = capture(s, ['permission_request'])
    s._onServerRequest({ id: 6, method: 'item/commandExecution/requestApproval', params: { command: 'rm -rf /', reason: 'nope' } })
    s.respondToPermission(reqs[0][1].requestId, 'deny')
    await tick()
    assert.deepEqual(responded, [[6, { decision: 'decline' }]])
    cleanup()
  })

  it('commandExecution allowAlways → {decision:acceptForSession}', async () => {
    const { s, cleanup, responded } = mkApprovalSession()
    const reqs = capture(s, ['permission_request'])
    s._onServerRequest({ id: 7, method: 'item/commandExecution/requestApproval', params: { command: 'ls', reason: 'list' } })
    s.respondToPermission(reqs[0][1].requestId, 'allowAlways')
    await tick()
    assert.deepEqual(responded, [[7, { decision: 'acceptForSession' }]])
    cleanup()
  })

  it('fileChange approval uses ReviewDecision (allow→approved, deny→denied, session→approved_for_session)', async () => {
    for (const [decision, expected] of [['allow', 'approved'], ['deny', 'denied'], ['allowAlways', 'approved_for_session']]) {
      const { s, cleanup, responded } = mkApprovalSession()
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 9, method: 'item/fileChange/requestApproval', params: { grantRoot: '/repo', reason: 'edit files' } })
      assert.equal(reqs[0][1].tool, 'apply_patch')
      s.respondToPermission(reqs[0][1].requestId, decision)
      await tick()
      assert.deepEqual(responded, [[9, { decision: expected }]], `fileChange ${decision} → ${expected}`)
      cleanup()
    }
  })

  describe('apply_patch diff preview (#6638)', () => {
    const fcItem = () => ({
      type: 'fileChange',
      id: 'fc-1',
      changes: [
        { path: 'src/a.js', kind: 'update', diff: '@@ -1 +1 @@\n-a\n+b' },
        { path: 'src/b.js', kind: 'add', diff: '+new' },
      ],
    })

    it('correlates the fileChange item changes into the approval (paths summary + raw changes)', () => {
      const { s, cleanup } = mkApprovalSession('approve')
      s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: true }
      const reqs = capture(s, ['permission_request'])
      const item = fcItem()
      s._onItemStarted(item) // caches changes keyed by itemId 'fc-1'
      s._onServerRequest({ id: 40, method: 'item/fileChange/requestApproval', params: { itemId: 'fc-1', grantRoot: '/repo', reason: 'edit' } })
      const req = reqs[0][1]
      assert.equal(req.tool, 'apply_patch')
      assert.match(req.description, /2 files: src\/a\.js, src\/b\.js/, 'description names the files being changed')
      assert.deepEqual(req.input.changes, item.changes, 'raw diff passed through for client rendering')
      s.respondToPermission(req.requestId, 'deny')
      cleanup()
    })

    it('gracefully omits the diff when no matching item was seen (no regression)', () => {
      const { s, cleanup } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 41, method: 'item/fileChange/requestApproval', params: { itemId: 'unseen', grantRoot: '/repo', reason: 'edit files' } })
      const req = reqs[0][1]
      assert.equal(req.description, 'edit files', 'falls back to the reason')
      assert.equal(req.input.changes, null)
      s.respondToPermission(req.requestId, 'deny')
      cleanup()
    })

    it('releases the cached diff on item completion', () => {
      const { s, cleanup } = mkApprovalSession('approve')
      s._activeTurn = { messageId: 'm1', didStreamStart: true }
      const reqs = capture(s, ['permission_request'])
      s._onItemStarted(fcItem())
      s._onItemCompleted({ type: 'fileChange', id: 'fc-1', status: 'ok' })
      s._onServerRequest({ id: 42, method: 'item/fileChange/requestApproval', params: { itemId: 'fc-1', grantRoot: '/repo', reason: 'edit' } })
      assert.equal(reqs[0][1].input.changes, null, 'a completed item is no longer cached')
      s.respondToPermission(reqs[0][1].requestId, 'deny')
      cleanup()
    })

    it('_summarizeFileChanges caps the path list with a +N more tail', () => {
      const { s, cleanup } = mkApprovalSession()
      const many = Array.from({ length: 6 }, (_, i) => ({ path: `f${i}.js`, kind: 'update', diff: 'd' }))
      assert.match(s._summarizeFileChanges(many), /6 files: f0\.js, f1\.js, f2\.js, \+3 more/)
      assert.equal(s._summarizeFileChanges([]), null)
      assert.equal(s._summarizeFileChanges(null), null)
      cleanup()
    })

    it('clears the cached diffs when the turn ends (leak prevention)', () => {
      const { s, cleanup } = mkApprovalSession('approve')
      s.on('error', () => {}) // _failTurn emits 'error'; swallow so EventEmitter doesn't throw
      s._activeTurn = { messageId: 'm1', didStreamStart: false }
      s._onItemStarted(fcItem())
      assert.equal(s._pendingFileChanges.size, 1, 'cached during the turn')
      s._failTurn('boom') // a turn-teardown path → _clearMessageState → clears the cache
      assert.equal(s._pendingFileChanges.size, 0, 'released at turn end')
      cleanup()
    })

    it('_summarizeFileChanges tolerates a string patch and path-less entries', () => {
      const { s, cleanup } = mkApprovalSession()
      // #6638: item.changes ?? item.patch — patch can be a unified-diff STRING.
      assert.equal(s._summarizeFileChanges('a-unified-diff-string'), null, 'a string patch → null, no throw')
      assert.match(s._summarizeFileChanges([{ kind: 'update', diff: 'd' }, null]), /file change\(s\)/, 'entries without a path → count only')
      cleanup()
    })
  })

  it('acceptEdits auto-approves a codex file edit (fileChange) without a prompt', async () => {
    const { s, cleanup, responded } = mkApprovalSession('acceptEdits')
    const reqs = capture(s, ['permission_request'])
    s._onServerRequest({ id: 30, method: 'item/fileChange/requestApproval', params: { grantRoot: '/repo', reason: 'edit' } })
    await tick()
    assert.equal(reqs.length, 0, 'acceptEdits does not prompt for a codex edit')
    assert.deepEqual(responded, [[30, { decision: 'approved' }]])
    cleanup()
  })

  it('acceptEdits still PROMPTS for a codex shell command (not an edit)', async () => {
    const { s, cleanup, responded } = mkApprovalSession('acceptEdits')
    const reqs = capture(s, ['permission_request'])
    s._onServerRequest({ id: 31, method: 'item/commandExecution/requestApproval', params: { command: 'rm x' } })
    assert.equal(reqs.length, 1, 'acceptEdits prompts for a shell command')
    assert.equal(responded.length, 0, 'no decision until the user answers')
    s.respondToPermission(reqs[0][1].requestId, 'deny')
    await tick()
    assert.deepEqual(responded, [[31, { decision: 'decline' }]])
    cleanup()
  })

  it('auto mode auto-allows without emitting a prompt (accept)', async () => {
    const { s, cleanup, responded } = mkApprovalSession('auto')
    const reqs = capture(s, ['permission_request'])
    s._onServerRequest({ id: 10, method: 'item/commandExecution/requestApproval', params: { command: 'echo hi' } })
    await tick()
    assert.equal(reqs.length, 0, 'auto mode does not prompt')
    assert.deepEqual(responded, [[10, { decision: 'accept' }]])
    cleanup()
  })

  describe('permissions-escalation surfacing (#6610)', () => {
    // A real PermissionsRequestApprovalParams (codex asks to broaden its sandbox).
    const escalationParams = {
      cwd: '/repo', itemId: 'i1', threadId: 't1', turnId: 'turn1', startedAtMs: 0,
      reason: 'install deps',
      permissions: {
        fileSystem: { entries: [{ access: 'write', path: { type: 'path', path: '/repo/node_modules' } }] },
        network: { enabled: true },
      },
    }

    it('surfaces the escalation as a distinctly-worded prompt describing the requested scope', () => {
      const { s, cleanup } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 11, method: 'item/permissions/requestApproval', params: escalationParams })
      assert.equal(reqs.length, 1, 'escalation is surfaced (no longer safe-denied silently)')
      const req = reqs[0][1]
      assert.match(req.description, /broaden its sandbox permissions/)
      assert.match(req.description, /install deps/)
      assert.match(req.description, /filesystem write/)
      assert.match(req.description, /network access/)
      // structured detail passed through for any client that wants to render it
      assert.deepEqual(req.input.requestedPermissions, escalationParams.permissions)
      s.respondToPermission(req.requestId, 'deny') // resolve so no pending timeout timer leaks past cleanup
      cleanup()
    })

    it('approve → grants EXACTLY the requested permissions for this turn', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 12, method: 'item/permissions/requestApproval', params: escalationParams })
      s.respondToPermission(reqs[0][1].requestId, 'allow')
      await tick()
      assert.deepEqual(responded, [[12, { permissions: escalationParams.permissions, scope: 'turn' }]])
      cleanup()
    })

    it('approve-always → grants the requested permissions for the SESSION', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 13, method: 'item/permissions/requestApproval', params: escalationParams })
      s.respondToPermission(reqs[0][1].requestId, 'allowAlways')
      await tick()
      assert.deepEqual(responded, [[13, { permissions: escalationParams.permissions, scope: 'session' }]])
      cleanup()
    })

    it('deny → grants NOTHING (empty permissions, scope omitted per #6612)', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 14, method: 'item/permissions/requestApproval', params: escalationParams })
      s.respondToPermission(reqs[0][1].requestId, 'deny')
      await tick()
      assert.deepEqual(responded, [[14, { permissions: {} }]])
      cleanup()
    })

    it('the grant response conforms to PermissionsRequestApprovalResponse (schema shape)', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 15, method: 'item/permissions/requestApproval', params: escalationParams })
      s.respondToPermission(reqs[0][1].requestId, 'allow')
      await tick()
      const resp = responded[0][1]
      assert.equal(typeof resp.permissions, 'object', 'permissions is the required GrantedPermissionProfile object')
      assert.ok(['turn', 'session'].includes(resp.scope), 'scope is a valid PermissionGrantScope enum')
      assert.deepEqual(
        Object.keys(resp).filter((k) => !['permissions', 'scope', 'strictAutoReview'].includes(k)),
        [],
        'no fields outside the schema',
      )
      cleanup()
    })

    it('abort mid-escalation → responds { permissions: {} } (answers codex, no turn wedge #6612)', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 16, method: 'item/permissions/requestApproval', params: escalationParams })
      assert.equal(reqs.length, 1, 'escalation prompted')
      s._endTurnAbort() // Stop / turn-end aborts the pending escalation
      await tick()
      assert.deepEqual(responded, [[16, { permissions: {} }]], 'abort grants nothing but still answers codex')
      cleanup()
    })

    it('malformed permissions (an array) is coerced to an empty grant, never echoed (no wedge)', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      // typeof [] === 'object': a naive echo would put an array on the wire where codex
      // expects a {fileSystem?, network?} object → deserialize failure → wedged turn (#6612).
      s._onServerRequest({ id: 17, method: 'item/permissions/requestApproval', params: { ...escalationParams, permissions: [] } })
      s.respondToPermission(reqs[0][1].requestId, 'allow')
      await tick()
      assert.deepEqual(responded, [[17, { permissions: {}, scope: 'turn' }]], 'array dropped, grants an empty (valid) profile')
      cleanup()
    })

    it('grants ONLY fileSystem/network — an unexpected requested field never reaches the wire', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      const params = { ...escalationParams, permissions: { ...escalationParams.permissions, bogus: 'x' } }
      s._onServerRequest({ id: 18, method: 'item/permissions/requestApproval', params })
      s.respondToPermission(reqs[0][1].requestId, 'allow')
      await tick()
      assert.deepEqual(
        responded[0][1],
        { permissions: { fileSystem: escalationParams.permissions.fileSystem, network: escalationParams.permissions.network }, scope: 'turn' },
        'only the two GrantedPermissionProfile fields are granted; a request-only key is dropped',
      )
      cleanup()
    })

    it('describes the legacy read/write filesystem shape (not just entries)', () => {
      const { s, cleanup } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      const params = { ...escalationParams, reason: null, permissions: { fileSystem: { read: ['/etc/hosts'], write: ['/var/log'] } } }
      s._onServerRequest({ id: 19, method: 'item/permissions/requestApproval', params })
      assert.match(reqs[0][1].description, /filesystem read: \/etc\/hosts/)
      assert.match(reqs[0][1].description, /filesystem write: \/var\/log/)
      s.respondToPermission(reqs[0][1].requestId, 'deny') // resolve so no pending timeout timer leaks past cleanup
      cleanup()
    })

    it('caps a huge filesystem scope with a "+N more" tail so the prompt stays bounded and keeps network access', () => {
      const { s, cleanup } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      const entries = Array.from({ length: 10 }, (_, i) => ({ access: 'write', path: { type: 'path', path: `/p/${i}` } }))
      const params = { ...escalationParams, reason: null, permissions: { fileSystem: { entries }, network: { enabled: true } } }
      s._onServerRequest({ id: 22, method: 'item/permissions/requestApproval', params })
      const desc = reqs[0][1].description
      assert.match(desc, /\+7 more/, 'summarizes the tail instead of listing all 10 entries')
      assert.match(desc, /network access/, 'the trailing network scope survives the cap')
      s.respondToPermission(reqs[0][1].requestId, 'deny')
      cleanup()
    })
  })

  describe('MCP connector elicitation surfacing (#6635)', () => {
    const elicitParams = { serverName: 'github', threadId: 't1', mode: 'form', message: 'Allow writing a comment to issue #42?', requestedSchema: {} }

    it('surfaces the elicitation as a prompt naming the connector + message (was -32601 declined)', () => {
      const { s, cleanup } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 30, method: 'mcpServer/elicitation/request', params: elicitParams })
      assert.equal(reqs.length, 1, 'connector elicitation is surfaced, not silently declined')
      assert.equal(reqs[0][1].tool, 'mcp_elicitation')
      assert.match(reqs[0][1].description, /github/)
      assert.match(reqs[0][1].description, /issue #42/)
      s.respondToPermission(reqs[0][1].requestId, 'deny')
      cleanup()
    })

    it('accept → { action: accept }', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 31, method: 'mcpServer/elicitation/request', params: elicitParams })
      s.respondToPermission(reqs[0][1].requestId, 'allow')
      await tick()
      assert.deepEqual(responded, [[31, { action: 'accept' }]])
      cleanup()
    })

    it('deny → { action: decline } (a missed connector approval is now an explicit decline)', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 32, method: 'mcpServer/elicitation/request', params: elicitParams })
      s.respondToPermission(reqs[0][1].requestId, 'deny')
      await tick()
      assert.deepEqual(responded, [[32, { action: 'decline' }]])
      cleanup()
    })

    it('abort mid-elicitation → { action: decline } (answers codex, no wedge)', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 33, method: 'mcpServer/elicitation/request', params: elicitParams })
      assert.equal(reqs.length, 1)
      s._endTurnAbort()
      await tick()
      assert.deepEqual(responded, [[33, { action: 'decline' }]])
      cleanup()
    })

    it('url-mode surfaces the link in the prompt', () => {
      const { s, cleanup } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 34, method: 'mcpServer/elicitation/request', params: { serverName: 'github', threadId: 't1', mode: 'url', elicitationId: 'e1', message: 'Authorize access', url: 'https://example.com/oauth' } })
      assert.match(reqs[0][1].description, /https:\/\/example\.com\/oauth/)
      s.respondToPermission(reqs[0][1].requestId, 'deny')
      cleanup()
    })

    it('a REQUIRED-field form is declined even on allow (no incomplete accept until #6684)', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      // form-mode with a required property → we can't collect content yet, so an
      // action-only accept could write empty/default params → decline instead.
      s._onServerRequest({ id: 35, method: 'mcpServer/elicitation/request', params: { serverName: 'github', threadId: 't1', mode: 'form', message: 'Fill the release notes', requestedSchema: { required: ['notes'] } } })
      s.respondToPermission(reqs[0][1].requestId, 'allow')
      await tick()
      assert.deepEqual(responded, [[35, { action: 'decline' }]], 'required-field form → decline even on allow')
      cleanup()
    })

    it('openai/form is declined even on allow (freeform content not yet collectable)', async () => {
      const { s, cleanup, responded } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 36, method: 'mcpServer/elicitation/request', params: { serverName: 'x', threadId: 't1', mode: 'openai/form', message: 'give feedback', requestedSchema: true } })
      s.respondToPermission(reqs[0][1].requestId, 'allow')
      await tick()
      assert.deepEqual(responded, [[36, { action: 'decline' }]])
      cleanup()
    })

    it('auto mode auto-accepts a connector elicitation (bypass) without prompting', async () => {
      const { s, cleanup, responded } = mkApprovalSession('auto')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 37, method: 'mcpServer/elicitation/request', params: elicitParams })
      await tick()
      assert.equal(reqs.length, 0, 'auto mode does not prompt')
      assert.deepEqual(responded, [[37, { action: 'accept' }]])
      cleanup()
    })

    it('a missing serverName falls back to a generic connector label', () => {
      const { s, cleanup } = mkApprovalSession('approve')
      const reqs = capture(s, ['permission_request'])
      s._onServerRequest({ id: 38, method: 'mcpServer/elicitation/request', params: { threadId: 't1', mode: 'form', message: 'proceed?', requestedSchema: {} } })
      assert.match(reqs[0][1].description, /an MCP connector/)
      s.respondToPermission(reqs[0][1].requestId, 'deny')
      cleanup()
    })
  })

  it('interrupt() aborts a pending approval → Stop unblocks the turn (decline)', async () => {
    const { s, cleanup, responded } = mkApprovalSession()
    capture(s, ['permission_request'])
    s._onServerRequest({ id: 20, method: 'item/commandExecution/requestApproval', params: { command: 'x' } })
    await s.interrupt()
    await tick()
    assert.deepEqual(responded, [[20, { decision: 'decline' }]], 'Stop declined the pending approval')
    cleanup()
  })

  it('switching to auto drains a pending approval (autoAllowPending → accept)', async () => {
    const { s, cleanup, responded } = mkApprovalSession('approve')
    capture(s, ['permission_request'])
    s._onServerRequest({ id: 21, method: 'item/commandExecution/requestApproval', params: { command: 'x' } })
    s.setPermissionMode('auto') // panic button — must drain the pending prompt
    await tick()
    assert.deepEqual(responded, [[21, { decision: 'accept' }]], 'auto drained the pending prompt as accept')
    cleanup()
  })

  it('destroy() clears a pending approval without hanging (no leak)', async () => {
    const { s, cleanup } = mkApprovalSession()
    capture(s, ['permission_request'])
    s._onServerRequest({ id: 14, method: 'item/commandExecution/requestApproval', params: { command: 'x' } })
    assert.equal(s._permissions._pendingPermissions.size, 1, 'one pending approval before destroy')
    await s.destroy()
    assert.equal(s._permissions._pendingPermissions.size, 0, 'destroy cleared the pending approval (no hang/leak)')
    cleanup()
  })

  it('an unsupported serverRequest is declined with a JSON-RPC error', () => {
    const { s, cleanup, responded } = mkApprovalSession()
    s._onServerRequest({ id: 12, method: 'some/futureRequest', params: {} })
    assert.equal(responded[0][0], 12)
    assert.ok(responded[0][1].error, 'answered with an error')
    cleanup()
  })

  it('an aborted turn scope resolves a pending approval as deny (decline)', async () => {
    const { s, cleanup, responded } = mkApprovalSession()
    const reqs = capture(s, ['permission_request'])
    s._onServerRequest({ id: 13, method: 'item/commandExecution/requestApproval', params: { command: 'sleep 999' } })
    assert.equal(reqs.length, 1)
    s._endTurnAbort() // interrupt()/turn-end aborts the scope
    await tick()
    assert.deepEqual(responded, [[13, { decision: 'decline' }]], 'abort → decline')
    cleanup()
  })
})

describe('CodexAppServerSession — attachments (#6609)', () => {
  const PNG_B64 = Buffer.from('89504e470d0a1a0a0000000d49484452', 'hex').toString('base64')

  it('text-only input when there are no attachments', () => {
    const { s, cleanup } = mkSession()
    assert.deepEqual(s._buildTurnInput('hi', undefined, 'm1'), [{ type: 'text', text: 'hi' }])
    cleanup()
  })

  it('a binary image becomes a localImage item (codex vision), prompt text unchanged', async () => {
    const { s, cleanup } = mkSession()
    const input = s._buildTurnInput('look at this', [{ type: 'image', mediaType: 'image/png', data: PNG_B64, name: 'shot.png' }], 'm2')
    assert.equal(input[0].type, 'text')
    assert.equal(input[0].text, 'look at this', 'prompt text is not suffixed for an image')
    const img = input.find((i) => i.type === 'localImage')
    assert.ok(img && img.path.endsWith('.png'), 'a localImage item points at the materialized file')
    assert.ok(existsSync(img.path), 'the image bytes were written to disk')
    await s.destroy()
    cleanup()
  })

  it('a document is named in a text suffix, not a localImage', async () => {
    const { s, cleanup } = mkSession()
    const input = s._buildTurnInput('read this', [{ type: 'document', mediaType: 'text/plain', data: Buffer.from('hello').toString('base64'), name: 'notes.txt' }], 'm3')
    assert.equal(input.filter((i) => i.type === 'localImage').length, 0, 'documents are not localImage items')
    assert.match(input[0].text, /notes\.txt|att-1/, 'document referenced in the text suffix')
    await s.destroy()
    cleanup()
  })

  it('a relative file_ref image path is used directly (no copy) as a localImage', () => {
    const { s, cleanup } = mkSession()
    const input = s._buildTurnInput('see', [{ type: 'file_ref', path: 'pics/shot.jpg', name: 'shot.jpg' }], 'm4')
    const img = input.find((i) => i.type === 'localImage')
    assert.equal(img?.path, 'pics/shot.jpg', 'relative file_ref path passed straight through, no temp copy')
    assert.equal(s._attachDir, null, 'no temp dir created when there are no binary attachments')
    cleanup()
  })

  it('destroy() removes the materialized-attachment temp dir', async () => {
    const { s, cleanup } = mkSession()
    s._buildTurnInput('x', [{ type: 'image', mediaType: 'image/png', data: PNG_B64, name: 'a.png' }], 'm5')
    const dir = s._attachDir
    assert.ok(dir && existsSync(dir), 'temp dir created for a binary attachment')
    await s.destroy()
    assert.ok(!existsSync(dir), 'temp dir removed on destroy')
    cleanup()
  })

  it('skips an absolute / parent-traversing file_ref path (defence-in-depth, #6614)', () => {
    const { s, cleanup } = mkSession()
    for (const bad of ['/etc/passwd.jpg', '../secrets/key.png']) {
      const input = s._buildTurnInput('see', [{ type: 'file_ref', path: bad, name: 'x.png' }], 'm6')
      assert.equal(input.filter((i) => i.type === 'localImage').length, 0, `unconfined file_ref not turned into a localImage: ${bad}`)
      assert.deepEqual(input, [{ type: 'text', text: 'see' }])
    }
    cleanup()
  })

  it('does not silently drop an unattachable attachment (no data, not a file_ref)', () => {
    const { s, cleanup } = mkSession()
    // No throw, prompt still sent; the malformed entry is omitted (and warn-logged).
    const input = s._buildTurnInput('hi', [{ type: 'image', mediaType: 'image/png', name: 'nodata.png' }], 'm7')
    assert.deepEqual(input, [{ type: 'text', text: 'hi' }], 'malformed attachment omitted, prompt preserved')
    cleanup()
  })
})

// #6692 — codex reports cached input as a SUBSET of inputTokens (OpenAI
// convention). Chroxy's accounting keys are additive, so _mapUsage must split
// into uncached input + cache_read (previously the cache count lived only
// under `cached_input_tokens`, a key _trackUsage never reads — dropped).
describe('usage mapping (#6692)', () => {
  it('splits subset-cached input into uncached input + cache_read and synthesizes modelUsage', () => {
    const { s, cleanup } = mkSession({ model: 'gpt-5.1-codex' })
    const ev = capture(s, ['result'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: false }
    s._onNotification({
      method: 'thread/tokenUsage/updated',
      params: { usage: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 42 } },
    })
    s._onNotification({ method: 'turn/completed', params: { turn: { durationMs: 7 } } })
    assert.equal(ev.length, 1)
    const r = ev[0][1]
    assert.deepEqual(r.usage, {
      input_tokens: 400,
      output_tokens: 42,
      cache_read_input_tokens: 600,
      cached_input_tokens: 600, // deprecated duplicate, one release
    })
    assert.deepEqual(r.modelUsage, {
      'gpt-5.1-codex': {
        input_tokens: 400,
        output_tokens: 42,
        cache_read_input_tokens: 600,
        cache_creation_input_tokens: 0,
        web_search_requests: 0,
        cost_usd: null,
      },
    })
    cleanup()
  })

  it('a turn with no tokenUsage notification emits usage null and no fabricated modelUsage', () => {
    const { s, cleanup } = mkSession({ model: 'gpt-5.1-codex' })
    const ev = capture(s, ['result'])
    s._isBusy = true
    s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: false }
    s._onNotification({ method: 'turn/completed', params: { turn: { durationMs: 7 } } })
    assert.equal(ev[0][1].usage, null)
    assert.equal(ev[0][1].modelUsage, null)
    cleanup()
  })

  it('clamps an additive-reporting future build instead of going negative', () => {
    const { s, cleanup } = mkSession({ model: 'gpt-5.1-codex' })
    // cached > input: impossible under subset semantics; the split clamps to 0
    const mapped = s._mapUsage({ usage: { inputTokens: 100, cachedInputTokens: 600, outputTokens: 1 } })
    assert.equal(mapped.input_tokens, 0)
    assert.equal(mapped.cache_read_input_tokens, 600)
    cleanup()
  })
})

// #6829 — the permission-rule accessors that #6826 gave SdkSession/ByokSession
// but left off CodexAppServerSession, so a codex session's rules never broadcast
// (permission_rules_updated) or replayed on reconnect (ws-history gates on the
// getters). Mirrors the SdkSession seeding test in
// settings-handlers-permission-rules.test.js.
describe('CodexAppServerSession — permission rule accessors (#6829)', () => {
  it('getPermissionRules / getPersistentPermissionRules / setPersistentPermissionRules delegate to the PermissionManager', () => {
    const { s, cleanup } = mkSession()
    try {
      // Session rules — codex keeps setPermissionRules OFF (sessionRules:false in
      // the picker), so seed the manager directly to prove the getter delegates.
      s._permissions.setRules([{ tool: 'Read', decision: 'allow' }])
      assert.deepEqual(s.getPermissionRules(), [{ tool: 'Read', decision: 'allow' }])

      // Persistent (project) rules — the setter re-seeds the in-memory set, the
      // getter tags each `persist:'project'` (the shape the wire broadcast carries).
      s.setPersistentPermissionRules([{ tool: 'Write', decision: 'allow' }])
      assert.deepEqual(s.getPersistentPermissionRules(), [
        { tool: 'Write', decision: 'allow', persist: 'project' },
      ])
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('seeds persistent rules from the injected rule store for its cwd', async () => {
    const { PermissionRuleStore } = await import('../src/permission-rule-store.js')
    const dir = mkdtempSync(join(tmpdir(), 'chroxy-codex-seed-'))
    try {
      const store = new PermissionRuleStore({
        filePath: join(dir, 'permission-rules.json'),
        logger: { info() {}, warn() {}, error() {} },
      })
      store.addRule('/proj/codex-seed', { tool: 'apply_patch', decision: 'allow' })

      const { s, cleanup } = mkSession({ cwd: '/proj/codex-seed', permissionRuleStore: store })
      assert.deepEqual(s.getPersistentPermissionRules(), [
        { tool: 'apply_patch', decision: 'allow', persist: 'project' },
      ])
      s.destroy()
      cleanup()

      // A codex session in a DIFFERENT cwd does not inherit the rule.
      const other = mkSession({ cwd: '/proj/other', permissionRuleStore: store })
      assert.deepEqual(other.s.getPersistentPermissionRules(), [])
      other.s.destroy()
      other.cleanup()
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it('getPermissionRules / getPersistentPermissionRules return [] when the delegate is absent', () => {
    const { s, cleanup } = mkSession()
    try {
      delete s._permissions.getRules
      delete s._permissions.getPersistentRules
      assert.deepEqual(s.getPermissionRules(), [])
      assert.deepEqual(s.getPersistentPermissionRules(), [])
    } finally {
      s.destroy()
      cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// #7729 — start() under test for the FIRST time.
//
// Until now `start()` had no unit coverage at all: it builds a real
// CodexAppServerClient (which spawns `codex app-server`), so the suite could
// only reach around it. `session-manager-codex-sandbox.test.js` said so in a
// comment and REPRODUCED start()'s sandbox line instead of calling it — a test
// that reimplements its subject cannot go red for the subject's bugs. The
// `clientFactory` seam replaces that: the stub below answers JSON-RPC with the
// shapes the live binary answers (codex-cli 0.154.0, recorded on the epic:
// github.com/blamechris/chroxy/issues/7721#issuecomment-5644101381), and the
// real start() runs over it. No test spawns a binary.
// ---------------------------------------------------------------------------

// A stub CodexAppServerClient: an EventEmitter with initialize/request/kill.
// `calls` records every (method, params) pair so a test can assert the EXACT
// wire params start() and sendMessage() send.
function stubClient(responses = {}) {
  const calls = []
  const c = new EventEmitter()
  c.initialize = async (params) => {
    calls.push(['initialize', params])
    return responses.initialize ?? { userAgent: 'codex_cli_rs/0.154.0 (x) chroxy' }
  }
  c.request = async (method, params) => {
    calls.push([method, params])
    if (Object.hasOwn(responses, method)) return responses[method]
    // Anything unstubbed (e.g. the fire-and-forget model/list catalog probe)
    // answers an empty object — a cannot-parse, which leaves the catalog UNSET.
    return {}
  }
  c.kill = () => {}
  return { client: c, calls }
}

// The live `thread/start` result, trimmed to the fields this session reads.
//
// Provenance is the UNTRIMMED codex-cli 0.154.0 capture,
// https://github.com/blamechris/chroxy/issues/7721#issuecomment-5646200933 —
// which carries the nested `thread` object (`id`, `model`, `reasoningEffort`,
// `cliVersion`, …) alongside the top-level fields, with `thread.model` /
// `thread.reasoningEffort` MIRRORING the top-level `model` /
// `reasoningEffort`. `thread` is in `ThreadStartResponse.required`. Nothing
// here is synthetic: the nested object is what exercises `start()`'s
// `started?.thread?.id` read (the sole source of `_threadId`) and
// `_captureBootedModel`'s `thread.model` branch, so do not trim it away on the
// belief that it was invented.
const THREAD_START_ECHO = Object.freeze({
  model: 'gpt-5.5',
  reasoningEffort: 'xhigh',
  modelProvider: 'openai',
  approvalPolicy: 'on-request',
  thread: { id: 'th-1', model: 'gpt-5.5', reasoningEffort: 'xhigh', cliVersion: '0.154.0' },
})

function mkStartedSession(extraOpts = {}, responses = {}) {
  const stub = stubClient(responses)
  const { s, cleanup } = mkSession({ clientFactory: () => stub.client, ...extraOpts })
  return { s, cleanup, ...stub }
}

describe('CodexAppServerSession — start() over a stub client (#7729)', () => {
  it('sends thread/start the EXACT param shape the inline object used to build', async () => {
    const prev = process.env.CHROXY_CODEX_SANDBOX
    delete process.env.CHROXY_CODEX_SANDBOX
    const { s, cleanup, calls } = mkStartedSession({}, { 'thread/start': THREAD_START_ECHO })
    try {
      await s.start()
      const threadCall = calls.find(([m]) => m === 'thread/start')
      assert.ok(threadCall, 'thread/start was sent')
      assert.deepEqual(threadCall[1], {
        approvalPolicy: 'on-request',
        cwd: '/tmp',
        sandbox: CODEX_DEFAULT_SANDBOX,
      }, 'no `model` key when the operator set none — codex falls back to ~/.codex/config.toml')
      assert.deepEqual(Object.keys(threadCall[1]), ['approvalPolicy', 'cwd', 'sandbox'])
    } finally {
      s.destroy()
      cleanup()
      if (prev === undefined) delete process.env.CHROXY_CODEX_SANDBOX
      else process.env.CHROXY_CODEX_SANDBOX = prev
    }
  })

  it('an operator model override rides thread/start', async () => {
    const { s, cleanup, calls } = mkStartedSession({ model: 'gpt-5-codex' }, { 'thread/start': THREAD_START_ECHO })
    try {
      await s.start()
      const params = calls.find(([m]) => m === 'thread/start')[1]
      assert.equal(params.model, 'gpt-5-codex')
      assert.deepEqual(Object.keys(params), ['approvalPolicy', 'cwd', 'sandbox', 'model'])
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('the thread/start echo sets bootedModel and `ready` names the resolved model', async () => {
    const { s, cleanup } = mkStartedSession({}, { 'thread/start': THREAD_START_ECHO })
    const ready = []
    s.on('ready', (p) => ready.push(p))
    try {
      await s.start()
      assert.equal(s.bootedModel, 'gpt-5.5', 'bootedModel comes from the thread/start echo')
      assert.deepEqual(ready, [{ model: 'gpt-5.5' }],
        'ready names the model codex actually resolved, not the null this session was constructed with')
      assert.equal(s._effectiveModelId(), 'gpt-5.5')
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('falls back to thread.model when the top-level echo is absent', async () => {
    const { s, cleanup } = mkStartedSession({}, { 'thread/start': { thread: { id: 'th-2', model: 'gpt-5.4' } } })
    try {
      await s.start()
      assert.equal(s.bootedModel, 'gpt-5.4')
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('a response with NO model field leaves bootedModel null — never undefined-coerced', async () => {
    const { s, cleanup } = mkStartedSession({}, { 'thread/start': { thread: { id: 'th-3' } } })
    const ready = []
    s.on('ready', (p) => ready.push(p))
    try {
      await s.start()
      assert.equal(s.bootedModel, null)
      assert.equal(s.bootedModel === undefined, false, 'null, not undefined — a cannot-check must stay readable')
      assert.deepEqual(ready, [{ model: null }], 'ready reports null rather than fabricating a model')
      assert.equal(s._threadId, 'th-3', 'the thread still started')
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('an empty-string / non-string echo is NOT a model id', async () => {
    for (const bad of ['', 42, null, {}]) {
      const { s, cleanup } = mkStartedSession({}, { 'thread/start': { model: bad, thread: { id: 'th' } } })
      try {
        await s.start()
        assert.equal(s.bootedModel, null, `echo ${JSON.stringify(bad)} must not become a model id`)
      } finally {
        s.destroy()
        cleanup()
      }
    }
  })

  it('the operator override WINS over the echo for the effective model', async () => {
    const { s, cleanup } = mkStartedSession({ model: 'gpt-5-codex' }, { 'thread/start': THREAD_START_ECHO })
    try {
      await s.start()
      assert.equal(s.bootedModel, 'gpt-5.5', 'what codex resolved is still recorded')
      assert.equal(s._effectiveModelId(), 'gpt-5-codex', 'the explicit override is what the session is described by')
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('start() stores the resolved sandbox and getCodexSandbox() does not drift with a later env change', async () => {
    const prev = process.env.CHROXY_CODEX_SANDBOX
    process.env.CHROXY_CODEX_SANDBOX = 'read-only'
    const { s, cleanup, calls } = mkStartedSession({}, { 'thread/start': THREAD_START_ECHO })
    try {
      await s.start()
      assert.equal(calls.find(([m]) => m === 'thread/start')[1].sandbox, 'read-only')
      assert.equal(s.getCodexSandbox(), 'read-only')
      process.env.CHROXY_CODEX_SANDBOX = 'danger-full-access'
      assert.equal(s.getCodexSandbox(), 'read-only', 'captured at start — must not follow the env')
    } finally {
      s.destroy()
      cleanup()
      if (prev === undefined) delete process.env.CHROXY_CODEX_SANDBOX
      else process.env.CHROXY_CODEX_SANDBOX = prev
    }
  })
})

describe('CodexAppServerSession — param builders (#7729)', () => {
  it('_buildThreadParams matches the inline shape, and omits `model` when there is none', () => {
    const { s, cleanup } = mkSession()
    try {
      assert.deepEqual(s._buildThreadParams('workspace-write'), {
        approvalPolicy: 'on-request',
        cwd: '/tmp',
        sandbox: 'workspace-write',
      })
      s.model = 'gpt-5.5'
      assert.deepEqual(s._buildThreadParams('read-only'), {
        approvalPolicy: 'on-request',
        cwd: '/tmp',
        sandbox: 'read-only',
        model: 'gpt-5.5',
      })
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('_buildTurnParams matches the inline shape, and omits `model` when there is none', () => {
    const { s, cleanup } = mkSession()
    try {
      s._threadId = 'th-9'
      const input = [{ type: 'text', text: 'hi' }]
      assert.deepEqual(s._buildTurnParams(input), {
        threadId: 'th-9',
        approvalPolicy: 'on-request',
        input,
      })
      s.model = 'gpt-5.5'
      assert.deepEqual(s._buildTurnParams(input), {
        threadId: 'th-9',
        approvalPolicy: 'on-request',
        input,
        model: 'gpt-5.5',
      })
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('the approvalPolicy tracks the permission mode on BOTH builders', () => {
    const { s, cleanup } = mkSession()
    try {
      s.permissionMode = 'auto'
      assert.equal(s._buildThreadParams('read-only').approvalPolicy, 'never')
      assert.equal(s._buildTurnParams([]).approvalPolicy, 'never')
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('turn/start is SENT the builder output (the builder is wired, not merely correct)', async () => {
    const { s, cleanup, calls } = mkStartedSession({ model: 'gpt-5-codex' }, { 'thread/start': THREAD_START_ECHO, 'turn/start': { turn: { id: 'tu-1' } } })
    try {
      await s.start()
      await s.sendMessage('hello')
      const turnCall = calls.find(([m]) => m === 'turn/start')
      assert.ok(turnCall, 'turn/start was sent')
      assert.deepEqual(Object.keys(turnCall[1]), ['threadId', 'approvalPolicy', 'input', 'model'])
      assert.equal(turnCall[1].threadId, 'th-1')
      assert.equal(turnCall[1].model, 'gpt-5-codex')
      assert.equal(turnCall[1].input[0].text, 'hello')
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('a re-routed thread does NOT pin turn/start back to the model codex moved away from', async () => {
    const { s, cleanup, calls } = mkStartedSession({}, { 'thread/start': THREAD_START_ECHO, 'turn/start': { turn: { id: 'tu-1' } } })
    try {
      await s.start()
      s._onModelRerouted({ fromModel: 'gpt-5.5', toModel: 'gpt-5.4-mini', reason: 'capacity' })
      await s.sendMessage('hello')
      const params = calls.find(([m]) => m === 'turn/start')[1]
      assert.equal('model' in params, false,
        'no operator override → no model on the turn; echoing the resolved model back would pin a re-routed thread')
    } finally {
      s.destroy()
      cleanup()
    }
  })
})

describe('CodexAppServerSession — reasoning effort (#7730)', () => {
  it('advertises thinkingLevel and NOT thinkingKeywords', () => {
    const caps = CodexAppServerSession.capabilities
    assert.equal(caps.thinkingLevel, true, 'codex has a real reasoning control and this driver can reach it')
    assert.equal(caps.thinkingKeywords, false,
      'the Claude magic keywords are not scanned on any codex path — #7735 split these so this flip cannot drag the highlight along')
  })

  it('thinkingLevel is null (never undefined) before anything is known', () => {
    const { s, cleanup } = mkSession()
    try {
      assert.equal(s.thinkingLevel, null,
        'undefined is BaseSession\'s "this provider has no thinking level" — which suppresses the ws-history replay entirely')
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('the thread/start echo becomes the session thinkingLevel when nobody chose one', async () => {
    const { s, cleanup } = mkStartedSession({}, { 'thread/start': THREAD_START_ECHO })
    try {
      await s.start()
      assert.equal(s.thinkingLevel, 'xhigh',
        "the control must show codex's real effort (from ~/.codex/config.toml), not a default this repo invented")
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('falls back to thread.reasoningEffort when the top-level echo is absent', async () => {
    const { s, cleanup } = mkStartedSession({}, { 'thread/start': { thread: { id: 'th-e', reasoningEffort: 'medium' } } })
    try {
      await s.start()
      assert.equal(s.thinkingLevel, 'medium')
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('an echo carrying NO effort leaves thinkingLevel null rather than guessing', async () => {
    const { s, cleanup } = mkStartedSession({}, { 'thread/start': { thread: { id: 'th-n' } } })
    try {
      await s.start()
      assert.equal(s.thinkingLevel, null)
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('the operator override WINS over the echo', async () => {
    const { s, cleanup } = mkStartedSession({}, { 'thread/start': THREAD_START_ECHO })
    try {
      await s.start()
      s.setThinkingLevel('low')
      assert.equal(s.thinkingLevel, 'low')
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('setThinkingLevel VALIDATES NOTHING — the per-model gate lives in the handler', () => {
    const { s, cleanup } = mkSession()
    try {
      // `zzz` is in no list anywhere in this repo. A roster here would be a
      // second one to drift, and this layer cannot see the active model's row.
      s.setThinkingLevel('zzz')
      assert.equal(s.thinkingLevel, 'zzz')
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('a null / empty level clears the override rather than storing a falsy string', () => {
    const { s, cleanup } = mkSession()
    try {
      s.setThinkingLevel('xhigh')
      s.setThinkingLevel(null)
      assert.equal(s.thinkingLevel, null)
      assert.equal('effort' in s._buildTurnParams([]), false, 'a cleared effort sends no key')
    } finally {
      s.destroy()
      cleanup()
    }
  })
})

describe('CodexAppServerSession — the effort reaches the wire (#7730)', () => {
  it('thread/start seeds the effort through `config.model_reasoning_effort`, NOT a top-level field', async () => {
    const prev = process.env.CHROXY_CODEX_SANDBOX
    delete process.env.CHROXY_CODEX_SANDBOX
    const { s, cleanup, calls } = mkStartedSession({}, { 'thread/start': THREAD_START_ECHO })
    try {
      s.setThinkingLevel('xhigh')
      await s.start()
      const params = calls.find(([m]) => m === 'thread/start')[1]
      // The asymmetry is the whole trap: thread/start has NO top-level effort
      // field (verified live on codex-cli 0.154.0), so a symmetrical
      // `effort: 'xhigh'` here is accepted and silently ignored.
      assert.equal('effort' in params, false, 'thread/start takes no top-level effort field')
      assert.deepEqual(params.config, { model_reasoning_effort: 'xhigh' })
    } finally {
      s.destroy()
      cleanup()
      if (prev === undefined) delete process.env.CHROXY_CODEX_SANDBOX
      else process.env.CHROXY_CODEX_SANDBOX = prev
    }
  })

  it('thread/start carries NO config key when the operator chose nothing', async () => {
    const prev = process.env.CHROXY_CODEX_SANDBOX
    delete process.env.CHROXY_CODEX_SANDBOX
    const { s, cleanup, calls } = mkStartedSession({}, { 'thread/start': THREAD_START_ECHO })
    try {
      await s.start()
      const params = calls.find(([m]) => m === 'thread/start')[1]
      assert.equal('config' in params, false,
        'codex must be left to resolve its own effort from ~/.codex/config.toml')
    } finally {
      s.destroy()
      cleanup()
      if (prev === undefined) delete process.env.CHROXY_CODEX_SANDBOX
      else process.env.CHROXY_CODEX_SANDBOX = prev
    }
  })

  it('a set_thinking_level lands in the NEXT turn/start params as a first-class `effort`', async () => {
    const { s, cleanup, calls } = mkStartedSession({}, { 'thread/start': THREAD_START_ECHO, 'turn/start': { turn: { id: 'tu-1' } } })
    try {
      await s.start()
      s.setThinkingLevel('zzz')
      await s.sendMessage('hello')
      const params = calls.find(([m]) => m === 'turn/start')[1]
      assert.equal(params.effort, 'zzz',
        'turn/start takes `effort` as a first-class per-turn field — an invented level rides it unchanged')
      assert.equal('config' in params, false, 'the config map is the thread/start half only')
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('the effort rides EVERY subsequent turn, not just the one after the change', async () => {
    const { s, cleanup, calls } = mkStartedSession({}, { 'thread/start': THREAD_START_ECHO, 'turn/start': { turn: { id: 'tu-1' } } })
    try {
      await s.start()
      s.setThinkingLevel('low')
      await s.sendMessage('one')
      // End the turn the way a real `result` would, so the second send is not
      // queued behind the busy flag.
      s._isBusy = false
      s._activeTurn = null
      await s.sendMessage('two')
      const turns = calls.filter(([m]) => m === 'turn/start')
      assert.equal(turns.length, 2, 'two turns were sent')
      assert.deepEqual(turns.map(([, p]) => p.effort), ['low', 'low'],
        'a thread must not silently drift back to the binary default on a later turn')
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('turn/start carries NO effort key when nobody chose one — the echo is display-only', async () => {
    const { s, cleanup, calls } = mkStartedSession({}, { 'thread/start': THREAD_START_ECHO, 'turn/start': { turn: { id: 'tu-1' } } })
    try {
      await s.start()
      assert.equal(s.thinkingLevel, 'xhigh', 'the echo IS known')
      await s.sendMessage('hello')
      const params = calls.find(([m]) => m === 'turn/start')[1]
      assert.equal('effort' in params, false,
        "echoing codex's own resolved effort back at it would pin a value the binary is free to re-resolve")
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('_buildThreadParams / _buildTurnParams keep their existing shape when no effort is set', () => {
    const { s, cleanup } = mkSession()
    try {
      s._threadId = 'th-9'
      assert.deepEqual(Object.keys(s._buildThreadParams('read-only')), ['approvalPolicy', 'cwd', 'sandbox'])
      assert.deepEqual(Object.keys(s._buildTurnParams([])), ['threadId', 'approvalPolicy', 'input'])
      s.setThinkingLevel('xhigh')
      assert.deepEqual(Object.keys(s._buildThreadParams('read-only')), ['approvalPolicy', 'cwd', 'sandbox', 'config'])
      assert.deepEqual(Object.keys(s._buildTurnParams([])), ['threadId', 'approvalPolicy', 'input', 'effort'])
    } finally {
      s.destroy()
      cleanup()
    }
  })
})

describe('CodexAppServerSession — model/rerouted (#7729)', () => {
  it('a mid-turn reroute moves bootedModel and the per-model usage split', () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['result'])
    try {
      s.bootedModel = 'gpt-5.5'
      s._isBusy = true
      s._activeTurn = { messageId: 'm1', turnId: 't1', didStreamStart: false }
      s._onNotification({ method: 'model/rerouted', params: { threadId: 'th', turnId: 't1', fromModel: 'gpt-5.5', toModel: 'gpt-5.4-mini', reason: 'capacity' } })
      assert.equal(s.bootedModel, 'gpt-5.4-mini')
      s._onNotification({ method: 'thread/tokenUsage/updated', params: { usage: { inputTokens: 10, outputTokens: 2 } } })
      s._onNotification({ method: 'turn/completed', params: { turn: { durationMs: 1 } } })
      assert.notEqual(ev[0][1].modelUsage, null,
        'a session with no operator override must still produce a per-model usage split')
      assert.deepEqual(Object.keys(ev[0][1].modelUsage), ['gpt-5.4-mini'],
        'usage is keyed on the model the turn actually ran on')
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('a reroute BETWEEN turns is still consumed (no active turn)', () => {
    const { s, cleanup } = mkSession()
    try {
      s.bootedModel = 'gpt-5.5'
      assert.equal(s._activeTurn, null)
      s._onNotification({ method: 'model/rerouted', params: { toModel: 'gpt-5.4' } })
      assert.equal(s.bootedModel, 'gpt-5.4')
    } finally {
      s.destroy()
      cleanup()
    }
  })

  it('a reroute with no usable toModel leaves the known model ALONE', () => {
    const { s, cleanup } = mkSession()
    try {
      s.bootedModel = 'gpt-5.5'
      for (const params of [{}, { toModel: '' }, { toModel: null }, { fromModel: 'gpt-5.5' }]) {
        assert.equal(s._onModelRerouted(params), false)
        assert.equal(s.bootedModel, 'gpt-5.5', 'a cannot-read must never blank a model id we already know')
      }
    } finally {
      s.destroy()
      cleanup()
    }
  })
})

// ---------------------------------------------------------------------------
// #7729 — the context window comes from codex itself.
//
// `model/list` carries NO context window, so `thread/tokenUsage/updated`'s
// `modelContextWindow` is the ONLY authoritative source that exists. It is
// written straight to the codex registry; the observed-tokens ratchet
// (utils/context-window-learn.js) stays as the fallback for a build that does
// not report one. Neither path emits `models_updated`, so neither pushes the
// whole roster over the tunnel once per turn.
// ---------------------------------------------------------------------------

// The live notification shape, verified against codex-cli 0.154.0 (epic record
// github.com/blamechris/chroxy/issues/7721#issuecomment-5644101381):
//   { threadId, turnId, tokenUsage: { total, last, modelContextWindow } }
// #7773 — `total` DEFAULTS TO `last` when a caller names only `last`, because
// that is the live turn-1 invariant: `total` is the thread-cumulative sum of
// every response, so on the first response of a fresh thread the two are
// identical (probed: turn 1 reported total.totalTokens == last.totalTokens ==
// 14962). Defaulting it to all-zeros instead would make every one of these
// fixtures describe a payload codex cannot emit, and the per-turn delta
// (#7773) would read 0 for a turn the fixture says spent 500k.
function tokenUsageParams({ last, total, modelContextWindow } = {}) {
  const breakdown = (o) => ({
    totalTokens: 0, inputTokens: 0, cachedInputTokens: 0,
    outputTokens: 0, reasoningOutputTokens: 0, cacheWriteInputTokens: 0,
    ...o,
  })
  const tokenUsage = { total: breakdown(total ?? last), last: breakdown(last) }
  if (modelContextWindow !== undefined) tokenUsage.modelContextWindow = modelContextWindow
  return { threadId: 'th-1', turnId: 'tu-1', tokenUsage }
}

describe('CodexAppServerSession — authoritative context window (#7729)', () => {
  const registry = getRegistryForProvider('codex')
  const windowOf = (id) => registry.getModels().find((m) => m.id === id)?.contextWindow

  function withCodexSession(fn, opts = {}) {
    const { s, cleanup } = mkSession(opts)
    // The registry is a process-global; put it back however the test ends.
    try {
      return fn(s)
    } finally {
      registry.resetModels()
      s.destroy()
      cleanup()
    }
  }

  it('the seed window this suite ratchets against is the one the registry really holds', () => {
    assert.equal(windowOf('gpt-5-codex'), 400_000,
      'if this changes, the 272000 / 550000 expectations below need re-deriving')
  })

  it('modelContextWindow is written to the registry — including DOWNWARD (authoritative, not a ratchet)', () => {
    withCodexSession((s) => {
      s.bootedModel = 'gpt-5-codex'
      s._activeTurn = { messageId: 'm1', turnId: 'tu-1', didStreamStart: false }
      s._onNotification({
        method: 'thread/tokenUsage/updated',
        params: tokenUsageParams({ last: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 42 }, modelContextWindow: 272_000 }),
      })
      assert.equal(windowOf('gpt-5-codex'), 272_000,
        'codex is the authority on its own window — a smaller reported window must win over the static 400k')
    })
  })

  // #7773 — this test used to assert the breakdown was read straight off
  // `last`, on the theory that `last` IS the turn. It is not: `last` is one
  // model RESPONSE. The turn is the DELTA of the cumulative `total` since turn
  // start, which is what the suite below pins. The anti-compounding rationale
  // the old assertion carried is preserved here: the reported figure must not
  // be the running total either.
  it('the token breakdown is neither the raw cumulative `total` nor one response (#7773)', () => {
    withCodexSession((s) => {
      s.bootedModel = 'gpt-5-codex'
      s._activeTurn = { messageId: 'm1', turnId: 'tu-1', didStreamStart: false }
      // Turn 1 of the thread: nothing accumulated yet, so the baseline is
      // zero and the turn's delta IS `total`.
      s._onNotification({
        method: 'thread/tokenUsage/updated',
        params: tokenUsageParams({
          last: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 42 },
          total: { inputTokens: 1000, cachedInputTokens: 600, outputTokens: 42 },
          modelContextWindow: 272_000,
        }),
      })
      assert.deepEqual(s._lastUsage, {
        input_tokens: 400,
        output_tokens: 42,
        cache_read_input_tokens: 600,
        cached_input_tokens: 600,
      }, 'session-manager ACCUMULATES result.usage — a running total here would compound every turn')
    })
  })

  it('a payload WITHOUT modelContextWindow leaves the entry unchanged and falls through to the ratchet', () => {
    withCodexSession((s) => {
      s.bootedModel = 'gpt-5-codex'
      s._activeTurn = { messageId: 'm1', turnId: 'tu-1', didStreamStart: false }
      s._onNotification({
        method: 'thread/tokenUsage/updated',
        params: tokenUsageParams({ last: { inputTokens: 1000, cachedInputTokens: 0, outputTokens: 42 } }),
      })
      assert.equal(windowOf('gpt-5-codex'), 400_000,
        'no reported window is a CANNOT-CHECK: the entry keeps its value and nothing is substituted for it')
      assert.notEqual(windowOf('gpt-5-codex'), DEFAULT_CONTEXT_WINDOW,
        '"no meter" and "wrong meter" must not be the same green')
    })
  })

  it('the ratchet still runs when codex reports no window (a prompt past the entry bumps it UP)', () => {
    withCodexSession((s) => {
      s.bootedModel = 'gpt-5-codex'
      s._activeTurn = { messageId: 'm1', turnId: 'tu-1', didStreamStart: false }
      s._onNotification({
        method: 'thread/tokenUsage/updated',
        params: tokenUsageParams({ last: { inputTokens: 500_000, cachedInputTokens: 0, outputTokens: 1 } }),
      })
      assert.equal(windowOf('gpt-5-codex'), 550_000, '500000 * 1.1, rounded up to the nearest 1k')
    })
  })

  it('the ratchet is fed the WHOLE prompt, not the disjoint uncached half the accounting split emits', () => {
    withCodexSession((s) => {
      s.bootedModel = 'gpt-5-codex'
      s._activeTurn = { messageId: 'm1', turnId: 'tu-1', didStreamStart: false }
      // A cache-heavy turn: 500k prompt of which 450k was cached. The emitted
      // accounting usage is the 50k uncached remainder — but the model still
      // held 500k of context, so that is what the window must be learned from.
      s._onNotification({
        method: 'thread/tokenUsage/updated',
        params: tokenUsageParams({ last: { inputTokens: 500_000, cachedInputTokens: 450_000, outputTokens: 1 } }),
      })
      assert.equal(s._lastUsage.input_tokens, 50_000, 'accounting still reports the disjoint split')
      assert.equal(windowOf('gpt-5-codex'), 550_000, 'the window is learned from the FULL prompt')
    })
  })

  it('0 / negative / NaN / null / non-number windows leave the entry unchanged', () => {
    for (const bad of [0, -1, Number.NaN, null, '272000', Infinity]) {
      withCodexSession((s) => {
        s.bootedModel = 'gpt-5-codex'
        s._activeTurn = { messageId: 'm1', turnId: 'tu-1', didStreamStart: false }
        s._onNotification({
          method: 'thread/tokenUsage/updated',
          // A tiny prompt, so the ratchet fallback is itself a no-op and this
          // assertion is about the reported window alone.
          params: tokenUsageParams({ last: { inputTokens: 10, outputTokens: 1 }, modelContextWindow: bad }),
        })
        assert.equal(windowOf('gpt-5-codex'), 400_000, `modelContextWindow ${String(bad)} must not be written`)
      })
    }
  })

  it('a session with NO model id writes nothing — a brand-new meter stays dashed, never fabricated', () => {
    withCodexSession((s) => {
      assert.equal(s._effectiveModelId(), null, 'no override, no thread/start echo yet')
      s._activeTurn = { messageId: 'm1', turnId: 'tu-1', didStreamStart: false }
      const before = registry.getModels().map((m) => [m.id, m.contextWindow])
      s._onNotification({
        method: 'thread/tokenUsage/updated',
        params: tokenUsageParams({ last: { inputTokens: 1000, outputTokens: 1 }, modelContextWindow: 272_000 }),
      })
      assert.deepEqual(registry.getModels().map((m) => [m.id, m.contextWindow]), before,
        'nothing to key a window on — and nothing invented to stand in for it')
    })
  })

  it('an operator override is what the window is keyed on when there is one', () => {
    withCodexSession((s) => {
      s.bootedModel = 'gpt-5.5' // what codex resolved; not in the registry
      s._activeTurn = { messageId: 'm1', turnId: 'tu-1', didStreamStart: false }
      s._onNotification({
        method: 'thread/tokenUsage/updated',
        params: tokenUsageParams({ last: { inputTokens: 10, outputTokens: 1 }, modelContextWindow: 272_000 }),
      })
      assert.equal(windowOf('gpt-5-codex'), 272_000, 'the OVERRIDE is the id the window is keyed on')
      assert.equal(windowOf('gpt-5'), 400_000, 'and no near-miss id was touched')
    }, { model: 'gpt-5-codex' })
  })

  it('an override SURVIVES a mid-turn reroute: the window stays keyed on the override, and the re-routed-to model is untouched', () => {
    // Review of #7767: override + reroute was the one combination neither the
    // reroute describe nor the window describe covered. It is pinned here
    // rather than changed — `_effectiveModelId()` is override → booted → null
    // on purpose, and session_info renders `model || bootedModel` in the SAME
    // precedence (session-manager.js:1998), so label and measurement agree.
    // Splitting them (a separate `_runningModelId()` for the registry key)
    // would make this test red, which is the point of having it.
    withCodexSession((s) => {
      s.bootedModel = 'gpt-5.5'
      s._activeTurn = { messageId: 'm1', turnId: 'tu-1', didStreamStart: false }
      // Codex re-routes the thread onto a model the registry DOES carry, so
      // "untouched" below is an assertion about a real entry, not about undefined.
      s._onNotification({
        method: 'model/rerouted',
        params: { threadId: 'th-1', turnId: 'tu-1', fromModel: 'gpt-5.5', toModel: 'gpt-5', reason: 'capacity' },
      })
      assert.equal(s.bootedModel, 'gpt-5', 'precondition: the reroute did move bootedModel')
      assert.equal(s._effectiveModelId(), 'gpt-5-codex', 'precondition: the override still wins over the re-routed model')

      s._onNotification({
        method: 'thread/tokenUsage/updated',
        params: tokenUsageParams({ last: { inputTokens: 10, outputTokens: 1 }, modelContextWindow: 272_000 }),
      })
      assert.equal(windowOf('gpt-5-codex'), 272_000,
        'the override is still what the window is keyed on after a reroute')
      assert.equal(windowOf('gpt-5'), 400_000,
        'the re-routed-to model keeps its own window — this path never writes to it')
    }, { model: 'gpt-5-codex' })
  })

  it('a codex tokenUsage update produces ZERO global available_models broadcasts', () => {
    const broadcasts = []
    const sm = new EventEmitter()
    sm.getSession = () => ({ provider: 'codex' })
    sm.listSessions = () => []
    sm.getSessionContext = async () => null
    const devPreview = new EventEmitter()
    devPreview.handleToolResult = () => {}
    devPreview.closeSession = () => {}
    setupForwarding({
      normalizer: new EventNormalizer(),
      sessionManager: sm,
      cliSession: null,
      devPreview,
      checkpointManager: new EventEmitter(),
      pushManager: null,
      permissionSessionMap: new Map(),
      questionSessionMap: new Map(),
      broadcast: (m) => broadcasts.push(m),
      broadcastToSession: () => {},
    })

    withCodexSession((s) => {
      // The ONE line session-manager.js:3928-3929 uses to forward this event.
      s.on('models_updated', (data) => sm.emit('session_event', { sessionId: 'sess-1', event: 'models_updated', data }))
      s.bootedModel = 'gpt-5-codex'
      s._activeTurn = { messageId: 'm1', turnId: 'tu-1', didStreamStart: false }
      // Both paths: the authoritative write, then the ratchet fallback.
      s._onNotification({
        method: 'thread/tokenUsage/updated',
        params: tokenUsageParams({ last: { inputTokens: 1000, outputTokens: 1 }, modelContextWindow: 272_000 }),
      })
      s._onNotification({
        method: 'thread/tokenUsage/updated',
        params: tokenUsageParams({ last: { inputTokens: 900_000, outputTokens: 1 } }),
      })
      // 900000 * 1.1 is 990000.0000000001 in IEEE754, so the 1k round-up lands on 991k.
      assert.equal(windowOf('gpt-5-codex'), 991_000, 'both paths actually did write — this is not vacuous')
      assert.deepEqual(broadcasts.filter((m) => m.type === 'available_models'), [],
        'a per-turn global roster push is waste over a tunnel; the write reaches clients on the next roster refresh')

      // Positive control: the harness DOES broadcast when a models_updated is
      // emitted, so the assertion above is armed rather than vacuously green.
      s.emit('models_updated', { models: registry.getModels() })
      assert.equal(broadcasts.filter((m) => m.type === 'available_models').length, 1,
        'control: this wiring broadcasts available_models when models_updated fires')
    })
  })
})

// ---------------------------------------------------------------------------
// #7773 / #7769 / #7794 — usage accounting on `thread/tokenUsage/updated`.
//
// THE LIVE FACT this suite rests on, probed against codex-cli 0.154.0 on
// 2026-09-12 (gpt-5.5, thread 01a09778-0c52-7c41-8d24-e4f4ff68b708, two
// one-word turns, every `thread/tokenUsage/updated` logged verbatim):
//
//   turn 1  total.totalTokens=14962  last.totalTokens=14962
//   turn 2  total.totalTokens=31920  last.totalTokens=16958   (= 14962+16958)
//
// So `total` is the thread-CUMULATIVE sum of every response's usage and `last`
// is the most recent response. Three consequences, one per issue:
//
//   #7773  NEITHER field is the turn. `total` compounds (session-manager ADDS
//          result.usage into cumulativeUsage once per turn), `last` drops every
//          response but the final one of a tool-heavy turn. The turn is
//          total_now - total_at_turn_start.
//   #7769  `_lastUsage` must be cleared per TURN, or a `turn/completed` with no
//          intervening notification re-reports — and re-accumulates — the
//          previous turn's numbers.
//   #7794  occupancy is `last.totalTokens`, NOT the `total.total_tokens` the
//          issue body specifies: metered as occupancy, `total` grows without
//          bound and can never step down after a compaction, which is the
//          failure that issue's own second acceptance criterion forbids.
// ---------------------------------------------------------------------------
describe('CodexAppServerSession — usage accounting (#7773 / #7769 / #7794)', () => {
  // Breakdown factory: every one of TokenUsageBreakdown's six fields, zero by
  // default, so a test only names the ones it is reasoning about.
  const bd = (o = {}) => ({
    totalTokens: 0, inputTokens: 0, cachedInputTokens: 0,
    cacheWriteInputTokens: 0, outputTokens: 0, reasoningOutputTokens: 0,
    ...o,
  })
  const notif = ({ total, last, modelContextWindow }) => {
    const tokenUsage = { total: bd(total), last: bd(last) }
    if (modelContextWindow !== undefined) tokenUsage.modelContextWindow = modelContextWindow
    return { threadId: 'th-1', turnId: 'tu-1', tokenUsage }
  }

  // A session that runs turns through the REAL sendMessage path, so the
  // per-turn reset (#7769) and the baseline freeze (#7773) are exercised where
  // they live instead of being poked directly.
  function mkTurnRunner(opts = {}) {
    const { s, cleanup } = mkSession({ model: 'gpt-5-codex', ...opts })
    s._processReady = true
    s._threadId = 'th-1'
    s._client = { request: async () => ({ turn: { id: 'tu-1' } }) }
    const results = capture(s, ['result'])
    return {
      s,
      results,
      send: (text = 'hi') => s.sendMessage(text),
      tokenUsage: (p) => s._onNotification({ method: 'thread/tokenUsage/updated', params: notif(p) }),
      // _finishTurn's _clearMessageState clears _isBusy, so the next send is
      // not queued — no manual flag poking.
      finish: () => s._onNotification({ method: 'turn/completed', params: { turn: { durationMs: 7 } } }),
      cleanup: () => { s.destroy(); cleanup() },
    }
  }

  it('sums a turn\'s responses instead of dropping all but the last (#7773)', async () => {
    const { results, send, tokenUsage, finish, cleanup } = mkTurnRunner()
    await send('do a tool-heavy thing')
    // Two model responses inside ONE turn, as any tool round-trip produces.
    // `total` climbs cumulatively; `last` is only ever the newest response.
    tokenUsage({ total: { inputTokens: 1000, outputTokens: 10 }, last: { inputTokens: 1000, outputTokens: 10 } })
    tokenUsage({ total: { inputTokens: 3000, outputTokens: 30 }, last: { inputTokens: 2000, outputTokens: 20 } })
    finish()
    assert.equal(results.length, 1)
    assert.equal(results[0][1].usage.input_tokens, 3000,
      'both responses of the turn are counted — reading `last` would report 2000 and silently drop the first request')
    assert.equal(results[0][1].usage.output_tokens, 30,
      'output is summed across the turn too — `last` alone would report 20')
    cleanup()
  })

  it('measures turn 2 from turn 1\'s cumulative baseline, so the total never compounds (#7773)', async () => {
    const { results, send, tokenUsage, finish, cleanup } = mkTurnRunner()
    // The live capture's own numbers.
    await send('one')
    tokenUsage({ total: { totalTokens: 14962, inputTokens: 14935, cachedInputTokens: 5504, outputTokens: 27, reasoningOutputTokens: 20 },
      last: { totalTokens: 14962, inputTokens: 14935, cachedInputTokens: 5504, outputTokens: 27, reasoningOutputTokens: 20 } })
    finish()
    await send('two')
    tokenUsage({ total: { totalTokens: 31920, inputTokens: 31872, cachedInputTokens: 20224, outputTokens: 48, reasoningOutputTokens: 34 },
      last: { totalTokens: 16958, inputTokens: 16937, cachedInputTokens: 14720, outputTokens: 21, reasoningOutputTokens: 14 } })
    finish()
    assert.equal(results.length, 2)
    // turn 2's delta: input 31872-14935=16937, cached 20224-5504=14720,
    // output 48-27=21 — which is exactly `last`, because turn 2 was a
    // single-response turn. That equality is the arithmetic PROOF that `total`
    // is the cumulative sum, and it is why a single-turn capture cannot tell
    // the two readings apart.
    assert.deepEqual(results[1][1].usage, {
      input_tokens: 16937 - 14720,
      output_tokens: 21,
      cache_read_input_tokens: 14720,
      cached_input_tokens: 14720,
    }, 'turn 2 reports only turn 2 — reporting the raw cumulative total would re-count turn 1')
    assert.notEqual(results[1][1].usage.cache_read_input_tokens, 20224,
      'control: the raw cumulative cached figure is a DIFFERENT number, so the assertion above is armed')
    cleanup()
  })

  it('clamps a cumulative total that moved BACKWARDS rather than emitting a negative (#7773)', async () => {
    const { results, send, tokenUsage, finish, cleanup } = mkTurnRunner()
    await send('one')
    tokenUsage({ total: { inputTokens: 5000, outputTokens: 50 }, last: { inputTokens: 5000, outputTokens: 50 } })
    finish()
    await send('two')
    // A resumed thread, or a future build that resets its counters after
    // compacting, can report a SMALLER total. An accumulator must never be fed
    // a negative.
    tokenUsage({ total: { inputTokens: 1000, outputTokens: 5 }, last: { inputTokens: 1000, outputTokens: 5 } })
    finish()
    assert.equal(results[1][1].usage.input_tokens, 0)
    assert.equal(results[1][1].usage.output_tokens, 0)
    cleanup()
  })

  it('a turn with NO tokenUsage notification reports null, not the previous turn\'s numbers (#7769)', async () => {
    const { results, send, tokenUsage, finish, cleanup } = mkTurnRunner()
    await send('one')
    tokenUsage({ total: { inputTokens: 1000, outputTokens: 10 }, last: { inputTokens: 1000, outputTokens: 10 } })
    finish()
    assert.equal(results[0][1].usage.input_tokens, 1000, 'precondition: turn 1 really did report usage')
    // Turn 2 completes without codex ever sending a usage update.
    await send('two')
    finish()
    assert.equal(results.length, 2)
    assert.equal(results[1][1].usage, null,
      'session-manager ADDS result.usage per turn — re-reporting turn 1 here double counts real tokens and cost')
    assert.equal(results[1][1].modelUsage, null,
      'and the per-model split must not be fabricated from stale numbers either')
    cleanup()
  })

  it('does not carry the previous turn\'s occupancy snapshot into a turn that had none (#7769/#7794)', async () => {
    const { results, send, tokenUsage, finish, cleanup } = mkTurnRunner()
    await send('one')
    tokenUsage({ total: { totalTokens: 500 }, last: { totalTokens: 500 }, modelContextWindow: 258_400 })
    finish()
    assert.ok(results[0][1].contextOccupancy, 'precondition: turn 1 emitted a snapshot')
    await send('two')
    finish()
    assert.equal('contextOccupancy' in results[1][1], false,
      'the field is OMITTED so clients keep their own last snapshot, rather than being re-told a stale one as fresh')
    cleanup()
  })

  it('emits a contextOccupancy snapshot from codex\'s own numbers (#7794)', async () => {
    const { results, send, tokenUsage, finish, cleanup } = mkTurnRunner()
    await send('one')
    tokenUsage({ total: { totalTokens: 14962 }, last: { totalTokens: 14962 }, modelContextWindow: 258_400 })
    finish()
    await send('two')
    tokenUsage({ total: { totalTokens: 31920 }, last: { totalTokens: 16958 }, modelContextWindow: 258_400 })
    finish()
    assert.deepEqual(results[1][1].contextOccupancy, { totalTokens: 16958, maxTokens: 258_400 },
      'occupancy is the last response (prompt + reply = the size the next turn starts from), never the cumulative total')
    assert.notEqual(results[1][1].contextOccupancy.totalTokens, 31920,
      'control: asserting the cumulative figure here would pin the unbounded-growth bug as correct')
    // The window must come from the live snapshot, not the roster: the same
    // probe read modelContextWindow=258400 for gpt-5.5 while
    // ~/.codex/models_cache.json said 272000.
    assert.equal(results[1][1].contextOccupancy.maxTokens, 258_400)
    cleanup()
  })

  it('the occupancy snapshot steps DOWN after a compaction (#7794 AC2)', async () => {
    const { results, send, tokenUsage, finish, cleanup } = mkTurnRunner()
    await send('one')
    tokenUsage({ total: { totalTokens: 200_000 }, last: { totalTokens: 200_000 }, modelContextWindow: 258_400 })
    finish()
    await send('two')
    // codex compacted: the cumulative total keeps climbing, the next response's
    // prompt is much smaller. Nothing here may pin the meter as monotonic.
    tokenUsage({ total: { totalTokens: 230_000 }, last: { totalTokens: 30_000 }, modelContextWindow: 258_400 })
    finish()
    assert.equal(results[0][1].contextOccupancy.totalTokens, 200_000)
    assert.equal(results[1][1].contextOccupancy.totalTokens, 30_000,
      'a post-compaction snapshot is SMALLER; sourcing it from the cumulative total would have reported 230000')
    cleanup()
  })

  it('emits no snapshot for the flat legacy shape or a zero total (#7794)', async () => {
    const { s, results, send, finish, cleanup } = mkTurnRunner()
    await send('one')
    // The pre-#7767 flat shape carries no totalTokens at all.
    s._onNotification({ method: 'thread/tokenUsage/updated', params: { usage: { inputTokens: 10, outputTokens: 2 } } })
    finish()
    assert.equal('contextOccupancy' in results[0][1], false, 'no fabricated meter from a shape that carries no occupancy')
    await send('two')
    s._onNotification({ method: 'thread/tokenUsage/updated', params: notif({ total: {}, last: {}, modelContextWindow: 258_400 }) })
    finish()
    assert.equal('contextOccupancy' in results[1][1], false, 'a zero-token snapshot is a cannot-check, not a 0% meter')
    cleanup()
  })

  it('omits maxTokens when codex reported no window, rather than sending null (#7794)', async () => {
    const { results, send, tokenUsage, finish, cleanup } = mkTurnRunner()
    await send('one')
    tokenUsage({ total: { totalTokens: 900 }, last: { totalTokens: 900 } })
    finish()
    assert.deepEqual(results[0][1].contextOccupancy, { totalTokens: 900 })
    cleanup()
  })

  it('leaves cache_creation_input_tokens unmapped ON PURPOSE (#7773)', async () => {
    const { results, send, tokenUsage, finish, cleanup } = mkTurnRunner()
    await send('one')
    // cacheWriteInputTokens is non-zero AND reasoningOutputTokens is a subset
    // of outputTokens (the live capture's arithmetic: totalTokens 14962 =
    // inputTokens 14935 + outputTokens 27, with reasoningOutputTokens 20).
    tokenUsage({
      total: { totalTokens: 1100, inputTokens: 1000, outputTokens: 100, cacheWriteInputTokens: 700, reasoningOutputTokens: 60 },
      last: { totalTokens: 1100, inputTokens: 1000, outputTokens: 100, cacheWriteInputTokens: 700, reasoningOutputTokens: 60 },
    })
    finish()
    const r = results[0][1]
    assert.equal('cache_creation_input_tokens' in r.usage, false,
      'codex cacheWriteInputTokens is plausibly another SUBSET of inputTokens; mapping it additively would double count')
    assert.equal(r.modelUsage['gpt-5-codex'].cache_creation_input_tokens, 0,
      'so it stays 0 downstream — deliberately, and this test is why it is not just an omission nobody noticed')
    assert.equal(r.usage.output_tokens, 100,
      'reasoningOutputTokens is inside outputTokens already — adding it would double count reasoning')
    cleanup()
  })

  it('forwards the codex snapshot onto the wire as contextOccupancy (#7794)', async () => {
    const { s, send, tokenUsage, finish, cleanup } = mkTurnRunner()
    const normalizer = new EventNormalizer({ flushIntervalMs: 10 })
    const ctx = {
      sessionId: 'sess-1',
      mode: 'multi',
      getSessionEntry: () => ({ session: { model: 'gpt-5-codex', permissionMode: 'approve' }, name: 'Codex', cwd: '/tmp' }),
    }
    const frames = []
    // The same hop session-manager uses to forward a session result.
    s.on('result', (data) => frames.push(...normalizer.normalize('result', data, ctx).messages))
    await send('one')
    tokenUsage({ total: { totalTokens: 16958 }, last: { totalTokens: 16958 }, modelContextWindow: 258_400 })
    finish()
    const resultMsg = frames.find((m) => m.msg.type === 'result')
    assert.ok(resultMsg, 'precondition: the result reached the normalizer')
    assert.deepEqual(resultMsg.msg.contextOccupancy, { totalTokens: 16958, maxTokens: 258_400 },
      'the snapshot has to survive the normalizer hop, or the meter still never renders')
    normalizer.destroy?.()
    cleanup()
  })
})
