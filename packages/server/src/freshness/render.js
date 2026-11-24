/**
 * Templates for the outbox: what an item, the digest, an echo and an alert
 * say. No model writes any of it. Every sentence is fixed here, and the only
 * values put into one are the item's declared-status fields (state, what it is
 * blocked on, the decision, the next step, the owner it names, its time) and
 * the session's source and id, each cleaned and cut to a length first.
 *
 * Nothing here reads a clock: a text names absolute times only, so the same
 * item in the same state renders the same text and an unchanged item is never
 * "updated". Pure functions over the derived state.
 */

import { H } from './hash.js'
import { effectiveState } from './derive.js'

const KEY_LEN = 32

/** The outbox key of an item's episode: stable, and the same on every restart. */
export function itemKey(itemId, episode) {
  return H('outbox_key', itemId, episode).slice(0, KEY_LEN)
}

/** The id of one outbox record, from what it is made of. */
export function recId(...parts) {
  return H('outbox_rec', ...parts).slice(0, KEY_LEN)
}

export const DIGEST_KEY = H('outbox_digest').slice(0, KEY_LEN)

export const HEX_ID = new RegExp(`^[0-9a-f]{${KEY_LEN}}$`)

/** A value put in a text: one line, no control characters, cut to `max` characters. */
export function clean(value, max) {
  if (value === null || value === undefined) return ''
  // Control characters and every Unicode format character (bidi overrides and
  // isolates, zero-width characters) become a space.
  const flat = String(value).replace(/[\u0000-\u001f\u007f-\u009f\u2028\u2029\p{Cf}]+/gu, ' ').replace(/\s+/g, ' ').trim()
  // Cut by code point, so a surrogate pair is never split.
  const points = Array.from(flat)
  return points.length > max ? points.slice(0, Math.max(0, max - 1)).join('') + '…' : flat
}

function iso(ms) {
  return Number.isFinite(ms) ? new Date(ms).toISOString() : 'unknown time'
}

function who(session, max) {
  return session ? `session ${clean(session.source, 64)}/${clean(session.native_id, max)}` : 'a session'
}

function reportOf(state, id) {
  return id ? (state.reports.get(id)?.body ?? null) : null
}

function field(label, value, max) {
  const v = clean(value, max)
  return v ? `${label}: ${v}` : null
}

/** One short line naming an item. */
export function headline(item, max = 240) {
  const w = who(item.session, max)
  switch (item.origin) {
    case 'owner':
      return `${w} needs the owner`
    case 'attention':
      return `${w} has an old status report`
    case 'gone':
      return `${w} is no longer listed`
    case 'outage':
      return `source ${clean(item.source, 64)} cannot be read`
    case 'seed':
      return `a seed to paste for ${clean(item.seed?.scope, max)}`
    default:
      return `${clean(item.kind, 64)} for ${w}`
  }
}

function ownerLines(state, item, max) {
  const lines = []
  const declared = item.asks.get('declared')
  if (declared) {
    const rep = reportOf(state, declared.report_id)
    lines.push(field('Blocked on', rep?.declared_blocked_on, max), field('Decision', rep?.decision, max), field('Next', rep?.next, max), field('Reported', rep ? iso(rep.last_report_at) : null, max))
  }
  if (item.asks.has('prompt')) lines.push('A prompt is waiting for an answer.')
  return lines
}

function conditionLines(item, max) {
  return item.carried.map((c) => `Also: the status report went stale (${clean(c.trigger, 64)}), since ${iso(c.since)}.`).slice(0, 3).map((l) => clean(l, max * 2))
}

/**
 * The text of an open or closed item, and whether it is open. `title` is
 * the headline the item was first rendered under, kept for the closed text.
 */
export function renderItem(state, item, { max, title = null, unconfirmed = false } = {}) {
  if (!item.open) {
    const how = item.closedAs ? ` (${clean(item.closedAs.replace(':', ' '), 64)})` : ''
    return { text: `Closed${how}: ${clean(title ?? headline(item, max), max * 2)}`, status: 'closed' }
  }
  const lines = [`${clean(headline(item, max), max * 2)}.`]
  if (item.origin === 'owner') lines.push(...ownerLines(state, item, max), ...conditionLines(item, max))
  else if (item.origin === 'attention' || item.origin === 'gone') {
    const rep = reportOf(state, item.reportId)
    lines.push(field('Last report', rep ? iso(rep.last_report_at) : null, max), field('State', rep?.state, max), field('Trigger', item.condition?.trigger, max))
  } else if (item.origin === 'seed') {
    lines.push(field('Written', item.seed ? iso(item.seed.written_at) : null, max))
  }
  if (item.state === 'acknowledged') lines.push('Marked done; it closes when the next check agrees.')
  if (item.state === 'deferred') lines.push(`Deferred until ${iso(item.deferUntil)}.`)
  if (item.state === 'exhausted') lines.push('No more reminders will be sent.')
  if (unconfirmed) lines.push('Delivery of an earlier message was not confirmed.')
  return { text: lines.filter(Boolean).join('\n'), status: 'open' }
}

/** The line a further delivery of an item starts with. */
export function stepLine(step, n) {
  if (step === 'reminded') return `Reminder ${n}.`
  if (step === 'returned') return 'Marked done earlier, but the latest status still shows it open.'
  return null
}

/** The digest: one line per open item, in a stable order, cut to `maxItems`. */
export function renderDigest(state, now, { max, maxItems }) {
  const open = [...state.items.values()].filter((it) => it.open).sort((a, b) => (a.orderTime ?? 0) - (b.orderTime ?? 0) || (a.itemId < b.itemId ? -1 : 1))
  if (open.length === 0) return { text: 'No open items.', count: 0 }
  const lines = [`Open items: ${open.length}.`]
  for (const it of open.slice(0, maxItems)) lines.push(`- ${effectiveState(it, now)}: ${clean(headline(it, max), max * 2)}`)
  if (open.length > maxItems) lines.push(`and ${open.length - maxItems} more.`)
  return { text: lines.join('\n'), count: open.length }
}

export const ECHO = Object.freeze({
  done: (title) => `Noted: marked done, ${title}. It closes when the next check agrees.`,
  dismiss: (title) => `Noted: dismissed, ${title}.`,
  defer: (title, until) => `Noted: deferred until ${iso(until)}, ${title}.`,
  capped: (title) => `Further lines about this item were not applied (too many): ${title}.`,
  refused: (title, reason) => `Not applied (${reason}): ${title}.`,
})

export const ALERT = (title) => `Marked done, but the latest status still shows it open: ${title}. The item stays open.`

export const REFUSAL_TEXT = Object.freeze({
  too_long: 'longer than the longest deferral allowed',
  too_many: 'more deferrals than allowed for this item',
  until_not_in_future: 'the time is not in the future',
  not_active: 'the item is not the one waiting for an answer',
  not_dismissable: 'this kind of item cannot be dismissed',
})
