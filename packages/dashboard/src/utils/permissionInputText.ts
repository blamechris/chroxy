/**
 * The text of the tool input an audit record shows (#6894), so the operator sees
 * WHAT was approved ("touch smoke-perm.txt") and not only the rationale the agent
 * gave for it ("Touch smoke file").
 *
 * Source is the message's `toolInput`: the server's `permission_request.input`,
 * already run through `sanitizeToolInput` before it is broadcast. This only
 * chooses and bounds the text. Callers render the result as a TEXT NODE, never as
 * HTML.
 *
 * Nothing is shown for a tool whose raw input is suppressed everywhere in chat
 * (`shouldSuppressRawToolInput`: AskUserQuestion has its own card).
 */
import { shouldSuppressRawToolInput } from '@chroxy/store-core'

/** Cap on the characters shown. The broadcast input is itself capped near 10K; an audit line needs the head, not the lot. */
export const PERMISSION_INPUT_MAX_CHARS = 1000

/** Keys shown elsewhere (the command is the headline; the rationale is the record's own description). */
const NOT_A_FLAG = new Set(['command', 'description'])

/**
 * Flags that change the execution boundary of the command, rendered BEFORE it
 * (#8505) in this fixed order: the compact group line clamps to two lines and the
 * body is cut at the cap, so anything after the command can be hidden by either.
 * `dangerouslyDisableSandbox` runs the command outside the sandbox;
 * `run_in_background` detaches it from the turn that was approved. Every other flag
 * (`timeout`, ...) keeps its key order after the command.
 */
export const SAFETY_FLAG_KEYS = ['dangerouslyDisableSandbox', 'run_in_background'] as const

/** Bound on a flag's key and on a scalar string value; longer strings render as a placeholder. */
const FLAG_KEY_MAX_CHARS = 80
const FLAG_VALUE_MAX_CHARS = 200
/**
 * A safety flag's string value on the compact (clamped) group line: short enough
 * that BOTH safety lines and the command fit in two lines. The record detail keeps
 * the full bounded value.
 */
const COMPACT_SAFETY_VALUE_MAX_CHARS = 60

export interface PermissionInputOptions {
  /** The two-line group line: cut a long safety-flag string so every safety line stays on one line. */
  compact?: boolean
}

export interface PermissionInputParts {
  /** `key: value` lines for the safety-relevant flags, in `SAFETY_FLAG_KEYS` order. Rendered first, set apart. */
  safetyFlags: string[]
  /** The command (or pretty JSON) followed by the remaining flags, cut at the cap. */
  body: string
}

/**
 * Characters that render as nothing or reorder what is around them: bidi
 * embeddings/overrides/isolates and marks (U+202A-202E, U+2066-2069, U+200E/200F,
 * U+061C), zero-width and invisible-operator characters (U+200B-200D, U+2060-2064,
 * U+180E, U+FEFF), C1 controls (U+0080-009F) and tag characters (U+E0000-E007F).
 * An RLO before "eslaf" would DISPLAY as "false".
 */
const HIDDEN_CHARS = /[\u0080-\u009f\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2064\u2066-\u2069\ufeff\u{e0000}-\u{e007f}]/gu

/** U+FFFD, the visible stand-in for a hidden character: its presence stays on the audit line. */
const HIDDEN_MARKER = '\ufffd'

/**
 * One visible line: a newline in a key or value must not be able to forge a second
 * flag line (C0, DEL, U+2028/2029 become a space), and a hidden or bidi character
 * is replaced by a visible marker (U+FFFD) instead of silently disguising the text.
 */
function oneLine(text: string): string {
  return text.replace(/[\u0000-\u001f\u007f\u2028\u2029]+/g, ' ').replace(HIDDEN_CHARS, HIDDEN_MARKER)
}

/**
 * The display value of one flag, or null to omit it. `false`, empty, null and
 * undefined are defaults, omitted so a plain command stays a plain command. An
 * object, an array or a long string is NOT dropped: it still separates the group
 * key, so it renders as a bounded placeholder.
 */
function flagValue(value: unknown, maxChars = FLAG_VALUE_MAX_CHARS): string | null {
  if (value === true) return 'true'
  if (typeof value === 'number') return Number.isFinite(value) ? String(value) : null
  if (typeof value === 'string') {
    if (value.length === 0) return null
    // Quoted (JSON-escaped) so a value can never read as a bare `key: value` flag of its own.
    if (value.length > FLAG_VALUE_MAX_CHARS) return '<string>'
    const line = oneLine(value)
    return JSON.stringify(line.length > maxChars ? `${line.slice(0, maxChars)}…` : line)
  }
  if (Array.isArray(value)) return '<array>'
  if (value !== null && typeof value === 'object') return '<object>'
  return null
}

function flagLine(key: string, value: unknown, maxChars?: number): string | null {
  const shown = flagValue(value, maxChars)
  if (shown === null) return null
  return `${oneLine(key.length > FLAG_KEY_MAX_CHARS ? `${key.slice(0, FLAG_KEY_MAX_CHARS)}…` : key)}: ${shown}`
}

const SAFETY_KEY_SET = new Set<string>(SAFETY_FLAG_KEYS)

function safetyFlagLines(toolInput: Record<string, unknown>, compact: boolean): string[] {
  const lines: string[] = []
  for (const key of SAFETY_FLAG_KEYS) {
    const line = flagLine(key, toolInput[key], compact ? COMPACT_SAFETY_VALUE_MAX_CHARS : undefined)
    if (line !== null) lines.push(line)
  }
  return lines
}

/**
 * The other fields that sit beside a command and change what it does (`timeout`,
 * ...), one `key: value` line each, in key order. The group key separates prompts
 * that differ in these, so the text must show them or two "identical" lines would
 * differ.
 */
function otherFlagLines(toolInput: Record<string, unknown>): string[] {
  const lines: string[] = []
  for (const [key, value] of Object.entries(toolInput)) {
    if (NOT_A_FLAG.has(key) || SAFETY_KEY_SET.has(key)) continue
    const line = flagLine(key, value)
    if (line !== null) lines.push(line)
  }
  return lines
}

/** Cut at the cap without leaving the first half of a surrogate pair (an emoji) before the marker. */
function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  let end = max
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return `${text.slice(0, end)}… (truncated)`
}

/**
 * The input split for rendering: the safety flags (styled apart by the caller) and
 * the body. The cap bounds safety lines + body together, but only the body is cut,
 * so a flag can never be the thing the cap removes.
 */
export function permissionInputParts(
  tool: string | undefined | null,
  toolInput: Record<string, unknown> | null | undefined,
  options: PermissionInputOptions = {},
): PermissionInputParts | null {
  if (!toolInput || shouldSuppressRawToolInput(tool)) return null
  const safetyFlags = safetyFlagLines(toolInput, options.compact === true)
  const command = toolInput.command
  let body: string
  if (typeof command === 'string' && command.length > 0) {
    body = [command, ...otherFlagLines(toolInput)].join('\n')
  } else {
    try {
      body = JSON.stringify(toolInput, null, 2) ?? ''
    } catch {
      return null
    }
  }
  if (body === '' || body === '{}') return null
  // Safety lines are at most two bounded lines, so the budget stays positive.
  const budget = Math.max(PERMISSION_INPUT_MAX_CHARS - safetyFlags.join('\n').length, 1)
  return { safetyFlags, body: truncate(body, budget) }
}

export function permissionInputText(
  tool: string | undefined | null,
  toolInput: Record<string, unknown> | null | undefined,
): string | null {
  const parts = permissionInputParts(tool, toolInput)
  if (!parts) return null
  return [...parts.safetyFlags, parts.body].join('\n')
}
