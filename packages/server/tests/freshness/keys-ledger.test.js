import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { H, canonical } from '../../src/freshness/hash.js'
import {
  READ_NO,
  checkInvestigationKey,
  checkTickKey,
  configKey,
  itemIds,
  ownerAckKey,
  reportKey,
  surfaceKey,
  surfaceOrdinal,
  tickId,
} from '../../src/freshness/keys.js'
import { append, createLedger, loadLedger, verifyChain } from '../../src/freshness/ledger.js'
import { deriveState } from '../../src/freshness/derive.js'
import { DEFAULT_POLICY } from '../../src/freshness/policy.js'
import { runSequence } from './helpers/sequence.js'

const S1 = { source: 'chroxy', native_id: 's1', incarnation: 't0' }
const T = Date.parse('2026-01-05T00:00:00Z')

describe('keys', () => {
  it('are deterministic over canonical encoding (key order does not matter)', () => {
    assert.equal(canonical({ b: 1, a: [2, { d: 3, c: 4 }] }), canonical({ a: [2, { c: 4, d: 3 }], b: 1 }))
    assert.equal(H('x', { a: 1, b: 2 }), H('x', { b: 2, a: 1 }))
    assert.notEqual(H('x', 1), H('x', '1'))
  })

  it('a session label is never part of a key; the incarnation is', () => {
    const renamed = { ...S1, label: 'something else' }
    assert.equal(itemIds.declared(S1), itemIds.declared(renamed))
    assert.notEqual(itemIds.declared(S1), itemIds.declared({ ...S1, incarnation: 't1' }))
  })

  it('the same slot is the same tick; a different source or slot is not', () => {
    assert.equal(tickId('L', 'chroxy', 1000), tickId('L', 'chroxy', 1000))
    assert.notEqual(tickId('L', 'chroxy', 1000), tickId('L', 'codex', 1000))
    assert.notEqual(tickId('L', 'chroxy', 1000), tickId('L', 'chroxy', 2000))
  })

  it('the three reads of one investigation and the tick check have four distinct keys', () => {
    const tick = checkTickKey(tickId('L', 'chroxy', 0), S1)
    const ks = [READ_NO.REREAD, READ_NO.RETRY, READ_NO.CONFIRM_GONE].map((n) => checkInvestigationKey('inv', n))
    assert.equal(new Set([tick, ...ks]).size, 4)
  })

  it('ordinals follow the per-step table', () => {
    assert.equal(surfaceOrdinal('queued', {}), 0)
    assert.equal(surfaceOrdinal('shown', { presentation: 3 }), 3)
    assert.equal(surfaceOrdinal('reminded', { presentation: 3, k: 2 }), 2)
    assert.equal(surfaceOrdinal('returned', { presentation: 3 }), 1)
    assert.equal(surfaceOrdinal('deferred', { ackRef: 'm9' }), 'm9')
    assert.equal(surfaceOrdinal('updated', { changeRef: 'r2' }), 'r2')
    assert.throws(() => surfaceOrdinal('updated', {}))
  })

  it('a reminder key does not depend on the presentation: two reminders per episode however often shown', () => {
    const k1 = surfaceKey('item', 1, 'reminded', surfaceOrdinal('reminded', { presentation: 1, k: 1 }), 'attempt')
    const k1Later = surfaceKey('item', 1, 'reminded', surfaceOrdinal('reminded', { presentation: 2, k: 1 }), 'attempt')
    assert.equal(k1, k1Later)
  })

  it('two acknowledgments by two messages are two records; ack and verify of one message are two records', () => {
    assert.notEqual(ownerAckKey('i', 1, 'm1', 'ack'), ownerAckKey('i', 1, 'm2', 'ack'))
    assert.notEqual(ownerAckKey('i', 1, 'm1', 'ack'), ownerAckKey('i', 1, 'm1', 'verify'))
  })

  it('a configuration change back to an earlier one is a new record', () => {
    const a = configKey(null, 'hashA')
    const b = configKey(a, 'hashB')
    const a2 = configKey(b, 'hashA')
    const b2 = configKey(a2, 'hashB')
    assert.equal(new Set([a, b, a2, b2]).size, 4)
  })

  it('keys of different records in a generated ledger never collide across kinds', () => {
    const r = runSequence(3, { steps: 150, probe: false })
    assert.ok(r.ok)
    const ids = r.harness.ctx.ledger.records.map((x) => x.id)
    assert.equal(new Set(ids).size, ids.length)
  })
})

describe('ledger', () => {
  const draft = (body) => ({ kind: 'report', id: reportKey(S1, T, 'f'), session: S1, body })

  it('same key and same payload is ignored, even when written later', () => {
    const l = createLedger({ ledgerId: 'L' })
    assert.equal(append(l, draft({ a: 1 }), T).status, 'appended')
    assert.equal(append(l, draft({ a: 1 }), T + 60_000).status, 'duplicate')
    assert.equal(l.records.length, 1)
  })

  it('same key and different payload yields one idempotency_conflict record and no effect', () => {
    const l = createLedger({ ledgerId: 'L' })
    append(l, draft({ a: 1 }), T)
    const r = append(l, draft({ a: 2 }), T)
    assert.equal(r.status, 'conflict')
    assert.equal(l.records.length, 2)
    assert.equal(l.records[1].kind, 'system')
    assert.equal(l.records[1].body.event, 'idempotency_conflict')
    assert.deepEqual(l.records[0].body, { a: 1 })
    // The same conflict seen again adds nothing.
    append(l, draft({ a: 3 }), T)
    assert.equal(l.records.length, 2)
  })

  it('keeps one hash chain, and rebuilds index and derived state from records alone', () => {
    const r = runSequence(5, { steps: 120, probe: false })
    const l = r.harness.ctx.ledger
    assert.equal(verifyChain(l), 0)
    const reloaded = loadLedger({ ledgerId: l.ledgerId, records: l.records })
    assert.equal(reloaded.byKey.size, l.byKey.size)
    const a = deriveState(l.records, DEFAULT_POLICY)
    const live = r.harness.ctx.state
    assert.deepEqual(
      [...a.items.values()].map((i) => [i.itemId, i.open, i.state, i.episode, i.counters]),
      [...live.items.values()].map((i) => [i.itemId, i.open, i.state, i.episode, i.counters]),
    )
  })
})
