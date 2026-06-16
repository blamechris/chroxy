/**
 * Session-list handlers (audit P2-3 split).
 *
 * `session_list` parsing + the per-session patch-builder pipeline
 * (`buildSessionListPatches` / `cumulativeUsageEquals` /
 * `chunkSubscribeSessionIds` / `SESSION_LIST_SUBSCRIBE_CHUNK_SIZE` /
 * `SessionListPatches`), plus the #4307 `background_work_changed` handler
 * (`handleBackgroundWorkChanged` / `PendingBackgroundShellsBuilder`).
 *
 * `handleBackgroundWorkChanged` lives here rather than in a standalone module
 * because `buildSessionListPatches` calls it internally to seed each session's
 * `pendingBackgroundShells` slot from the snapshot.
 *
 * Re-exported from ./index (the barrel) so the public surface is unchanged.
 */

import type {
  CumulativeUsage,
  PendingBackgroundShell,
  SessionInfo,
} from '../types'
import { resolveSessionId } from './_shared'

// ---------------------------------------------------------------------------
// session_list
// ---------------------------------------------------------------------------

/**
 * Validate a `session_list` message and return the parsed sessions array.
 *
 * Returns null when `msg.sessions` is missing or non-array — matches both
 * clients' prior `if (Array.isArray(msg.sessions))` guard.
 *
 * Per-element shape is NOT validated — the cast to `SessionInfo[]` matches
 * the inline behaviour in both clients prior to this migration. Tightening
 * would be a behaviour change beyond the scope of #2661.
 *
 * Heavy state-merge logic (GC of removed sessions, flat-field sync, auto-
 * subscribe, conversationId persistence) stays at the call site — those
 * concerns are platform-specific (the dashboard syncs `activeModel` against
 * `availableModels`; the app additionally auto-subscribes via WS and persists
 * the last conversationId to disk).
 */
export function handleSessionList(msg: Record<string, unknown>): SessionInfo[] | null {
  if (!Array.isArray(msg.sessions)) return null
  return msg.sessions as unknown as SessionInfo[]
}

/**
 * Default (and maximum) chunk size for `subscribe_sessions` messages
 * produced by {@link buildSessionListPatches}. Matches the protocol-level
 * `SubscribeSessionsSchema` `.max(20)` bound (client→server message — the
 * server validates incoming `subscribe_sessions` payloads against this
 * cap). Consumers may pass a SMALLER override via the optional
 * `subscribeChunkSize` parameter; {@link chunkSubscribeSessionIds} clamps
 * larger / non-integer / non-positive values to this constant so a buggy
 * caller can never produce payloads the server will reject.
 *
 * Co-located here (rather than per-consumer) so the app and dashboard
 * can't drift out of sync — see #4767 acceptance criteria.
 */
export const SESSION_LIST_SUBSCRIBE_CHUNK_SIZE = 20

/**
 * Per-session patch maps + derived bookkeeping produced by
 * {@link buildSessionListPatches}. See that function's doc-comment for the
 * full call-site recipe.
 */
export interface SessionListPatches {
  /** Parsed sessions array (same reference returned by {@link handleSessionList}). */
  sessionList: SessionInfo[]
  /**
   * Session ids present in `prevSessionStateIds` but missing from the new
   * snapshot. Consumers GC persisted state + `sessionStates[id]` for these,
   * and decide their own "active session was removed" fallback policy.
   */
  removedIds: string[]
  /**
   * Session ids in the new snapshot that are NOT in `prevSessionStateIds`.
   * Consumers seed `sessionStates[id]` for these (typically with their
   * platform-specific `createEmptySessionState()`); the dashboard's
   * `isBusy → isIdle` seed (#4639) stays at the call site because it
   * mutates the consumer's own state shape.
   */
  newSessionIds: string[]
  /**
   * `sessionId → conversationId` for every session whose snapshot has a
   * non-null `conversationId`. Consumers gate on `sessionStates[id]` and
   * call `updateSession(id, ss => ss.conversationId !== cid ? { conversationId: cid } : {})`.
   */
  conversationIdPatches: Map<string, string>
  /**
   * `sessionId → CumulativeUsage snapshot` for every session whose
   * snapshot has a non-undefined `cumulativeUsage` (#4073 / #4074).
   * Consumers gate on `sessionStates[id]` and use
   * {@link cumulativeUsageEquals} to short-circuit no-op patches.
   */
  cumulativeUsagePatches: Map<string, CumulativeUsage>
  /**
   * `sessionId → PendingBackgroundShellsBuilder` for every session in the
   * snapshot — defaults to an empty `pending` list when the snapshot omits
   * the field (#4307 wire compat). Consumers gate on `sessionStates[id]`
   * and call `builder.applyTo(current)`; the builder's reference-equality
   * short-circuit suppresses no-op re-renders.
   */
  backgroundShellBuilders: Map<string, PendingBackgroundShellsBuilder>
  /**
   * Non-active session ids chunked into `subscribe_sessions` payloads. Each
   * chunk's length <= `SESSION_LIST_SUBSCRIBE_CHUNK_SIZE` (default 20 — the
   * server schema's max ids per message). Consumers iterate and send one
   * `subscribe_sessions` message per chunk; empty array means nothing to send.
   *
   * Consumers that don't auto-subscribe (currently the dashboard) ignore this
   * field; it's surfaced here so both clients can adopt the same chunking
   * logic without re-duplicating it later (#4767).
   */
  subscribeChunks: string[][]
}

/**
 * Reference-comparison-friendly equality check for two
 * {@link CumulativeUsage} snapshots. Returns `true` when both are non-null
 * and all six tracked fields (`inputTokens`, `outputTokens`,
 * `cacheReadTokens`, `cacheCreationTokens`, `costUsd`, `turnsBilled`) match.
 *
 * Two nulls return `false` — there is no current snapshot to short-circuit
 * against, so the caller would apply the (also-null) candidate as a no-op
 * write anyway. The pre-existing inline checks both gated on
 * `current && ...`, so this preserves that exact behaviour.
 *
 * Centralised here so both consumers stay in sync if the
 * {@link CumulativeUsage} shape grows a new field (#4767 AC).
 */
export function cumulativeUsageEquals(
  a: CumulativeUsage | null | undefined,
  b: CumulativeUsage | null | undefined,
): boolean {
  if (!a || !b) return false
  return (
    a.inputTokens === b.inputTokens &&
    a.outputTokens === b.outputTokens &&
    a.cacheReadTokens === b.cacheReadTokens &&
    a.cacheCreationTokens === b.cacheCreationTokens &&
    a.costUsd === b.costUsd &&
    a.turnsBilled === b.turnsBilled
  )
}

/**
 * Build the per-session patch maps + derived bookkeeping a `session_list`
 * consumer needs to apply the snapshot. Centralises the GC + new-session
 * seeding + conversationId sync + #4073/#4074 cumulativeUsage seeding +
 * #4307 pendingBackgroundShells seeding + `subscribe_sessions` chunking
 * logic that previously lived inline in both the app and dashboard
 * `case 'session_list'` branches (#4767).
 *
 * Returns `null` when {@link handleSessionList} rejects the message —
 * consumers `break` out of the case in that path, preserving prior
 * behaviour.
 *
 * Behaviour preservation contract:
 * - `removedIds` filters `prevSessionStateIds` by membership in the new id
 *   set — identical to both prior inline computations
 *   (app L1209-1211 / dashboard L2140-2142).
 * - `newSessionIds` lists ids in the new snapshot that aren't already in
 *   `prevSessionStateIds`, in snapshot order. Mirrors both prior
 *   `for (const s of sessionList) if (!newStates[s.sessionId]) ...` loops
 *   (app L1236-1241 / dashboard L2206-2213).
 * - `conversationIdPatches` includes every session with a truthy
 *   `conversationId` — the consumer's `ss.conversationId !== cid` short-
 *   circuit stays at the call site (existing `updateSession` callback).
 * - `cumulativeUsagePatches` includes every session whose snapshot has a
 *   non-undefined `cumulativeUsage` field — same gate as the prior inline
 *   `if (s.cumulativeUsage && ...)` (app L1258 / dashboard L2246). Use
 *   {@link cumulativeUsageEquals} at the call site for the six-field
 *   no-op short-circuit (centralised here per #4767 AC).
 * - `backgroundShellBuilders` always includes every session (per the
 *   #4307 wire contract: omitted = []); each builder's `applyTo` does the
 *   per-shell reference-equality short-circuit. The consumer still gates
 *   on `sessionStates[id]` to skip sessions it hasn't seeded yet, matching
 *   both prior inline `if (!get().sessionStates[s.sessionId]) continue;`
 *   guards (app L1283 / dashboard L2275).
 * - `subscribeChunks` filters out `activeSessionId` then chunks by
 *   `SESSION_LIST_SUBSCRIBE_CHUNK_SIZE`. Matches app L1308-1318. When
 *   nothing to subscribe (empty list or only active id present), the
 *   array is empty so consumers can iterate without an outer guard.
 *
 * Consumer-specific behaviour stays at the call site:
 * - The app's `loadLastConversationId()` auto-resume on empty list +
 *   reconnect (L1196-1207).
 * - The dashboard's `activeModel` lookup against `availableModels`
 *   (L2188-2197) and `isBusy → isIdle` resync (#4639, L2223-2230).
 * - Both consumers' `clearPersistedSession(prevId)` call per removed id.
 * - The app's `persistLastConversationId(activeConversationId)` after seeding.
 * - The dashboard's "active session removed → copy flat fields into the
 *   top-level patch" recovery (L2159-2180) — this touches consumer-
 *   specific top-level state slots so it stays in the consumer's `set()`.
 */
export function buildSessionListPatches(
  msg: Record<string, unknown>,
  prevSessionStateIds: readonly string[],
  activeSessionId: string | null,
  subscribeChunkSize: number = SESSION_LIST_SUBSCRIBE_CHUNK_SIZE,
): SessionListPatches | null {
  const sessionList = handleSessionList(msg)
  if (!sessionList) return null

  const newIdSet = new Set<string>()
  for (const s of sessionList) {
    if (s && typeof s.sessionId === 'string') newIdSet.add(s.sessionId)
  }

  const prevIdSet = new Set(prevSessionStateIds)

  const removedIds: string[] = []
  for (const prev of prevSessionStateIds) {
    if (!newIdSet.has(prev)) removedIds.push(prev)
  }

  const newSessionIds: string[] = []
  const conversationIdPatches = new Map<string, string>()
  const cumulativeUsagePatches = new Map<string, CumulativeUsage>()
  const backgroundShellBuilders = new Map<string, PendingBackgroundShellsBuilder>()

  for (const s of sessionList) {
    if (!s || typeof s.sessionId !== 'string') continue
    const sid = s.sessionId
    if (!prevIdSet.has(sid)) newSessionIds.push(sid)
    if (s.conversationId) conversationIdPatches.set(sid, s.conversationId)
    if (s.cumulativeUsage) cumulativeUsagePatches.set(sid, s.cumulativeUsage)
    backgroundShellBuilders.set(
      sid,
      handleBackgroundWorkChanged(
        { sessionId: sid, pending: s.pendingBackgroundShells ?? [] },
        activeSessionId,
      ),
    )
  }

  const subscribeChunks = chunkSubscribeSessionIds(sessionList, activeSessionId, subscribeChunkSize)

  return {
    sessionList,
    removedIds,
    newSessionIds,
    conversationIdPatches,
    cumulativeUsagePatches,
    backgroundShellBuilders,
    subscribeChunks,
  }
}

/**
 * Filter out `activeSessionId` from `sessionList` and chunk the remaining
 * ids into `subscribe_sessions`-bound payloads.
 *
 * Extracted from {@link buildSessionListPatches} so consumers whose active
 * session changes after the initial patch computation (e.g. the active
 * session was removed and the consumer fell back to the first surviving
 * id) can recompute the chunks against the final active id without
 * re-running the full patch builder.
 *
 * Returns `[]` when there are no non-active ids to subscribe (empty
 * sessionList, or list contains only the active session). Defensive
 * against malformed entries (missing/non-string sessionId — skipped).
 *
 * `subscribeChunkSize` is normalised to an integer in
 * `[1, SESSION_LIST_SUBSCRIBE_CHUNK_SIZE]`:
 * - Non-integers (e.g. `0.5`, `2.5`) would cause `i += chunkSize` to walk
 *   off the grid and `slice(i, i + chunkSize)` to coerce via truncation,
 *   producing duplicated / skipped ids — `Math.floor` removes the
 *   fractional part defensively.
 * - Values `<= 0` or non-numeric fall back to the default constant.
 * - Values `> SESSION_LIST_SUBSCRIBE_CHUNK_SIZE` are clamped down so a
 *   buggy caller can never emit a chunk the server's
 *   `SubscribeSessionsSchema.max(20)` would reject.
 */
export function chunkSubscribeSessionIds(
  sessionList: SessionInfo[],
  activeSessionId: string | null,
  subscribeChunkSize: number = SESSION_LIST_SUBSCRIBE_CHUNK_SIZE,
): string[][] {
  const requested =
    typeof subscribeChunkSize === 'number' &&
    Number.isFinite(subscribeChunkSize) &&
    subscribeChunkSize > 0
      ? Math.floor(subscribeChunkSize)
      : SESSION_LIST_SUBSCRIBE_CHUNK_SIZE
  // Floor may produce 0 if 0 < value < 1 (e.g. 0.5) — fall back to default.
  const normalised = requested >= 1 ? requested : SESSION_LIST_SUBSCRIBE_CHUNK_SIZE
  // Clamp to the protocol-enforced cap so callers can't produce
  // payloads that violate SubscribeSessionsSchema.max(20).
  const chunkSize = Math.min(normalised, SESSION_LIST_SUBSCRIBE_CHUNK_SIZE)
  const ids: string[] = []
  for (const s of sessionList) {
    if (!s || typeof s.sessionId !== 'string') continue
    if (s.sessionId !== activeSessionId) ids.push(s.sessionId)
  }
  const chunks: string[][] = []
  for (let i = 0; i < ids.length; i += chunkSize) {
    chunks.push(ids.slice(i, i + chunkSize))
  }
  return chunks
}

// ---------------------------------------------------------------------------
// #4307 — background_work_changed
//
// Snapshot-replacement: each event carries the full pending list for the
// targeted session. The handler returns a builder mirroring the
// agent_spawned/completed shape so the caller can gate on
// `sessionStates[sessionId]` (a known session) before applying, matching
// the surrounding handler conventions. Defensive against missing /
// non-array `pending` field (returns []), missing session id (caller
// treats as no-op), and malformed entries (skips fail-soft).
// ---------------------------------------------------------------------------

/**
 * Builder returned by {@link handleBackgroundWorkChanged}. Mirrors
 * {@link AgentInfoBuilder} / {@link ActiveToolBuilder}: callers gate
 * on `sessionStates[sessionId]` and call `applyTo` with the current
 * value to produce the next array (same reference when no change).
 */
export interface PendingBackgroundShellsBuilder {
  sessionId: string | null
  applyTo: (current: PendingBackgroundShell[]) => PendingBackgroundShell[]
}

/**
 * Parse a `background_work_changed` message into a builder that
 * replaces the session's `pendingBackgroundShells` slot with the
 * server's authoritative snapshot.
 *
 * Why snapshot-replace (rather than per-id diff): the wire event always
 * carries the full pending list (full-snapshot protocol — see
 * `ServerBackgroundWorkChangedSchema` doc-comment), so the handler can
 * be a flat replace. Late joiners catch up via `session_list`'s
 * `pendingBackgroundShells` field; live updates come through this
 * handler.
 *
 * Malformed entries (missing/non-string shellId, missing/non-number
 * startedAt, missing/non-string command) are filtered out fail-soft so
 * one bad row from a hypothetical future server can't make the whole
 * list disappear.
 */
export function handleBackgroundWorkChanged(
  msg: Record<string, unknown>,
  activeSessionId: string | null,
): PendingBackgroundShellsBuilder {
  const rawPending = Array.isArray(msg.pending) ? msg.pending : []
  const next: PendingBackgroundShell[] = []
  for (const raw of rawPending) {
    if (!raw || typeof raw !== 'object') continue
    const entry = raw as Record<string, unknown>
    const shellId = typeof entry.shellId === 'string' ? entry.shellId : null
    if (!shellId) continue
    const command = typeof entry.command === 'string' ? entry.command : ''
    const startedAt = typeof entry.startedAt === 'number' && entry.startedAt >= 0
      ? entry.startedAt
      : Date.now()
    next.push({ shellId, command, startedAt })
  }
  return {
    sessionId: resolveSessionId(msg, activeSessionId),
    applyTo: (current) => {
      // Reference-equality short-circuit: same length AND same
      // (shellId, startedAt, command) per index means no observable
      // change. The dashboard's `updateSession` skips re-renders when
      // the patch yields the same reference, so this matters for
      // duplicate emissions (idempotent server pushes from
      // pre-existing flows or reconnect-replay races).
      if (next.length === current.length) {
        let same = true
        for (let i = 0; i < next.length; i++) {
          const a = next[i]
          const b = current[i]
          // Index-in-bounds guard satisfies TS strict-null: `next` /
          // `current` are equal length but `noUncheckedIndexedAccess`
          // still types the element as `T | undefined`. The `!a || !b`
          // path is unreachable given the bounds; treat as mismatch
          // defensively.
          if (!a || !b) {
            same = false
            break
          }
          if (a.shellId !== b.shellId || a.startedAt !== b.startedAt || a.command !== b.command) {
            same = false
            break
          }
        }
        if (same) return current
      }
      return next
    },
  }
}
