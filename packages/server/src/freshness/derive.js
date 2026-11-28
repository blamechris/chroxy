/**
 * Derived state: a pure fold over ledger records.
 *
 * Nothing the planners decide on lives anywhere but here, and everything here
 * is computed from records alone. A restart discards this object and rebuilds
 * it with `deriveState(records, policy)`; the result is the same object a
 * process that never stopped would hold. The policy is code, not state: it is
 * the rules the fold applies (which states disagree with a busy host, for
 * instance), never a value remembered between runs.
 */

import { sessionKey } from './keys.js'

const TRIGGERS = ['stale_report', 'native_disagreement', 'dropped_from_list', 'repeated_error']
const STALE_STATES = new Set(['running', 'unknown', 'blocked', 'stalled'])

export function createState(policy) {
  if (!policy) throw new Error('createState: a policy is required')
  return {
    policy,
    config: null,
    configRef: null,
    lastConfigId: null,
    sessions: new Map(),
    reports: new Map(),
    checks: new Map(),
    checkNative: new Map(),
    stash: new Map(),
    ticks: new Map(),
    lastClosedTick: new Map(),
    sourceTrigger: new Map(),
    investigations: new Map(),
    onsets: new Map(),
    items: new Map(),
    // Opening references of attention items whose condition an owner-block
    // item has carried: attention item id -> Set of opening references.
    carriedRefs: new Map(),
    // Conditions an owner item still carried when it closed, to be
    // handed on by the tick that closed it: "item|episode" -> handover.
    handovers: new Map(),
    attempts: new Map(),
    // The exchange files (exchange.js): outbox renders by item key, receipts
    // by outbox record, and the acknowledgements a verification contradicted.
    outbox: new Map(),
    receipts: new Map(),
    contradictions: new Map(),
    echoCounts: new Map(),
    index: new Map(),
    lastSeq: 0,
  }
}

export function deriveState(records, policy) {
  const state = createState(policy)
  for (const r of records) foldRecord(state, r)
  return state
}

function ms(ts) {
  return Date.parse(ts)
}

export function sessionOf(state, session) {
  const sk = sessionKey(session)
  let s = state.sessions.get(sk)
  if (!s) {
    s = {
      sk,
      session: { source: session.source, native_id: session.native_id, incarnation: session.incarnation ?? null },
      scope: null,
      listed: true,
      cur: null,
      prev: null,
      latestRead: null,
      latestAuthored: null,
      firstReportAt: null,
      relayedSince: null,
      prompts: new Map(),
      events: [],
      eventIds: new Set(),
      lastReadAt: null,
      lastClosedInv: null,
    }
    state.sessions.set(sk, s)
  }
  return s
}

/** The onset (a check id) of a trigger at the session's latest tick check, or null. */
export function onsetOf(s, trigger, policy) {
  if (!s.cur || !s.cur.flags[trigger]) return null
  const fresh = policy.startsNewOnset(trigger, {
    prevHolds: Boolean(s.prev && s.prev.flags[trigger]),
    sameReport: Boolean(s.prev) && s.prev.reportId === s.cur.reportId,
    staleReset: s.cur.staleReset,
  })
  return fresh ? s.cur.checkId : s.prev.onset[trigger]
}

function flagsFor(state, s) {
  const c = s.cur
  const cfg = state.config
  const f = {}
  const staleBySelf = c.freshness === 'stale' && STALE_STATES.has(c.state)
  let relayedLong = false
  if (c.freshnessReason === 'relayed_declaration' && s.relayedSince != null && cfg) {
    // DESIGN-GAP: the relayed-declaration clause of the stale trigger (unknown
    // for longer than the running stale threshold) does not say where that
    // time starts. The model measures from the first check of the current
    // unbroken run of relayed reads.
    relayedLong = c.checkedAt - s.relayedSince > cfg.freshness.running.stale_after_s * 1000
  }
  f.stale_report = staleBySelf || relayedLong
  f.native_disagreement = Boolean(c.nativeAvailable && c.turnInFlight && state.policy.disagreementStates.has(c.state))
  f.dropped_from_list = c.listed === false
  // DESIGN-GAP: the repeated-error trigger (two errored checks in a row) does
  // not say whether an investigation's own re-reads count. The model counts tick checks only.
  f.repeated_error = c.outcome === 'error' && s.prev?.outcome === 'error'
  return f
}

function refreshFlags(state, s) {
  if (s.cur) s.cur.flags = flagsFor(state, s)
}

function finalizeCur(s, policy) {
  if (!s.cur) return
  const onset = {}
  for (const t of TRIGGERS) onset[t] = onsetOf(s, t, policy)
  s.prev = { ...s.cur, onset }
}

function foldCheck(state, r) {
  const b = r.body
  const s = sessionOf(state, r.session)
  state.checks.set(r.id, { id: r.id, seq: r.seq, body: b, sk: s.sk, tickId: r.refs?.tick ?? null })
  if (b.scope != null) s.scope = b.scope
  s.lastReadAt = b.checked_at
  if (b.trigger === 'tick' || b.trigger === 'emit') setCurrent(state, s, r)
  const held = state.stash.get(r.id)
  if (held) {
    state.stash.delete(r.id)
    for (const a of held) foldActivity(state, a)
  }
}

function setCurrent(state, s, r) {
  const b = r.body
  finalizeCur(s, state.policy)
  const rep = b.report_id ? state.reports.get(b.report_id) : null
  s.cur = {
    checkId: r.id,
    seq: r.seq,
    tickId: r.refs?.tick ?? null,
    outcome: b.outcome,
    errorCode: b.error_code ?? null,
    listed: b.listed !== false,
    freshness: b.freshness,
    freshnessReason: b.freshness_reason,
    reportId: b.report_id ?? null,
    state: b.state,
    checkedAt: b.checked_at,
    nativeAvailable: Boolean(b.native_available),
    turnInFlight: false,
    busyBackground: false,
    answeringNow: Boolean(b.native_available),
    pending: new Set(),
    staleReset: false,
    flags: {},
  }
  s.listed = b.listed !== false
  if (b.report_id) s.latestRead = b.report_id
  if (b.freshness_reason === 'relayed_declaration') {
    if (s.relayedSince == null) s.relayedSince = b.checked_at
  } else if (b.outcome !== 'error') {
    s.relayedSince = null
  }
  if (rep && b.outcome === 'ok' && rep.body.evidence_class === 'E2' && b.freshness_reason !== 'time_untrusted') {
    s.latestAuthored = b.report_id
  }
  coverReport(state, s)
  refreshFlags(state, s)
}

/**
 * Every authored owner-block report a declared ask covered while it was
 * live is used, whatever its fingerprint: the ask stood on it. Derived from
 * the tick checks and the item's asks already in the ledger, so it writes
 * nothing.
 *
 * DESIGN-GAP: the reports an ask covered are recorded nowhere, and writing
 * one on every repeat read would cost a record per tick. The fold derives
 * them instead: a report is covered when a tick check makes it the
 * session's latest authored report while the item carries a live declared
 * ask.
 */
function coverReport(state, s) {
  if (!state.policy.coveredReportsUsed || !s.latestAuthored || !state.config) return
  const it = state.items.get(state.policy.ownerItemOf(s.session, 'declared'))
  if (!it?.open || !it.asks.has('declared')) return
  const rep = state.reports.get(s.latestAuthored)
  if (rep && state.policy.isOwnerBlock(rep.body, state.config)) it.usedRefs.add(s.latestAuthored)
}

function foldActivity(state, r) {
  const b = r.body
  // A read's activity records precede its check (the check is the commit
  // point, see checks.js); hold them until the check arrives.
  if (!state.checks.has(b.check_id)) {
    const list = state.stash.get(b.check_id) ?? []
    list.push(r)
    state.stash.set(b.check_id, list)
    return
  }
  const check = state.checks.get(b.check_id)
  const s = check ? state.sessions.get(check.sk) : r.session ? sessionOf(state, r.session) : null
  if (!s) return
  const isCur = s.cur && s.cur.checkId === b.check_id
  if (b.basis === 'busy_now_turn' || b.basis === 'busy_now_background' || b.basis === 'pending_permission' || b.basis === 'pending_question') {
    const snap = state.checkNative.get(b.check_id) ?? { turn_in_flight: false, busy_background: false, pending: [] }
    if (b.basis === 'busy_now_turn') snap.turn_in_flight = true
    else if (b.basis === 'busy_now_background') snap.busy_background = true
    else snap.pending.push({ ref: b.ref, raised_at: b.raised_at ?? null, deadline: b.deadline ?? null })
    state.checkNative.set(b.check_id, snap)
  }
  switch (b.basis) {
    case 'busy_now_turn':
      if (isCur) s.cur.turnInFlight = true
      break
    case 'busy_now_background':
      if (isCur) s.cur.busyBackground = true
      break
    case 'pending_permission':
    case 'pending_question': {
      const p = s.prompts.get(b.ref) ?? { ref: b.ref, status: 'pending', raised_at: b.raised_at ?? null, deadline: b.deadline ?? null }
      if (p.status === 'pending') s.prompts.set(b.ref, p)
      if (isCur) s.cur.pending.add(b.ref)
      break
    }
    case 'permission_answered_by_owner': {
      const p = s.prompts.get(b.ref) ?? { ref: b.ref, raised_at: null, deadline: null }
      s.prompts.set(b.ref, { ...p, status: 'answered', at: b.activity_at })
      break
    }
    case 'permission_lapsed': {
      const p = s.prompts.get(b.ref) ?? { ref: b.ref, raised_at: null, deadline: null }
      if (p.status !== 'answered') s.prompts.set(b.ref, { ...p, status: 'lapsed', at: b.activity_at })
      break
    }
    default:
      if (!s.eventIds.has(r.id)) {
        s.eventIds.add(r.id)
        s.events.push({ basis: b.basis, activity_at: b.activity_at ?? null, ref: b.ref ?? null })
      }
  }
  if (isCur) refreshFlags(state, s)
}

function foldReport(state, r) {
  const s = sessionOf(state, r.session)
  state.reports.set(r.id, { id: r.id, seq: r.seq, body: r.body, sk: s.sk })
  if (r.body.evidence_class === 'E2' && s.firstReportAt == null) s.firstReportAt = r.body.last_report_at
}

function onsetKey(inv) {
  return inv.sourceLevel ? `src|${inv.source}|${inv.onset}` : `${inv.sk}|${inv.trigger}|${inv.onset}`
}

function foldInvestigation(state, r) {
  const b = r.body
  const sk = r.session ? sessionKey(r.session) : null
  let inv = state.investigations.get(b.investigation_id)
  if (!inv) {
    inv = {
      id: b.investigation_id,
      sk,
      source: b.source ?? r.session?.source ?? null,
      sourceLevel: Boolean(b.source_level),
      trigger: b.trigger,
      onset: b.onset,
      cycle: b.cycle,
      reportId: b.report_id ?? null,
      tickId: r.refs?.tick ?? null,
      openSeq: r.seq,
      closed: false,
      classification: null,
    }
    state.investigations.set(b.investigation_id, inv)
  }
  // An abandoned investigation (its tick was never replayed) decided
  // nothing: it closes, but counts as no cycle and is no session's latest.
  if (b.phase === 'close' && b.classification === 'abandoned' && !state.policy.abandonedIsCycle) {
    if (!inv.closed) {
      inv.closed = true
      inv.abandoned = true
      inv.classification = b.classification
      inv.closeSeq = r.seq
      const o = inv.trigger === 'recheck' ? null : state.onsets.get(onsetKey(inv))
      if (o) o.open = null
    }
    return
  }
  if (b.trigger === 'recheck') return foldInvestigationPhase(state, inv, b, r)
  const ok = onsetKey(inv)
  let o = state.onsets.get(ok)
  if (!o) {
    o = { closed: 0, lastClass: null, open: null }
    state.onsets.set(ok, o)
  }
  if (b.phase === 'open') o.open = inv.id
  if (b.phase === 'close' && !inv.closed) {
    o.closed += 1
    o.lastClass = b.classification
    o.open = null
  }
  foldInvestigationPhase(state, inv, b, r)
}

function foldInvestigationPhase(state, inv, b, r) {
  if (b.phase !== 'close' || inv.closed) return
  inv.closed = true
  inv.classification = b.classification
  inv.closeSeq = r.seq
  inv.classifiedAt = b.classified_at
  if (!inv.sk) return
  const s = state.sessions.get(inv.sk)
  if (!s) return
  s.lastClosedInv = { id: inv.id, reportId: inv.reportId, classification: b.classification, trigger: inv.trigger, cycle: inv.cycle, at: b.classified_at, tickId: inv.tickId, ownerWaitBasis: b.owner_wait_basis ?? null }
  if (b.classification === 'no_longer_observed' && s.cur) {
    // Rule: this check starts a new stale_report onset, with fresh cycles.
    s.cur.staleReset = true
  }
}

function newItem(r) {
  const b = r.body
  return {
    itemId: b.item_id,
    kind: b.item_kind,
    origin: b.origin,
    session: r.session ?? null,
    sk: r.session ? sessionKey(r.session) : null,
    source: b.source ?? r.session?.source ?? null,
    episode: 0,
    open: false,
    state: 'none',
    counters: { presentation: 0, shows_counted: 0, reminders_used: 0, returns_used: 0, round_shows: 0 },
    usedRefs: new Set(),
    openedBy: null,
    fingerprint: null,
    contentRef: null,
    contentAt: null,
    reportId: null,
    deadline: null,
    orderTime: null,
    position: { rank: 1, seq: 0 },
    afterDeferral: false,
    deferUntil: null,
    ack: null,
    verifiedAck: null,
    lastShowAt: null,
    lastReturnAt: null,
    closable: true,
    closedAs: null,
    deferrals: 0,
    seed: null,
    condition: null,
    root: null,
    rootCounters: new Map(),
    carried: [],
    carriedEver: new Set(),
    carryRef: null,
    // An owner item's live asks by kind ('declared', 'prompt'), from its
    // latest content; whether one that joined is owed a show at once.
    asks: new Map(),
    promptLive: false,
    showDue: false,
    // Shows still owed to a prompt round that joined with the counted shows used.
    roundOwed: 0,
    // The prompt ask of this item that ended last, in any episode: its
    // opening reference and its ending evidence (policy `promptAskRef`).
    lastPromptEnd: null,
    history: [],
  }
}

const OWNER_BLOCK_ORIGINS = new Set(['owner'])

/**
 * An owner item's ordering fields follow its live asks: the earliest
 * deadline, a live prompt first.
 *
 * DESIGN-GAP: "otherwise the existing order" orders owner items by their
 * report or prompt time, and a two-ask item has two. The model uses the
 * earliest of its live asks, so an item does not lose its place when a
 * second ask joins.
 */
function setAsks(it, asks) {
  it.asks = new Map((asks ?? []).map((a) => [a.kind, a]))
  if (it.asks.size === 0) return
  const deadlines = [...it.asks.values()].map((a) => a.deadline).filter((d) => d != null)
  it.deadline = deadlines.length ? Math.min(...deadlines) : null
  it.orderTime = Math.min(...[...it.asks.values()].map((a) => a.order_time ?? Infinity))
  it.promptLive = it.asks.has('prompt')
  const declared = it.asks.get('declared')
  it.fingerprint = declared?.fingerprint ?? null
  if (declared?.report_id) it.reportId = declared.report_id
}

function foldSurface(state, r) {
  const b = r.body
  let it = state.items.get(b.item_id)
  if (!it) {
    it = newItem(r)
    state.items.set(b.item_id, it)
  }
  it.history.push(b.step + (b.phase && b.phase !== 'none' ? ':' + b.phase : ''))
  if (b.phase === 'outcome') {
    const a = state.attempts.get(b.attempt_id)
    if (a) {
      a.hasOutcome = true
      a.outcome = b.outcome
    }
    // Only when an attempt does not use up its step does the outcome apply it.
    if (!state.policy.attemptUsesOrdinal && a) applyStep(it, a.body, a.at, r.seq, state.policy)
    return
  }
  if (b.phase === 'attempt') {
    state.attempts.set(r.id, { id: r.id, itemId: b.item_id, step: b.step, hasOutcome: false, unknown: false, seq: r.seq, body: b, at: ms(r.ts) })
    // Rule: an attempt consumes its ordinal even if the send is never
    // confirmed.
    if (!state.policy.attemptUsesOrdinal) return
  }
  applyStep(it, b, ms(r.ts), r.seq, state.policy)
  if (b.step === 'updated' && b.carry && b.carry.op === 'carry') {
    const refs = state.carriedRefs.get(b.carry.attention_item) ?? new Set()
    refs.add(b.carry.opened_by)
    state.carriedRefs.set(b.carry.attention_item, refs)
  }
  // The counters an attention episode ended with belong to its condition, so
  // that a handover of the same condition continues them.
  if ((b.step === 'resolved' || b.step === 'withdrawn') && it.origin === 'attention' && it.root) it.rootCounters.set(it.root, { ...it.counters })
  if ((b.step === 'resolved' || b.step === 'withdrawn') && OWNER_BLOCK_ORIGINS.has(it.origin) && it.carried.length > 0) {
    const key = `${it.itemId}|${it.episode}`
    state.handovers.set(key, { key, itemId: it.itemId, episode: it.episode, session: it.session, sk: it.sk, source: it.source, carried: it.carried.slice() })
  }
  // Once the preemptor is shown, or closes without being shown, the items it
  // preempted no longer wait on it.
  const shown = b.step === 'shown' && (b.phase === 'attempt' || !state.policy.attemptUsesOrdinal)
  if (shown || b.step === 'resolved' || b.step === 'withdrawn') {
    for (const other of state.items.values()) if (other.preemptedBy === b.item_id) other.preemptedBy = null
  }
}

function applyStep(it, b, at, seq, policy) {
  if ('presentation' in b) {
    it.counters = { presentation: b.presentation, shows_counted: b.shows_counted, reminders_used: b.reminders_used, returns_used: b.returns_used, round_shows: b.round_shows ?? 0 }
  }
  switch (b.step) {
    case 'queued':
      it.open = true
      it.state = 'queued'
      it.episode = b.episode
      it.openedBy = b.opened_by
      it.usedRefs.add(b.opened_by)
      it.fingerprint = b.fingerprint ?? null
      it.contentRef = b.content_ref ?? null
      it.contentAt = b.content_at ?? null
      it.reportId = b.report_id ?? null
      it.deadline = b.deadline ?? null
      it.orderTime = b.order_time ?? null
      it.position = { rank: 1, seq: 0 }
      it.afterDeferral = false
      it.deferUntil = null
      it.ack = null
      it.verifiedAck = null
      it.lastShowAt = null
      it.lastReturnAt = null
      it.closable = b.closable !== false
      it.closedAs = null
      it.deferrals = 0
      it.seed = b.seed ?? null
      it.preemptedBy = null
      it.condition = b.condition ?? null
      it.root = b.condition?.root ?? b.opened_by
      it.carried = []
      it.carriedEver = new Set()
      it.carryRef = null
      it.showDue = false
      it.roundOwed = 0
      it.promptLive = false
      if (b.asks) setAsks(it, b.asks)
      break
    case 'shown':
      it.showDue = false
      if (b.round) {
        it.roundOwed = Math.max(0, it.roundOwed - 1)
        // A round's show leaves the item's state and clock as they were.
        if (!policy?.roundShowTakesSlot) break
      } else {
        it.roundOwed = 0
      }
      it.state = 'active'
      it.preemptedBy = null
      it.lastShowAt = at
      it.afterDeferral = false
      it.position = { rank: 1, seq: 0 }
      break
    case 'returned':
      it.state = 'active'
      it.lastReturnAt = at
      break
    case 'reminded':
      break
    case 'expired':
      it.state = 'queued'
      it.position = { rank: 2, seq }
      break
    case 'preempted':
      it.state = 'queued'
      it.position = { rank: 0, seq }
      it.preemptedBy = b.preempted_by ?? null
      break
    case 'deferred':
      it.state = 'deferred'
      it.deferUntil = b.until
      it.afterDeferral = true
      it.deferrals += 1
      break
    case 'exhausted':
      it.state = 'exhausted'
      break
    case 'updated':
      it.fingerprint = b.fingerprint ?? it.fingerprint
      it.contentRef = b.content_ref ?? it.contentRef
      if (b.content_at != null) it.contentAt = b.content_at
      if (b.report_id) it.reportId = b.report_id
      if (b.deadline !== undefined) it.deadline = b.deadline
      if (b.carry) {
        it.carried = b.carried
        it.carryRef = b.n
        if (b.carry.op === 'carry') it.carriedEver.add(`${b.carry.attention_item}|${b.carry.opened_by}`)
      }
      if (b.ask) {
        setAsks(it, b.asks)
        if (b.ask.op === 'join') {
          it.usedRefs.add(b.ask.opened_by)
          it.showDue = Boolean(b.show_now)
          if (b.round_owed) {
            it.roundOwed = b.round_owed
            it.roundSince = at
          }
          // The show a new ask is owed is a counted one, whatever deferral came before.
          if (b.counted_next) it.afterDeferral = false
        }
        // DESIGN-GAP: a show owed to a round is dropped when that round's
        // prompt ask ends before it is shown: the round it was for is over.
        if (b.ask.op === 'end' && b.ask.kind === 'prompt') {
          it.roundOwed = 0
          it.lastPromptEnd = { opened_by: b.ask.opened_by, evidence: b.ask.evidence ?? null }
        }
      }
      if (b.requeue) {
        it.state = 'queued'
        it.position = { rank: 1, seq: 0 }
      }
      break
    case 'resolved':
    case 'withdrawn':
      if (b.closing_ask === 'prompt' && it.asks.has('prompt')) {
        it.lastPromptEnd = { opened_by: it.asks.get('prompt').opened_by, evidence: b.resolution_evidence ?? null }
      }
      it.open = false
      it.state = 'closed'
      it.closedAs = b.step === 'withdrawn' ? `withdrawn:${b.reason ?? ''}` : 'resolved'
      break
    default:
      break
  }
}

function foldOwnerAck(state, r) {
  const b = r.body
  const it = state.items.get(b.item_id)
  if (!it || b.episode !== it.episode) return
  if (b.phase === 'ack' && b.intent === 'done' && it.closable) {
    it.state = 'acknowledged'
    it.ack = { ackRef: b.ack_ref, seq: r.seq }
  }
  if (b.phase === 'verify') it.verifiedAck = b.ack_ref
  // An acknowledgement the next tick's evidence did not agree with.
  if (b.phase === 'verify' && b.verified === false) state.contradictions.set(r.id, { itemId: b.item_id, episode: b.episode, ackRef: b.ack_ref })
}

function foldTick(state, r) {
  const b = r.body
  let t = state.ticks.get(b.tick_id)
  if (!t) {
    t = { id: b.tick_id, source: b.source, slot: b.slot_start, openSeq: r.seq, closed: false }
    state.ticks.set(b.tick_id, t)
  }
  if (b.phase === 'close') {
    t.closed = true
    // An earlier tick of the source that never closed (a crash, never
    // replayed) is superseded: nothing more is taken from it.
    for (const o of state.ticks.values()) if (o.source === b.source && !o.closed && o.id !== b.tick_id) o.superseded = true
    state.lastClosedTick.set(b.source, { slot: b.slot_start, id: b.tick_id })
    state.sourceTrigger.set(b.source, { held: Boolean(b.source_all_failed), onset: b.source_onset ?? null })
    // A handover belongs to the tick that closed the item: by this record it
    // has been made, or found to have nothing left to do.
    for (const [key, ho] of state.handovers) if (ho.source === b.source) state.handovers.delete(key)
  }
}

function foldConfig(state, r) {
  state.config = r.body.values
  state.configRef = r.body.config_ref
  state.lastConfigId = r.id
}

function foldSystem(state, r) {
  const d = r.body.detail ?? {}
  if (r.body.event === 'delivery_unknown') {
    const a = state.attempts.get(d.ids[0])
    if (a) a.unknown = true
  }
  // What the outbox was given, by key: an item or the digest, whose later
  // changes are edits of the same message. Echo and alert items are posted
  // once and never edited, so they are not kept.
  if (r.body.event === 'outbox_render' && (d.class === 'item' || d.class === 'digest')) {
    const prev = state.outbox.get(d.key)
    state.outbox.set(d.key, { key: d.key, class: d.class, itemId: d.item_id ?? null, episode: d.episode ?? null, title: prev?.title ?? d.title ?? null, rec: d.ids[0], hash: d.hash })
  }
  // Echo items an item has had in an episode (applied and refused lines).
  if (r.body.event === 'input_line' && (d.disposition === 'applied' || d.disposition === 'refused') && d.item_id) {
    const k = `${d.item_id}|${d.episode}`
    state.echoCounts.set(k, (state.echoCounts.get(k) ?? 0) + 1)
  }
  // The first receipt for an outbox record stands; a later one never rewrites it.
  if (r.body.event === 'input_line' && d.disposition === 'receipt' && !state.receipts.has(d.rec)) state.receipts.set(d.rec, d.outcome)
}

/** Fold one record into the derived state. */
export function foldRecord(state, r) {
  state.index.set(r.id, r)
  state.lastSeq = r.seq
  switch (r.kind) {
    case 'config':
      return foldConfig(state, r)
    case 'tick':
      return foldTick(state, r)
    case 'report':
      return foldReport(state, r)
    case 'check':
      return foldCheck(state, r)
    case 'activity':
      return foldActivity(state, r)
    case 'investigation':
      return foldInvestigation(state, r)
    case 'surface':
      return foldSurface(state, r)
    case 'owner_ack':
      return foldOwnerAck(state, r)
    case 'system':
      return foldSystem(state, r)
    default:
      return undefined
  }
}

/** The sessions of one source (or of every source, for null), in key order. */
export function sessionsOf(state, source) {
  return [...state.sessions.values()].filter((s) => source == null || s.session.source === source).sort((a, b) => (a.sk < b.sk ? -1 : 1))
}

/** The item's state at a time: a deferral whose time has come reads as queued. */
export function effectiveState(item, now) {
  if (item.state === 'deferred' && item.deferUntil != null && now >= item.deferUntil) return 'queued'
  return item.state
}
