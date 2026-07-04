import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { settingsHandlers } from '../src/handlers/settings-handlers.js'
import { createSpy, nsCtx } from './test-helpers.js'
import { ServerPermissionInputSchema } from '@chroxy/protocol'

/**
 * #6543 (IDE P3 feature B) — `get_permission_input` handler. The security-
 * critical contract: it returns the FULL secret-redacted tool input ONLY to a
 * client authorized for the owning session (same gate as permission_response),
 * and NEVER leaks another session's input. Un-truncated (larger cap) so a
 * pre-write diff is complete; secrets are still stripped.
 */

const SECRET = 'sk-ant-api03-' + 'x'.repeat(95)
const BIG_CONTENT = 'const line = 1\n'.repeat(1500) // ~22K chars — exceeds the 10K broadcast cap

// A session whose PermissionManager (back-compat accessors) holds a pending
// Write permission for `req-1`, with a secret embedded in the content.
function makeSession() {
  return {
    session: {
      _pendingPermissions: new Map([
        ['req-1', { input: { file_path: '/repo/x.js', content: `${BIG_CONTENT}\n// token=${SECRET}` }, resolve: () => {} }],
      ]),
      _lastPermissionData: new Map([['req-1', { tool: 'Write' }]]),
    },
  }
}

function makeCtx({ mapEntry = ['req-1', 'sess-1'] } = {}) {
  const send = createSpy()
  return nsCtx({
    send,
    permissionSessionMap: new Map(mapEntry ? [mapEntry] : []),
    sessionManager: { getSession: (sid) => (sid === 'sess-1' ? makeSession() : undefined) },
    _send: send,
  })
}

function lastSent(ctx) {
  return ctx.transport.send.lastCall[1]
}

describe('get_permission_input handler (#6543)', () => {
  it('is registered in settingsHandlers', () => {
    assert.equal(typeof settingsHandlers.get_permission_input, 'function')
  })

  it('returns the FULL redacted input to a viewer of the owning session', () => {
    const ctx = makeCtx()
    // unbound client actively viewing sess-1 (isSessionViewer)
    settingsHandlers.get_permission_input({}, { id: 'c1', activeSessionId: 'sess-1' }, { type: 'get_permission_input', requestId: 'req-1' }, ctx)
    const msg = lastSent(ctx)
    assert.equal(msg.type, 'permission_input')
    assert.equal(msg.found, true)
    assert.equal(msg.tool, 'Write')
    // secret stripped
    assert.ok(!JSON.stringify(msg.input).includes(SECRET), 'the API key must be redacted out')
    assert.ok(JSON.stringify(msg.input).includes('[REDACTED'), 'redaction marker present')
    // NOT truncated at the 10K broadcast cap — the big content survives for the diff
    assert.ok(msg.input.content.length > 15000, 'content is not truncated at the broadcast cap')
    assert.equal(msg.input.file_path, '/repo/x.js')
    assert.ok(ServerPermissionInputSchema.safeParse(msg).success)
  })

  it('returns found:true for a bound client that OWNS the session', () => {
    const ctx = makeCtx()
    settingsHandlers.get_permission_input({}, { id: 'c1', boundSessionId: 'sess-1' }, { type: 'get_permission_input', requestId: 'req-1' }, ctx)
    assert.equal(lastSent(ctx).found, true)
  })

  it('LEAKS NOTHING to a bound client of a DIFFERENT session', () => {
    const ctx = makeCtx()
    settingsHandlers.get_permission_input({}, { id: 'c2', boundSessionId: 'other-session' }, { type: 'get_permission_input', requestId: 'req-1' }, ctx)
    const msg = lastSent(ctx)
    assert.equal(msg.found, false)
    assert.equal(msg.input, undefined, 'no input for a cross-session client')
    assert.ok(ServerPermissionInputSchema.safeParse(msg).success)
  })

  it('LEAKS NOTHING to an unbound client that is not a viewer of the session', () => {
    const ctx = makeCtx()
    settingsHandlers.get_permission_input({}, { id: 'c3', activeSessionId: 'unrelated', subscribedSessionIds: new Set() }, { type: 'get_permission_input', requestId: 'req-1' }, ctx)
    const msg = lastSent(ctx)
    assert.equal(msg.found, false)
    assert.equal(msg.input, undefined)
  })

  it('found:false for an unknown requestId (no session mapping)', () => {
    const ctx = makeCtx({ mapEntry: null })
    settingsHandlers.get_permission_input({}, { id: 'c1', activeSessionId: 'sess-1' }, { type: 'get_permission_input', requestId: 'nope' }, ctx)
    assert.equal(lastSent(ctx).found, false)
  })

  it('found:false (NOT_PENDING) when the session no longer holds the request', () => {
    const send = createSpy()
    const ctx = nsCtx({
      send,
      permissionSessionMap: new Map([['req-1', 'sess-1']]),
      // session exists but its pending map is empty (resolved/expired)
      sessionManager: { getSession: () => ({ session: { _pendingPermissions: new Map(), _lastPermissionData: new Map() } }) },
      _send: send,
    })
    settingsHandlers.get_permission_input({}, { id: 'c1', activeSessionId: 'sess-1' }, { type: 'get_permission_input', requestId: 'req-1' }, ctx)
    const msg = ctx.transport.send.lastCall[1]
    assert.equal(msg.found, false)
    assert.equal(msg.error.code, 'NOT_PENDING')
  })

  it('#6551 — memoizes the redacted pull on the pending entry (no re-serialization per repeat pull)', () => {
    // A STABLE session (getSession returns the SAME object) so the memo stored on
    // the pending entry survives across calls — makeCtx() rebuilds the session per
    // call, which would defeat the memo.
    const { session } = makeSession()
    const send = createSpy()
    const ctx = nsCtx({
      send,
      permissionSessionMap: new Map([['req-1', 'sess-1']]),
      sessionManager: { getSession: (sid) => (sid === 'sess-1' ? { session } : undefined) },
      _send: send,
    })
    const pull = () => {
      settingsHandlers.get_permission_input({}, { id: 'c1', activeSessionId: 'sess-1' }, { type: 'get_permission_input', requestId: 'req-1' }, ctx)
      return ctx.transport.send.lastCall[1].input
    }

    const first = pull()
    const second = pull()

    // Reference-identical → the second pull reused the memoized redaction instead
    // of a fresh redactDeep tree-walk + JSON.stringify. (Without the memo,
    // sanitizeToolInput returns a NEW object each call.)
    assert.strictEqual(first, second, 'repeated pulls return the SAME redacted object (memoized)')
    // The memo lives on the pending entry, so it auto-invalidates when the entry
    // is deleted on resolve/timeout/abort.
    assert.ok(session._pendingPermissions.get('req-1')._redactedPull !== undefined, 'redacted pull cached on the pending entry')
    // Security is unaffected — the cached value is still fully redacted.
    assert.ok(!JSON.stringify(first).includes(SECRET), 'the memoized pull is still redacted')
  })

  it('#6551 — a WARM memo is still authorization-gated (the cache never bypasses the viewer/owner check)', () => {
    const { session } = makeSession()
    const send = createSpy()
    const ctx = nsCtx({
      send,
      permissionSessionMap: new Map([['req-1', 'sess-1']]),
      sessionManager: { getSession: (sid) => (sid === 'sess-1' ? { session } : undefined) },
      _send: send,
    })

    // An authorized viewer pulls first → the memo is populated.
    settingsHandlers.get_permission_input({}, { id: 'c1', activeSessionId: 'sess-1' }, { type: 'get_permission_input', requestId: 'req-1' }, ctx)
    assert.equal(ctx.transport.send.lastCall[1].found, true)
    assert.ok(session._pendingPermissions.get('req-1')._redactedPull !== undefined, 'memo is warm')

    // A DIFFERENT client bound to another session pulls the SAME requestId. The
    // authority gate must reject it BEFORE the memo is served — the warm cache
    // must not leak the input to an unauthorized client.
    settingsHandlers.get_permission_input({}, { id: 'c2', boundSessionId: 'other-session' }, { type: 'get_permission_input', requestId: 'req-1' }, ctx)
    const msg = ctx.transport.send.lastCall[1]
    assert.equal(msg.found, false, 'unauthorized client gets found:false even with a warm memo')
    assert.equal(msg.input, undefined, 'no cached input leaks to the unauthorized client')
  })
})
