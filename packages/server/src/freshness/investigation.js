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
import { H } from './hash.js'
import { isFileLevelReadError, isSourceLevelError } from './read-errors.js'
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

/**
 * Whether every tracked session of the source failed its last two tick checks
 * with an error that describes the source. An error that describes the one file
 * read (see read-errors.js) is the session's own trouble and never counts.
 */
export function sourceAllFailed(st, source, tickId) {
  const ss = sessionsOf(st, source)
  if (ss.length === 0) return false
  return ss.every((s) => s.cur && s.cur.tickId === tickId && isSourceLevelError(s.cur) && isSourceLevelError(s.prev))
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

/**
 * DESIGN-GAP (added fields): the rules ask for each investigation's result to
 * carry the evidence class of the reads it used, but a rung recorded only its
 * outcome. Each rung of the close record also names the check it read
 * (`read`, null when it read nothing) and the classes that read supplied
 * (`evidence`); `classify` carries the union. The classes are the ledger's own
 * (E2, E5 on a report, E1 on native state), never taken from the adapter.
 *
 * The evidence classes one read supplied, from the ledger's own records: a
 * report it carried (E2 authored and host-timed, E5 relayed) and native state
 * (E1). A read that carried neither supplied none. An activity read's report
 * is never recorded, so it supplies E1 at most.
 */
function evidenceOfCheck(st, body) {
  const out = []
  const rep = body.report_id ? st.reports.get(body.report_id)?.body : null
  if (rep) out.push(rep.evidence_class)
  if (body.native_available) out.push('E1')
  return out.sort()
}

function* investigationRead(ctx, { invId, readNo, session, readFn, now, tickId, readKind }) {
  const key = checkInvestigationKey(invId, readNo)
  const recorded = ctx.policy.reuseRecorded(ctx.state.index, key, 'check')
  if (recorded) {
    const snap = ctx.state.checkNative.get(key)
    const native = recorded.body.native_available
      ? { turn_in_flight: Boolean(snap?.turn_in_flight), busy_background: Boolean(snap?.busy_background), pending: snap?.pending ?? [] }
      : null
    return { body: recorded.body, native, reused: true, checkId: key }
  }
  const read = readFn()
  const r = yield* planRead(ctx, { key, trigger: 'investigation', session, read, now, tickId, investigationId: invId, readKind })
  return { ...r, checkId: key }
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
      return [{ kind: inv.trigger === 'recheck' ? 'recheck' : 'cycle', resume: inv, s, key: s.sk, priority: -1, cycle: inv.cycle, trigger: inv.trigger, onset: inv.onset, onsetSeq: st.checks.get(inv.onset)?.seq ?? 0, needsRead: inv.trigger === 'recheck' && !caps.native_in_read, lastInvestigatedAt: s.lastClosedInv?.at ?? 0 }]
    }
  }
  const out = []
  P.triggerPriority.forEach((trigger, priority) => {
    if (trigger === 'recheck') {
      const last = s.lastClosedInv
      // DESIGN-GAP: the recheck budget serves "least recently checked first",
      // but every tracked session is read at every tick, so the time of a
      // session's last read never tells two apart and the same sessions would
      // win every tick. The model orders by the time of the session's last
      // investigation instead, so each recheck sends a session to the back.
      if (last && P.needsRecheck(last, P) && last.reportId === s.latestRead && last.tickId !== tickId) {
        out.push({ kind: 'recheck', s, key: s.sk, priority, trigger, needsRead: !caps.native_in_read, lastInvestigatedAt: last.at ?? 0, cycle: null })
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
    : afterAbandoned(
        st,
        cand.sourceLevel
          ? sourceInvestigationId({ source: cand.source, onset: cand.onset, cycle: cand.cycle })
          : cand.kind === 'recheck'
            ? recheckInvestigationId({ session, reportId, tickId })
            : investigationId({ session, reportId, trigger: cand.trigger, onset: cand.onset, cycle: cand.cycle }),
      )

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
      rungs.push({ rung: 'activity_read', outcome: native ? 'tick_read' : 'none', read: native ? (s.cur?.checkId ?? null) : null, evidence: native ? ['E1'] : [] })
    } else if (caps.activity_read) {
      const r = yield* investigationRead(ctx, { invId, readNo: READ_NO.ACTIVITY, session, readFn: () => world.activity(session, now), now, tickId, readKind: 'activity' })
      readFailed = r.body.outcome === 'error'
      rungBlocked = r.body.outcome === 'blocked'
      native = r.native ? nativeEvidence(s, r.native) : null
      rungs.push({ rung: 'activity_read', outcome: r.body.outcome, read: r.checkId, evidence: evidenceOfCheck(st, r.body) })
    }
    pendingSeen = Boolean(native?.pending)
    classification = P.classifyRecheck({ native, readFailed, rungBlocked })
    rungs.push({ rung: 'classify', outcome: classification, read: null, evidence: unionEvidence(rungs) })
  } else {
    // The re-read: the same adapter read, once more; then one retry of a failed read.
    const reRead = yield* investigationRead(ctx, { invId, readNo: READ_NO.REREAD, session, readFn: () => world.reread(session, now), now, tickId })
    rungs.push({ rung: 're_read', outcome: reRead.body.outcome, read: reRead.checkId, evidence: evidenceOfCheck(st, reRead.body) })
    let failed = reRead.body.outcome === 'error'
    let rungBlocked = reRead.body.outcome === 'blocked'
    // The latest read of the cycle: the retry when the re-read failed.
    let latest = reRead
    if (failed) {
      const retry = yield* investigationRead(ctx, { invId, readNo: READ_NO.RETRY, session, readFn: () => world.reread(session, now), now, tickId })
      rungs.push({ rung: 're_read', outcome: retry.body.outcome, retry: true, read: retry.checkId, evidence: evidenceOfCheck(st, retry.body) })
      failed = retry.body.outcome === 'error'
      latest = retry
    }
    let confirmListed = null
    if (cand.trigger === 'dropped_from_list' && !cand.sourceLevel) {
      const c = yield* investigationRead(ctx, { invId, readNo: READ_NO.CONFIRM_GONE, session, readFn: () => world.reread(session, now), now, tickId })
      confirmListed = c.body.listed !== false
      rungs.push({ rung: 'confirm_gone', outcome: confirmListed ? 'listed' : 'not_listed', read: c.checkId, evidence: evidenceOfCheck(st, c.body) })
    }
    let native = null
    if (!cand.sourceLevel && cand.trigger !== 'dropped_from_list') {
      if (caps.native_in_read) {
        // From the latest successful read of the cycle (the retry, if the
        // re-read failed and it succeeded); from the tick's own read only
        // when neither succeeded. A failed read carries no native state.
        native = nativeEvidence(s, latest.native)
        // The read named is the one the evidence came from: the cycle's latest
        // read when it carried native state, else the tick's own check.
        rungs.push({ rung: 'activity_read', outcome: native ? 'read' : 'none', read: native ? (latest.native ? latest.checkId : (s.cur?.checkId ?? null)) : null, evidence: native ? ['E1'] : [] })
      } else if (caps.activity_read) {
        const a = yield* investigationRead(ctx, { invId, readNo: READ_NO.ACTIVITY, session, readFn: () => world.activity(session, now), now, tickId, readKind: 'activity' })
        if (a.body.outcome === 'blocked') rungBlocked = true
        native = a.native ? nativeEvidence(s, a.native) : null
        rungs.push({ rung: 'activity_read', outcome: a.body.outcome, read: a.checkId, evidence: evidenceOfCheck(st, a.body) })
      } else {
        rungs.push({ rung: 'activity_read', outcome: 'unavailable', read: null, evidence: [] })
      }
    }
    // DESIGN-GAP: a stale owner block is explained by its owner item only
    // while the item carries a live declared ask. A session rewound to an
    // owner-block line whose ask already used it (and so never comes back)
    // has no ask carrying it, and is classified, and rechecked, as any other
    // stale line.
    const declaredOpen = declaredAskLive(st, P, session)
    const latestRead = st.sessions.get(s.sk)?.latestRead
    const rep = latestRead ? st.reports.get(latestRead)?.body : report
    reportAgeMs = rep ? now - rep.last_report_at : null
    const ev = {
      trigger: cand.trigger,
      cycle: cand.cycle,
      sourceLevel: Boolean(cand.sourceLevel),
      // A source-level re-read that failed only on the one file it read says
      // nothing about the source: not an outage.
      rereadFailed: failed && !(cand.sourceLevel && isFileLevelReadError(latest.body.error_code)),
      rungBlocked,
      confirmListed,
      canConfirmGone: caps.can_confirm_gone,
      native,
      events: st.sessions.get(s.sk)?.events ?? [],
      reportAt: rep ? rep.last_report_at : -Infinity,
      state: rep ? rep.state : 'none',
      ownerBlock: rep ? P.isOwnerBlock(rep, cfg) && declaredOpen : false,
      now,
      reportAgeMs,
    }
    pendingSeen = Boolean(native?.available && native.pending)
    classification = P.classify(ev, cfg)
    rungs.push({ rung: 'classify', outcome: classification, read: null, evidence: unionEvidence(rungs) })
  }
  const surface = P.surfaceFor(classification, cand.kind === 'recheck' ? null : cand.cycle, { reportAgeMs }, cfg)
  // DESIGN-GAP (added field): which owner the session waits on, so that a
  // recheck can tell a pending prompt from an owner block.
  const reportIsOwnerBlock = report ? P.isOwnerBlock(report, cfg) && declaredAskLive(st, P, session) : false
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

/** The evidence classes of every read the rungs so far used, sorted and without repeats. */
function unionEvidence(rungs) {
  return [...new Set(rungs.flatMap((r) => r.evidence ?? []))].sort()
}

/**
 * DESIGN-GAP: a tick killed by a crash is replayed only within its own slot.
 * When the process comes back after the slot has passed, the crashed tick is
 * never replayed, and an investigation it opened would stay open for good;
 * the next one for the same onset and cycle would have the same id, and its
 * open record (naming another tick) would conflict with the first. The
 * source's next tick closes such an investigation as `abandoned`: it decided
 * nothing, surfaces nothing and counts as no cycle. Its reads are not
 * reused. The investigation then run for that onset and cycle takes the id
 * H(id, 'after_abandoned') instead, once for each abandoned one before it,
 * so every id is still derived from the ledger alone. An investigation the
 * crashed tick did close keeps its decision: its signal (attention, gone,
 * outage) is applied by the source's next tick, as a replay in the same slot
 * would have applied it, unless the item's closing evidence has arrived
 * since; once a later tick of the source closes, the crashed tick is
 * superseded and nothing more is taken from it. A crashed tick replayed
 * after a later tick abandoned its investigation would count the abandoned
 * one in its spent budget and its signal loop; the model cannot reach that,
 * because a tick is replayed only within its own slot.
 */
function afterAbandoned(st, id) {
  let next = id
  while (st.investigations.get(next)?.abandoned) next = H(next, 'after_abandoned')
  return next
}

/** Close the investigations of this source left open by a tick that was never replayed. */
function* closeAbandoned(ctx, { source, tickId, now }) {
  const st = ctx.state
  if (!ctx.policy.closeAbandonedInvestigations) return
  for (const inv of [...st.investigations.values()]) {
    if (inv.closed || inv.source !== source || inv.tickId === tickId) continue
    if (st.ticks.get(inv.tickId)?.closed) continue
    const open = st.index.get(investigationKey(inv.id, 'open'))
    if (!open) continue
    const body = { ...open.body, phase: 'close', rungs: [], classification: 'abandoned', classified_at: null, report_age_ms: null, surface: null, owner_wait_basis: null, basis_onset: null, abandoned_by: tickId }
    yield put({ kind: 'investigation', id: investigationKey(inv.id, 'close'), session: open.session, refs: { tick: tickId }, body }, now)
  }
}

function declaredAskLive(st, P, session) {
  const it = st.items.get(P.ownerItemOf(session, 'declared'))
  return Boolean(it?.open && it.asks.has('declared'))
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
  yield* closeAbandoned(ctx, { source, tickId, now })
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
  // Signals from investigations closed by an earlier tick of this source
  // that was never replayed (see `closeAbandoned`), unless their closing
  // evidence has arrived since. (The `abandoned` filter is belt and braces:
  // an abandoned close surfaces nothing, so it yields no signal anyway.)
  for (const inv of P.recoverAbandonedSignals ? st.investigations.values() : []) {
    if (!inv.closed || inv.abandoned || inv.tickId === tickId || inv.source !== source) continue
    const t = st.ticks.get(inv.tickId)
    if (!t || t.closed || t.superseded) continue
    const rec = st.index.get(investigationKey(inv.id, 'close'))
    const s = inv.sk ? st.sessions.get(inv.sk) : sessionsOf(st, inv.source)[0]
    const sig = rec && s ? signalFrom(rec.body, s, { trigger: inv.trigger }) : null
    if (!sig || signals.some((x) => x.investigationId === sig.investigationId) || evidenceSince(st, sig, source, tickId)) continue
    signals.push(sig)
  }
  return { signals, srcHeld, srcOnset: srcHeld ? sourceOnset(st, source, tickId) : null }
}

/**
 * Whether the item a recovered signal would raise already has its closing
 * evidence at this tick. (The `tickId` tests always hold here: every session
 * of the source has its check of this tick before investigations run.)
 */
function evidenceSince(st, sig, source, tickId) {
  if (sig.type === 'outage') return sessionsOf(st, source).some((s) => s.cur && s.cur.tickId === tickId && (s.cur.outcome === 'ok' || s.cur.outcome === 'no_report'))
  const s = st.sessions.get(sig.sk)
  if (sig.type === 'gone') return Boolean(s?.cur && s.cur.tickId === tickId && s.cur.listed)
  const latest = s?.latestAuthored ? st.reports.get(s.latestAuthored)?.body : null
  const opening = sig.reportId ? st.reports.get(sig.reportId)?.body : null
  return Boolean(latest && (!opening || latest.last_report_at > opening.last_report_at))
}

