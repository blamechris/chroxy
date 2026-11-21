/**
 * In-memory append-only ledger with idempotent append.
 *
 * A record's `id` is its idempotency key. Appending a record whose key is
 * already present with the same payload is ignored. Appending one whose key is
 * present with a different payload appends an `idempotency_conflict` system
 * record and has no other effect. Nothing is ever changed after it is written.
 *
 * The payload compared is the record without the envelope fields the ledger
 * itself assigns (`seq`, `ts`, `prev`): a repeat written later, at a different
 * time, is still the same record.
 *
 * Pure in-memory data structure; the clock is an argument.
 */

import { canonical, sha256 } from './hash.js'
import { systemKey } from './keys.js'

export const KINDS = Object.freeze(['tick', 'check', 'report', 'activity', 'emit', 'investigation', 'surface', 'owner_ack', 'config', 'system'])

export function createLedger({ ledgerId }) {
  if (!ledgerId) throw new Error('createLedger: ledgerId is required')
  return { ledgerId, records: [], byKey: new Map(), lastHash: null }
}

/**
 * Rebuild a ledger's in-memory index from its records alone, as a process
 * would after a restart. The records are the durable part; the index is not.
 */
export function loadLedger({ ledgerId, records }) {
  const ledger = createLedger({ ledgerId })
  for (const r of records) {
    ledger.records.push(r)
    ledger.byKey.set(r.id, payloadOf(r))
  }
  ledger.lastHash = records.length ? sha256(canonical(records[records.length - 1])) : null
  return ledger
}

/** The part of a record that identifies its content. */
export function payloadOf(record) {
  const { seq: _seq, ts: _ts, prev: _prev, ...rest } = record
  return canonical(rest)
}

export function has(ledger, key) {
  return ledger.byKey.has(key)
}

/** The record with this key, or null. Linear in the worst case; for lookups the caller keeps its own index. */
export function find(ledger, key) {
  if (!ledger.byKey.has(key)) return null
  for (let i = ledger.records.length - 1; i >= 0; i--) {
    if (ledger.records[i].id === key) return ledger.records[i]
  }
  return null
}

function write(ledger, draft, now) {
  const record = {
    v: 1,
    seq: ledger.records.length + 1,
    ts: new Date(now).toISOString(),
    kind: draft.kind,
    id: draft.id,
    actor: draft.actor ?? { class: 'system', id: 'reconciler', label: 'freshness' },
    session: draft.session ?? null,
    workKey: draft.workKey ?? null,
    refs: draft.refs ?? {},
    body: draft.body ?? {},
    ext: draft.ext ?? {},
    prev: ledger.lastHash,
  }
  ledger.records.push(record)
  ledger.byKey.set(record.id, payloadOf(record))
  ledger.lastHash = sha256(canonical(record))
  return record
}

/**
 * Append a draft record. Returns { status, record } where status is
 * 'appended', 'duplicate' (same key, same payload: ignored) or 'conflict'
 * (same key, different payload: an idempotency_conflict record is appended
 * instead, and `record` is that system record).
 */
export function append(ledger, draft, now) {
  if (!KINDS.includes(draft.kind)) throw new Error(`append: unknown kind ${draft.kind}`)
  if (!draft.id) throw new Error('append: a record needs its key as id')
  const probe = {
    v: 1,
    kind: draft.kind,
    id: draft.id,
    actor: draft.actor ?? { class: 'system', id: 'reconciler', label: 'freshness' },
    session: draft.session ?? null,
    workKey: draft.workKey ?? null,
    refs: draft.refs ?? {},
    body: draft.body ?? {},
    ext: draft.ext ?? {},
  }
  const existing = ledger.byKey.get(draft.id)
  if (existing !== undefined) {
    if (existing === canonical(probe)) return { status: 'duplicate', record: null }
    const conflictDraft = {
      kind: 'system',
      id: systemKey('idempotency_conflict', [draft.id]),
      body: { event: 'idempotency_conflict', detail: { ids: [draft.id] } },
    }
    if (ledger.byKey.has(conflictDraft.id)) return { status: 'conflict', record: null }
    return { status: 'conflict', record: write(ledger, conflictDraft, now) }
  }
  return { status: 'appended', record: write(ledger, draft, now) }
}

/** Verify the hash chain; returns the first broken seq, or 0. */
export function verifyChain(ledger) {
  let prev = null
  for (const r of ledger.records) {
    if (r.prev !== prev) return r.seq
    prev = sha256(canonical(r))
  }
  return 0
}
