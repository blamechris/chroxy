/**
 * Turning one adapter read into ledger records: an optional `report`, one
 * `check`, and `activity` records for native evidence. The read itself is
 * data the caller supplies; nothing here
 * performs one.
 *
 * Planner functions in this directory are generators. They yield operations
 * (`{ op: 'append', record, at }` or `{ op: 'send', effect }`) and receive the
 * result of each; `run()` in reconciler.js is the driver. A crash is a driver
 * that stops part-way.
 */

import { sourceCaps } from './config.js'
import { gradeRead } from './grade.js'
import { H } from './hash.js'
import { activityEventKey, activityStateKey, reportKey, sessionKey, systemKey } from './keys.js'

function sameEvent(prior, sessionEnv, e) {
  if (!prior) return false
  const b = prior.body
  return (
    prior.kind === 'activity' &&
    prior.session?.source === sessionEnv.source &&
    prior.session?.native_id === sessionEnv.native_id &&
    (prior.session?.incarnation ?? null) === (sessionEnv.incarnation ?? null) &&
    b.basis === e.basis &&
    (b.ref ?? null) === (e.ref ?? null) &&
    (b.activity_at ?? null) === (e.activity_at ?? null)
  )
}

export function put(record, at) {
  return { op: 'append', record, at }
}

const RELAYED = new Set(['api', 'hook'])

function reportFields(rep) {
  return {
    state: rep.state,
    next: rep.next ?? null,
    declared_blocked_on: rep.declared_blocked_on ?? null,
    decision: rep.decision ?? null,
    decision_basis: rep.decision_basis ?? 'none',
    declared_via: rep.declared_via,
    owner_named: rep.owner_named ?? null,
    seed_ref: rep.seed_ref ?? null,
  }
}

/**
 * Plan the records for one read. Returns the check body, the report body (if
 * any) and the native evidence the read carried, for the caller to classify.
 *
 * opts: { key, trigger, session, read, now, tickId, investigationId, scope, readKind }
 */
export function* planRead(ctx, opts) {
  const { key, trigger, session, read, now } = opts
  const st = ctx.state
  const P = ctx.policy
  const cfg = st.config
  const caps = sourceCaps(cfg, session.source)
  const sk = sessionKey(session)
  const s = st.sessions.get(sk)
  const listed = read.listed !== false
  const sessionEnv = { source: session.source, native_id: session.native_id, incarnation: session.incarnation ?? null }

  const body = {
    check_id: key,
    source: session.source,
    checked_at: now,
    trigger,
    outcome: read.outcome ?? 'no_report',
    report_id: null,
    last_report_at: null,
    state: 'none',
    freshness: 'unknown',
    report_age_s: null,
    freshness_reason: null,
    config_ref: st.configRef,
    error_code: null,
    not_read_reason: null,
    // DESIGN-GAP: the check body has no way to say a session is unlisted,
    // yet `dropped_from_list` must be derivable from the ledger. Added field.
    listed,
    scope: opts.scope ?? null,
    // DESIGN-GAP: activity records are written only for states seen, so the
    // ledger cannot tell "not busy" from "this read carried no native state".
    // Added field.
    native_available: false,
    read_kind: opts.readKind ?? 'report',
    // Added fields: what the grading depended on besides the report and the
    // check time, so a reader can re-grade the check from the ledger alone.
    source_now: read.source_now ?? null,
    remote_without_clock: Boolean(read.remote_without_clock),
  }
  let reportDraft = null
  let regressed = false

  if (!listed) {
    body.outcome = 'no_report'
    // DESIGN-GAP: no `freshness_reason` value exists for a session that is no
    // longer listed. Added value.
    body.freshness_reason = 'not_listed'
  } else if (body.outcome === 'ok' && read.report && opts.readKind !== 'activity') {
    const rep = read.report
    body.state = rep.state
    if (rep.time_trusted === false) {
      // The adapter rules: no report record; the check says why.
      body.freshness_reason = 'time_untrusted'
    } else {
      const fields = reportFields(rep)
      const fieldsHash = H(fields)
      const rid = reportKey(session, rep.last_report_at, fieldsHash)
      body.report_id = rid
      body.last_report_at = rep.last_report_at
      const relayed = RELAYED.has(rep.declared_via)
      if (!st.index.has(rid)) {
        const rbody = {
          report_id: rid,
          source: session.source,
          last_report_at: rep.last_report_at,
          report_time_basis: caps.report_time_basis,
          declared_via: rep.declared_via,
          key_basis: `${session.source}:${caps.report_time_basis}+fields`,
          state: rep.state,
          next: fields.next,
          declared_blocked_on: fields.declared_blocked_on,
          decision: fields.decision,
          decision_basis: fields.decision_basis,
          block_fingerprint: null,
          later_unfootered_messages: Boolean(rep.later_unfootered_messages),
          evidence_class: relayed ? 'E5' : 'E2',
          locator: null,
          fields_hash: fieldsHash,
          // DESIGN-GAP: the owner-block rule needs the name in the OWNER slot
          // and the seed origin needs the seed's scope, session and write
          // time, but the report body stores neither, so neither origin could
          // be derived from the ledger alone. Added fields.
          owner_named: fields.owner_named,
          seed_ref: fields.seed_ref,
        }
        rbody.block_fingerprint = P.blockFingerprint(rbody)
        reportDraft = { kind: 'report', id: rid, session: sessionEnv, body: rbody }
      }
      if (!relayed && s?.latestAuthored && s.latestAuthored !== rid) {
        const latest = st.reports.get(s.latestAuthored)
        if (latest && latest.body.last_report_at > rep.last_report_at) regressed = true
      }
    }
  }

  const previousCheckedAt = s?.cur && s.cur.reportId === body.report_id ? s.cur.checkedAt : null
  if (opts.readKind !== 'activity' && listed) {
    const g = gradeRead(
      {
        outcome: body.outcome,
        state: body.state,
        declaredVia: read.report?.declared_via,
        timeTrusted: read.report?.time_trusted,
        lastReportAt: body.last_report_at,
        checkedAt: now,
        previousCheckedAt,
        sourceNow: read.source_now ?? null,
        remoteWithoutClock: Boolean(read.remote_without_clock),
        errorCode: read.error_code,
        notReadReason: read.not_read_reason,
        reason: body.freshness_reason ?? undefined,
      },
      cfg,
      P.reportAge,
    )
    body.freshness = g.freshness
    body.freshness_reason = g.reason ?? body.freshness_reason
    body.report_age_s = g.ageS
    body.error_code = g.errorCode
    body.not_read_reason = g.notReadReason
    if (g.errorCode === 'clock_skew' && body.outcome === 'ok') {
      // A skewed clock makes the read's outcome `error: clock_skew`, and a
      // line whose time cannot be trusted writes no report record.
      body.outcome = 'error'
      body.report_id = null
      reportDraft = null
      regressed = false
    }
  } else if (body.outcome === 'error') {
    body.freshness = 'error'
    body.error_code = read.error_code ?? 'adapter_fault'
  }

  const native = read.native && (body.outcome === 'ok' || body.outcome === 'no_report') ? read.native : null
  body.native_available = native != null

  if (reportDraft) yield put(reportDraft, now)
  if (regressed) {
    yield put({ kind: 'system', id: systemKey('report_regressed', [sk, body.report_id]), session: sessionEnv, body: { event: 'report_regressed', detail: { ids: [sk, body.report_id] } } }, now)
  }

  // DESIGN-GAP: one read becomes several records (report, check, activity)
  // and the rules give no atomicity rule (README, DESIGN-GAP choices). Written check-first, a crash
  // between the check and its activity records leaves a partial observation
  // that a resumed tick either keeps (if it reuses the check, the remaining
  // observations are lost) or collides with (if it re-reads, the activity
  // keys H(check_id, basis, ref) repeat with a different `observed_at`). The
  // model writes the activity records first and the check LAST, as the
  // commit point of the read; a re-read skips activity keys already written.
  if (native) {
    const state = (basis, ref, extra = {}) => {
      const id = activityStateKey(key, basis, ref)
      const prior = st.index.get(id)
      // Written by a crashed run of this same read: same check, basis and ref.
      if (prior && prior.body.check_id === key && prior.body.basis === basis && (prior.body.ref ?? null) === (ref ?? null)) return null
      return put({ kind: 'activity', id, session: sessionEnv, body: { check_id: key, basis, ref: ref ?? null, activity_at: null, evidence_class: 'E1', observed_at: now, ...extra } }, now)
    }
    const ops = []
    if (native.turn_in_flight) ops.push(state('busy_now_turn', null))
    if (native.busy_background) ops.push(state('busy_now_background', null))
    for (const p of native.pending ?? []) {
      // DESIGN-GAP: the surfacing order sorts by deadline and the lapse rule
      // needs the prompt's time, but the activity body carries neither.
      // Added fields.
      ops.push(state('pending_permission', p.ref, { raised_at: p.raised_at ?? null, deadline: p.deadline ?? null }))
    }
    for (const op of ops) if (op) yield op
    for (const e of native.events ?? []) {
      const id = activityEventKey({ hostEventId: e.id, session, basis: e.basis, activityAt: e.activity_at })
      // The same event seen again at a later read is skipped, but only when
      // it IS the same event: a different event under the same key goes on
      // to append(), which records the collision as an idempotency_conflict
      // instead of dropping it silently.
      if (sameEvent(st.index.get(id), sessionEnv, e)) continue
      yield put({ kind: 'activity', id, session: sessionEnv, body: { check_id: key, basis: e.basis, ref: e.ref ?? null, activity_at: e.activity_at ?? null, evidence_class: 'E1', observed_at: now } }, now)
    }
  }
  yield put({ kind: 'check', id: key, session: sessionEnv, refs: { tick: opts.tickId ?? null, report: body.report_id, investigation: opts.investigationId ?? null }, body }, now)
  return { body, native, report: read.report ?? null }
}
