/**
 * #4307 — helpers for tracking `Bash` tool calls dispatched with
 * `run_in_background: true`. Both SdkSession (assistant tool_use →
 * user tool_result) and ClaudeTuiSession (PreToolUse hook → PostToolUse
 * hook) flow their inputs / results through a small parsing surface so
 * BaseSession can record the resulting shell id and survive turn-end.
 *
 * The canonical tool_result text Claude emits when a Bash call returns
 * with `run_in_background: true` is:
 *
 *   "Command running in background with ID: brk57kt6pm. Output is being
 *    written to: /private/tmp/claude-501/…/tasks/br57k6pm.output. You
 *    will be notified when it completes."
 *
 * We do not depend on the format of the surrounding sentence — only on
 * the canonical `Command running in background with ID: <token>` opener,
 * which has been stable across the claude versions chroxy targets.
 *
 * #4417: the pending-shells map populated via these helpers lives in
 * memory only and is intentionally NOT persisted across server
 * restart. See `BaseSession._pendingBackgroundShells` for the full
 * rationale — short version: the OS-level shells are owned by claude,
 * not chroxy, so a restored map would be stale and the activity
 * indicator would lie. Dropping the map on restart is the safe choice.
 */

// `[A-Za-z0-9_-]+` is intentionally tight — every shell id observed so
// far is short alphanumeric (`brk57kt6pm`). A non-whitespace match would
// also swallow a trailing period or sentence-end punctuation. Keep this
// narrow: malformed payloads return null and the wait is invisible.
const SHELL_ID_RE = /Command running in background with ID:\s+([A-Za-z0-9_-]+)/

// #5177: the canonical tool_result also names the file claude tails the
// background command's stdout/stderr into:
//
//   "Output is being written to: /private/tmp/claude-501/…/tasks/<id>.output"
//
// We capture the path so the periodic sweep (see BaseSession) can observe
// the shell's completion WITHOUT the agent ever calling `BashOutput`: a
// finished command stops appending to this file, so a quiesced mtime is a
// reap signal. Match a run of non-whitespace after the colon — the path is
// always a single token and any trailing sentence punctuation (". You will
// be notified…") is whitespace-separated. Strip a single trailing period
// defensively in case a future claude build drops the space before it.
const SHELL_OUTPUT_PATH_RE = /Output is being written to:\s+(\S+)/

/**
 * Parse the shell id from a tool_result text. Returns the id when the
 * canonical pattern matches, else null.
 *
 * Defensive against non-string / empty inputs so callers can hand the
 * raw `tool_result.result` field through without pre-checking.
 *
 * @param {unknown} text
 * @returns {string | null}
 */
export function parseBackgroundShellId(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const m = SHELL_ID_RE.exec(text)
  return m ? m[1] : null
}

/**
 * #5177: parse the output file path from a tool_result text. Returns the
 * path when the canonical `Output is being written to: <path>` pattern
 * matches, else null. A single trailing period is stripped so a build that
 * emits `…<id>.output.` (no space before the sentence end) still yields a
 * clean path.
 *
 * Defensive against non-string / empty inputs so callers can hand the raw
 * `tool_result.result` field through without pre-checking. Returning null
 * is non-fatal: the shell is still tracked, the sweep just can't reap it
 * via the output file and falls back to the BashOutput / destroy paths.
 *
 * @param {unknown} text
 * @returns {string | null}
 */
export function parseBackgroundShellOutputPath(text) {
  if (typeof text !== 'string' || text.length === 0) return null
  const m = SHELL_OUTPUT_PATH_RE.exec(text)
  if (!m) return null
  return m[1].replace(/\.$/, '')
}

/**
 * Returns true when a tool_use block represents a Bash call dispatched
 * with `run_in_background: true`. Used by providers to stash the
 * command text against the tool_use_id so the matching tool_result can
 * record it with its shell id.
 *
 * Strict-boolean on the `run_in_background` field — a malformed input
 * (truthy non-bool) is rejected so a buggy SDK payload can't poison the
 * pending map with a non-background call.
 *
 * @param {string} toolName
 * @param {unknown} input
 * @returns {boolean}
 */
export function isRunInBackgroundInput(toolName, input) {
  if (toolName !== 'Bash') return false
  if (!input || typeof input !== 'object') return false
  return input.run_in_background === true
}

/**
 * Returns true when a tool_use block represents a `BashOutput` poll. The
 * `bash_id` field identifies the shell whose pending entry should clear
 * — the agent calling BashOutput means it has seen the completion (or
 * is at least aware of the shell), so we drop the entry. If the same
 * shell is still incomplete the agent will poll again later; recording
 * a fresh entry would require parsing claude's BashOutput response
 * format and is intentionally out of scope (issue #4307 documents
 * BashOutput as the canonical clear signal).
 *
 * @param {string} toolName
 * @param {unknown} input
 * @returns {string | null} bash_id when this is a BashOutput call, else null
 */
export function parseBashOutputShellId(toolName, input) {
  if (toolName !== 'BashOutput') return null
  if (!input || typeof input !== 'object') return null
  const id = input.bash_id
  if (typeof id !== 'string' || id.length === 0) return null
  return id
}
