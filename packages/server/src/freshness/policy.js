/**
 * The rules of the session-freshness model, gathered into one policy object.
 *
 * `DEFAULT_POLICY` is the design's rules, plus the smallest choice the model
 * had to make wherever the design is silent or contradicts itself; each such
 * choice is marked DESIGN-GAP. The planners in this directory call these rules
 * and nothing else, so a test can replace ONE rule with a broken one and show
 * that the invariant suite then fails. This object is the only injection point.
 *
 * Pure functions; time is always an argument (milliseconds since the epoch).
 */

import { reportAgeMs } from './grade.js'
import { H } from './hash.js'
import { surfaceOrdinal } from './keys.js'

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

const CLASS_INDEX = { prompt: 1, declared: 1, outage: 2, attention: 3, gone: 3, seed: 4, issue: 5 }

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
  const sub = item.origin === 'prompt' ? 0 : 1
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
 * Preemption, narrowed. The design's row preempts for any item
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
  // fingerprint; a new prompt id is a change for a prompt item.
  //
  // DESIGN-GAP: `updated` is keyed by the id of the report or prompt that
  // carried the change, so content that moves BACK to an earlier report or
  // prompt (an older prompt still pending after a newer one was answered; a
  // session rewound to an earlier line) repeats a key with a different
  // payload: an idempotency_conflict. The model only moves an item's content
  // forward in time.
  contentChanged(item, next) {
    if (next.at != null && item.contentAt != null && next.at <= item.contentAt) return false
    if (item.origin === 'prompt') return next.ref !== item.contentRef
    return next.fingerprint !== item.fingerprint
  },

  // A new episode opens only when none is open and the opening
  // reference is one no earlier episode of that item used.
  mayOpenEpisode(item, ref) {
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

  // DESIGN-GAP: an acceptance case lists acknowledgment among the events that
  // free the slot, but the table returns an acknowledged item to `active` with a
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

  orderKey,

  // Pending prompt origin: resolved by a host record that the owner
  // answered the latest prompt. Returns the answered prompt's ref, or null.
  // DESIGN-GAP: a prompt lives 300 s and a tick comes every 15 to 40 min, so
  // most prompts are raised AND answered between two ticks and are never seen
  // pending. The item's latest prompt is then an older, lapsed one and the
  // design's rule never fires. The model also accepts an owner answer to any
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
  surfaceOrdinal(step, ctx) {
    if (step === 'exhausted') return `${ctx.presentation}:${ctx.contentRef ?? ''}`
    return surfaceOrdinal(step, ctx)
  },

  // ── idempotency ──
  // An attempt record uses up its ordinal (and its step) whether
  // or not the send is ever confirmed. Read by the fold in derive.js.
  attemptUsesOrdinal: true,
  // Before writing an attempt, look for its key; if present,
  // send nothing.
  attemptAlreadyRecorded(ledger, key) {
    return ledger.byKey.has(key)
  },
  // DESIGN-GAP: the design looks a key up before a SEND only. A step re-run
  // after a crash also re-makes reads whose records are already written
  // (checks, verifications), and a re-read at a later time has a different
  // payload under the same key, which the design itself turns into an
  // idempotency_conflict. The model reuses a recorded read instead of
  // re-reading.
  reuseRecorded(index, key) {
    return index.get(key) ?? null
  },

  // ── investigation ──
  // DESIGN-GAP: several triggers can hold at once, and the design allows one
  // investigation per session per tick without saying which. Fixed order.
  triggerPriority: Object.freeze(['dropped_from_list', 'repeated_error', 'native_disagreement', 'stale_report', 'recheck']),
  // DESIGN-GAP: "disagree" is defined by one example (idle while a turn is in
  // flight). A `running` line with no turn in flight is the normal state just
  // after every turn that ends RUNNING, so it cannot count. The model uses
  // idle and done.
  disagreementStates: Object.freeze(new Set(['idle', 'done'])),
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
    // no row but `inconclusive`, so two cycles later it is surfaced a second
    // time as an attention item beside its own owner-block item. The model
    // classifies it `waiting_on_owner`: the owner-block item carries it.
    if (ev.ownerBlock) return 'waiting_on_owner'
    if (live && n.answering_now && n.turn_in_flight) return 'working_unreported'
    const windowMs = config.investigation.activity_window_minutes * MIN_MS
    const after = ev.events.filter((e) => e.activity_at != null && e.activity_at > ev.reportAt)
    const lastEnd = Math.max(-Infinity, ...after.filter((e) => e.basis === 'turn_ended_after_report').map((e) => e.activity_at))
    const openTurn = after.some((e) => e.basis === 'open_turn_event_after_report' && e.activity_at > lastEnd && ev.now - e.activity_at <= windowMs)
    if (openTurn) return 'working_unreported'
    if (live && n.busy_background && !n.turn_in_flight) return 'waiting_on_background'
    if (Number.isFinite(lastEnd) && !(live && n.pending)) return 'finished_unreported'
    // DESIGN-GAP: the absence of a turn and of a prompt cannot be shown on a
    // source with no native state. The model reads absence of evidence there
    // as nothing shown, so a stale non-owner block is still classified.
    if (BLOCKING_STATES.has(ev.state) && !ev.ownerBlock && !(live && n.turn_in_flight)) return 'blocked_unresolved'
    if (ev.state === 'running' && !(live && n.turn_in_flight) && !(live && !n.busy_background)) return 'running_claim_unverified'
    return 'inconclusive'
  },

  // A recheck runs rungs I1 and I3 only.
  classifyRecheck(ev) {
    if (ev.rungBlocked || ev.readFailed) return 'no_longer_observed'
    const n = ev.native
    if (n && n.available && n.pending) return 'waiting_on_owner'
    if (n && n.available && n.answering_now && n.turn_in_flight) return 'working_unreported'
    if (n && n.available && n.busy_background && !n.turn_in_flight) return 'waiting_on_background'
    return 'no_longer_observed'
  },

  // What each classification does to the queue.
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
