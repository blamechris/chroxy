/**
 * The stale-investigation scheduler.
 *
 * Five level triggers, an onset per trigger, at most two cycles per onset, a
 * recheck after a "working" or "waiting" verdict, two budgets, and a
 * classification from evidence the caller's reads supplied. Read-only by
 * construction: the only reads are the caller's functions, and the only
 * outputs are ledger records and signals for the owner queue.
 */

import { sourceCaps } from './config.js'
import { onsetOf, sessionsOf } from './derive.js'
import { put, planRead } from './checks.js'
import {
  READ_NO,
  checkInvestigationKey,
  investigationId,
  investigationKey,
  recheckInvestigationId,
  sourceInvestigationId,
} from './keys.js'

function sessionEnvOf(s) {
  return { source: s.session.source, native_id: s.session.native_id, incarnation: s.session.incarnation ?? null }
}

/** Whether every tracked session of the source failed its last two tick checks. */
export function sourceAllFailed(st, source, tickId) {
  const ss = sessionsOf(st, source)
  if (ss.length === 0) return false
  return ss.every((s) => s.cur && s.cur.tickId === tickId && s.cur.outcome === 'error' && s.prev && s.prev.outcome === 'error')
}

function firstCheckOfTick(st, source, tickId) {
  let best = null
  for (const s of sessionsOf(st, source)) {
    if (s.cur && s.cur.tickId === tickId && (best == null || s.cur.seq < best.seq)) best = s.cur
  }
  return best ? best.checkId : null
}

/** The source-level onset at this tick, if the source-level trigger holds. */
export function sourceOnset(st, source, tickId) {
  if (!sourceAllFailed(st, source, tickId)) return null
  const prev = st.sourceTrigger.get(source)
  if (prev && prev.held && prev.onset) return prev.onset
  return firstCheckOfTick(st, source, tickId)
}

function nativeEvidence(s, read) {
  if (read) {
    return {
      available: true,
      answering_now: read.answering_now !== false,
      turn_in_flight: Boolean(read.turn_in_flight),
      busy_background: Boolean(read.busy_background),
      pending: (read.pending ?? []).length > 0,
    }
  }
  if (s.cur && s.cur.nativeAvailable) {
    return {
      available: true,
      answering_now: s.cur.answeringNow,
      turn_in_flight: s.cur.turnInFlight,
      busy_background: s.cur.busyBackground,
      pending: s.cur.pending.size > 0,
    }
  }
  return null
}

function* investigationRead(ctx, { invId, readNo, session, readFn, now, tickId, readKind }) {
  const key = checkInvestigationKey(invId, readNo)
  const recorded = ctx.policy.reuseRecorded(ctx.state.index, key, 'check')
  if (recorded) {
    const snap = ctx.state.checkNative.get(key)
    const native = recorded.body.native_available
      ? { turn_in_flight: Boolean(snap?.turn_in_flight), busy_background: Boolean(snap?.busy_background), pending: snap?.pending ?? [] }
      : null
    return { body: recorded.body, native, reused: true }
  }
  const read = readFn()
  const r = yield* planRead(ctx, { key, trigger: 'investigation', session, read, now, tickId, investigationId: invId, readKind })
  return r
}

/**
 * Every candidate for one session, in trigger priority order: each trigger
 * that holds and has a cycle (or a recheck) available. Choosing one per
 * session is the policy's job (selectInvestigations).
 */
function candidatesFor(ctx, s, { tickId, srcHeld }) {
  const st = ctx.state
  const P = ctx.policy
  const caps = sourceCaps(st.config, s.session.source)
  // A crashed run of this tick already investigated this session: resume an
  // open investigation, or do nothing more for a closed one.
  for (const inv of st.investigations.values()) {
    if (inv.sk === s.sk && inv.tickId === tickId) {
      if (inv.closed) return []
      return [{ kind: inv.trigger === 'recheck' ? 'recheck' : 'cycle', resume: inv, s, key: s.sk, priority: -1, cycle: inv.cycle, trigger: inv.trigger, onset: inv.onset, onsetSeq: st.checks.get(inv.onset)?.seq ?? 0, needsRead: inv.trigger === 'recheck' && !caps.native_in_read, lastReadAt: s.lastReadAt }]
    }
  }
  const out = []
  P.triggerPriority.forEach((trigger, priority) => {
    if (trigger === 'recheck') {
      const last = s.lastClosedInv
      if (last && P.needsRecheck(last, P) && last.reportId === s.latestRead && last.tickId !== tickId) {
        out.push({ kind: 'recheck', s, key: s.sk, priority, trigger, needsRead: !caps.native_in_read, lastReadAt: s.lastReadAt, cycle: null })
      }
      return
    }
    if (trigger === 'repeated_error' && srcHeld) return
    if (!s.cur || s.cur.tickId !== tickId || !s.cur.flags[trigger]) return
    if (trigger === 'native_disagreement' && !caps.native_in_read) return
    const onset = onsetOf(s, trigger, P)
    const o = st.onsets.get(`${s.sk}|${trigger}|${onset}`)
    const closed = o?.closed ?? 0
    let cycle = null
    if (closed === 0) cycle = 1
    else if (closed < P.maxCycles && P.secondCycleAfter.has(o.lastClass)) cycle = closed + 1
    if (cycle == null) return
    out.push({ kind: 'cycle', s, key: s.sk, priority, cycle, trigger, onset, onsetSeq: st.checks.get(onset)?.seq ?? 0 })
  })
  return out
}

function sourceCandidate(ctx, source, tickId) {
  const st = ctx.state
  const P = ctx.policy
  const onset = sourceOnset(st, source, tickId)
  if (!onset) return null
  for (const inv of st.investigations.values()) {
    if (inv.sourceLevel && inv.source === source && inv.tickId === tickId) {
      if (inv.closed) return null
      return { kind: 'cycle', sourceLevel: true, source, resume: inv, key: `src:${source}`, priority: -1, cycle: inv.cycle, trigger: 'repeated_error', onset, onsetSeq: st.checks.get(onset)?.seq ?? 0 }
    }
  }
  const o = st.onsets.get(`src|${source}|${onset}`)
  const closed = o?.closed ?? 0
  let cycle = null
  if (closed === 0) cycle = 1
  else if (closed < P.maxCycles && P.secondCycleAfter.has(o.lastClass)) cycle = closed + 1
  if (cycle == null) return null
  // DESIGN-GAP: the rules do not say whether the one source-level
  // investigation draws on the per-tick budget. The model counts it as a cycle.
  return { kind: 'cycle', sourceLevel: true, source, key: `src:${source}`, priority: 0, cycle, trigger: 'repeated_error', onset, onsetSeq: st.checks.get(onset)?.seq ?? 0 }
}

function* runCandidate(ctx, cand, { tickId, now, world }) {
  const st = ctx.state
  const P = ctx.policy
  const cfg = st.config
  let s = cand.s
  if (cand.sourceLevel) s = sessionsOf(st, cand.source)[0]
  const session = s.session
  const caps = sourceCaps(cfg, session.source)
  const reportId = s.latestRead
  const report = reportId ? st.reports.get(reportId)?.body : null
  const invId = cand.resume
    ? cand.resume.id
    : cand.sourceLevel
      ? sourceInvestigationId({ source: cand.source, onset: cand.onset, cycle: cand.cycle })
      : cand.kind === 'recheck'
        ? recheckInvestigationId({ session, reportId, tickId })
        : investigationId({ session, reportId, trigger: cand.trigger, onset: cand.onset, cycle: cand.cycle })

  const closeKey = investigationKey(invId, 'close')
  const recordedClose = P.reuseRecorded(st.index, closeKey, 'investigation')
  if (recordedClose) return signalFrom(recordedClose.body, s, cand)

  const env = cand.sourceLevel ? null : sessionEnvOf(s)
  const openBody = {
    investigation_id: invId,
    trigger: cand.trigger,
    onset: cand.kind === 'recheck' ? null : cand.onset,
    report_id: cand.sourceLevel ? null : reportId,
    cycle: cand.kind === 'recheck' ? null : cand.cycle,
    phase: 'open',
    source: session.source,
    source_level: Boolean(cand.sourceLevel),
  }
  yield put({ kind: 'investigation', id: investigationKey(invId, 'open'), session: env, refs: { tick: tickId }, body: openBody }, now)

  const rungs = []
  let classification
  let pendingSeen = false
  let reportAgeMs = report ? now - report.last_report_at : null
  if (cand.kind === 'recheck') {
    let native = null
    let readFailed = false
    let rungBlocked = false
    if (caps.native_in_read) {
      native = nativeEvidence(s, null)
      rungs.push({ rung: 'activity_read', outcome: native ? 'tick_read' : 'none' })
    } else if (caps.activity_read) {
      const r = yield* investigationRead(ctx, { invId, readNo: READ_NO.ACTIVITY, session, readFn: () => world.activity(session, now), now, tickId, readKind: 'activity' })
      readFailed = r.body.outcome === 'error'
      rungBlocked = r.body.outcome === 'blocked'
      native = r.native ? nativeEvidence(s, r.native) : null
      rungs.push({ rung: 'activity_read', outcome: r.body.outcome })
    }
    pendingSeen = Boolean(native?.pending)
    classification = P.classifyRecheck({ native, readFailed, rungBlocked })
  } else {
    // The re-read: the same adapter read, once more; then one retry of a failed read.
    const i0 = yield* investigationRead(ctx, { invId, readNo: READ_NO.REREAD, session, readFn: () => world.reread(session, now), now, tickId })
    rungs.push({ rung: 're_read', outcome: i0.body.outcome })
    let failed = i0.body.outcome === 'error'
    let rungBlocked = i0.body.outcome === 'blocked'
    if (failed) {
      const retry = yield* investigationRead(ctx, { invId, readNo: READ_NO.RETRY, session, readFn: () => world.reread(session, now), now, tickId })
      rungs.push({ rung: 're_read', outcome: retry.body.outcome, retry: true })
      failed = retry.body.outcome === 'error'
    }
    let confirmListed = null
    if (cand.trigger === 'dropped_from_list' && !cand.sourceLevel) {
      const c = yield* investigationRead(ctx, { invId, readNo: READ_NO.CONFIRM_GONE, session, readFn: () => world.reread(session, now), now, tickId })
      confirmListed = c.body.listed !== false
      rungs.push({ rung: 'confirm_gone', outcome: confirmListed ? 'listed' : 'not_listed' })
    }
    let native = null
    if (!cand.sourceLevel && cand.trigger !== 'dropped_from_list') {
      if (caps.native_in_read) {
        native = nativeEvidence(s, i0.native)
        rungs.push({ rung: 'activity_read', outcome: native ? 'read' : 'none' })
      } else if (caps.activity_read) {
        const a = yield* investigationRead(ctx, { invId, readNo: READ_NO.ACTIVITY, session, readFn: () => world.activity(session, now), now, tickId, readKind: 'activity' })
        if (a.body.outcome === 'blocked') rungBlocked = true
        native = a.native ? nativeEvidence(s, a.native) : null
        rungs.push({ rung: 'activity_read', outcome: a.body.outcome })
      } else {
        rungs.push({ rung: 'activity_read', outcome: 'unavailable' })
      }
    }
    const latestRead = st.sessions.get(s.sk)?.latestRead
    const rep = latestRead ? st.reports.get(latestRead)?.body : report
    reportAgeMs = rep ? now - rep.last_report_at : null
    const ev = {
      trigger: cand.trigger,
      cycle: cand.cycle,
      sourceLevel: Boolean(cand.sourceLevel),
      rereadFailed: failed,
      rungBlocked,
      confirmListed,
      canConfirmGone: caps.can_confirm_gone,
      native,
      events: st.sessions.get(s.sk)?.events ?? [],
      reportAt: rep ? rep.last_report_at : -Infinity,
      state: rep ? rep.state : 'none',
      ownerBlock: rep ? P.isOwnerBlock(rep, cfg) : false,
      now,
      reportAgeMs,
    }
    pendingSeen = Boolean(native?.available && native.pending)
    classification = P.classify(ev, cfg)
    rungs.push({ rung: 'classify', outcome: classification })
  }
  const surface = P.surfaceFor(classification, cand.kind === 'recheck' ? null : cand.cycle, { reportAgeMs }, cfg)
  // DESIGN-GAP (added field): which owner the session waits on, so that a
  // recheck can tell a pending prompt from an owner block.
  const reportIsOwnerBlock = report ? P.isOwnerBlock(report, cfg) : false
  const ownerWaitBasis = classification === 'waiting_on_owner' ? (reportIsOwnerBlock || !pendingSeen ? 'owner_block' : 'prompt') : null
  // DESIGN-GAP: an attention item's opening reference is "the trigger's
  // onset", but a recheck (which can surface waiting_on_background) has no
  // onset. Keyed by the recheck's own id, a dismissed item would reopen at
  // the next recheck. The model uses the onset of the cycle that led to the
  // recheck, so a dismissal holds until a new onset.
  const basisOnset = cand.kind === 'recheck' ? cycleOnsetFor(st, s.sk, reportId) : null
  const closeBody = { ...openBody, phase: 'close', rungs, classification, classified_at: now, report_age_ms: reportAgeMs, surface, owner_wait_basis: ownerWaitBasis, basis_onset: basisOnset }
  // DESIGN-GAP: the investigation body names a `remainder` field that is never
  // defined. The model stores what it decided for the queue (`surface`) and
  // the age it decided on, so a replay re-derives the same signal.
  yield put({ kind: 'investigation', id: closeKey, session: env, refs: { tick: tickId }, body: closeBody }, now)
  return signalFrom(closeBody, s, cand)
}

function cycleOnsetFor(st, sk, reportId) {
  let best = null
  for (const inv of st.investigations.values()) {
    if (inv.sk === sk && inv.reportId === reportId && inv.trigger !== 'recheck' && inv.closed && (!best || inv.closeSeq > best.closeSeq)) best = inv
  }
  return best ? best.onset : null
}

function signalFrom(body, s, cand) {
  if (!body.surface) return null
  if (body.surface === 'outage') return { type: 'outage', source: body.source, onset: body.onset, investigationId: body.investigation_id }
  return {
    type: body.surface,
    session: s.session,
    sk: s.sk,
    reportId: body.report_id,
    onset: body.onset ?? body.basis_onset ?? body.investigation_id,
    classification: body.classification,
    investigationId: body.investigation_id,
    trigger: cand.trigger,
  }
}

/**
 * Plan this tick's investigations for one source. Returns the queue signals
 * (attention, gone, outage) the closed investigations produced.
 */
export function* planInvestigations(ctx, { source, tickId, now, world }) {
  const st = ctx.state
  const P = ctx.policy
  const cfg = st.config
  const srcHeld = sourceAllFailed(st, source, tickId)
  const cands = []
  const srcCand = srcHeld ? sourceCandidate(ctx, source, tickId) : null
  if (srcCand) cands.push(srcCand)
  for (const s of sessionsOf(st, source)) cands.push(...candidatesFor(ctx, s, { tickId, srcHeld }))
  // Budgets already spent by a crashed run of this same tick.
  let usedCycles = 0
  let usedPaid = 0
  for (const inv of st.investigations.values()) {
    if (inv.tickId !== tickId || !inv.closed) continue
    if (inv.trigger === 'recheck') {
      if (!sourceCaps(cfg, inv.source).native_in_read) usedPaid += 1
    } else usedCycles += 1
  }
  const selected = P.selectInvestigations(cands, {
    cycleBudget: Math.max(0, cfg.investigation_budget_per_tick - usedCycles),
    recheckBudget: Math.max(0, cfg.recheck_budget_per_tick - usedPaid),
  })
  const signals = []
  for (const cand of selected) {
    const sig = yield* runCandidate(ctx, cand, { tickId, now, world })
    if (sig) signals.push(sig)
  }
  // Signals from investigations a crashed run of this tick already closed.
  for (const inv of st.investigations.values()) {
    if (inv.tickId !== tickId || !inv.closed) continue
    if (selected.some((c) => c.resume?.id === inv.id)) continue
    const rec = st.index.get(investigationKey(inv.id, 'close'))
    const s = inv.sk ? st.sessions.get(inv.sk) : sessionsOf(st, inv.source)[0]
    const sig = rec && s ? signalFrom(rec.body, s, { trigger: inv.trigger }) : null
    if (sig && !signals.some((x) => x.investigationId === sig.investigationId)) signals.push(sig)
  }
  return { signals, srcHeld, srcOnset: srcHeld ? sourceOnset(st, source, tickId) : null }
}

