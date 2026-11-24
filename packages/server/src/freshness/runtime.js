/**
 * The driver half of the freshness model: a model context, the `run` loop
 * that executes a planner against it, the configuration record and the list
 * of sessions a tick tracks.
 *
 * A model context is `{ ledger, state, policy }`: the ledger is the durable
 * part, `state` is derived from it (derive.js) and is discarded on a restart,
 * and `policy` is the rule set (policy.js). Planners are generators that
 * yield operations; `run()` executes them against the context. Every
 * outward effect is an operation the driver hands to the caller's `deliver`
 * function; the code here performs none.
 *
 * This is the one implementation. The model tests (tests/freshness) and the
 * file-backed reconciler (core.js) both import it.
 */

import { canonical, H } from './hash.js'
import { deriveState, foldRecord, sessionsOf } from './derive.js'
import { put } from './checks.js'
import { append, createLedger, loadLedger } from './ledger.js'
import { DEFAULT_POLICY } from './policy.js'
import { configKey, sessionKey } from './keys.js'

/** A fresh model context. */
export function createModel({ ledgerId, policy = DEFAULT_POLICY }) {
  const ledger = createLedger({ ledgerId })
  return { ledger, state: deriveState([], policy), policy }
}

/**
 * Rebuild a context from ledger records alone, as after a crash: the
 * ledger's index and every derived value are recomputed; nothing survives
 * from the previous process.
 */
export function restoreModel({ ledgerId, records, policy = DEFAULT_POLICY }) {
  const ledger = loadLedger({ ledgerId, records: records.slice() })
  return { ledger, state: deriveState(ledger.records, policy), policy }
}

/**
 * Execute a planner against a context. `deliver(effect)` performs a send
 * and returns 'delivered' or 'failed'. Returns { sends, value }.
 *
 * `appendRecord(draft, at)` is the one place a record is written. It
 * defaults to the in-memory ledger; the file-backed reconciler passes one
 * that also makes the record durable.
 */
export function run(ctx, gen, { deliver = () => 'delivered', appendRecord = (draft, at) => append(ctx.ledger, draft, at) } = {}) {
  const sends = []
  let res = gen.next()
  while (!res.done) {
    const op = res.value
    let reply
    if (op.op === 'append') {
      reply = appendRecord(op.record, op.at)
      if (reply.record) foldRecord(ctx.state, reply.record)
    } else if (op.op === 'send') {
      sends.push(op.effect)
      reply = deliver(op.effect)
    } else {
      throw new Error(`run: unknown op ${op.op}`)
    }
    res = gen.next(reply)
  }
  return { sends, value: res.value }
}

/** Plan a configuration record. The full values are stored (the DESIGN-GAP note below). */
export function* planConfig(ctx, { config, now }) {
  const st = ctx.state
  const configHash = H(config)
  const previous = st.lastConfigId
  const id = configKey(previous, configHash)
  if (st.index.has(id)) return { configRef: st.configRef }
  const configRef = 'cfg_' + configHash.slice(0, 12)
  const prevValues = st.config
  const changed = prevValues ? Object.keys(config).filter((k) => canonical(config[k]) !== canonical(prevValues[k])) : Object.keys(config)
  yield put(
    {
      kind: 'config',
      id,
      body: {
        config_ref: configRef,
        previous_config_ref: st.configRef,
        config_hash: configHash,
        changed_fields: changed,
        // DESIGN-GAP: the `config` body carries only a hash and the names of
        // the changed fields, so the thresholds a check was graded under are
        // not derivable from the ledger alone. The model stores the values.
        values: config,
      },
    },
    now,
  )
  return { configRef }
}

/**
 * The sessions a tick of `source` reads: every session the ledger already
 * tracks plus every session the source lists now, in key order. A tracked
 * session the source no longer lists is `listed: false`; when the source
 * cannot be listed at all (`list` returned null) `listed` is null and the
 * session is read anyway, so the read reports the failure.
 */
export function trackedSessions(ctx, source, world) {
  const listed = world.list(source)
  const out = new Map()
  for (const s of sessionsOf(ctx.state, source)) out.set(s.sk, { session: s.session, scope: s.scope, listed: listed == null ? null : false })
  if (listed) {
    for (const e of listed) out.set(sessionKey(e.session), { session: e.session, scope: e.scope ?? null, listed: true })
  }
  return [...out.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1)).map(([, v]) => v)
}
