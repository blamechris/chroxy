import { describe, it, beforeEach } from 'node:test'
import assert from 'node:assert/strict'
import { runTokensList, runTokensRevoke } from '../src/cli/tokens-cmd.js'

// In-memory session-token store fake matching the { load, loadResult, exists,
// save } adapter shape. `opts.status` forces an 'unreadable' result; `opts.saveOk
// = false` simulates a persist failure.
function fakeStore(initial = [], opts = {}) {
  let entries = initial.map((e) => [e[0], { ...e[1] }])
  const status = opts.status || 'ok'
  const saveOk = opts.saveOk !== false
  return {
    load: () => entries.map((e) => [e[0], { ...e[1] }]),
    loadResult: () => ({
      status,
      entries: status === 'unreadable' ? [] : entries.map((e) => [e[0], { ...e[1] }]),
    }),
    exists: () => status !== 'absent',
    save: (next) => {
      if (!saveOk) return false
      entries = next.map((e) => [e[0], { ...e[1] }])
      return true
    },
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

  it('does not crash on a corrupt-but-array store (non-tuple row shown as malformed)', () => {
    // A hand-edited store could decode to an array containing a non-tuple element.
    const w = cap()
    const store = fakeStore([])
    // Inject malformed rows past the tuple-cloning constructor via loadResult.
    store.loadResult = () => ({ status: 'ok', entries: [['good00000000_secret', { createdAt: NOW, sessionId: 's' }], 'not-a-tuple', [42]] })
    const res = runTokensList({ store, write: w.write, now: NOW })
    assert.equal(res.count, 3)
    assert.equal(res.tokens[0].handle, 'good00000000')
    assert.equal(res.tokens[1].handle, '(malformed)')
    assert.equal(res.tokens[2].handle, '(malformed)')
  })

  it('an UNREADABLE store is reported as an error, never as "empty"', () => {
    const w = cap()
    // A present-but-unreadable store (bad perms / no keychain key / corrupt) must
    // not masquerade as "no tokens".
    const res = runTokensList({ store: fakeStore([['tok', { createdAt: NOW }]], { status: 'unreadable' }), write: w.write, now: NOW })
    assert.equal(res.error, 'unreadable')
    assert.equal(res.count, 0)
    assert.match(w.text(), /could not be read/)
    assert.doesNotMatch(w.text(), /No paired session tokens/)
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

  it('an EMPTY-STRING target is refused (no-target) and never wipes a single-token store', () => {
    // The `if (!target)` guard is load-bearing: '' would otherwise match every
    // token via startsWith(''), and on a single-token store revoke exactly one.
    const single = fakeStore([['only1token', { createdAt: NOW }]])
    const w = cap()
    const res = runTokensRevoke('', {}, { store: single, write: w.write })
    assert.equal(res.error, 'no-target')
    assert.equal(res.revoked, 0)
    assert.equal(single._current().length, 1, 'the single token survives an empty target')
  })

  it('refuses to revoke against an UNREADABLE store (never overwrites it)', () => {
    const s = fakeStore([[A, { createdAt: NOW }]], { status: 'unreadable' })
    const w = cap()
    const res = runTokensRevoke('aaaa', {}, { store: s, write: w.write })
    assert.equal(res.error, 'unreadable')
    assert.equal(s._current().length, 1, 'the unreadable store is left intact')
  })

  it('reports persist-failure instead of a false success', () => {
    const s = fakeStore([[A, { createdAt: NOW }], [B, { createdAt: NOW }]], { saveOk: false })
    const w = cap()
    const res = runTokensRevoke('aaaa1111', {}, { store: s, write: w.write })
    assert.equal(res.error, 'persist-failed')
    assert.equal(res.revoked, 0)
    assert.match(w.text(), /Failed to write/)
  })

  it('a targeted revoke preserves a malformed row (never drops or crashes on it)', () => {
    const store = fakeStore([])
    let saved = null
    store.loadResult = () => ({ status: 'ok', entries: [['keepme00_secret', { createdAt: NOW }], 'not-a-tuple', ['dropme00_secret', { createdAt: NOW }]] })
    store.save = (next) => { saved = next; return true }
    const w = cap()
    const res = runTokensRevoke('dropme00', {}, { store, write: w.write })
    assert.equal(res.revoked, 1)
    // the real token is dropped; the good one AND the malformed row are preserved
    assert.deepEqual(saved.map((e) => (Array.isArray(e) ? e[0] : e)), ['keepme00_secret', 'not-a-tuple'])
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

  it('--all --yes REFUSES to overwrite a present-but-unreadable store (the key footgun)', () => {
    // Two real tokens the CLI can't decrypt. A naive load()->[] + save([]) would
    // destroy them and report "0". loadResult()==='unreadable' must block the wipe.
    const s = fakeStore([['t1aaaa', { createdAt: NOW }], ['t2bbbb', { createdAt: NOW }]], { status: 'unreadable' })
    const w = cap()
    const res = runTokensRevoke(undefined, { all: true, yes: true }, { store: s, write: w.write })
    assert.equal(res.error, 'unreadable')
    assert.equal(res.revoked, 0)
    assert.equal(s._current().length, 2, 'the unreadable store is NOT overwritten')
    assert.match(w.text(), /could not be read/)
  })

  it('--all --yes reports persist-failure instead of a false success', () => {
    const s = fakeStore([['t1aaaa', { createdAt: NOW }]], { saveOk: false })
    const w = cap()
    const res = runTokensRevoke(undefined, { all: true, yes: true }, { store: s, write: w.write })
    assert.equal(res.error, 'persist-failed')
    assert.match(w.text(), /Failed to write/)
  })
})
