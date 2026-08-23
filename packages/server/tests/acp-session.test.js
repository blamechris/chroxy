import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { createAcpSessionClass, registerAcpProviders } from '../src/acp-session.js'
import { validateAcpProviders } from '../src/acp-config.js'
import { getProvider, listProviders, getRegisteredProviderNames } from '../src/providers.js'

// #7319 — the config-driven ACP provider. These tests drive a REAL spawned
// child process running the scripted fake-acp-agent.js fixture over stdio —
// never a live third-party agent — so the persistent-connection shape
// (one child, many turns) and the deny-all permission guard are proven
// against the actual `@agentclientprotocol/sdk` wire behaviour, not a mock.

const __dirname = dirname(fileURLToPath(import.meta.url))
const FIXTURE = join(__dirname, 'fixtures', 'fake-acp-agent.js')

let uniqueCounter = 0
function uniqueId(prefix) {
  return `${prefix}-${Date.now()}-${uniqueCounter++}`
}

function mkAcpSessionClass(entryOverrides = {}) {
  return createAcpSessionClass({
    id: uniqueId('fake-acp'),
    label: 'Fake ACP Agent',
    command: process.execPath,
    args: [FIXTURE],
    env: {},
    ...entryOverrides,
  })
}

// #4633 — every test constructing session state points stateFilePath-adjacent
// scratch (skillsDir here) at a temp dir; AcpSession itself never touches
// SessionManager/session-state.json, but BaseSession's constructor loads
// skills synchronously and a real skillsDir keeps that off the developer's
// actual ~/.claude tree.
//
// #7319 review finding #9 — default a SHORT resultTimeoutMs (BaseSession's
// own default is 30 MINUTES). A regression that drops the session/cancel
// notify, or otherwise wedges a turn, must fail this suite in seconds via
// the soft result timeout, not hang CI for half an hour before the runner's
// own job timeout eventually kills it. `extraOpts` can still override it.
function mkSession(extraOpts = {}, entryOverrides = {}) {
  const sk = mkdtempSync(join(tmpdir(), 'chroxy-acp-'))
  const Klass = mkAcpSessionClass(entryOverrides)
  const s = new Klass({ cwd: tmpdir(), skillsDir: sk, repoSkillsDir: null, resultTimeoutMs: 5000, ...extraOpts })
  return { s, cleanup: () => rmSync(sk, { recursive: true, force: true }) }
}

function capture(s, events) {
  const out = []
  events.forEach((e) => s.on(e, (p) => out.push([e, p])))
  return out
}

function waitFor(s, event) {
  return new Promise((resolve) => s.once(event, resolve))
}

describe('acp-config validation', () => {
  it('accepts a valid entry and normalizes defaults', () => {
    const { entries, warnings } = validateAcpProviders([{ id: 'my-agent', command: '/usr/bin/my-agent' }])
    assert.deepEqual(warnings, [])
    assert.equal(entries.length, 1)
    assert.deepEqual({ ...entries[0] }, { id: 'my-agent', label: 'my-agent', command: '/usr/bin/my-agent', args: [], env: {} })
  })

  it('rejects an entry with no command', () => {
    const { entries, warnings } = validateAcpProviders([{ id: 'my-agent' }])
    assert.equal(entries.length, 0)
    assert.match(warnings.join('\n'), /command/)
  })

  it('rejects an id colliding with a built-in/reserved provider', () => {
    const { entries, warnings } = validateAcpProviders([{ id: 'codex', command: '/bin/x' }])
    assert.equal(entries.length, 0)
    assert.match(warnings.join('\n'), /collides/)
  })

  it('rejects an id colliding with a LIVE registered provider (reservedIds opt)', () => {
    const { entries, warnings } = validateAcpProviders([{ id: 'zai-glm', command: '/bin/x' }], { reservedIds: ['zai-glm'] })
    assert.equal(entries.length, 0)
    assert.match(warnings.join('\n'), /collides/)
  })

  it('rejects a duplicate id within the same block, keeping the first', () => {
    const { entries, warnings } = validateAcpProviders([
      { id: 'dup', command: '/bin/a' },
      { id: 'dup', command: '/bin/b' },
    ])
    assert.equal(entries.length, 1)
    assert.equal(entries[0].command, '/bin/a')
    assert.match(warnings.join('\n'), /duplicate id/)
  })

  it('rejects non-string args entries and non-string env values', () => {
    const { entries: e1, warnings: w1 } = validateAcpProviders([{ id: 'a', command: '/bin/a', args: [1, 2] }])
    assert.equal(e1.length, 0)
    assert.match(w1.join('\n'), /\.args'/)

    const { entries: e2, warnings: w2 } = validateAcpProviders([{ id: 'b', command: '/bin/b', env: { X: 1 } }])
    assert.equal(e2.length, 0)
    assert.match(w2.join('\n'), /\.env\.X'/)
  })

  it('drops invalid entries but keeps valid siblings', () => {
    const { entries, warnings } = validateAcpProviders([
      { id: 'bad id with spaces' },
      { id: 'good-one', command: '/bin/good' },
    ])
    assert.equal(entries.length, 1)
    assert.equal(entries[0].id, 'good-one')
    assert.ok(warnings.length > 0)
  })

  it('rejects a non-array providers.acp value', () => {
    const { entries, warnings } = validateAcpProviders({ not: 'an array' })
    assert.equal(entries.length, 0)
    assert.match(warnings.join('\n'), /expected an array/)
  })
})

describe('registerAcpProviders', () => {
  it('is a no-op with no providers.acp block', () => {
    assert.deepEqual(registerAcpProviders({}), [])
    assert.deepEqual(registerAcpProviders({ providers: {} }), [])
    assert.deepEqual(registerAcpProviders(null), [])
    assert.deepEqual(registerAcpProviders(undefined), [])
  })

  it('registers a configured agent, which then appears in listProviders() with deny-all capabilities', () => {
    const id = uniqueId('fake-acp-reg')
    const registered = registerAcpProviders({
      providers: { acp: [{ id, command: process.execPath, args: [FIXTURE] }] },
    })
    assert.deepEqual(registered, [id])
    assert.ok(getRegisteredProviderNames().includes(id))

    const listed = listProviders().find((p) => p.name === id)
    assert.ok(listed, 'registered id should appear in listProviders()')
    assert.equal(listed.capabilities.inProcessPermissions, false)
    assert.equal(listed.capabilities.permissions, false)

    const ProviderClass = getProvider(id)
    assert.equal(ProviderClass.acpEntry.command, process.execPath)
    assert.deepEqual([...ProviderClass.acpEntry.args], [FIXTURE])
  })

  it('skips an entry colliding with an already-registered provider id and still registers valid siblings', () => {
    const first = uniqueId('fake-acp-collide')
    const second = `${first}-b`
    registerAcpProviders({ providers: { acp: [{ id: first, command: process.execPath, args: [FIXTURE] }] } })
    const registered = registerAcpProviders({
      providers: {
        acp: [
          { id: first, command: process.execPath, args: [FIXTURE] }, // collides with the already-registered id above
          { id: second, command: process.execPath, args: [FIXTURE] },
        ],
      },
    })
    assert.deepEqual(registered, [second])
  })
})

describe('AcpSession — real fixture round trip', () => {
  it('full round trip: prompt -> streamed text + thinking -> tool_call/tool_call_update -> result (end_turn)', async () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['stream_start', 'stream_delta', 'stream_end', 'tool_start', 'tool_result', 'result', 'error', 'stopped'])
    await s.start()
    const resultP = waitFor(s, 'result')
    await s.sendMessage('WITH_TOOL', [])
    const result = await resultP
    await s.destroy()
    cleanup()

    const kinds = ev.map(([e]) => e)
    assert.equal(kinds.filter((k) => k === 'error').length, 0)
    assert.equal(kinds.filter((k) => k === 'stopped').length, 0)
    assert.equal(kinds.filter((k) => k === 'tool_start').length, 1)
    assert.equal(kinds.filter((k) => k === 'tool_result').length, 1, 'no synthetic orphan tool_result')
    assert.equal(kinds.filter((k) => k === 'result').length, 1)

    const toolStart = ev.find(([e]) => e === 'tool_start')[1]
    assert.equal(toolStart.toolUseId, 'tc-1')
    assert.equal(toolStart.tool, 'read')

    const toolResult = ev.find(([e]) => e === 'tool_result')[1]
    assert.equal(toolResult.toolUseId, 'tc-1')
    assert.equal(toolResult.result, 'file contents')
    assert.equal(toolResult.isError, false)

    const thinkingStart = ev.find(([e, p]) => e === 'stream_start' && p.thinking === true)
    assert.ok(thinkingStart, 'expected a thinking stream_start')
    const thinkingDelta = ev.find(([e, p]) => e === 'stream_delta' && p.thinking === true)
    assert.equal(thinkingDelta[1].delta, 'thinking it through')
    assert.ok(
      ev.some(([e, p]) => e === 'stream_end' && p.messageId === thinkingStart[1].messageId),
      'the thinking stream must be closed at turn end',
    )

    const textStart = ev.find(([e, p]) => e === 'stream_start' && !p.thinking)
    assert.ok(textStart)
    const textDelta = ev.find(([e, p]) => e === 'stream_delta' && !p.thinking)
    assert.equal(textDelta[1].delta, 'Done.')
    assert.ok(
      ev.some(([e, p]) => e === 'stream_end' && p.messageId === textStart[1].messageId),
      'the text stream must be closed at turn end',
    )

    assert.equal(result.sessionId, 'fake-acp-session-1')
  })

  it('interrupt() sends session/cancel and the child stays alive — the SAME pid answers the next prompt', async () => {
    const { s, cleanup } = mkSession()
    await s.start()
    const pid = s._child.pid
    assert.ok(Number.isInteger(pid) && pid > 0)

    const stoppedOrErrorP = new Promise((resolve) => {
      s.once('stopped', (p) => resolve(['stopped', p]))
      s.once('error', (p) => resolve(['error', p]))
    })

    const sendP = s.sendMessage('HANG_UNTIL_CANCEL', [])
    // Deterministic sync point: wait for the fixture's own "I'm about to
    // hang" signal (routed through the REAL stream_delta translation path)
    // rather than guessing a timing window between two independent client
    // calls (sendMessage's request write vs interrupt's notify write).
    await new Promise((resolve) => {
      const onDelta = (p) => {
        if (p.delta === 'WAITING') { s.off('stream_delta', onDelta); resolve() }
      }
      s.on('stream_delta', onDelta)
    })

    await s.interrupt()
    await sendP
    const [kind] = await stoppedOrErrorP
    assert.equal(kind, 'stopped', 'a user-initiated interrupt must report `stopped`, not `error`')
    assert.equal(s._child.pid, pid, 'the SAME child must still be alive after interrupt')
    assert.equal(s.isRunning, false)

    // Second turn on the SAME persistent connection/child — the point of
    // the whole architecture: one child process, many turns.
    const resultP = waitFor(s, 'result')
    await s.sendMessage('hi again', [])
    const result = await resultP
    assert.equal(s._child.pid, pid, 'pid must be unchanged across two turns')
    assert.equal(result.sessionId, 'fake-acp-session-1')

    await s.destroy()
    cleanup()
  })

  it('session/request_permission is answered with a denial by default', async () => {
    const { s, cleanup } = mkSession()
    const deltas = []
    s.on('stream_delta', (p) => { if (!p.thinking) deltas.push(p.delta) })
    await s.start()
    const resultP = waitFor(s, 'result')
    await s.sendMessage('WITH_PERMISSION', [])
    await resultP
    await s.destroy()
    cleanup()
    assert.equal(deltas.join(''), 'PERMISSION_RESULT:reject-once')
  })

  // Repo convention (docs/false-safety-guards.md): a guard that always
  // passes regardless of what it's checking is not a guard. This proves the
  // denial assertion above is a REAL check — bypass the production deny-all
  // handler with an ALLOW test double, confirm the agent's echoed decision
  // flips to the allowed option, then re-run the SAME assertion the real
  // test uses and confirm it throws against the bypassed outcome instead of
  // silently passing either way.
  it('proves the denial assertion actually catches a bypass (adversarial self-test)', async () => {
    const { s, cleanup } = mkSession()
    s._denyAllPermission = async (ctx) => {
      const allow = ctx.params.options.find((o) => o.kind === 'allow_once')
      return { outcome: { outcome: 'selected', optionId: allow.optionId } }
    }
    const deltas = []
    s.on('stream_delta', (p) => { if (!p.thinking) deltas.push(p.delta) })
    await s.start()
    const resultP = waitFor(s, 'result')
    await s.sendMessage('WITH_PERMISSION', [])
    await resultP
    await s.destroy()
    cleanup()

    const bypassedText = deltas.join('')
    assert.equal(bypassedText, 'PERMISSION_RESULT:allow-once')

    assert.throws(
      () => assert.equal(bypassedText, 'PERMISSION_RESULT:reject-once'),
      /PERMISSION_RESULT:reject-once/,
      'the denial assertion must fail (go red) when the deny-all handler is bypassed — a guard that cannot fail is not a guard',
    )
  })

  it('refuses to send when attachments are present (not yet supported)', async () => {
    const { s, cleanup } = mkSession()
    await s.start()
    const errorP = waitFor(s, 'error')
    await s.sendMessage('hi', [{ type: 'file_ref', path: 'a.png' }])
    const err = await errorP
    assert.match(err.message, /does not support attachments/)
    await s.destroy()
    cleanup()
  })
})

// #7319 review finding #2 — verified repro: after a normal turn ->
// interrupt() -> follow-up turn emits ["stopped"] with no `result` event at
// all, because interrupt() armed markIntentionalStop() unconditionally (no
// active turn to consume it) and the NEXT turn's _finishTurn read the stale
// flag. input-handlers.js calls interrupt() with no busy guard, so a Stop tap
// racing a turn's natural end hits this in production.
describe('AcpSession — interrupt() outside an active turn (#7319 review finding #2)', () => {
  it('interrupt() with no active turn does not corrupt the NEXT turn', async () => {
    const { s, cleanup } = mkSession()
    await s.start()

    // Turn 1: completes normally.
    const result1P = waitFor(s, 'result')
    await s.sendMessage('hi', [])
    await result1P

    // Stop tapped AFTER the turn already ended — nothing active to interrupt.
    await s.interrupt()

    // Turn 2 must ALSO complete as a normal `result` — not `stopped`, and
    // not silently swallowed with no event at all.
    const ev = capture(s, ['result', 'stopped', 'error'])
    const result2P = waitFor(s, 'result')
    await s.sendMessage('hi again', [])
    await result2P
    await s.destroy()
    cleanup()

    assert.deepEqual(
      ev.map(([e]) => e),
      ['result'],
      'the second turn must report a clean result — a post-turn interrupt() must not leak into it as `stopped`',
    )
  })

  it('interrupt() with no active turn does not send session/cancel (nothing to cancel)', async () => {
    const { s, cleanup } = mkSession()
    await s.start()
    // No sendMessage() at all — start() alone leaves no active turn.
    await s.interrupt() // must be a clean no-op, not throw, not hang
    const resultP = waitFor(s, 'result')
    await s.sendMessage('hi', [])
    const result = await resultP
    assert.equal(result.sessionId, 'fake-acp-session-1')
    await s.destroy()
    cleanup()
  })
})

// #7319 review finding #6 — ToolCall.status is OPTIONAL and schema-legal to
// already be terminal on the FIRST message about a call; ToolCallUpdate's
// fields are all optional except toolCallId, so a terminal tick may omit
// `content` when it didn't change since an earlier one. Both shapes are
// legal even though the SDK's own example agent always uses the two-message
// open-then-update flow the original implementation silently assumed.
describe('AcpSession — tool_call schema-legal shapes (#7319 review finding #6)', () => {
  it('a tool_call that arrives ALREADY terminal yields a successful tool_result, not a synthetic failure', async () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['tool_start', 'tool_result'])
    await s.start()
    const resultP = waitFor(s, 'result')
    await s.sendMessage('WITH_TOOL_IMMEDIATE_COMPLETE', [])
    await resultP
    await s.destroy()
    cleanup()

    const kinds = ev.map(([e]) => e)
    assert.equal(kinds.filter((k) => k === 'tool_start').length, 1)
    assert.equal(kinds.filter((k) => k === 'tool_result').length, 1, 'no synthetic orphan tool_result on top of the real one')

    const toolResult = ev.find(([e]) => e === 'tool_result')[1]
    assert.equal(toolResult.toolUseId, 'tc-immediate')
    assert.equal(toolResult.result, 'instant result')
    assert.equal(toolResult.isError, false)
    assert.equal(toolResult.synthetic, undefined, 'must not be BaseSession\'s orphan-sweep synthetic failure')
  })

  it('a bare terminal tool_call_update (no content) does not blank out content received on an earlier in-progress tick', async () => {
    const { s, cleanup } = mkSession()
    const ev = capture(s, ['tool_start', 'tool_result'])
    await s.start()
    const resultP = waitFor(s, 'result')
    await s.sendMessage('WITH_TOOL_BARE_COMPLETE', [])
    await resultP
    await s.destroy()
    cleanup()

    const toolResult = ev.find(([e]) => e === 'tool_result')[1]
    assert.equal(toolResult.toolUseId, 'tc-bare')
    assert.equal(
      toolResult.result,
      'partial output',
      'content from the EARLIER in-progress tick must survive a later contentless terminal update',
    )
    assert.equal(toolResult.isError, false)
  })
})

// #7319 review finding #5 — spawn-env.js's own header comment states the
// rule this file previously got backwards: allowlist mode is for
// THIRD-PARTY providers (so operator secrets never reach them); denylist is
// for the first-party Claude CLI only. Verified reaching the child under the
// old denylist posture: ANTHROPIC_API_KEY, GITHUB_TOKEN,
// AWS_SECRET_ACCESS_KEY, CHROXY_HOOK_SECRET.
describe('AcpSession — child env posture is ALLOWLIST, not denylist (#7319 review finding #5)', () => {
  it('an ambient secret NOT on STANDARD_ALLOWLIST never reaches the child', async () => {
    const secretName = `ACP_TEST_FAKE_SECRET_${uniqueId('X').replace(/[^A-Z0-9]/gi, '_').toUpperCase()}`
    process.env[secretName] = 'super-secret-ambient-value'
    const { s, cleanup } = mkSession()
    try {
      await s.start()
      const deltas = []
      s.on('stream_delta', (p) => deltas.push(p.delta))
      const resultP = waitFor(s, 'result')
      await s.sendMessage(`REPORT_ENV:${secretName}`, [])
      await resultP
      assert.equal(deltas.join(''), `ENV:${secretName}=(unset)`)
    } finally {
      delete process.env[secretName]
      await s.destroy()
      cleanup()
    }
  })

  it('a STANDARD_ALLOWLIST var (PATH) DOES reach the child — the baseline every CLI tool needs', async () => {
    const { s, cleanup } = mkSession()
    await s.start()
    const deltas = []
    s.on('stream_delta', (p) => deltas.push(p.delta))
    const resultP = waitFor(s, 'result')
    await s.sendMessage('REPORT_ENV:PATH', [])
    await resultP
    await s.destroy()
    cleanup()
    assert.notEqual(deltas.join(''), 'ENV:PATH=(unset)')
  })

  it("Chroxy's own daemon secret (API_TOKEN) is stripped even when the OPERATOR configures it in providers.acp[].env", async () => {
    // #7319 review — the second half of finding #5: configuredEnv used to be
    // spread AFTER the strip, so an operator's OWN config entry could
    // resurrect the one secret the strip exists to guarantee never leaks.
    process.env.API_TOKEN = 'ambient-primary-token'
    const { s, cleanup } = mkSession({}, { env: { API_TOKEN: 'operator-configured-token' } })
    try {
      await s.start()
      const deltas = []
      s.on('stream_delta', (p) => deltas.push(p.delta))
      const resultP = waitFor(s, 'result')
      await s.sendMessage('REPORT_ENV:API_TOKEN', [])
      await resultP
      assert.equal(deltas.join(''), 'ENV:API_TOKEN=(unset)')
    } finally {
      delete process.env.API_TOKEN
      await s.destroy()
      cleanup()
    }
  })
})

// #7319 review finding #7 — ACP has no system-prompt channel, so the
// first-turn user message is the ONLY vehicle for the session preamble and
// any loaded skill. Verified: a loaded preamble and an always-apply skill
// never reached the agent before this fix.
describe('AcpSession — first-turn prefix carries the preamble + skills (#7319 review finding #7)', () => {
  it('the session preamble and a loaded skill both reach the agent on the first turn', async () => {
    const sk = mkdtempSync(join(tmpdir(), 'chroxy-acp-skill-'))
    writeFileSync(join(sk, 'safety.md'), '---\nname: safety\ninjection: prepend\n---\nALWAYS_APPLY_SKILL_MARKER\n')
    const Klass = mkAcpSessionClass()
    const s = new Klass({
      cwd: tmpdir(),
      skillsDir: sk,
      repoSkillsDir: null,
      resultTimeoutMs: 5000,
      sessionPreamble: 'SAFETY_INSTRUCTION_XYZ',
    })
    try {
      await s.start()
      const deltas = []
      s.on('stream_delta', (p) => { if (!p.thinking) deltas.push(p.delta) })
      const resultP = waitFor(s, 'result')
      await s.sendMessage('CHECK_PREFIX', [])
      await resultP
      const raw = deltas.join('')
      assert.match(raw, /SAFETY_INSTRUCTION_XYZ/, 'the session preamble must reach the agent')
      assert.match(raw, /ALWAYS_APPLY_SKILL_MARKER/, 'the loaded skill must reach the agent')
      assert.match(raw, /CHECK_PREFIX/, 'the original prompt text must still be present')
    } finally {
      await s.destroy()
      rmSync(sk, { recursive: true, force: true })
    }
  })
})

// #7319 review finding #8 — the ACP schema says the client SHOULD disconnect
// if the agent negotiates a protocol version it doesn't support. Pinning
// what we OFFER (v1) isn't the same as enforcing what we actually GOT back.
describe('AcpSession — negotiated protocol version is enforced (#7319 review finding #8)', () => {
  it('start() rejects an agent that negotiates an unsupported protocol version', async () => {
    const { s, cleanup } = mkSession({}, { env: { ACP_FIXTURE_PROTOCOL_VERSION: '2' } })
    // start()'s failure path proactively kills the never-fully-initialized
    // child; production always has a listener wired before start() runs
    // (session-manager.js calls _wireSessionEvents BEFORE session.start()),
    // so mirror that here and wait for the resulting teardown `error` to
    // settle — otherwise the killed child's async `exit` fires with no
    // listener attached (EventEmitter's special-cased throw on an
    // unlistened 'error') and leaks past this test's own boundary.
    const errorP = waitFor(s, 'error')
    await assert.rejects(s.start(), /protocol version/)
    await errorP
    cleanup()
  })
})

// #7319 review finding #3 — killProcessTree() is a bare SIGTERM request on
// POSIX; nothing guarantees the operator-chosen, unvetted agent binary
// honors it. Verified: an agent with a no-op SIGTERM handler was still alive
// 4.2s after destroy() with the pre-fix code.
describe('AcpSession — destroy() escalates to SIGKILL (#7319 review finding #3)', () => {
  // POSIX-only premise: the assertion is that destroy() actually WAITS OUT
  // the ~1s grace window before escalating to SIGKILL, which only means
  // anything for a child that can ignore SIGTERM in the first place. Windows
  // has no SIGTERM for a child to ignore — child.kill()/killProcessTree()
  // map to TerminateProcess there, which kills the process immediately
  // regardless of any handler the child installed — so the grace window
  // never elapses and the elapsed-time assertion is unsatisfiable by
  // construction, not because the implementation is wrong on that platform.
  // Skip is CONDITIONAL (win32 only): on every other platform this still
  // runs and can still fail — see the cross-platform test below for the
  // platform-independent postcondition ("destroy() actually kills the
  // child"), which DOES run on Windows.
  it('destroy() kills a child that ignores SIGTERM within the grace window', {
    skip: process.platform === 'win32'
      ? 'POSIX-only premise: Windows has no SIGTERM for a child to ignore — kill() maps to TerminateProcess and terminates immediately, so there is no grace window to wait out'
      : false,
  }, async () => {
    const { s, cleanup } = mkSession({}, { env: { ACP_FIXTURE_IGNORE_SIGTERM: '1' } })
    await s.start()
    const pid = s._child.pid
    const startedAt = Date.now()
    await s.destroy()
    const elapsedMs = Date.now() - startedAt
    cleanup()

    // A brief settle window for the OS to finish reaping before the probe.
    await new Promise((resolve) => setTimeout(resolve, 50))
    let stillAlive = true
    try { process.kill(pid, 0); } catch { stillAlive = false }
    assert.equal(stillAlive, false, 'the child must be gone after destroy() resolves, even though it ignored SIGTERM')
    assert.ok(
      elapsedMs >= 800,
      `expected destroy() to wait out most of the ~1s SIGKILL grace window before the child died, took only ${elapsedMs}ms`,
    )
  })

  // Platform-independent companion: makes no assumption about WHICH
  // mechanism terminates the child (SIGTERM honored, SIGKILL escalation, or
  // Windows' TerminateProcess) — only that destroy() leaves it dead. Runs
  // (and is verifiable) on every platform, including this repo's dev
  // machines, unlike the win32-only branch of the test above.
  it('destroy() terminates the child (platform-independent postcondition)', async () => {
    const { s, cleanup } = mkSession()
    await s.start()
    const pid = s._child.pid
    await s.destroy()
    cleanup()

    await new Promise((resolve) => setTimeout(resolve, 50))
    let stillAlive = true
    try { process.kill(pid, 0); } catch { stillAlive = false }
    assert.equal(stillAlive, false, 'the child must be gone after destroy() resolves')
  })
})

// #7319 review finding #10 — a dying child previously emitted the generic
// "connection closed" message FIRST and the informative "exited unexpectedly
// (code=N)" message SECOND (the latter marked recoverable:true) — two error
// events for one failure, with the less useful one arriving first.
describe('AcpSession — exactly one teardown report per failure (#7319 review finding #10)', () => {
  it('an unexpected child death reports exactly ONE error event, and it is the informative one', async () => {
    const { s, cleanup } = mkSession()
    await s.start()
    const ev = capture(s, ['error'])
    s._child.kill('SIGKILL')
    // Past CONNECTION_CLOSED_GRACE_MS so a (correctly suppressed) second
    // report would have had its chance to fire before we assert.
    await new Promise((resolve) => setTimeout(resolve, 400))
    await s.destroy()
    cleanup()

    assert.equal(
      ev.length,
      1,
      `expected exactly one error event, got ${ev.length}: ${JSON.stringify(ev.map(([, p]) => p.message))}`,
    )
    assert.match(ev[0][1].message, /exited unexpectedly/, 'the informative exit-code message must win, not the generic one')
  })
})
