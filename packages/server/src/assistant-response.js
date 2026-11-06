import { MAX_DECLARATION_MESSAGE_CHARS } from './declared-status.js'
import { outcomeFromSdkResult } from './turn-outcome.js'

/** Preserve complete message identity without retaining a second raw buffer. */
export function assistantResponseText(content) {
  if (typeof content === 'string') return content.length <= MAX_DECLARATION_MESSAGE_CHARS ? content : null
  if (!Array.isArray(content)) return null
  const parts = []
  let length = 0
  for (const block of content) {
    if (block?.type !== 'text' || typeof block.text !== 'string') continue
    length += block.text.length
    if (length > MAX_DECLARATION_MESSAGE_CHARS) return null
    parts.push(block.text)
  }
  return parts.join('')
}

/** Declaration eligibility is distinct from user-visible turn outcomes. */
export function sdkDeclarationEligible(result) {
  const outcome = outcomeFromSdkResult(result)
  return result?.is_error !== true && result?.subtype === 'success'
    && (!outcome || outcome === 'completed')
}
