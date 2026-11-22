import { describe, it, mock, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

/**
 * #9242 — a scheduled prompt's admission is re-asked AFTER a provider's asynchronous
 * preparation, before anything irreversible. A person taking the session over during
 * the await must leave the scheduled prompt undispatched.
 *
 * REAL SdkSession (its project-settings verification held open by replacing the one
 * module that decides it, as stop-before-reply-sdk-preflight.test.js does) and REAL
 * ClaudeByokSession (the MCP prompt expansion held open on the instance seam).
 */

const realSources = await import('../src/claude-setting-sources.js')
const gate = { promise: null }
mock.module('../src/claude-setting-sources.js', {
  namedExports: {
    ...realSources,
    projectSettingsDecidedWithoutScan: () => null,
    projectSettingsAllowedAsync: () => gate.promise,
  },
})
const { SdkSession } = await import('../src/sdk-session.js')
const { ClaudeByokSession } = await import('../src/byok-session.js')
const { TurnDriver, TurnError } = await import('../src/orchestration/turn-driver.js')

const tmp = mkdtempSync(join(tmpdir(), 'adm-prep-'))
after(() => rmSync(tmp, { recursive: true, force: true }))
const stateFile = () => join(tmp, `state-${Math.random().toString(36).slice(2)}.json`)
const deferred = () => { let resolve; const promise = new Promise((r) => { resolve = r }); return { promise, resolve } }

const initMsg = { type: 'system', subtype: 'init', session_id: 'sdk-1', model: 'claude-x', tools: [] }
const resultMsg = { type: 'result', subtype: 'success', session_id: 'sdk-1', is_error: false, duration_ms: 5, num_turns: 1, total_cost_usd: 0, usage: {} }

function sdkSession() {
  const session = new SdkSession({ cwd: '/tmp', stateFilePath: stateFile() })
  session._fetchSupportedModels = () => {}
  const queries = []
  session._callQuery = (args) => {
    queries.push(args)
    const q = (async function* () { yield initMsg; yield resultMsg })()
    q.close = () => {}
    q.interrupt = async () => {}
    return q
  }
  return { session, queries }
}

describe('SDK: admission is re-asked after the project-settings verification (#9242)', () => {
  it('a takeover during the verification: no query, busy released, refusal reported, queued follow-up still runs', async () => {
    const { session, queries } = sdkSession()
    gate.promise = deferred()
    const g = gate.promise
    gate.promise = g.promise
    let owned = true
    const admissions = []
    const turn = session.sendMessage('scheduled', [], { admitAtFlush: () => owned, onInputAdmission: (a) => admissions.push(a) })
    assert.ok(session._pendingDecision, 'premise: inside the verification window')
    owned = false // the person takes over meanwhile
    const followUps = []
    session.sendMessage('person', [], { onInputAdmission: (a) => followUps.push(a) }) // queues: busy
    g.resolve(true)
    await turn
    assert.equal(admissions.at(-1)?.reason, 'not_admitted')
    await new Promise((r) => setTimeout(r, 30))
    assert.equal(queries.filter((q) => JSON.stringify(q).includes('scheduled')).length, 0, 'the scheduled prompt never reached query()')
    assert.equal(queries.length, 1, 'the person\'s queued follow-up ran instead')
    session.destroy()
  })

  it('control: still admitted → dispatched as before', async () => {
    const { session, queries } = sdkSession()
    const g = deferred(); gate.promise = g.promise
    const turn = session.sendMessage('scheduled', [], { admitAtFlush: () => true })
    g.resolve(true)
    await turn
    assert.equal(queries.length, 1)
    session.destroy()
  })

  it('a caller with no predicate is unchanged', async () => {
    const { session, queries } = sdkSession()
    const g = deferred(); gate.promise = g.promise
    const turn = session.sendMessage('plain')
    g.resolve(true)
    await turn
    assert.equal(queries.length, 1)
    session.destroy()
  })

  it('through the real TurnDriver: the turn rejects NOT_ADMITTED and nothing is dispatched', async () => {
    const { session, queries } = sdkSession()
    const sm = new EventEmitter()
    sm.getSession = () => ({ session })
    for (const ev of ['result', 'error', 'stopped']) session.on(ev, (data) => sm.emit('session_event', { sessionId: 's1', event: ev, data }))
    const driver = new TurnDriver({ sessionManager: sm })
    const g = deferred(); gate.promise = g.promise
    let owned = true
    const p = driver.driveTurn('s1', 'scheduled', { admit: () => owned })
    owned = false
    g.resolve(true)
    await assert.rejects(p, (e) => e instanceof TurnError && e.code === 'NOT_ADMITTED')
    assert.equal(queries.length, 0)
    driver.dispose()
    session.destroy()
  })
})

describe('BYOK: admission is re-asked after the MCP prompt expansion (#9242)', () => {
  let tmpHome, originalKey
  beforeEach(() => {
    tmpHome = mkdtempSync(join(tmpdir(), 'adm-byok-'))
    originalKey = process.env.ANTHROPIC_API_KEY
    process.env.ANTHROPIC_API_KEY = 'sk-ant-test-key-fixture'
  })
  afterEach(() => {
    if (originalKey) process.env.ANTHROPIC_API_KEY = originalKey
    else delete process.env.ANTHROPIC_API_KEY
    rmSync(tmpHome, { recursive: true, force: true })
  })

  function byok() {
    const session = new ClaudeByokSession({ cwd: tmpHome })
    const streams = []
    session._client = {
      messages: {
        stream: ({ messages }) => {
          streams.push(messages.map((m) => ({ ...m })))
          return {
            async *[Symbol.asyncIterator]() { yield { type: 'message_delta', delta: { stop_reason: 'end_turn' } } },
            async finalMessage() { return { stop_reason: 'end_turn', content: [{ type: 'text', text: 'ok' }], usage: { input_tokens: 1, output_tokens: 1 } } },
          }
        },
      },
    }
    session._processReady = true
    const expansion = deferred()
    session._matchMcpPromptCommand = () => ({ prefixedName: 'mcp__stub__p' })
    session._resolveMcpPromptToText = () => expansion.promise
    return { session, streams, expansion }
  }

  it('a takeover during the expansion: no history entry, no stream, busy released, refusal reported', async () => {
    const { session, streams, expansion } = byok()
    let owned = true
    const admissions = []
    const turn = session.sendMessage('/mcp__stub__p x', [], { admitAtFlush: () => owned, onInputAdmission: (a) => admissions.push(a) })
    assert.equal(session.isRunning, true, 'premise: inside the expansion await')
    owned = false
    expansion.resolve('EXPANDED')
    await turn
    assert.equal(admissions.at(-1)?.reason, 'not_admitted')
    assert.equal(streams.length, 0, 'nothing reached messages.stream')
    assert.equal(session._history.length, 0, 'no history entry')
    assert.equal(session.isRunning, false)
  })

  it('control: still admitted → expanded and streamed as before', async () => {
    const { session, streams, expansion } = byok()
    const turn = session.sendMessage('/mcp__stub__p x', [], { admitAtFlush: () => true })
    expansion.resolve('EXPANDED')
    await turn
    assert.equal(streams.length, 1)
    assert.equal(streams[0].at(-1).content, 'EXPANDED')
  })

  it('a caller with no predicate is unchanged', async () => {
    const { session, streams, expansion } = byok()
    const turn = session.sendMessage('/mcp__stub__p x')
    expansion.resolve('EXPANDED')
    await turn
    assert.equal(streams.length, 1)
  })
})
