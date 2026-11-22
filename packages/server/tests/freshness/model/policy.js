/**
 * The rules of the session-freshness model, gathered into one policy object.
 *
 * `DEFAULT_POLICY` is the rules README states, plus the smallest choice the
 * model had to make wherever the source rules were silent or contradictory; each such
 * choice is marked DESIGN-GAP. The planners in this directory call these rules
 * and nothing else, so a test can replace ONE rule with a broken one and show
 * that the invariant suite then fails. This object is the only injection point.
 *
 * Pure functions; time is always an argument (milliseconds since the epoch).
 */

import { reportAgeMs } from './grade.js'
import { H } from './hash.js'
import { itemIds, surfaceOrdinal } from './keys.js'

const MIN_MS = 60_000

function norm(text) {
  return typeof text === 'string' ? text.trim().replace(/\s+/g, ' ').toLowerCase() : null
}

const BLOCKING_STATES = new Set(['blocked', 'stalled'])

/**
 * Which reports are owner blocks. `report` is a report body.
 * The owner's name is configuration (`config.owner_name`), never a literal.
 */
export function isOwnerBlock(report, config) {
  if (!report) return false
  // A line that names a seed raises only the seed handoff.
  if (report.seed_ref) return false
  const blocking = BLOCKING_STATES.has(report.state)
  const owner = norm(config.owner_name)
  const namesOwner = owner != null && norm(report.owner_named) === owner
  const decision = norm(report.decision)
  const hasDecision = decision != null && decision !== '' && decision !== 'none'
  if (blocking && namesOwner) return true
  if (report.decision_basis === 'stated' && hasDecision) return true
  if (blocking && report.decision_basis === 'possibly_inherited' && hasDecision) return true
  return false
}

/**
 * A hash of the state, the blocked-on text and a stated decision,
 * normalized for case and whitespace, when the state is blocked or stalled or
 * a decision is stated in that line; else null. An inherited decision is left
 * out.
 */
export function blockFingerprint(report) {
  if (!report) return null
  const stated = report.decision_basis === 'stated' ? norm(report.decision) : null
  const statedDecision = stated && stated !== 'none' ? stated : null
  if (!BLOCKING_STATES.has(report.state) && !statedDecision) return null
  return H(report.state, norm(report.declared_blocked_on), statedDecision)
}

function anchorAt(item) {
  // DESIGN-GAP: timing from the latest show is undefined after a `returned` step,
  // which sends but is not a show. The model times reminders and expiry from
  // the latest show OR return, so a return is not followed by an immediate
  // expiry in the same tick.
  return Math.max(item.lastShowAt ?? -Infinity, item.lastReturnAt ?? -Infinity)
}

function reminderAt(item, k, config) {
  return anchorAt(item) + config.surface.reminder_after_minutes[k - 1] * MIN_MS
}

function expiryAt(item, config) {
  return anchorAt(item) + config.surface.item_time_limit_hours * 60 * MIN_MS
}

/** The time of this item's next reminder, if it has one left. */
export function nextReminderAt(item, config) {
  const k = item.counters.reminders_used + 1
  if (k > config.surface.reminder_after_minutes.length) {
    // DESIGN-GAP: preemption compares a deadline with "this item's next
    // reminder", which does not exist once both reminders are used. The model
    // uses the item's expiry time instead.
    return expiryAt(item, config)
  }
  return reminderAt(item, k, config)
}

const CLASS_INDEX = { owner: 1, outage: 2, attention: 3, gone: 3, seed: 4, issue: 5 }

/**
 * The surfacing order, as a sort key (lower first). `position` is set by
 * `preempted` (front of its class) and `expired` (back of its class).
 */
export function orderKey(item, now) {
  const hasDeadline = item.kind === 'owner_block' && item.deadline != null && item.deadline > now
  const cls = hasDeadline ? 0 : CLASS_INDEX[item.origin]
  // DESIGN-GAP: front and back of a class are not ordered against each
  // other or against the class's own order when several items carry them. The
  // model sorts front (earliest preemption first), then natural order, then
  // back (earliest expiry first).
  //
  // DESIGN-GAP: a preempted item is queued at the front of its class. When both
  // items carry deadlines they share class 1, so the preempted item would be
  // shown again at once, ahead of the item that preempted it, and spend its
  // counted shows while the earlier deadline waits. Within the deadline
  // class the model keeps deadline order and ignores front and back.
  const posRank = hasDeadline ? 1 : (item.position?.rank ?? 1)
  const posSeq = hasDeadline ? 0 : (item.position?.seq ?? 0)
  // Among owner items, one with a live prompt ask comes first.
  const sub = item.promptLive ? 0 : 1
  const natural = hasDeadline ? item.deadline : (item.orderTime ?? 0)
  return [cls, posRank, posRank === 1 ? 0 : posSeq, cls === 1 ? sub : 0, natural, item.itemId]
}

export function compareKeys(a, b) {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1
    if (a[i] > b[i]) return 1
  }
  return 0
}

/**
 * Preemption, narrowed. The rule as written preempts for any item
 * whose deadline passes before the active item's next reminder.
 *
 * DESIGN-GAP: read literally, two items with deadlines preempt each other on
 * alternate ticks, each preemption costing a counted show, because the row
 * never compares the two deadlines. The model preempts only when the
 * challenger's deadline is also earlier than the active item's own.
 */
export function preempts(challenger, active, now, config) {
  if (challenger.kind !== 'owner_block' || challenger.deadline == null) return false
  if (challenger.deadline <= now) return false
  if (challenger.deadline >= nextReminderAt(active, config)) return false
  // DESIGN-GAP: the row does not require that the challenger can be shown. A
  // challenger with no counted show left is exhausted as soon as it reaches
  // the slot, and the preempted item is shown straight back, having spent a
  // counted show for nothing. The model preempts only for a showable item.
  if (!challenger.afterDeferral && challenger.counters.shows_counted >= config.surface.max_presentations) return false
  // Compared by deadline alone: a preempted item sits at the front of its
  // class, and comparing full order keys would let it preempt straight back.
  const activeDeadline = active.kind === 'owner_block' && active.deadline != null && active.deadline > now ? active.deadline : Infinity
  return challenger.deadline < activeDeadline
}

export const DEFAULT_POLICY = Object.freeze({
  // ── freshness ──
  reportAge: reportAgeMs,

  // ── owner blocks ──
  isOwnerBlock,
  blockFingerprint,

  // DESIGN-GAP: the transition table counts any new report or prompt as a
  // content change, while the prose says the fingerprint decides. Read as
  // any new report, an exhausted item would be queued again
  // each time a session re-authored the identical line. The model uses the
  // fingerprint; a new prompt id is a change for a prompt ask.
  //
  // DESIGN-GAP: `updated` is keyed by the id of the report or prompt that
  // carried the change, so content that moves BACK to an earlier report or
  // prompt (an older prompt still pending after a newer one was answered; a
  // session rewound to an earlier line) repeats a key with a different
  // payload: an idempotency_conflict. The model only moves an item's content
  // forward in time.
  // `ask` is one ask of an owner item: its kind, content time, content
  // reference (a prompt id) and fingerprint (a declared block's).
  contentChanged(ask, next) {
    if (next.at != null && ask.contentAt != null && next.at <= ask.contentAt) return false
    if (ask.askKind === 'prompt') return next.ref !== ask.contentRef
    return next.fingerprint !== ask.fingerprint
  },

  // A new episode opens only when none is open and the opening
  // reference is one no earlier episode of that item used.
  mayOpenEpisode(item, ref, _origin) {
    if (!item) return true
    if (item.open) return false
    return !item.usedRefs.has(ref)
  },

  // Transition table: `queued` at the slot.
  canShow(item, config) {
    return item.afterDeferral || item.counters.shows_counted < config.surface.max_presentations
  },
  showIsCounted(item) {
    return !item.afterDeferral
  },

  // Transition table: reminder k is due when k is 1 or 2, reminders_used < k, and
  // the k-th interval has passed since the latest show.
  // DESIGN-GAP: after a long gap (a host sleep) both reminders can be due at
  // once, and the row does not say whether both are sent, or which. The model
  // sends at most one per tick: the lowest k due.
  reminderDue(item, now, config) {
    const n = config.surface.reminder_after_minutes.length
    for (let k = 1; k <= n; k++) {
      if (item.counters.reminders_used < k && now >= reminderAt(item, k, config)) return k
    }
    return null
  },
  // Reminder k leaves reminders_used at k.
  remindersAfter(item, k) {
    return k
  },

  expiryDue(item, now, config) {
    return now >= expiryAt(item, config)
  },

  preempts,

  // DESIGN-GAP: one statement of the rules lists acknowledgment among the
  // events that free the slot, but the transition table returns an acknowledged item to `active` with a
  // send after an unconfirmed "done", which would make two items active. The
  // model keeps the slot held while an item is acknowledged and awaits
  // verification (one tick).
  slotHolderStates: Object.freeze(new Set(['active', 'acknowledged'])),

  // Transition table: no evidence at verification.
  verifyFailedStep(item) {
    return item.counters.returns_used === 0 ? 'returned' : 'exhausted'
  },

  // Transition table: `updated` from exhausted is queued if a counted show is left.
  requeueFromExhausted(item, config) {
    return item.counters.shows_counted < config.surface.max_presentations
  },

  // ── one session, one item ──
  // When a session already has an open owner item, an attention item
  // about that session is not raised beside it: its condition is merged into
  // the open item as an `updated` step that names it ('merge'). 'raise' is
  // the earlier behaviour (both items); 'drop' loses the condition (a
  // mutant, for the liveness proof).
  attentionBesideOwnerBlock: 'merge',
  // The reverse order: an attention item already open when the session gets
  // an owner item is withdrawn as merged and its condition carried.
  mergeOpenAttention: true,
  // A carried condition still holding when its owner item closes is raised as
  // its own attention item (or, if the item opened its next episode in the
  // same tick, carried on into it).
  handOverOnClose: true,
  // DESIGN-GAP: a condition's send history belongs to the condition, not to
  // the attention episode. A condition handed back to its own attention item
  // opens that episode with the counters its previous episode ended with
  // (presentation, counted shows, reminders, returns), so across any number
  // of merges and handovers it gets at most the show limit, two reminders
  // and one return. A condition that was never shown starts from zero.
  inheritCountersOnHandover: true,

  // ── the owner item ──
  // A session's declared block and its pending prompt are one owner item,
  // whose content lists each ask that is live. This rule gives the item an
  // ask belongs to.
  ownerItemOf(session, _kind) {
    return itemIds.owner(session)
  },
  // DESIGN-GAP: the episode rule (never on a used reference) is per item,
  // and one item now has several asks. An ask is added to an owner item
  // (opening its episode, or joining it) only on a reference that no earlier
  // ask of that item stood on, in any episode: its opening reference, and,
  // for a declared ask, every authored owner-block report of its session it
  // covered while it was live, whatever the fingerprint (see
  // `coveredReportsUsed`). So a line an ask already covered (a session
  // rewound to it, re-authored identically or reworded) never brings it
  // back, and an ask that leaves and comes back does so on a new reference.
  //
  // DESIGN-GAP: a prompt the ask's content moved away from can still be
  // pending when the ask ends (its newer prompt was answered). Treating it as
  // used would leave a prompt the owner never answered with no item, so for a
  // prompt ask only the opening reference is used, and such a prompt opens
  // an ask of its own.
  mayAddAsk(item, ref, _kind) {
    return !item || !item.usedRefs.has(ref)
  },
  // An ask that joins an open owner item is a reason to show it again: a
  // counted show from the item's own limit, made at once if the item holds
  // the slot, else when it next reaches the slot. With the limit used, the
  // new ask only changes the content.
  newAskShows(item, config) {
    return item.counters.shows_counted < config.surface.max_presentations
  },
  // ── prompt rounds ──
  // Once an owner item has used its counted shows, each new prompt round on
  // the session (a prompt ask joining the item) earns one fresh show anyway.
  // A declared ask joining earns none.
  promptRoundShows(_item, ask, _config) {
    return ask.kind === 'prompt'
  },
  // How many shows one round earns.
  showsPerRound: 1,
  // DESIGN-GAP: where a round's show is counted. The model keeps it out of
  // `shows_counted`, in a fifth counter `round_shows`, so every rule that
  // reads `shows_counted` against the limit (a new ask's counted show, the
  // re-queue from exhausted, the slot, preemption) is unchanged by rounds.
  roundShowCounters(c) {
    return { ...c, presentation: c.presentation + 1, round_shows: (c.round_shows ?? 0) + 1 }
  },
  // A round's show takes nothing: the item keeps the state it had (an item
  // that held the slot keeps holding it, any other does not take it), and
  // the reminder and time-limit clock does not move. Read by the fold.
  roundShowTakesSlot: false,
  // The item closes only when its last ask ends.
  closesOnAskEnd(item, kind) {
    return [...item.asks.keys()].every((k) => k === kind)
  },

  orderKey,

  // DESIGN-GAP: a preempted item goes to the front of its class, and prompts
  // come before declared blocks only by class order. If the preemptor's
  // deadline passes before it is shown (a crash between the preemption and
  // the show, replayed minutes later), the preempted item outranks the item
  // that preempted it and is shown straight back. The model shows a still
  // queued preemptor first. Reorders `queue` in place.
  preemptorFirst(queue) {
    const head = queue[0]
    if (!head?.preemptedBy) return
    const i = queue.findIndex((x) => x.itemId === head.preemptedBy)
    if (i > 0) queue.unshift(...queue.splice(i, 1))
  },

  // Pending prompt origin: resolved by a host record that the owner
  // answered the latest prompt. Returns the answered prompt's ref, or null.
  // DESIGN-GAP: a prompt lives 300 s and a tick comes every 15 to 40 min, so
  // most prompts are raised AND answered between two ticks and are never seen
  // pending. The item's latest prompt is then an older, lapsed one and the
  // rule as written never fires. The model also accepts an owner answer to any
  // prompt raised (or, if never seen pending, answered) after the item's
  // current prompt, provided no prompt is pending at a live read.
  promptAnswered(item, current, prompts, { livePending }) {
    if (current?.status === 'answered') return item.contentRef
    if (livePending !== 0) return null
    const since = current?.raised_at ?? -Infinity
    for (const p of prompts.values()) {
      if (p.status !== 'answered' || p.ref === item.contentRef) continue
      if ((p.raised_at ?? p.at ?? -Infinity) >= since) return p.ref
    }
    return null
  },

  // Pending prompt origin: withdrawn as lapsed when no prompt is pending at a
  // live read and the session has authored a newer report.
  // DESIGN-GAP: "newer" is not said to be newer than what. The model uses a
  // report authored after the item's latest prompt was raised.
  promptLapsed(item, current, latestReport, { livePending }) {
    if (livePending !== 0 || !latestReport) return false
    return latestReport.last_report_at > (current?.raised_at ?? -Infinity)
  },

  // Declared block origin: resolved by a newer authored report that is
  // not an owner block by the same rule.
  declaredResolvedBy(latest, opening, config) {
    if (!latest || !opening) return false
    if (latest.last_report_at <= opening.last_report_at) return false
    return !isOwnerBlock(latest, config)
  },

  // The ordinal table of the surface key.
  // DESIGN-GAP: `exhausted` is keyed by the presentation number, but an item
  // can be exhausted twice at one presentation: exhausted after two
  // unconfirmed acknowledgments, re-queued by a content change, then
  // exhausted again at the slot because the show limit was lowered in
  // between. The key repeats with a different payload, the ledger records an
  // idempotency_conflict, and the item stays queued for good. A re-queue
  // always carries new content, so the model adds the content reference.
  // A carried condition changes the content without changing the content
  // reference, so once an item has carried one the ordinal also names the
  // latest carried-condition change.
  surfaceOrdinal(step, ctx) {
    if (step === 'exhausted') return `${ctx.presentation}:${ctx.contentRef ?? ''}${ctx.carryRef ? `:${ctx.carryRef}` : ''}`
    return surfaceOrdinal(step, ctx)
  },

  // ── idempotency ──
  // An attempt record uses up its ordinal (and its step) whether
  // or not the send is ever confirmed. Read by the fold in derive.js.
  attemptUsesOrdinal: true,
  // Every authored owner-block report a declared ask covered while it was
  // live is used, as its opening reference is. Read by the fold in derive.js.
  coveredReportsUsed: true,
  // Before writing an attempt, look for its key; if present,
  // send nothing.
  attemptAlreadyRecorded(ledger, key) {
    return ledger.byKey.has(key)
  },
  // DESIGN-GAP: the rules look a key up before a SEND only. A step re-run
  // after a crash also re-makes reads whose records are already written
  // (checks, verifications), and a re-read at a later time has a different
  // payload under the same key, which the rules themselves turn into an
  // idempotency_conflict. The model reuses a recorded read instead of
  // re-reading.
  // A record under the key is reused only if it is the kind expected there:
  // a record of another kind is a key collision, and re-making the read lets
  // append() record it as an idempotency_conflict instead of hiding it.
  reuseRecorded(index, key, kind) {
    const rec = index.get(key) ?? null
    return rec && rec.kind === kind ? rec : null
  },

  // ── investigation ──
  // DESIGN-GAP: several triggers can hold at once, and the rules allow one
  // investigation per session per tick without saying which. Fixed order.
  triggerPriority: Object.freeze(['dropped_from_list', 'repeated_error', 'native_disagreement', 'stale_report', 'recheck']),
  // DESIGN-GAP: "disagree" is defined by one example (idle while a turn is in
  // flight). A `running` line with no turn in flight is the normal state just
  // after every turn that ends RUNNING, so it cannot count. The model uses
  // idle and done.
  disagreementStates: Object.freeze(new Set(['idle', 'done'])),
  // An onset is the check at which a trigger began to hold: the first check
  // after one at which it did not hold. A `no_longer_observed` recheck starts
  // a new stale_report onset.
  // DESIGN-GAP: whether a new report starts a new onset while the trigger
  // keeps holding is not said. The model starts one, so a newly stale report
  // gets its own cycles.
  startsNewOnset(trigger, { prevHolds, sameReport, staleReset }) {
    if (!prevHolds) return true
    if (trigger === 'stale_report') return staleReset || !sameReport
    return false
  },
  maxCycles: 2,
  secondCycleAfter: Object.freeze(new Set(['inconclusive', 'running_claim_unverified'])),
  recheckAfter: Object.freeze(new Set(['working_unreported', 'waiting_on_background'])),
  // The `recheck` trigger: the latest closed investigation of the
  // same report ended working_unreported or waiting_on_background.
  // DESIGN-GAP: `waiting_on_owner` because of a pending prompt is an
  // explanation that ends when the prompt is answered or lapses, but it is
  // not rechecked and uses up the onset's cycles, so a session that stops
  // after its prompt is answered keeps a stale line that is never surfaced.
  // The model rechecks it too. (A stale owner block is carried by its own
  // item until a newer report, which is a new onset, so it is not.)
  needsRecheck(last, policy) {
    if (policy.recheckAfter.has(last.classification)) return true
    return last.classification === 'waiting_on_owner' && last.ownerWaitBasis === 'prompt'
  },

  // Budgets: first cycles before second cycles, oldest onset first;
  // rechecks never draw on the cycle budget; a recheck needing its own read
  // draws on the recheck budget, least recently checked first.
  // At most one investigation per session per tick: the highest-priority
  // candidate of each session.
  selectInvestigations(candidates, { cycleBudget, recheckBudget }) {
    const cmpStr = (a, b) => (a < b ? -1 : a > b ? 1 : 0)
    const best = new Map()
    for (const c of candidates) {
      const cur = best.get(c.key)
      if (!cur || c.priority < cur.priority) best.set(c.key, c)
    }
    candidates = [...best.values()]
    const cycles = candidates
      .filter((c) => c.kind === 'cycle')
      .sort((a, b) => a.cycle - b.cycle || a.onsetSeq - b.onsetSeq || cmpStr(a.key, b.key))
      .slice(0, cycleBudget)
    const free = candidates.filter((c) => c.kind === 'recheck' && !c.needsRead)
    const paid = candidates
      .filter((c) => c.kind === 'recheck' && c.needsRead)
      .sort((a, b) => (a.lastReadAt ?? 0) - (b.lastReadAt ?? 0) || cmpStr(a.key, b.key))
      .slice(0, recheckBudget)
    return [...cycles, ...free, ...paid]
  },

  // The classification table, driven by evidence the caller supplied.
  // DESIGN-GAP: the rows overlap (a pending prompt during a turn in flight;
  // a blocked line with a turn-ending event) and the table gives no
  // precedence. The model applies them in the order below.
  classify(ev, config) {
    if (ev.rungBlocked) return 'inconclusive'
    if (ev.sourceLevel) return ev.rereadFailed ? 'source_unreachable' : 'inconclusive'
    if (ev.trigger === 'dropped_from_list') {
      if (ev.confirmListed === false && ev.canConfirmGone) return 'gone'
      return 'inconclusive'
    }
    if (ev.rereadFailed) return 'inconclusive'
    const n = ev.native
    const live = n != null && n.available
    if (live && n.pending) return 'waiting_on_owner'
    // DESIGN-GAP: a stale owner block (4 h at the starting thresholds) matches
    // no row but `inconclusive`, so two cycles later its own owner item
    // would carry a stale condition about the wait it already shows. The
    // model classifies it `waiting_on_owner`: the owner item is enough.
    if (ev.ownerBlock) return 'waiting_on_owner'
    if (live && n.answering_now && n.turn_in_flight) return 'working_unreported'
    const after = ev.events.filter((e) => e.activity_at != null && e.activity_at > ev.reportAt)
    const lastEnd = Math.max(-Infinity, ...after.filter((e) => e.basis === 'turn_ended_after_report').map((e) => e.activity_at))
    const openTurn = after.some((e) => e.basis === 'open_turn_event_after_report' && e.activity_at > lastEnd && this.withinActivityWindow(e, ev.now, config))
    if (openTurn) return 'working_unreported'
    if (live && n.busy_background && !n.turn_in_flight) return 'waiting_on_background'
    // (A pending prompt already returned above.)
    if (Number.isFinite(lastEnd)) return 'finished_unreported'
    // DESIGN-GAP: the absence of a turn and of a prompt cannot be shown on a
    // source with no native state. The model reads absence of evidence there
    // as nothing shown, so a stale non-owner block is still classified.
    if (BLOCKING_STATES.has(ev.state) && !ev.ownerBlock && !(live && n.turn_in_flight)) return 'blocked_unresolved'
    // On a live source a turn in flight or background work returned above,
    // and their absence rules a wake out; only a source with no live busy
    // state leaves the claim unverified.
    if (ev.state === 'running' && !live) return 'running_claim_unverified'
    return 'inconclusive'
  },

  // An open-turn event counts as working only inside the activity window.
  withinActivityWindow(event, now, config) {
    return now - event.activity_at <= config.investigation.activity_window_minutes * MIN_MS
  },

  // A recheck runs only the activity read and the classification.
  classifyRecheck(ev) {
    if (ev.rungBlocked || ev.readFailed) return 'no_longer_observed'
    const n = ev.native
    if (n && n.available && n.pending) return 'waiting_on_owner'
    if (n && n.available && n.answering_now && n.turn_in_flight) return 'working_unreported'
    if (n && n.available && n.busy_background && !n.turn_in_flight) return 'waiting_on_background'
    return 'no_longer_observed'
  },

  // What each classification does to the queue.
  //
  // DESIGN-GAP: `finished_unreported` is surfaced only "if linked work is
  // still open", and this model links no work, so it is never surfaced: a
  // session whose turn ended (in error, or by a stop) after a `running` line
  // keeps that stale line without anyone being told. The surfacing
  // invariant (I7f) exempts exactly these sessions, to match; see README.
  surfaceFor(classification, cycle, ev, config) {
    switch (classification) {
      case 'blocked_unresolved':
        return 'attention'
      case 'inconclusive':
      case 'running_claim_unverified':
        return cycle === 2 ? 'attention' : null
      case 'waiting_on_background':
        return ev.reportAgeMs > config.investigation.background_wait_max_minutes * MIN_MS ? 'attention' : null
      case 'gone':
        return 'gone'
      case 'source_unreachable':
        return 'outage'
      default:
        return null
    }
  },
})

/** A copy of the default policy with some rules replaced. */
export function withPolicy(overrides) {
  return Object.freeze({ ...DEFAULT_POLICY, ...overrides })
}
