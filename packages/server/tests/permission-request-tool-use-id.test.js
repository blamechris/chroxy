import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { createServer } from 'node:http'
import http from 'node:http'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createPermissionHandler } from '../src/ws-permissions.js'
import { ClaudeTuiSession } from '../src/claude-tui-session.js'
import { SessionMessageHistory } from '../src/session-message-history.js'
import { SessionManager } from '../src/session-manager.js'
import { buildPermissionRequestMessage } from '@chroxy/protocol'

/**
 * #8357 -- the id that pairs an AskUserQuestion permission with its question card.
 *
 * A client used to guess the pairing from arrival order, which breaks the moment
 * one card or permission has no partner (an auto-mode card, a multi-question form
 * the hook denies before any prompt, a trimmed history). The daemon now puts the
 * provider's `toolUseId` on BOTH frames: `user_question` has always carried it,
 * and the hook-routed `permission_request` now does too, read from the same hook
 * payload field. It rides the pending-permission stash (the reconnect resend) and
 * the journaled `permission_outcome` (the history replay).
 */

function postJson(port, body) {
  return new Promise((resolvePromise, reject) => {
    const data = JSON.stringify(body)
    const req = http.request({
      port,
      path: '/permission',
      method: 'POST',
      agent: false,
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        Authorization: 'Bearer test-secret',
      },
    }, (res) => {
      let raw = ''
      res.on('data', (c) => { raw += c })
      res.on('end', () => resolvePromise({ status: res.statusCode, body: raw ? JSON.parse(raw) : null }))
    })
    req.on('error', reject)
    req.write(data)
    req.end()
  })
}

async function startDaemon({ resend = false } = {}) {
  const prompts = []
  const resent = []
  const noted = []
  const pendingPermissions = new Map()
  const handler = createPermissionHandler({
    sendFn: (ws, msg) => { if (msg?.type === 'permission_request') resent.push(msg) },
    broadcastFn: (msg) => {
      if (msg?.type !== 'permission_request') return
      prompts.push(msg)
      setTimeout(() => {
        if (resend) handler.resendPendingPermissions({}, { id: 'reconnecting-client' })
        handler.resolvePermission(msg.requestId, 'deny')
      }, 0)
    },
    validateBearerAuth: () => true,
    validateHookAuth: () => true,
    pushManager: null,
    pendingPermissions,
    permissionSessionMap: new Map(),
    getSessionManager: () => ({ notePermissionRequest: (sid, req) => noted.push({ sid, req }) }),
    pairingManager: null,
    findSessionByHookSecret: (secret) => (secret === 'test-secret' ? { session: { cwd: '/work/p' }, sessionId: 'sess-1' } : null),
  })
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url === '/permission') { handler.handlePermissionRequest(req, res); return }
    res.writeHead(404); res.end('{}')
  })
  await new Promise((r) => server.listen(0, r))
  return {
    port: server.address().port,
    prompts,
    resent,
    noted,
    close: async () => {
      handler.destroy()
      server.closeAllConnections()
      await new Promise((r) => server.close(r))
    },
  }
}

const ASK = { questions: [{ question: 'Red or blue?', options: [{ label: 'Red' }, { label: 'Blue' }] }] }

describe('#8357 hook-routed permission_request carries the tool-use id', () => {
  it('the live frame carries the hook payload\'s tool_use_id as toolUseId', async () => {
    const d = await startDaemon()
    try {
      await postJson(d.port, { tool_name: 'AskUserQuestion', tool_input: ASK, tool_use_id: 'toolu_abc' })
      assert.equal(d.prompts.length, 1)
      assert.equal(d.prompts[0].toolUseId, 'toolu_abc')
    } finally { await d.close() }
  })

  it('a reconnect resend replays the same id', async () => {
    const d = await startDaemon({ resend: true })
    try {
      await postJson(d.port, { tool_name: 'AskUserQuestion', tool_input: ASK, tool_use_id: 'toolu_abc' })
      assert.equal(d.resent.length, 1, 'the pending prompt must have been resent')
      assert.equal(d.resent[0].toolUseId, 'toolu_abc')
    } finally { await d.close() }
  })

  it('the transcript registry is told the id, so the replayed outcome can carry it', async () => {
    const d = await startDaemon()
    try {
      await postJson(d.port, { tool_name: 'AskUserQuestion', tool_input: ASK, tool_use_id: 'toolu_abc' })
      assert.equal(d.noted.length, 1)
      assert.equal(d.noted[0].req.toolUseId, 'toolu_abc')
    } finally { await d.close() }
  })

  for (const [label, extra] of [
    ['absent', {}],
    ['empty', { tool_use_id: '' }],
    ['not a string', { tool_use_id: 7 }],
    ['over 200 characters', { tool_use_id: 'x'.repeat(201) }],
  ]) {
    it(`claims no id when the payload's is ${label} (the key is omitted, not null)`, async () => {
      const d = await startDaemon({ resend: true })
      try {
        await postJson(d.port, { tool_name: 'AskUserQuestion', tool_input: ASK, ...extra })
        assert.equal('toolUseId' in d.prompts[0], false)
        assert.equal('toolUseId' in d.resent[0], false)
      } finally { await d.close() }
    })
  }
})

describe('#8357 the same id reaches user_question from the same hook payload field', () => {
  let session
  let skillsDir
  beforeEach(() => {
    skillsDir = mkdtempSync(join(tmpdir(), 'chroxy-tui-skills-'))
    session = new ClaudeTuiSession({ cwd: tmpdir(), skillsDir, repoSkillsDir: null })
    session.on('error', () => {})
    session._activeTurn = { messageId: 'msg-1', startedAt: Date.now(), aborted: false, synthSeq: 0 }
    session._isBusy = true
    session._currentMessageId = 'msg-1'
  })
  afterEach(async () => {
    try { await session?.destroy() } catch { /* ignore */ }
    rmSync(skillsDir, { recursive: true, force: true })
  })

  it('user_question.toolUseId equals the tool_use_id the permission hook posts for the same call', () => {
    const questions = []
    session.on('user_question', (q) => questions.push(q))
    const payload = { tool_name: 'AskUserQuestion', tool_use_id: 'toolu_abc', tool_input: ASK }
    session._emitToolHookEvent('PreToolUse', payload, 'msg-1')
    assert.equal(questions.length, 1)
    assert.equal(questions[0].toolUseId, payload.tool_use_id)
  })
})

describe('#8357 protocol builder', () => {
  const base = { requestId: 'r', tool: 'AskUserQuestion', input: {}, floored: false }
  it('keeps toolUseId when given and omits the key when not', () => {
    assert.equal(buildPermissionRequestMessage({ ...base, toolUseId: 't1' }).toolUseId, 't1')
    assert.equal('toolUseId' in buildPermissionRequestMessage(base), false)
  })
  it('rejects a non-string toolUseId', () => {
    assert.throws(() => buildPermissionRequestMessage({ ...base, toolUseId: 5 }), /toolUseId/)
  })
})

describe('#8357 the journaled permission_outcome keeps the id', () => {
  it('SessionMessageHistory records it, bounded, and omits it when there is none', () => {
    const history = new SessionMessageHistory()
    const base = { tool: 'AskUserQuestion', description: 'd' }
    history.recordHistory('s1', 'permission_outcome', { ...base, requestId: 'a', outcome: 'allowed', toolUseId: 'toolu_abc' })
    history.recordHistory('s1', 'permission_outcome', { ...base, requestId: 'b', outcome: 'denied' })
    history.recordHistory('s1', 'permission_outcome', { ...base, requestId: 'c', outcome: 'denied', toolUseId: 'x'.repeat(201) })
    const byId = Object.fromEntries(history.getHistory('s1').map((e) => [e.requestId, e]))
    assert.equal(byId.a.toolUseId, 'toolu_abc')
    assert.equal('toolUseId' in byId.b, false)
    assert.equal('toolUseId' in byId.c, false)
  })

  it('SessionManager.notePermissionRequest + recordPermissionOutcome carry it into the entry', () => {
    const recorded = []
    const fake = {
      _permissionRequests: new Map(),
      _sessions: new Map([['s1', {}]]),
      _recordHistory: (sid, kind, data) => recorded.push({ sid, kind, data }),
    }
    SessionManager.prototype.notePermissionRequest.call(fake, 's1', { requestId: 'a', tool: 'AskUserQuestion', description: 'd', input: {}, toolUseId: 'toolu_abc' })
    assert.equal(SessionManager.prototype.recordPermissionOutcome.call(fake, 'a', 'allowed', 'allow'), true)
    assert.equal(recorded[0].data.toolUseId, 'toolu_abc')
  })
})
