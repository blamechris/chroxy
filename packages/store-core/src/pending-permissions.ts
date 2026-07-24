/**
 * Pending-permission derivation — the single source of truth for "which
 * sessions / messages have a live, unanswered permission prompt", shared by
 * both clients (#5759).
 *
 * Before this module the predicate lived in three places that all operated on
 * the same shared `ChatMessage`: the dashboard's `utils/pendingPermissions.ts`
 * (#5667/#5693) and two app copies (`SessionPicker.countLivePermissionPrompts`
 * and `usePermissionAnnouncer`, #5750). If the rule drifted on one side the two
 * clients would silently disagree on what counts as "waiting" — the exact
 * cross-client drift the 2026-06-13 audit flagged. The dashboard util now
 * re-exports from here; the app imports from here.
 *
 * A session/message counts as a *live permission prompt* iff it is a
 * `type: 'prompt'` message with a `requestId`, a future `expiresAt`, and no
 * `answered` decision:
 *   - `requestId` + `expiresAt` distinguish a *permission* prompt from an
 *     AskUserQuestion prompt (also `type:'prompt'` but carrying neither), so
 *     questions never trip the indicator.
 *   - `expiresAt > now` clears it once the prompt has timed out — the
 *     `permission_expired` / `permission_timeout` handlers clear the prompt's
 *     `options` but do NOT set `answered`, so without the expiry check an
 *     ignored prompt would leave the indicator stuck on.
 *   - `!answered` clears it the moment the user allows/denies.
 */
import type { ChatMessage } from './types'

/** True iff `m` is a live, unanswered permission prompt (not an AskUserQuestion). */
export function isLivePermissionPrompt(m: ChatMessage, now: number): boolean {
  return (
    m.type === 'prompt' &&
    !!m.requestId &&
    !!m.expiresAt &&
    m.expiresAt > now &&
    !m.answered
  )
}

/** The first live, unanswered permission prompt in `messages`, or null. */
export function firstLivePermissionPrompt(messages: ChatMessage[], now: number): ChatMessage | null {
  for (const m of messages) {
    if (isLivePermissionPrompt(m, now)) return m
  }
  return null
}

/** All live, unanswered permission prompts in `messages`, in order. */
export function livePermissionPrompts(messages: ChatMessage[], now: number): ChatMessage[] {
  return messages.filter((m) => isLivePermissionPrompt(m, now))
}

/** Count of live, unanswered permission prompts in `messages`. */
export function countLivePermissionPrompts(messages: ChatMessage[], now: number): number {
  let count = 0
  for (const m of messages) {
    if (isLivePermissionPrompt(m, now)) count++
  }
  return count
}

/**
 * #5693 (PR-3) — count the live, unanswered permission prompts in EACH session.
 * Sessions with zero pending are omitted (so a `useShallow` selector re-renders
 * a tab only when its count changes). Does NOT early-exit — a session can hold
 * more than one pending permission (parallel SDK tool calls), and the count is
 * the point. Pending permissions are few, so the full scan is cheap.
 */
export function derivePendingPermissionCounts(
  sessionStates: Record<string, { messages: ChatMessage[] }>,
  now: number,
): Record<string, number> {
  const out: Record<string, number> = {}
  for (const id in sessionStates) {
    const count = countLivePermissionPrompts(sessionStates[id]!.messages, now)
    if (count > 0) out[id] = count
  }
  return out
}

/**
 * #5667 — which sessions have at least one live unanswered permission prompt.
 * Thin boolean view over {@link derivePendingPermissionCounts}.
 */
export function derivePendingPermissionSessions(
  sessionStates: Record<string, { messages: ChatMessage[] }>,
  now: number,
): Record<string, true> {
  const counts = derivePendingPermissionCounts(sessionStates, now)
  const out: Record<string, true> = {}
  for (const id in counts) out[id] = true
  return out
}

/** Total live pending permissions across all sessions. */
export function totalPendingPermissions(counts: Record<string, number>): number {
  let total = 0
  for (const id in counts) total += counts[id]!
  return total
}

/**
 * #5693 (PR-3) — pick the next session (in visual tab order) that has a pending
 * permission, scanning cyclically AFTER the active tab so repeated "jump to
 * pending" clicks cycle through every waiting session. Returns null when none
 * are pending. If the active tab is the only one pending, returns it (a no-op
 * focus). If `activeSessionId` isn't in the list, scans from the start.
 */
export function selectNextPendingSession(
  orderedSessionIds: string[],
  counts: Record<string, number>,
  activeSessionId: string | null,
): string | null {
  const hasPending = (id: string) => (counts[id] ?? 0) > 0
  const n = orderedSessionIds.length
  if (n === 0 || !orderedSessionIds.some(hasPending)) return null
  const activeIndex = activeSessionId ? orderedSessionIds.indexOf(activeSessionId) : -1
  const from = activeIndex < 0 ? -1 : activeIndex
  for (let step = 1; step <= n; step++) {
    const id = orderedSessionIds[(from + step + n) % n]!
    if (hasPending(id)) return id
  }
  return null
}

/**
 * #6859 (IDE P3.3 follow-up of #6857/#6544) — viewer↔pending-write
 * correlation, hoisted out of two byte-identical copies in the dashboard's and
 * app's `ViewerPreWriteReview.tsx`. Safety-relevant for the same reason
 * `isLivePermissionPrompt` above lives here (#5759): a divergence in the match
 * logic could correlate the WRONG pending write to the file open in the
 * viewer — approving one file's write believing it's another's.
 *
 * `isReviewableTool` (which tools have a per-hunk diff review) stays owned by
 * each client's local `PreWriteDiffReview.tsx` — it's a presentation concern,
 * not a correlation one — so `findPendingWriteForFile` takes it as an injected
 * predicate rather than pulling `TOOL_DIFF` in here too.
 */

/**
 * Tolerant path match between a permission's `file_path` and the viewer's open
 * file. Claude passes an ABSOLUTE `file_path` for Write/Edit; the viewer's
 * selection is absolute (a file-tree click) OR workspace-relative (a symbol
 * jump), so compare tolerantly — an exact match, or one path tail-matching the
 * other. Both nulls => no match (nothing to correlate).
 */
export function pathMatchesViewer(filePath: string | null | undefined, viewed: string | null): boolean {
  if (!filePath || !viewed) return false
  const a = filePath.replace(/\\/g, '/')
  const b = viewed.replace(/\\/g, '/')
  if (a === b) return true
  const tail = (p: string) => p.replace(/^\.?\//, '')
  return a.endsWith('/' + tail(b)) || b.endsWith('/' + tail(a))
}

/**
 * The first live, reviewable (Write/Edit) permission whose target `file_path`
 * matches the file open in the viewer — or null. Pure so it's unit-testable
 * without a store. `now` gates the expiry inside `isLivePermissionPrompt`.
 */
export function findPendingWriteForFile(
  messages: ChatMessage[],
  viewed: string | null,
  now: number,
  isReviewableTool: (tool: string) => boolean,
): ChatMessage | null {
  if (!viewed) return null
  for (const m of messages) {
    if (!isLivePermissionPrompt(m, now)) continue
    if (!m.tool || !isReviewableTool(m.tool)) continue
    const fp = m.toolInput && typeof m.toolInput.file_path === 'string' ? (m.toolInput.file_path as string) : null
    if (pathMatchesViewer(fp, viewed)) return m
  }
  return null
}
