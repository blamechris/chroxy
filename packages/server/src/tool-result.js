// Max size for tool result text forwarded to mobile (10KB)
export const MAX_TOOL_RESULT_SIZE = 10240

// Max base64 size per image forwarded to mobile (500KB base64 ≈ 375KB decoded)
export const MAX_TOOL_IMAGE_SIZE = 512000

// Allowed image media types
const ALLOWED_IMAGE_TYPES = new Set([
  'image/png',
  'image/jpeg',
  'image/gif',
  'image/webp',
])

/**
 * Extract tool_result events from a user-role message's content blocks.
 * Used by both CliSession and SdkSession to avoid duplicating the parsing logic.
 *
 * Extracts both text and image content blocks. Images are forwarded as base64
 * with media type metadata for inline display on the mobile client.
 *
 * @param {Array} content - The message.content array from a user-role event
 * @param {EventEmitter} emitter - Session instance to emit tool_result events on
 * @param {number} [maxSize] - Optional override for max text result size
 */
export function emitToolResults(content, emitter, maxSize = MAX_TOOL_RESULT_SIZE) {
  if (!Array.isArray(content)) return

  for (const block of content) {
    if (block.type !== 'tool_result' || !block.tool_use_id) continue

    let result = ''
    const images = []

    if (typeof block.content === 'string') {
      result = block.content
    } else if (Array.isArray(block.content)) {
      // Extract text blocks
      result = block.content
        .filter(b => b.type === 'text')
        .map(b => b.text)
        .join('\n')

      // Extract image blocks
      for (const b of block.content) {
        if (b.type !== 'image' || !b.source) continue
        const mediaType = b.source.media_type || b.source.mediaType
        if (!mediaType || !ALLOWED_IMAGE_TYPES.has(mediaType)) continue
        const data = b.source.data
        if (!data || typeof data !== 'string') continue
        // Skip images that exceed the size limit
        if (data.length > MAX_TOOL_IMAGE_SIZE) continue
        images.push({ mediaType, data })
      }
    }

    const truncated = result.length > maxSize
    if (truncated) {
      result = result.slice(0, maxSize)
    }

    const event = {
      toolUseId: block.tool_use_id,
      result,
      truncated,
    }

    if (images.length > 0) {
      event.images = images
    }

    emitter.emit('tool_result', event)
  }
}
