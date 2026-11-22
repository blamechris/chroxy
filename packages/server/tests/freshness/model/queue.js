/**
 * The single-slot owner queue.
 *
 * Items have one origin each; the origin fixes the item's identity, what
 * opens an episode and the only evidence that closes it. Every step is one
 * row of the item transition table (README) and writes one `surface` record (or, for
 * the three sending steps, an attempt record, the send, and an outcome
 * record). Five counters are stored on every surface record and copied
 * forward, so a restart reads them back rather than recounting.
 *
 * A "send" here is only a returned effect description: `{ op: 'send' }`.
 */

import { sourceCaps } from './config.js'
import { effectiveState, sessionsOf } from './derive.js'
import { compareKeys } from './policy.js'
import { put } from './checks.js'
import { H } from './hash.js'
import { SENDING_STEPS, itemIds, ownerAckKey, sessionKey, surfaceKey, systemKey } from './keys.js'

const ZERO = Object.freeze({ presentation: 0, shows_counted: 0, reminders_used: 0, returns_used: 0, round_shows: 0 })
const DISMISSABLE = new Set(['seed', 'issue', 'attention', 'gone'])
const OWNER_BLOCK_ORIGINS = new Set(['owner'])

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
    round_shows: c.round_shows ?? 0,
    fingerprint: item.fingerprint ?? null,
    opened_by: item.openedBy ?? null,
    reason: null,
    report_id: item.reportId ?? null,
    channel_ref: null,
    resolution_evidence: null,
    source: item.source ?? null,
    // DESIGN-GAP (added field): an owner item's records all carry its live
    // asks, so each states the content it was made with; without it two
    // records of one step at one presentation could differ only in content
    // the record does not show.
    ...(item.asks?.size ? { asks: [...item.asks.values()] } : {}),
    ...extra,
  }
}

/** A step that sends nothing: one surface record with phase `none`. */
function* step(ctx, item, name, { ordCtx = {}, c = item.counters, extra = {}, now }) {
  const ordinal = ctx.policy.surfaceOrdinal(name, { presentation: c.presentation, returns: c.returns_used, contentRef: item.contentRef, carryRef: item.carryRef, ...ordCtx })
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

function* raise(ctx, { itemId, kind, origin, session, source, ref, fingerprint, contentRef, contentAt = null, reportId, deadline, orderTime, closable = true, seed = null, condition, handoverOf, counters = ZERO, asks, ask, now }) {
  const st = ctx.state
  const existing = st.items.get(itemId)
  if (!ctx.policy.mayOpenEpisode(existing, ref, origin)) return false
  const item = {
    itemId,
    kind,
    origin,
    session,
    source,
    episode: (existing?.episode ?? 0) + 1,
    counters: { ...counters },
    openedBy: ref,
    fingerprint,
    reportId,
  }
  yield* step(ctx, item, 'queued', {
    c: item.counters,
    now,
    extra: {
      content_ref: contentRef ?? ref,
      content_at: contentAt,
      deadline: deadline ?? null,
      order_time: orderTime ?? null,
      closable,
      seed,
      ...(condition ? { condition } : {}),
      ...(handoverOf ? { handover_of: handoverOf } : {}),
      ...(asks ? { asks, ask } : {}),
    },
  })
  return true
}

function* resolve(ctx, item, { now, evidence, closingAsk }) {
  yield* clearCarried(ctx, item, now)
  if (item.state === 'acknowledged' && item.ack) {
    const vk = ownerAckKey(item.itemId, item.episode, item.ack.ackRef, 'verify')
    yield put({ kind: 'owner_ack', id: vk, session: envOf(item), body: { item_id: item.itemId, episode: item.episode, ack_ref: item.ack.ackRef, phase: 'verify', intent: 'done', basis: 'owner_direct', verified: true } }, now)
  }
  yield* step(ctx, item, 'resolved', { now, extra: { resolution_evidence: evidence ?? null, ...(closingAsk ? { closing_ask: closingAsk } : {}) } })
}

function* withdraw(ctx, item, { now, reason, closingAsk }) {
  yield* clearCarried(ctx, item, now)
  yield* step(ctx, item, 'withdrawn', { now, extra: { reason, ...(closingAsk ? { closing_ask: closingAsk } : {}) } })
}

function reportBody(st, id) {
  return id ? (st.reports.get(id)?.body ?? null) : null
}

// ── conditions carried by an owner item ─────────────────────────────
//
// A condition is what an attention item would have said: the attention item
// it would be (session and report), the reference that would open it, the
// trigger and the time the condition began. An owner item carries a
// list of them as part of its content; each change is one `updated` step.

function openOwnerBlocks(st, sk) {
  return [...st.items.values()].filter((it) => it.open && it.sk === sk && OWNER_BLOCK_ORIGINS.has(it.origin))
}

function carries(items, attentionId) {
  return items.some((it) => it.carried.some((c) => c.attention_item === attentionId))
}

/** The trigger whose onset this is: a recheck's opening reference is the onset of the cycle that led to it. */
function triggerAt(st, sk, onset, trigger) {
  if (trigger && trigger !== 'recheck') return trigger
  for (const inv of st.investigations.values()) {
    if (inv.sk === sk && inv.onset === onset && inv.trigger !== 'recheck') return inv.trigger
  }
  return trigger ?? null
}

function conditionOf(st, { attentionId, ref, root, reportId, sk, trigger, since, now }) {
  return {
    attention_item: attentionId,
    opened_by: ref,
    // The reference that first opened (or would have opened) the condition,
    // kept through every merge and handover: the condition's identity.
    root: root ?? ref,
    report_id: reportId ?? null,
    trigger: triggerAt(st, sk, ref, trigger),
    since: since ?? st.checks.get(ref)?.body.checked_at ?? now,
  }
}

/** The evidence that closes an attention item: a newer authored report than its own. */
function conditionResolved(st, sk, cond) {
  const s = st.sessions.get(sk)
  const latest = reportBody(st, s?.latestAuthored)
  if (!latest) return false
  const opening = reportBody(st, cond.report_id)
  return !opening || latest.last_report_at > opening.last_report_at
}

/**
 * One change to the conditions an owner item carries: `carry` adds
 * one, `clear` drops one. It is the `updated` row of the transition table:
 * it sends nothing, and from exhausted it queues the item again only if a
 * counted show is left.
 */
function* carryStep(ctx, item, { now, op, cond, path, from = null }) {
  const cfg = ctx.state.config
  const requeue = item.state === 'exhausted' && ctx.policy.requeueFromExhausted(item, cfg)
  const carried = op === 'carry' ? [...item.carried, cond] : item.carried.filter((c) => c.attention_item !== cond.attention_item)
  // A condition is carried at most once per episode and cleared at most once
  // after that, so the change reference never repeats.
  const changeRef = H('carried', op, cond.attention_item, cond.opened_by)
  yield* step(ctx, item, 'updated', {
    now,
    ordCtx: { changeRef },
    extra: { requeue, carry: { op, path, from, ...cond }, carried },
  })
}

/**
 * DESIGN-GAP: what becomes of a carried condition whose own closing evidence
 * arrives while the owner item is still open. The model drops it from
 * the content with another `updated` step, so the item names only what still
 * holds; the dropped condition stays in the item's history.
 */
function* clearCarried(ctx, item, now, { reason = 'resolved', all = false } = {}) {
  if (!OWNER_BLOCK_ORIGINS.has(item.origin) || !item.carried?.length) return
  for (const c of item.carried.slice()) {
    if (all || conditionResolved(ctx.state, item.sk, c)) yield* carryStep(ctx, item, { now, op: 'clear', cond: c, path: reason })
  }
}

/**
 * An attention signal for a session. With no open owner item it raises
 * the attention item, as it always did. With one, the condition is merged
 * into that item instead, if the attention item would have been raised: it
 * is not open, its opening reference is unused and was never carried, and
 * its closing evidence has not arrived.
 */
function* attentionSignal(ctx, sig, now) {
  const st = ctx.state
  const P = ctx.policy
  const attentionId = itemIds.attention(sig.session, sig.reportId)
  const consumed = st.carriedRefs.get(attentionId)?.has(sig.onset) ?? false
  const obs = P.attentionBesideOwnerBlock === 'raise' ? [] : openOwnerBlocks(st, sig.sk)
  const rep = reportBody(st, sig.reportId)
  const condition = { trigger: triggerAt(st, sig.sk, sig.onset, sig.trigger), since: st.checks.get(sig.onset)?.body.checked_at ?? now, root: sig.onset }
  if (obs.length === 0) {
    if (consumed) return
    yield* raise(ctx, {
      itemId: attentionId,
      kind: 'session_attention',
      origin: 'attention',
      session: sig.session,
      source: sig.session.source,
      ref: sig.onset,
      reportId: sig.reportId,
      orderTime: rep ? rep.last_report_at : now,
      condition,
      now,
    })
    return
  }
  if (P.attentionBesideOwnerBlock === 'drop') return
  const existing = st.items.get(attentionId)
  // An open attention item is merged by the reverse-order rule below.
  if (existing?.open || consumed || !P.mayOpenEpisode(existing, sig.onset, 'attention')) return
  if (carries(obs, attentionId)) return
  const cond = conditionOf(st, { attentionId, ref: sig.onset, reportId: sig.reportId, sk: sig.sk, ...condition, now })
  if (conditionResolved(st, sig.sk, cond)) return
  yield* carryStep(ctx, obs[0], { now, op: 'carry', cond, path: 'signal' })
}

/**
 * A condition that an owner item still carried when it closed: raised as its
 * own attention item, as for a session with no open item, or carried on into
 * the item's next episode if an ask opened one in the same tick. Runs in the
 * tick that closed the item (a crash re-runs it there).
 *
 * DESIGN-GAP: an attention item withdrawn as merged has used its opening
 * reference, and a new episode never opens on a used reference. Its
 * condition is raised again under a reference derived from that one and the
 * owner episode that carried it, which no other episode can use.
 */
function* handOver(ctx, ho, cond, now) {
  const st = ctx.state
  const P = ctx.policy
  const attentionId = cond.attention_item
  const existing = st.items.get(attentionId)
  if (existing?.open || conditionResolved(st, ho.sk, cond)) return
  const obs = openOwnerBlocks(st, ho.sk)
  if (obs.length > 0) {
    if (carries(obs, attentionId)) return
    const target = obs[0]
    if (target.carriedEver.has(`${attentionId}|${cond.opened_by}`)) return
    yield* carryStep(ctx, target, { now, op: 'carry', cond, path: 'handover', from: ho.key })
    return
  }
  const ref = existing?.usedRefs.has(cond.opened_by) ? H(cond.opened_by, 'unmerged', ho.itemId, ho.episode) : cond.opened_by
  const root = cond.root ?? cond.opened_by
  const rep = reportBody(st, cond.report_id)
  // DESIGN-GAP (counters): the episode continues the counters of the
  // condition's previous attention episode. Reminders and the time limit
  // count from this episode's own latest show or return, as for any episode:
  // the previous show was made before the merge and is no anchor for a show
  // not yet made. An owner deferral pending when the condition was merged
  // does not survive it; deferrals keep their meaning within an episode.
  const counters = (P.inheritCountersOnHandover && existing?.rootCounters.get(root)) || ZERO
  yield* raise(ctx, {
    itemId: attentionId,
    kind: 'session_attention',
    origin: 'attention',
    session: ho.session,
    source: ho.source,
    ref,
    reportId: cond.report_id,
    orderTime: rep ? rep.last_report_at : now,
    condition: { trigger: cond.trigger, since: cond.since, root },
    handoverOf: ho.key,
    counters,
    now,
  })
}

/** Per session of the source with an open owner item: drop what has ended; merge what is open beside it. */
function* reconcileOwnerBlocks(ctx, source, now) {
  const st = ctx.state
  const P = ctx.policy
  for (const s of sessionsOf(st, source)) {
    const obs = openOwnerBlocks(st, s.sk)
    if (obs.length === 0) continue
    for (const ob of obs) yield* clearCarried(ctx, ob, now)
    if (P.attentionBesideOwnerBlock === 'raise' || !P.mergeOpenAttention) continue
    // DESIGN-GAP (reverse order): an attention item already open when its
    // session gets an owner item is withdrawn, reason `merged`, after
    // its condition is carried on the owner item (carried first, so a
    // crash between the two loses nothing).
    for (const a of [...st.items.values()]) {
      if (!a.open || a.origin !== 'attention' || a.sk !== s.sk) continue
      const current = openOwnerBlocks(st, s.sk)
      if (!carries(current, a.itemId)) {
        const cond = conditionOf(st, { attentionId: a.itemId, ref: a.openedBy, root: a.root, reportId: a.reportId, sk: s.sk, trigger: a.condition?.trigger, since: a.condition?.since, now })
        yield* carryStep(ctx, current[0], { now, op: 'carry', cond, path: 'open_attention' })
      }
      yield* withdraw(ctx, a, { now, reason: 'merged' })
    }
  }
}

// ── origins ────────────────────────────────────────────────────────────────

// ── the owner item and its asks ────────────────────────────────────────────
//
// One owner item per session. Its content lists each ask that is live: the
// declared block (an authored owner-block report) and the pending prompt.
// Each ask opens on its own reference and ends on its own evidence; the item
// opens with its first ask and closes with its last.

/** An ask as the per-origin rules see it (content change, prompt answer and lapse). */
function askView(ask) {
  return { askKind: ask.kind, contentAt: ask.content_at ?? null, contentRef: ask.content_ref ?? ask.report_id ?? null, fingerprint: ask.fingerprint ?? null }
}

/** The open owner item carrying a live ask of this kind for the session, if any. */
function ownerWith(ctx, session, kind) {
  const it = ctx.state.items.get(ctx.policy.ownerItemOf(session, kind))
  return it?.open && it.asks.has(kind) ? it : null
}

function* askChange(ctx, item, { now, op, ask, asks, extra = {} }) {
  // Each ask has its own opening reference, never reused on the item, so
  // these change references never repeat when an ask leaves and another of
  // its kind joins later.
  const changeRef = H('ask', op, ask.kind, ask.opened_by, op === 'content' ? (ask.content_ref ?? ask.report_id) : null)
  yield* step(ctx, item, 'updated', { now, ordCtx: { changeRef }, extra: { content_ref: changeRef, ask: { op, ...ask }, asks, ...extra } })
}

/**
 * An ask arriving: it opens the item's episode, or joins the open item.
 *
 * DESIGN-GAP: what a new ask does in each state of the item. With a counted
 * show left: an item holding the slot (active, or acknowledged and waiting
 * for its verification) is shown again at once, and an acknowledgment
 * pending then applies to the earlier content and is not verified; a queued
 * item (behind another, preempted, or back from expiry) keeps its place and
 * its next show is a counted one; a deferred or exhausted item is queued
 * again, so the new ask cancels a deferral. With no counted show left, a
 * prompt round is still owed one show (see `roundShow`); a declared ask only
 * changes the content: nothing is sent and an exhausted item stays
 * exhausted.
 */
function* addAsk(ctx, session, ask, now) {
  const st = ctx.state
  const P = ctx.policy
  const cfg = st.config
  const id = P.ownerItemOf(session, ask.kind)
  const it = st.items.get(id)
  if (!P.mayAddAsk(it, ask.opened_by, ask.kind)) return
  if (!it?.open) {
    yield* raise(ctx, {
      itemId: id,
      kind: 'owner_block',
      origin: 'owner',
      session,
      source: session.source,
      ref: ask.opened_by,
      contentRef: ask.opened_by,
      contentAt: ask.content_at ?? null,
      deadline: ask.deadline ?? null,
      orderTime: ask.order_time,
      reportId: ask.report_id ?? null,
      asks: [ask],
      ask: { op: 'open', ...ask },
      now,
    })
    return
  }
  const show = P.newAskShows(it, cfg)
  // With the counted shows used, a prompt round still earns its own show.
  const round = !show && P.promptRoundShows(it, ask, cfg)
  const holder = P.slotHolderStates.has(it.state)
  yield* askChange(ctx, it, {
    now,
    op: 'join',
    ask,
    asks: [...it.asks.values(), ask],
    extra: {
      show_now: (show || round) && holder,
      counted_next: show,
      requeue: show && (it.state === 'exhausted' || it.state === 'deferred'),
      ...(round ? { round_owed: P.showsPerRound } : {}),
    },
  })
}

/**
 * The show a prompt round earns once the counted shows are used.
 *
 * DESIGN-GAP: a round's show, in each state of the item. Holding the slot
 * (active, or acknowledged and waiting for its verification tick): shown at
 * once, and the item keeps holding the slot as it did before. Queued (behind
 * another item, preempted, back from expiry), deferred or exhausted: shown
 * when the slot is free, in the item's own place in the order; the item
 * then keeps its state, so a queued item with no counted show left is
 * exhausted at the slot as usual, and a deferred one stays deferred. The
 * show moves neither the reminder nor the time-limit clock, so it brings no
 * reminder, return or expiry the item would not otherwise have had; a
 * reminder still unused falls due when it would have anyway.
 */
function* roundShow(ctx, it, now) {
  const c = ctx.policy.roundShowCounters(it.counters)
  yield* sendStep(ctx, it, 'shown', { c, now, extra: { counted: false, round: true } })
}

/** An ask ending: removed from the content (nothing sent), or, as the last ask, the item's closing step. */
function* endAsk(ctx, item, kind, { now, how, evidence = null }) {
  const P = ctx.policy
  if (P.closesOnAskEnd(item, kind)) {
    if (how === 'lapsed') yield* withdraw(ctx, item, { now, reason: 'lapsed', closingAsk: kind })
    else yield* resolve(ctx, item, { now, evidence, closingAsk: kind })
    return
  }
  // DESIGN-GAP: an ask ending while another is live is a content change by
  // removal. It does not queue an exhausted item again: there is less for
  // the owner to do, not more.
  const ask = item.asks.get(kind)
  yield* askChange(ctx, item, { now, op: 'end', ask: { ...ask, how, evidence }, asks: [...item.asks.values()].filter((a) => a.kind !== kind), extra: { requeue: false } })
}

/** New content within a live ask (a new owner-block wording; a newer prompt): the `updated` row. */
function* changeAsk(ctx, item, ask, now) {
  const requeue = item.state === 'exhausted' && ctx.policy.requeueFromExhausted(item, ctx.state.config)
  yield* askChange(ctx, item, { now, op: 'content', ask, asks: [...item.asks.values()].map((a) => (a.kind === ask.kind ? ask : a)), extra: { requeue } })
}

/**
 * The asks of each session of the source, in three passes: asks that end,
 * then new content within live asks, then asks that arrive.
 *
 * DESIGN-GAP: when one tick both ends an item's last ask and brings a new
 * one, the ending is taken first, so the new ask opens a new episode rather
 * than keeping the old one open.
 */
function* ownerAsks(ctx, source, now) {
  const st = ctx.state
  const P = ctx.policy
  const cfg = st.config
  for (const s of sessionsOf(st, source)) {
    const latest = reportBody(st, s.latestAuthored)
    const ob = latest ? P.isOwnerBlock(latest, cfg) : false
    // DESIGN-GAP: whether a prompt is pending can only be read from a check
    // that carried native state; an errored read says nothing either way.
    // The model evaluates prompt asks only on such a check, so a source with
    // no native state never has one.
    const live = Boolean(s.cur && s.cur.nativeAvailable)
    const pending = live ? [...s.cur.pending].map((ref) => s.prompts.get(ref)).filter((p) => p && p.status === 'pending') : []
    pending.sort((a, b) => (a.raised_at ?? 0) - (b.raised_at ?? 0) || (a.ref < b.ref ? -1 : 1))
    const lp = pending[pending.length - 1]

    // Asks that end, each on its own evidence.
    const d = ownerWith(ctx, s.session, 'declared')
    if (d && P.declaredResolvedBy(latest, reportBody(st, d.asks.get('declared').opened_by), cfg)) {
      yield* endAsk(ctx, d, 'declared', { now, how: 'resolved', evidence: s.latestAuthored })
    }
    const p = ownerWith(ctx, s.session, 'prompt')
    if (p) {
      const view = askView(p.asks.get('prompt'))
      const cur = s.prompts.get(view.contentRef)
      const answered = P.promptAnswered(view, cur, s.prompts, { livePending: live ? pending.length : null })
      if (answered) yield* endAsk(ctx, p, 'prompt', { now, how: 'answered', evidence: answered })
      else if (live && P.promptLapsed(view, cur, latest, { livePending: pending.length })) yield* endAsk(ctx, p, 'prompt', { now, how: 'lapsed' })
    }

    // New content within a live ask.
    const d2 = ownerWith(ctx, s.session, 'declared')
    if (d2 && ob) {
      const ask = d2.asks.get('declared')
      const fp = P.blockFingerprint(latest)
      if (P.contentChanged(askView(ask), { fingerprint: fp, ref: s.latestAuthored, at: latest.last_report_at })) {
        yield* changeAsk(ctx, d2, { ...ask, report_id: s.latestAuthored, fingerprint: fp, content_at: latest.last_report_at }, now)
      }
    }
    const p2 = ownerWith(ctx, s.session, 'prompt')
    if (p2 && live && lp) {
      const ask = p2.asks.get('prompt')
      if (P.contentChanged(askView(ask), { ref: lp.ref, at: lp.raised_at })) {
        yield* changeAsk(ctx, p2, { ...ask, content_ref: lp.ref, content_at: lp.raised_at ?? null, deadline: lp.deadline ?? null }, now)
      }
    }

    // Asks that arrive.
    if (ob && !ownerWith(ctx, s.session, 'declared')) {
      yield* addAsk(ctx, s.session, { kind: 'declared', opened_by: s.latestAuthored, report_id: s.latestAuthored, fingerprint: P.blockFingerprint(latest), content_at: latest.last_report_at, order_time: latest.last_report_at }, now)
    }
    if (lp && !ownerWith(ctx, s.session, 'prompt')) {
      yield* addAsk(ctx, s.session, { kind: 'prompt', opened_by: lp.ref, content_ref: lp.ref, content_at: lp.raised_at ?? null, deadline: lp.deadline ?? null, order_time: lp.raised_at ?? now }, now)
    }
  }
}

/** An owner item that a new ask found holding the slot is shown again at once (a counted show). */
function* showNewAsks(ctx, now) {
  const st = ctx.state
  const P = ctx.policy
  const cfg = st.config
  for (const it of openItems(st)) {
    if (!it.showDue || !P.slotHolderStates.has(it.state)) continue
    if (P.newAskShows(it, cfg)) {
      const c = { ...it.counters, presentation: it.counters.presentation + 1, shows_counted: it.counters.shows_counted + 1 }
      yield* sendStep(ctx, it, 'shown', { c, now, extra: { counted: true, new_ask: true } })
    } else if (it.roundOwed > 0) {
      yield* roundShow(ctx, it, now)
    }
  }
  if (P.roundWaitsForSlot) return
  // Only a broken rule reaches this: a round shown without waiting for the slot.
  for (const it of openItems(st)) {
    if (it.roundOwed > 0 && !P.slotHolderStates.has(it.state)) yield* roundShow(ctx, it, now)
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
  if (ctx.policy.handOverOnClose) {
    for (const ho of [...st.handovers.values()]) {
      if (ho.source !== source) continue
      for (const c of ho.carried) yield* handOver(ctx, ho, c, now)
    }
  }
  for (const sig of signals) {
    if (sig.type === 'attention') {
      yield* attentionSignal(ctx, sig, now)
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
        // A condition carried for the session is superseded the same way.
        for (const ob of openOwnerBlocks(st, sessionKey(sig.session))) yield* clearCarried(ctx, ob, now, { reason: 'superseded', all: true })
      }
    }
  }
  yield* reconcileOwnerBlocks(ctx, source, now)
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
  const challenger = queued.find((x) => P.preempts(x, it, now, cfg))
  if (challenger) {
    yield* step(ctx, it, 'preempted', { now, extra: { preempted_by: challenger.itemId } })
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
  const byOrder = (a, b) => compareKeys(P.orderKey(a, now), P.orderKey(b, now))
  // Rounds owed to items that are not queued (deferred or exhausted) are
  // shown first, in their order. They take no slot, so they are kept out of
  // the pass below: an item at the head of it that is not queued would hide a
  // still-queued preemptor from the preemptor-first rule.
  const rounds = openItems(st).filter((it) => it.roundOwed > 0 && effectiveState(it, now) !== 'queued' && P.roundStillOwed(it, now)).sort(byOrder)
  for (const it of rounds) {
    yield* roundShow(ctx, it, now)
    if (P.slotHolderStates.has(it.state)) return
  }
  const queue = openItems(st)
    .filter((it) => effectiveState(it, now) === 'queued')
    .sort(byOrder)
  P.preemptorFirst(queue)
  for (const it of queue) {
    if (P.canShow(it, cfg)) {
      const counted = P.showIsCounted(it)
      const c = { ...it.counters, presentation: it.counters.presentation + 1, shows_counted: it.counters.shows_counted + (counted ? 1 : 0) }
      yield* sendStep(ctx, it, 'shown', { c, now, extra: { counted } })
      return
    }
    // A queued item with no counted show left: its round's show, if one is
    // owed, then exhausted at the slot as usual.
    if (it.roundOwed > 0 && P.roundStillOwed(it, now)) {
      yield* roundShow(ctx, it, now)
      if (P.slotHolderStates.has(it.state)) return
    }
    yield* step(ctx, it, 'exhausted', { now })
  }
}

/** Plan the owner-queue part of one tick. */
export function* planQueue(ctx, { source, tickId, now, signals, tickOpenSeq }) {
  yield* ownerAsks(ctx, source, now)
  yield* attention(ctx, source, now, signals)
  yield* outages(ctx, source, now, signals, tickId)
  yield* seeds(ctx, now)
  yield* showNewAsks(ctx, now)
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
