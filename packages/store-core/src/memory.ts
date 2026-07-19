/**
 * Shared logic for the `#`-prefix composer quick-append (#6861, epic #6760).
 *
 * A composer message that starts with `# ` (hash + a space) is a "memory
 * quick-append": instead of a chat turn, the note after the prefix is appended
 * to the session's project `CLAUDE.md`. This module is the single source of
 * truth BOTH clients (dashboard + mobile) use so the interception semantics and
 * the confirmation wording can't drift between them.
 *
 * Pure data + string logic only — no store, no wire, no platform imports — so
 * store-core vitest, the app jest suite, and the dashboard vitest suite can all
 * consume it from one place.
 */

/** Result of testing a composer draft for the `#`-quick-append prefix. */
export interface MemoryAppendParse {
  /** True when the draft is a memory quick-append command. */
  isMemory: boolean
  /** The note to append (prefix stripped, trimmed). Empty when `isMemory` is false. */
  note: string
}

/**
 * Detect the `#`-prefix quick-append in a composer draft.
 *
 * Matches the desktop-app semantics: the draft must be a SINGLE LINE that starts
 * with a `#` followed by at least one space/tab, and carry a non-empty note.
 * Deliberately strict so ordinary prose — and pasted documents — aren't hijacked:
 *   - `# remember X`  → memory append (note: "remember X")
 *   - `# Title\nbody` → NOT a command — a multi-line draft (even one opening with
 *                       a Markdown H1) is a normal chat turn; intercepting it
 *                       would collapse the body to one line and silently eat it.
 *   - `#`             → NOT a command (no note)
 *   - `#tag`          → NOT a command (no space after `#`)
 *   - `see #123`      → NOT a command (`#` is mid-text, not leading)
 *   - `#   ` (spaces) → NOT a command (empty note)
 *
 * The leading `#` must be the very first character — a leading space means the
 * user didn't start the line with the marker, so it stays a normal message.
 */
export function parseMemoryAppend(text: unknown): MemoryAppendParse {
  if (typeof text !== 'string') return { isMemory: false, note: '' }
  // Single-line drafts only: a multi-line message is always a normal chat turn.
  // (No dotAll flag AND an explicit newline guard — belt and suspenders, since a
  // Markdown-H1 spec/plan paste opening with `# ` must never be eaten as memory.)
  if (text.includes('\n')) return { isMemory: false, note: '' }
  const match = /^#[ \t]+(.+)$/.exec(text)
  const note = match?.[1]?.trim() ?? ''
  if (!note) return { isMemory: false, note: '' }
  return { isMemory: true, note }
}

/** Parsed payload for an `append_memory_result` ack. */
export interface AppendMemoryResultPayload {
  /** Absolute path the note landed in. Null on error / missing. */
  path: string | null
  /** Whether the server created the file (vs. appended to an existing one). */
  created: boolean
  /** Error string from the server, if any. Null on success. */
  error: string | null
}

/**
 * Parse an `append_memory_result` wire message into a normalised payload.
 * Mirrors the `handleWriteFileResult` shape (both are file-mutation acks).
 */
export function handleAppendMemoryResult(
  msg: Record<string, unknown>,
): AppendMemoryResultPayload {
  return {
    path: typeof msg.path === 'string' ? msg.path : null,
    created: msg.created === true,
    error: typeof msg.error === 'string' ? msg.error : null,
  }
}

/** Last path segment (handles both `/` and `\` separators). */
function basenameOf(p: string): string {
  const parts = p.split(/[/\\]/)
  return parts[parts.length - 1] || p
}

/**
 * Format the transcript confirmation shown after a quick-append. Honest about
 * WHICH file the note landed in (the project `CLAUDE.md`) and whether it was
 * created. Shared so both clients render byte-identical text (pinned by the
 * behavioural-contract fixture).
 */
export function formatMemoryAppendNotice(payload: AppendMemoryResultPayload): string {
  if (payload.error) return `Couldn't save to memory: ${payload.error}`
  const file = payload.path ? basenameOf(payload.path) : 'CLAUDE.md'
  return payload.created
    ? `Created ${file} and saved your note.`
    : `Saved your note to ${file}.`
}
