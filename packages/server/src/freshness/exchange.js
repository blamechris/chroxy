/**
 * The exchange: how the owner queue talks to a consumer through files, with
 * no channel of its own. One directory holds three files.
 *
 *   outbox.jsonl    written here: what to show (schema in outbox.js)
 *   receipts.jsonl  written by the consumer: what became of each delivery
 *   acks.jsonl      written by the consumer: what the operator said
 *
 * Receipts, one JSON object per line:
 *   { "v": 1, "key": <32 hex>, "rec": <32 hex>, "outcome": "delivered" | "failed" | anything else }
 * `rec` is the outbox line delivered and `key` its key. Any other outcome is
 * unclear: the message is recorded as "delivery not confirmed" and is never
 * delivered again. The first receipt for a line stands.
 *
 * Acknowledgements and deferrals, one JSON object per line:
 *   { "v": 1, "key": <32 hex>, "rec": <32 hex>, "intent": "done" | "dismiss" | "defer", "until": <ms>, "at": <ms> }
 * `until` is for "defer" only and is required there; `at` is optional and
 * only makes two otherwise identical lines different. `rec` is the outbox line
 * the operator answers. These are what the operator said, not what is true:
 *
 *  - one that names anything but the item's currently delivered message, or an
 *    item that is not open, is ignored and recorded;
 *  - "done" closes nothing: the item waits as acknowledged, and the next tick's
 *    own evidence closes it, or, if it disagrees, an alert item is written and
 *    the item stays open;
 *  - a deferral longer than `surface.defer_max_minutes`, past
 *    `surface.defer_max_count` for the item's episode, not in the future, or on
 *    an item that is not waiting for an answer, is refused and recorded;
 *  - every acknowledgement, deferral and refusal writes an echo item.
 *
 * Every input is bounded (`exchange.*` in the configuration): a file over
 * `max_file_bytes` is read only that far, a line over `max_line_bytes`, a line
 * that does not parse or fit the shape is recorded by a fixed reason and
 * ignored, at most `max_new_lines_per_tick` new lines are taken per tick and at
 * most `max_rejects_per_tick` rejections recorded. A line is acted on once
 * ever: its disposition is a ledger record under the line's hash.
 *
 * Nothing here sends. The one thing it writes outside the ledger is the outbox.
 */

import path from 'node:path'
import { H } from './hash.js'
import { exchangeLimits, deferLimits } from './config.js'
import { effectiveState } from './derive.js'
import { put } from './checks.js'
import { itemKey, recId, headline, renderItem, renderDigest, stepLine, ECHO, ALERT, REFUSAL_TEXT, DIGEST_KEY } from './render.js'
import { outboxRecord, openOutbox } from './outbox.js'
import { readInput, parseReceipt, parseAck } from './inbox.js'
import { DISMISSABLE, planOwnerEvent, planQueue, sweepUnknownDeliveries } from './queue.js'
import { ownerAckKey, systemKey } from './keys.js'

export const EXCHANGE_FILES = Object.freeze({ outbox: 'outbox.jsonl', receipts: 'receipts.jsonl', acks: 'acks.jsonl' })

/** An exchange over a directory the caller names. */
export function createExchange({ dir }) {
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) throw new TypeError('createExchange: dir must be an absolute path')
  const files = Object.fromEntries(Object.entries(EXCHANGE_FILES).map(([k, f]) => [k, path.join(dir, f)]))
  return { dir, files, outbox: openOutbox(files.outbox), pending: [], pendingKeys: new Set(), now: 0, tickEchoes: new Map() }
}

const sys = (event, ids, detail, now) => put({ kind: 'system', id: systemKey(event, ids), body: { event, detail: { ids, ...detail } } }, now)

/** The attempts by the outbox line each one was delivered as. */
function attemptsByRec(state) {
  const m = new Map()
  for (const a of state.attempts.values()) m.set(recId('attempt', a.id), a)
  return m
}

/** The message an item has currently delivered: its latest delivered attempt of this episode. */
export function currentMessage(state, item) {
  let best = null
  for (const a of state.attempts.values()) {
    if (a.itemId !== item.itemId || a.body.episode !== item.episode) continue
    if (!a.hasOutcome || a.outcome !== 'delivered' || a.unknown || state.receipts.get(recId('attempt', a.id)) === 'failed') continue
    if (!best || a.seq > best.seq) best = a
  }
  return best
}

function unconfirmedFor(state, item) {
  for (const a of state.attempts.values()) if (a.itemId === item.itemId && a.body.episode === item.episode && a.unknown) return true
  return false
}

// ── inputs ───────────────────────────────────────────────────────────

function* ingest(ctx, ex, { input, parse, handle, tickId, now }) {
  const lim = exchangeLimits(ctx.state.config)
  const { lines, problem } = readInput(ex.files[input], { maxFileBytes: lim.max_file_bytes, maxLineBytes: lim.max_line_bytes })
  // Once per file, not once per tick: a rotated file starts a new one.
  if (problem) yield sys('input_limit', [input, problem, lines[0]?.id ?? ''], { input, problem }, now)
  let fresh = 0
  let rejects = 0
  for (const ln of lines) {
    const key = systemKey('input_line', [input, ln.id])
    if (ctx.state.index.has(key)) continue
    const parsed = ln.tooLong ? { reason: 'too_long' } : parse(ln.text)
    if (parsed.reason) {
      if (++rejects <= lim.max_rejects_per_tick) yield sys('input_line', [input, ln.id], { input, disposition: 'rejected', reason: parsed.reason }, now)
      continue
    }
    if (++fresh > lim.max_new_lines_per_tick) break
    yield* handle(parsed, ln.id, now)
  }
}

function* handleReceipt(ctx, ex, r, lid, now) {
  const st = ctx.state
  const att = attemptsByRec(st).get(r.rec)
  const line = (disposition, extra) => sys('input_line', ['receipts', lid], { input: 'receipts', disposition, ...extra }, now)
  if (!att || itemKey(att.itemId, att.body.episode) !== r.key) return yield line('ignored', { reason: 'unknown_message' })
  if (st.receipts.has(r.rec) || att.unknown) return yield line('ignored', { reason: 'already_receipted' })
  // An unclear outcome is "delivery not confirmed": the attempt is marked, and an
  // attempt that exists is never made again.
  if (r.outcome === 'unclear') yield sys('delivery_unknown', [att.id], {}, now)
  yield line('receipt', { rec: r.rec, outcome: r.outcome })
}

/** Why an acknowledgement does not apply to this item now, or null. */
function refusalFor(ctx, it, a, now) {
  if (a.intent === 'dismiss') return DISMISSABLE.has(it.origin) ? null : 'not_dismissable'
  if (effectiveState(it, now) !== 'active') return 'not_active'
  if (a.intent !== 'defer') return null
  const { maxMs, maxCount } = deferLimits(ctx.state.config)
  if (a.until <= now) return 'until_not_in_future'
  if (a.until - now > maxMs) return 'too_long'
  if (it.deferrals >= maxCount) return 'too_many'
  return null
}

/** Write an echo item; false when the outbox could not be written, so the line is tried again next tick. */
function echo(ex, lid, text, item, now) {
  return append(ex, outboxRecord({ at: now, rec: recId('echo', lid), key: recId('echo_key', lid), op: 'post', cls: 'echo', status: 'info', origin: item.origin, source: item.source ?? null, text }))
}

/** An outbox write that can fail without failing the tick. */
function append(ex, record) {
  try {
    ex.outbox.append(record)
    return true
  } catch {
    return false
  }
}

function* handleAck(ctx, ex, a, lid, now) {
  const st = ctx.state
  const lim = exchangeLimits(st.config)
  const line = (disposition, extra) => sys('input_line', ['acks', lid], { input: 'acks', disposition, intent: a.intent, ...extra }, now)
  const att = attemptsByRec(st).get(a.rec)
  const judgedKey = systemKey('input_judged', ['acks', lid])
  const prior = st.index.get(judgedKey)?.body.detail
  const it = prior ? st.items.get(prior.item_id) : att ? st.items.get(att.itemId) : null
  let ignored = null
  if (prior) ignored = null
  else if (!att) ignored = 'unknown_message'
  else if (itemKey(att.itemId, att.body.episode) !== a.key) ignored = 'key_mismatch'
  else if (!it?.open) ignored = 'item_closed'
  else if (att.body.episode !== it.episode) ignored = 'old_episode'
  else if (currentMessage(st, it)?.id !== att.id) ignored = 'not_current_message'
  if (ignored) return yield line('ignored', { reason: ignored })

  // How many echoes this item may still have: per tick (the rest wait for the
  // next tick) and per episode (the rest are not judged; one record and one
  // echo say so, once).
  let judged = prior
  const itemKeyStr = `${judged?.item_id ?? it.itemId}|${judged?.episode ?? it.episode}`
  if (!judged) {
    if ((st.echoCounts.get(itemKeyStr) ?? 0) >= lim.max_echoes_per_episode) {
      const id = ['acks', 'echo_cap', it.itemId, it.episode]
      if (!st.index.has(systemKey('input_limit', id)) && echo(ex, recId('echo_cap', it.itemId, it.episode), ECHO.capped(headline(it, lim.text_field_max)), it, now)) yield sys('input_limit', id, { input: 'acks', problem: 'echo_cap', item_id: it.itemId, episode: it.episode }, now)
      return
    }
    if ((ex.tickEchoes.get(itemKeyStr) ?? 0) >= lim.max_echoes_per_item_per_tick) return
    // Judge the line once, now, and keep the judgement: a retry after a crash or a
    // failed echo carries it out and never judges again, with a later time.
    const why = refusalFor(ctx, it, a, now)
    judged = { verdict: why ? 'refuse' : 'accept', reason: why, item_id: it.itemId, episode: it.episode }
    yield sys('input_judged', ['acks', lid], { verdict: judged.verdict, reason: why, item_id: it.itemId, episode: it.episode }, now)
  }
  ex.tickEchoes.set(itemKeyStr, (ex.tickEchoes.get(itemKeyStr) ?? 0) + 1)
  const title = headline(it, lim.text_field_max)
  const detail = { item_id: judged.item_id, episode: judged.episode }
  if (judged.verdict === 'refuse') {
    if (!echo(ex, lid, ECHO.refused(title, REFUSAL_TEXT[judged.reason]), it, now)) return
    return yield line('refused', { reason: judged.reason, ...detail })
  }
  if (!st.index.has(ownerAckKey(judged.item_id, judged.episode, lid, 'ack'))) {
    const res = yield* planOwnerEvent(ctx, { itemId: it.itemId, intent: a.intent, ackRef: lid, until: a.until, now })
    if (!res.applied) return yield line('ignored', { reason: 'not_applicable' })
  }
  if (!echo(ex, lid, ECHO[a.intent](title, a.until), it, now)) return
  return yield line('applied', detail)
}

// ── outbox ───────────────────────────────────────────────────────────

/**
 * The deliver function of the core's `run`: an item's show, reminder or return
 * goes into the outbox. "Delivered" here means written there, nothing more; the
 * consumer's receipt says whether it reached anyone. A write that fails is a
 * failed delivery, which is not made again.
 */
export function writeToOutbox(ctx, ex, effect) {
  const st = ctx.state
  const lim = exchangeLimits(st.config)
  const it = st.items.get(effect.item_id)
  const key = itemKey(effect.item_id, effect.episode)
  const rec = recId('attempt', effect.attempt_id)
  try {
    const prior = st.outbox.get(key)
    const title = prior?.title ?? headline(it, lim.text_field_max)
    const { text: base, status } = renderItem(st, it, { max: lim.text_field_max, title, unconfirmed: unconfirmedFor(st, it) })
    const head = stepLine(effect.step, effect.n)
    const first = !prior && !ex.pendingKeys.has(key)
    ex.outbox.append(outboxRecord({ at: ex.now, rec, key, op: first ? 'post' : 'repost', cls: 'item', status, step: effect.step, n: effect.n, origin: it.origin, source: it.source ?? null, text: head ? `${head}\n${base}` : base }))
    ex.pending.push({ rec, key, cls: 'item', hash: H(base, status).slice(0, 32), itemId: effect.item_id, episode: effect.episode, title })
    ex.pendingKeys.add(key)
    return 'delivered'
  } catch {
    return 'failed'
  }
}

function* renderOutbox(ctx, ex, now) {
  const st = ctx.state
  const lim = exchangeLimits(st.config)
  const renderRecord = (p, op) => sys('outbox_render', [p.rec], { key: p.key, op, class: p.cls, hash: p.hash, item_id: p.itemId ?? null, episode: p.episode ?? null, title: p.title ?? null }, now)

  // What the deliveries of this tick put in the outbox.
  for (const p of ex.pending.splice(0)) yield renderRecord(p, 'delivery')
  ex.pendingKeys.clear()

  // A changed item, or one that has closed, is an edit of its message.
  for (const e of [...st.outbox.values()].filter((x) => x.class === 'item')) {
    const it = st.items.get(e.itemId)
    const live = it && it.episode === e.episode ? it : { open: false, closedAs: null }
    const { text, status } = renderItem(st, live, { max: lim.text_field_max, title: e.title, unconfirmed: live.open ? unconfirmedFor(st, live) : false })
    const hash = H(text, status).slice(0, 32)
    if (hash === e.hash) continue
    const rec = recId('updated', e.key, hash, e.rec)
    if (!append(ex, outboxRecord({ at: now, rec, key: e.key, op: 'updated', cls: 'item', status, origin: live.origin ?? null, source: live.source ?? null, text }))) continue
    yield renderRecord({ rec, key: e.key, cls: 'item', hash, itemId: e.itemId, episode: e.episode }, 'updated')
  }

  // An acknowledgement the evidence did not agree with: an alert, once.
  for (const [id, c] of [...st.contradictions]) {
    const rec = recId('alert', id)
    if (st.index.has(systemKey('outbox_render', [rec]))) continue
    const it = st.items.get(c.itemId)
    if (!it) continue
    if (!append(ex, outboxRecord({ at: now, rec, key: recId('alert_key', id), op: 'post', cls: 'alert', status: 'info', origin: it.origin, source: it.source ?? null, text: ALERT(headline(it, lim.text_field_max)) }))) continue
    yield renderRecord({ rec, key: recId('alert_key', id), cls: 'alert', hash: rec }, 'alert')
  }

  // The digest of everything open, kept as one message.
  const d = renderDigest(st, now, { max: lim.text_field_max, maxItems: lim.digest_max_items })
  const prior = st.outbox.get(DIGEST_KEY)
  const hash = H(d.text).slice(0, 32)
  if (prior ? prior.hash !== hash : d.count > 0) {
    const rec = recId('digest', hash, prior?.rec ?? null)
    if (append(ex, outboxRecord({ at: now, rec, key: DIGEST_KEY, op: prior ? 'updated' : 'post', cls: 'digest', status: 'open', text: d.text }))) yield renderRecord({ rec, key: DIGEST_KEY, cls: 'digest', hash }, 'digest')
  }
}

/**
 * The queue part of one tick, with the exchange around it: unknown deliveries
 * are swept, receipts and acknowledgements are read, the queue runs (its shows
 * go to the outbox through `writeToOutbox`), and the outbox is brought up to
 * date.
 */
export function* planExchange(ctx, ex, { source, tickId, now, signals, tickOpenSeq }) {
  ex.now = now
  ex.tickEchoes.clear()
  yield* sweepUnknownDeliveries(ctx, now)
  yield* ingest(ctx, ex, { input: 'receipts', parse: parseReceipt, handle: (r, lid) => handleReceipt(ctx, ex, r, lid, now), tickId, now })
  yield* ingest(ctx, ex, { input: 'acks', parse: parseAck, handle: (a, lid) => handleAck(ctx, ex, a, lid, now), tickId, now })
  yield* planQueue(ctx, { source, tickId, now, signals, tickOpenSeq })
  yield* renderOutbox(ctx, ex, now)
}
