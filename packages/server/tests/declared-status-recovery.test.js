import { test } from 'node:test'
import { spawn } from 'node:child_process'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { SessionManager } from '../src/session-manager.js'
import { BaseSession } from '../src/base-session.js'
import { registerProvider } from '../src/providers.js'
import { declareUnknownCustomization } from './helpers/provider-customization.js'
class ReviewProvider extends BaseSession {
  static get capabilities() { return { resume: true } }
  start() {}
  sendMessage() {}
  interrupt() {}
  setModel() {}
  setPermissionMode() {}
  destroy() { this._destroyPendingBackgroundShells(); this.removeAllListeners() }
}
declareUnknownCustomization(ReviewProvider)
registerProvider('test-review-8854-persistence', ReviewProvider)
function harness() {
  const dir = mkdtempSync(join(tmpdir(), 'declared-status-state-'))
  const managers = []
  function manager(name) {
    const sm = new SessionManager({ skipPreflight: true, stateFilePath: join(dir, `${name}.json`) })
    managers.push(sm)
    return sm
  }
  const sm = manager('first')
  const id = sm.createSession({ cwd: dir, provider: 'test-review-8854-persistence' })
  sm.getSession(id).session.setActivitySessionId(id)
  const set = (m, decision, summary = decision) => m.setDeclaredStatus(id, { state: 'blocked', summary, decision })
  function restore() {
    sm.serializeState()
    const restored = manager('second')
    writeFileSync(join(dir, 'second.json'), readFileSync(join(dir, 'first.json')))
    restored.restoreState()
    assert.ok(restored.getSession(id), 'real boot restore retains session id')
    restored.getSession(id).session.setActivitySessionId(id)
    return restored
  }
  return { sm, id, set, restore, close() { for (const m of managers) m.destroyAll(); rmSync(dir, { recursive: true, force: true }) } }
}
test('retained decision keeps original lifetime start through real disk restore', () => {
  const h = harness(); const now = Date.now; let clock = 1800000000000; Date.now = () => clock
  try {
    h.set(h.sm, 'Pick target')
    const before = h.sm.getSession(h.id).session.getActivitySnapshot().entries[0]
    clock += 1000
    h.sm.setDeclaredStatus(h.id, { state: 'running', summary: 'Still checking' })
    const restored = h.restore()
    const after = restored.getSession(h.id).session.getActivitySnapshot().entries[0]
    console.log('retained lifetime', { before: before.startedAt, after: after.startedAt })
    assert.equal(after.startedAt, before.startedAt)
  } finally { Date.now = now; h.close() }
})
test('same-clock pending-clear-pending retains epoch through disk restore and rejects delayed old end', () => {
  const h = harness(); const now = Date.now; Date.now = () => 1800000000000
  try {
    const session = h.sm.getSession(h.id).session
    const deltas = []; session.on('activity_delta', d => deltas.push(d))
    h.set(h.sm, 'First')
    h.set(h.sm, 'none')
    const oldEnd = deltas.find(d => d.op === 'ended')
    assert.ok(oldEnd)
    h.set(h.sm, 'Second')
    const before = session.getActivitySnapshot().entries[0]
    assert.ok(before.startedAt > oldEnd.entry.endedAt, 'positive control: live epoch is newer')
    const restored = h.restore()
    const snapshot = restored.getSession(h.id).session.getActivitySnapshot()
    assert.equal(snapshot.entries[0].startedAt, before.startedAt, 'restored lifetime keeps the reducer identity')
    assert.ok(snapshot.entries[0].startedAt > oldEnd.entry.endedAt, 'delayed old end remains older than the restored lifetime')
  } finally { Date.now = now; h.close() }
})
test('clear then restart preserves ended lifetime fence for the next decision', () => {
  const h = harness(); const now = Date.now; Date.now = () => 1800000000000
  try {
    h.set(h.sm, 'First'); h.set(h.sm, 'none')
    const restored = h.restore()
    h.set(restored, 'Second')
    const start = restored.getSession(h.id).session.getActivitySnapshot().entries[0].startedAt
    console.log('clear/restart/new', { start, oldEnded: Date.now() })
    assert.ok(start > Date.now(), 'new lifetime must advance beyond pre-restart endedAt')
  } finally { Date.now = now; h.close() }
})
test('failed restore retry retains decision on real recovery recipe', async () => {
  const h = harness()
  try {
    h.set(h.sm, 'First'); h.set(h.sm, 'none'); h.set(h.sm, 'Choose recovery target')
    const originalStart = h.sm.getSession(h.id).session.getActivitySnapshot().entries[0].startedAt
    const saved = h.sm.serializeState().sessions[0]
    h.sm._sessions.delete(h.id)
    h.sm._failedRestores.set(h.id, { saved, error: new Error('temporary start failure') })
    const result = await h.sm.retryFailedRestore(h.id)
    assert.equal(result.ok, true)
    assert.equal(h.sm.getSession(h.id).declaredStatus.decision, 'Choose recovery target')
    assert.equal(h.sm.getSession(h.id).session.getActivitySnapshot().entries[0].label, 'Choose recovery target')
    assert.equal(h.sm.getSession(h.id).session.getActivitySnapshot().entries[0].startedAt, originalStart)
  } finally { h.close() }
})
test('archive native restore retains decision on real recovery recipe', async () => {
  const h = harness()
  try {
    h.sm._claudeTranscriptExists = () => true
    h.sm.getSession(h.id).session.resumeSessionId = 'review-conversation'
    h.set(h.sm, 'First'); h.set(h.sm, 'none'); h.set(h.sm, 'Choose archive target')
    const originalStart = h.sm.getSession(h.id).session.getActivitySnapshot().entries[0].startedAt
    h.sm._history.setHistory(h.id, [{ type: 'message', messageType: 'user_input', content: 'review archive conversation' }])
    h.sm.destroySession(h.id)
    await h.sm.whenArchiveIdle()
    const row = h.sm.listArchivedSessions().sessions.find(row => row.sessionId === h.id)
    assert.ok(row)
    const result = await h.sm.restoreArchivedSession(row.archiveId, 'native')
    assert.equal(result.ok, true)
    assert.equal(h.sm.getSession(h.id).declaredStatus.decision, 'Choose archive target')
    assert.equal(h.sm.getSession(h.id).session.getActivitySnapshot().entries[0].label, 'Choose archive target')
    assert.equal(h.sm.getSession(h.id).session.getActivitySnapshot().entries[0].startedAt, originalStart)
  } finally { h.close() }
})

async function writeThenCrash(dir, mode = 'kill') {
  const child = spawn(process.execPath, ['--import', './tests/_setup.mjs', '--experimental-test-module-mocks', fileURLToPath(new URL('./fixtures/declared-status-crash-writer.mjs', import.meta.url)), dir, mode], {
    cwd: fileURLToPath(new URL('../', import.meta.url)), stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
  })
  let stderr = '', timer
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-8192) })
  const exited = new Promise((resolve, reject) => {
    child.once('error', reject)
    child.once('exit', (code, signal) => resolve({ code, signal }))
  })
  const ready = new Promise((resolve) => child.on('message', (message) => {
    if (message?.type === 'declared-state-ready') resolve()
  }))
  const deadline = new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('Crash writer exceeded 5 second ceiling')), 5000) })
  try {
    await Promise.race([ready, exited.then(() => { throw new Error(`Child exited before state ready: ${stderr}`) }), deadline])
    const saved = JSON.parse(readFileSync(join(dir, 'crash.json'), 'utf8')).sessions[0]
    assert.equal(saved.declaredStatus.decision, 'Pick crash target', 'readiness must follow successful persistence')
    if (mode === 'graceful') child.send('finish-gracefully')
    else assert.equal(child.kill('SIGKILL'), true, 'parent must actually issue the abrupt termination')
    const exit = await Promise.race([exited, deadline])
    assert.equal(exit.signal, 'SIGKILL', 'recovery proof requires parent-triggered SIGKILL')
    assert.equal(existsSync(join(dir, 'graceful-exit')), false, 'no shutdown cleanup may run')
    return saved
  } finally {
    clearTimeout(timer)
    if (child.exitCode === null && child.signalCode === null) {
      child.kill('SIGKILL')
      let cleanupTimer
      try {
        await Promise.race([exited, new Promise((_, reject) => {
          cleanupTimer = setTimeout(() => reject(new Error('Crash writer did not exit after cleanup kill')), 2000)
        })])
      } finally { clearTimeout(cleanupTimer) }
    }
  }
}

test('abrupt parent SIGKILL after ready then boot restore keeps persisted decision without shutdown cleanup', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'declared-status-crash-'))
  let sm
  try {
    const saved = await writeThenCrash(dir)
    sm = new SessionManager({ skipPreflight: true, stateFilePath: join(dir, 'crash.json') })
    sm.restoreState()
    assert.equal(sm.getSession(saved.id).declaredStatus.decision, 'Pick crash target')
    assert.equal(sm.getSession(saved.id).session.getActivitySnapshot().entries[0].label, 'Pick crash target')
    assert.equal(sm.getSession(saved.id).session.getActivitySnapshot().entries[0].startedAt, saved.decisionActivity.startedAt)
    assert.ok(saved.decisionActivity.startedAt > saved.decisionActivity.endedAt)
  } finally { sm?.destroyAll(); rmSync(dir, { recursive: true, force: true }) }
})

test('crash recovery proof rejects a child exiting before persistence readiness', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'declared-status-early-exit-'))
  try {
    await assert.rejects(writeThenCrash(dir, 'exit-before-ready'), /Child exited before state ready/)
    assert.equal(existsSync(join(dir, 'crash.json')), false)
  } finally { rmSync(dir, { recursive: true, force: true }) }
})

test('crash recovery proof rejects graceful shutdown after persistence readiness', { timeout: 10000 }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'declared-status-graceful-'))
  try {
    await assert.rejects(writeThenCrash(dir, 'graceful'), /requires parent-triggered SIGKILL/)
    assert.equal(existsSync(join(dir, 'graceful-exit')), true, 'negative control actually ran exit cleanup')
  } finally { rmSync(dir, { recursive: true, force: true }) }
})


test('reordered semantic status fields do not emit a duplicate or advance updatedAt', () => {
  const h = harness()
  try {
    h.set(h.sm, 'Keep')
    const entry = h.sm.getSession(h.id)
    entry.declaredStatus = Object.fromEntries(Object.entries(entry.declaredStatus).reverse())
    const previous = entry.declaredStatus.updatedAt
    let changes = 0
    h.sm.on('session_event', ({ event }) => { if (event === 'session_status') changes++ })
    const next = h.sm.setDeclaredStatus(h.id, { decision: 'Keep', summary: 'Keep', state: 'blocked' })
    assert.equal(changes, 0)
    assert.equal(next.updatedAt, previous)
  } finally { h.close() }
})
