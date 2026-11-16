/**
 * The agent principal's pending-permission snapshot (docs/security/agent-principals.md
 * section 7.3; #9119, S4 of #9112; advances #7860).
 *
 * `collectPendingPermissions` reads the CANONICAL current state of BOTH permission pipelines
 * at one instant and returns a plain description of every request still waiting for a
 * decision on the sessions asked about:
 *
 *   - IN-PROCESS: the PermissionManager behind the SDK, BYOK and Codex sessions. Its pending
 *     map is `session._pendingPermissions` and the payload each prompt was raised with is
 *     `session._lastPermissionData` (wirePermissionManager installs both). A BYOK session's
 *     subagents hold their own managers; the parent routes their prompts through
 *     `_subagentPermissionRouting`, so those children are read too.
 *   - HOOK-ROUTED: the claude CLI / TUI prompts the daemon holds as an open HTTP request
 *     (ws-permissions.js). The store is the server's `pendingPermissions` Map, the owner is
 *     its `permissionSessionMap`. A prompt with no owner belongs to no session a principal
 *     can have been granted, so it is not listed.
 *
 * The result is a snapshot, not a stream, and it grants NO decision authority: nothing here
 * can answer, extend, or reroute a request.
 *
 *   - NEVER the tool input, in any form. A request is described by its tool name, the three
 *     policy verdicts and its deadline; the S3 journal narrows tool inputs the same way
 *     (observe tier sees which tools ran, not their inputs).
 *   - The existing bounded, sanitised description is included ONLY when the request is
 *     positively not floored. Anything else (floored, or no verdict recorded) carries none.
 *   - FAIL CLOSED on missing metadata: no recorded `floored` / `explicitConsent` /
 *     `nonDelegable` reads as true, never as the permissive value.
 *   - An entry whose own deadline has passed is excluded even when its timer has not fired
 *     yet, so a request that "expired during the read" is not offered as answerable.
 *   - Bounded: at most `PRINCIPAL_PENDING_PERMISSIONS_MAX` requests, oldest first, with
 *     `truncated` when there were more.
 */
import { redactBounded } from './redaction.js'

/** The most requests one reply carries (the protocol schema's `.max()`). */
export const PRINCIPAL_PENDING_PERMISSIONS_MAX = 100

/** A description is clipped to this many characters, after redaction. */
export const PENDING_DESCRIPTION_MAX = 200

/** The longest tool name echoed. */
const TOOL_NAME_MAX = 200

/**
 * The most holders (a session plus its BYOK subagents, at any depth) one read will visit. A
 * read that would exceed it is reported incomplete (`truncated`), never as a complete snapshot.
 */
export const MAX_HOLDERS_PER_SESSION = 256

function finiteMs(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.trunc(value) : null
}

/**
 * One request, described. `pending` is the holder's own entry (may carry `explicitConsent`),
 * `data` the payload it was raised with (the `permission_request` fields).
 */
function describeRequest({ requestId, sessionId, origin, pending, data }) {
  const floored = data == null || data.floored !== false
  const createdAt = finiteMs(data?.createdAt)
  const ttl = finiteMs(data?.remainingMs)
  const out = {
    requestId,
    sessionId,
    // A tool name comes from a provider or a hook payload (an MCP name, say), so it is redacted
    // WHOLE before it is bounded: a cut first could leave a prefix no pattern recognises.
    tool: typeof data?.tool === 'string' && data.tool.length > 0 ? redactBounded(data.tool, TOOL_NAME_MAX) : 'unknown',
    floored,
    explicitConsent: pending?.explicitConsent === true || data == null || data.explicitConsent !== false,
    nonDelegable: data == null || data.nonDelegable !== false,
    origin,
    createdAt,
    expiresAt: createdAt !== null && ttl !== null ? createdAt + ttl : null,
  }
  if (!floored && typeof data.description === 'string') {
    out.description = redactBounded(data.description, PENDING_DESCRIPTION_MAX)
  }
  return out
}

/**
 * The pending requests of one session's in-process holder and of every BYOK subagent below it,
 * at any depth (iterative, with a visited set so a cycle ends). Returns true when the walk hit
 * `MAX_HOLDERS_PER_SESSION` with holders still unvisited: the read is then incomplete.
 */
function readInProcess(root, sessionId, add) {
  const seen = new Set()
  const queue = [root]
  let incomplete = false
  while (queue.length > 0) {
    const holder = queue.shift()
    if (holder == null || typeof holder !== 'object' || seen.has(holder)) continue
    if (seen.size >= MAX_HOLDERS_PER_SESSION) { incomplete = true; continue }
    seen.add(holder)
    const pendingMap = holder._pendingPermissions
    if (pendingMap instanceof Map) {
      const dataMap = holder._lastPermissionData instanceof Map ? holder._lastPermissionData : null
      for (const [requestId, pending] of pendingMap) {
        if (typeof requestId !== 'string') continue
        add(describeRequest({ requestId, sessionId, origin: 'in_process', pending, data: dataMap?.get(requestId) }))
      }
    }
    const routing = holder._subagentPermissionRouting
    if (routing instanceof Map) for (const child of new Set(routing.values())) queue.push(child)
  }
  return incomplete
}

/**
 * Read both pipelines for `sessionIds` at `now`.
 *
 * Every id must already have been checked against the principal's grant by the caller; this
 * function reads what it is told to and knows nothing about who is asking.
 *
 * @param {object} opts
 * @param {string[]} opts.sessionIds   granted, de-duplicated session ids
 * @param {{ getSession: (id: string) => any } | null} opts.sessionManager
 * @param {Map<string, any>} [opts.pendingPermissions]    the hook-routed store (requestId -> { data })
 * @param {Map<string, string>} [opts.permissionSessionMap] requestId -> owning session id
 * @param {number} [opts.now]
 * @param {number} [opts.max]
 * @returns {{ generatedAt: number, permissions: object[], truncated: boolean }}
 */
export function collectPendingPermissions({
  sessionIds, sessionManager, pendingPermissions, permissionSessionMap, now = Date.now(), max = PRINCIPAL_PENDING_PERMISSIONS_MAX,
}) {
  const wanted = new Set(sessionIds)
  const byRequest = new Map()
  let incomplete = false
  const add = (request) => {
    // One request id is one request: the in-process read goes first, so a hook entry that
    // somehow shares its id never replaces it.
    if (!byRequest.has(request.requestId)) byRequest.set(request.requestId, request)
  }

  for (const sessionId of wanted) {
    const entry = typeof sessionManager?.getSession === 'function' ? sessionManager.getSession(sessionId) : null
    if (readInProcess(entry?.session, sessionId, add)) incomplete = true
  }

  // Still O(total hook entries): the store has no per-session index (not needed at this size).
  if (wanted.size > 0 && pendingPermissions instanceof Map && permissionSessionMap instanceof Map) {
    for (const [requestId, pending] of pendingPermissions) {
      const owner = permissionSessionMap.get(requestId)
      if (typeof owner !== 'string' || !wanted.has(owner)) continue
      // A hook-routed AskUserQuestion is held here too, but it is a question with the user's
      // wording in it, not a permission request; the in-process pipeline keeps questions out
      // of this map as well, so the two pipelines agree (contract 7.3).
      if (pending?.data?.tool === 'AskUserQuestion') continue
      add(describeRequest({ requestId, sessionId: owner, origin: 'hook', pending, data: pending?.data }))
    }
  }

  // Excluded: a request whose own deadline is at or before the read. Its timer may not have
  // fired yet, and a request that can no longer be answered is not pending.
  const live = [...byRequest.values()].filter((r) => r.expiresAt === null || r.expiresAt > now)
  // Oldest first (closest to its deadline), unknown age last, ties by id: a stable order.
  live.sort((a, b) => {
    const ca = a.createdAt ?? Number.MAX_SAFE_INTEGER
    const cb = b.createdAt ?? Number.MAX_SAFE_INTEGER
    return ca !== cb ? ca - cb : a.requestId < b.requestId ? -1 : a.requestId > b.requestId ? 1 : 0
  })
  return { generatedAt: now, permissions: live.slice(0, max), truncated: incomplete || live.length > max }
}
