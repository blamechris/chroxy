/**
 * A simulated set of sources and sessions for the freshness model's tests.
 *
 * This is the ground truth the model is checked against: who authored what
 * and when, whether a turn is really in flight, which prompts are pending.
 * The model never sees it directly; it sees only the reads `adapter()`
 * returns, which follow the design's adapter rules (host times, changed-at
 * time on the Chroxy-like source, decisions carried forward there, native
 * state only where the source's read carries it).
 *
 * Plain data, so a test can structuredClone() a world to explore a branch.
 */

import { sessionKey } from '../../../src/freshness/keys.js'

export const SOURCES = Object.freeze(['chroxy', 'codex', 'claude-desktop'])

export function createWorld() {
  return {
    sources: { chroxy: { up: true }, codex: { up: true }, 'claude-desktop': { up: true } },
    sessions: {},
    order: [],
    counter: 0,
  }
}

export function addSession(world, { source, native_id, incarnation = 't0', scope = null }) {
  const session = { source, native_id, incarnation }
  const sk = sessionKey(session)
  world.sessions[sk] = {
    sk,
    session,
    scope,
    listed: true,
    lines: [],
    current: null,
    relayed: null,
    turn: false,
    background: false,
    prompts: [],
    events: [],
    flaky: 0,
    blockedRead: false,
    untrusted: false,
  }
  world.order.push(sk)
  return sk
}

export function W(world, sk) {
  const w = world.sessions[sk]
  if (!w) throw new Error(`no such session ${sk}`)
  return w
}

function sameFields(a, b) {
  return (
    a.state === b.state &&
    a.next === b.next &&
    a.blocked_on === b.blocked_on &&
    a.decision === b.decision &&
    a.decision_basis === b.decision_basis &&
    a.owner === b.owner &&
    JSON.stringify(a.seed ?? null) === JSON.stringify(b.seed ?? null)
  )
}

/**
 * The session authors a status line at `at`. On the Chroxy-like source the
 * declaration is changed-at: an identical repeat changes nothing, and a line
 * that states no decision inherits the previous one (every report there is
 * `possibly_inherited`). Elsewhere every message is stamped by the host.
 */
export function author(world, sk, at, fields) {
  const w = W(world, sk)
  const chroxy = w.session.source === 'chroxy'
  const prev = w.current != null ? w.lines[w.current] : null
  let decision = fields.decision ?? null
  let basis = decision ? 'stated' : 'none'
  if (chroxy) {
    if (fields.decision === undefined && prev?.decision) decision = prev.decision
    basis = 'possibly_inherited'
  }
  const line = {
    at,
    state: fields.state,
    next: fields.next ?? null,
    blocked_on: fields.blocked_on ?? null,
    decision,
    decision_basis: basis,
    owner: fields.owner ?? null,
    seed: fields.seed ?? null,
  }
  w.relayed = null
  if (chroxy && prev && sameFields(prev, line)) return false
  w.lines.push(line)
  w.current = w.lines.length - 1
  return true
}

/** A token holder or a hook writes a declaration for the session (relayed). */
export function relayedWrite(world, sk, at, state) {
  W(world, sk).relayed = { at, state }
}

/** The session is rewound so that its latest line is an older one. */
export function rewind(world, sk, index) {
  const w = W(world, sk)
  if (index >= 0 && index < w.lines.length) w.current = index
}

export function raisePrompt(world, sk, at, ttlS = 300) {
  const w = W(world, sk)
  world.counter += 1
  const ref = `p${world.counter}`
  w.prompts.push({ ref, raised_at: at, deadline: at + ttlS * 1000, status: 'pending', at: null })
  return ref
}

export function answerPrompt(world, sk, ref, at) {
  const p = W(world, sk).prompts.find((x) => x.ref === ref)
  if (p && p.status === 'pending') {
    p.status = 'answered'
    p.at = at
    W(world, sk).events.push({ id: `${ref}:answered`, basis: 'permission_answered_by_owner', activity_at: at, ref })
  }
}

export function lapsePrompt(world, sk, ref, at) {
  const p = W(world, sk).prompts.find((x) => x.ref === ref)
  if (p && p.status === 'pending') {
    p.status = 'lapsed'
    p.at = at
    W(world, sk).events.push({ id: `${ref}:lapsed`, basis: 'permission_lapsed', activity_at: at, ref })
  }
}

export function turnStart(world, sk, at) {
  const w = W(world, sk)
  world.counter += 1
  w.turn = true
  w.events.push({ id: `e${world.counter}`, basis: 'open_turn_event_after_report', activity_at: at, ref: null })
}

export function turnEnd(world, sk, at) {
  const w = W(world, sk)
  world.counter += 1
  w.turn = false
  w.events.push({ id: `e${world.counter}`, basis: 'turn_ended_after_report', activity_at: at, ref: null })
}

function declaration(w) {
  const line = w.current != null ? w.lines[w.current] : null
  if (w.relayed && (!line || w.relayed.at > line.at)) return { relayed: true, at: w.relayed.at, state: w.relayed.state }
  return line ? { relayed: false, ...line } : null
}

function native(w) {
  return {
    turn_in_flight: w.turn,
    busy_background: w.background && !w.turn,
    answering_now: true,
    pending: w.prompts.filter((p) => p.status === 'pending').map((p) => ({ ref: p.ref, raised_at: p.raised_at, deadline: p.deadline })),
    events: w.events.slice(),
  }
}

function readOne(world, session) {
  const sk = sessionKey(session)
  const w = world.sessions[sk]
  if (!world.sources[session.source].up) return { outcome: 'error', error_code: 'unreachable' }
  if (!w || !w.listed) return { listed: false }
  if (w.flaky > 0) {
    w.flaky -= 1
    return { outcome: 'error', error_code: 'timeout' }
  }
  if (w.blockedRead) return { outcome: 'blocked', not_read_reason: 'credential_required' }
  const chroxy = session.source === 'chroxy'
  const d = declaration(w)
  const nat = chroxy ? native(w) : null
  if (!d) return { outcome: 'no_report', native: nat }
  return {
    outcome: 'ok',
    report: {
      declared_via: d.relayed ? 'api' : chroxy ? 'marker' : 'transcript',
      last_report_at: d.at,
      state: d.state,
      next: d.next ?? null,
      declared_blocked_on: d.blocked_on ?? null,
      decision: d.relayed ? null : d.decision,
      decision_basis: d.relayed ? 'none' : d.decision_basis,
      owner_named: d.owner ?? null,
      seed_ref: d.seed ?? null,
      time_trusted: !w.untrusted,
    },
    native: nat,
  }
}

/** The model-facing read interface over this world. */
export function adapter(world) {
  return {
    list(source) {
      if (!world.sources[source].up) return null
      return world.order
        .map((sk) => world.sessions[sk])
        .filter((w) => w.session.source === source && w.listed)
        .map((w) => ({ session: w.session, scope: source === 'claude-desktop' ? null : w.scope }))
    },
    read: (session) => readOne(world, session),
    reread: (session) => readOne(world, session),
    activity(session) {
      const w = world.sessions[sessionKey(session)]
      if (!world.sources[session.source].up) return { outcome: 'error', error_code: 'unreachable' }
      if (!w || !w.listed) return { outcome: 'error', error_code: 'unreachable' }
      return { outcome: 'ok', native: native(w) }
    },
  }
}

/** Ground truth: is anything explaining a stale line right now? */
export function explained(world, sk) {
  const w = W(world, sk)
  if (!world.sources[w.session.source].up || !w.listed) return true
  if (w.turn || w.background) return true
  if (w.prompts.some((p) => p.status === 'pending')) return true
  return false
}
