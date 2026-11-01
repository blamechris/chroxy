/**
 * #8866 — the first message of a session continued from the archive as a NEW
 * thread carries the archived transcript, once, and only if the provider took it.
 *
 * Against the real handler and a real SessionManager (temp stateFilePath, #4633).
 */
import { describe, it, mock, beforeEach, after } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { handleSessionMessage } from '../src/ws-message-handlers.js'
import { SessionManager } from '../src/session-manager.js'
import { buildContinuationSeed } from '../src/archive-continuation.js'
import { createMockSession, nsCtx } from './test-helpers.js'

let tmp
function tmpState() {
  if (!tmp) tmp = mkdtempSync(join(tmpdir(), 'input-seed-'))
  return join(tmp, `state-${Math.random().toString(36).slice(2)}.json`)
}
after(() => { if (tmp) rmSync(tmp, { recursive: true, force: true }) })

const WS = {}
const SEED_TEXT_MARK = 'the archived question about flags'

describe('continuation seed on the first input (#8866)', () => {
  let mgr, session, ctx, client, calls, admission
  beforeEach(() => {
    mgr = new SessionManager({ skipPreflight: true, maxSessions: 3, stateFilePath: tmpState() })
    session = createMockSession()
    calls = []
    admission = { status: 'accepted', delivery: 'dispatch_started' }
    session.sendMessage = (text, attachments, opts) => {
      calls.push({ text, attachments, opts })
      if (admission) opts.onInputAdmission?.(admission)
    }
    mgr._sessions.set('s1', { session, name: 'S', cwd: '/tmp' })
    const seed = buildContinuationSeed([
      { type: 'message', messageType: 'user_input', content: SEED_TEXT_MARK },
      { type: 'message', messageType: 'response', content: 'the archived answer' },
    ])
    mgr._continuationSeeds.set('s1', { seed: { ...seed, name: 'Old work', archivedAt: 99 }, claimed: false, claimedAt: 0 })
    const primary = new Map()
    ctx = nsCtx({
      sessionManager: {
        getSession: (id) => mgr.getSession(id),
        isBudgetPaused: () => false,
        recordUserInput: (...a) => mgr.recordUserInput(...a),
        recordUserIntent: (id) => mgr.recordUserIntent(id),
        touchActivity: (id) => mgr.touchActivity(id),
        claimContinuationSeed: (id) => mgr.claimContinuationSeed(id),
        settleContinuationSeed: (id, ok) => mgr.settleContinuationSeed(id, ok),
        getHistoryCount: () => 0,
        listSessions: () => [],
      },
      send: mock.fn(),
      broadcast: mock.fn(),
      broadcastToSession: mock.fn(),
      updatePrimary: mock.fn((sid, cid) => { primary.set(sid, cid) }),
      getPrimary: mock.fn((sid) => primary.get(sid)),
      checkpointManager: { createCheckpoint: mock.fn(() => Promise.resolve()) },
      permissionSessionMap: new Map(),
      questionSessionMap: new Map(),
      pendingPermissions: new Map(),
      clients: new Map(),
    })
    client = { id: 'c1', activeSessionId: 's1', clientCapabilities: new Set(['input_context_v1']) }
  })

  const send = (data, clientMessageId) => handleSessionMessage(WS, client, { type: 'input', data, clientMessageId }, ctx)
  const pending = () => mgr._continuationSeeds.has('s1')

  it('the first accepted input carries the transcript, labelled as archived data, ahead of the request', async () => {
    await send('now do the next thing', 'u1')
    assert.equal(calls.length, 1)
    assert.ok(calls[0].text.includes(SEED_TEXT_MARK))
    assert.ok(calls[0].text.includes('source="archived_session"'))
    assert.ok(calls[0].text.endsWith('User request:\nnow do the next thing'))
    assert.equal(pending(), false, 'consumed')
  })

  it('the SECOND input is plain text: the seed goes once', async () => {
    await send('first', 'u1')
    await send('second', 'u2')
    assert.equal(calls[1].text, 'second')
  })

  it('what the chat records and the provider is told as context is only what the user typed / selected', async () => {
    await send('typed words', 'u1')
    const typed = mgr.getHistory('s1').filter((e) => e.messageType === 'user_input')
    assert.deepEqual(typed.map((e) => e.content), ['typed words'], 'history shows the user text, not the transcript')
    assert.equal(calls[0].opts.context, undefined, 'the seed is not passed off as a client-selected context item')
  })

  it('a user-selected context item travels alongside the seed', async () => {
    const context = {
      version: 1,
      items: [{ id: 'sel-1', kind: 'text', mediaType: 'text/plain', sizeBytes: 3, lifetime: 'one_turn', provenance: { source: 'clipboard' }, content: { type: 'text', text: 'abc' } }],
    }
    await handleSessionMessage(WS, client, { type: 'input', data: 'go', clientMessageId: 'u1', context }, ctx)
    assert.ok(calls[0].text.includes(SEED_TEXT_MARK))
    assert.ok(calls[0].text.includes('id="sel-1"'))
    assert.equal(calls[0].opts.context.items.length, 1, 'sendOptions.context stays what the user selected')
    assert.equal(pending(), false)
  })

  it('a provider that REJECTS the input keeps the seed pending, and the retry carries it', async () => {
    admission = { status: 'rejected', delivery: 'not_dispatched', reason: 'busy' }
    await send('first try', 'u1')
    assert.equal(pending(), true, 'not consumed by a rejected send')
    assert.equal(mgr._continuationSeeds.get('s1').claimed, false, 'and not stuck claimed')
    admission = { status: 'accepted', delivery: 'dispatch_started' }
    await send('second try', 'u2')
    assert.ok(calls[1].text.includes(SEED_TEXT_MARK))
    assert.equal(pending(), false)
  })

  it('an UNCERTAIN admission keeps it pending (an explicit resend may carry it again)', async () => {
    admission = { status: 'uncertain', delivery: 'unknown' }
    await send('first try', 'u1')
    assert.equal(pending(), true)
    assert.equal(mgr._continuationSeeds.get('s1').claimed, false)
  })

  it('a provider that throws keeps it pending', async () => {
    const real = session.sendMessage
    session.sendMessage = () => { throw new Error('transport down') }
    await assert.rejects(() => send('first try', 'u1'), /transport down/)
    assert.equal(pending(), true)
    assert.equal(mgr._continuationSeeds.get('s1').claimed, false)
    session.sendMessage = real
    await send('again', 'u2')
    assert.ok(calls[0].text.includes(SEED_TEXT_MARK))
  })

  it('an input rejected BEFORE dispatch (budget paused) never touches the seed', async () => {
    ctx.sessions.sessionManager.isBudgetPaused = () => true
    await send('blocked', 'u1')
    assert.equal(calls.length, 0)
    assert.equal(pending(), true)
    assert.equal(mgr._continuationSeeds.get('s1').claimed, false)
  })

  it('a session with no seed is untouched: the provider gets the plain text', async () => {
    mgr._continuationSeeds.clear()
    await send('plain', 'u1')
    assert.equal(calls[0].text, 'plain')
  })

  it('a legacy client (no admission contract) consumes it once sendMessage returned', async () => {
    client = { id: 'c1', activeSessionId: 's1', clientCapabilities: new Set() }
    await handleSessionMessage(WS, client, { type: 'input', data: 'legacy' }, ctx)
    assert.ok(calls[0].text.includes(SEED_TEXT_MARK))
    assert.equal(pending(), false)
  })
})
