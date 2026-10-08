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

export function permissionInputText(
  tool: string | undefined | null,
  toolInput: Record<string, unknown> | null | undefined,
): string | null {
  if (!toolInput || shouldSuppressRawToolInput(tool)) return null
  const command = toolInput.command
  let text: string
  if (typeof command === 'string' && command.length > 0) {
    text = command
  } else {
    try {
      text = JSON.stringify(toolInput, null, 2) ?? ''
    } catch {
      return null
    }
  }
  if (text === '' || text === '{}') return null
  return text.length > PERMISSION_INPUT_MAX_CHARS
    ? `${text.slice(0, PERMISSION_INPUT_MAX_CHARS)}… (truncated)`
    : text
}
