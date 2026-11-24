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
import { sessionsOf } from './derive.js'
import { put, planRead } from './checks.js'
import { planInvestigations } from './investigation.js'
import { createModel, planConfig, restoreModel, run, trackedSessions } from '../../../src/freshness/runtime.js'
import { planOwnerEvent, planQueue, sweepUnknownDeliveries } from './queue.js'
import { checkTickKey, tickId as makeTickId, tickKey } from './keys.js'

export { createModel, planConfig, planOwnerEvent, restoreModel, run }

/**
 * Plan one tick of one source.
 *
 * world: the caller's reads, all pure data access:
 *   list(source)            -> [{ session, scope }] or null when the source is unreadable
 *   read(session, now)      -> ReportRead (the tick's one bounded read)
 *   reread(session, now)    -> ReportRead (an investigation's re-read, its retry, the gone confirmation)
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
