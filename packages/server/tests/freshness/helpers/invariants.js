/**
 * Invariant monitor for generated sequences.
 *
 * It reads the ledger incrementally and keeps its OWN account of every item
 * (a spec-level state per item), so it does not trust the model's derived
 * state or counters: a broken rule in the model shows up as a disagreement
 * with this account, or as a bound the account says was crossed. Ground truth
 * about sessions comes from the simulated world.
 *
 * Each failure carries an invariant id (I1a .. I10, with I7i) so a mutation proof can
 * assert WHICH invariant went red. The full list is in ../README.md.
 *
 * What the monitor derives for itself rather than reading from the model:
 * item states and counters, the freshness band of each trusted authored read
 * (I8b), the onset of each per-session trigger (I7a), and the evidence behind
 * every resolution and withdrawal (I4b). It still reads from the model the
 * parsed report fields and, for the source-level outage investigation only,
 * the model's own onset.
 *
 * Limits: the monitor uses the model's own `isOwnerBlock` (for declared
 * resolutions in I4b, and in I9 and I10) and the model-computed
 * `block_fingerprint` (I6). A defect in the default owner-block rule or in
 * the fingerprint is therefore invisible to those checks.
 */

import { isOwnerBlock } from '../model/policy.js'
import { sourceCaps } from '../model/config.js'
import { AGE_ORDER } from '../model/grade.js'
import { itemIds, sessionKey } from '../model/keys.js'

export class InvariantError extends Error {
  constructor(id, message) {
    super(`[${id}] ${message}`)
    this.id = id
  }
}

const STALE_STATES = new Set(['running', 'unknown', 'blocked', 'stalled'])
const DISAGREE_STATES = new Set(['idle', 'done'])
const TRIGGERS = ['stale_report', 'native_disagreement', 'dropped_from_list', 'repeated_error']
const WITHDRAW_REASONS = {
  declared: new Set(),
  prompt: new Set(['lapsed']),
  attention: new Set(['dismissed', 'superseded']),
  gone: new Set(['dismissed']),
  seed: new Set(['dismissed', 'owner_stated_unverified']),
  issue: new Set(['dismissed', 'no_longer_eligible']),
  outage: new Set(),
}

function fail(id, msg) {
  throw new InvariantError(id, msg)
}

export function createMonitor({ config, firstCycleBound, surfaceBound }) {
  return {
    config,
    firstCycleBound,
    surfaceBound,
    pos: 0,
    sendPos: 0,
    sendKeys: new Set(),
    items: new Map(),
    reports: new Map(),
    latestTick: new Map(),
    latestAuthored: new Map(),
    firstAuthored: new Map(),
    listed: new Map(),
    freshSeq: new Map(),
    onsetCycles: new Map(),
    perTickSession: new Map(),
    tickCycles: new Map(),
    tickPaid: new Map(),
    openInv: new Map(),
    invReports: new Map(),
    rechecksAt: new Map(),
    starve: new Map(),
    unexplained: new Map(),
    recheckStreak: new Map(),
    dismissedReports: new Set(),
    answered: new Set(),
    answeredAt: new Map(),
    promptRaised: new Map(),
    ownerDismiss: new Set(),
    tickChecks: new Map(),
    lastTickOf: new Map(),
    tickOpenSeq: new Map(),
    scopes: new Map(),
    configs: new Map(),
    checkAct: new Map(),
    livePending: new Map(),
    runs: new Map(),
    relayedSince: new Map(),
    prevTickOutcome: new Map(),
    ownerDone: new Set(),
    onsetTrigger: new Map(),
    onsetConfirms: new Map(),
    stats: { records: 0, sends: 0, shows: 0, reminders: 0, returns: 0, investigations: 0, rechecks: 0, episodes: 0, resolved: 0, withdrawn: 0, exhausted: 0, crashes: 0 },
  }
}

/**
 * This monitor's own freshness band for one check, from the report record,
 * the check's time and the configuration the check names. Returns null when
 * the check is not a trusted, authored, listed read.
 */
function ownBand(mon, b) {
  if (b.listed === false || b.last_report_at == null) return null
  const cfg = mon.configs.get(b.config_ref)
  if (!cfg) return null
  const skew = cfg.max_source_skew_seconds * 1000
  if (b.source_now != null && Math.abs(b.source_now - b.checked_at) > skew) return 'error'
  const rep = b.report_id ? mon.reports.get(b.report_id) : null
  // A relayed declaration is never graded by its time, so it is `unknown`
  // even when that time is beyond the skew limit (the same order as the
  // model's grading: its time is not a report time, so it is not skew).
  if (rep && rep.evidence_class !== 'E2') return 'unknown'
  if (b.last_report_at - b.checked_at > skew) return 'error'
  if (!rep) return null
  const row = cfg.freshness[rep.state]
  if (!row) return 'unknown'
  const age = Math.max(0, b.checked_at - rep.last_report_at)
  let v = age <= row.fresh_max_s * 1000 ? 'fresh' : age > row.stale_after_s * 1000 ? 'stale' : 'aging'
  if (b.remote_without_clock && v === 'fresh') v = 'aging'
  return v
}

/** The monitor's own trigger runs (onsets) for one session at one tick check. */
function advanceRuns(mon, sk, b, own) {
  const cfg = mon.configs.get(b.config_ref) ?? mon.config
  const rep = b.report_id ? mon.reports.get(b.report_id) : null
  if (rep && rep.evidence_class === 'E5') {
    if (!mon.relayedSince.has(sk)) mon.relayedSince.set(sk, b.checked_at)
  } else if (b.outcome !== 'error') {
    mon.relayedSince.delete(sk)
  }
  const since = mon.relayedSince.get(sk)
  const act = mon.checkAct.get(b.check_id)
  const holds = {
    stale_report: (own === 'stale' && STALE_STATES.has(b.state)) || (since != null && rep?.evidence_class === 'E5' && b.checked_at - since > cfg.freshness.running.stale_after_s * 1000),
    native_disagreement: Boolean(b.native_available && act?.turn && DISAGREE_STATES.has(b.state)),
    dropped_from_list: b.listed === false,
    repeated_error: b.outcome === 'error' && mon.prevTickOutcome.get(sk) === 'error',
  }
  mon.prevTickOutcome.set(sk, b.outcome)
  const runs = mon.runs.get(sk) ?? {}
  for (const t of TRIGGERS) {
    const prev = runs[t]
    if (!holds[t]) runs[t] = null
    else if (!prev || (t === 'stale_report' && prev.reportId !== b.report_id)) runs[t] = { cycles: 0, reportId: b.report_id }
  }
  mon.runs.set(sk, runs)
}

function spec(mon, id, origin) {
  let it = mon.items.get(id)
  if (!it) {
    it = { id, origin, open: false, episode: 0, usedRefs: new Set(), state: 'none', shows: 0, counted: 0, reminders: 0, returns: 0, deferrals: 0, fp: null, contentRef: null, reportId: null, exhausted: false, openedBy: null, sk: null, source: null }
    mon.items.set(id, it)
  }
  return it
}

function newerAuthored(mon, sk, thanReportId) {
  const latest = mon.latestAuthored.get(sk)
  if (!latest) return null
  const lr = mon.reports.get(latest)
  const or = thanReportId ? mon.reports.get(thanReportId) : null
  if (!or || lr.last_report_at > or.last_report_at) return lr
  return null
}

function justifyResolved(mon, it) {
  const sk = it.sk
  switch (it.origin) {
    case 'declared': {
      const lr = newerAuthored(mon, sk, it.openedBy)
      return lr && !isOwnerBlock(lr, mon.config)
    }
    case 'prompt': {
      // The item's own prompt answered, or an owner answer to a later prompt.
      if (mon.answered.has(`${sk}|${it.contentRef}`)) return true
      const since = mon.promptRaised.get(`${sk}|${it.contentRef}`) ?? -Infinity
      for (const [k, at] of mon.answeredAt) if (k.startsWith(`${sk}|`) && k !== `${sk}|${it.contentRef}` && (mon.promptRaised.get(k) ?? at) >= since) return true
      return false
    }
    case 'attention':
      return Boolean(newerAuthored(mon, sk, it.reportId))
    case 'gone':
      return mon.listed.get(sk) === true
    case 'outage': {
      const tick = mon.lastTickOf.get(it.source)
      const t = mon.tickChecks.get(tick) ?? []
      return t.some((c) => c.outcome === 'ok' || c.outcome === 'no_report')
    }
    case 'seed': {
      const seed = it.seed
      if (!seed) return false
      for (const [osk, first] of mon.firstAuthored) {
        if (osk !== sk && first.scope === seed.scope && first.at > seed.written_at) return true
      }
      return false
    }
    default:
      return false
  }
}

function justifyWithdrawn(mon, it, reason) {
  switch (reason) {
    case 'dismissed':
      return mon.ownerDismiss.has(`${it.id}|${it.episode}`)
    case 'lapsed': {
      // No prompt pending at the latest live read, and a newer report.
      const pend = mon.livePending.get(it.sk)
      if (!pend || pend.size > 0) return false
      const lr = mon.latestAuthored.get(it.sk)
      const rep = lr ? mon.reports.get(lr) : null
      const raised = mon.promptRaised.get(`${it.sk}|${it.contentRef}`) ?? -Infinity
      return Boolean(rep && rep.last_report_at > raised)
    }
    case 'superseded':
      return [...mon.items.values()].some((g) => g.open && g.origin === 'gone' && g.sk === it.sk)
    case 'owner_stated_unverified':
      return mon.ownerDone.has(`${it.id}|${it.episode}`) && !sourceCaps(mon.config, it.source).scope
    default:
      return false
  }
}

function onRecord(mon, h, r) {
  const b = r.body
  const sk = r.session ? sessionKey(r.session) : null
  switch (r.kind) {
    case 'config':
      mon.configs.set(b.config_ref, b.values)
      mon.config = b.values
      break
    case 'report':
      mon.reports.set(r.id, b)
      if (b.evidence_class === 'E2' && !mon.firstAuthored.has(sk)) mon.firstAuthored.set(sk, { at: b.last_report_at, scope: mon.scopes.get(sk) ?? null })
      break
    case 'tick':
      if (b.phase === 'open') {
        mon.lastTickOf.set(b.source, b.tick_id)
        mon.tickOpenSeq.set(b.tick_id, r.seq)
      }
      break
    case 'check': {
      // I8: for a fixed report under a fixed configuration, the age-graded
      // freshness never improves.
      if (b.report_id && b.freshness in AGE_ORDER) {
        const key = `${sk}|${b.report_id}|${b.config_ref}`
        const prev = mon.freshSeq.get(key)
        if (prev && AGE_ORDER[b.freshness] < AGE_ORDER[prev.freshness] && b.checked_at >= prev.at) {
          fail('I8', `freshness improved from ${prev.freshness} to ${b.freshness} for one report under one configuration`)
        }
        mon.freshSeq.set(key, { freshness: b.freshness, at: b.checked_at })
      }
      // I8b: the model's graded freshness equals this monitor's own band.
      const own = ownBand(mon, b)
      if (own != null && b.read_kind !== 'activity') {
        const model = b.freshness
        if (own !== model) fail('I8b', `freshness graded ${model} where the report's age gives ${own}`)
      }
      if (b.trigger === 'tick') {
        mon.latestTick.set(sk, { ...b, sk, tickId: r.refs?.tick, own })
        advanceRuns(mon, sk, b, own)
        if (b.native_available) mon.livePending.set(sk, new Set((mon.checkAct.get(b.check_id)?.pending ?? []).map((p) => p.ref)))
        mon.listed.set(sk, b.listed !== false)
        const list = mon.tickChecks.get(r.refs?.tick) ?? []
        list.push({ source: b.source, outcome: b.outcome })
        mon.tickChecks.set(r.refs?.tick, list)
        const rep = b.report_id ? mon.reports.get(b.report_id) : null
        if (rep && b.outcome === 'ok' && rep.evidence_class === 'E2') mon.latestAuthored.set(sk, b.report_id)
      }
      if (b.scope != null) {
        mon.scopes.set(sk, b.scope)
        if (mon.firstAuthored.has(sk)) mon.firstAuthored.get(sk).scope = b.scope
      }
      break
    }
    case 'activity': {
      const act = mon.checkAct.get(b.check_id) ?? { turn: false, pending: [] }
      if (b.basis === 'busy_now_turn') act.turn = true
      if (b.basis === 'pending_permission') act.pending.push({ ref: b.ref, raised_at: b.raised_at })
      mon.checkAct.set(b.check_id, act)
      if (b.basis === 'permission_answered_by_owner') {
        mon.answered.add(`${sk}|${b.ref}`)
        mon.answeredAt.set(`${sk}|${b.ref}`, b.activity_at)
      }
      if (b.basis === 'pending_permission' && b.raised_at != null) mon.promptRaised.set(`${sk}|${b.ref}`, b.raised_at)
      break
    }
    case 'investigation': {
      const tick = r.refs?.tick
      if (b.phase === 'open') {
        mon.stats.investigations += 1
        mon.openInv.set(b.investigation_id, true)
        if (b.onset) mon.onsetTrigger.set(b.onset, b.trigger)
        const who = b.source_level ? `src:${b.source}` : sk
        const ts = `${tick}|${who}`
        mon.perTickSession.set(ts, (mon.perTickSession.get(ts) ?? 0) + 1)
        // I7b: at most one investigation per session per tick.
        if (mon.perTickSession.get(ts) > 1) fail('I7b', `two investigations of one session in one tick`)
        if (sk && b.report_id) {
          const set = mon.invReports.get(sk) ?? new Set()
          set.add(b.report_id)
          mon.invReports.set(sk, set)
        }
        if (b.trigger === 'recheck') {
          mon.stats.rechecks += 1
          mon.rechecksAt.set(`${tick}|${sk}`, true)
          if (!sourceCaps(mon.config, b.source).native_in_read) mon.tickPaid.set(tick, (mon.tickPaid.get(tick) ?? 0) + 1)
        } else {
          mon.tickCycles.set(tick, (mon.tickCycles.get(tick) ?? 0) + 1)
          // I7a: at most two cycles per onset. Per session, the onset is this
          // monitor's own: an unbroken run of tick checks at which the trigger
          // holds (a new report starts a new stale run; a no_longer_observed
          // recheck starts one too). The source-level outage investigation
          // uses the model's onset id: the monitor does not re-derive it.
          if (b.cycle < 1 || b.cycle > 2) fail('I7a', `cycle ${b.cycle}`)
          if (b.source_level) {
            const ok = `${who}|${b.onset}`
            const set = mon.onsetCycles.get(ok) ?? new Set()
            set.add(b.cycle)
            mon.onsetCycles.set(ok, set)
            if (set.size > 2) fail('I7a', `${set.size} cycles for one source-level onset`)
          } else {
            // I7i: an investigation is opened only for a trigger that this
            // monitor also sees holding at that tick.
            const run = mon.runs.get(sk)?.[b.trigger]
            if (!run) fail('I7i', `an investigation was opened for ${b.trigger}, which the monitor does not see holding`)
            run.cycles += 1
            if (run.cycles > 2) fail('I7a', `${run.cycles} cycles of ${b.trigger} in one unbroken run of the trigger`)
          }
        }
      } else if (b.phase === 'close') {
        mon.openInv.delete(b.investigation_id)
        if (b.trigger === 'dropped_from_list' && b.onset) {
          const list = mon.onsetConfirms.get(b.onset) ?? []
          for (const rg of b.rungs ?? []) if (rg.rung === 'confirm_gone') list.push(rg.outcome)
          mon.onsetConfirms.set(b.onset, list)
        }
        if (b.trigger === 'recheck' && b.classification === 'no_longer_observed' && sk) {
          const run = mon.runs.get(sk)?.stale_report
          if (run) run.cycles = 0
        }
      }
      break
    }
    case 'surface': {
      const it = spec(mon, b.item_id, b.origin)
      if (b.step === 'queued') {
        // I5: never two open episodes; never a new episode on a used reference.
        if (it.open) fail('I5', `a second episode opened while one is open (${b.origin})`)
        if (it.usedRefs.has(b.opened_by)) fail('I5', `an episode opened on an opening reference already used (${b.origin})`)
        if (b.episode !== it.episode + 1) fail('I5', `episode ${b.episode} after ${it.episode}`)
        Object.assign(it, { open: true, episode: b.episode, state: 'queued', shows: 0, counted: 0, reminders: 0, returns: 0, deferrals: 0, maxSeen: mon.config.surface.max_presentations, fp: b.fingerprint, contentRef: b.content_ref, reportId: b.report_id, exhausted: false, openedBy: b.opened_by, sk, source: b.source, seed: b.seed ?? null })
        it.usedRefs.add(b.opened_by)
        mon.stats.episodes += 1
        break
      }
      if (b.episode !== it.episode) break
      const max = mon.config.surface.max_presentations
      it.maxSeen = Math.max(it.maxSeen ?? max, max)
      const sending = b.phase === 'attempt'
      if (sending && it.exhausted) {
        // I6: an exhausted item sends nothing unless its content changed while a counted show remained.
        fail('I6', `an exhausted item sent '${b.step}' without a content change while a counted show remained`)
      }
      if (b.phase === 'outcome') break
      switch (b.step) {
        case 'shown':
          // I2c: the first show after a preemption is not the preempted item
          // itself. (It checks only that; which item is shown is the order's
          // business.)
          if (mon.lastPreempted && mon.lastPreempted === it.id && sending) fail('I2c', 'the first show after a preemption was the preempted item')
          if (sending) mon.lastPreempted = null
          it.shows += 1
          const counted = it.state !== 'deferred'
          if (counted) it.counted += 1
          else it.deferredShows = (it.deferredShows ?? 0) + 1
          it.state = 'active'
          mon.stats.shows += 1
          // I1a: a counted show stays within the limit in force when it is made.
          if (sending && counted && it.counted > max) fail('I1a', `${it.counted} counted shows in one episode (max ${max})`)
          if (sending && counted && b.shows_counted > max) fail('I1a', `stored shows_counted ${b.shows_counted} above max ${max}`)
          break
        case 'reminded':
          it.reminders += 1
          mon.stats.reminders += 1
          break
        case 'returned':
          it.returns += 1
          it.state = 'active'
          mon.stats.returns += 1
          break
        case 'expired':
          it.state = 'queued'
          break
        case 'preempted':
          it.state = 'queued'
          mon.lastPreempted = it.id
          break
        case 'deferred':
          it.deferrals += 1
          it.state = 'deferred'
          break
        case 'exhausted':
          it.state = 'exhausted'
          it.exhausted = true
          mon.stats.exhausted += 1
          break
        case 'updated': {
          let changed
          if (it.origin === 'prompt') changed = b.content_ref !== it.contentRef
          else {
            const rep = mon.reports.get(b.content_ref)
            changed = rep ? rep.block_fingerprint !== it.fp : true
            if (rep) it.fp = rep.block_fingerprint
          }
          it.contentRef = b.content_ref
          if (b.report_id) it.reportId = b.report_id
          if (b.requeue) {
            if (it.exhausted && changed && it.counted < max) it.exhausted = false
            it.state = 'queued'
          }
          break
        }
        case 'resolved':
          if (!justifyResolved(mon, it)) fail('I4b', `an item (${it.origin}) was resolved without its origin's closing evidence`)
          it.open = false
          it.state = 'closed'
          mon.stats.resolved += 1
          break
        case 'withdrawn': {
          if (!WITHDRAW_REASONS[it.origin]?.has(b.reason)) fail('I4b', `an item (${it.origin}) was withdrawn for '${b.reason}'`)
          if (!justifyWithdrawn(mon, it, b.reason)) fail('I4b', `an item (${it.origin}) was withdrawn as '${b.reason}' without the evidence for it`)
          if (b.reason === 'dismissed' && it.reportId) mon.dismissedReports.add(`${sk}|${it.reportId}`)
          it.open = false
          it.state = 'closed'
          mon.stats.withdrawn += 1
          break
        }
        default:
          break
      }
      // I1: per-episode bounds, from this monitor's own count...
      if (it.reminders > 2) fail('I1b', `${it.reminders} reminders in one episode`)
      if (it.returns > 1) fail('I1c', `${it.returns} returns in one episode`)
      if (it.shows > it.maxSeen + it.deferrals) fail('I1d', `${it.shows} shows exceed max ${it.maxSeen} plus ${it.deferrals} deferrals`)
      // ...and from the model's stored counters.
      if (b.reminders_used > 2) fail('I1b', `stored reminders_used ${b.reminders_used}`)
      if (b.returns_used > 1) fail('I1c', `stored returns_used ${b.returns_used}`)
      if (b.presentation > b.shows_counted + it.deferrals) fail('I1d', `presentation ${b.presentation} above ${b.shows_counted} counted plus ${it.deferrals} deferrals`)
      break
    }
    case 'owner_ack': {
      const it = mon.items.get(b.item_id)
      if (b.phase === 'ack' && b.intent === 'dismiss') mon.ownerDismiss.add(`${b.item_id}|${b.episode}`)
      if (b.phase === 'ack' && b.intent === 'done') mon.ownerDone.add(`${b.item_id}|${b.episode}`)
      if (it && b.phase === 'ack' && b.intent === 'done' && it.state === 'active' && b.episode === it.episode) {
        it.state = 'acknowledged'
        it.ackSeq = r.seq
      }
      break
    }
    case 'system':
      // I3a: the model never produces an idempotency_conflict from its own operation.
      if (b.event === 'idempotency_conflict') fail('I3a', `idempotency_conflict on ${b.detail.ids[0].slice(0, 12)}`)
      break
    default:
      break
  }
}

function covered(h, sk, source, reportId, mon) {
  for (const it of h.ctx.state.items.values()) {
    if (!it.open) continue
    if (it.origin === 'outage' && it.source === source) return true
    if (it.sk === sk && ['attention', 'gone', 'declared', 'prompt'].includes(it.origin)) return true
  }
  return mon.dismissedReports.has(`${sk}|${reportId}`)
}

function onTickClosed(mon, h, r) {
  const tick = r.body.tick_id
  const source = r.body.source
  const cfg = mon.config
  // I2b: an acknowledged item is verified at the next tick of its source
  // (every next-tick row of the transition table moves it), so it can never hold
  // the slot past that tick.
  const openSeq = mon.tickOpenSeq.get(tick) ?? 0
  for (const it of mon.items.values()) {
    if (it.open && it.state === 'acknowledged' && it.ackSeq < openSeq && (it.source == null || it.source === source)) {
      fail('I2b', `an acknowledged ${it.origin} item was not verified at the next tick of its source`)
    }
  }
  const budget = cfg.investigation_budget_per_tick
  const cycles = mon.tickCycles.get(tick) ?? 0
  // I7c: budgets respected.
  if (cycles > budget) fail('I7c', `${cycles} investigation cycles in one tick (budget ${budget})`)
  if ((mon.tickPaid.get(tick) ?? 0) > cfg.recheck_budget_per_tick) fail('I7c', `recheck budget exceeded`)
  for (const [sk, c] of mon.latestTick) {
    if (c.source !== source || c.tickId !== tick) continue
    const w = h.world.sessions[sk]
    // Graded by this monitor (I8b), not read from the model.
    const qualifies = c.own === 'stale' && STALE_STATES.has(c.state)
    const hasInv = Boolean(c.report_id && mon.invReports.get(sk)?.has(c.report_id))
    const starved = qualifies && !hasInv
    // I7d: rechecks never consume the cycle budget.
    if (starved && cycles < budget) fail('I7d', `a stale session was left uninvestigated with cycle budget unused`)
    // I7e: a held trigger gets its first cycle within a bound.
    const n = starved ? (mon.starve.get(sk) ?? 0) + 1 : 0
    mon.starve.set(sk, n)
    if (n > mon.firstCycleBound) fail('I7e', `a stale session waited ${n} ticks for its first cycle`)
    // I7f: a stale report that stays unexplained is surfaced within a bound.
    // DESIGN-GAP (exemption): a session whose turn ended after its report is
    // exempt, because the model never surfaces `finished_unreported` (it is
    // surfaced only when linked work is open, and the model links none; see
    // README).
    const rep = c.report_id ? mon.reports.get(c.report_id) : null
    const ended = rep && w ? w.events.some((e) => e.basis === 'turn_ended_after_report' && e.activity_at > rep.last_report_at) : false
    const unexplained = qualifies && w && !explainedNow(h.world, sk) && !ended
    const prev = mon.unexplained.get(sk)
    const u = unexplained ? (prev && prev.reportId === c.report_id ? prev.n + 1 : 1) : 0
    mon.unexplained.set(sk, { n: u, reportId: c.report_id })
    if (u > mon.surfaceBound && !covered(h, sk, source, c.report_id, mon)) {
      fail('I7f', `a stale, unexplained report went ${u} ticks without being surfaced (${c.state})`)
    }
    // I7g: no session is rechecked as working or waiting while nothing is there.
    const rechecked = mon.rechecksAt.get(`${tick}|${sk}`)
    const idleNow = w && !w.turn && !w.background && !w.prompts.some((p) => p.status === 'pending')
    const g = rechecked && idleNow ? (mon.recheckStreak.get(sk) ?? 0) + 1 : 0
    mon.recheckStreak.set(sk, g)
    if (g > 1) fail('I7g', `a session was rechecked ${g} ticks running while nothing was working or waiting`)
    // I10: an owner block is not left without an item. A prompt pending at a
    // live read, and an authored report that is an owner block, each have an
    // open item of that origin by the end of the tick, unless that item
    // already used the same opening reference.
    const sess = w?.session
    if (sess && c.native_available) {
      const pend = mon.checkAct.get(c.check_id)?.pending ?? []
      if (pend.length) {
        const latest = pend.slice().sort((a, b) => (a.raised_at ?? 0) - (b.raised_at ?? 0) || (a.ref < b.ref ? -1 : 1)).pop()
        const it = mon.items.get(itemIds.prompt(sess))
        if (!it?.open && !it?.usedRefs.has(latest.ref)) fail('I10', 'a prompt pending at a live read has no open prompt item')
      }
    }
    const la = mon.latestAuthored.get(sk)
    const lrep = la ? mon.reports.get(la) : null
    if (sess && lrep && isOwnerBlock(lrep, mon.config)) {
      const it = mon.items.get(itemIds.declared(sess))
      if (!it?.open && !it?.usedRefs.has(la)) fail('I10', 'an authored owner-block report has no open owner-block item')
    }
  }
}

function explainedNow(world, sk) {
  const w = world.sessions[sk]
  if (!world.sources[w.session.source].up || !w.listed) return true
  return w.turn || w.background || w.prompts.some((p) => p.status === 'pending')
}

/** Check everything appended since the last call. `complete` is false while a crashed step awaits replay. */
export function checkStep(mon, h, { complete = true } = {}) {
  const recs = h.ctx.ledger.records
  for (; mon.pos < recs.length; mon.pos++) {
    const r = recs[mon.pos]
    mon.stats.records += 1
    onRecord(mon, h, r)
    if (r.kind === 'tick' && r.body.phase === 'close') onTickClosed(mon, h, r)
  }
  // I3b: no attempt is ever sent twice, crashes included.
  for (; mon.sendPos < h.sends.length; mon.sendPos++) {
    const s = h.sends[mon.sendPos]
    mon.stats.sends += 1
    if (mon.sendKeys.has(s.attempt_id)) fail('I3b', `attempt ${s.step} n=${s.n} sent twice`)
    mon.sendKeys.add(s.attempt_id)
  }
  if (!complete) return
  // I7h: every investigation that opened has closed by the end of its step.
  if (mon.openInv.size > 0) fail('I7h', `an investigation was left open after its tick`)
  // I2: at most one item active at any moment.
  const active = [...mon.items.values()].filter((it) => it.open && it.state === 'active')
  if (active.length > 1) fail('I2', `${active.length} items active at once (${active.map((a) => a.origin).join(', ')})`)
  // I4c: the model's derived open set equals this monitor's account of the
  // same records. Both are folds of one ledger, so this catches a fold that
  // drops or keeps an item wrongly; it cannot see an item never raised
  // (that is I10's job).
  for (const it of mon.items.values()) {
    const m = h.ctx.state.items.get(it.id)
    if (it.open !== Boolean(m?.open)) fail('I4c', `item open=${it.open} in the ledger account but open=${Boolean(m?.open)} in the model`)
  }
  // I9: an owner-block report is not surfaced a second time as an attention
  // item beside its own owner-block item. Two cases are exempt, both places
  // where the owner hears twice about one session (README, open):
  //  - the attention item came from `repeated_error`: the session's own reads
  //    keep failing, a different signal from its old line;
  //  - DESIGN-GAP: it came from `dropped_from_list` on a source that cannot
  //    confirm `gone`, so two inconclusive cycles surface it as attention;
  //  - DESIGN-GAP: it came from `dropped_from_list` where every confirming
  //    read found the session listed again (a list that intermittently omits
  //    it), which is also two inconclusive cycles.
  for (const it of h.ctx.state.items.values()) {
    if (!it.open || it.origin !== 'attention' || !it.session) continue
    const trigger = mon.onsetTrigger.get(it.openedBy)
    if (trigger === 'repeated_error') continue
    if (trigger === 'dropped_from_list' && !sourceCaps(mon.config, it.source).can_confirm_gone) continue
    const confirms = mon.onsetConfirms.get(it.openedBy) ?? []
    if (trigger === 'dropped_from_list' && confirms.length > 0 && confirms.every((c) => c === 'listed')) continue
    const d = h.ctx.state.items.get(itemIds.declared(it.session))
    const rep = it.reportId ? mon.reports.get(it.reportId) : null
    if (d?.open && rep && isOwnerBlock(rep, mon.config)) fail('I9', `an owner-block report holds both an owner-block item and an attention item (${trigger})`)
  }
}
