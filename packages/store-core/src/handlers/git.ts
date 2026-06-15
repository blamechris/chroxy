/**
 * Shared stateless handlers for git operation result messages
 * (diff_result / git_status_result / git_branches_result / git_stage_result /
 * git_unstage_result / git_commit_result).
 *
 * Extracted from the handlers barrel (audit P2-3) — pure move, no logic
 * change. Re-exported from ./index so the public surface is unchanged. See
 * the module-level doc in ./index.ts for the stateless-handler contract.
 */

import type {
  DiffFile,
  DiffHunk,
  DiffHunkLine,
  GitBranch,
  GitFileStatus,
} from '../types'

// ---------------------------------------------------------------------------
// Git operation results (diff_result / git_status_result / git_branches_result /
// git_stage_result / git_unstage_result / git_commit_result)
//
// All five share the callback-style shape: parse the wire payload into a
// normalized object, then the call site invokes the corresponding registered
// callback. The dashboard wires only `diff_result` and `git_status_result`
// today; the app wires all five (with stage/unstage sharing one handler since
// their payloads are identical — only `error`).
//
// Element types (`DiffFile`, `GitFileStatus`, `GitBranch`) live downstream in
// each consumer — the shared handlers keep entries as `unknown[]` to avoid
// pulling concrete types up into store-core. Per-element shape is NOT
// validated here; matches the inline `as DiffFile[]` casts both clients used
// prior to this migration. Tightening would be a behaviour change and is out
// of scope for the #2661 mechanical migration.
// ---------------------------------------------------------------------------

// Per-element validation helpers (#3132). Hand-rolled type guards, fail-soft:
// drop malformed elements rather than reject the whole payload. A debug log
// is emitted for each rejection so server-side regressions are visible in
// the browser/RN console.

const VALID_GIT_FILE_STATUSES: ReadonlySet<GitFileStatus['status']> = new Set([
  'modified',
  'added',
  'deleted',
  'renamed',
  'copied',
  'unknown',
])

const VALID_DIFF_STATUSES: ReadonlySet<DiffFile['status']> = new Set([
  'modified',
  'added',
  'deleted',
  'renamed',
  'untracked',
])

const VALID_DIFF_LINE_TYPES: ReadonlySet<DiffHunkLine['type']> = new Set([
  'context',
  'addition',
  'deletion',
])

function isGitFileStatus(v: unknown): v is GitFileStatus {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.path === 'string' &&
    typeof o.status === 'string' &&
    VALID_GIT_FILE_STATUSES.has(o.status as GitFileStatus['status'])
  )
}

function isGitBranch(v: unknown): v is GitBranch {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.name === 'string' &&
    typeof o.isCurrent === 'boolean' &&
    typeof o.isRemote === 'boolean'
  )
}

function isDiffHunkLine(v: unknown): v is DiffHunkLine {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  return (
    typeof o.type === 'string' &&
    VALID_DIFF_LINE_TYPES.has(o.type as DiffHunkLine['type']) &&
    typeof o.content === 'string'
  )
}

function isDiffHunk(v: unknown): v is DiffHunk {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (typeof o.header !== 'string') return false
  if (!Array.isArray(o.lines)) return false
  for (const line of o.lines) {
    if (!isDiffHunkLine(line)) return false
  }
  return true
}

function isDiffFile(v: unknown): v is DiffFile {
  if (typeof v !== 'object' || v === null) return false
  const o = v as Record<string, unknown>
  if (typeof o.path !== 'string') return false
  if (
    typeof o.status !== 'string' ||
    !VALID_DIFF_STATUSES.has(o.status as DiffFile['status'])
  ) {
    return false
  }
  if (typeof o.additions !== 'number') return false
  if (typeof o.deletions !== 'number') return false
  if (!Array.isArray(o.hunks)) return false
  for (const h of o.hunks) {
    if (!isDiffHunk(h)) return false
  }
  return true
}

/**
 * Drop malformed elements from `arr` using the supplied type guard. When ANY
 * element is rejected, logs a SINGLE `console.debug` message with the
 * dropped/total count so server-side regressions are visible without
 * throwing. Element values themselves are intentionally NOT logged to avoid
 * leaking large/sensitive payloads.
 *
 * #3184: aggregated rather than per-element. A pathological case (e.g. a
 * 1000-file diff where every entry is malformed because of a server-side
 * regression) previously emitted 1000 lines per payload to the
 * Metro/Vite/browser console. The aggregated form gives operators the same
 * signal (count + handler name) at bounded cost.
 */
function validateGitElements<T>(
  arr: unknown[],
  isValid: (v: unknown) => v is T,
  handlerName: string,
): T[] {
  const out: T[] = []
  let dropped = 0
  for (let i = 0; i < arr.length; i++) {
    const elem = arr[i]
    if (isValid(elem)) {
      out.push(elem)
    } else {
      dropped++
    }
  }
  if (dropped > 0) {
    // eslint-disable-next-line no-console
    console.debug(`[${handlerName}] dropped ${dropped}/${arr.length} malformed elements`)
  }
  return out
}

/** Parsed payload from a `diff_result` message. */
export interface DiffResultPayload {
  /** Validated file entries (#3132). Malformed elements are dropped fail-soft. */
  files: DiffFile[]
  /** Error string from the server, or null when missing/non-string. */
  error: string | null
}

/**
 * Parse a `diff_result` message.
 *
 * Per-element validation added in #3132 — `files` entries that fail the
 * `DiffFile` shape guard are dropped fail-soft (with a `console.debug`
 * message). The `error` string passes through verbatim when present.
 */
export function handleDiffResult(msg: Record<string, unknown>): DiffResultPayload {
  const rawFiles = Array.isArray(msg.files) ? (msg.files as unknown[]) : []
  return {
    files: validateGitElements(rawFiles, isDiffFile, 'handleDiffResult.files'),
    error: typeof msg.error === 'string' ? msg.error : null,
  }
}

/** Parsed payload from a `git_status_result` message. */
export interface GitStatusResultPayload {
  /** Current branch name, or null when missing/non-string. */
  branch: string | null
  /** Validated staged file entries (#3132). Malformed elements are dropped fail-soft. */
  staged: GitFileStatus[]
  /** Validated unstaged file entries (#3132). Malformed elements are dropped fail-soft. */
  unstaged: GitFileStatus[]
  /** Untracked file paths — validated as array of strings (#3132). Non-strings dropped. */
  untracked: string[]
  /** Error string from the server, or null when missing/non-string. */
  error: string | null
}

/**
 * Parse a `git_status_result` message.
 *
 * Behaviour-preserving for `branch` and `error`: bare `typeof === 'string'`
 * guard (no trim, empty strings preserved verbatim) to match the prior inline
 * guards in both clients.
 *
 * Per-element validation added in #3132 — `staged`, `unstaged`, and
 * `untracked` entries that fail their type guards are dropped fail-soft.
 */
export function handleGitStatusResult(
  msg: Record<string, unknown>,
): GitStatusResultPayload {
  const rawStaged = Array.isArray(msg.staged) ? (msg.staged as unknown[]) : []
  const rawUnstaged = Array.isArray(msg.unstaged) ? (msg.unstaged as unknown[]) : []
  const rawUntracked = Array.isArray(msg.untracked)
    ? (msg.untracked as unknown[])
    : []
  return {
    branch: typeof msg.branch === 'string' ? msg.branch : null,
    staged: validateGitElements(rawStaged, isGitFileStatus, 'handleGitStatusResult.staged'),
    unstaged: validateGitElements(rawUnstaged, isGitFileStatus, 'handleGitStatusResult.unstaged'),
    untracked: validateGitElements(
      rawUntracked,
      (v): v is string => typeof v === 'string',
      'handleGitStatusResult.untracked',
    ),
    error: typeof msg.error === 'string' ? msg.error : null,
  }
}

/** Parsed payload from a `git_branches_result` message (app-only today). */
export interface GitBranchesResultPayload {
  /** Validated branch entries (#3132). Malformed elements are dropped fail-soft. */
  branches: GitBranch[]
  /** Currently checked-out branch name, or null when missing/non-string. */
  currentBranch: string | null
  /** Error string from the server, or null when missing/non-string. */
  error: string | null
}

/**
 * Parse a `git_branches_result` message.
 *
 * App-only handler today (the dashboard does not subscribe to git branches).
 * Extracted here so the dashboard can adopt the same parser later.
 *
 * Per-element validation added in #3132 — `branches` entries that fail the
 * `GitBranch` shape guard are dropped fail-soft.
 */
export function handleGitBranchesResult(
  msg: Record<string, unknown>,
): GitBranchesResultPayload {
  const rawBranches = Array.isArray(msg.branches)
    ? (msg.branches as unknown[])
    : []
  return {
    branches: validateGitElements(
      rawBranches,
      isGitBranch,
      'handleGitBranchesResult.branches',
    ),
    currentBranch: typeof msg.currentBranch === 'string' ? msg.currentBranch : null,
    error: typeof msg.error === 'string' ? msg.error : null,
  }
}

/**
 * Parsed payload from a `git_stage_result` or `git_unstage_result` message.
 *
 * Both messages share the same shape: only an optional `error` string. The
 * call site dispatches both cases to the same callback (`getCallback('gitStage')`).
 */
export interface GitStageResultPayload {
  /** Error string from the server, or null when missing/non-string. */
  error: string | null
}

/**
 * Parse a `git_stage_result` or `git_unstage_result` message.
 *
 * App-only today; both message types share this handler since the payloads
 * are identical.
 */
export function handleGitStageResult(
  msg: Record<string, unknown>,
): GitStageResultPayload {
  return {
    error: typeof msg.error === 'string' ? msg.error : null,
  }
}

/** Parsed payload from a `git_commit_result` message (app-only today). */
export interface GitCommitResultPayload {
  /** Newly created commit hash, or null when missing/non-string. */
  hash: string | null
  /** Commit message echoed by the server, or null when missing/non-string. */
  message: string | null
  /** Error string from the server, or null when missing/non-string. */
  error: string | null
}

/**
 * Parse a `git_commit_result` message.
 *
 * App-only handler today. Behaviour-preserving: bare `typeof === 'string'`
 * checks (no trim, empty strings preserved verbatim) matching the inline
 * guards in the app prior to this migration.
 */
export function handleGitCommitResult(
  msg: Record<string, unknown>,
): GitCommitResultPayload {
  return {
    hash: typeof msg.hash === 'string' ? msg.hash : null,
    message: typeof msg.message === 'string' ? msg.message : null,
    error: typeof msg.error === 'string' ? msg.error : null,
  }
}

