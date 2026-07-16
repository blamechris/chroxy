import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { runTokensList, runTokensRevoke } from '../src/cli/tokens-cmd.js'

// In-memory session-token store fake matching the { load, save } adapter shape.
function fakeStore(initial = []) {
  let entries = initial.map((e) => [e[0], { ...e[1] }])
  return {
    load: () => entries.map((e) => [e[0], { ...e[1] }]),
    save: (next) => { entries = next.map((e) => [e[0], { ...e[1] }]) },
    _current: () => entries,
  }
}

// Capture writer.
function cap() {
  const lines = []
  return { write: (s) => lines.push(String(s)), lines, text: () => lines.join('\n') }
}

const NOW = 1_800_000_000_000

describe('chroxy tokens — list (#6599)', () => {
  it('reports an empty store without leaking anything', () => {
    const w = cap()
    const res = runTokensList({ store: fakeStore([]), write: w.write, now: NOW })
    assert.equal(res.count, 0)
    assert.deepEqual(res.tokens, [])
    assert.match(w.text(), /No paired session tokens/)
  })

  it('lists entries by 12-char handle, session, and age — never the full token', () => {
    const token = 'abcdefghijklmNOPQRSTUVWXYZ0123456789fulltoken'
    const w = cap()
    const res = runTokensList({
      store: fakeStore([[token, { createdAt: NOW - 3 * 3600_000, sessionId: 'sess-1' }]]),
      write: w.write,
      now: NOW,
    })
    assert.equal(res.count, 1)
    assert.equal(res.tokens[0].handle, 'abcdefghijkl')
    assert.equal(res.tokens[0].sessionId, 'sess-1')
    // full token must never appear in the output
    assert.ok(!w.text().includes(token), 'full token is never printed')
    assert.match(w.text(), /abcdefghijkl….*session=sess-1.*age=3h/)
  })

  it('handles a missing sessionId / createdAt gracefully', () => {
    const w = cap()
    const res = runTokensList({
      store: fakeStore([['tok0000000000rest', {}]]),
      write: w.write,
      now: NOW,
    })
    assert.equal(res.tokens[0].sessionId, '(none)')
    assert.equal(res.tokens[0].ageMs, null)
    assert.match(w.text(), /age=unknown/)
  })
})

describe('chroxy tokens — revoke one (#6599)', () => {
  let store
  const A = 'aaaa1111bbbb2222cccc'
  const B = 'bbbb3333dddd4444eeee'
  beforeEach(() => {
    store = fakeStore([[A, { createdAt: NOW, sessionId: 's-a' }], [B, { createdAt: NOW, sessionId: 's-b' }]])
  })

  it('revokes exactly the matching token by unique prefix and persists the rest', () => {
    const w = cap()
    const res = runTokensRevoke('aaaa1111', {}, { store, write: w.write })
    assert.deepEqual(res, { revoked: 1, mode: 'one', confirmed: true })
    const remaining = store._current().map(([t]) => t)
    assert.deepEqual(remaining, [B], 'only the non-matching token remains')
    assert.match(w.text(), /Revoked 1 session token/)
    assert.match(w.text(), /Restart the daemon to enforce/)
  })

  it('refuses an ambiguous prefix without revoking anything', () => {
    const s = fakeStore([['pre_a_xxxx', { createdAt: NOW }], ['pre_b_yyyy', { createdAt: NOW }]])
    const w = cap()
    const res = runTokensRevoke('pre_', {}, { store: s, write: w.write })
    assert.equal(res.error, 'ambiguous')
    assert.equal(res.matches, 2)
    assert.equal(res.revoked, 0)
    assert.equal(s._current().length, 2, 'nothing revoked on an ambiguous prefix')
    assert.match(w.text(), /use a longer handle prefix/)
  })

  it('reports no-match without touching the store', () => {
    const w = cap()
    const res = runTokensRevoke('zzzz', {}, { store, write: w.write })
    assert.equal(res.error, 'no-match')
    assert.equal(store._current().length, 2)
    assert.match(w.text(), /No session token matches/)
  })

  it('errors when no handle and no --all is given', () => {
    const w = cap()
    const res = runTokensRevoke(undefined, {}, { store, write: w.write })
    assert.equal(res.error, 'no-target')
    assert.equal(store._current().length, 2)
  })
})

describe('chroxy tokens — revoke --all (#6599)', () => {
  it('requires --yes: explains and changes nothing without it', () => {
    const store = fakeStore([['t1aaaa', { createdAt: NOW }], ['t2bbbb', { createdAt: NOW }]])
    const w = cap()
    const res = runTokensRevoke(undefined, { all: true }, { store, write: w.write })
    assert.deepEqual(res, { revoked: 0, mode: 'all', confirmed: false })
    assert.equal(store._current().length, 2, 'no-op without --yes')
    assert.match(w.text(), /re-run with --yes/)
    assert.match(w.text(), /panic button/)
  })

  it('with --yes clears the whole store (panic button)', () => {
    const store = fakeStore([['t1aaaa', { createdAt: NOW }], ['t2bbbb', { createdAt: NOW }]])
    const w = cap()
    const res = runTokensRevoke(undefined, { all: true, yes: true }, { store, write: w.write })
    assert.deepEqual(res, { revoked: 2, mode: 'all', confirmed: true })
    assert.equal(store._current().length, 0, 'every token revoked')
    assert.match(w.text(), /Revoked all 2 session token/)
  })

  it('--all --yes on an empty store is a safe no-op reporting 0', () => {
    const store = fakeStore([])
    const w = cap()
    const res = runTokensRevoke(undefined, { all: true, yes: true }, { store, write: w.write })
    assert.equal(res.revoked, 0)
    assert.equal(store._current().length, 0)
  })
})
