/**
 * The reconciler core: ticks over read-only adapters, written to a file
 * ledger.
 *
 * One tick of one source opens a `tick` record, reads every session the source
 * lists and every session the ledger already tracks, turns each read into at
 * most one `report`, any `activity` records and one `check` (the model's
 * `planRead`), and closes the tick. Freshness is graded by the model's
 * `gradeRead` from the report's age at the check time; an adapter reports
 * what it found and never grades.
 *
 * It runs the bounded stale investigation of each tick (investigation.js),
 * which reads through the adapter and records what it found. It keeps no
 * queue, delivers nothing and talks to no live source: the adapters it is given decide
 * what it reads, and nothing it holds can send. It opens no credential store,
 * holds no secret and makes no network call; its only I/O is the ledger
 * directory it is given and whatever the adapters read.
 *
 * Source capabilities: `coreConfig` adds the state-file source to the model's
 * configuration. A configuration is stored in the ledger as a `config`
 * record, and every check names the one it was graded under.
 */

import path from 'node:path'
import { sourceCaps, cadenceSeconds, makeConfig } from './config.js'
import { deriveState, sessionsOf } from './derive.js'
import { planRead, put } from './checks.js'
import { planInvestigations } from './investigation.js'
import { DEFAULT_POLICY } from './policy.js'
import { checkTickKey, systemKey, tickId as makeTickId, tickKey } from './keys.js'
import { DEFAULT_LEASE_MS, openFileLedger } from './file-ledger.js'
import { planConfig, run, trackedSessions } from './runtime.js'
import { H } from './hash.js'
import { safeList, safeRead, sealAdapter } from './adapter.js'
import { STATE_FILE_CAPS, STATE_FILE_SOURCE } from './state-file-adapter.js'
import { REGISTRY_CAPS, REGISTRY_SOURCE } from './session-registry-adapter.js'
import { createExchange, writeToOutbox, planExchange } from './exchange.js'

/** The model's configuration with the state-file and session-registry sources' capabilities added. */
export function coreConfig(overrides = {}) {
  const { sources, ...rest } = overrides
  return makeConfig({ ...rest, sources: { [STATE_FILE_SOURCE]: STATE_FILE_CAPS, [REGISTRY_SOURCE]: REGISTRY_CAPS, ...(sources ?? {}) } })
}

/**
 * Plan one tick of one source against a sealed adapter. A generator of
 * operations for `run`, as the model's planners are.
 */
export function* planCoreTick(ctx, { source, slotStart, now, adapter }) {
  const st = ctx.state
  if (!st.config) throw new Error('planCoreTick: no configuration in the ledger')
  if (adapter.source !== source) throw new Error(`planCoreTick: adapter reads ${adapter.source}, not ${source}`)
  const tid = makeTickId(ctx.ledger.ledgerId, source, slotStart)
  if (st.ticks.get(tid)?.closed) return { skipped: 'closed', tickId: tid }
  const cad = cadenceSeconds(st.config, source) * 1000
  const last = st.lastClosedTick.get(source)
  const missed = last ? Math.max(0, Math.round((slotStart - last.slot) / cad) - 1) : 0
  const openBody = { tick_id: tid, source, slot_start: slotStart, phase: 'open', cadence_minutes: cad / 60000, config_ref: st.configRef, fence: null, missed_slots: missed }
  yield put({ kind: 'tick', id: tickKey(tid, 'open'), refs: { tick: tid }, body: openBody }, now)
  const tickOpenSeq = st.ticks.get(tid).openSeq

  const listing = safeList(adapter)
  if (listing === null) {
    // The source cannot be listed. Say so in the ledger even when no session
    // is tracked yet, so an unreadable source never looks like an empty one.
    yield put({ kind: 'system', id: systemKey('source_unreadable', [tid]), body: { event: 'source_unreadable', detail: { ids: [tid], source } } }, now)
  }
  // What an investigation may read: the sealed adapter's `read`, and nothing
  // else. A separate activity read is the same read with its report ignored.
  const world = { list: () => listing, reread: (session, at) => safeRead(adapter, session, at), activity: (session, at) => safeRead(adapter, session, at) }
  for (const t of trackedSessions(ctx, source, world)) {
    const key = checkTickKey(tid, t.session)
    if (ctx.policy.reuseRecorded(st.index, key, 'check')) continue
    const read = t.listed === false ? { listed: false } : safeRead(adapter, t.session, now)
    yield* planRead(ctx, { key, trigger: 'tick', session: t.session, read, now, tickId: tid, scope: t.scope })
  }

  // Bounded, read-only investigation of stale sessions. Its signals go to the
  // owner queue when the reconciler has an exchange (exchange.js); without one
  // the decision is only in its close record.
  const inv = yield* planInvestigations(ctx, { source, tickId: tid, now, world })
  if (ctx.exchange) yield* planExchange(ctx, ctx.exchange, { source, tickId: tid, now, signals: inv.signals, tickOpenSeq })
  const closeBody = {
    ...openBody,
    phase: 'close',
    sessions: sessionsOf(st, source).length,
    checks: [...st.checks.values()].filter((c) => c.tickId === tid && c.body.trigger === 'tick').length,
    new_reports: [...st.reports.values()].filter((r) => r.seq > tickOpenSeq && r.body.source === source).length,
    source_listed: listing !== null,
    investigations: [...st.investigations.values()].filter((i) => i.tickId === tid).length,
    source_all_failed: inv.srcHeld,
    source_onset: inv.srcOnset,
  }
  yield put({ kind: 'tick', id: tickKey(tid, 'close'), refs: { tick: tid }, body: closeBody }, now)
  return { tickId: tid }
}

/** The core delivers nothing: a planner that yields a send is a fault, not a no-op. */
function refuseDelivery() {
  throw new Error('the reconciler core cannot deliver')
}

/** The longest tick cadence the configuration allows, in ms. */
function longestCadenceMs(config) {
  const sources = new Set([...Object.keys(config.sources ?? {}), ...Object.keys(config.per_source ?? {})])
  return Math.max(cadenceSeconds(config, ''), ...[...sources].map((s) => cadenceSeconds(config, s))) * 1000
}

/**
 * Open a reconciler over a file ledger. Takes the ledger's writer lock, so a
 * second reconciler on the same directory throws `LedgerHeldError` here.
 * Call `close()` to release it.
 *
 * @param {object} opts
 * @param {string} opts.dir           ledger directory
 * @param {string} opts.ledgerId
 * @param {object} opts.config        a `coreConfig(...)`
 * @param {object[]} opts.adapters    read-only adapters (adapter.js); sealed here
 * @param {number} opts.now           time of the open, ms
 * @param {object} [opts.policy]
 * @param {string[]} [opts.keepOutOf] directories the ledger must not be in or under
 * @param {string} [opts.exchangeDir] absolute directory of the outbox, receipts and acknowledgement files; with it the owner queue runs (exchange.js)
 * @param {object} [opts.guard]       writer guard, for tests
 * @param {number} [opts.leaseMs]     must exceed the longest tick cadence; default is twice it, at least 15 minutes
 */
export function openReconciler({ dir, ledgerId, config, adapters, now, policy = DEFAULT_POLICY, guard, leaseMs, keepOutOf, pid, host, isAlive, exchangeDir }) {
  // The lease must outlast a tick interval, or a holder between ticks looks silent.
  const cadenceMs = longestCadenceMs(config)
  if (leaseMs === undefined) leaseMs = Math.max(DEFAULT_LEASE_MS, 2 * cadenceMs)
  else if (!(leaseMs > cadenceMs)) throw new TypeError(`openReconciler: leaseMs (${leaseMs}) must exceed the longest tick cadence (${cadenceMs} ms)`)
  if (exchangeDir !== undefined && path.resolve(exchangeDir) === path.resolve(dir)) throw new TypeError('openReconciler: exchangeDir must not be the ledger directory')
  const sealed = new Map()
  for (const a of adapters) {
    const s = sealAdapter(a)
    if (sealed.has(s.source)) throw new Error(`two adapters for source ${s.source}`)
    if (config.sources?.[s.source] === undefined) throw new Error(`the configuration has no capabilities for source ${s.source}`)
    sealed.set(s.source, s)
  }
  const handle = openFileLedger({ dir, ledgerId, now, guard, leaseMs, keepOutOf, pid, host, isAlive })
  const ctx = { ledger: handle.ledger, state: deriveState(handle.ledger.records, policy), policy }
  // With an exchange directory the owner queue runs and its shows go to the outbox file there.
  if (exchangeDir !== undefined) ctx.exchange = createExchange({ dir: exchangeDir })
  const appendRecord = (draft, at) => handle.append(draft, at)
  try {
    // A config record is keyed by the one before it, so the same configuration
    // registered again would be a new record each time. It is written only when it changed.
    if (!(ctx.state.config && H(ctx.state.config) === H(config))) run(ctx, planConfig(ctx, { config, now }), { appendRecord })
  } catch (err) {
    handle.close()
    throw err
  }
  return {
    ctx,
    handle,
    sourceCaps: (source) => sourceCaps(ctx.state.config, source),
    /**
     * One tick of one source. Returns `{ tickId, skipped?, reads }` where
     * `reads` has one entry per session checked: the source, the check time,
     * the report time, the state and the graded freshness.
     */
    tick({ source, slotStart, now: at }) {
      const adapter = sealed.get(source)
      if (!adapter) throw new Error(`no adapter for source ${source}`)
      const { value } = run(ctx, planCoreTick(ctx, { source, slotStart, now: at, adapter }), { appendRecord, deliver: ctx.exchange ? (effect) => writeToOutbox(ctx, ctx.exchange, effect) : refuseDelivery })
      const reads = [...ctx.state.checks.values()]
        .filter((c) => c.tickId === value.tickId && c.body.trigger === 'tick')
        .map((c) => ({
          source: c.body.source,
          session: ctx.state.sessions.get(c.sk).session.native_id,
          checked_at: c.body.checked_at,
          last_report_at: c.body.last_report_at,
          state: c.body.state,
          freshness: c.body.freshness,
          freshness_reason: c.body.freshness_reason,
          error_code: c.body.error_code,
        }))
      return { ...value, reads }
    },
    close: () => handle.close(),
  }
}
