import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { scopeConversationsToClient } from '../src/conversation-scope.js'

/**
 * Unit tests for conversation-scope — Adversary A8 fix (2026-04-11
 * audit). Closes the `list_conversations` / `search_conversations`
 * global-reveal attack by scoping the result set to the bound
 * session's cwd.
 */

function makeCtx(sessionsByCwd) {
  return {
    sessionManager: {
      getSession(id) {
        if (!id || !(id in sessionsByCwd)) return null
        return { cwd: sessionsByCwd[id] }
      },
    },
  }
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
    const ctx = {
      sessionManager: {
        getSession: () => ({ cwd: undefined }),
      },
    }
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
})
