/**
 * Idempotency keys for every record kind of the freshness ledger.
 *
 * Each function returns the record's `id`. The tuples follow the key table
 * in README exactly, without extra kind tags, so that a collision the table
 * allows is a collision the model reproduces. "Session" in a key is always the
 * identity triple (source, native id, incarnation), never a label.
 *
 * Pure: no I/O, no clock, no randomness.
 */

import { H } from './hash.js'

/** The session identity used in keys. A label is never part of it. */
export function sessionIdentity(session) {
  return [session.source, session.native_id, session.incarnation ?? null]
}

/** A stable string form of the identity, used as a map key. */
export function sessionKey(session) {
  return H('session', sessionIdentity(session))
}

/** `report`: H(session, report_time, fields_hash). */
export function reportKey(session, reportTime, fieldsHash) {
  return H(sessionIdentity(session), reportTime, fieldsHash)
}

/** `tick_id`: H(ledger_id, source, slot_start). */
export function tickId(ledgerId, source, slotStart) {
  return H(ledgerId, source, slotStart)
}

/** `tick` record: H(tick_id, phase). */
export function tickKey(id, phase) {
  return H(id, phase)
}

/** `check` made by a tick: H(tick_id, session). */
export function checkTickKey(id, session) {
  return H(id, sessionIdentity(session))
}

/** `check` made for an accepted emit: H(emit_id, session). */
export function checkEmitKey(emitId, session) {
  return H(emitId, sessionIdentity(session))
}

/**
 * The read numbers of the reads inside one investigation: 1 the re-read, 2 its
 * one retry, 3 the read that confirms a session is gone; 4, the separate
 * activity read, is the model's addition (README, key table).
 */
export const READ_NO = Object.freeze({
  REREAD: 1,
  RETRY: 2,
  CONFIRM_GONE: 3,
  // DESIGN-GAP: the activity read on a source whose tick read carries no native state
  // needs a separate activity read, and a recheck "that needs a read of its
  // own" makes one too, but `read_no` defines only 1..3. The model gives the
  // activity read number 4.
  ACTIVITY: 4,
})

/** `check` made inside an investigation: H(investigation_id, read_no). */
export function checkInvestigationKey(investigationId, readNo) {
  return H(investigationId, readNo)
}

/** `emit`: the source's event id, or H(session, type, host timestamp). */
export function emitKey({ sourceEventId, session, type, hostTs }) {
  if (sourceEventId != null) return String(sourceEventId)
  return H(sessionIdentity(session), type, hostTs)
}

/** `activity` for a state seen at a read: H(check_id, basis, ref). */
export function activityStateKey(checkId, basis, ref) {
  return H(checkId, basis, ref ?? null)
}

/**
 * `activity` for an event: the host's event id, or H(session, basis,
 * activity_at) when the host gives none.
 *
 * DESIGN-GAP: the key table uses the host's event id alone. A host that
 * numbers events per session gives two sessions the same id, and the second
 * session's event would collide with the first's. The model puts the
 * session identity in the key in both cases.
 */
export function activityEventKey({ hostEventId, session, basis, activityAt }) {
  if (hostEventId != null) return H(sessionIdentity(session), 'event', String(hostEventId))
  return H(sessionIdentity(session), basis, activityAt ?? null)
}

/** `investigation_id` for a per-session cycle. */
export function investigationId({ session, reportId, trigger, onset, cycle }) {
  return H(sessionIdentity(session), reportId ?? null, trigger, onset, cycle)
}

/** `investigation_id` for a source-level outage cycle. */
export function sourceInvestigationId({ source, onset, cycle }) {
  return H(source, 'source_unreachable', onset, cycle)
}

/** `investigation_id` for a recheck: one per session, report and tick. */
export function recheckInvestigationId({ session, reportId, tickId: tid }) {
  return H(sessionIdentity(session), reportId ?? null, 'recheck', tid)
}

/** `investigation` record: H(investigation_id, phase). */
export function investigationKey(id, phase) {
  return H(id, phase)
}

/** Item identity by origin. */
export const itemIds = Object.freeze({
  // One owner item per session, whatever its asks (a declared block, a
  // pending prompt, or both).
  owner: (session) => H(sessionIdentity(session), 'owner_block', 'owner'),
  // An owner item per ask kind: the earlier identity, kept for the variant
  // that restores two separate items.
  ownerAsk: (session, kind) => H(sessionIdentity(session), 'owner_block', kind),
  seed: (seedScope, seedSession) => H(seedScope, seedSession, 'session_request', 'seed'),
  issue: (workKey) => H(workKey, 'session_request', 'issue'),
  attention: (session, reportId) => H(sessionIdentity(session), 'session_attention', reportId ?? null),
  gone: (session) => H(sessionIdentity(session), 'session_attention', 'gone'),
  outage: (source) => H(source, 'source_unreachable'),
})

/** Steps that send, and so have an attempt and an outcome record. */
export const SENDING_STEPS = Object.freeze(new Set(['shown', 'reminded', 'returned']))

/**
 * The per-step ordinal table (README, keys). `ctx` carries what the
 * ordinal is drawn from: `presentation`, `k`, `ackRef`, `changeRef`.
 */
export const SURFACE_ORDINAL = Object.freeze({
  queued: () => 0,
  resolved: () => 0,
  withdrawn: () => 0,
  shown: (ctx) => ctx.presentation,
  expired: (ctx) => ctx.presentation,
  preempted: (ctx) => ctx.presentation,
  exhausted: (ctx) => ctx.presentation,
  reminded: (ctx) => ctx.k,
  returned: () => 1,
  deferred: (ctx) => ctx.ackRef,
  updated: (ctx) => ctx.changeRef,
})

export function surfaceOrdinal(step, ctx) {
  const fn = SURFACE_ORDINAL[step]
  if (!fn) throw new Error(`surfaceOrdinal: unknown step ${step}`)
  const v = fn(ctx)
  if (v === undefined) throw new Error(`surfaceOrdinal: ${step} needs an ordinal input`)
  return v
}

/** `surface`: H(item_id, episode, step, ordinal, phase). */
export function surfaceKey(itemId, episode, step, ordinal, phase) {
  return H(itemId, episode, step, ordinal, phase)
}

/** `owner_ack`: H(item_id, episode, ack_ref, phase). */
export function ownerAckKey(itemId, episode, ackRef, phase) {
  return H(itemId, episode, ackRef, phase)
}

/** `config`: H(previous config record id, config_hash). */
export function configKey(previousConfigRecordId, configHash) {
  return H(previousConfigRecordId ?? null, configHash)
}

/** `system`: H(event, the ids in detail). */
export function systemKey(event, ids) {
  return H(event, ids)
}
