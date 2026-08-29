/**
 * #7457 — a genuinely PENDING AskUserQuestion must survive an ordinary
 * reconnect.
 *
 * `history_replay_end` stamps `answered: '(resolved)'` on every unanswered
 * `prompt` the sweep is entitled to touch, on the premise that anything in
 * history is already resolved. #7420 / PR #7453 carved out the question that
 * arrived LIVE during the replay; it deliberately did not carve out the
 * question that is genuinely still pending and that the replay itself
 * re-delivered — and it cannot, because that question comes from the ring
 * buffer and so carries `historySeq`, which is the whole discriminator.
 *
 * `user_question` is NOT in the server's `builtinTransient` list, so it IS
 * written to the ring buffer, and until this change the ONLY way a pending
 * question reached a reconnecting client was that replay. So: background the
 * phone mid-question, reopen it, and the prompt renders as a resolved pill with
 * the agent still blocked on the resolver.
 *
 * The fix mirrors `reseedActiveAgents`: after the replay's `history_replay_end`
 * — from the ONE exit both replay paths share — re-send every question the
 * session is still blocked on, as a LIVE frame (no `historySeq`). The sweep has
 * already run by then, so it cannot reach the re-sent copy.
 *
 * The pending set is READ THROUGH to each provider's own resolver store rather
 * than mirrored into a new map. A mirror would need its own lifecycle, and a
 * leaked mirror entry re-delivers a dead question to every future client
 * forever; a read-through cannot leak, because the record IS the thing that
 * blocks the turn.
 */
import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync, statSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createSpy, createMockSessionManager } from './test-helpers.js'
import { replayHistory, resendPendingQuestions } from '../src/ws-history.js'
import { PermissionManager, wirePermissionManager } from '../src/permission-manager.js'
import { BaseSession } from '../src/base-session.js'
import { CliSession } from '../src/cli-session.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'

const SRC = fileURLToPath(new URL('../src/', import.meta.url))

// ── Fixtures ───────────────────────────────────────────────────────────────

const QUESTIONS = [{ question: 'Which approach?', options: [{ label: 'A' }, { label: 'B' }] }]

function makeFakeWs(readyState = 1) {
  return { readyState, send: () => {}, close: createSpy(), bufferedAmount: 0 }
}

/**
 * A ctx shaped like the one ws-history.js is handed, recording every send.
 */
function makeCtx({ sessionManager }) {
  const sends = []
  return {
    clients: new Map(),
    sessionManager,
    send: (_ws, msg) => sends.push(msg),
    _sends: sends,
  }
}

/**
 * A session manager with one session whose provider reports `pending` as its
 * still-blocked AskUserQuestion set.
 */
function managerWithPending(history, pending, { sessionId = 'sess-1' } = {}) {
  const { manager } = createMockSessionManager([{ id: sessionId, name: 'Alpha', cwd: '/alpha' }])
  manager.getHistory = () => history
  manager.isHistoryTruncated = () => false
  manager.getSession(sessionId).session.getPendingQuestions = () => pending
  return manager
}

function registerClient(ctx, ws, overrides = {}) {
  const client = { id: 'client-1', activeSessionId: null, ...overrides }
  ctx.clients.set(ws, client)
  return client
}

// ── AC 1: the reconnect leaves the prompt answerable ───────────────────────

describe('replayHistory — pending AskUserQuestion re-send (#7457)', () => {
  it('re-sends the pending question AFTER history_replay_end', async () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({
      sessionManager: managerWithPending(
        [{ type: 'user_question', toolUseId: 'ask-1', questions: QUESTIONS, _seq: 1 }],
        [{ toolUseId: 'ask-1', questions: QUESTIONS }],
      ),
    })
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-1')
    await new Promise((r) => setImmediate(r))

    const types = ctx._sends.map((m) => m.type)
    const endIdx = types.indexOf('history_replay_end')
    assert.ok(endIdx >= 0, 'precondition: the replay finished')
    // The REPLAYED copy is at index 1 and carries historySeq; the re-sent one
    // must come after the end frame.
    const resendIdx = ctx._sends.findIndex((m, i) => m.type === 'user_question' && i > endIdx)
    assert.ok(
      resendIdx > endIdx,
      `a pending question must be re-sent after history_replay_end; got ${JSON.stringify(types)}`,
    )
    assert.deepEqual(ctx._sends[resendIdx], {
      type: 'user_question',
      sessionId: 'sess-1',
      toolUseId: 'ask-1',
      questions: QUESTIONS,
    })
  })

  // The re-sent frame is the client's ONLY signal that this question is still
  // live. `historySeq` on it would make both clients classify it as
  // replay-delivered (#7420's discriminator) and the sweep would be entitled to
  // stamp it all over again on the next replay.
  it('the re-sent frame carries NO historySeq', async () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({
      sessionManager: managerWithPending(
        [{ type: 'user_question', toolUseId: 'ask-1', questions: QUESTIONS, _seq: 1 }],
        [{ toolUseId: 'ask-1', questions: QUESTIONS }],
      ),
    })
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-1')
    await new Promise((r) => setImmediate(r))

    const types = ctx._sends.map((m) => m.type)
    const endIdx = types.indexOf('history_replay_end')
    const resent = ctx._sends.filter((m, i) => m.type === 'user_question' && i > endIdx)
    assert.equal(resent.length, 1)
    assert.equal('historySeq' in resent[0], false, 'a re-sent pending question must read as LIVE')
  })

  // THE ordering pin, and the reason the re-send is sequenced by the replay's
  // COMPLETION rather than by its invocation.
  //
  // `replayHistory` emits in 20-entry chunks separated by `setImmediate` yields,
  // so a history longer than one chunk PARKS and `history_replay_end` is sent on
  // a later turn of the event loop. Anything placed after the
  // `replayHistory(...)` CALL — which is where the issue proposed putting this,
  // beside `resendPendingPermissions` in the post-auth block — therefore runs
  // BEFORE the end frame, and the client's sweep then stamps the very question
  // we just re-sent. Permissions never noticed because `requestId` excludes them
  // from the sweep outright; a question's whole defence is landing after the end
  // frame.
  //
  // A one-entry history hides this completely: a single chunk drains
  // synchronously and `onDone` runs before the call returns, so the wrong
  // placement passes. 25 entries is the fixture that can tell them apart.
  it('lands after history_replay_end even when the replay PARKS mid-way (>1 chunk)', async () => {
    const history = Array.from({ length: 25 }, (_, i) => ({ type: 'response', content: `m${i}`, _seq: i + 1 }))
    const ws = makeFakeWs()
    const ctx = makeCtx({
      sessionManager: managerWithPending(history, [{ toolUseId: 'ask-1', questions: QUESTIONS }]),
    })
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-1')
    // Two turns: the parked continuation, then the drained finish.
    await new Promise((r) => setImmediate(r))
    await new Promise((r) => setImmediate(r))

    const types = ctx._sends.map((m) => m.type)
    // Precondition: the replay really did park — 25 entries cannot be one chunk.
    assert.equal(types.filter((t) => t === 'response').length, 25)
    const endIdx = types.indexOf('history_replay_end')
    const resendIdx = types.indexOf('user_question')
    assert.ok(endIdx >= 0, 'precondition: the replay finished')
    assert.ok(
      resendIdx > endIdx,
      `the re-send must follow the END FRAME, not the replayHistory() call; got ${JSON.stringify(types.slice(-4))}`,
    )
  })

  // The empty-slice path is the SECOND exit from the replay and the most common
  // one of all — the quick reconnect whose cursor is already current. On it the
  // client still gets `history_replay_end`, so its sweep still runs, so the
  // re-send must follow that exit too.
  it('re-sends on an already-current (empty-slice) replay too', async () => {
    const history = [{ type: 'user_question', toolUseId: 'ask-1', questions: QUESTIONS, _seq: 1 }]
    const manager = managerWithPending(history, [{ toolUseId: 'ask-1', questions: QUESTIONS }])
    manager.getLatestHistorySeq = () => 1
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })
    registerClient(ctx, ws, { historyCursors: { 'sess-1': 1 } })

    replayHistory(ctx, ws, 'sess-1')
    await new Promise((r) => setImmediate(r))

    const types = ctx._sends.map((m) => m.type)
    assert.equal(types.filter((t) => t === 'user_question').length, 1, 'precondition: nothing was replayed')
    const endIdx = types.indexOf('history_replay_end')
    const resendIdx = types.indexOf('user_question')
    assert.ok(endIdx >= 0 && resendIdx > endIdx)
  })

  // AC (b) direction, held at the SERVER: a long-answered question is not
  // pending, so nothing is re-sent and the client's sweep keeps its stamp.
  // This is the pin an over-broad fix (re-send everything in the ring buffer)
  // would break.
  it('re-sends NOTHING when the session has no pending question', async () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({
      sessionManager: managerWithPending(
        [{ type: 'user_question', toolUseId: 'ask-old', questions: QUESTIONS, _seq: 1 }],
        [],
      ),
    })
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-1')
    await new Promise((r) => setImmediate(r))

    const types = ctx._sends.map((m) => m.type)
    const endIdx = types.indexOf('history_replay_end')
    assert.ok(endIdx >= 0)
    assert.equal(
      ctx._sends.filter((m, i) => m.type === 'user_question' && i > endIdx).length,
      0,
      'an already-answered question must stay stamped (resolved)',
    )
  })

  it('re-sends every pending question, not just the first', async () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({
      sessionManager: managerWithPending([{ type: 'response', content: 'hi', _seq: 1 }], [
        { toolUseId: 'ask-1', questions: QUESTIONS },
        { toolUseId: 'ask-2', questions: QUESTIONS },
      ]),
    })
    registerClient(ctx, ws)

    replayHistory(ctx, ws, 'sess-1')
    await new Promise((r) => setImmediate(r))

    assert.deepEqual(
      ctx._sends.filter((m) => m.type === 'user_question').map((m) => m.toolUseId),
      ['ask-1', 'ask-2'],
    )
  })

  it('is scoped to the replayed session', () => {
    const { manager } = createMockSessionManager([
      { id: 'sess-1', name: 'Alpha', cwd: '/alpha' },
      { id: 'sess-2', name: 'Beta', cwd: '/beta' },
    ])
    manager.getSession('sess-1').session.getPendingQuestions = () => []
    manager.getSession('sess-2').session.getPendingQuestions = () => [
      { toolUseId: 'ask-2', questions: QUESTIONS },
    ]
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: manager })

    resendPendingQuestions(ctx, ws, 'sess-1')

    assert.deepEqual(ctx._sends, [])
  })

  it('skips a session the manager does not know', () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({ sessionManager: managerWithPending([], []) })

    resendPendingQuestions(ctx, ws, 'no-such-session')

    assert.deepEqual(ctx._sends, [])
  })

  // A malformed pending entry must not strand the questions behind it — the
  // same per-entry isolation `resendPendingPermissions` grew in #6054.
  it('drops a pending entry with no toolUseId rather than sending a frame nothing can answer', () => {
    const ws = makeFakeWs()
    const ctx = makeCtx({
      sessionManager: managerWithPending([], [
        { toolUseId: null, questions: QUESTIONS },
        { toolUseId: 'ask-2', questions: QUESTIONS },
      ]),
    })

    resendPendingQuestions(ctx, ws, 'sess-1')

    assert.deepEqual(ctx._sends.map((m) => m.toolUseId), ['ask-2'])
  })
})

// ── The provider-side pending sets ─────────────────────────────────────────

describe('getPendingQuestions — PermissionManager (#7457)', () => {
  function pm() {
    return new PermissionManager({ timeoutMs: 60_000 })
  }

  it('reports the question the turn is blocked on', () => {
    const p = pm()
    p.handlePermission('AskUserQuestion', { questions: QUESTIONS }, null, 'approve')
    const pending = p.getPendingQuestions()
    assert.equal(pending.length, 1)
    assert.equal(pending[0].questions, QUESTIONS)
    assert.match(pending[0].toolUseId, /^ask-/)
    p.clearAll()
  })

  it('reports nothing before any question', () => {
    assert.deepEqual(pm().getPendingQuestions(), [])
  })

  // The four resolution paths, each of which releases the resolver. A pending
  // record that outlives its resolver is re-delivered to every future client
  // forever — the leak this design exists to make impossible.
  it('LIFECYCLE: answered → no longer pending', async () => {
    const p = pm()
    const promise = p.handlePermission('AskUserQuestion', { questions: QUESTIONS }, null, 'approve')
    p.respondToQuestion('A')
    assert.deepEqual(p.getPendingQuestions(), [])
    // Answering it also unblocks the turn — the second half of AC 1.
    const result = await promise
    assert.equal(result.behavior, 'allow')
  })

  it('LIFECYCLE: timed out → no longer pending', async () => {
    const p = new PermissionManager({ timeoutMs: 5 })
    const promise = p.handlePermission('AskUserQuestion', { questions: QUESTIONS }, null, 'approve')
    const result = await promise
    assert.equal(result.behavior, 'deny')
    assert.deepEqual(p.getPendingQuestions(), [])
  })

  it('LIFECYCLE: aborted → no longer pending', async () => {
    const p = pm()
    const controller = new AbortController()
    const promise = p.handlePermission('AskUserQuestion', { questions: QUESTIONS }, controller.signal, 'approve')
    controller.abort()
    await promise
    assert.deepEqual(p.getPendingQuestions(), [])
  })

  it('LIFECYCLE: clearAll (turn end / session destroy) → no longer pending', async () => {
    const p = pm()
    const promise = p.handlePermission('AskUserQuestion', { questions: QUESTIONS }, null, 'approve')
    p.clearAll()
    await promise
    assert.deepEqual(p.getPendingQuestions(), [])
  })

  // autoAllowPending() deliberately leaves questions alone (#3729): solicited
  // user input is not a permission gate. The resolver is therefore STILL
  // blocked, so the question is still pending and must still be re-sent.
  it('stays pending across autoAllowPending — the resolver is still blocked', () => {
    const p = pm()
    p.handlePermission('AskUserQuestion', { questions: QUESTIONS }, null, 'approve')
    p.autoAllowPending()
    assert.equal(p.getPendingQuestions().length, 1)
    p.clearAll()
  })

  it('wirePermissionManager installs the delegate on the session', () => {
    const p = pm()
    const session = new (class extends BaseSession {})({ sessionId: 's', cwd: '/tmp' })
    wirePermissionManager(session, p)
    p.handlePermission('AskUserQuestion', { questions: QUESTIONS }, null, 'approve')
    assert.equal(session.getPendingQuestions().length, 1)
    p.clearAll()
    session.destroy?.()
  })
})

describe('getPendingQuestions — CliSession (#7457)', () => {
  // The legacy `claude -p` provider holds no resolver: it writes the answer to
  // the child's stdin and tracks the wait with `_waitingForAnswer`. #7457 gives
  // it a payload to go with that flag, written and cleared in the same statement
  // block at every one of the flag's sites.
  function askOn(session) {
    // Drives the REAL path: `_applyToolInputSemantics` is what emits
    // `user_question`, so the pending payload is recorded by the same statement
    // the client's prompt comes from.
    session._applyToolInputSemantics({
      currentToolName: 'AskUserQuestion',
      currentToolUseId: 'toolu_ask',
      toolInputChunks: JSON.stringify({ questions: QUESTIONS }),
    })
  }

  it('reports the question the child is parked on', () => {
    const session = new CliSession({ cwd: '/tmp' })
    session.on('error', () => {})
    askOn(session)
    assert.deepEqual(session.getPendingQuestions(), [{ toolUseId: 'toolu_ask', questions: QUESTIONS }])
  })

  it('reports nothing before any question', () => {
    const session = new CliSession({ cwd: '/tmp' })
    session.on('error', () => {})
    assert.deepEqual(session.getPendingQuestions(), [])
  })

  it('LIFECYCLE: the turn-end funnel (_clearMessageState) drops it', () => {
    const session = new CliSession({ cwd: '/tmp' })
    session.on('error', () => {})
    askOn(session)
    assert.equal(session.getPendingQuestions().length, 1)
    session._clearMessageState()
    assert.deepEqual(session.getPendingQuestions(), [])
  })

  it('LIFECYCLE: answering drops it', () => {
    const session = new CliSession({ cwd: '/tmp' })
    session.on('error', () => {})
    askOn(session)
    // respondToQuestion needs a child to write to; a stdin stub is enough to
    // reach the clear.
    session._child = { stdin: { write: () => {} } }
    session.respondToQuestion('A')
    assert.deepEqual(session.getPendingQuestions(), [])
    session._child = null
  })

  // The doc on `getPendingQuestions` claims the payload is co-located with
  // `_waitingForAnswer` at every one of that flag's sites. That is a claim about
  // SOURCE, not about any one behaviour, and the two mutants above can only
  // reach the sites a test happens to drive. Assert it mechanically instead —
  // otherwise a fifth `_waitingForAnswer` site added later leaves a stale
  // payload that `getPendingQuestions` will happily re-send forever.
  it('every `_waitingForAnswer` write is co-located with a `_pendingQuestion` write', () => {
    const src = readFileSync(join(SRC, 'cli-session.js'), 'utf8')
    const lines = src.split('\n')
    const isComment = (l) => {
      const t = l.trim()
      return t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')
    }
    const orphans = []
    lines.forEach((line, i) => {
      if (!/\bthis\._waitingForAnswer\s*=/.test(line)) return
      // The paired write is the next STATEMENT, so comment lines are skipped
      // rather than counted — a window measured in raw lines is silently
      // widened or narrowed by whatever prose sits between the two writes.
      const window = lines
        .slice(i + 1)
        .filter((l) => !isComment(l) && l.trim() !== '')
        .slice(0, 2)
        .join('\n')
      if (!/\bthis\._pendingQuestion\s*=/.test(window)) orphans.push(`line ${i + 1}: ${line.trim()}`)
    })
    assert.deepEqual(orphans, [])
  })

  // Positive control for the scan: it really does find the writes, so
  // "no orphans" is not the answer a regex that matches nothing would give.
  it('the co-location scan finds every known `_waitingForAnswer` write', () => {
    const src = readFileSync(join(SRC, 'cli-session.js'), 'utf8')
    assert.equal((src.match(/\bthis\._waitingForAnswer\s*=/g) || []).length, 4)
  })
})

describe('getPendingQuestions — ClaudeTuiSession (#7457)', () => {
  const payload = (toolUseId) => ({
    tool_name: 'AskUserQuestion',
    tool_use_id: toolUseId,
    tool_input: { questions: [{ question: 'Which approach?', header: 'A', options: [{ label: 'A', value: 'a' }] }] },
  })

  function makeSession(skillsDir) {
    const session = new ClaudeTuiSession({ cwd: '/tmp', skillsDir, repoSkillsDir: null })
    session.on('error', () => {})
    session._activeTurn = { messageId: 'msg-test', startedAt: Date.now(), aborted: false, synthSeq: 0 }
    return session
  }

  it('reports every entry the PTY is parked on, keyed by the MAP key', async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-7457-'))
    const session = makeSession(skillsDir)
    try {
      session._emitToolHookEvent('PreToolUse', payload('toolu_a'), 'msg-test')
      session._emitToolHookEvent('PreToolUse', payload('toolu_b'), 'msg-test')
      assert.deepEqual(session.getPendingQuestions().map((q) => q.toolUseId), ['toolu_a', 'toolu_b'])
      assert.equal(session.getPendingQuestions()[0].questions.length, 1)
    } finally {
      await session.destroy().catch(() => {})
      rmSync(skillsDir, { recursive: true, force: true })
    }
  })

  it('LIFECYCLE: the surgical per-toolUseId clear drops exactly one', async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-7457-'))
    const session = makeSession(skillsDir)
    try {
      session._emitToolHookEvent('PreToolUse', payload('toolu_a'), 'msg-test')
      session._emitToolHookEvent('PreToolUse', payload('toolu_b'), 'msg-test')
      session._clearPendingAnswerByToolUseId('toolu_a')
      assert.deepEqual(session.getPendingQuestions().map((q) => q.toolUseId), ['toolu_b'])
    } finally {
      await session.destroy().catch(() => {})
      rmSync(skillsDir, { recursive: true, force: true })
    }
  })

  it('LIFECYCLE: the turn-level clear-all drops them all', async () => {
    const skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-7457-'))
    const session = makeSession(skillsDir)
    try {
      session._emitToolHookEvent('PreToolUse', payload('toolu_a'), 'msg-test')
      session._pendingUserAnswers_clearAll()
      assert.deepEqual(session.getPendingQuestions(), [])
    } finally {
      await session.destroy().catch(() => {})
      rmSync(skillsDir, { recursive: true, force: true })
    }
  })
})

describe('getPendingQuestions — BaseSession default (#7457)', () => {
  // Every provider answers the call, so `resendPendingQuestions` can call it
  // unguarded. A feature-detect that can never fail turns a future regression
  // into a silent no-op (docs/false-safety-guards.md).
  it('a provider with no question surface reports an empty set', () => {
    const session = new (class extends BaseSession {})({ sessionId: 's', cwd: '/tmp' })
    assert.deepEqual(session.getPendingQuestions(), [])
    session.destroy?.()
  })
})

// ── Roster guard: every replay-end that can sweep a LIVE session ───────────

describe('pending-question re-send coverage (#7457)', () => {
  function allServerSources(dir = SRC, out = []) {
    for (const name of readdirSync(dir)) {
      const full = join(dir, name)
      if (statSync(full).isDirectory()) allServerSources(full, out)
      else if (name.endsWith('.js')) out.push(full)
    }
    return out
  }
  // Normalised to `/`, because `relative()` returns OS-NATIVE separators and the
  // roster below is an exact `deepEqual` on those strings — so without this the
  // guard is structurally red on Windows and can only ever pass on the author's
  // platform. `Server Windows Tests` runs this file, and it caught exactly that
  // (`'handlers\\conversation-handlers.js'` vs `'handlers/conversation-handlers.js'`).
  // Same class as #5642 and the #6928 floor-resolver `split(sep)`: measure as
  // the CI account on the CI platform, not as yourself on yours.
  const rel = (f) => relative(SRC, f).split(sep).join('/')

  /**
   * Comments stripped. Without this the scan counts the wire-protocol JSDoc
   * roster in ws-server.js as a `history_replay_end` PRODUCER and the doc block
   * on `resendPendingQuestions` as a call — a guard that reports on prose is
   * satisfied (or broken) by prose.
   */
  const codeOnly = (src) =>
    src
      .split('\n')
      .filter((line) => {
        const t = line.trim()
        return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*')
      })
      .join('\n')

  // Counts SITES, not files: a file-level "contains a call" check is satisfied
  // for the whole file by the repair already in it, which is exactly how a
  // THIRD producer slipped into conversation-handlers.js green in #7340.
  //
  // An exact roster, not a threshold, because one `history_replay_end` producer
  // is legitimately EXEMPT and a >= rule cannot express that: the
  // `request_conversation_transcript` replay carries a conversationId in the
  // `sessionId` field, which is never a live session id, so both clients'
  // `updateSession` no-ops and their sweep touches nothing. A new producer
  // changes these numbers and goes red, which is the direction that matters.
  it('every replay-end that can sweep a live session re-sends its pending questions', () => {
    const counts = {}
    for (const file of allServerSources()) {
      const code = codeOnly(readFileSync(file, 'utf8'))
      const ends = (code.match(/\btype\s*:\s*['"`]history_replay_end['"`]/g) || []).length
      if (ends === 0) continue
      // CALLS only — the `export function resendPendingQuestions(` declaration
      // lives in ws-history.js and would otherwise count as its own repair.
      const all = (code.match(/\bresendPendingQuestions\s*\(/g) || []).length
      const decls = (code.match(/function\s+resendPendingQuestions\s*\(/g) || []).length
      counts[rel(file)] = { ends, resends: all - decls }
    }
    assert.deepEqual(counts, {
      // 2 ends: `request_full_history` (live session — re-sends) and
      // `request_conversation_transcript` (a closed on-disk conversation, no
      // live session, nothing to re-send).
      'handlers/conversation-handlers.js': { ends: 2, resends: 1 },
      // 1 end, from the ONE exit both the chunked and empty-slice paths share.
      'ws-history.js': { ends: 1, resends: 1 },
    })
  })
})
