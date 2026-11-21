/**
 * The single-slot owner queue.
 *
 * Items have one origin each; the origin fixes the item's identity, what
 * opens an episode and the only evidence that closes it. Every step is one
 * row of the design's item transition table and writes one `surface` record (or, for
 * the three sending steps, an attempt record, the send, and an outcome
 * record). Four counters are stored on every surface record and copied
 * forward, so a restart reads them back rather than recounting.
 *
 * A "send" here is only a returned effect description: `{ op: 'send' }`.
 */

import { sourceCaps } from './config.js'
import { effectiveState, sessionsOf } from './derive.js'
import { compareKeys } from './policy.js'
import { put } from './checks.js'
import { SENDING_STEPS, itemIds, ownerAckKey, sessionKey, surfaceKey, systemKey } from './keys.js'

const ZERO = Object.freeze({ presentation: 0, shows_counted: 0, reminders_used: 0, returns_used: 0 })
const DISMISSABLE = new Set(['seed', 'issue', 'attention', 'gone'])

function envOf(item) {
  return item.session ? { source: item.session.source, native_id: item.session.native_id, incarnation: item.session.incarnation ?? null } : null
}

function body(item, step, phase, n, c, extra) {
  return {
    item_id: item.itemId,
    item_kind: item.kind,
    origin: item.origin,
    episode: item.episode,
    step,
    n,
    phase,
    outcome: null,
    presentation: c.presentation,
    shows_counted: c.shows_counted,
    reminders_used: c.reminders_used,
    returns_used: c.returns_used,
    fingerprint: item.fingerprint ?? null,
    opened_by: item.openedBy ?? null,
    reason: null,
    report_id: item.reportId ?? null,
    channel_ref: null,
    resolution_evidence: null,
    source: item.source ?? null,
    ...extra,
  }
}

/** A step that sends nothing: one surface record with phase `none`. */
function* step(ctx, item, name, { ordCtx = {}, c = item.counters, extra = {}, now }) {
  const ordinal = ctx.policy.surfaceOrdinal(name, { presentation: c.presentation, returns: c.returns_used, contentRef: item.contentRef, ...ordCtx })
  const id = surfaceKey(item.itemId, item.episode, name, ordinal, 'none')
  return yield put({ kind: 'surface', id, session: envOf(item), body: body(item, name, 'none', ordinal, c, extra) }, now)
}

/** A sending step: attempt record, the send, outcome record. */
function* sendStep(ctx, item, name, { ordCtx = {}, c, extra = {}, now }) {
  if (!SENDING_STEPS.has(name)) throw new Error(`sendStep: ${name} does not send`)
  const ordinal = ctx.policy.surfaceOrdinal(name, { presentation: c.presentation, returns: c.returns_used, ...ordCtx })
  const attemptId = surfaceKey(item.itemId, item.episode, name, ordinal, 'attempt')
  if (ctx.policy.attemptAlreadyRecorded(ctx.ledger, attemptId)) return { sent: false }
  yield put({ kind: 'surface', id: attemptId, session: envOf(item), body: body(item, name, 'attempt', ordinal, c, extra) }, now)
  const outcome = yield {
    op: 'send',
    effect: { attempt_id: attemptId, item_id: item.itemId, item_kind: item.kind, origin: item.origin, episode: item.episode, step: name, n: ordinal, session: envOf(item) },
  }
  const delivered = outcome === 'failed' ? 'failed' : 'delivered'
  const outId = surfaceKey(item.itemId, item.episode, name, ordinal, 'outcome')
  yield put({ kind: 'surface', id: outId, session: envOf(item), body: { ...body(item, name, 'outcome', ordinal, c, extra), outcome: delivered, attempt_id: attemptId } }, now)
  return { sent: true }
}

/** Record an attempt that has no outcome as `delivery_unknown`; never re-send it. */
export function* sweepUnknownDeliveries(ctx, now) {
  for (const a of ctx.state.attempts.values()) {
    if (a.hasOutcome || a.unknown) continue
    yield put({ kind: 'system', id: systemKey('delivery_unknown', [a.id]), body: { event: 'delivery_unknown', detail: { ids: [a.id] } } }, now)
  }
}

function* raise(ctx, { itemId, kind, origin, session, source, ref, fingerprint, contentRef, contentAt = null, reportId, deadline, orderTime, closable = true, seed = null, now }) {
  const st = ctx.state
  const existing = st.items.get(itemId)
  if (!ctx.policy.mayOpenEpisode(existing, ref)) return false
  const item = {
    itemId,
    kind,
    origin,
    session,
    source,
    episode: (existing?.episode ?? 0) + 1,
    counters: { ...ZERO },
    openedBy: ref,
    fingerprint,
    reportId,
  }
  yield* step(ctx, item, 'queued', {
    c: ZERO,
    now,
    extra: { content_ref: contentRef ?? ref, content_at: contentAt, deadline: deadline ?? null, order_time: orderTime ?? null, closable, seed },
  })
  return true
}

function* resolve(ctx, item, { now, evidence }) {
  if (item.state === 'acknowledged' && item.ack) {
    const vk = ownerAckKey(item.itemId, item.episode, item.ack.ackRef, 'verify')
    yield put({ kind: 'owner_ack', id: vk, session: envOf(item), body: { item_id: item.itemId, episode: item.episode, ack_ref: item.ack.ackRef, phase: 'verify', intent: 'done', basis: 'owner_direct', verified: true } }, now)
  }
  yield* step(ctx, item, 'resolved', { now, extra: { resolution_evidence: evidence ?? null } })
}

function* withdraw(ctx, item, { now, reason }) {
  yield* step(ctx, item, 'withdrawn', { now, extra: { reason } })
}

function* update(ctx, item, { now, changeRef, changeAt = null, fingerprint, reportId, deadline }) {
  const cfg = ctx.state.config
  const requeue = item.state === 'exhausted' && ctx.policy.requeueFromExhausted(item, cfg)
  const next = { ...item, fingerprint, reportId: reportId ?? item.reportId }
  yield* step(ctx, next, 'updated', {
    now,
    ordCtx: { changeRef },
    extra: { content_ref: changeRef, content_at: changeAt, requeue, ...(deadline !== undefined ? { deadline } : {}) },
  })
}

function reportBody(st, id) {
  return id ? (st.reports.get(id)?.body ?? null) : null
}

// ── origins ────────────────────────────────────────────────────────────────

function* declaredBlocks(ctx, source, now) {
  const st = ctx.state
  const P = ctx.policy
  const cfg = st.config
  for (const s of sessionsOf(st, source)) {
    const latest = reportBody(st, s.latestAuthored)
    const id = itemIds.declared(s.session)
    const it = st.items.get(id)
    const ob = latest ? P.isOwnerBlock(latest, cfg) : false
    if (it?.open) {
      if (P.declaredResolvedBy(latest, reportBody(st, it.openedBy), cfg)) {
        yield* resolve(ctx, it, { now, evidence: s.latestAuthored })
        continue
      }
      if (ob) {
        const fp = P.blockFingerprint(latest)
        if (P.contentChanged(it, { fingerprint: fp, ref: s.latestAuthored, at: latest.last_report_at })) {
          yield* update(ctx, it, { now, changeRef: s.latestAuthored, changeAt: latest.last_report_at, fingerprint: fp, reportId: s.latestAuthored })
        }
      }
    } else if (ob) {
      yield* raise(ctx, {
        itemId: id,
        kind: 'owner_block',
        origin: 'declared',
        session: s.session,
        source: s.session.source,
        ref: s.latestAuthored,
        fingerprint: P.blockFingerprint(latest),
        reportId: s.latestAuthored,
        contentAt: latest.last_report_at,
        orderTime: latest.last_report_at,
        now,
      })
    }
  }
}

function* prompts(ctx, source, now) {
  const st = ctx.state
  const P = ctx.policy
  for (const s of sessionsOf(st, source)) {
    const id = itemIds.prompt(s.session)
    const it = st.items.get(id)
    // DESIGN-GAP: whether a prompt is pending can only be read from a check
    // that carried native state; an errored read says nothing either way.
    // The model evaluates the prompt origin only on such a check.
    const live = s.cur && s.cur.nativeAvailable
    if (it?.open) {
      const cur = s.prompts.get(it.contentRef)
      const pending = live ? [...s.cur.pending].map((ref) => s.prompts.get(ref)).filter((p) => p && p.status === 'pending') : []
      pending.sort((a, b) => (a.raised_at ?? 0) - (b.raised_at ?? 0) || (a.ref < b.ref ? -1 : 1))
      const latest = pending[pending.length - 1]
      const answered = P.promptAnswered(it, cur, s.prompts, { livePending: live ? pending.length : null })
      if (answered) {
        yield* resolve(ctx, it, { now, evidence: answered })
        continue
      }
      if (!live) continue
      if (latest && P.contentChanged(it, { ref: latest.ref, at: latest.raised_at })) {
        yield* update(ctx, it, { now, changeRef: latest.ref, changeAt: latest.raised_at, fingerprint: it.fingerprint, deadline: latest.deadline ?? null })
      } else if (!latest) {
        // DESIGN-GAP: the lapse rule's newer report does not say newer than
        // what. The model uses a report authored after the item's
        // latest prompt was raised.
        const rep = reportBody(st, s.latestAuthored)
        const raisedAt = cur?.raised_at ?? -Infinity
        if (rep && rep.last_report_at > raisedAt) yield* withdraw(ctx, it, { now, reason: 'lapsed' })
      }
    } else if (live) {
      const pending = [...s.cur.pending].map((ref) => s.prompts.get(ref)).filter((p) => p && p.status === 'pending')
      pending.sort((a, b) => (a.raised_at ?? 0) - (b.raised_at ?? 0) || (a.ref < b.ref ? -1 : 1))
      const latest = pending[pending.length - 1]
      if (latest) {
        yield* raise(ctx, {
          itemId: id,
          kind: 'owner_block',
          origin: 'prompt',
          session: s.session,
          source: s.session.source,
          ref: latest.ref,
          contentRef: latest.ref,
          contentAt: latest.raised_at ?? null,
          deadline: latest.deadline ?? null,
          orderTime: latest.raised_at ?? now,
          reportId: s.latestAuthored,
          now,
        })
      }
    }
  }
}

function* attention(ctx, source, now, signals) {
  const st = ctx.state
  // Resolution first, so a session listed again closes its `gone` item before
  // this tick's signals are applied.
  for (const it of [...st.items.values()]) {
    if (!it.open || it.source !== source || (it.origin !== 'attention' && it.origin !== 'gone')) continue
    const s = st.sessions.get(it.sk)
    if (!s) continue
    if (it.origin === 'gone') {
      if (s.listed && s.cur && s.cur.listed) yield* resolve(ctx, it, { now, evidence: s.cur.checkId })
      continue
    }
    const latest = reportBody(st, s.latestAuthored)
    const opening = reportBody(st, it.reportId)
    if (latest && (!opening || latest.last_report_at > opening.last_report_at)) {
      yield* resolve(ctx, it, { now, evidence: s.latestAuthored })
    }
  }
  for (const sig of signals) {
    if (sig.type === 'attention') {
      const rep = reportBody(st, sig.reportId)
      yield* raise(ctx, {
        itemId: itemIds.attention(sig.session, sig.reportId),
        kind: 'session_attention',
        origin: 'attention',
        session: sig.session,
        source: sig.session.source,
        ref: sig.onset,
        reportId: sig.reportId,
        orderTime: rep ? rep.last_report_at : now,
        now,
      })
    } else if (sig.type === 'gone') {
      const raised = yield* raise(ctx, {
        itemId: itemIds.gone(sig.session),
        kind: 'session_attention',
        origin: 'gone',
        session: sig.session,
        source: sig.session.source,
        ref: sig.onset,
        reportId: sig.reportId,
        orderTime: now,
        now,
      })
      if (raised || st.items.get(itemIds.gone(sig.session))?.open) {
        for (const it of [...st.items.values()]) {
          if (it.open && it.origin === 'attention' && it.sk === sessionKey(sig.session)) {
            yield* withdraw(ctx, it, { now, reason: 'superseded' })
          }
        }
      }
    }
  }
}

function* outages(ctx, source, now, signals, tickId) {
  const st = ctx.state
  const id = itemIds.outage(source)
  const it = st.items.get(id)
  if (it?.open) {
    const ok = sessionsOf(st, source).find((s) => s.cur && s.cur.tickId === tickId && (s.cur.outcome === 'ok' || s.cur.outcome === 'no_report'))
    if (ok) {
      yield* resolve(ctx, it, { now, evidence: ok.cur.checkId })
      return
    }
  }
  for (const sig of signals) {
    if (sig.type !== 'outage') continue
    yield* raise(ctx, { itemId: id, kind: 'source_unreachable', origin: 'outage', session: null, source, ref: sig.onset, orderTime: now, now })
  }
}

function* seeds(ctx, now) {
  const st = ctx.state
  const all = sessionsOf(st, null)
  for (const s of all) {
    const latest = reportBody(st, s.latestAuthored)
    const seed = latest?.seed_ref
    const ids = new Set()
    if (seed) ids.add(itemIds.seed(seed.scope, seed.session))
    // An open seed item stays subject to its evidence even after the session
    // that named it moved on to another line.
    for (const it of st.items.values()) if (it.open && it.origin === 'seed' && it.sk === s.sk) ids.add(it.itemId)
    for (const id of ids) {
      const it = st.items.get(id)
      const ref = it?.open ? it.seed : seed
      if (!ref) continue
      const evidence = all.find((t) => t.sk !== s.sk && t.scope != null && t.scope === ref.scope && t.firstReportAt != null && t.firstReportAt > ref.written_at)
      if (it?.open) {
        if (evidence) yield* resolve(ctx, it, { now, evidence: evidence.sk })
        continue
      }
      if (evidence || id !== itemIds.seed(seed.scope, seed.session)) continue
      yield* raise(ctx, {
        itemId: id,
        kind: 'session_request',
        origin: 'seed',
        session: s.session,
        source: s.session.source,
        ref: ref.written_at,
        reportId: s.latestAuthored,
        orderTime: ref.written_at,
        // DESIGN-GAP: the rule for a source that gives no working directory
        // does not say which source: the one that named the seed, or the one the
        // seed will be pasted into. The model uses the naming session's.
        closable: sourceCaps(st.config, s.session.source).scope,
        seed: ref,
        now,
      })
    }
  }
}

// ── the slot ───────────────────────────────────────────────────────────────

function openItems(st) {
  return [...st.items.values()].filter((it) => it.open)
}

function* verifyAcknowledged(ctx, { source, now, tickOpenSeq }) {
  const st = ctx.state
  const P = ctx.policy
  for (const it of openItems(st)) {
    if (it.state !== 'acknowledged' || !it.ack) continue
    if (it.ack.seq >= tickOpenSeq) continue
    // DESIGN-GAP: "next tick" is ambiguous when each source has its own
    // ticks. The model verifies at the next tick of the item's own source,
    // and at the next tick of any source for an item with none.
    if (it.source != null && it.source !== source) continue
    const vk = ownerAckKey(it.itemId, it.episode, it.ack.ackRef, 'verify')
    yield put({ kind: 'owner_ack', id: vk, session: envOf(it), body: { item_id: it.itemId, episode: it.episode, ack_ref: it.ack.ackRef, phase: 'verify', intent: 'done', basis: 'owner_direct', verified: false } }, now)
    const next = P.verifyFailedStep(it)
    if (next === 'returned') {
      const c = { ...it.counters, returns_used: it.counters.returns_used + 1 }
      yield* sendStep(ctx, it, 'returned', { c, now, extra: { note: 'acknowledged, not yet confirmed' } })
    } else {
      yield* step(ctx, it, 'exhausted', { now })
    }
  }
}

function* activeTiming(ctx, now) {
  const st = ctx.state
  const P = ctx.policy
  const cfg = st.config
  const active = openItems(st).filter((it) => effectiveState(it, now) === 'active')
  if (active.length === 0) return
  const it = active[0]
  if (P.expiryDue(it, now, cfg)) {
    yield* step(ctx, it, 'expired', { now })
    return
  }
  const queued = openItems(st)
    .filter((x) => effectiveState(x, now) === 'queued')
    .sort((a, b) => compareKeys(P.orderKey(a, now), P.orderKey(b, now)))
  if (queued.some((x) => P.preempts(x, it, now, cfg))) {
    yield* step(ctx, it, 'preempted', { now })
    return
  }
  const k = P.reminderDue(it, now, cfg)
  if (k != null) {
    const c = { ...it.counters, reminders_used: P.remindersAfter(it, k) }
    yield* sendStep(ctx, it, 'reminded', { c, ordCtx: { k }, now })
  }
}

function* fillSlot(ctx, now) {
  const st = ctx.state
  const P = ctx.policy
  const cfg = st.config
  if (openItems(st).some((it) => P.slotHolderStates.has(effectiveState(it, now)))) return
  const queue = openItems(st)
    .filter((it) => effectiveState(it, now) === 'queued')
    .sort((a, b) => compareKeys(P.orderKey(a, now), P.orderKey(b, now)))
  for (const it of queue) {
    if (P.canShow(it, cfg)) {
      const counted = P.showIsCounted(it)
      const c = { ...it.counters, presentation: it.counters.presentation + 1, shows_counted: it.counters.shows_counted + (counted ? 1 : 0) }
      yield* sendStep(ctx, it, 'shown', { c, now, extra: { counted } })
      return
    }
    yield* step(ctx, it, 'exhausted', { now })
  }
}

/** Plan the owner-queue part of one tick. */
export function* planQueue(ctx, { source, tickId, now, signals, tickOpenSeq }) {
  yield* declaredBlocks(ctx, source, now)
  yield* prompts(ctx, source, now)
  yield* attention(ctx, source, now, signals)
  yield* outages(ctx, source, now, signals, tickId)
  yield* seeds(ctx, now)
  yield* verifyAcknowledged(ctx, { source, now, tickOpenSeq })
  yield* activeTiming(ctx, now)
  yield* fillSlot(ctx, now)
}

/**
 * Plan an owner action on one item: "done", a deferral to a time, or a
 * dismissal. `ackRef` is the channel's own message id.
 */
export function* planOwnerEvent(ctx, { itemId, intent, ackRef, until, now, basis = 'owner_direct' }) {
  const st = ctx.state
  yield* sweepUnknownDeliveries(ctx, now)
  const it = st.items.get(itemId)
  if (!it || !it.open) return { applied: false }
  const ackKey = ownerAckKey(it.itemId, it.episode, ackRef, 'ack')
  const resumed = st.index.has(ackKey)
  const es = effectiveState(it, now)
  const ack = () => put({ kind: 'owner_ack', id: ackKey, session: envOf(it), body: { item_id: it.itemId, episode: it.episode, ack_ref: ackRef, phase: 'ack', intent, basis, verified: null } }, now)
  // DESIGN-GAP: the transition table gives owner actions only on an active item
  // (and dismissal in any open state). "Done" or a deferral on a queued,
  // deferred, acknowledged or exhausted item has no row; the model records
  // nothing for it.
  if (intent === 'done') {
    if (es !== 'active' && !resumed) return { applied: false }
    yield ack()
    if (!it.closable) {
      // The item origins: a seed whose scope cannot be read is closed by
      // "done", labelled owner-stated and unverified. DESIGN-GAP: the table sends
      // "done" to `acknowledged` for every item; the two rules conflict here.
      yield* withdraw(ctx, it, { now, reason: 'owner_stated_unverified' })
    }
    return { applied: true }
  }
  if (intent === 'defer') {
    if ((es !== 'active' && !resumed) || until == null) return { applied: false }
    yield ack()
    if (it.state !== 'deferred' || it.deferUntil !== until) {
      // DESIGN-GAP: neither the `deferred` record nor the `owner_ack` body
      // has a field for the time the item is deferred to, so the re-queue
      // time is not derivable from the ledger. Added field `until`.
      yield* step(ctx, it, 'deferred', { now, ordCtx: { ackRef }, extra: { until } })
    }
    return { applied: true }
  }
  if (intent === 'dismiss') {
    if (!DISMISSABLE.has(it.origin)) return { applied: false }
    yield ack()
    yield* withdraw(ctx, it, { now, reason: 'dismissed' })
    return { applied: true }
  }
  return { applied: false }
}
