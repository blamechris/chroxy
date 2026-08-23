import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'fs'
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
function mkSession(extraOpts = {}, entryOverrides = {}) {
  const sk = mkdtempSync(join(tmpdir(), 'chroxy-acp-'))
  const Klass = mkAcpSessionClass(entryOverrides)
  const s = new Klass({ cwd: tmpdir(), skillsDir: sk, repoSkillsDir: null, ...extraOpts })
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
