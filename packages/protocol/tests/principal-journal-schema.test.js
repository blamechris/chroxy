import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import {
  PrincipalSubscribeSchema, PrincipalUnsubscribeSchema, PrincipalEventsReadSchema, ClientMessageSchema,
  ServerPrincipalSubscribedSchema, ServerPrincipalEventSchema, ServerPrincipalLiveFenceSchema,
  ServerPrincipalGapFrameSchema, ServerPrincipalEventsPageSchema, PRINCIPAL_GAP_REASON_VALUES,
} from '../src/schemas/index.ts'

const cursor = { sessionId: 's', journalId: 'j', seq: 3 }

describe('principal journal client schemas (#9118)', () => {
  it('each is a member of the client message union', () => {
    const types = ClientMessageSchema.options.map((o) => o.shape.type.value)
    for (const t of ['principal_subscribe', 'principal_unsubscribe', 'principal_events_read']) assert.ok(types.includes(t), t)
  })

  it('subscribe: needs a requestId and at least one session id, caps the lists, accepts cursors', () => {
    const ok = { type: 'principal_subscribe', requestId: 'r', sessionIds: ['s'], cursors: [cursor] }
    assert.equal(PrincipalSubscribeSchema.safeParse(ok).success, true)
    assert.equal(PrincipalSubscribeSchema.safeParse({ ...ok, requestId: undefined }).success, false)
    assert.equal(PrincipalSubscribeSchema.safeParse({ ...ok, requestId: '' }).success, false)
    assert.equal(PrincipalSubscribeSchema.safeParse({ ...ok, sessionIds: [] }).success, false)
    assert.equal(PrincipalSubscribeSchema.safeParse({ ...ok, sessionIds: new Array(33).fill('s') }).success, false)
    assert.equal(PrincipalSubscribeSchema.safeParse({ ...ok, cursors: [{ ...cursor, seq: -1 }] }).success, false)
    assert.equal(PrincipalSubscribeSchema.safeParse({ ...ok, cursors: [{ ...cursor, seq: 1.5 }] }).success, false)
  })

  it('events_read: a page limit above 200 is refused by the schema, 200 is accepted', () => {
    const ok = { type: 'principal_events_read', requestId: 'r', sessionId: 's', limit: 200 }
    assert.equal(PrincipalEventsReadSchema.safeParse(ok).success, true)
    assert.equal(PrincipalEventsReadSchema.safeParse({ ...ok, limit: 201 }).success, false)
    assert.equal(PrincipalEventsReadSchema.safeParse({ ...ok, limit: 0 }).success, false)
    assert.equal(PrincipalEventsReadSchema.safeParse({ ...ok, cursor }).success, true)
  })

  it('unsubscribe: both fields are optional', () => {
    assert.equal(PrincipalUnsubscribeSchema.safeParse({ type: 'principal_unsubscribe' }).success, true)
    assert.equal(PrincipalUnsubscribeSchema.safeParse({ type: 'principal_unsubscribe', sessionIds: ['s'] }).success, true)
  })
})

describe('principal journal server frames (#9118)', () => {
  it('the event carries journalSeq, never a top-level seq the transport would overwrite', () => {
    assert.equal('seq' in ServerPrincipalEventSchema.shape, false)
    assert.equal('journalSeq' in ServerPrincipalEventSchema.shape, true)
    assert.equal('seq' in ServerPrincipalLiveFenceSchema.shape, false)
    assert.equal('journalSeq' in ServerPrincipalLiveFenceSchema.shape, true)
  })

  it('accepts the documented frames', () => {
    assert.equal(ServerPrincipalSubscribedSchema.safeParse({ type: 'principal_subscribed', requestId: 'r', sessions: [{ sessionId: 's', journalId: 'j', headSeq: 0, gap: { reason: 'evicted', fromSeq: 1, toSeq: 4 } }] }).success, true)
    assert.equal(ServerPrincipalEventSchema.safeParse({ type: 'principal_event', requestId: 'r', sessionId: 's', journalId: 'j', journalSeq: 1, ts: 1, eventType: 'message', data: { a: 1 }, replay: true, truncated: true }).success, true)
    assert.equal(ServerPrincipalLiveFenceSchema.safeParse({ type: 'principal_live_fence', requestId: 'r', sessionId: 's', journalId: 'j', journalSeq: 0 }).success, true)
    assert.equal(ServerPrincipalGapFrameSchema.safeParse({ type: 'principal_gap', sessionId: 's', journalId: 'j', reason: 'held_overflow', ended: true }).success, true)
    assert.equal(ServerPrincipalEventsPageSchema.safeParse({ type: 'principal_events_page', requestId: 'r', sessionId: 's', journalId: 'j', events: [{ seq: 1, ts: 1, eventType: 'message', data: {} }], headSeq: 1, cursor, more: false }).success, true)
  })

  it('rejects an unknown gap reason, a non-object event payload and an oversized page', () => {
    assert.equal(ServerPrincipalGapFrameSchema.safeParse({ type: 'principal_gap', sessionId: 's', journalId: 'j', reason: 'because', ended: false }).success, false)
    assert.equal(ServerPrincipalEventSchema.safeParse({ type: 'principal_event', sessionId: 's', journalId: 'j', journalSeq: 1, ts: 1, eventType: 'm', data: 'raw text' }).success, false)
    const ev = { seq: 1, ts: 1, eventType: 'message', data: {} }
    assert.equal(ServerPrincipalEventsPageSchema.safeParse({ type: 'principal_events_page', requestId: 'r', sessionId: 's', journalId: 'j', events: new Array(201).fill(ev), headSeq: 1, cursor, more: false }).success, false)
  })

  it('the cursor gap reasons are the four of the contract', () => {
    assert.deepEqual([...PRINCIPAL_GAP_REASON_VALUES], ['evicted', 'journal_reset', 'restart_loss', 'unknown_cursor'])
  })
})
