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
        settleContinuationSeed: (id, token, ok) => mgr.settleContinuationSeed(id, token, ok),
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

  it('an UNCERTAIN admission counts as CONSUMED: the transcript is never risked twice', async () => {
    admission = { status: 'uncertain', delivery: 'unknown' }
    await send('first try', 'u1')
    assert.equal(pending(), false)
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

  it('a legacy client (no input acks) is observed through the admission callback too: accepted consumes', async () => {
    client = { id: 'c1', activeSessionId: 's1', clientCapabilities: new Set() }
    await handleSessionMessage(WS, client, { type: 'input', data: 'legacy' }, ctx)
    assert.ok(calls[0].text.includes(SEED_TEXT_MARK))
    assert.equal(typeof calls[0].opts.onInputAdmission, 'function', 'passed because a seed is claimed')
    assert.equal(pending(), false)
  })

  it('a legacy client whose input is DEFINITELY rejected keeps the seed pending', async () => {
    client = { id: 'c1', activeSessionId: 's1', clientCapabilities: new Set() }
    admission = { status: 'rejected', delivery: 'not_dispatched', reason: 'busy' }
    await handleSessionMessage(WS, client, { type: 'input', data: 'legacy' }, ctx)
    assert.equal(pending(), true)
    assert.equal(mgr._continuationSeeds.get('s1').claimed, false)
  })

  it('a provider that reports no admission at all settles it as consumed when its call returns', async () => {
    admission = null
    await send('first', 'u1')
    assert.equal(pending(), false)
  })

  it('while the first input is unresolved a SECOND input is refused (retry-safe), not sent without the transcript', async () => {
    admission = null
    let finish
    session.sendMessage = (text, attachments, opts) => { calls.push({ text, opts }); return new Promise((r) => { finish = r }) }
    const first = send('first', 'u1')
    await new Promise((r) => setImmediate(r))
    assert.equal(calls.length, 1)
    await send('second', 'u2')
    assert.equal(calls.length, 1, 'the second input was never dispatched')
    finish(); await first
    assert.equal(pending(), false)
    await send('third', 'u3')
    assert.equal(calls[1].text, 'third', 'after the first settled, later input is plain')
  })

  it('the refused second input is acked rejected / not_dispatched / retrySafe with reason continuation_seed_pending', async () => {
    admission = null
    session.sendMessage = (text, attachments, opts) => { calls.push({ text, opts }); return new Promise(() => {}) }
    send('first', 'u1')
    await new Promise((r) => setImmediate(r))
    const sent = []
    ctx.transport.send = (_ws, m) => sent.push(m)
    await send('second', 'u2')
    const ack = sent.find((m) => m.type === 'input_ack' && m.clientMessageId === 'u2')
    assert.deepEqual([ack.status, ack.delivery, ack.retrySafe, ack.reason], ['rejected', 'not_dispatched', true, 'continuation_seed_pending'])
  })

  it('a stale settle (wrong token) cannot consume or release a newer claim', async () => {
    const claim = mgr.claimContinuationSeed('s1')
    mgr.settleContinuationSeed('s1', 'not-the-token', true)
    assert.equal(pending(), true)
    assert.equal(mgr._continuationSeeds.get('s1').claimed, true)
    mgr.settleContinuationSeed('s1', claim.token, false)
    assert.equal(mgr._continuationSeeds.get('s1').claimed, false)
  })
})
