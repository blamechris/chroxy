/**
 * Generated event sequences over a handful of sessions and three sources,
 * with the invariant monitor checked after every step, crash/replay at random
 * points (some restarts coming back only in a later slot), and a closability
 * probe at the end.
 *
 * `runSequence(seed, opts)` is deterministic: the same seed and step count
 * give the same events, crashes and result. `shortestFailingPrefix()` finds
 * the smallest step count that still fails the same invariant, by simple
 * truncation.
 */

import { DEFAULT_CONFIG, cadenceSeconds } from '../model/config.js'
import { DEFAULT_POLICY, isOwnerBlock } from '../model/policy.js'
import { planConfig, restoreModel, run } from '../model/reconciler.js'
import { Crash, MIN, OWNER, T0, createHarness } from './harness.js'
import { InvariantError, checkStep, createMonitor } from './invariants.js'
import { mulberry32 } from './prng.js'
import * as Wd from './world.js'

// Shorter surfacing timings than the starting values in config.js make
// expiry, re-show and exhaustion reachable within a few hundred steps; the
// rules are the same, only the numbers move. Budgets of one stress the
// ordering rules; runSequence raises them on some seeds.
export const GEN_CONFIG = Object.freeze({
  per_source: { chroxy: 15, codex: 30, 'claude-desktop': 40 },
  investigation_budget_per_tick: 1,
  recheck_budget_per_tick: 1,
  surface: { reminder_after_minutes: [30, 90], item_time_limit_hours: 2, max_presentations: 2 },
})

const WORDINGS = ['approve the merge', 'approve the merge (1h)', 'approve the merge (2h)', 'review the plan']
const NEXTS = ['continue', 'run the suite', 'write the fix']
const MAX_SESSIONS = 7
// The share of crashed ticks whose restart comes back in a later slot.
const LATER_SLOT = 0.35

function lineKind(rng, w, now) {
  const kind = rng.weighted([
    ['running', 5], ['idle', 2], ['done', 1], ['owner', 4], ['ci', 2], ['stalled', 1],
    ['running_decision', 1], ['blocked_decision', 1], ['seed', 1], ['unknown', 1],
  ])
  switch (kind) {
    case 'running': return { state: 'running', next: rng.pick(NEXTS) }
    case 'idle': return { state: 'idle', decision: w.session.source === 'chroxy' ? undefined : null }
    case 'done': return { state: 'done' }
    case 'owner': return { state: 'blocked', blocked_on: rng.pick(WORDINGS), owner: OWNER }
    case 'ci': return { state: 'blocked', blocked_on: 'waiting on CI' }
    case 'stalled': return { state: 'stalled', blocked_on: 'the job failed' }
    case 'running_decision': return { state: 'running', decision: 'pick A or B' }
    case 'blocked_decision': return { state: 'blocked', blocked_on: 'needs a call', decision: 'pick A or B' }
    case 'seed': return { state: 'idle', seed: { scope: w.scope ?? 'scope-none', session: w.session.native_id, written_at: now } }
    default: return { state: 'unknown' }
  }
}

function initialWorld({ perSessionIds }) {
  const world = Wd.createWorld({ perSessionIds })
  Wd.addSession(world, { source: 'chroxy', native_id: 'c1', scope: 'repo-a' })
  Wd.addSession(world, { source: 'chroxy', native_id: 'c2', scope: 'repo-b' })
  Wd.addSession(world, { source: 'codex', native_id: 'x1', scope: 'repo-a' })
  Wd.addSession(world, { source: 'claude-desktop', native_id: 'd1', scope: 'repo-c' })
  return world
}

/** Draw the next event (as data) from the generator's state. */
function drawEvent(rng, g, h) {
  const world = h.world
  const sks = world.order
  const sk = rng.pick(sks)
  const w = world.sessions[sk]
  const now = g.now
  const kind = rng.weighted([
    ['tick', 30], ['advance', 6], ['author', 12], ['reword', 4], ['reauthor', 3],
    ['turn_start', 4], ['turn_end', 4], ['turn_error', 2], ['background', 2],
    ['prompt', 3], ['answer', 2], ['lapse', 2], ['relayed', 1], ['rewind', 1],
    ['drop', 1], ['relist', 1.5], ['outage', 1], ['recover', 2], ['flaky', 1], ['spawn', 0.5],
    ['owner_done', 4], ['owner_defer', 2], ['owner_dismiss', 2], ['quiet', 1.5],
    ['die', 1.5], ['blocked_read', 0.6], ['untrusted', 0.6], ['future_line', 0.6],
    ['source_skew', 0.5], ['answering', 0.6], ['flicker', 0.8], ['config', 0.4],
    ['prompt_round', 0.6],
  ])
  switch (kind) {
    case 'tick': {
      const src = Object.keys(g.nextSlot).sort((a, b) => g.nextSlot[a] - g.nextSlot[b])[0]
      const at = Math.max(now, g.nextSlot[src]) + rng.int(0, 60) * 1000
      return { kind, source: src, at, crash: rng.chance(0.12) ? rng.int(0, 30) : null, crash2: rng.chance(0.3) ? rng.int(0, 30) : null, replayDelay: rng.chance(0.5) ? rng.int(1, 300) * 1000 : 0 }
    }
    case 'advance': return { kind, ms: rng.int(5, 150) * MIN }
    // A quiet stretch: many ticks in a row with nothing changing in the world.
    case 'quiet': return { kind, ticks: rng.int(6, 16) }
    case 'die': case 'blocked_read': case 'untrusted': case 'flicker':
      return { kind, sk }
    // A host clock ahead: the line is stamped later than the reconciler's now.
    case 'future_line': return { kind, sk, aheadMs: rng.int(3, 30) * MIN, fields: lineKind(rng, w, now) }
    case 'source_skew': return { kind, source: rng.pick(Wd.SOURCES) }
    case 'answering': return { kind, source: 'chroxy' }
    case 'config': return { kind, which: rng.pick(['max_presentations', 'running_stale_after']) }
    case 'author': return { kind, sk, fields: lineKind(rng, w, now) }
    case 'reword': return { kind, sk, wording: rng.pick(WORDINGS) }
    case 'reauthor': return { kind, sk }
    case 'turn_start': case 'turn_end': case 'turn_error': case 'background': case 'drop': case 'relist': case 'flaky':
      return { kind, sk }
    case 'prompt': return { kind, sk: rng.pick(sks.filter((x) => world.sessions[x].session.source === 'chroxy')) }
    // Owner-block cycles in a row on one session: a prompt raised, a tick,
    // the owner's answer, a tick, repeated.
    case 'prompt_round': return { kind, sk: rng.pick(sks.filter((x) => world.sessions[x].session.source === 'chroxy')), rounds: rng.int(2, 4) }
    case 'answer': case 'lapse': {
      const pend = sks.flatMap((x) => world.sessions[x].prompts.filter((p) => p.status === 'pending').map((p) => [x, p.ref]))
      if (pend.length === 0) return { kind: 'noop' }
      const [psk, ref] = rng.pick(pend)
      return { kind, sk: psk, ref }
    }
    case 'relayed': return { kind, sk: rng.pick(sks.filter((x) => world.sessions[x].session.source === 'chroxy')), state: 'running' }
    case 'rewind': return { kind, sk, index: w.lines.length ? rng.int(0, w.lines.length - 1) : 0 }
    case 'outage': case 'recover': return { kind, source: rng.pick(Wd.SOURCES) }
    case 'spawn': return { kind, source: rng.pick(['chroxy', 'codex']), scope: rng.pick(['repo-a', 'repo-b', 'repo-c']) }
    default: {
      // Owner actions: mostly on the active item, sometimes on any open item.
      const open = [...h.ctx.state.items.values()].filter((i) => i.open)
      if (open.length === 0) return { kind: 'noop' }
      const active = open.find((i) => i.state === 'active')
      const target = active && rng.chance(0.8) ? active : rng.pick(open)
      g.ack += 1
      const intent = kind === 'owner_done' ? 'done' : kind === 'owner_defer' ? 'defer' : 'dismiss'
      return { kind: 'owner', itemId: target.itemId, intent, ackRef: `m${g.ack}`, until: intent === 'defer' ? now + rng.int(20, 240) * MIN : null, crash: rng.chance(0.1) ? rng.int(0, 6) : null }
    }
  }
}

function applyWorld(g, h, ev) {
  const world = h.world
  const now = g.now
  const w = ev.sk ? world.sessions[ev.sk] : null
  switch (ev.kind) {
    case 'advance': g.now += ev.ms; break
    case 'author': Wd.author(world, ev.sk, now, ev.fields); break
    case 'reword': {
      const cur = w.current != null ? w.lines[w.current] : null
      if (cur) Wd.author(world, ev.sk, now, { state: cur.state, next: cur.next, blocked_on: ev.wording, owner: cur.owner, decision: w.session.source === 'chroxy' ? undefined : cur.decision })
      break
    }
    case 'reauthor': {
      const cur = w.current != null ? w.lines[w.current] : null
      if (cur) Wd.author(world, ev.sk, now, { state: cur.state, next: cur.next, blocked_on: cur.blocked_on, owner: cur.owner, decision: w.session.source === 'chroxy' ? undefined : cur.decision, seed: cur.seed })
      break
    }
    case 'turn_start': if (!w.turn) Wd.turnStart(world, ev.sk, now); break
    case 'turn_end': if (w.turn) { Wd.turnEnd(world, ev.sk, now); Wd.author(world, ev.sk, now, { state: 'running', next: 'continue' }) } break
    case 'turn_error': if (w.turn) Wd.turnEnd(world, ev.sk, now); break
    case 'background': w.background = !w.background; break
    case 'prompt': Wd.raisePrompt(world, ev.sk, now); break
    case 'answer': Wd.answerPrompt(world, ev.sk, ev.ref, now); break
    case 'lapse': Wd.lapsePrompt(world, ev.sk, ev.ref, now); break
    case 'relayed': Wd.relayedWrite(world, ev.sk, now, ev.state); break
    case 'rewind': Wd.rewind(world, ev.sk, ev.index); break
    case 'drop': w.listed = false; break
    case 'relist': w.listed = true; break
    case 'outage': world.sources[ev.source].up = false; break
    case 'recover': world.sources[ev.source].up = true; break
    case 'flaky': w.flaky = 2; break
    case 'die': if (w.turn) Wd.dieMidTurn(world, ev.sk); break
    case 'blocked_read': w.blockedRead = !w.blockedRead; break
    case 'untrusted': w.untrusted = !w.untrusted; break
    case 'flicker': w.flickerDrop = true; break
    case 'future_line': Wd.author(world, ev.sk, now + ev.aheadMs, ev.fields); break
    case 'source_skew': world.sources[ev.source].clockOffsetMs = world.sources[ev.source].clockOffsetMs ? 0 : 15 * MIN; break
    case 'answering': world.sources[ev.source].answering = !world.sources[ev.source].answering; break
    case 'spawn': {
      if (world.order.length >= MAX_SESSIONS) break
      g.spawned += 1
      const nsk = Wd.addSession(world, { source: ev.source, native_id: `n${g.spawned}`, scope: ev.scope })
      Wd.author(world, nsk, now, { state: 'running', next: 'start' })
      break
    }
    default: break
  }
}

function runStep(g, h, mon, ev) {
  h.now = Math.max(h.now, g.now)
  if (ev.kind === 'tick') {
    g.now = Math.max(g.now, ev.at)
    const cad = cadenceSeconds(h.ctx.state.config, ev.source) * 1000
    const slotStart = Math.floor(g.now / cad) * cad
    g.nextSlot[ev.source] = slotStart + cad
    const attempt = (crashAfter, at) => h.tick(ev.source, at, { crashAfter, slotStart })
    let at = g.now
    if (ev.crash != null) {
      try {
        attempt(ev.crash, at)
      } catch (e) {
        if (!(e instanceof Crash)) throw e
        mon.stats.crashes += 1
        checkStep(mon, h, { complete: false })
        h.restart()
        // Some restarts come back only after the slot has passed: the crashed
        // tick is never replayed, and the source's next tick, in a later
        // slot, is the next to run. Chosen from a separate stream, so a
        // seed's events are unchanged up to its first such restart.
        if (g.restarts.chance(LATER_SLOT)) {
          g.pending.add(ev.source)
          mon.stats.laterSlot = (mon.stats.laterSlot ?? 0) + 1
          return
        }
        at = g.now + ev.replayDelay
        if (ev.crash2 != null) {
          try {
            attempt(ev.crash2, at)
          } catch (e2) {
            if (!(e2 instanceof Crash)) throw e2
            mon.stats.crashes += 1
            checkStep(mon, h, { complete: false })
            h.restart()
          }
        }
      }
    }
    attempt(Infinity, at)
    g.now = at
    g.pending.delete(ev.source)
    return
  }
  if (ev.kind === 'quiet') {
    for (let k = 0; k < ev.ticks; k++) {
      const src = Object.keys(g.nextSlot).sort((a, b) => g.nextSlot[a] - g.nextSlot[b])[0]
      runStep(g, h, mon, { kind: 'tick', source: src, at: Math.max(g.now, g.nextSlot[src]), crash: null })
      checkStep(mon, h, { complete: g.pending.size === 0 })
    }
    return
  }
  if (ev.kind === 'prompt_round') {
    for (let k = 0; k < ev.rounds; k++) {
      const ref = Wd.raisePrompt(h.world, ev.sk, g.now)
      for (const answer of [false, true]) {
        if (answer) Wd.answerPrompt(h.world, ev.sk, ref, g.now)
        runStep(g, h, mon, { kind: 'tick', source: 'chroxy', at: Math.max(g.now, g.nextSlot.chroxy), crash: null })
        checkStep(mon, h, { complete: g.pending.size === 0 })
      }
    }
    return
  }
  if (ev.kind === 'config') {
    const cur = structuredClone(h.ctx.state.config)
    if (ev.which === 'max_presentations') cur.surface.max_presentations = cur.surface.max_presentations === 2 ? 3 : 2
    else cur.freshness.running.stale_after_s = cur.freshness.running.stale_after_s === 2700 ? 3600 : 2700
    run(h.ctx, planConfig(h.ctx, { config: cur, now: g.now }))
    return
  }
  if (ev.kind === 'owner') {
    if (ev.crash != null) {
      try {
        h.owner(ev.itemId, ev.intent, ev.ackRef, { at: g.now, until: ev.until, crashAfter: ev.crash })
      } catch (e) {
        if (!(e instanceof Crash)) throw e
        mon.stats.crashes += 1
        checkStep(mon, h, { complete: false })
        h.restart()
      }
    }
    h.owner(ev.itemId, ev.intent, ev.ackRef, { at: g.now, until: ev.until })
    return
  }
  applyWorld(g, h, ev)
  h.now = Math.max(h.now, g.now)
}

/** Supply each open item's closing evidence on a copy of the run, and check it closes. */
export function probeClosable(h, policy) {
  const items = [...h.ctx.state.items.values()].filter((i) => i.open)
  for (const it of items) {
    const p = createHarness({ config: GEN_CONFIG, policy, world: structuredClone(h.world), now: h.now })
    p.ctx = restoreModel({ ledgerId: h.ctx.ledger.ledgerId, records: h.ctx.ledger.records, policy })
    p.policy = policy
    const world = p.world
    // After every time in the world, so the evidence is the newest line even
    // when a host clock ran ahead.
    let now = Math.max(h.now, ...Object.values(world.sessions).flatMap((w) => w.lines.map((l) => l.at))) + MIN
    const sources = new Set()
    const readableSource = (src) => {
      world.sources[src].up = true
      world.sources[src].clockOffsetMs = 0
      world.sources[src].answering = true
      sources.add(src)
    }
    const ensureReadable = (sk) => {
      const w = world.sessions[sk]
      readableSource(w.session.source)
      w.listed = true
      w.flaky = 0
      w.blockedRead = false
      w.untrusted = false
      w.flickerDrop = false
    }
    const nonOwnerLine = (sk) => {
      // The weakest closing evidence: still blocked, but on something that is
      // not the owner. On the Chroxy-like source an earlier decision would be
      // inherited and keep it an owner block, so there a running line is used.
      const w = world.sessions[sk]
      const probe = { state: 'blocked', declared_blocked_on: 'waiting on CI', decision: w.session.source === 'chroxy' ? (w.lines[w.current]?.decision ?? null) : null, decision_basis: w.session.source === 'chroxy' ? 'possibly_inherited' : 'none' }
      // The evidence line must differ from the current one: on a changed-at
      // source an identical line is not a new report.
      if (isOwnerBlock(probe, p.config)) Wd.author(world, sk, now, { state: 'running', next: 'closing evidence' })
      else Wd.author(world, sk, now, { state: 'blocked', blocked_on: 'waiting on CI', next: 'closing evidence', decision: w.session.source === 'chroxy' ? undefined : null })
    }
    switch (it.origin) {
      case 'attention':
        ensureReadable(it.sk)
        nonOwnerLine(it.sk)
        break
      case 'owner': {
        // Every live ask's own evidence: a line that is no owner block for the
        // declared ask; for the prompt ask, an owner answer to the latest
        // prompt, or, if that prompt already lapsed, the lapse path (nothing
        // pending and a newer report).
        ensureReadable(it.sk)
        if (it.asks.has('declared')) nonOwnerLine(it.sk)
        if (it.asks.has('prompt')) {
          const w = world.sessions[it.sk]
          const latest = w.prompts.slice().sort((a, b) => a.raised_at - b.raised_at).pop()
          for (const x of w.prompts.filter((y) => y.status === 'pending')) Wd.answerPrompt(world, it.sk, x.ref, now)
          if ((!latest || latest.status === 'lapsed') && !it.asks.has('declared')) Wd.author(world, it.sk, now + 1000, { state: 'running', next: 'closing evidence' })
        }
        break
      }
      case 'gone':
        ensureReadable(it.sk)
        break
      case 'outage':
        for (const sk of world.order) if (world.sessions[sk].session.source === it.source) ensureReadable(sk)
        readableSource(it.source)
        break
      case 'seed': {
        const nsk = Wd.addSession(world, { source: 'chroxy', native_id: `probe-${it.itemId.slice(0, 6)}`, scope: it.seed.scope })
        Wd.author(world, nsk, now, { state: 'running', next: 'start' })
        ensureReadable(nsk)
        ensureReadable(it.sk)
        break
      }
      default:
        break
    }
    for (let round = 0; round < 2; round++) {
      for (const src of [...sources].sort()) {
        const cad = cadenceSeconds(p.ctx.state.config, src) * 1000
        now += cad
        p.tick(src, now)
      }
    }
    const after = p.ctx.state.items.get(it.itemId)
    if (after.open && after.episode === it.episode) {
      throw new InvariantError('I4a', `an open ${it.origin} item in state '${it.state}' did not close when its closing evidence was supplied`)
    }
  }
}

/**
 * Run one generated sequence. Returns { ok, stats } or
 * { ok: false, error, step, events }.
 */
/** Per-seed variation of the run's setup, drawn before any event. */
function seedSetup(rng, base) {
  const config = { ...base }
  if (rng.chance(0.4)) config.investigation_budget_per_tick = rng.int(2, 3)
  if (rng.chance(0.4)) config.recheck_budget_per_tick = rng.int(2, 3)
  if (rng.chance(0.3)) config.sources = { ...DEFAULT_CONFIG.sources, 'claude-desktop': { ...DEFAULT_CONFIG.sources['claude-desktop'], can_confirm_gone: false } }
  return { config, perSessionIds: rng.chance(0.5) }
}

/**
 * opts.fault: test-only hooks for proving structural checks can fail:
 *   { dropAppend(draft) -> bool, rewriteAppend(draft) -> draft, afterStep(h, i) }
 */
export function runSequence(seed, { steps = 150, policy = DEFAULT_POLICY, probe = true, config: baseConfig = GEN_CONFIG, fault = null } = {}) {
  const rng = mulberry32(seed)
  const { config, perSessionIds } = seedSetup(rng, baseConfig)
  const h = createHarness({ config, policy, world: initialWorld({ perSessionIds }) })
  // `pending`: sources whose crashed tick was not replayed and whose next
  // tick has not yet run; until it has, the tick's work is unfinished, so
  // only the checks that hold mid-tick are made.
  const g = { now: T0, nextSlot: { chroxy: T0, codex: T0, 'claude-desktop': T0 }, ack: 0, spawned: 0, restarts: mulberry32(seed ^ 0x5bd1e995), pending: new Set() }
  const perSource = 4
  // Bounds for the worst case, a cycle budget of one; a larger budget only
  // makes the real wait shorter.
  const mon = createMonitor({
    config: h.ctx.state.config,
    firstCycleBound: perSource + 1,
    surfaceBound: 2 * (perSource + 1) + 2,
  })
  if (fault?.dropAppend) h.dropAppend = fault.dropAppend
  if (fault?.rewriteAppend) h.rewriteAppend = fault.rewriteAppend
  const events = []
  let i = 0
  try {
    for (; i < steps; i++) {
      const ev = drawEvent(rng, g, h)
      events.push(ev)
      runStep(g, h, mon, ev)
      fault?.afterStep?.(h, i)
      checkStep(mon, h, { complete: g.pending.size === 0 })
    }
    if (probe) probeClosable(h, policy)
  } catch (e) {
    if (!(e instanceof InvariantError)) {
      e.message = `seed ${seed} step ${i}: ${e.message}`
      throw e
    }
    return { ok: false, error: e, step: i, events, seed, harness: h }
  }
  return { ok: true, stats: mon.stats, records: h.ctx.ledger.records.length, events, harness: h }
}

/** The smallest step count (by truncation) that still fails with the same invariant id. */
export function shortestFailingPrefix(seed, failure, opts = {}) {
  for (let n = 1; n <= failure.step + 1; n++) {
    const r = runSequence(seed, { ...opts, steps: n })
    if (!r.ok && r.error.id === failure.error.id) return { steps: n, events: r.events, error: r.error }
  }
  return { steps: failure.step + 1, events: failure.events, error: failure.error }
}

export function describe(events) {
  return events.map((e, i) => `${i}: ${JSON.stringify(e)}`).join('\n')
}
