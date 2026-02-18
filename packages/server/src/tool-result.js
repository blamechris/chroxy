// Max size for tool results forwarded to mobile (10KB)
const MAX_TOOL_RESULT_SIZE = 10240

/**
 * Extract tool_result events from a user-role message's content blocks.
 * Used by both CliSession and SdkSession to avoid duplicating the parsing logic.
 *
 * @param {Array} content - The message.content array from a user-role event
 * @param {EventEmitter} emitter - Session instance to emit tool_result events on
 * @param {number} [maxSize] - Optional override for max result size
 */
export function emitToolResults(content, emitter, maxSize = MAX_TOOL_RESULT_SIZE) {
  if (!Array.isArray(content)) return

  for (const block of content) {
    if (block.type !== 'tool_result' || !block.tool_use_id) continue

    let result = ''
    if (typeof block.content === 'string') {
      result = block.content
    } else if (Array.isArray(block.content)) {
      result = block.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')
    }

    const truncated = result.length > maxSize
    if (truncated) {
      result = result.slice(0, maxSize)
    }

    emitter.emit('tool_result', {
      toolUseId: block.tool_use_id,
      result,
      truncated,
    })
  }
}
