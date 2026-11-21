/**
 * Test harness for the freshness model: a model context, a simulated world,
 * a send log, and a driver that can stop part-way through a step (a crash).
 */

import { cadenceSeconds, makeConfig } from '../model/config.js'
import { append } from '../model/ledger.js'
import { foldRecord } from '../model/derive.js'
import { DEFAULT_POLICY } from '../model/policy.js'
import { createModel, planConfig, planOwnerEvent, planTick, restoreModel, run } from '../model/reconciler.js'
import { adapter, createWorld } from './world.js'

export const T0 = Date.parse('2026-01-05T00:00:00.000Z')
export const MIN = 60_000
export const HOUR = 60 * MIN
export const OWNER = 'the-owner'

export class Crash extends Error {}

/**
 * Drive a planner like run(), but stop (throw Crash) after `crashAfter`
 * operations. The operations already executed stay executed: appended records
 * are in the ledger and sends have happened.
 */
export function runWithCrash(ctx, gen, { deliver, crashAfter, onSend, dropAppend }) {
  let n = 0
  let res = gen.next()
  while (!res.done) {
    if (n >= crashAfter) throw new Crash(`crash after ${n} ops`)
    const op = res.value
    let reply
    if (op.op === 'append' && dropAppend?.(op.record)) {
      // Test-only fault: the planner believes the record was written.
      reply = { status: 'appended', record: null }
    } else if (op.op === 'append') {
      reply = append(ctx.ledger, op.record, op.at)
      if (reply.record) foldRecord(ctx.state, reply.record)
    } else {
      onSend(op.effect)
      reply = deliver(op.effect)
    }
    n += 1
    res = gen.next(reply)
  }
  return res.value
}

export function createHarness({ config: overrides = {}, policy = DEFAULT_POLICY, world = createWorld(), now = T0 } = {}) {
  const config = makeConfig({ owner_name: OWNER, ...overrides })
  const ctx = createModel({ ledgerId: 'ledger-test', policy })
  run(ctx, planConfig(ctx, { config, now }))
  const h = {
    ctx,
    world,
    config,
    policy,
    now,
    sends: [],
    deliver: () => 'delivered',
    // Test-only fault injection: a predicate over draft records to drop.
    dropAppend: null,
    onSend(effect) {
      h.sends.push(effect)
    },
    slotFor(source, at) {
      const cad = cadenceSeconds(h.ctx.state.config, source) * 1000
      return Math.floor(at / cad) * cad
    },
    /** One tick of `source` at time `at`. */
    tick(source, at = h.now, { crashAfter = Infinity, slotStart, reads } = {}) {
      h.now = Math.max(h.now, at)
      const world = reads ? reads(adapter(h.world)) : adapter(h.world)
      const gen = planTick(h.ctx, { source, slotStart: slotStart ?? h.slotFor(source, at), now: at, world })
      return runWithCrash(h.ctx, gen, { deliver: h.deliver, crashAfter, onSend: (e) => h.onSend(e), dropAppend: h.dropAppend })
    },
    owner(itemId, intent, ackRef, { at = h.now, until = null, crashAfter = Infinity } = {}) {
      h.now = Math.max(h.now, at)
      const gen = planOwnerEvent(h.ctx, { itemId, intent, ackRef, until, now: at })
      return runWithCrash(h.ctx, gen, { deliver: h.deliver, crashAfter, onSend: (e) => h.onSend(e) })
    },
    /** Discard all in-memory state and rebuild from the ledger records alone. */
    restart() {
      h.ctx = restoreModel({ ledgerId: h.ctx.ledger.ledgerId, records: h.ctx.ledger.records, policy: h.policy })
    },
    records(kind) {
      return h.ctx.ledger.records.filter((r) => !kind || r.kind === kind)
    },
    surface(itemId) {
      return h.records('surface').filter((r) => r.body.item_id === itemId)
    },
    item(itemId) {
      return h.ctx.state.items.get(itemId)
    },
    openItems() {
      return [...h.ctx.state.items.values()].filter((i) => i.open)
    },
    sendsFor(itemId) {
      return h.sends.filter((s) => s.item_id === itemId)
    },
    conflicts() {
      return h.records('system').filter((r) => r.body.event === 'idempotency_conflict')
    },
    lastCheck(sk) {
      const s = h.ctx.state.sessions.get(sk)
      return s?.cur ?? null
    },
  }
  return h
}
