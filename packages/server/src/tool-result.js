import { isTurnTerminationReason, describeTurnTermination } from '@chroxy/protocol'

// Max size for tool result text forwarded to mobile (10KB)
export const MAX_TOOL_RESULT_SIZE = 10240

// Max base64 size per image forwarded to mobile (500KB base64 ≈ 375KB decoded)
export const MAX_TOOL_IMAGE_SIZE = 512000

// Max number of images forwarded per tool result (prevents oversized WS frames on mobile)
export const MAX_TOOL_IMAGES_PER_RESULT = 5

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
        // Cap total images per result
        if (images.length >= MAX_TOOL_IMAGES_PER_RESULT) break
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

    // #8300: carry the block's own error flag to the wire (the schema already
    // declares `isError`; the turn-end orphan sweep sets it on its synthetic
    // results), so a client can tell a failed tool call from a result that
    // merely reads like one. Only ever added, never defaulted to false.
    if (block.is_error === true) {
      event.isError = true
    }

    if (images.length > 0) {
      event.images = images
    }

    // #8363: the provider wrote this result itself because Stop cancelled the
    // tool's pending permission prompt -- its text says the USER declined, which
    // is false. The session names the real cause; the result then says so (the
    // clients render the shared wording and hide this text for a terminated tool)
    // and carries the same `terminatedReason` the turn-end sweep stamps (#7376).
    // Only a BaseSession-derived emitter that overrides the hook can ask; for
    // anything else this is a no-op.
    if (typeof emitter._terminatedReasonForToolResult === 'function') {
      const reason = emitter._terminatedReasonForToolResult(block.tool_use_id, block)
      if (isTurnTerminationReason(reason)) {
        event.terminatedReason = reason
        event.result = describeTurnTermination(reason).summary
        event.truncated = false
        event.isError = true
        delete event.images
      }
    }

    // #7346: backfill the finalized tool input recorded via
    // `_recordToolInput` (base-session.js) — at `content_block_stop` for
    // CliSession, or from the full assistant-message `block.input` for
    // SdkSession — onto this tool_result. session-message-history.js's
    // `tool_result` case uses it to correct the matching `tool_start`
    // history entry (which was `input: null` when first emitted, since
    // neither provider's `content_block_start` carries the real input),
    // and the client backfills `toolInput` from it too. `undefined` when
    // nothing was recorded (BYOK never calls `_trackToolStart`, so
    // `_getTrackedToolInput` isn't even present there) — this stays a
    // no-op and BYOK's `tool_result` shape is unchanged.
    if (typeof emitter._getTrackedToolInput === 'function') {
      const input = emitter._getTrackedToolInput(block.tool_use_id)
      if (input !== undefined) event.input = input
    }

    emitter.emit('tool_result', event)
    // #4628: drop the in-flight tracker entry so _emitResult's sweep
    // (BaseSession) doesn't double-emit a synthetic for an already-
    // resolved tool. Only the BaseSession-derived emitter exposes
    // _trackToolResult; ignore for any other emitter shape (e.g. tests
    // that pass a bare EventEmitter).
    if (typeof emitter._trackToolResult === 'function') {
      emitter._trackToolResult(block.tool_use_id)
    }
  }
}
