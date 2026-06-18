/**
 * Web-task + search handlers (audit P2-3 split).
 *
 * Parsers for the Claude Code Web feature: `web_task_created` /
 * `web_task_updated` (shared upsert + `applyWebTaskUpsert`), `web_task_error`,
 * `web_task_list`, `web_feature_status`, and the conversation `search_results`
 * stale-query guard. All side effects (state writes, ChatMessage allocation)
 * stay at the call site; these only normalise the wire payload.
 *
 * Re-exported from ./index (the barrel) so the public surface is unchanged.
 */

import type { SearchResult, WebTask } from '../types'

// ---------------------------------------------------------------------------
// web_task_created / web_task_updated (shared upsert)
//
// Both messages carry a single `task` payload that should replace any existing
// task with the same `taskId`. The handler extracts the validated task; the
// caller performs the filter-and-append against its own `webTasks` list so
// the dedup semantics stay identical across consumers.
// ---------------------------------------------------------------------------

export interface WebTaskUpsertPayload {
  /** The validated task to upsert, or null when the message is malformed. */
  task: WebTask | null
}

/**
 * Validate and extract the task from a `web_task_created` or `web_task_updated`
 * message.
 *
 * Returns `{ task: null }` when:
 * - `msg.task` is missing or not a non-null object
 * - `task.taskId` is missing or not a non-empty string
 *
 * Otherwise returns the task as-is. The element type stays downstream — the
 * runtime check above is only on `taskId`, matching the prior inline behaviour.
 */
export function handleWebTaskUpsert(
  msg: Record<string, unknown>,
): WebTaskUpsertPayload {
  const task = msg.task
  if (!task || typeof task !== 'object') return { task: null }
  const taskId = (task as { taskId?: unknown }).taskId
  if (typeof taskId !== 'string' || taskId.length === 0) return { task: null }
  return { task: task as WebTask }
}

/**
 * Filter-and-append upsert against an existing `webTasks` list (#5556 slice 4).
 * Drops any existing task with the same `taskId`, then appends `task` at the
 * end — exactly the `state.webTasks.filter(t => t.taskId !== task.taskId)`
 * then-spread the app and dashboard both performed inline. Both clients were
 * byte-identical here, so this is the shared body the dispatch handler runs.
 */
export function applyWebTaskUpsert(existing: WebTask[], task: WebTask): WebTask[] {
  const kept = existing.filter((t) => t.taskId !== task.taskId)
  return [...kept, task]
}

// ---------------------------------------------------------------------------
// web_task_error
//
// Server-emitted failure for a web task. The shared handler extracts the
// taskId, the user-visible error text, the optional error code, and the
// optional bound-session name; it also pre-builds the system ChatMessage.
// Callers decide the side-effects: the app shows a Disconnect Alert when a
// SESSION_TOKEN_MISMATCH carries a `boundSessionName` and skips dispatching
// the chat message; the dashboard always dispatches the chat message.
// ---------------------------------------------------------------------------

export interface WebTaskErrorPayload {
  /** Validated taskId for the failed task, or null when missing. */
  taskId: string | null
  /**
   * Failure text to apply to the matching task's `error` field. Defaults to
   * `'Unknown error'` when the message is missing or non-string.
   */
  errorMessage: string
  /**
   * Normalized chat content for the optional system ChatMessage. Defaults to
   * `'Web task error'` when the message is missing or non-string. The caller
   * builds the ChatMessage (allocating id + timestamp) only when it will
   * actually dispatch — the app's SESSION_TOKEN_MISMATCH-with-boundSessionName
   * branch short-circuits to an Alert and never builds the message.
   */
  chatMessageContent: string
  /** Optional error code (e.g. `'SESSION_TOKEN_MISMATCH'`). */
  code: string | null
  /** Optional bound session name for the SESSION_TOKEN_MISMATCH branch. */
  boundSessionName: string | null
}

/**
 * Normalize a `web_task_error` message.
 *
 * - `taskId`: string pass-through; null when missing, non-string, or empty.
 * - `errorMessage`: `msg.message` when a non-empty string, else
 *   `'Unknown error'`. Used by the caller to update the matching task's
 *   `error` field.
 * - `chatMessageContent`: `msg.message` when a non-empty string, else
 *   `'Web task error'`. The caller wraps this in a system-typed ChatMessage
 *   (allocating id + timestamp) only when it actually dispatches the message
 *   — the app's SESSION_TOKEN_MISMATCH-with-boundSessionName branch
 *   short-circuits to an Alert and skips dispatch (and the construction).
 * - `code`: string pass-through; null when missing or non-string.
 * - `boundSessionName`: string pass-through; null when missing, non-string,
 *   or empty.
 */
export function handleWebTaskError(
  msg: Record<string, unknown>,
): WebTaskErrorPayload {
  const taskId =
    typeof msg.taskId === 'string' && (msg.taskId as string).length > 0
      ? (msg.taskId as string)
      : null
  const messageText =
    typeof msg.message === 'string' && (msg.message as string).length > 0
      ? (msg.message as string)
      : null
  const errorMessage = messageText ?? 'Unknown error'
  const code = typeof msg.code === 'string' ? (msg.code as string) : null
  const boundSessionName =
    typeof msg.boundSessionName === 'string' &&
    (msg.boundSessionName as string).length > 0
      ? (msg.boundSessionName as string)
      : null
  const chatMessageContent = messageText ?? 'Web task error'
  return { taskId, errorMessage, chatMessageContent, code, boundSessionName }
}

// ---------------------------------------------------------------------------
// web_task_list
//
// Server emits the full webTasks list. Caller replaces its `webTasks` state
// wholesale. Element type stays at the call site (`tasks as WebTask[]`).
// ---------------------------------------------------------------------------

export interface WebTaskListPayload {
  tasks: unknown[]
}

/** Extract the tasks array from a `web_task_list` message; defaults to `[]`. */
export function handleWebTaskList(
  msg: Record<string, unknown>,
): WebTaskListPayload {
  return { tasks: Array.isArray(msg.tasks) ? (msg.tasks as unknown[]) : [] }
}

// ---------------------------------------------------------------------------
// web_feature_status
//
// Server reports availability flags for the Claude Code Web feature. All
// three booleans are coerced via `!!` to preserve the prior inline behaviour
// (truthy non-booleans become `true`, missing/falsy become `false`).
// ---------------------------------------------------------------------------

export interface WebFeatureStatusPayload {
  webFeatures: {
    available: boolean
    remote: boolean
    teleport: boolean
  }
}

/**
 * Coerce the three boolean fields of a `web_feature_status` message into the
 * `webFeatures` state patch. Missing fields default to `false`.
 */
export function handleWebFeatureStatus(
  msg: Record<string, unknown>,
): WebFeatureStatusPayload {
  return {
    webFeatures: {
      available: !!msg.available,
      remote: !!msg.remote,
      teleport: !!msg.teleport,
    },
  }
}

// ---------------------------------------------------------------------------
// search_results
//
// Server emits search results in response to a search query. The shared
// handler validates the array shape and applies the stale-query guard so the
// client does not overwrite newer results with a late response. Callers do
// the platform-specific `set(...)` (the app additionally clears `searchError`
// and mirrors the results into `useConversationStore`).
// ---------------------------------------------------------------------------

export interface SearchResultsPayload {
  /**
   * Validated results array (non-array `msg.results` defaults to `[]`).
   * Typed as `SearchResult[]` (#3146) — per-element shape is NOT validated;
   * the cast trusts the wire format. Always defined; meaningful only when
   * `shouldApply` is `true`.
   */
  results: SearchResult[]
  /**
   * Whether the caller should apply the results. Returns `false` when the
   * server-echoed `query` no longer matches the current in-flight `query`,
   * preserving the prior inline stale-response guard.
   */
  shouldApply: boolean
}

/**
 * Validate and stale-check a `search_results` message.
 *
 * - `results`: pass-through when `msg.results` is an array, else `[]`.
 * - `shouldApply`:
 *   - `false` only when the message included a non-null `query` AND the
 *     current in-flight `currentQuery` is truthy AND the two strings differ.
 *   - `true` otherwise — including when the message omits `query` (broadcast)
 *     or when the client has already cleared its `currentQuery` (no in-flight
 *     query to be stale against).
 *
 * Callers use the boolean to short-circuit before applying state. The handler
 * does not mutate or clone the array; the original reference is returned.
 */
export function handleSearchResults(
  msg: Record<string, unknown>,
  currentQuery: string | null,
): SearchResultsPayload {
  const results: SearchResult[] = Array.isArray(msg.results)
    ? (msg.results as SearchResult[])
    : []
  const msgQuery: string | null =
    typeof msg.query === 'string' ? (msg.query as string) : null
  if (msgQuery !== null && currentQuery && msgQuery !== currentQuery) {
    return { results, shouldApply: false }
  }
  return { results, shouldApply: true }
}
