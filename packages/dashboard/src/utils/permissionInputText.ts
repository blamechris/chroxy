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
 * The scalar fields that sit beside a command and change what it does
 * (`dangerouslyDisableSandbox`, `run_in_background`, `timeout`, ...), one
 * `key: value` line each. `false`, empty and non-scalar values are omitted so a
 * plain command stays a plain command. The group key separates prompts that differ
 * in these, so the text must show them or two "identical" lines would differ.
 */
function flagLines(toolInput: Record<string, unknown>): string[] {
  const lines: string[] = []
  for (const [key, value] of Object.entries(toolInput)) {
    if (NOT_A_FLAG.has(key)) continue
    if (value === true || (typeof value === 'number' && Number.isFinite(value))) {
      lines.push(`${key}: ${value}`)
    } else if (typeof value === 'string' && value.length > 0 && value.length <= 200) {
      lines.push(`${key}: ${value}`)
    }
  }
  return lines
}

/** Cut at the cap without leaving the first half of a surrogate pair (an emoji) before the marker. */
function truncate(text: string): string {
  if (text.length <= PERMISSION_INPUT_MAX_CHARS) return text
  let end = PERMISSION_INPUT_MAX_CHARS
  const last = text.charCodeAt(end - 1)
  if (last >= 0xd800 && last <= 0xdbff) end--
  return `${text.slice(0, end)}… (truncated)`
}

export function permissionInputText(
  tool: string | undefined | null,
  toolInput: Record<string, unknown> | null | undefined,
): string | null {
  if (!toolInput || shouldSuppressRawToolInput(tool)) return null
  const command = toolInput.command
  let text: string
  if (typeof command === 'string' && command.length > 0) {
    text = [command, ...flagLines(toolInput)].join('\n')
  } else {
    try {
      text = JSON.stringify(toolInput, null, 2) ?? ''
    } catch {
      return null
    }
  }
  if (text === '' || text === '{}') return null
  return truncate(text)
}
