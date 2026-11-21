/**
 * Invariant monitor for generated sequences.
 *
 * It reads the ledger incrementally and keeps its OWN account of every item
 * (a spec-level state per item), so it does not trust the model's derived
 * state or counters: a broken rule in the model shows up as a disagreement
 * with this account, or as a bound the account says was crossed. Ground truth
 * about sessions comes from the simulated world.
 *
 * Each failure carries an invariant id (I1a .. I9) so a mutation proof can
 * assert WHICH invariant went red.
 */

import { isOwnerBlock } from '../../../src/freshness/policy.js'
import { sourceCaps } from '../../../src/freshness/config.js'
import { AGE_ORDER } from '../../../src/freshness/grade.js'
import { itemIds, sessionKey } from '../../../src/freshness/keys.js'

export class InvariantError extends Error {
  constructor(id, message) {
    super(`[${id}] ${message}`)
    this.id = id
  }
}

const STALE_STATES = new Set(['running', 'unknown', 'blocked', 'stalled'])
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
    stats: { records: 0, sends: 0, shows: 0, reminders: 0, returns: 0, investigations: 0, rechecks: 0, episodes: 0, resolved: 0, withdrawn: 0, exhausted: 0, crashes: 0 },
  }
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

function onRecord(mon, h, r) {
  const b = r.body
  const sk = r.session ? sessionKey(r.session) : null
  const max = mon.config.surface.max_presentations
  switch (r.kind) {
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
      if (b.trigger === 'tick') {
        mon.latestTick.set(sk, { ...b, sk, tickId: r.refs?.tick })
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
      break
    }
    case 'activity':
      if (b.basis === 'permission_answered_by_owner') {
        mon.answered.add(`${sk}|${b.ref}`)
        mon.answeredAt.set(`${sk}|${b.ref}`, b.activity_at)
      }
      if (b.basis === 'pending_permission' && b.raised_at != null) mon.promptRaised.set(`${sk}|${b.ref}`, b.raised_at)
      break
    case 'investigation': {
      const tick = r.refs?.tick
      if (b.phase === 'open') {
        mon.stats.investigations += 1
        mon.openInv.set(b.investigation_id, true)
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
          // I7a: at most two cycles per onset.
          const ok = `${who}|${b.trigger}|${b.onset}`
          const set = mon.onsetCycles.get(ok) ?? new Set()
          set.add(b.cycle)
          mon.onsetCycles.set(ok, set)
          if (b.cycle < 1 || b.cycle > 2 || set.size > 2) fail('I7a', `cycle ${b.cycle} for one onset (${set.size} cycles)`)
        }
      } else if (b.phase === 'close') {
        mon.openInv.delete(b.investigation_id)
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
        Object.assign(it, { open: true, episode: b.episode, state: 'queued', shows: 0, counted: 0, reminders: 0, returns: 0, deferrals: 0, fp: b.fingerprint, contentRef: b.content_ref, reportId: b.report_id, exhausted: false, openedBy: b.opened_by, sk, source: b.source, seed: b.seed ?? null })
        it.usedRefs.add(b.opened_by)
        mon.stats.episodes += 1
        break
      }
      if (b.episode !== it.episode) break
      const sending = b.phase === 'attempt'
      if (sending && it.exhausted) {
        // I6: an exhausted item sends nothing unless its content changed while a counted show remained.
        fail('I6', `an exhausted item sent '${b.step}' without a content change while a counted show remained`)
      }
      if (b.phase === 'outcome') break
      switch (b.step) {
        case 'shown':
          // I2c: a preemption shows the item that preempted, never the
          // preempted item straight back.
          if (mon.lastPreempted && mon.lastPreempted === it.id && sending) fail('I2c', 'a preempted item was shown again ahead of the item that preempted it')
          if (sending) mon.lastPreempted = null
          it.shows += 1
          if (it.state === 'deferred') it.deferredShows = (it.deferredShows ?? 0) + 1
          else it.counted += 1
          it.state = 'active'
          mon.stats.shows += 1
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
          if (b.reason === 'dismissed' && !mon.ownerDismiss.has(`${it.id}|${it.episode}`)) fail('I4b', 'withdrawn as dismissed with no dismissal')
          if (b.reason === 'dismissed' && it.reportId) mon.dismissedReports.add(`${sk}|${it.reportId}`)
          it.open = false
          it.state = 'closed'
          mon.stats.withdrawn += 1
          break
        }
        default:
          break
      }
      // I1: per-episode bounds, from this monitor's own count.
      if (it.counted > max) fail('I1a', `${it.counted} counted shows in one episode (max ${max})`)
      if (it.reminders > 2) fail('I1b', `${it.reminders} reminders in one episode`)
      if (it.returns > 1) fail('I1c', `${it.returns} returns in one episode`)
      if (it.shows > max + it.deferrals) fail('I1d', `${it.shows} shows exceed max ${max} plus ${it.deferrals} deferrals`)
      // ...and from the model's stored counters.
      if (b.shows_counted > max) fail('I1a', `stored shows_counted ${b.shows_counted} above max ${max}`)
      if (b.reminders_used > 2) fail('I1b', `stored reminders_used ${b.reminders_used}`)
      if (b.returns_used > 1) fail('I1c', `stored returns_used ${b.returns_used}`)
      if (b.presentation > b.shows_counted + it.deferrals) fail('I1d', `presentation ${b.presentation} above ${b.shows_counted} counted plus ${it.deferrals} deferrals`)
      break
    }
    case 'owner_ack': {
      const it = mon.items.get(b.item_id)
      if (b.phase === 'ack' && b.intent === 'dismiss') mon.ownerDismiss.add(`${b.item_id}|${b.episode}`)
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
    const qualifies = c.freshness === 'stale' && STALE_STATES.has(c.state)
    const hasInv = Boolean(c.report_id && mon.invReports.get(sk)?.has(c.report_id))
    const starved = qualifies && !hasInv
    // I7d: rechecks never consume the cycle budget.
    if (starved && cycles < budget) fail('I7d', `a stale session was left uninvestigated with cycle budget unused`)
    // I7e: a held trigger gets its first cycle within a bound.
    const n = starved ? (mon.starve.get(sk) ?? 0) + 1 : 0
    mon.starve.set(sk, n)
    if (n > mon.firstCycleBound) fail('I7e', `a stale session waited ${n} ticks for its first cycle`)
    // I7f: a stale report that stays unexplained is surfaced within a bound.
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
  // I3c: every investigation path that opened has closed by the end of its step.
  if (mon.openInv.size > 0) fail('I7g', `an investigation was left open after its tick`)
  // I2: at most one item active at any moment.
  const active = [...mon.items.values()].filter((it) => it.open && it.state === 'active')
  if (active.length > 1) fail('I2', `${active.length} items active at once (${active.map((a) => a.origin).join(', ')})`)
  // I4c: no item is dropped: the model's open set is exactly the account's.
  for (const it of mon.items.values()) {
    const m = h.ctx.state.items.get(it.id)
    if (it.open !== Boolean(m?.open)) fail('I4c', `item open=${it.open} in the ledger account but open=${Boolean(m?.open)} in the model`)
  }
  // I9: one report never has two open items (an owner block and an attention item).
  for (const it of h.ctx.state.items.values()) {
    if (!it.open || it.origin !== 'attention' || !it.session) continue
    const d = h.ctx.state.items.get(itemIds.declared(it.session))
    const rep = it.reportId ? mon.reports.get(it.reportId) : null
    if (d?.open && rep && isOwnerBlock(rep, mon.config)) fail('I9', `one owner-block report holds both an owner-block item and an attention item`)
  }
}
