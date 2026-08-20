import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scopeConversationsToClient } from '../src/conversation-scope.js'
import { nsCtx } from './test-helpers.js'

/**
 * Unit tests for conversation-scope — Adversary A8 fix (2026-04-11
 * audit). Closes the `list_conversations` / `search_conversations`
 * global-reveal attack by scoping the result set to the bound
 * session's cwd.
 */

function makeCtx(sessionsByCwd) {
  return nsCtx({
    sessionManager: {
      getSession(id) {
        if (!id || !(id in sessionsByCwd)) return null
        return { cwd: sessionsByCwd[id] }
      },
    },
  })
}

describe('scopeConversationsToClient', () => {
  const conversations = [
    { conversationId: 'a', cwd: '/home/dev/Projects/chroxy' },
    { conversationId: 'b', cwd: '/home/dev/Projects/chroxy/packages/server' },
    { conversationId: 'c', cwd: '/home/dev/Projects/other-repo' },
    { conversationId: 'd', cwd: '/home/dev/.ssh' },
    { conversationId: 'e', cwd: null },
  ]

  it('returns the full list for unbound clients', () => {
    const client = { boundSessionId: null }
    const ctx = makeCtx({})
    const result = scopeConversationsToClient(conversations, client, ctx)
    assert.equal(result.length, conversations.length)
  })

  it('filters to bound session cwd exact match and subdirectories', () => {
    const client = { boundSessionId: 's1' }
    const ctx = makeCtx({ s1: '/home/dev/Projects/chroxy' })
    const result = scopeConversationsToClient(conversations, client, ctx)
    const ids = result.map((c) => c.conversationId).sort()
    assert.deepEqual(ids, ['a', 'b'], 'chroxy + packages/server are allowed, others rejected')
  })

  it('rejects conversations in a sibling directory with the same prefix', () => {
    const client = { boundSessionId: 's1' }
    const ctx = makeCtx({ s1: '/home/dev/Projects/chrox' })
    const result = scopeConversationsToClient(conversations, client, ctx)
    // /home/dev/Projects/chroxy must NOT match /home/dev/Projects/chrox
    assert.deepEqual(result, [], 'prefix collision with sibling dir must not match')
  })

  it('fails closed when bound session has no cwd', () => {
    const client = { boundSessionId: 's-missing' }
    const ctx = makeCtx({}) // session not found
    const result = scopeConversationsToClient(conversations, client, ctx)
    assert.deepEqual(result, [])
  })

  it('fails closed when bound session cwd is not a string', () => {
    const client = { boundSessionId: 's1' }
    const ctx = nsCtx({
      sessionManager: {
        getSession: () => ({ cwd: undefined }),
      },
    })
    const result = scopeConversationsToClient(conversations, client, ctx)
    assert.deepEqual(result, [])
  })

  it('skips conversations with null/missing cwd even when bound', () => {
    const client = { boundSessionId: 's1' }
    const ctx = makeCtx({ s1: '/home/dev/Projects/chroxy' })
    const result = scopeConversationsToClient(conversations, client, ctx)
    assert.ok(!result.some((c) => c.cwd == null))
  })

  it('handles non-array input defensively', () => {
    assert.deepEqual(scopeConversationsToClient(null, {}, {}), [])
    assert.deepEqual(scopeConversationsToClient(undefined, {}, {}), [])
  })

  it('handles missing sessionManager on ctx', () => {
    const client = { boundSessionId: 's1' }
    const result = scopeConversationsToClient(conversations, client, {})
    assert.deepEqual(result, [], 'no sessionManager → fail closed for bound client')
  })

  // #7273 — the containment predicate REFUSES a non-absolute path rather than
  // silently resolving it against the server process's cwd. Both arguments here
  // come from outside: `conv.cwd` is read out of a JSONL record on disk and
  // `entry.cwd` off a session record. Without these guards the predicate throws
  // out of a WS handler; with them the filter fails closed. Neither direction is
  // observable from the existing cases, all of which pass absolute paths.
  it('fails closed when the BOUND SESSION cwd is not absolute', () => {
    const client = { boundSessionId: 's1' }
    const ctx = makeCtx({ s1: 'relative/not/absolute' })
    assert.deepEqual(
      scopeConversationsToClient(conversations, client, ctx), [],
      'an unplaceable bound cwd must reveal nothing, not throw')
  })

  it('drops a conversation whose recorded cwd is not absolute, and keeps the rest', () => {
    const client = { boundSessionId: 's1' }
    const ctx = makeCtx({ s1: '/home/dev/Projects/chroxy' })
    const convs = [
      { id: 'ok', cwd: '/home/dev/Projects/chroxy/packages/server' },
      { id: 'bad', cwd: 'Projects/chroxy/relative' },
    ]
    const result = scopeConversationsToClient(convs, client, ctx)
    assert.deepEqual(result.map((c) => c.id), ['ok'],
      'the unplaceable row is dropped; the placeable one still comes through')
  })
})
