/**
 * Invariant monitor for generated sequences.
 *
 * It reads the ledger incrementally and keeps its OWN account of every item
 * (a spec-level state per item), so it does not trust the model's derived
 * state or counters: a broken rule in the model shows up as a disagreement
 * with this account, or as a bound the account says was crossed. Ground truth
 * about sessions comes from the simulated world.
 *
 * Each failure carries an invariant id (I1a .. I13, with I7i) so a mutation proof can
 * assert WHICH invariant went red. The full list is in ../README.md.
 *
 * What the monitor derives for itself rather than reading from the model:
 * item states and counters, the freshness band of each trusted authored read
 * (I8b), the onset of each per-session trigger (I7a), and the evidence behind
 * every resolution and withdrawal (I4b), and which attention conditions are
 * live and what each owner item's content names (I9, I11). It still
 * reads from the model the parsed report fields, an investigation's decision
 * to surface (whose timing I7f checks against the world) and, for the
 * source-level outage investigation only, the model's own onset.
 *
 * Limits: the monitor uses the model's own `isOwnerBlock` (for declared
 * resolutions in I4b, and in I10) and the model-computed
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
const OWNER_BLOCK_ORIGINS = new Set(['owner'])
const WITHDRAW_REASONS = {
  owner: new Set(['lapsed']),
  attention: new Set(['dismissed', 'superseded', 'merged']),
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
    // I11: attention conditions this monitor holds live, by attention item id,
    // and every (attention item, opening reference) an owner item carried.
    conds: new Map(),
    carriedEver: new Set(),
    // What each owner episode carried when it closed: "item|episode" ->
    // Map(attention item -> condition root), for the handover that follows.
    closedCarried: new Map(),
    // I12: sends per condition, by the condition's root (the reference that
    // first opened it), across every episode that condition opened.
    condCounts: new Map(),
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
    it = { id, origin, open: false, episode: 0, usedRefs: new Set(), state: 'none', shows: 0, counted: 0, reminders: 0, returns: 0, deferrals: 0, fp: null, contentRef: null, reportId: null, exhausted: false, openedBy: null, sk: null, source: null, asks: new Map(), endedRefs: new Set(), stood: new Set(), owed: false, noShow: false, roundOwed: 0, roundJoins: 0, roundShown: 0, tookSlot: null, base: null }
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

/** The evidence that ends one ask, from this monitor's own account of reports, prompts and answers. */
function askEnded(mon, sk, kind, ask, how) {
  if (kind === 'declared') {
    const lr = newerAuthored(mon, sk, ask.opened_by)
    return Boolean(lr && !isOwnerBlock(lr, mon.config))
  }
  if (how === 'lapsed') {
    // No prompt pending at the latest live read, and a newer report.
    const pend = mon.livePending.get(sk)
    if (!pend || pend.size > 0) return false
    const lr = mon.latestAuthored.get(sk)
    const rep = lr ? mon.reports.get(lr) : null
    const raised = mon.promptRaised.get(`${sk}|${ask.content_ref}`) ?? -Infinity
    return Boolean(rep && rep.last_report_at > raised)
  }
  // The ask's own prompt answered, or an owner answer to a later prompt.
  if (mon.answered.has(`${sk}|${ask.content_ref}`)) return true
  const since = mon.promptRaised.get(`${sk}|${ask.content_ref}`) ?? -Infinity
  for (const [k, at] of mon.answeredAt) if (k.startsWith(`${sk}|`) && k !== `${sk}|${ask.content_ref}` && (mon.promptRaised.get(k) ?? at) >= since) return true
  return false
}

/** The kinds the record says the item carries equal this monitor's own fold of its ask changes. */
/**
 * One ask as this monitor follows it: the references it stood on (its
 * opening reference and, for a declared ask, every authored owner-block
 * report it covered while live, as this monitor sees the reports). A prompt
 * the content moved away from stays free to open an ask of its own (it may
 * still be pending, unanswered).
 */
function newAsk(_mon, _sk, a) {
  return { opened_by: a.opened_by, content_ref: a.content_ref ?? null, fp: a.fingerprint ?? null, stood: new Set([a.opened_by]) }
}

/** At a tick's end: a live declared ask covers the session's latest authored owner-block report, whatever its fingerprint. */
function follow(x, ask, ref) {
  ask.stood.add(ref)
  x.stood.add(ref)
}

function checkAsks(it, b) {
  const named = (b.asks ?? []).map((a) => a.kind).sort()
  const mine = [...it.asks.keys()].sort()
  if (named.length !== mine.length || named.some((k, i) => k !== mine[i])) fail('I10', `an owner item's content lists asks [${named}] where its changes add up to [${mine}]`)
}

function justifyResolved(mon, it, b) {
  const sk = it.sk
  switch (it.origin) {
    case 'owner': {
      const ask = it.asks.get(b.closing_ask)
      return Boolean(ask) && askEnded(mon, sk, b.closing_ask, ask, 'resolved')
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

function justifyWithdrawn(mon, it, reason, _b) {
  switch (reason) {
    case 'dismissed':
      return mon.ownerDismiss.has(`${it.id}|${it.episode}`)
    case 'lapsed': {
      const ask = it.asks.get('prompt')
      return Boolean(ask) && askEnded(mon, it.sk, 'prompt', ask, 'lapsed')
    }
    case 'superseded':
      return [...mon.items.values()].some((g) => g.open && g.origin === 'gone' && g.sk === it.sk)
    case 'merged':
      return openOwnerBlocksOf(mon, it.sk).some((ob) => ob.own?.has(it.id))
    case 'owner_stated_unverified':
      return mon.ownerDone.has(`${it.id}|${it.episode}`) && !sourceCaps(mon.config, it.source).scope
    default:
      return false
  }
}

/** One condition's sends: its attention item and its root, across its episodes. */
function account(mon, it) {
  const key = `${it.id}|${it.root}`
  let a = mon.condCounts.get(key)
  if (!a) {
    a = { counted: 0, reminders: 0, returns: 0, deferrals: 0 }
    mon.condCounts.set(key, a)
  }
  return a
}

/**
 * I1d: the counters a record stores are this monitor's own counts of the
 * episode's shows, counted shows, round shows, reminders and returns.
 */
function checkCounters(it, b) {
  if (!it.base) return
  const own = {
    presentation: it.base.presentation + it.shows,
    shows_counted: it.base.shows_counted + it.counted,
    round_shows: it.base.round_shows + it.roundShown,
    reminders_used: it.base.reminders_used + it.reminders,
    returns_used: it.base.returns_used + it.returns,
  }
  for (const [k, v] of Object.entries(own)) {
    const stored = k === 'round_shows' ? (b.round_shows ?? 0) : b[k]
    if (stored !== v) fail('I1d', `a ${b.step} record stores ${k} ${stored} where this monitor counts ${v}`)
  }
}

/** I10: an owner item closes only with its last ask. */
function closeOwner(it, b) {
  if (it.origin !== 'owner') return
  const others = [...it.asks.keys()].filter((k) => k !== b.closing_ask)
  if (!it.asks.has(b.closing_ask) || others.length > 0) fail('I10', `an owner item closed on its ${b.closing_ask} ask while [${others}] was still live`)
}

function endClosingAsk(it, b) {
  if (it.origin !== 'owner') return
  const ask = it.asks.get(b.closing_ask)
  if (ask) for (const ref of ask.stood) it.endedRefs.add(ref)
  it.asks = new Map()
}

function openOwnerBlocksOf(mon, sk) {
  return [...mon.items.values()].filter((x) => x.open && x.sk === sk && OWNER_BLOCK_ORIGINS.has(x.origin))
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
        mon.currentTick = b.tick_id
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
        if (b.trigger === 'recheck' && b.classification === 'no_longer_observed' && sk) {
          const run = mon.runs.get(sk)?.stale_report
          if (run) run.cycles = 0
        }
        // I11: an investigation that decides to surface a session starts a
        // condition that must stay in front of the owner until its attention
        // item's own closing evidence, unless the attention item it would be
        // already used that opening reference (the model never reopens on a
        // used reference) or a carried condition consumed it.
        if (sk && b.surface === 'attention') {
          const id = itemIds.attention(r.session, b.report_id)
          const ref = b.onset ?? b.basis_onset ?? b.investigation_id
          const spent = mon.items.get(id)?.usedRefs.has(ref) || mon.carriedEver.has(`${id}|${ref}`)
          if (!mon.conds.has(id) && !spent) mon.conds.set(id, { id, sk, ref, reportId: b.report_id ?? null })
        }
        // A session confirmed gone supersedes every attention condition it had.
        if (sk && b.surface === 'gone') for (const [id, c] of mon.conds) if (c.sk === sk) mon.conds.delete(id)
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
        Object.assign(it, { open: true, episode: b.episode, state: 'queued', shows: 0, counted: 0, reminders: 0, returns: 0, deferrals: 0, maxSeen: mon.config.surface.max_presentations, fp: b.fingerprint, contentRef: b.content_ref, reportId: b.report_id, exhausted: false, openedBy: b.opened_by, sk, source: b.source, seed: b.seed ?? null, carried: [], own: new Map(), roundOwed: 0, roundJoins: 0, roundShown: 0, tookSlot: null })
        // The counters this episode starts from (an attention item handed back
        // continues its condition's), for I1d's comparison of every record.
        it.base = { presentation: b.presentation, shows_counted: b.shows_counted, reminders_used: b.reminders_used, returns_used: b.returns_used, round_shows: b.round_shows ?? 0 }
        it.usedRefs.add(b.opened_by)
        if (b.ask) {
          // I5: an ask opens only on a reference no earlier ask of the item stood on.
          if (it.stood.has(b.ask.opened_by)) fail('I5', `a ${b.ask.kind} ask opened an owner item on a reference an earlier ask stood on`)
          it.asks = new Map([[b.ask.kind, newAsk(mon, sk, b.ask)]])
          it.stood.add(b.ask.opened_by)
          checkAsks(it, b)
        }
        // A condition's root, from this monitor's own account: the opening
        // reference, unless the episode is a handover of a condition that a
        // closed owner episode carried, which keeps that one's root.
        if (b.origin === 'attention') it.root = (b.handover_of && mon.closedCarried.get(b.handover_of)?.get(b.item_id)) || b.opened_by
        mon.stats.episodes += 1
        break
      }
      if (b.episode !== it.episode) break
      const max = mon.config.surface.max_presentations
      it.maxSeen = Math.max(it.maxSeen ?? max, max)
      const sending = b.phase === 'attempt'
      // A prompt round's show, as this monitor counts them: a show made while
      // a round that joined with the counted shows used is still owed one,
      // unless it is an ordinary show that serves the round as well: a queued
      // item with a counted show left (the limit was raised since), or the
      // owner's deferral coming due.
      const deferralDue = it.state === 'deferred' && it.deferUntil != null && Date.parse(r.ts) >= it.deferUntil
      const ordinary = (it.state === 'queued' && it.counted < max) || deferralDue
      const roundShow = sending && b.step === 'shown' && it.roundOwed > 0 && !ordinary
      if (sending && it.exhausted && !roundShow) {
        // I6: an exhausted item sends nothing unless its content changed while a counted show remained.
        fail('I6', `an exhausted item sent '${b.step}' without a content change while a counted show remained`)
      }
      if (b.phase === 'outcome') {
        checkCounters(it, b)
        break
      }
      switch (b.step) {
        case 'shown':
          // I2c: the first show after a preemption is not the preempted item
          // itself. (It checks only that; which item is shown is the order's
          // business.)
          if (mon.lastPreempted && mon.lastPreempted === it.id && sending) fail('I2c', 'the first show after a preemption was the preempted item')
          // A round's show takes no slot, so it is not the show that follows
          // a preemption.
          if (sending && !roundShow) mon.lastPreempted = null
          it.shows += 1
          if (roundShow) {
            // I2: a round's show waits for the slot: it is made by the item
            // holding the slot, or while the slot is free.
            const other = [...mon.items.values()].find((x) => x !== it && x.open && (x.state === 'active' || x.state === 'acknowledged'))
            if (other) fail('I2', `a round's show was made while another item (${other.origin}) held the slot`)
            // It takes nothing: the item keeps the state it had.
            it.roundOwed -= 1
            it.roundShown += 1
            mon.stats.shows += 1
            mon.stats.roundShows = (mon.stats.roundShows ?? 0) + 1
            break
          }
          if (sending) it.roundOwed = 0
          const counted = it.state !== 'deferred'
          if (counted) it.counted += 1
          else it.deferredShows = (it.deferredShows ?? 0) + 1
          if (sending && it.state !== 'active' && it.state !== 'acknowledged') it.tookSlot = mon.currentTick
          it.state = 'active'
          mon.stats.shows += 1
          // I13: a new ask found no counted show left, so nothing is shown for it.
          if (sending && counted && it.noShow) fail('I13', 'an owner item with no counted show left was shown for a new ask')
          if (sending && counted) it.owed = false
          // I1a: a counted show stays within the limit in force when it is
          // made; beyond it, only the one show each prompt round earned
          // (counted above, from this monitor's own count of rounds).
          if (sending && counted && it.counted > max) fail('I1a', `${it.counted} counted shows in one episode (max ${max}), with ${it.roundJoins} rounds after the limit and none owed`)
          if (sending && counted && b.shows_counted > max) fail('I1a', `stored shows_counted ${b.shows_counted} above max ${max}`)
          // I12: one condition, however many episodes, within the show limit.
          if (sending && counted && it.root && ++account(mon, it).counted > max) fail('I12', `one condition was shown ${account(mon, it).counted} counted times across its episodes (max ${max})`)
          break
        case 'reminded':
          it.reminders += 1
          mon.stats.reminders += 1
          if (sending && it.root && ++account(mon, it).reminders > 2) fail('I12', `one condition was reminded ${account(mon, it).reminders} times across its episodes`)
          break
        case 'returned':
          if (sending && it.root && ++account(mon, it).returns > 1) fail('I12', `one condition was returned ${account(mon, it).returns} times across its episodes`)
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
          it.deferUntil = b.until ?? null
          if (it.root) account(mon, it).deferrals += 1
          it.deferrals += 1
          it.state = 'deferred'
          break
        case 'exhausted':
          it.state = 'exhausted'
          it.exhausted = true
          mon.stats.exhausted += 1
          break
        case 'updated': {
          if (b.ask) {
            const kind = b.ask.kind
            let changed = true
            if (b.ask.op === 'join') {
              // I5: an ask joins only on a reference no earlier ask of the item used.
              if (it.usedRefs.has(b.ask.opened_by)) fail('I5', `a ${kind} ask joined an owner item on a reference already used`)
              if (it.stood.has(b.ask.opened_by)) fail('I5', `a ${kind} ask joined an owner item on a reference an earlier ask stood on`)
              if (it.asks.has(kind)) fail('I10', `a second ${kind} ask joined one owner item`)
              it.usedRefs.add(b.ask.opened_by)
              it.asks.set(kind, newAsk(mon, sk, b.ask))
              it.stood.add(b.ask.opened_by)
              // I13: a new ask with a counted show left is owed one; with none
              // left it may change only the content.
              if (it.counted < max) it.owed = mon.lastTickOf.get(b.source) ?? true
              else if (kind === 'prompt') {
                // A prompt round after the limit is owed exactly one show.
                it.roundOwed = 1
                it.roundJoins += 1
              } else it.noShow = true
              mon.stats.joins = (mon.stats.joins ?? 0) + 1
            } else if (b.ask.op === 'end') {
              const mine = it.asks.get(kind)
              if (!mine) fail('I10', `an owner item ended a ${kind} ask it does not carry`)
              if (!askEnded(mon, sk, kind, mine, b.ask.how)) fail('I4b', `a ${kind} ask was ended (${b.ask.how}) without its evidence`)
              it.asks.delete(kind)
              if (kind === 'prompt') it.roundOwed = 0
              for (const ref of mine.stood) it.endedRefs.add(ref)
              changed = false
            } else {
              const mine = it.asks.get(kind)
              if (!mine) fail('I10', `an owner item changed a ${kind} ask it does not carry`)
              if (kind === 'prompt') {
                changed = b.ask.content_ref !== mine.content_ref
                mine.content_ref = b.ask.content_ref
              } else {
                const rep = mon.reports.get(b.ask.report_id)
                changed = rep ? rep.block_fingerprint !== mine.fp : true
                if (rep) mine.fp = rep.block_fingerprint
              }
            }
            checkAsks(it, b)
            if (b.requeue) {
              if (it.noShow && it.exhausted) fail('I13', 'an exhausted owner item with no counted show left was queued again for a new ask')
              if (it.exhausted && changed && it.counted < max) it.exhausted = false
              it.state = 'queued'
            }
            break
          }
          if (b.carry) {
            // A carried-condition change: judged against this monitor's own
            // account of what the item carries, not the record's list.
            const own = it.own ?? new Map()
            const key = b.carry.attention_item
            const changed = b.carry.op === 'carry' ? !own.has(key) : own.has(key)
            if (b.carry.op === 'carry') {
              // The condition's root: that of the attention item being merged,
              // or of the closed owner episode handing it on, else the
              // reference that would have opened it.
              const att = mon.items.get(key)
              const root = (att?.open && att.root) || (b.carry.from && mon.closedCarried.get(b.carry.from)?.get(key)) || b.carry.opened_by
              own.set(key, root)
              mon.carriedEver.add(`${key}|${b.carry.opened_by}`)
            } else own.delete(key)
            it.own = own
            it.carried = b.carried ?? []
            // I11: what the record says the item names is what this monitor's
            // own account says it carries.
            const named = it.carried.map((c) => c.attention_item).sort()
            const mine = [...own.keys()].sort()
            if (named.length !== mine.length || named.some((k, i) => k !== mine[i])) fail('I11', `an owner item's content names ${named.length} conditions where its changes add up to ${mine.length}`)
            if (b.requeue) {
              if (it.exhausted && changed && it.counted < max) it.exhausted = false
              it.state = 'queued'
            }
            break
          }
          // Only owner items have an `updated` step, and each is an ask change
          // or a carried-condition change.
          break
        }
        case 'resolved':
          closeOwner(it, b)
          if (!justifyResolved(mon, it, b)) fail('I4b', `an item (${it.origin}) was resolved without its origin's closing evidence`)
          endClosingAsk(it, b)
          if (it.own) mon.closedCarried.set(`${it.id}|${it.episode}`, new Map(it.own))
          it.open = false
          it.state = 'closed'
          mon.stats.resolved += 1
          break
        case 'withdrawn': {
          if (!WITHDRAW_REASONS[it.origin]?.has(b.reason)) fail('I4b', `an item (${it.origin}) was withdrawn for '${b.reason}'`)
          closeOwner(it, b)
          if (!justifyWithdrawn(mon, it, b.reason, b)) fail('I4b', `an item (${it.origin}) was withdrawn as '${b.reason}' without the evidence for it`)
          endClosingAsk(it, b)
          if (b.reason === 'dismissed' && it.reportId) mon.dismissedReports.add(`${sk}|${it.reportId}`)
          if (b.reason === 'dismissed' && it.origin === 'attention') mon.conds.delete(it.id)
          if (it.own) mon.closedCarried.set(`${it.id}|${it.episode}`, new Map(it.own))
          it.open = false
          it.state = 'closed'
          mon.stats.withdrawn += 1
          break
        }
        default:
          break
      }
      checkCounters(it, b)
      // I1: per-episode bounds, from this monitor's own count...
      if (it.reminders > 2) fail('I1b', `${it.reminders} reminders in one episode`)
      if (it.returns > 1) fail('I1c', `${it.returns} returns in one episode`)
      if (it.shows > it.maxSeen + it.deferrals + it.roundShown) fail('I1d', `${it.shows} shows exceed max ${it.maxSeen} plus ${it.deferrals} deferrals and ${it.roundShown} round shows`)
      // ...and from the model's stored counters.
      if (b.reminders_used > 2) fail('I1b', `stored reminders_used ${b.reminders_used}`)
      if (b.returns_used > 1) fail('I1c', `stored returns_used ${b.returns_used}`)
      // A condition's episodes continue one presentation count, so its stored
      // count is bounded by the deferrals of all of them.
      const deferrals = it.root ? account(mon, it).deferrals : it.deferrals
      if (b.presentation > b.shows_counted + deferrals + it.roundShown) fail('I1d', `presentation ${b.presentation} above ${b.shows_counted} counted plus ${deferrals} deferrals and ${it.roundShown} round shows`)
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
    if (it.sk === sk && ['attention', 'gone', 'owner'].includes(it.origin)) return true
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
  // I13: a new ask that found a counted show left is shown by the end of the
  // tick that brought it: at once if its item held the slot, else as the
  // tick fills the slot, so a new ask still unshown is queued behind the
  // item that holds the slot. With no counted show left it brought no show.
  const holder = [...mon.items.values()].find((x) => x.open && (x.state === 'active' || x.state === 'acknowledged'))
  for (const it of mon.items.values()) {
    if (it.owed !== tick) continue
    it.owed = false
    if (!it.open || it.counted >= cfg.surface.max_presentations) continue
    if (it.state === 'queued' && holder && holder !== it) continue
    fail('I13', `an owner item owed a show for a new ask is ${it.state === 'queued' ? 'queued with the slot free' : it.state} at the end of the tick, not shown`)
  }
  // I13, for prompt rounds after the limit: a round's one show stays owed,
  // from this monitor's own account, until it is made, its prompt ask ends,
  // or an ordinary show serves it. At every tick's end an item still owed one
  // must be waiting behind another item that holds the slot: one that held it
  // before this tick filled the slot, or, for a queued item, one that took it
  // now. The order between the two is not checked here: a queued item passes
  // whenever another item holds the slot, on the ground that the model shows
  // or exhausts everything ahead of the taker (the ordering checks cover a
  // model that does not). Holding the slot itself, or with the slot free, it
  // should have been shown.
  const tickTime = Date.parse(r.ts)
  for (const it of mon.items.values()) {
    if (!it.open || it.roundOwed === 0) continue
    if (holder && holder !== it) {
      const queuedNow = it.state === 'queued' || (it.state === 'deferred' && it.deferUntil != null && tickTime >= it.deferUntil)
      if (queuedNow || holder.tookSlot !== tick) continue
    }
    fail('I13', `a prompt round owed its show was not shown (item ${it.state}${holder ? (holder === it ? ', holding the slot' : ', the slot taken this tick by another') : ', the slot free'})`)
  }
  for (const it of mon.items.values()) it.noShow = false
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
    // I10: every live ask is on the session's open owner item, by the end of
    // the tick, as this monitor sees the asks: the latest prompt pending at a
    // live read, and an authored report that is an owner block. The only
    // exception is a line or prompt that an ask already stood on and that ask
    // has ended (a session rewound to it), which never brings it back. And no owner item
    // still carries a declared ask that a newer, non-owner-block report ended.
    const owners = [...mon.items.values()].filter((x) => x.sk === sk && OWNER_BLOCK_ORIGINS.has(x.origin))
    const carrying = (kind) => owners.some((x) => x.open && x.asks.has(kind))
    const askGone = (ref) => owners.some((x) => x.endedRefs.has(ref))
    const la = mon.latestAuthored.get(sk)
    const lrep = la ? mon.reports.get(la) : null
    const ob = Boolean(lrep && isOwnerBlock(lrep, mon.config))
    let latest = null
    if (c.native_available) {
      const pend = mon.checkAct.get(c.check_id)?.pending ?? []
      if (pend.length) latest = pend.slice().sort((a, b) => (a.raised_at ?? 0) - (b.raised_at ?? 0) || (a.ref < b.ref ? -1 : 1)).pop()
    }
    // The references each live ask stood on, as this monitor sees its
    // content move (I5 uses them).
    for (const x of owners) {
      if (!x.open) continue
      const d = x.asks.get('declared')
      if (d && ob) follow(x, d, la)
    }
    if (latest && !carrying('prompt') && !askGone(latest.ref)) fail('I10', 'a prompt pending at a live read is not an ask on an open owner item')
    if (ob && !carrying('declared') && !askGone(la)) fail('I10', 'an authored owner-block report is not an ask on an open owner item')
    for (const x of owners) {
      const d = x.open ? x.asks.get('declared') : null
      if (d && askEnded(mon, sk, 'declared', d, 'resolved')) fail('I10', 'an owner item still carries a declared ask that a newer report ended')
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
  // ...and the item that holds the slot in the model is the one that holds it
  // in this monitor's account (a round's show takes no slot).
  const holds = (st) => st === 'active' || st === 'acknowledged'
  for (const it of mon.items.values()) {
    const m = h.ctx.state.items.get(it.id)
    if (it.open && m?.open && holds(it.state) !== holds(m.state)) fail('I2', `an item holds the slot in the model (${m.state}) but not in the ledger account (${it.state}), or the reverse`)
  }
  // I4c: the model's derived open set equals this monitor's account of the
  // same records. Both are folds of one ledger, so this catches a fold that
  // drops or keeps an item wrongly; it cannot see an item never raised
  // (that is I10's job).
  for (const it of mon.items.values()) {
    const m = h.ctx.state.items.get(it.id)
    if (it.open !== Boolean(m?.open)) fail('I4c', `item open=${it.open} in the ledger account but open=${Boolean(m?.open)} in the model`)
  }
  // I9: a session never has two open owner items, and a session with an
  // open owner item never also has an open attention item, whatever the
  // attention item's trigger.
  const blocked = new Set()
  for (const it of mon.items.values()) {
    if (!it.open || !OWNER_BLOCK_ORIGINS.has(it.origin)) continue
    if (blocked.has(it.sk)) fail('I9', 'a session holds two open owner items')
    blocked.add(it.sk)
  }

  for (const it of mon.items.values()) {
    if (!it.open || it.origin !== 'attention' || !blocked.has(it.sk)) continue
    fail('I9', `a session holds both an owner item and an attention item (${mon.onsetTrigger.get(it.openedBy) ?? 'carried'})`)
  }
  // I11: a condition that was surfaced is never lost. While it is live (no
  // newer authored report, not superseded by gone, not dismissed), its
  // session has its open attention item or an open owner item whose
  // content names it; and an owner item names no condition that has
  // ended.
  for (const [id, c] of mon.conds) {
    if (newerAuthored(mon, c.sk, c.reportId)) mon.conds.delete(id)
  }
  for (const c of mon.conds.values()) {
    if (mon.items.get(c.id)?.open) continue
    if (openOwnerBlocksOf(mon, c.sk).some((ob) => ob.own?.has(c.id))) continue
    fail('I11', `a surfaced condition has neither its attention item nor an owner item that names it`)
  }
  for (const ob of mon.items.values()) {
    if (!ob.open || !OWNER_BLOCK_ORIGINS.has(ob.origin)) continue
    for (const id of ob.own?.keys() ?? []) if (!mon.conds.has(id)) fail('I11', `an owner item names a condition that has ended`)
  }
}
