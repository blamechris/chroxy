/**
 * The reconciliation tick and its driver, as a pure model.
 *
 * A model context is `{ ledger, state, policy }`: the ledger is the durable
 * part, `state` is derived from it (derive.js) and is discarded on a restart,
 * and `policy` is the rule set (policy.js). Planners are generators that
 * yield operations; `run()` executes them against the context. Every
 * outward effect is an operation the driver hands to the caller's `deliver`
 * function; the model itself performs none.
 *
 * Not modelled here, by scope: the lease and fencing, the side log, emits and
 * early checks, compaction, timers.
 */

import { cadenceSeconds } from './config.js'
import { canonical, H } from './hash.js'
import { deriveState, foldRecord, sessionsOf } from './derive.js'
import { put, planRead } from './checks.js'
import { planInvestigations } from './investigation.js'
import { append, createLedger, loadLedger } from './ledger.js'
import { DEFAULT_POLICY } from './policy.js'
import { planOwnerEvent, planQueue, sweepUnknownDeliveries } from './queue.js'
import { checkTickKey, configKey, sessionKey, tickId as makeTickId, tickKey } from './keys.js'

export { planOwnerEvent }

/** A fresh model context. */
export function createModel({ ledgerId, policy = DEFAULT_POLICY }) {
  const ledger = createLedger({ ledgerId })
  return { ledger, state: deriveState([], policy), policy }
}

/**
 * Rebuild a context from ledger records alone, as after a crash: the
 * ledger's index and every derived value are recomputed; nothing survives
 * from the previous process.
 */
export function restoreModel({ ledgerId, records, policy = DEFAULT_POLICY }) {
  const ledger = loadLedger({ ledgerId, records: records.slice() })
  return { ledger, state: deriveState(ledger.records, policy), policy }
}

/**
 * Execute a planner against a context. `deliver(effect)` performs a send
 * and returns 'delivered' or 'failed'. Returns { sends, value }.
 */
export function run(ctx, gen, { deliver = () => 'delivered' } = {}) {
  const sends = []
  let res = gen.next()
  while (!res.done) {
    const op = res.value
    let reply
    if (op.op === 'append') {
      reply = append(ctx.ledger, op.record, op.at)
      if (reply.record) foldRecord(ctx.state, reply.record)
    } else if (op.op === 'send') {
      sends.push(op.effect)
      reply = deliver(op.effect)
    } else {
      throw new Error(`run: unknown op ${op.op}`)
    }
    res = gen.next(reply)
  }
  return { sends, value: res.value }
}

/** Plan a configuration record. The full values are stored (see the gap note). */
export function* planConfig(ctx, { config, now }) {
  const st = ctx.state
  const configHash = H(config)
  const previous = st.lastConfigId
  const id = configKey(previous, configHash)
  if (st.index.has(id)) return { configRef: st.configRef }
  const configRef = 'cfg_' + configHash.slice(0, 12)
  const prevValues = st.config
  const changed = prevValues ? Object.keys(config).filter((k) => canonical(config[k]) !== canonical(prevValues[k])) : Object.keys(config)
  yield put(
    {
      kind: 'config',
      id,
      body: {
        config_ref: configRef,
        previous_config_ref: st.configRef,
        config_hash: configHash,
        changed_fields: changed,
        // DESIGN-GAP: the `config` body carries only a hash and the names of
        // the changed fields, so the thresholds a check was graded under are
        // not derivable from the ledger alone. The model stores the values.
        values: config,
      },
    },
    now,
  )
  return { configRef }
}

function trackedSessions(ctx, source, world) {
  const listed = world.list(source)
  const out = new Map()
  for (const s of sessionsOf(ctx.state, source)) out.set(s.sk, { session: s.session, scope: s.scope, listed: listed == null ? null : false })
  if (listed) {
    for (const e of listed) out.set(sessionKey(e.session), { session: e.session, scope: e.scope ?? null, listed: true })
  }
  return [...out.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v)
}

/**
 * Plan one tick of one source.
 *
 * world: the caller's reads, all pure data access:
 *   list(source)            -> [{ session, scope }] or null when the source is unreadable
 *   read(session, now)      -> ReportRead (the tick's one bounded read)
 *   reread(session, now)    -> ReportRead (investigation I0 and its retry)
 *   activity(session, now)  -> ActivityRead (a separate native read)
 */
export function* planTick(ctx, { source, slotStart, now, world }) {
  const st = ctx.state
  if (!st.config) throw new Error('planTick: no configuration in the ledger')
  yield* sweepUnknownDeliveries(ctx, now)
  const tid = makeTickId(ctx.ledger.ledgerId, source, slotStart)
  if (st.ticks.get(tid)?.closed) return { skipped: 'closed' }
  const cad = cadenceSeconds(st.config, source) * 1000
  const last = st.lastClosedTick.get(source)
  const missed = last ? Math.max(0, Math.round((slotStart - last.slot) / cad) - 1) : 0
  const openBody = { tick_id: tid, source, slot_start: slotStart, phase: 'open', cadence_minutes: cad / 60000, config_ref: st.configRef, fence: null, missed_slots: missed }
  yield put({ kind: 'tick', id: tickKey(tid, 'open'), refs: { tick: tid }, body: openBody }, now)
  const tickOpenSeq = st.ticks.get(tid).openSeq

  for (const t of trackedSessions(ctx, source, world)) {
    const key = checkTickKey(tid, t.session)
    if (ctx.policy.reuseRecorded(st.index, key, 'check')) continue
    const read = t.listed === false ? { listed: false } : world.read(t.session, now)
    yield* planRead(ctx, { key, trigger: 'tick', session: t.session, read, now, tickId: tid, scope: t.scope })
  }

  const inv = yield* planInvestigations(ctx, { source, tickId: tid, now, world })
  yield* planQueue(ctx, { source, tickId: tid, now, signals: inv.signals, tickOpenSeq })

  const investigations = [...st.investigations.values()].filter((i) => i.tickId === tid).length
  const closeBody = {
    ...openBody,
    phase: 'close',
    sessions: sessionsOf(st, source).length,
    checks: [...st.checks.values()].filter((c) => c.tickId === tid && c.body.trigger === 'tick').length,
    new_reports: [...st.reports.values()].filter((r) => r.seq > tickOpenSeq && r.body.source === source).length,
    investigations,
    surfaced: null,
    duration_ms: null,
    source_all_failed: inv.srcHeld,
    source_onset: inv.srcOnset,
  }
  yield put({ kind: 'tick', id: tickKey(tid, 'close'), refs: { tick: tid }, body: closeBody }, now)
  return { tickId: tid }
}
