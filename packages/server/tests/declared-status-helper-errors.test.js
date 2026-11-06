import { test } from 'node:test'
import { EventEmitter } from 'node:events'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { SessionManager } from '../src/session-manager.js'
import { SdkSession } from '../src/sdk-session.js'

const footer = (decision = 'none') => `**Status:**\n- ✅ Verified\n- 🔄 none\n- ⛔ none\n- 🔶 DECISION: ${decision}\n\n**Next:** ⚪ IDLE — Completed check`
const text = (value) => ({ type: 'assistant', message: { content: [{ type: 'text', text: value }] } })
const result = (cost) => ({ type: 'result', subtype: 'success', num_turns: 1, total_cost_usd: cost, duration_ms: 1, usage: {} })
function deferred() {
  let resolve
  const promise = new Promise((r) => { resolve = r })
  return { promise, resolve }
}
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'declared-helper-error-'))
  const stateFilePath = join(dir, 'state.json')
  const session = new SdkSession({ cwd: dir, skillsDir: dir, repoSkillsDir: null })
  session._processReady = true
  session._fetchSupportedModels = () => {}
  const manager = new SessionManager({ skipPreflight: true, stateFilePath })
  manager._sessions.set('s', { session, name: 'Helper error', cwd: dir, provider: 'claude-sdk', createdAt: Date.now() })
  manager._wireSessionEvents('s', session)
  manager.setDeclaredStatus('s', { state: 'blocked', summary: 'Keep', decision: 'Keep' })
  const errors = []
  session.on('error', (data) => errors.push(data))
  return {
    session, manager, errors,
    entry: () => manager.getSession('s'),
    saved: () => JSON.parse(readFileSync(stateFilePath, 'utf8')).sessions[0],
    close() { manager.destroyAll(); rmSync(dir, { recursive: true, force: true }) },
  }
}
function oversizedAssistant(session) {
  return {
    type: 'assistant',
    message: { content: [
      { type: 'text', text: footer() },
      { type: 'tool_use', id: 'oversize', name: 'Read', input: { value: 'x'.repeat(session._maxToolInput + 1) } },
    ] },
  }
}

test('current SDK oversized helper error vetoes its own declaration and preserves accounting', async () => {
  const h = harness()
  let origin
  try {
    h.session._callQuery = () => (async function* () {
      origin = h.session._currentMessageId
      yield oversizedAssistant(h.session)
      yield result(0.01)
    })()
    await h.session.sendMessage('active oversized error')
    const error = h.errors.find((entry) => entry.message?.includes('Tool input too large'))
    assert.ok(error, 'the real oversized tool guard must have emitted its error')
    assert.equal(h.entry().declaredStatus.decision, 'Keep', 'own nonrecoverable helper error must discard the candidate')
    assert.equal(h.saved().declaredStatus.decision, 'Keep', 'the prior decision must remain durable')
    assert.equal(error.declarationTurnId, origin)
    assert.equal(h.entry().cumulativeUsage.turnsBilled, 1)
    assert.equal(h.entry().cumulativeUsage.costUsd, 0.01)
  } finally { h.close() }
})

test('late old SDK oversized helper error cannot veto a successor declaration or its accounting', { timeout: 5000 }, async () => {
  const h = harness(), aSeen = deferred(), releaseA = deferred(), bSeen = deferred(), releaseB = deferred()
  let a, b, originA, originB
  try {
    let ordinal = 0
    h.session._callQuery = () => {
      const index = ++ordinal
      const origin = h.session._currentMessageId
      if (index === 1) originA = origin
      else originB = origin
      const query = (async function* () {
        yield text(index === 1 ? 'A starts' : footer('B choice'))
        ;(index === 1 ? aSeen : bSeen).resolve()
        await (index === 1 ? releaseA : releaseB).promise
        if (index === 1) yield oversizedAssistant(h.session)
        yield result(index / 100)
      })()
      query.interrupt = async () => {}
      return query
    }
    a = h.session.sendMessage('A')
    await aSeen.promise
    h.session._handleHardTimeout(originA, false)
    b = h.session.sendMessage('B')
    await bSeen.promise
    releaseA.resolve()
    await a
    const error = h.errors.find((entry) => entry.message?.includes('Tool input too large'))
    assert.ok(error, 'the late old query must actually reach the helper error')
    assert.equal(error.declarationTurnId, originA)
    assert.notEqual(error.declarationTurnId, originB)
    assert.equal(h.entry().declaredStatus.decision, 'Keep')
    assert.equal(h.entry()._pendingDeclaredStatus.decision, 'B choice')
    assert.equal(h.session._isBusy, true)
    assert.equal(h.saved().turnInFlight, true)
    releaseB.resolve()
    await b
    assert.equal(h.entry().declaredStatus.decision, 'B choice')
    assert.equal(h.saved().declaredStatus.decision, 'B choice')
    assert.equal(h.entry().cumulativeUsage.turnsBilled, 2)
    assert.equal(h.entry().cumulativeUsage.costUsd, 0.03)
  } finally {
    releaseA.resolve(); releaseB.resolve()
    await Promise.allSettled([a, b].filter(Boolean))
    h.close()
  }
})


test('session-sticky sidecar stdin loss vetoes current declaration success without a fabricated query owner', async () => {
  const h = harness(), proc = new EventEmitter(), results = []
  try {
    h.session._attachSidecarProcessListeners(proc)
    h.session.on('result', (data) => results.push(data))
    h.session._callQuery = () => (async function* () {
      yield text(footer())
      proc.emit('stdin_disabled')
      yield result(0.01)
    })()
    await h.session.sendMessage('sidecar failure during current query')
    const failure = h.errors.find((entry) => entry.code === 'stdin_disabled')
    assert.ok(failure, 'actual sidecar listener must emit the session failure')
    assert.equal(failure.declarationTurnId, undefined, 'session-wide loss has no invented originating query')
    assert.equal(h.session._stdinForwardingDisabled, true)
    assert.equal(h.entry().declaredStatus.decision, 'Keep', 'known sticky channel failure must veto declaration completion')
    assert.equal(h.saved().declaredStatus.decision, 'Keep')
    assert.equal(results[0].declarationEligible, false)
    assert.equal(h.entry().cumulativeUsage.turnsBilled, 1)
    assert.equal(h.entry().cumulativeUsage.costUsd, 0.01)
  } finally { h.close() }
})


test('late sidecar loss stays session-wide and does not let an old result consume the successor candidate', { timeout: 5000 }, async () => {
  const h = harness(), proc = new EventEmitter(), aSeen = deferred(), releaseA = deferred(), bSeen = deferred(), releaseB = deferred()
  let a, b
  try {
    h.session._attachSidecarProcessListeners(proc)
    let ordinal = 0
    h.session._callQuery = () => {
      const index = ++ordinal
      const query = (async function* () {
        yield text(index === 1 ? 'A starts' : footer('B choice'))
        ;(index === 1 ? aSeen : bSeen).resolve()
        await (index === 1 ? releaseA : releaseB).promise
        if (index === 1) proc.emit('stdin_disabled')
        yield result(index / 100)
      })()
      query.interrupt = async () => {}
      return query
    }
    a = h.session.sendMessage('A'); await aSeen.promise
    h.session._handleHardTimeout(h.session._currentMessageId, false)
    b = h.session.sendMessage('B'); await bSeen.promise
    releaseA.resolve(); await a
    const failure = h.errors.find((entry) => entry.code === 'stdin_disabled')
    assert.ok(failure)
    assert.equal(failure.declarationTurnId, undefined)
    assert.equal(h.entry()._pendingDeclaredStatus.decision, 'B choice', 'global warning cannot be misattributed as a current query error')
    assert.equal(h.session._isBusy, true)
    assert.equal(h.saved().turnInFlight, true)
    releaseB.resolve(); await b
    assert.equal(h.entry().declaredStatus.decision, 'Keep', 'B completion observes the actual sticky session failure')
    assert.equal(h.saved().declaredStatus.decision, 'Keep')
    assert.equal(h.entry().cumulativeUsage.turnsBilled, 2)
    assert.equal(h.entry().cumulativeUsage.costUsd, 0.03)
  } finally {
    releaseA.resolve(); releaseB.resolve()
    await Promise.allSettled([a, b].filter(Boolean))
    h.close()
  }
})
